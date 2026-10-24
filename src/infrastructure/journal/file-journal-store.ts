import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  SCHEMA_VERSION,
  isTerminalJournalState,
  isUnfinishedJournalState,
  parseJournal,
  parsePlan,
  type ApplyResult,
  type Journal,
  type JournalState,
} from '@shared/domain';
import { JournalLockError, NotFoundError, ValidationError } from '@shared/errors';
import type {
  JournalBeginInput,
  JournalClearOptions,
  JournalStore,
  JournalUpdateOptions,
} from '@core/journal/journal-store';
import { isNotFoundError, renameWithRetry } from '../storage/atomic-json-file';

export const JOURNAL_FILE_NAME = 'journal.json';
export const JOURNAL_LEASE_SUFFIX = '.lease';
const BEGIN_LOCK_STALE_MS = 30_000;
const LEASE_STALE_MS = 10 * 60_000;

interface BeginLockFile {
  readonly pid: number;
  readonly token: string;
  readonly createdAt: string;
}

interface JournalLease {
  readonly pid: number;
  readonly runId: string;
  readonly runToken: string;
  readonly createdAt: string;
}

export interface FileJournalStoreOptions {
  readonly path?: string;
  readonly now?: () => Date;
  /**
   * When set, update() and complete() refuse to write a journal belonging to
   * another run. The helper and the finishing coordinator bind the planned run
   * id; the GUI's read/recovery store stays unbound.
   */
  readonly runId?: string;
  /** Optional explicit fencing token; begin() anchors the token it generated. */
  readonly runToken?: string;
}

export function defaultJournalPath(): string {
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData === undefined || localAppData.length === 0) {
    throw new ValidationError('LOCALAPPDATA is not set; the journal path cannot be located.');
  }
  return join(localAppData, 'WindhawkProfileManager', JOURNAL_FILE_NAME);
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined;
}

function isMissingFile(error: unknown): boolean {
  return errorCode(error) === 'ENOENT';
}

function isAlreadyExists(error: unknown): boolean {
  return errorCode(error) === 'EEXIST';
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but the current user may not signal it.
    return errorCode(error) === 'EPERM';
  }
}

function parseStoredJournal(text: string): Journal {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new ValidationError('The journal file is not valid JSON.', [], { cause: error });
  }
  return parseJournal(value);
}

function serialized(journal: Journal): string {
  return `${JSON.stringify(journal, null, 2)}\n`;
}

/**
 * Durable journal and cross-process lock. The journal file's existence is the
 * lock: begin() creates it with O_EXCL, and every later phase rewrites it
 * atomically. A completed successful or rolled-back journal may be replaced by
 * the next run; a rollback-failed or interrupted journal blocks until cleared.
 */
export class FileJournalStore implements JournalStore {
  private readonly path: string;
  private readonly now: () => Date;
  private readonly expectedRunId: string | undefined;
  private runToken: string | null = null;

  constructor(options: FileJournalStoreOptions = {}) {
    this.path = options.path ?? defaultJournalPath();
    this.now = options.now ?? (() => new Date());
    this.expectedRunId = options.runId;
    this.runToken = options.runToken ?? null;
  }

  async begin(input: JournalBeginInput): Promise<Journal> {
    const plan = parsePlan(input.plan);
    const runToken = randomUUID();
    const journal = parseJournal({
      schemaVersion: SCHEMA_VERSION,
      runId: plan.runId,
      runToken,
      state: 'journaling',
      startedAt: input.startedAt,
      updatedAt: input.startedAt,
      snapshotId: input.snapshotId,
      planHash: plan.planHash,
      beforeHash: plan.beforeHash,
      profileRevision: plan.profileRevision,
      plan,
      result: null,
    });

    await mkdir(dirname(this.path), { recursive: true });
    const lockToken = await this.acquireBeginLock();
    let keepLease = false;
    try {
      await this.acquireLease(plan.runId, runToken);
      await this.assertBeginLock(lockToken);

      if (await this.publishNewJournal(journal)) {
        keepLease = true;
        this.runToken = runToken;
        return journal;
      }

      let existing: Journal | null;
      try {
        existing = await this.read();
      } catch (error) {
        throw new ValidationError(
          'The journal file is corrupt; clear it before starting another run.',
          [],
          { cause: error },
        );
      }

      if (existing === null) {
        await this.assertBeginLock(lockToken);
        if (await this.publishNewJournal(journal)) {
          keepLease = true;
          this.runToken = runToken;
          return journal;
        }
        throw new JournalLockError('The journal lock could not be acquired.');
      }

      if (
        existing.state === 'succeeded' ||
        existing.state === 'succeeded-with-warning' ||
        existing.state === 'rolled-back'
      ) {
        await this.assertBeginLock(lockToken);
        await unlink(this.path).catch((error: unknown) => {
          if (!isMissingFile(error)) throw error;
        });
        await this.assertBeginLock(lockToken);
        if (await this.publishNewJournal(journal)) {
          keepLease = true;
          this.runToken = runToken;
          return journal;
        }
        throw new JournalLockError('The journal lock could not be acquired.');
      }

      throw new JournalLockError(
        `Another apply or restore is already running (journal state "${existing.state}").`,
      );
    } finally {
      if (!keepLease) await this.releaseLease(runToken).catch(() => undefined);
      await this.releaseBeginLock(lockToken);
    }
  }

