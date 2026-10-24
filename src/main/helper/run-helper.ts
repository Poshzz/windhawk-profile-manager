import type { ApplyResult, ExecutionPlan } from '@shared/domain';
import { HELPER_EXIT_CODES } from '@shared/constants';
import {
  exitCodeForError,
  exitCodeForResult,
  makeHelperFailureResult,
  writeHelperResult,
} from './result-file';
import type { HelperPlanArguments } from './arguments';
import { NodeCommandRunner } from '@infra/process/node-command-runner';
import { WindowsServiceController } from '@infra/services/windows-service-controller';
import { validateHelperPlanPaths } from './helper-paths';
import { readHelperPlanFile, type HelperPlanFile } from './plan-file';

export interface HelperPlanExecutor {
  execute(plan: ExecutionPlan, options?: { readonly dryRun?: boolean }): Promise<ApplyResult>;
}

export interface HelperRunDependencies {
  readonly readPlan?: (path: string, expectedHash: string) => Promise<HelperPlanFile>;
  readonly validatePaths?: (plan: ExecutionPlan, planPath: string) => Promise<void>;
  readonly execute?: (
    plan: ExecutionPlan,
    options: { readonly dryRun: boolean },
  ) => Promise<ApplyResult>;
  readonly writeResult?: (path: string, result: ApplyResult) => Promise<void>;
  readonly now?: () => Date;
}

async function defaultExecute(
  plan: ExecutionPlan,
  options: { readonly dryRun: boolean },
  appVersion: string | undefined,
): Promise<ApplyResult> {
  const { createRealHelperExecutor } = await import('./real-executor');
  const executor = await createRealHelperExecutor(plan, appVersion);
  return executor.execute(plan, { dryRun: options.dryRun });
}

export interface RunHelperOptions extends HelperRunDependencies {
  readonly appVersion?: string;
}

/**
 * Runs the privileged phase and maps every outcome to the stable broker exit
 * codes. Validation errors before a trustworthy plan is parsed deliberately do
 * not write anywhere; post-parse failures write a schema-valid result first.
 */
export async function runHelperMode(
  args: HelperPlanArguments,
  options: RunHelperOptions = {},
): Promise<number> {
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const readPlan = options.readPlan ?? readHelperPlanFile;

  let plan: ExecutionPlan;
  try {
    plan = (await readPlan(args.planPath, args.expectedHash)).plan;
  } catch {
    return HELPER_EXIT_CODES.validationFailure;
  }

  const execute =
    options.execute ??
    ((candidate: ExecutionPlan, executeOptions: { readonly dryRun: boolean }) =>
      defaultExecute(candidate, executeOptions, options.appVersion));
  const writeResult = options.writeResult ?? writeHelperResult;
  const persistFailure = async (error: unknown): Promise<number> => {
    const failure = makeHelperFailureResult(plan, startedAt, now().toISOString(), error);
    await writeResult(plan.paths.result, failure).catch(() => undefined);
    return exitCodeForError(error);
  };

  const validatePaths = options.validatePaths ?? validateHelperPlanPaths;
  try {
    await validatePaths(plan, args.planPath);
  } catch (error) {
    // The plan is hash-valid at this point; a failure result preserves the
    // actionable path/permission message for the non-elevated broker.
    return persistFailure(error);
  }

  let result: ApplyResult;
  try {
    result = await execute(plan, { dryRun: args.dryRun });
  } catch (error) {
    return persistFailure(error);
  }

  try {
    await writeResult(plan.paths.result, result);
  } catch {
    return HELPER_EXIT_CODES.applyFailure;
  }

  return exitCodeForResult(result);
}

/**
 * Service-only privileged mode used by the Home action. It performs no registry
 * write and does not create a plan or journal.
 */
export async function runHelperServiceStart(): Promise<number> {
  try {
    const service = new WindowsServiceController({ runner: new NodeCommandRunner() });
    const ensured = await service.ensureRunning();
    return ensured.service.state === 'running' ? 0 : 3;
  } catch {
    return 3;
  }
}
