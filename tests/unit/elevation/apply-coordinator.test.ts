import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SCHEMA_VERSION,
  parseApplyResult,
  type ApplyResult,
  type ExecutionPlan,
} from '@shared/domain';
import { ApplyError, StaleProfileError } from '@shared/errors';
import { buildPlan } from '@core/planner/apply-planner';
import { FakeProcessController } from '@core/process/process-controller';
import { FakeApplyStateStore } from '@core/state/apply-state-store';
import { FakeElevationBroker } from '@core/elevation/elevation-broker';
import { ApplyCoordinator } from '@core/elevation/apply-coordinator';
import { FileJournalStore } from '@infra/journal/file-journal-store';
import {
  dword,
  makeEnvironment,
  makeProfile,
  makeSnapshot,
  modKeys,
  planOptions,
  stringValue,
} from '../planner/support';

const MOD = 'sample-mod';
const FIXED_NOW = '2026-10-22T20:02:20.000Z';
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

interface Fixture {
  readonly plan: ReturnType<typeof buildPlan>;
  readonly journal: FileJournalStore;
  readonly process: FakeProcessController;
  readonly state: FakeApplyStateStore;
}

async function fixture(
  actions: {
    rainmeter?: 'start' | 'stop' | 'unchanged';
    explorer?: 'ask' | 'always' | 'never';
  } = {},
): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'wpm-coordinator-'));
  directories.push(root);
  const planPath = join(root, 'runs', 'run-1', 'plan.json');
  const journalPath = join(root, 'LocalAppData', 'WindhawkProfileManager', 'journal.json');
  const snapshot = makeSnapshot([
    ...modKeys(MOD, {
      enabled: true,
      version: '1',
      settings: { Theme: stringValue('old') },
    }),
  ]);
  const plan = buildPlan(
    makeProfile({
      rainmeter: actions.rainmeter ?? 'stop',
      restartExplorer: actions.explorer ?? 'always',
      requiredMods: [
        {
          modId: MOD,
          state: 'enabled',
          mode: 'replace',
          settings: { Theme: stringValue('new'), Count: dword(3) },
        },
      ],
    }),
    snapshot,
    makeEnvironment(),
    planOptions({
      runId: 'run-1',
      snapshotId: 'snapshot-1',
      paths: {
        plan: planPath,
        snapshotRegistry: join(
          root,
          'LocalAppData',
          'WindhawkProfileManager',
          'snapshots',
          'snapshot-1.reg',
        ),
        journal: journalPath,
        result: join(root, 'runs', 'run-1', 'result.json'),
      },
    }),
  );

  const processController = new FakeProcessController();
  processController.explorerResult = {
    kill: { attempted: true, succeeded: true, detail: 'Explorer was stopped.' },
    start: { attempted: true, succeeded: true, detail: 'Explorer was started.' },
    shellRestarted: true,
  };

  return {
    plan,
    journal: new FileJournalStore({ path: journalPath }),
    process: processController,
    state: new FakeApplyStateStore(),
  };
}

function helperResult(
  plan: ExecutionPlan,
  status: ApplyResult['status'] = 'succeeded',
): ApplyResult {
  const privilegedSucceeded = status === 'succeeded' || status === 'succeeded-with-warning';
  return parseApplyResult({
    schemaVersion: SCHEMA_VERSION,
    runId: plan.runId,
    kind: plan.kind,
    status,
    message: 'Applied; reload requested, not confirmed loaded.',
    startedAt: '2026-10-22T20:02:14.000Z',
    completedAt: '2026-10-22T20:02:19.000Z',
    changedMods: privilegedSucceeded ? [MOD] : [],
    skippedMods: [],
    warnings: status === 'succeeded-with-warning' ? ['The privileged phase warned.'] : [],
    reload: {
      requested: privilegedSucceeded,
      confirmed: false,
      message: 'The engine watches the registry; reload was requested.',
    },
    verification: privilegedSucceeded
      ? {
          status: 'verified',
          checkedAt: '2026-10-22T20:02:19.000Z',
          message: 'All managed values matched.',
        }
      : { status: 'not-run', checkedAt: null, message: 'Not run.' },
    actions: {
      rainmeter: { status: 'skipped', message: 'main process' },
      explorer: { status: 'skipped', message: 'main process' },
    },
    rollback: status === 'rolled-back' ? { status: 'succeeded', message: 'Restored.' } : null,
    error: null,
  });
}

async function seedJournal(
  journal: FileJournalStore,
  plan: ExecutionPlan,
  result: ApplyResult,
): Promise<void> {
  await journal.begin({
    plan,
    snapshotId: plan.snapshotId,
    startedAt: '2026-10-22T20:02:14.000Z',
  });
  await journal.update('applying');
  await journal.update('privileged-complete', { result });
}

function coordinator(
  fx: Fixture,
  broker: FakeElevationBroker,
  readProfileRevision?: (profileId: string) => Promise<number | null>,
): ApplyCoordinator {
  return new ApplyCoordinator({
    broker,
    journalStoreFor: () => fx.journal,
    processController: fx.process,
    stateStore: fx.state,
    ...(readProfileRevision === undefined ? {} : { readProfileRevision }),
    clock: () => new Date(FIXED_NOW),
  });
}

