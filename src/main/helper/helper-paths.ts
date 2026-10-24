import { constants } from 'node:fs';
import { access, lstat, mkdir, realpath } from 'node:fs/promises';
import { basename, dirname, join, normalize } from 'node:path';
import type { ExecutionPlan } from '@shared/domain';
import { ValidationError } from '@shared/errors';

export interface HelperPathAccess {
  ensureWritableDirectory(path: string, label: string): Promise<void>;
  assertReadableFile(path: string, label: string): Promise<void>;
  assertMissingFile(path: string, label: string): Promise<void>;
}

function normalizePath(path: string): string {
  return normalize(path).replace(/\//g, '\\').toLowerCase();
}

const APP_DATA_DIRECTORY = 'windhawkprofilemanager';
const SNAPSHOTS_DIRECTORY = 'snapshots';
const JOURNAL_FILE = 'journal.json';

function isUserLocalAppDataPath(path: string): boolean {
  const normalized = normalizePath(path);
  return (
    !normalized.startsWith('\\\\') &&
    normalized.includes('\\users\\') &&
    normalized.includes('\\appdata\\local\\')
  );
}

function isSnapshotPath(path: string): boolean {
  return (
    isUserLocalAppDataPath(path) &&
    basename(dirname(path)).toLowerCase() === SNAPSHOTS_DIRECTORY &&
    basename(dirname(dirname(path))).toLowerCase() === APP_DATA_DIRECTORY
  );
}

function isCanonicalJournalPath(path: string): boolean {
  return (
    isUserLocalAppDataPath(path) &&
    basename(path).toLowerCase() === JOURNAL_FILE &&
    basename(dirname(path)).toLowerCase() === APP_DATA_DIRECTORY
  );
}

async function assertNoReparsePoint(path: string, label: string): Promise<void> {
  let resolved: string;
  try {
    resolved = await realpath(path);
  } catch (error) {
    throw new ValidationError(
      `The ${label} could not be resolved; a reparse point is not allowed.`,
      [],
      { cause: error },
    );
  }
  if (normalizePath(resolved) !== normalizePath(path)) {
    throw new ValidationError(
      `The ${label} resolves through a reparse point or alternate path; it is not allowed.`,
    );
  }
}

async function assertNoReparseAncestors(path: string): Promise<void> {
  let current = dirname(path);
  for (;;) {
    try {
      const resolved = await realpath(current);
      if (normalizePath(resolved) !== normalizePath(current)) {
        throw new ValidationError(
          `The ${current} directory resolves through a reparse point; it is not allowed.`,
        );
      }
    } catch (error) {
      if (!(
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { readonly code?: unknown }).code === 'ENOENT'
      )) {
        throw error;
      }
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function ensureWritableDirectory(path: string, label: string): Promise<void> {
  try {
    await assertNoReparseAncestors(path);
    await mkdir(path, { recursive: true });
    await access(path, constants.W_OK);
    await assertNoReparsePoint(path, label);
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ValidationError(
      `The elevated helper cannot write the ${label}. If the UAC prompt used a different administrator account, that account must be able to access this path.`,
      [],
      { cause: error },
    );
  }
}

async function assertReadableFile(path: string, label: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new ValidationError(`The ${label} must be a regular file.`);
    }
    await access(path, constants.R_OK);
    await assertNoReparsePoint(path, label);
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ValidationError(
      `The elevated helper cannot read the ${label}. If the UAC prompt used a different administrator account, that account must be able to access this path.`,
      [],
      { cause: error },
    );
  }
}

async function assertMissingFile(path: string, label: string): Promise<void> {
  try {
    await assertNoReparsePoint(dirname(path), `${label} directory`);
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new ValidationError(`The ${label} exists and is not a regular file.`);
    }
    throw new ValidationError(`The ${label} already exists; a new run must not overwrite it.`);
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    if (typeof error === 'object' && error !== null && 'code' in error) {
      if ((error as { readonly code?: unknown }).code === 'ENOENT') return;
    }
    throw new ValidationError(`The ${label} could not be checked.`, [], { cause: error });
  }
}