  async update(state: JournalState, options: JournalUpdateOptions = {}): Promise<Journal> {
    const current = await this.read();
    if (current === null) {
      throw new NotFoundError('The journal does not exist.');
    }
    this.assertRunBound(current);
    if (isTerminalJournalState(current.state)) {
      throw new ValidationError(`Journal state "${current.state}" is already terminal.`);
    }
    if (options.expectedState !== undefined && current.state !== options.expectedState) {
      throw new JournalLockError(
        `The journal is in state "${current.state}", not the expected "${options.expectedState}".`,
      );
    }

    const updated = parseJournal({
      ...current,
      state,
      updatedAt: this.now().toISOString(),
      result: options.result === undefined ? current.result : options.result,
    });
    await this.write(updated);
    return updated;
  }

  async complete(state: JournalState, result: ApplyResult): Promise<Journal> {
    if (!isTerminalJournalState(state)) {
      throw new ValidationError(`Journal state "${state}" is not terminal.`);
    }

    const current = await this.read();
    if (current === null) {
      throw new NotFoundError('The journal does not exist.');
    }
    this.assertRunBound(current);
    if (isTerminalJournalState(current.state)) {
      throw new ValidationError(`Journal state "${current.state}" is already terminal.`);
    }

    const completed = parseJournal({
      ...current,
      state,
      updatedAt: this.now().toISOString(),
      result,
    });
    await this.write(completed);
    await this.unlinkLeaseForRun(completed);
    return completed;
  }

