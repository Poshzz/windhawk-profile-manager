import {
  parseApplyResult,
  parsePlan,
  type ActionOutcome,
  type ApplyResult,
  type ApplyStatus,
  type ExecutionPlan,
} from '@shared/domain';
import { ApplyError, StaleProfileError } from '@shared/errors';
import type { JournalStore } from '@core/journal/journal-store';
import type { ProcessController } from '@core/process/process-controller';
import type { ApplyStateStore } from '@core/state/apply-state-store';
import type { ElevationBroker } from './elevation-broker';

export interface CoordinatorLogger {
  warn(message: string, details?: unknown): void;
}

export interface ApplyCoordinatorOptions {
  readonly broker: ElevationBroker;
  readonly journalStoreFor: (plan: ExecutionPlan) => JournalStore;
  readonly processController: ProcessController;
  readonly stateStore: ApplyStateStore;
  readonly readProfileRevision?: (profileId: string) => Promise<number | null>;
  readonly clock?: () => Date;
  readonly logger?: CoordinatorLogger;
}

export interface FinishingActions {
  readonly rainmeter: ActionOutcome;
  readonly explorer: ActionOutcome;
}

function clip(value: string, maximum = 1000): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs the non-elevated finishing phase after the helper leaves the journal at
 * `privileged-complete`: Rainmeter and Explorer actions, active-profile state,
 * and the terminal journal state. A rollback or failed helper result is returned
 * untouched; the privileged phase is never retried here.
 */
export class ApplyCoordinator {
  private readonly broker: ElevationBroker;
  private readonly journalStoreFor: (plan: ExecutionPlan) => JournalStore;
  private readonly processController: ProcessController;
  private readonly stateStore: ApplyStateStore;
  private readonly readProfileRevision: ((profileId: string) => Promise<number | null>) | undefined;
  private readonly clock: () => Date;
  private readonly logger: CoordinatorLogger;

  constructor(options: ApplyCoordinatorOptions) {
    this.broker = options.broker;
    this.journalStoreFor = options.journalStoreFor;
    this.processController = options.processController;
    this.stateStore = options.stateStore;
    this.readProfileRevision = options.readProfileRevision;
    this.clock = options.clock ?? (() => new Date());
    this.logger = options.logger ?? { warn: () => undefined };
  }

  async run(input: ExecutionPlan): Promise<ApplyResult> {
    const plan = parsePlan(input);

    if (plan.kind === 'apply' && this.readProfileRevision !== undefined) {
      const revision = await this.readProfileRevision(plan.profileId);
      if (revision === null) {
        throw new StaleProfileError(
          `Profile "${plan.profileId}" no longer exists; rebuild the plan.`,
        );
      }
      if (revision !== plan.profileRevision) {
        throw new StaleProfileError(
          `Profile "${plan.profileId}" changed (revision ${revision}, plan ${plan.profileRevision}); rebuild the plan.`,
        );
      }
    }

    const brokerResult = parseApplyResult(await this.broker.run(plan));

    if (brokerResult.runId !== plan.runId || brokerResult.kind !== plan.kind) {
      throw new ApplyError('The helper result does not belong to this plan.');
    }

    if (brokerResult.status !== 'succeeded' && brokerResult.status !== 'succeeded-with-warning') {
      return brokerResult;
    }

    return this.finish(plan, brokerResult);
  }

