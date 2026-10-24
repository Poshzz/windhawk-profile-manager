import { lstat } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import {
  SCHEMA_VERSION,
  parseApplyResult,
  type ApplyResult,
  type ExecutionPlan,
} from '@shared/domain';
import { HELPER_EXIT_CODES } from '@shared/constants';
import {
  CompatibilityError,
  NotFoundError,
  RollbackError,
  StalePlanError,
  StaleProfileError,
  ValidationError,
  serializeError,
} from '@shared/errors';
import {
  AtomicJsonFile,
  isNotFoundError,
  NodeAtomicFileSystem,
} from '@infra/storage/atomic-json-file';

function clip(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function writeHelperResult(path: string, result: ApplyResult): Promise<void> {
  try {
    await lstat(path);
    throw new ValidationError('The helper result file already exists.');
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }

  const parsed = parseApplyResult(result);
  await new AtomicJsonFile(dirname(path), new NodeAtomicFileSystem()).write(basename(path), parsed);
}

/**
 * The executor normally returns a complete result, including rollback outcomes.
 * This fallback covers errors thrown before it can return (stale plan, journal
 * lock, path preflight) so the broker always has a schema-valid result.
 */
export function makeHelperFailureResult(
  plan: ExecutionPlan,
  startedAt: string,
  completedAt: string,
  error: unknown,
): ApplyResult {
  const rollbackFailed = error instanceof RollbackError;
  const status = rollbackFailed ? 'rollback-failed' : 'failed';
  const message = rollbackFailed
    ? `The ${plan.kind} failed and rollback did not complete: ${clip(errorMessage(error), 1800)}`
    : `The ${plan.kind} failed before the privileged phase completed: ${clip(
        errorMessage(error),
        1800,
      )}`;
  return parseApplyResult({
    schemaVersion: SCHEMA_VERSION,
    runId: plan.runId,
    kind: plan.kind,
    status,
    message,
    startedAt,
    completedAt,
    changedMods: [],
    skippedMods: plan.kind === 'apply' ? plan.missingMods : [],
    warnings: plan.warnings.map((warning) => clip(warning.message, 1000)).slice(0, 1000),
    reload: {
      requested: false,
      confirmed: false,
      message: 'No registry writes were confirmed; no reload was requested.',
    },
    verification: {
      status: 'not-run',
      checkedAt: null,
      message: 'The privileged phase did not complete, so verification was not run.',
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
    rollback: rollbackFailed
      ? { status: 'failed', message: clip(errorMessage(error), 2000) }
      : null,
    error: serializeError(error),
  });
}

export function exitCodeForResult(result: ApplyResult): number {
  switch (result.status) {
    case 'succeeded':
    case 'succeeded-with-warning':
    case 'dry-run':
      return HELPER_EXIT_CODES.success;
    case 'rollback-failed':
      return HELPER_EXIT_CODES.rollbackFailure;
    case 'rolled-back':
    case 'failed':
    case 'canceled':
      return HELPER_EXIT_CODES.applyFailure;
  }
}

export function exitCodeForError(error: unknown): number {
  if (
    error instanceof ValidationError ||
    error instanceof NotFoundError ||
    error instanceof StalePlanError ||
    error instanceof StaleProfileError ||
    error instanceof CompatibilityError
  ) {
    return HELPER_EXIT_CODES.validationFailure;
  }
  if (error instanceof RollbackError) return HELPER_EXIT_CODES.rollbackFailure;
  return HELPER_EXIT_CODES.applyFailure;
}