export const NODE_HELPER_PATH_ACCESS: HelperPathAccess = {
  ensureWritableDirectory,
  assertReadableFile,
  assertMissingFile,
};

function samePath(left: string, right: string): boolean {
  return normalizePath(left) === normalizePath(right);
}

/**
 * Paths are bound into the hashed plan, but the helper still checks the layout
 * it relies on: the result sits beside the plan, the snapshot ID matches its
 * file, and every supplied path is reachable by the elevated account.
 */
export async function validateHelperPlanPaths(
  plan: ExecutionPlan,
  planFilePath: string,
  pathAccess: HelperPathAccess = NODE_HELPER_PATH_ACCESS,
): Promise<void> {
  if (!samePath(plan.paths.plan, planFilePath)) {
    throw new ValidationError('The plan path does not match the file the helper was given.');
  }

  if (!samePath(plan.paths.result, join(dirname(planFilePath), 'result.json'))) {
    throw new ValidationError('The result path must be result.json beside the plan file.');
  }

  if (
    !samePath(
      plan.paths.snapshotRegistry,
      join(dirname(plan.paths.snapshotRegistry), `${plan.snapshotId}.reg`),
    )
  ) {
    throw new ValidationError('The snapshot path must match the plan snapshot ID.');
  }

  if (!isCanonicalJournalPath(plan.paths.journal)) {
    throw new ValidationError(
      'The journal path must be the canonical WindhawkProfileManager\\journal.json path.',
    );
  }
  if (!isSnapshotPath(plan.paths.snapshotRegistry)) {
    throw new ValidationError(
      'The pre-run snapshot must be inside WindhawkProfileManager\\snapshots.',
    );
  }
  if (!samePath(dirname(dirname(plan.paths.snapshotRegistry)), dirname(plan.paths.journal))) {
    throw new ValidationError(
      'The snapshot and journal must belong to the same WindhawkProfileManager directory.',
    );
  }

  if (plan.kind === 'restore') {
    if (!isSnapshotPath(plan.paths.sourceSnapshotRegistry)) {
      throw new ValidationError(
        'The source snapshot must be inside WindhawkProfileManager\\snapshots.',
      );
    }
    if (
      basename(plan.paths.sourceSnapshotRegistry).toLowerCase() !==
      `${plan.sourceSnapshotId}.reg`.toLowerCase()
    ) {
      throw new ValidationError('The source snapshot path must match the source snapshot ID.');
    }
    if (
      !samePath(dirname(plan.paths.sourceSnapshotRegistry), dirname(plan.paths.snapshotRegistry))
    ) {
      throw new ValidationError('The source snapshot must be in the same snapshots directory.');
    }
  }

  await pathAccess.ensureWritableDirectory(
    dirname(plan.paths.snapshotRegistry),
    'snapshot directory',
  );
  await pathAccess.ensureWritableDirectory(dirname(plan.paths.journal), 'journal directory');
  await pathAccess.ensureWritableDirectory(dirname(plan.paths.result), 'result directory');

  await pathAccess.assertMissingFile(plan.paths.snapshotRegistry, 'snapshot file');
  await pathAccess.assertMissingFile(
    join(dirname(plan.paths.snapshotRegistry), `${plan.snapshotId}.json`),
    'snapshot metadata file',
  );

  if (plan.kind === 'restore') {
    await pathAccess.assertReadableFile(plan.paths.sourceSnapshotRegistry, 'source snapshot');
  }

  // A result left by a previous failed run must not be mistaken for this run's
  // result. The broker allocates a fresh run directory, so this is a last guard.
  await pathAccess.assertMissingFile(plan.paths.result, 'result file');

  // basename() is only used to make it explicit that the result is a leaf file.
  if (basename(plan.paths.result).length === 0) {
    throw new ValidationError('The result path must name a file.');
  }
}