  /**
   * Re-runs only the non-elevated finishing phase. This is idempotent enough
   * for recovery after a GUI crash: the privileged phase is never retried.
   */
  async finish(input: ExecutionPlan, inputResult: ApplyResult): Promise<ApplyResult> {
    const plan = parsePlan(input);
    const brokerResult = parseApplyResult(inputResult);
    if (brokerResult.runId !== plan.runId || brokerResult.kind !== plan.kind) {
      throw new ApplyError('The helper result does not belong to this plan.');
    }
    if (brokerResult.status !== 'succeeded' && brokerResult.status !== 'succeeded-with-warning') {
      throw new ApplyError('Only a successful privileged phase can enter finishing actions.');
    }

    const journalStore = this.journalStoreFor(plan);
    const journal = await journalStore.read();
    if (
      journal === null ||
      journal.runId !== plan.runId ||
      journal.planHash !== plan.planHash ||
      (journal.state !== 'privileged-complete' && journal.state !== 'finishing')
    ) {
      throw new ApplyError(
        'The helper reported success, but its journal is not ready for finishing actions.',
      );
    }

    let warnings = [...brokerResult.warnings];
    if (brokerResult.status === 'succeeded-with-warning' && warnings.length === 0) {
      warnings.push('The privileged phase reported a warning.');
    }

    if (journal.state === 'finishing') {
      const recovered = parseApplyResult({
        ...brokerResult,
        status: 'succeeded-with-warning',
        warnings: [
          ...warnings,
          'Finishing actions were already started before the interruption; they were not repeated.',
        ],
      });
      await journalStore.complete('succeeded-with-warning', recovered);
      return recovered;
    }

    await journalStore.update('finishing', {
      result: brokerResult,
      expectedState: 'privileged-complete',
    });

    const actions = await this.runActions(plan);
    if (actions.rainmeter.status === 'failed') {
      warnings.push(
        clip(`The Rainmeter action failed: ${actions.rainmeter.message ?? 'unknown error'}`),
      );
    }
    if (actions.explorer.status === 'failed') {
      warnings.push(
        clip(`The Explorer action failed: ${actions.explorer.message ?? 'unknown error'}`),
      );
    }

    const completedAt = this.clock().toISOString();
    try {
      await this.stateStore.recordApply({
        profileId: plan.profileId,
        appliedAt: completedAt,
        runId: plan.runId,
      });
    } catch (error) {
      warnings.push(clip(`The active profile could not be recorded: ${errorMessage(error)}`));
      this.logger.warn('The active profile could not be recorded.', error);
    }

    warnings = [...new Set(warnings)].slice(0, 1000);
    let status: ApplyStatus = warnings.length > 0 ? 'succeeded-with-warning' : 'succeeded';
    let final = this.makeFinalResult(brokerResult, status, actions, warnings, completedAt);

    try {
      await journalStore.complete(status, final);
    } catch (error) {
      this.logger.warn('The journal could not be finalized.', error);
      warnings = [
        ...new Set([
          ...warnings,
          clip(`The journal could not be finalized: ${errorMessage(error)}`),
        ]),
      ].slice(0, 1000);
      status = 'succeeded-with-warning';
      final = this.makeFinalResult(brokerResult, status, actions, warnings, completedAt);
    }

    return final;
  }

  private makeFinalResult(
    result: ApplyResult,
    status: ApplyStatus,
    actions: FinishingActions,
    warnings: readonly string[],
    completedAt: string,
  ): ApplyResult {
    return parseApplyResult({
      ...result,
      status,
      message: clip(
        status === 'succeeded'
          ? `${result.message} Finishing actions completed.`
          : `${result.message} Finishing actions completed with warnings.`,
        2000,
      ),
      completedAt,
      warnings,
      actions,
    });
  }

  private async runActions(plan: ExecutionPlan): Promise<FinishingActions> {
    return {
      rainmeter: await this.runRainmeter(plan.actions.rainmeter),
      explorer: await this.runExplorer(plan.actions.restartExplorer),
    };
  }

  private async runRainmeter(action: 'start' | 'stop' | 'unchanged'): Promise<ActionOutcome> {
    if (action === 'unchanged') {
      return { status: 'skipped', message: 'No Rainmeter action was requested.' };
    }

    try {
      if (action === 'start') {
        await this.processController.startRainmeter();
        return { status: 'succeeded', message: 'Rainmeter was started.' };
      }
      await this.processController.quitRainmeter();
      return { status: 'succeeded', message: 'Rainmeter was asked to quit.' };
    } catch (error) {
      return { status: 'failed', message: clip(errorMessage(error)) };
    }
  }

  private async runExplorer(action: 'ask' | 'always' | 'never'): Promise<ActionOutcome> {
    if (action !== 'always') {
      return {
        status: 'skipped',
        message:
          action === 'ask'
            ? 'The plan did not resolve the Explorer-restart prompt.'
            : 'Explorer restart was not requested.',
      };
    }

    try {
      const result = await this.processController.restartExplorer();
      const message = clip(
        [result.kill.detail, result.start.detail].filter((entry) => entry.length > 0).join(' '),
      );
      if (result.shellRestarted || (result.kill.succeeded && result.start.succeeded)) {
        return {
          status: 'succeeded',
          message: message.length > 0 ? message : 'Explorer restarted.',
        };
      }
      return {
        status: 'failed',
        message: message.length > 0 ? message : 'Explorer did not restart.',
      };
    } catch (error) {
      return { status: 'failed', message: clip(errorMessage(error)) };
    }
  }
}
