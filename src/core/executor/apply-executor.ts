import { setTimeout as delay } from 'node:timers/promises';
import {
  SCHEMA_VERSION,
  canonicalPlanHashInput,
  isTerminalJournalState,
  parseApplyResult,
  parseEnvironment,
  parsePlan,
  stableStringify,
  type ApplyPlan,
  type ApplyResult,
  type ApplyStatus,
  type Environment,
  type ExecutionPlan,
  type JournalState,
  type PlanSkippedMod,
  type RegistrySnapshot,
  type SnapshotTrigger,
} from '@shared/domain';
import {
  ApplyError,
  CompatibilityError,
  JournalLockError,
  RollbackError,
  StalePlanError,
  StaleProfileError,
  ValidationError,
  serializeError,
} from '@shared/errors';
import type { RegistryGateway } from '@core/registry/registry-gateway';
import type { ServiceController } from '@core/services/service-controller';
import type { JournalStore } from '@core/journal/journal-store';
import {
  computeManagedHash,
  computeSettingsHash,
  hashCanonical,
  readInstalledMods,
} from '@core/planner/registry-state';
import {
  computeRestoreManagedHash,
  restoreSourceModIds,
  restoreTargetingValues,
} from '@core/planner/restore-state';
import {
  planBlockingError,
  planRequiresDeleteAllSettingsConfirmation,
} from '@core/planner/apply-planner';
import {
  planApplyWrites,
  planRestoreWrites,
  planRollbackWrites,
  registryValueAt,
  valuesEqual,
  type PlannedWrites,
} from './registry-writes';
import type { SnapshotPort, SnapshotRecord } from './snapshot-port';

export const SETTLE_MS = 400;

export interface ApplyClock {
  now(): Date;
}

export interface ApplyLogger {
  info(message: string, details?: unknown): void;
  warn(message: string, details?: unknown): void;
  error(message: string, details?: unknown): void;
}

export interface ApplyExecutorOptions {
  readonly snapshotStore: SnapshotPort;
  readonly registry: RegistryGateway;
  readonly service: ServiceController;
  readonly journalStore: JournalStore;
  readonly environment: Environment;
  readonly clock?: ApplyClock;
  readonly logger?: ApplyLogger;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly appVersion?: string;
  /**
   * Optional non-elevated freshness check. Helper mode normally receives only a
   * plan; the apply coordinator can supply the current profile revision here.
   */
  readonly currentProfileRevision?: (profileId: string) => Promise<number | null>;
  /**
   * Helper-mode watchdog. It is checked between registry batches and phases,
   * never by killing the process, so a write in flight always completes before
   * rollback starts.
   */
  readonly watchdogMs?: number;
  /**
   * Merge all apply-stage batches into one ordered registry call. Restore keeps
   * split batches because targeting reconciliation uses a different allowlist.
   */
  readonly mergeApplyBatches?: boolean;
}

export interface ExecuteOptions {
  readonly dryRun?: boolean;
}

const NOOP_LOGGER: ApplyLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const DEFAULT_CLOCK: ApplyClock = { now: () => new Date() };

interface PreflightResult {
  readonly current: RegistrySnapshot;
  readonly source: SnapshotRecord | null;
  readonly sourceIds: string[];
  readonly planned: PlannedWrites;
}

interface ResultInput {
  readonly status: ApplyStatus;
  readonly message: string;
  readonly changedMods: readonly string[];
  readonly skippedMods: readonly PlanSkippedMod[];
  readonly warnings: readonly string[];
  readonly reloadRequested: boolean;
  readonly reloadMessage: string;
  readonly verification: ApplyResult['verification'];
  readonly rollback: ApplyResult['rollback'];
  readonly error: unknown | null;
}

function clip(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function uniqueStrings(values: readonly string[], maximum: number): string[] {
  return [...new Set(values)].slice(0, maximum);
}

function uniqueModIds(values: readonly string[], maximum = 1000): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(value);
  }
  return maximum === Number.MAX_SAFE_INTEGER ? result : result.slice(0, maximum);
}

