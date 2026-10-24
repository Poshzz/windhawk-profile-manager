import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseApplyResult, type ApplyResult } from '@shared/domain';
import { JournalLockError, ValidationError } from '@shared/errors';
import { buildPlan } from '@core/planner/apply-planner';
import { FileJournalStore, defaultJournalPath } from '@infra/journal/file-journal-store';
import {
  makeEnvironment,
  makeProfile,
  makeSnapshot,
  modKeys,
  planOptions,
} from '../planner/support';
import { makeRestorePlanForTest } from '../executor/executor-support';

const STARTED_AT = '2026-10-22T20:02:14.123Z';
const SNAPSHOT_ID = '2026-10-22T20-02-14-123Z';

function sampleResult(status: ApplyResult['status'] = 'rolled-back'): ApplyResult {
  return parseApplyResult({
    schemaVersion: 1,
    runId: 'run-2026-10-22T20-02-14-123Z',
    kind: 'apply',
    status,
    message: 'Sample result.',
    startedAt: STARTED_AT,
    completedAt: STARTED_AT,
    changedMods: [],
    skippedMods: [],
    warnings: [],
    reload: { requested: false, confirmed: false, message: 'No reload.' },
    verification: {
      status: 'not-run',
      checkedAt: null,
      message: 'Not run.',
    },
    actions: {
      rainmeter: { status: 'skipped' },
      explorer: { status: 'skipped' },
    },
    rollback: null,
    error: null,
  });
}

function samplePlan(overrides: Parameters<typeof planOptions>[0] = {}) {
  const profile = makeProfile();
  const snapshot = makeSnapshot(
    modKeys('windows-11-taskbar-styler', {
      settings: { TaskbarHeight: { type: 'dword', value: 40 } },
    }),
  );
  return buildPlan(profile, snapshot, makeEnvironment(), planOptions(overrides));
}