describe('ApplyCoordinator', () => {
  it('runs Rainmeter and Explorer, records state, and finalizes the journal', async () => {
    const fx = await fixture();
    const result = helperResult(fx.plan);
    await seedJournal(fx.journal, fx.plan, result);
    const broker = new FakeElevationBroker(async () => result);

    const final = await coordinator(fx, broker).run(fx.plan);

    expect(final.status).toBe('succeeded');
    expect(final.actions.rainmeter.status).toBe('succeeded');
    expect(final.actions.explorer.status).toBe('succeeded');
    expect(final.completedAt).toBe(FIXED_NOW);
    expect(fx.process.quitRainmeterCalls).toBe(1);
    expect(fx.process.restartExplorerCalls).toBe(1);
    expect(fx.state.records).toEqual([
      { profileId: fx.plan.profileId, appliedAt: FIXED_NOW, runId: fx.plan.runId },
    ]);

    const journal = await fx.journal.read();
    expect(journal?.state).toBe('succeeded');
    expect(journal?.result?.status).toBe('succeeded');
    expect(journal?.result?.actions.explorer.status).toBe('succeeded');
  });

  it('finishes a privileged warning result and keeps the warning terminal state', async () => {
    const fx = await fixture();
    const result = helperResult(fx.plan, 'succeeded-with-warning');
    await seedJournal(fx.journal, fx.plan, result);
    const broker = new FakeElevationBroker(async () => result);

    const final = await coordinator(fx, broker).run(fx.plan);

    expect(final.status).toBe('succeeded-with-warning');
    expect(final.warnings).toContain('The privileged phase warned.');
    expect(fx.process.restartExplorerCalls).toBe(1);
    expect((await fx.journal.read())?.state).toBe('succeeded-with-warning');
  });

  it('continues to Explorer and returns a warning when Rainmeter fails', async () => {
    const fx = await fixture();
    fx.process.failQuitRainmeter = new Error('Rainmeter did not exit');
    const result = helperResult(fx.plan);
    await seedJournal(fx.journal, fx.plan, result);
    const broker = new FakeElevationBroker(async () => result);

    const final = await coordinator(fx, broker).run(fx.plan);

    expect(final.status).toBe('succeeded-with-warning');
    expect(final.actions.rainmeter.status).toBe('failed');
    expect(final.actions.explorer.status).toBe('succeeded');
    expect(final.warnings.join(' ')).toMatch(/Rainmeter did not exit/);
    expect(fx.process.restartExplorerCalls).toBe(1);
    expect((await fx.journal.read())?.state).toBe('succeeded-with-warning');
  });

  it('reports an Explorer failure as a warning', async () => {
    const fx = await fixture();
    fx.process.explorerResult = {
      kill: { attempted: true, succeeded: false, detail: 'Could not stop Explorer.' },
      start: { attempted: false, succeeded: false, detail: 'Not started.' },
      shellRestarted: false,
    };
    const result = helperResult(fx.plan);
    await seedJournal(fx.journal, fx.plan, result);
    const broker = new FakeElevationBroker(async () => result);

    const final = await coordinator(fx, broker).run(fx.plan);

    expect(final.status).toBe('succeeded-with-warning');
    expect(final.actions.explorer).toMatchObject({ status: 'failed' });
    expect(final.warnings.join(' ')).toMatch(/Could not stop Explorer/);
  });

  it('does not finish or run actions when the helper rolled back', async () => {
    const fx = await fixture();
    const result = helperResult(fx.plan, 'rolled-back');
    const broker = new FakeElevationBroker(async () => result);

    const final = await coordinator(fx, broker).run(fx.plan);

    expect(final.status).toBe('rolled-back');
    expect(fx.process.quitRainmeterCalls).toBe(0);
    expect(fx.process.restartExplorerCalls).toBe(0);
    expect(fx.state.records).toEqual([]);
    expect(await fx.journal.read()).toBeNull();
  });

  it('does not finish a dry run', async () => {
    const fx = await fixture();
    const result = helperResult(fx.plan, 'dry-run');
    const broker = new FakeElevationBroker(async () => result);

    const final = await coordinator(fx, broker).run(fx.plan);

    expect(final.status).toBe('dry-run');
    expect(fx.process.quitRainmeterCalls).toBe(0);
    expect(fx.state.records).toEqual([]);
  });

  it('refuses to run finishing actions without a matching privileged journal', async () => {
    const fx = await fixture();
    const result = helperResult(fx.plan);
    const broker = new FakeElevationBroker(async () => result);

    await expect(coordinator(fx, broker).run(fx.plan)).rejects.toThrow(ApplyError);
    expect(fx.process.quitRainmeterCalls).toBe(0);
  });

  it('rejects a stale or deleted profile before elevation', async () => {
    const fx = await fixture();
    let brokerCalls = 0;
    const broker = new FakeElevationBroker(async () => {
      brokerCalls += 1;
      throw new Error('The broker should not run for a stale profile.');
    });

    await expect(
      coordinator(fx, broker, async () => fx.plan.profileRevision + 1).run(fx.plan),
    ).rejects.toBeInstanceOf(StaleProfileError);
    await expect(coordinator(fx, broker, async () => null).run(fx.plan)).rejects.toBeInstanceOf(
      StaleProfileError,
    );
    expect(brokerCalls).toBe(0);
  });

  it('rejects a result from another run', async () => {
    const fx = await fixture();
    const other = { ...helperResult(fx.plan), runId: 'run-other' };
    const broker = new FakeElevationBroker(async () => parseApplyResult(other));
    await expect(coordinator(fx, broker).run(fx.plan)).rejects.toThrow(/does not belong/);
  });

  it('turns a state-store failure into a warning but still finalizes the journal', async () => {
    const fx = await fixture();
    fx.state.failWith = new Error('state file locked');
    const result = helperResult(fx.plan);
    await seedJournal(fx.journal, fx.plan, result);
    const broker = new FakeElevationBroker(async () => result);

    const final = await coordinator(fx, broker).run(fx.plan);

    expect(final.status).toBe('succeeded-with-warning');
    expect(final.warnings.join(' ')).toMatch(/state file locked/);
    expect((await fx.journal.read())?.state).toBe('succeeded-with-warning');
  });
});