function uniqueSkipped(values: readonly PlanSkippedMod[]): PlanSkippedMod[] {
  const seen = new Set<string>();
  const result: PlanSkippedMod[] = [];
  for (const value of values) {
    const key = `${value.modId.toLowerCase()}\u0000${value.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result.slice(0, 1000);
}

function applyManagedIds(plan: ApplyPlan, snapshot?: RegistrySnapshot): string[] {
  const ids = [
    ...plan.modChanges.map((change) => change.modId),
    ...plan.missingMods.map((mod) => mod.modId),
    ...(plan.unlistedPolicy === 'disable' ? plan.unlistedMods.map((mod) => mod.modId) : []),
  ];

  if (plan.unlistedPolicy === 'disable' && snapshot !== undefined) {
    const known = new Set(ids.map((modId) => modId.toLowerCase()));
    for (const modId of readInstalledMods(snapshot).keys()) {
      if (!known.has(modId)) ids.push(modId);
    }
  }

  return ids;
}

function planWarningMessages(plan: ExecutionPlan): string[] {
  return plan.warnings.map((warning) => warning.message);
}

function snapshotTrigger(plan: ExecutionPlan): SnapshotTrigger {
  return plan.kind === 'apply' ? 'pre-apply' : 'pre-restore';
}

function serializedError(error: unknown): NonNullable<ApplyResult['error']> {
  const serialized = serializeError(error);
  return {
    code: serialized.code,
    name: clip(serialized.name, 100),
    message: clip(serialized.message, 4000),
    details: serialized.details.slice(0, 100).map((detail) => ({
      path: detail.path.slice(0, 100),
      message: clip(detail.message, 2000),
    })),
  };
}

/**
 * Runs the privileged phase: preflight hashes, snapshot, journal, ordered typed
 * writes, settle, verification, and rollback. It never starts or stops the
 * service except by ensuring it is running once before the snapshot.
 */
export class ApplyExecutor {
  private readonly snapshotStore: SnapshotPort;
  private readonly registry: RegistryGateway;
  private readonly service: ServiceController;
  private readonly journalStore: JournalStore;
  private readonly environment: Environment;
  private readonly clock: ApplyClock;
  private readonly logger: ApplyLogger;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly appVersion: string | undefined;
  private readonly currentProfileRevision:
    ((profileId: string) => Promise<number | null>) | undefined;
  private readonly watchdogMs: number | undefined;
  private readonly mergeApplyBatches: boolean;

  constructor(options: ApplyExecutorOptions) {
    this.snapshotStore = options.snapshotStore;
    this.registry = options.registry;
    this.service = options.service;
    this.journalStore = options.journalStore;
    this.environment = parseEnvironment(options.environment);
    this.clock = options.clock ?? DEFAULT_CLOCK;
    this.logger = options.logger ?? NOOP_LOGGER;
    this.sleep = options.sleep ?? ((milliseconds) => delay(milliseconds));
    this.appVersion = options.appVersion;
    this.currentProfileRevision = options.currentProfileRevision;
    this.watchdogMs = options.watchdogMs;
    this.mergeApplyBatches = options.mergeApplyBatches === true;
  }

  async execute(input: ExecutionPlan, options: ExecuteOptions = {}): Promise<ApplyResult> {
    const startedAt = this.nowIso();
    const deadlineAt = this.watchdogMs === undefined ? null : this.nowMs() + this.watchdogMs;
    const plan = parsePlan(input);
    this.assertPlanHash(plan);
    this.assertCompatible();
    if (plan.kind === 'apply') {
      const blocked = planBlockingError(plan);
      if (blocked !== null) throw blocked;
    }

    const preflight = await this.preflight(plan);

    if (options.dryRun === true) {
      return this.dryRunResult(plan, startedAt, preflight.planned);
    }

    if (plan.kind === 'apply' && planRequiresDeleteAllSettingsConfirmation(plan)) {
      throw new ValidationError(
        'Deleting all settings requires explicit confirmation; rebuild the plan after confirming.',
      );
    }

    let ensured;
    try {
      ensured = await this.service.ensureRunning();
    } catch (error) {
      this.logger.error('The Windhawk service could not be started.', error);
      return this.failedResult(plan, startedAt, error, preflight.planned);
    }

    const snapshotEnvironment: Environment = ensured.started
      ? parseEnvironment({ ...this.environment, service: ensured.service })
      : this.environment;

    let captured: SnapshotRecord;
    try {
      captured = await this.snapshotStore.capture(
        snapshotTrigger(plan),
        {
          environment: snapshotEnvironment,
          profileId: plan.profileId,
          registryView: '64-bit',
          ...(this.appVersion === undefined ? {} : { appVersion: this.appVersion }),
        },
        { prune: false },
      );
    } catch (error) {
      this.logger.error('The pre-run snapshot could not be created.', error);
      return this.failedResult(plan, startedAt, error, preflight.planned);
    }

    const afterSnapshotHash =
      plan.kind === 'apply'
        ? computeManagedHash(applyManagedIds(plan, captured.registry), captured.registry)
        : computeRestoreManagedHash(captured.registry, preflight.sourceIds);
    if (afterSnapshotHash !== plan.beforeHash) {
      throw new StalePlanError(
        'The registry changed while the pre-run snapshot was being captured; the plan was not applied.',
      );
    }

    const planned = this.planWrites(plan, captured.registry, preflight.source);

    try {
      await this.journalStore.begin({
        plan,
        snapshotId: captured.metadata.id,
        startedAt,
      });
    } catch (error) {
      if (error instanceof JournalLockError) throw error;
      this.logger.error('The journal could not be started.', error);
      return this.failedResult(plan, startedAt, error, planned);
    }

    try {
      // The journal is now the retention fence: activeSnapshotIds() protects
      // both this run's snapshot and a restore source while we prune.
      await this.snapshotStore.prune();
    } catch (error) {
      this.logger.warn('Snapshot retention could not run after the journal was created.', error);
    }

    try {
      await this.journalStore.update('applying');
    } catch (error) {
      this.logger.error('The journal could not enter the applying state.', error);
      return this.failedResult(plan, startedAt, error, planned);
    }

    try {
      this.assertBeforeDeadline(deadlineAt, 'apply');
      await this.runBatches(planned, plan.kind, deadlineAt);
      this.assertBeforeDeadline(deadlineAt, 'settle');
      await this.journalStore.update('settling');
      await this.sleep(SETTLE_MS);
      this.assertBeforeDeadline(deadlineAt, 'verification');
      await this.journalStore.update('verifying');
      await this.verifyWrites(plan.kind, planned);
      if (planned.allOps.length > 0) await this.verifyServiceRunning();
      this.assertBeforeDeadline(deadlineAt, 'completion');

      const result = this.makeResult(plan, startedAt, {
        status: 'succeeded',
        message:
          planned.allOps.length === 0
            ? 'No registry writes were needed.'
            : 'Applied; reload requested, not confirmed loaded.',
        changedMods: planned.touchedModIds,
        skippedMods: planned.skippedMods,
        warnings: this.warnings(plan, planned),
        reloadRequested: planned.allOps.length > 0,
        reloadMessage:
          planned.allOps.length === 0
            ? 'No registry values changed; no reload was requested.'
            : 'Applied; the Windhawk engine reload was requested but is not confirmed loaded.',
        verification: {
          status: 'verified',
          checkedAt: this.nowIso(),
          message:
            planned.touchedModIds.length === 0
              ? 'No touched registry values needed verification.'
              : `Verified ${planned.touchedModIds.length} touched mod(s) after a ${SETTLE_MS} ms settle.`,
        },
        rollback: null,
        error: null,
      });

      // The non-elevated coordinator (0009) finishes actions and marks the
      // journal terminal. The privileged phase deliberately stops here.
      await this.journalStore.update('privileged-complete', { result });
      return result;
    } catch (error) {
      this.logger.error('The privileged apply phase failed; rolling back.', error);
      return this.rollback(plan, captured, startedAt, error, planned);
    }
  }

  private async preflight(plan: ExecutionPlan): Promise<PreflightResult> {
    if (plan.kind === 'apply' && this.currentProfileRevision !== undefined) {
      const revision = await this.currentProfileRevision(plan.profileId);
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

    let source: SnapshotRecord | null = null;
    let sourceIds: string[] = [];
    let managedIds: string[] = [];

    if (plan.kind === 'restore') {
      source = await this.snapshotStore.get(plan.sourceSnapshotId);
      if (plan.sourceSnapshotSha256 === undefined) {
        throw new ValidationError(
          'The restore plan does not bind the source snapshot checksum; rebuild the restore plan.',
        );
      }
      if (source.metadata.registrySha256 !== plan.sourceSnapshotSha256) {
        throw new StalePlanError(
          'The source snapshot changed since the restore was previewed; rebuild the restore plan.',
        );
      }

      const targetingValues = restoreTargetingValues(source.registry);
      if (stableStringify(targetingValues) !== stableStringify(plan.targetingValues)) {
        throw new StalePlanError(
          'The source snapshot targeting values changed since the restore was previewed; rebuild the restore plan.',
        );
      }
      if (targetingValues.length > 0 && !plan.targetingConfirmed) {
        throw new ValidationError(
          'The restore writes machine-specific targeting values and requires explicit confirmation; rebuild the confirmed plan.',
        );
      }
      sourceIds = restoreSourceModIds(source.registry);
    } else {
      managedIds = applyManagedIds(plan);
    }

    const current = await this.registry.read();

    if (plan.kind === 'restore') {
      const currentHash = computeRestoreManagedHash(current, sourceIds);
      if (currentHash !== plan.beforeHash) {
        throw new StalePlanError(
          'The registry changed since the restore plan was built; rebuild the plan.',
        );
      }
    } else {
      const currentHash = computeManagedHash(managedIds, current);
      if (currentHash !== plan.beforeHash) {
        throw new StalePlanError(
          'The registry changed since the apply plan was built; rebuild the plan.',
        );
      }

      const installed = readInstalledMods(current);
      for (const change of plan.modChanges) {
        const state = installed.get(change.modId.toLowerCase());
        if (computeSettingsHash(state) !== change.settingsHash) {
          throw new StalePlanError(
            `Settings for "${change.modId}" changed since the plan was built; rebuild the plan.`,
          );
        }
      }

      if (plan.unlistedPolicy === 'disable') {
        const plannedIds = new Set(applyManagedIds(plan).map((modId) => modId.toLowerCase()));
        for (const modId of installed.keys()) {
          if (!plannedIds.has(modId)) {
            throw new StalePlanError(
              `A mod ("${modId}") was installed after the plan was built; rebuild the plan so the unlisted-mod policy is complete.`,
            );
          }
        }
      }
    }

    const planned =
      plan.kind === 'apply'
        ? planApplyWrites(plan, current, this.nowMs())
        : planRestoreWrites(source!.registry, current, this.nowMs());

    return { current, source, sourceIds, planned };
  }

  private planWrites(
    plan: ExecutionPlan,
    snapshot: RegistrySnapshot,
    source: SnapshotRecord | null,
  ): PlannedWrites {
    if (plan.kind === 'apply') {
      return planApplyWrites(plan, snapshot, this.nowMs());
    }
    if (source === null) {
      throw new ValidationError('A restore plan requires its source snapshot.');
    }
    return planRestoreWrites(source.registry, snapshot, this.nowMs());
  }

  private async runBatches(
    planned: PlannedWrites,
    mode: 'apply' | 'restore',
    deadlineAt: number | null = null,
  ): Promise<void> {
    if (this.mergeApplyBatches && mode === 'apply') {
      const operations = planned.batches.flatMap((batch) => batch.ops);
      if (operations.length > 0) {
        this.assertBeforeDeadline(deadlineAt, 'registry writes');
        this.logger.info('Writing merged registry apply batch.', {
          operations: operations.length,
        });
        await this.registry.applyOps(operations);
      }
      return;
    }

    for (const batch of planned.batches) {
      if (batch.ops.length === 0) continue;
      this.assertBeforeDeadline(deadlineAt, 'registry writes');
      this.logger.info(`Writing registry batch "${batch.stage}".`, {
        operations: batch.ops.length,
      });
      // Restore and rollback reconcile targeting values, which the apply
      // allowlist intentionally rejects. The marker batch is the one exception:
      // SettingsChangeTime is a marker, not captured restore state, so it goes
      // through the apply allowlist and is still never taken from a snapshot.
      if (mode === 'apply' || batch.stage === 'marker') {
        await this.registry.applyOps(batch.ops);
      } else {
        await this.registry.applyRestoreOps(batch.ops);
      }
    }
  }

  private async verifyWrites(
    mode: 'apply' | 'restore' | 'rollback',
    planned: PlannedWrites,
    additionalModIds: readonly string[] = [],
  ): Promise<void> {
    const touchedModIds = uniqueModIds(
      [...planned.touchedModIds, ...additionalModIds],
      Number.MAX_SAFE_INTEGER,
    );
    if (touchedModIds.length === 0) return;

    const fresh = await this.registry.read();
    for (const operation of planned.allOps) {
      const actual = registryValueAt(fresh, operation.path, operation.name);
      if (operation.kind === 'deleteValue') {
        if (actual !== null) {
          throw new ApplyError(
            `Verification failed: "${operation.name}" still exists under "${operation.path}".`,
          );
        }
        continue;
      }
      if (actual === null || !valuesEqual(actual, operation.value)) {
        throw new ApplyError(
          `Verification failed: "${operation.name}" under "${operation.path}" does not match the planned value.`,
        );
      }
    }

    const restoreStyle = mode !== 'apply';
    const expectedHash = restoreStyle
      ? computeRestoreManagedHash(planned.expectedSnapshot, touchedModIds)
      : computeManagedHash(touchedModIds, planned.expectedSnapshot);
    const actualHash = restoreStyle
      ? computeRestoreManagedHash(fresh, touchedModIds)
      : computeManagedHash(touchedModIds, fresh);
    if (actualHash !== expectedHash) {
      throw new ApplyError(
        'Verification failed: the touched registry values do not match the expected state.',
      );
    }
  }

  private async verifyServiceRunning(): Promise<void> {
    const service = await this.service.status();
    if (service.state !== 'running') {
      throw new ApplyError(
        `The Windhawk service is ${service.state} after the apply; the engine cannot reload settings.`,
      );
    }
  }

  private async ensureServiceRunningAfterRollback(): Promise<void> {
    const ensured = await this.service.ensureRunning();
    if (ensured.started) {
      this.logger.info('The Windhawk service was started again after rollback.');
    }
  }

  private async rollback(
    plan: ExecutionPlan,
    preRun: SnapshotRecord,
    startedAt: string,
    originalError: unknown,
    originalPlanned: PlannedWrites,
  ): Promise<ApplyResult> {
    let planned: PlannedWrites;
    try {
      await this.journalStore.update('rolling-back').catch((error: unknown) => {
        this.logger.warn('The journal could not enter the rolling-back state.', error);
      });

      const current = await this.registry.read();
      planned = planRollbackWrites(preRun.registry, current, this.nowMs());
      await this.runBatches(planned, 'restore');
      await this.sleep(SETTLE_MS);

      if (planned.unrestorableModIds.length > 0) {
        throw new RollbackError(
          `Mod keys no longer exist for: ${planned.unrestorableModIds.join(', ')}. The app never recreates a missing mod key.`,
        );
      }

      await this.verifyWrites('rollback', planned, originalPlanned.touchedModIds);
    } catch (rollbackFailure) {
      this.logger.error('Rollback failed.', rollbackFailure);
      return this.rollbackFailedResult(
        plan,
        preRun,
        startedAt,
        originalError,
        originalPlanned,
        rollbackFailure,
      );
    }

    const warnings = this.warnings(plan, originalPlanned);
    try {
      await this.ensureServiceRunningAfterRollback();
    } catch (error) {
      warnings.push(
        clip(
          `The registry was restored, but the Windhawk service could not be started: ${errorMessage(error)}`,
          1000,
        ),
      );
      this.logger.warn('The Windhawk service could not be started after rollback.', error);
    }

    const result = this.makeResult(plan, startedAt, {
      status: 'rolled-back',
      message: `The ${plan.kind} failed and the pre-run snapshot was restored. ${clip(
        errorMessage(originalError),
        1500,
      )}`,
      changedMods: originalPlanned.touchedModIds,
      skippedMods: originalPlanned.skippedMods,
      warnings,
      reloadRequested: planned.allOps.length > 0,
      reloadMessage:
        planned.allOps.length === 0
          ? 'No registry values changed during rollback.'
          : 'Rollback wrote reload markers; the Windhawk reload was requested but is not confirmed loaded.',
      verification: {
        status: 'verified',
        checkedAt: this.nowIso(),
        message: `Rollback verified after a ${SETTLE_MS} ms settle.`,
      },
      rollback: {
        status: 'succeeded',
        message: `Restored the pre-run snapshot "${preRun.metadata.id}".`,
      },
      error: originalError,
    });

    if (!(await this.completeJournalWithRetry('rolled-back', result))) {
      const journalWarning = clip(
        'The registry was restored, but the journal could not be finalized. Clear the unfinished journal manually.',
        1000,
      );
      return parseApplyResult({
        ...result,
        warnings: uniqueStrings([...result.warnings, journalWarning], 1000),
      });
    }
    return result;
  }

  private async rollbackFailedResult(
    plan: ExecutionPlan,
    preRun: SnapshotRecord,
    startedAt: string,
    originalError: unknown,
    originalPlanned: PlannedWrites,
    rollbackFailure: unknown,
  ): Promise<ApplyResult> {
    const manualSteps =
      `Automatic rollback failed: ${clip(errorMessage(rollbackFailure), 1200)} ` +
      `The journal and snapshot "${preRun.metadata.id}" were kept. ` +
      'Restore this snapshot manually from the Snapshots screen, then clear the journal.';
    const result = this.makeResult(plan, startedAt, {
      status: 'rollback-failed',
      message: clip(manualSteps, 2000),
      changedMods: originalPlanned.touchedModIds,
      skippedMods: originalPlanned.skippedMods,
      warnings: uniqueStrings(
        [...this.warnings(plan, originalPlanned), clip(manualSteps, 1000)],
        1000,
      ),
      reloadRequested: false,
      reloadMessage: 'Rollback did not complete; no reload was requested.',
      verification: {
        status: 'not-verified',
        checkedAt: null,
        message: 'Rollback verification did not complete.',
      },
      rollback: {
        status: 'failed',
        message: clip(errorMessage(rollbackFailure), 2000),
      },
      error: originalError,
    });

    if (!(await this.completeJournalWithRetry('rollback-failed', result))) {
      this.logger.error('The rollback-failed journal state could not be recorded.');
    }
    return result;
  }

  private async completeJournalWithRetry(
    state: 'rolled-back' | 'rollback-failed',
    result: ApplyResult,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await this.journalStore.complete(state, result);
        return true;
      } catch (error) {
        let journalState: JournalState | null = null;
        try {
          journalState = (await this.journalStore.read())?.state ?? null;
        } catch {
          // If the journal cannot be read, retry once and then report failure.
        }
        if (journalState === state) return true;
        if (journalState !== null && isTerminalJournalState(journalState)) {
          this.logger.error(
            `The journal is already terminal in state "${journalState}" instead of "${state}".`,
            error,
          );
          return false;
        }
        if (attempt === 0) {
          this.logger.warn(`The ${state} journal state could not be recorded; retrying.`, error);
        } else {
          this.logger.error(`The ${state} journal state could not be recorded.`, error);
        }
      }
    }
    return false;
  }

  private dryRunResult(
    plan: ExecutionPlan,
    startedAt: string,
    planned: PlannedWrites,
  ): ApplyResult {
    const count = planned.touchedModIds.length;
    return this.makeResult(plan, startedAt, {
      status: 'dry-run',
      message:
        count === 0
          ? 'Dry run: no registry changes are needed; no writes or service actions were made.'
          : `Dry run: ${count} mod(s) would change; no registry or service changes were made.`,
      changedMods: planned.touchedModIds,
      skippedMods: planned.skippedMods,
      warnings: this.warnings(plan, planned),
      reloadRequested: false,
      reloadMessage: 'Dry run: no reload was requested.',
      verification: {
        status: 'not-run',
        checkedAt: null,
        message: 'Dry run: verification was not run.',
      },
      rollback: null,
      error: null,
    });
  }

  private failedResult(
    plan: ExecutionPlan,
    startedAt: string,
    error: unknown,
    planned: PlannedWrites,
  ): ApplyResult {
    return this.makeResult(plan, startedAt, {
      status: 'failed',
      message: `The ${plan.kind} failed before any registry write: ${clip(
        errorMessage(error),
        1800,
      )}`,
      changedMods: [],
      skippedMods: planned.skippedMods,
      warnings: this.warnings(plan, planned),
      reloadRequested: false,
      reloadMessage: 'No registry writes were made; no reload was requested.',
      verification: {
        status: 'not-run',
        checkedAt: null,
        message: 'No registry writes were made, so verification was not run.',
      },
      rollback: null,
      error,
    });
  }

  private warnings(plan: ExecutionPlan, planned: PlannedWrites): string[] {
    return uniqueStrings(
      [...planWarningMessages(plan), ...planned.warnings].map((message) => clip(message, 1000)),
      1000,
    );
  }

  private makeResult(plan: ExecutionPlan, startedAt: string, input: ResultInput): ApplyResult {
    return {
      schemaVersion: SCHEMA_VERSION,
      runId: plan.runId,
      kind: plan.kind,
      status: input.status,
      message: clip(input.message, 2000),
      startedAt,
      completedAt: this.nowIso(),
      changedMods: uniqueModIds(input.changedMods),
      skippedMods: uniqueSkipped(input.skippedMods),
      warnings: uniqueStrings(
        input.warnings.map((value) => clip(value, 1000)),
        1000,
      ),
      reload: {
        requested: input.reloadRequested,
        confirmed: false,
        message: clip(input.reloadMessage, 1000),
      },
      verification: {
        ...input.verification,
        message: clip(input.verification.message, 1000),
      },
      actions: {
        rainmeter: {
          status: 'skipped',
          message: 'Rainmeter actions run in the non-elevated main process.',
        },
        explorer: {
          status: 'skipped',
          message: 'Explorer actions run in the non-elevated main process.',
        },
      },
      rollback: input.rollback,
      error: input.error === null ? null : serializedError(input.error),
    };
  }

  private assertCompatible(): void {
    const compatibility = this.environment.compatibility;
    if (compatibility.canApply && compatibility.mode === 'writable') return;

    const issues = compatibility.issues.map((issue) => issue.message).join(' ');
    throw new CompatibilityError(
      `This machine cannot apply Windhawk profiles (${compatibility.mode}).${
        issues.length > 0 ? ` ${issues}` : ''
      }`,
    );
  }

  private assertPlanHash(plan: ExecutionPlan): void {
    const actual = hashCanonical(canonicalPlanHashInput(plan));
    if (actual !== plan.planHash) {
      throw new ValidationError('The plan hash does not match the plan contents.');
    }
  }

  private assertBeforeDeadline(deadlineAt: number | null, stage: string): void {
    if (deadlineAt === null) return;
    if (this.nowMs() < deadlineAt) return;
    throw new ApplyError(
      `The helper watchdog expired before ${stage}; the run was rolled back instead of killing a write in flight.`,
    );
  }

  private nowMs(): number {
    return this.clock.now().getTime();
  }

  private nowIso(): string {
    return this.clock.now().toISOString();
  }
}