describe('FileJournalStore', () => {
  let directory: string;
  let path: string;
  let now: Date;
  let store: FileJournalStore;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'wpm-journal-'));
    path = join(directory, 'journal.json');
    now = new Date('2026-10-22T20:03:00.000Z');
    store = new FileJournalStore({ path, now: () => now });
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('writes a journal before work and detects it as unfinished on a fresh read', async () => {
    const plan = samplePlan();
    const journal = await store.begin({
      plan,
      snapshotId: SNAPSHOT_ID,
      startedAt: STARTED_AT,
    });

    expect(journal.state).toBe('journaling');
    expect(journal.snapshotId).toBe(SNAPSHOT_ID);
    expect(journal.planHash).toBe(plan.planHash);
    expect(journal.beforeHash).toBe(plan.beforeHash);

    const fresh = new FileJournalStore({ path });
    const read = await fresh.read();
    expect(read?.state).toBe('journaling');
    expect(await fresh.activeSnapshotIds()).toEqual(new Set([SNAPSHOT_ID]));
  });

  it('updates phase boundaries atomically and completes with a result', async () => {
    const plan = samplePlan();
    await store.begin({ plan, snapshotId: SNAPSHOT_ID, startedAt: STARTED_AT });

    now = new Date('2026-10-22T20:03:01.000Z');
    await store.update('applying');
    now = new Date('2026-10-22T20:03:02.000Z');
    await store.update('settling');
    now = new Date('2026-10-22T20:03:03.000Z');
    await store.update('verifying');
    const result = sampleResult('succeeded');
    now = new Date('2026-10-22T20:03:04.000Z');
    const completed = await store.update('privileged-complete', { result });

    expect(completed.state).toBe('privileged-complete');
    expect(completed.result?.status).toBe('succeeded');
    expect(completed.updatedAt).toBe('2026-10-22T20:03:04.000Z');
    expect((await store.read())?.state).toBe('privileged-complete');
    expect(await store.activeSnapshotIds()).toEqual(new Set([SNAPSHOT_ID]));
  });

  it('locks against a second process while the journal is unfinished', async () => {
    const plan = samplePlan();
    await store.begin({ plan, snapshotId: SNAPSHOT_ID, startedAt: STARTED_AT });

    const second = new FileJournalStore({ path });
    await expect(
      second.begin({ plan, snapshotId: SNAPSHOT_ID, startedAt: STARTED_AT }),
    ).rejects.toBeInstanceOf(JournalLockError);
  });

  it('serializes concurrent replacement of a terminal journal', async () => {
    const plan = samplePlan();
    await store.begin({ plan, snapshotId: SNAPSHOT_ID, startedAt: STARTED_AT });
    await store.update('rolling-back');
    await store.complete('rolled-back', sampleResult('rolled-back'));

    const contenders = Array.from({ length: 12 }, () =>
      new FileJournalStore({ path }).begin({
        plan,
        snapshotId: SNAPSHOT_ID,
        startedAt: STARTED_AT,
      }),
    );
    const results = await Promise.allSettled(contenders);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(11);
    for (const result of rejected) {
      expect(result.reason).toBeInstanceOf(JournalLockError);
    }
    expect((await store.read())?.state).toBe('journaling');
    await expect(access(`${path}.begin.lock`)).rejects.toThrow();
    expect(await readFile(path, 'utf8')).toContain('"state": "journaling"');
    expect((await readdir(directory)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('honors an active begin lock and leaves a terminal journal untouched', async () => {
    const plan = samplePlan();
    await store.begin({ plan, snapshotId: SNAPSHOT_ID, startedAt: STARTED_AT });
    await store.update('rolling-back');
    await store.complete('rolled-back', sampleResult('rolled-back'));

    await writeFile(
      `${path}.begin.lock`,
      JSON.stringify({
        pid: process.pid,
        token: 'other-process',
        createdAt: new Date().toISOString(),
      }),
      'utf8',
    );

    await expect(
      store.begin({ plan, snapshotId: SNAPSHOT_ID, startedAt: STARTED_AT }),
    ).rejects.toBeInstanceOf(JournalLockError);
    expect((await store.read())?.state).toBe('rolled-back');

    await rm(`${path}.begin.lock`);
    const next = await store.begin({
      plan,
      snapshotId: SNAPSHOT_ID,
      startedAt: STARTED_AT,
    });
    expect(next.state).toBe('journaling');
    await expect(access(`${path}.begin.lock`)).rejects.toThrow();
  });

  it('reclaims a begin lock whose owner is no longer running', async () => {
    const plan = samplePlan();
    await writeFile(
      `${path}.begin.lock`,
      JSON.stringify({
        pid: 0,
        token: 'dead-process',
        createdAt: new Date().toISOString(),
      }),
      'utf8',
    );

    const journal = await store.begin({ plan, snapshotId: SNAPSHOT_ID, startedAt: STARTED_AT });

    expect(journal.state).toBe('journaling');
    await expect(access(`${path}.begin.lock`)).rejects.toThrow();
  });

  it('force-clears an unparseable journal after a crash', async () => {
    const plan = samplePlan();
    await writeFile(path, '{"schemaVersion":1,"state":', 'utf8');

    await expect(store.read()).rejects.toBeInstanceOf(ValidationError);
    await expect(store.clear()).rejects.toBeInstanceOf(ValidationError);
    await expect(
      store.begin({ plan, snapshotId: SNAPSHOT_ID, startedAt: STARTED_AT }),
    ).rejects.toBeInstanceOf(ValidationError);

    await store.clear({ force: true });
    expect(await store.read()).toBeNull();
    const journal = await store.begin({ plan, snapshotId: SNAPSHOT_ID, startedAt: STARTED_AT });
    expect(journal.state).toBe('journaling');
  });

  it('archives a corrupt journal instead of deleting its evidence', async () => {
    await writeFile(path, '{"schemaVersion":1,"state":', 'utf8');

    const archivePath = await store.archiveCorrupt();

    expect(archivePath).not.toBeNull();
    expect(await store.read()).toBeNull();
    await expect(readFile(archivePath!, 'utf8')).resolves.toContain('"schemaVersion":1');
  });

  it('completes rolled-back and permits the next run to replace the journal', async () => {
    const plan = samplePlan();
    await store.begin({ plan, snapshotId: SNAPSHOT_ID, startedAt: STARTED_AT });
    await store.update('rolling-back');
    await store.complete('rolled-back', sampleResult('rolled-back'));

    expect((await store.read())?.state).toBe('rolled-back');
    expect(await store.activeSnapshotIds()).toEqual(new Set());

    const next = await store.begin({
      plan,
      snapshotId: '2026-10-22T20-04-00-000Z',
      startedAt: '2026-10-22T20:04:00.000Z',
    });
    expect(next.state).toBe('journaling');
  });

  it('keeps the restore source snapshot active as well as the pre-restore snapshot', async () => {
    const registry = makeSnapshot(
      modKeys('windows-11-taskbar-styler', {
        settings: { TaskbarHeight: { type: 'dword', value: 40 } },
      }),
    );
    const plan = makeRestorePlanForTest({
      source: { metadata: { id: 'source-snapshot' }, registry },
      current: registry,
      snapshotId: SNAPSHOT_ID,
    });
    await store.begin({ plan, snapshotId: SNAPSHOT_ID, startedAt: STARTED_AT });

    expect(await store.activeSnapshotIds()).toEqual(new Set([SNAPSHOT_ID, 'source-snapshot']));
  });

  it('keeps a rollback-failed journal and snapshot locked for manual recovery', async () => {
    const plan = samplePlan();
    await store.begin({ plan, snapshotId: SNAPSHOT_ID, startedAt: STARTED_AT });
    await store.update('rolling-back');
    await store.complete('rollback-failed', sampleResult('rollback-failed'));

    expect(await store.activeSnapshotIds()).toEqual(new Set([SNAPSHOT_ID]));
    await expect(
      store.begin({ plan, snapshotId: SNAPSHOT_ID, startedAt: STARTED_AT }),
    ).rejects.toBeInstanceOf(JournalLockError);
  });

  it('refuses to clear an unfinished journal without force', async () => {
    const plan = samplePlan();
    await store.begin({ plan, snapshotId: SNAPSHOT_ID, startedAt: STARTED_AT });
    await writeFile(
      `${path}.lease`,
      JSON.stringify({
        pid: 0,
        runId: plan.runId,
        runToken: 'stale-lease-token',
        createdAt: new Date().toISOString(),
      }),
      'utf8',
    );

    await expect(store.clear()).rejects.toBeInstanceOf(ValidationError);
    expect((await store.read())?.state).toBe('journaling');

    await store.clear({ force: true });
    expect(await store.read()).toBeNull();
  });

  it('writes a run token and a durable lease owned by the helper process', async () => {
    const plan = samplePlan();
    const journal = await store.begin({ plan, snapshotId: SNAPSHOT_ID, startedAt: STARTED_AT });

    expect(journal.runToken).toBeDefined();
    expect(journal.runToken?.length).toBeGreaterThanOrEqual(16);
    const lease = JSON.parse(await readFile(`${path}.lease`, 'utf8')) as {
      pid: number;
      runId: string;
      runToken: string;
    };
    expect(lease.pid).toBe(process.pid);
    expect(lease.runId).toBe(plan.runId);
    expect(lease.runToken).toBe(journal.runToken);
    expect(await store.isRunLive()).toBe(true);
  });

  it('refuses to force-clear a journal while its lease is live', async () => {
    const plan = samplePlan();
    await store.begin({ plan, snapshotId: SNAPSHOT_ID, startedAt: STARTED_AT });

    await expect(store.clear({ force: true })).rejects.toBeInstanceOf(JournalLockError);
    expect((await store.read())?.state).toBe('journaling');
    await expect(access(`${path}.lease`)).resolves.toBeUndefined();
  });

  it('treats a lease whose owner is no longer running as stale', async () => {
    const plan = samplePlan();
    await store.begin({ plan, snapshotId: SNAPSHOT_ID, startedAt: STARTED_AT });
    await writeFile(
      `${path}.lease`,
      JSON.stringify({
        pid: 0,
        runId: plan.runId,
        runToken: 'dead-lease-token',
        createdAt: new Date().toISOString(),
      }),
      'utf8',
    );

    expect(await store.isRunLive()).toBe(false);
    await store.clear({ force: true });
    expect(await store.read()).toBeNull();
  });

  it('does not wedge recovery forever on a recycled live PID', async () => {
    const plan = samplePlan();
    await store.begin({ plan, snapshotId: SNAPSHOT_ID, startedAt: STARTED_AT });
    await writeFile(
      `${path}.lease`,
      JSON.stringify({
        pid: process.pid,
        runId: plan.runId,
        runToken: 'recycled-pid-token',
        createdAt: new Date(Date.parse('2026-10-22T20:03:00.000Z') - 11 * 60_000).toISOString(),
      }),
      'utf8',
    );

    expect(await store.isRunLive()).toBe(false);
    await store.clear({ force: true });
    expect(await store.read()).toBeNull();
  });

  it('replaces an aged lease even when its PID was recycled', async () => {
    const plan = samplePlan();
    await writeFile(
      `${path}.lease`,
      JSON.stringify({
        pid: process.pid,
        runId: 'run-old',
        runToken: 'old-token',
        createdAt: new Date(Date.parse('2026-10-22T20:03:00.000Z') - 11 * 60_000).toISOString(),
      }),
      'utf8',
    );

    const journal = await store.begin({ plan, snapshotId: SNAPSHOT_ID, startedAt: STARTED_AT });
    expect(journal.runId).toBe(plan.runId);
  });

  it('rejects updates from a store bound to a different run', async () => {
    const plan = samplePlan();
    await store.begin({ plan, snapshotId: SNAPSHOT_ID, startedAt: STARTED_AT });
    const foreign = new FileJournalStore({ path, runId: 'run-another-2026-10-22T20-02-14-123Z' });

    await expect(foreign.update('applying')).rejects.toBeInstanceOf(JournalLockError);
    await expect(
      foreign.complete('rolled-back', sampleResult('rolled-back')),
    ).rejects.toBeInstanceOf(JournalLockError);
    expect((await store.read())?.state).toBe('journaling');
  });

  it('rejects updates from a store carrying the wrong run token', async () => {
    const plan = samplePlan();
    const journal = await store.begin({
      plan,
      snapshotId: SNAPSHOT_ID,
      startedAt: STARTED_AT,
    });
    const foreign = new FileJournalStore({
      path,
      runId: plan.runId,
      runToken: journal.runToken === 'x'.repeat(36) ? 'y'.repeat(36) : 'x'.repeat(36),
    });

    await expect(foreign.update('applying')).rejects.toBeInstanceOf(JournalLockError);
  });

  it('rejects updates from the previous run after a new run replaces the journal', async () => {
    const first = samplePlan();
    const firstJournal = await store.begin({
      plan: first,
      snapshotId: SNAPSHOT_ID,
      startedAt: STARTED_AT,
    });
    await store.update('rolling-back');
    await store.complete('rolled-back', sampleResult('rolled-back'));

    const secondPlan = buildPlan(
      makeProfile(),
      makeSnapshot(
        modKeys('windows-11-taskbar-styler', {
          settings: { TaskbarHeight: { type: 'dword', value: 40 } },
        }),
      ),
      makeEnvironment(),
      planOptions({ runId: 'run-second-2026-10-22T20-04-00-000Z' }),
    );
    const second = new FileJournalStore({ path });
    const secondJournal = await second.begin({
      plan: secondPlan,
      snapshotId: '2026-10-22T20-04-00-000Z',
      startedAt: '2026-10-22T20:04:00.000Z',
    });
    expect(secondJournal.runToken).not.toBe(firstJournal.runToken);

    await expect(store.update('applying')).rejects.toBeInstanceOf(JournalLockError);
    expect((await second.read())?.state).toBe('journaling');
  });

  it('removes the lease on a terminal completion', async () => {
    const plan = samplePlan();
    await store.begin({ plan, snapshotId: SNAPSHOT_ID, startedAt: STARTED_AT });
    await store.update('rolling-back');
    await store.complete('rolled-back', sampleResult('rolled-back'));

    await expect(access(`${path}.lease`)).rejects.toThrow();
    expect(await store.isRunLive()).toBe(false);
  });

  it('returns null for a missing journal and validates default path requirements', async () => {
    expect(await store.read()).toBeNull();
    const old = process.env.LOCALAPPDATA;
    delete process.env.LOCALAPPDATA;
    try {
      expect(() => defaultJournalPath()).toThrow(ValidationError);
    } finally {
      if (old !== undefined) process.env.LOCALAPPDATA = old;
    }
  });
});