  async read(): Promise<Journal | null> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw error;
    }
    return parseStoredJournal(text);
  }

  /**
   * True while a process still holds the durable lease beside the journal.
   * EPERM is treated as alive: an elevated helper may be un-signalable by the
   * non-elevated GUI, but it is still running.
   */
  async isRunLive(): Promise<boolean> {
    const lease = await this.readLease();
    if (lease === null) {
      // A just-created lease can be briefly unreadable while begin() writes it.
      // Treat a fresh unreadable file as live instead of racing a real run.
      return this.leaseIsRecent();
    }
    const createdAt = Date.parse(lease.createdAt);
    if (!Number.isFinite(createdAt) || this.now().getTime() - createdAt > LEASE_STALE_MS) {
      // A recycled PID must not wedge recovery forever. The helper watchdog is
      // 120 s; ten minutes is far beyond any legitimate run.
      return false;
    }
    return isProcessAlive(lease.pid);
  }

  /** Preserve a corrupt/unparseable journal instead of silently deleting evidence. */
  async archiveCorrupt(): Promise<string | null> {
    if (await this.isRunLive()) {
      throw new JournalLockError(
        'The journal is owned by a live helper or run; wait for it to finish before archiving it.',
      );
    }
    const suffix = this.now().toISOString().replace(/[:.]/g, '-');
    const archivePath = `${this.path}.corrupt-${suffix}`;
    try {
      await rename(this.path, archivePath);
    } catch (error) {
      if (isNotFoundError(error)) {
        await this.unlinkLease();
        return null;
      }
      throw error;
    }
    await this.unlinkLease();
    return archivePath;
  }

  async clear(options: JournalClearOptions = {}): Promise<void> {
    if (await this.isRunLive()) {
      throw new JournalLockError(
        'The journal is owned by a live helper or run; wait for it to finish before clearing it.',
      );
    }

    let current: Journal | null;
    try {
      current = await this.read();
    } catch (error) {
      if (options.force !== true) {
        throw new ValidationError(
          'The journal file is corrupt; force-clear it before retrying.',
          [],
          { cause: error },
        );
      }
      await this.unlinkJournal();
      await this.unlinkLease();
      return;
    }
    if (current === null) {
      await this.unlinkLease();
      return;
    }
    this.assertRunBound(current);
    if (isUnfinishedJournalState(current.state) && options.force !== true) {
      throw new ValidationError(
        `The unfinished journal in state "${current.state}" must be resolved before it can be cleared.`,
      );
    }

    await this.unlinkJournal();
    await this.unlinkLease();
  }

  /**
   * Restores a previously read recovery journal after a failed recovery
   * restore. It is serialized against begin() and refuses to overwrite a run
   * whose lease is live.
   */
  async restore(journal: Journal): Promise<void> {
    const parsed = parseJournal(journal);
    const lockToken = await this.acquireBeginLock();
    try {
      await this.assertBeginLock(lockToken);
      if (await this.isRunLive()) {
        throw new JournalLockError(
          'A live run owns the journal; the recovery record cannot be restored over it.',
        );
      }
      await this.unlinkLease();
      await this.write(parsed);
    } finally {
      await this.releaseBeginLock(lockToken);
    }
  }

  async activeSnapshotIds(): Promise<ReadonlySet<string>> {
    const journal = await this.read();
    if (journal === null) return new Set<string>();
    if (isUnfinishedJournalState(journal.state) || journal.state === 'rollback-failed') {
      const ids = new Set<string>([journal.snapshotId]);
      if (journal.plan.kind === 'restore') ids.add(journal.plan.sourceSnapshotId);
      return ids;
    }
    return new Set<string>();
  }

  private assertRunBound(journal: Journal): void {
    if (this.expectedRunId !== undefined && journal.runId !== this.expectedRunId) {
      throw new JournalLockError(
        `The journal belongs to run "${journal.runId}", not "${this.expectedRunId}".`,
      );
    }
    if (this.runToken !== null && journal.runToken !== this.runToken) {
      throw new JournalLockError('The journal was replaced by a different run.');
    }
  }

  private get leasePath(): string {
    return `${this.path}${JOURNAL_LEASE_SUFFIX}`;
  }

  private async acquireLease(runId: string, runToken: string): Promise<void> {
    const contents = `${JSON.stringify({
      pid: process.pid,
      runId,
      runToken,
      createdAt: this.now().toISOString(),
    } satisfies JournalLease)}\n`;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      let handle;
      let created = false;
      try {
        handle = await open(this.leasePath, 'wx', 0o600);
        created = true;
        await handle.writeFile(contents, 'utf8');
        await handle.sync();
        return;
      } catch (error) {
        if (created) {
          await handle?.close().catch(() => undefined);
          handle = undefined;
          await this.unlinkLease().catch(() => undefined);
          throw error;
        }
        if (!isAlreadyExists(error)) throw error;
        const lease = await this.readLease();
        if (lease === null) {
          if (await this.leaseIsRecent()) {
            throw new JournalLockError(
              'Another apply or restore is starting and owns the journal lease.',
            );
          }
        } else {
          const createdAt = Date.parse(lease.createdAt);
          const stale =
            !Number.isFinite(createdAt) || this.now().getTime() - createdAt > LEASE_STALE_MS;
          if (!stale && isProcessAlive(lease.pid)) {
            throw new JournalLockError(
              `Another apply or restore is already running (helper pid ${lease.pid}).`,
            );
          }
        }
        await this.unlinkLease();
      } finally {
        await handle?.close().catch(() => undefined);
      }
    }

    throw new JournalLockError('The journal lease could not be acquired.');
  }

  private async releaseLease(runToken: string): Promise<void> {
    const lease = await this.readLease();
    if (lease !== null && lease.runToken === runToken) await this.unlinkLease();
  }

  private async readLease(): Promise<JournalLease | null> {
    let text: string;
    try {
      text = await readFile(this.leasePath, 'utf8');
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw error;
    }

    try {
      const value: unknown = JSON.parse(text);
      if (
        typeof value === 'object' &&
        value !== null &&
        'pid' in value &&
        'runId' in value &&
        'runToken' in value &&
        'createdAt' in value &&
        typeof (value as { pid?: unknown }).pid === 'number' &&
        typeof (value as { runId?: unknown }).runId === 'string' &&
        typeof (value as { runToken?: unknown }).runToken === 'string' &&
        typeof (value as { createdAt?: unknown }).createdAt === 'string'
      ) {
        return value as JournalLease;
      }
    } catch {
      // A corrupt lease is reclaimed like a stale one; the journal state still
      // blocks a new run until recovery clears it.
    }
    return null;
  }

  private async leaseIsRecent(): Promise<boolean> {
    try {
      const info = await stat(this.leasePath);
      return this.now().getTime() - info.mtimeMs < BEGIN_LOCK_STALE_MS;
    } catch (error) {
      if (isMissingFile(error)) return false;
      throw error;
    }
  }

  private async unlinkLease(): Promise<void> {
    await unlink(this.leasePath).catch((error: unknown) => {
      if (!isMissingFile(error)) throw error;
    });
  }

  private async unlinkLeaseForRun(journal: Journal): Promise<void> {
    const lease = await this.readLease();
    if (lease !== null && lease.runId === journal.runId) await this.unlinkLease();
  }

  private get beginLockPath(): string {
    return `${this.path}.begin.lock`;
  }

  private async acquireBeginLock(): Promise<string> {
    const token = randomUUID();
    const contents = `${JSON.stringify({
      pid: process.pid,
      token,
      createdAt: new Date().toISOString(),
    } satisfies BeginLockFile)}\n`;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      let handle;
      let created = false;
      try {
        handle = await open(this.beginLockPath, 'wx', 0o600);
        created = true;
        await handle.writeFile(contents, 'utf8');
        await handle.sync();
        return token;
      } catch (error) {
        if (created) {
          await handle?.close().catch(() => undefined);
          handle = undefined;
          await this.unlinkBeginLock().catch(() => undefined);
          throw error;
        }
        if (!isAlreadyExists(error)) throw error;
        if (!(await this.beginLockIsStale())) {
          throw new JournalLockError('Another apply or restore is already starting.');
        }
        await unlink(this.beginLockPath).catch((unlinkError: unknown) => {
          if (!isMissingFile(unlinkError)) throw unlinkError;
        });
      } finally {
        await handle?.close().catch(() => undefined);
      }
    }

    throw new JournalLockError('The journal begin lock could not be acquired.');
  }

  private async releaseBeginLock(token: string): Promise<void> {
    try {
      const lock = await this.readBeginLock();
      if (lock !== null && lock.token === token) await this.unlinkBeginLock();
    } catch {
      // A stale begin lock is reclaimed on the next attempt; never mask the
      // result of the begin operation if cleanup itself fails.
    }
  }

  private async assertBeginLock(token: string): Promise<void> {
    const lock = await this.readBeginLock();
    if (lock === null || lock.token !== token) {
      throw new JournalLockError('The journal begin lock was lost to another process.');
    }
  }

  private async readBeginLock(): Promise<BeginLockFile | null> {
    let text: string;
    try {
      text = await readFile(this.beginLockPath, 'utf8');
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw error;
    }

    try {
      const value: unknown = JSON.parse(text);
      if (
        typeof value === 'object' &&
        value !== null &&
        'pid' in value &&
        'token' in value &&
        'createdAt' in value &&
        typeof (value as { pid?: unknown }).pid === 'number' &&
        typeof (value as { token?: unknown }).token === 'string' &&
        typeof (value as { createdAt?: unknown }).createdAt === 'string'
      ) {
        return value as BeginLockFile;
      }
    } catch {
      // A lock file without valid JSON is handled by the age check.
    }
    return null;
  }

  private async beginLockIsStale(): Promise<boolean> {
    let info;
    try {
      info = await stat(this.beginLockPath);
    } catch (error) {
      if (isMissingFile(error)) return true;
      throw error;
    }

    const lock = await this.readBeginLock();
    if (lock !== null && lock.pid !== process.pid && !isProcessAlive(lock.pid)) return true;
    return Date.now() - info.mtimeMs > BEGIN_LOCK_STALE_MS;
  }

  private async unlinkBeginLock(): Promise<void> {
    await unlink(this.beginLockPath).catch((error: unknown) => {
      if (!isMissingFile(error)) throw error;
    });
  }

  private async unlinkJournal(): Promise<void> {
    await unlink(this.path).catch((error: unknown) => {
      if (!isMissingFile(error)) throw error;
    });
  }

  private async publishNewJournal(journal: Journal): Promise<boolean> {
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(serialized(journal), 'utf8');
      await handle.sync();
    } finally {
      await handle?.close().catch(() => undefined);
    }

    try {
      // Hard-linking a fully written temporary file publishes it atomically
      // and fails with EEXIST instead of replacing an existing journal.
      await link(temporary, this.path);
      return true;
    } catch (error) {
      if (isAlreadyExists(error)) return false;
      throw error;
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  private async write(journal: Journal): Promise<void> {
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(serialized(journal), 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }

    try {
      await renameWithRetry(rename, temporary, this.path);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}
