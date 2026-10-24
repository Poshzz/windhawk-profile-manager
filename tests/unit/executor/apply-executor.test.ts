import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  canonicalPlanHashInput,
  parseApplyResult,
  parsePlan,
  type ApplyPlan,
  type Environment,
  type RegistrySnapshot,
} from '@shared/domain';
import {
  CompatibilityError,
  JournalLockError,
  StalePlanError,
  StaleProfileError,
  ValidationError,
} from '@shared/errors';
import { ApplyExecutor, type ApplyExecutorOptions } from '@core/executor/apply-executor';
import { computeManagedHash } from '@core/planner/registry-state';
import { computeRestoreManagedHash, restoreSourceModIds } from '@core/planner/restore-state';
import { hashCanonical } from '@core/planner/registry-state';
import { buildPlan } from '@core/planner/apply-planner';
import { FakeServiceController } from '@core/services/service-controller';
import { applyMutationsToSnapshot } from '@core/registry/snapshot-operations';
import { FileJournalStore } from '@infra/journal/file-journal-store';
import { SnapshotStore } from '@infra/snapshots/snapshot-store';
import { NodeSnapshotFileSystem } from '@infra/storage/snapshot-file-system';
import {
  dword,
  makeEnvironment,
  makeProfile,
  makeSnapshot,
  managedMod,
  modKeys,
  modRootPath,
  planOptions,
  stringValue,
} from '../planner/support';
import {
  FlakyJournalStore,
  BarrierSnapshotPort,
  RecordingAcl,
  ScriptedRegistryGateway,
  flattenOps,
  makeRestorePlanForTest,
} from './executor-support';

const MOD_ID = 'windows-11-taskbar-styler';
const SETTINGS_PATH = `${modRootPath(MOD_ID)}\\Settings`;
const FIXED_NOW = '2026-10-22T20:03:00.000Z';
const SNAPSHOT_AT = '2026-10-22T20:02:14.123Z';

interface Fixture {
  readonly directory: string;
  readonly gateway: ScriptedRegistryGateway;
  readonly snapshotStore: SnapshotStore;
  readonly journalInner: FileJournalStore;
  readonly journal: FlakyJournalStore;
  readonly service: FakeServiceController;
  readonly acl: RecordingAcl;
  readonly executor: ApplyExecutor;
  readonly makeExecutor: (overrides?: Partial<ApplyExecutorOptions>) => ApplyExecutor;
}

function environment(): Environment {
  return makeEnvironment();
}

function workspaceSnapshot(
  options: {
    readonly enabled?: boolean;
    readonly taskbarHeight?: number;
    readonly theme?: string;
    readonly extra?: string | null;
    readonly marker?: number;
  } = {},
): RegistrySnapshot {
  const settings: Record<
    string,
    { type: 'dword'; value: number } | { type: 'string'; value: string }
  > = {
    TaskbarHeight: dword(options.taskbarHeight ?? 40),
    Theme: stringValue(options.theme ?? 'default'),
  };
  if (options.extra !== null) {
    settings.Extra = stringValue(options.extra ?? 'keep-me');
  }

  return makeSnapshot(
    modKeys(MOD_ID, {
      enabled: options.enabled ?? true,
      version: '1.0',
      settings,
      extraRootValues: { SettingsChangeTime: dword(options.marker ?? 100) },
    }),
  );
}

function applyPlanFor(
  snapshot: RegistrySnapshot,
  overrides: Parameters<typeof makeProfile>[0] = {},
): ApplyPlan {
  return buildPlan(makeProfile(overrides), snapshot, environment(), planOptions());
}

async function createFixture(
  initial: RegistrySnapshot,
  options: { readonly automaticRetentionLimit?: number } = {},
): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'wpm-executor-'));
  const snapshotDirectory = join(directory, 'snapshots');
  const journalPath = join(directory, 'journal.json');
  const acl = new RecordingAcl();
  const gateway = new ScriptedRegistryGateway(initial);
  const journalInner = new FileJournalStore({
    path: journalPath,
    now: () => new Date(FIXED_NOW),
  });
  const journal = new FlakyJournalStore(journalInner);

  let snapshotTick = Date.parse('2026-10-22T20:00:00.000Z');
  const snapshotStore = new SnapshotStore({
    gateway,
    directory: snapshotDirectory,
    fileSystem: new NodeSnapshotFileSystem(acl),
    now: () => {
      snapshotTick += 1000;
      return new Date(snapshotTick);
    },
    activeJournalSnapshotIds: () => journal.activeSnapshotIds(),
    ...(options.automaticRetentionLimit === undefined
      ? {}
      : { automaticRetentionLimit: options.automaticRetentionLimit }),
  });

  const service = new FakeServiceController({ state: 'running' });
  const baseOptions: ApplyExecutorOptions = {
    snapshotStore,
    registry: gateway,
    service,
    journalStore: journal,
    environment: environment(),
    clock: { now: () => new Date(FIXED_NOW) },
    sleep: async () => undefined,
  };
  const makeExecutor = (overrides: Partial<ApplyExecutorOptions> = {}) =>
    new ApplyExecutor({ ...baseOptions, ...overrides });

  return {
    directory,
    gateway,
    snapshotStore,
    journalInner,
    journal,
    service,
    acl,
    executor: makeExecutor(),
    makeExecutor,
  };
}

async function dispose(fixture: Fixture): Promise<void> {
  await rm(fixture.directory, { recursive: true, force: true });
}

function tamperSettingsHash(plan: ApplyPlan): ApplyPlan {
  const base = {
    ...plan,
    modChanges: plan.modChanges.map((change, index) =>
      index === 0 ? { ...change, settingsHash: `sha256:${'1'.repeat(64)}` } : change,
    ),
  };
  return parsePlan({
    ...base,
    planHash: hashCanonical(canonicalPlanHashInput(base)),
  }) as ApplyPlan;
}

describe('ApplyExecutor apply', () => {
  const fixtures: Fixture[] = [];

  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map((fixture) => dispose(fixture)));
  });

  async function fixture(
    snapshot: RegistrySnapshot = workspaceSnapshot(),
    options: { readonly automaticRetentionLimit?: number } = {},
  ): Promise<Fixture> {
    const created = await createFixture(snapshot, options);
    fixtures.push(created);
    return created;
  }

  it('snapshots, journals, writes settings, stamps a marker, and leaves the service running', async () => {
    const preRun = workspaceSnapshot();
    const fx = await fixture(preRun);
    const plan = applyPlanFor(preRun);

    const result = await fx.executor.execute(plan);

    expect(parseApplyResult(result).status).toBe('succeeded');
    expect(result.message).toMatch(/reload requested, not confirmed loaded/i);
    expect(result.reload.requested).toBe(true);
    expect(result.reload.confirmed).toBe(false);
    expect(result.verification.status).toBe('verified');
    expect(result.changedMods).toEqual([MOD_ID]);
    expect(fx.service.startCalls).toBe(0);
    expect(fx.service.statusCalls).toBe(2);

    const snapshots = await fx.snapshotStore.list();
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.metadata.trigger).toBe('pre-apply');
    expect(fx.gateway.exportCalls).toHaveLength(1);

    const journal = await fx.journalInner.read();
    expect(journal?.state).toBe('privileged-complete');
    expect(journal?.result?.status).toBe('succeeded');
    expect(journal?.snapshotId).toBe(snapshots[0]?.metadata.id);
    expect(fx.journal.updateStates).toEqual([
      'applying',
      'settling',
      'verifying',
      'privileged-complete',
    ]);

    expect(fx.gateway.applyCalls).toHaveLength(2);
    const settingsOps = fx.gateway.applyCalls[0] ?? [];
    expect(settingsOps.some((op) => op.name === 'TaskbarHeight')).toBe(true);
    expect(settingsOps.some((op) => op.name === 'Theme')).toBe(true);
    expect(settingsOps.some((op) => op.kind === 'deleteValue' && op.name === 'Extra')).toBe(true);
    const markerOps = fx.gateway.applyCalls[1] ?? [];
    expect(markerOps).toHaveLength(1);
    expect(markerOps[0]?.name).toBe('SettingsChangeTime');
    expect(markerOps[0]?.kind).toBe('set');
    if (markerOps[0]?.kind === 'set') {
      expect(markerOps[0].value.type).toBe('dword');
    }

    const after = fx.gateway.getSnapshot();
    const root = after.keys.find((key) => key.path === modRootPath(MOD_ID));
    const settings = after.keys.find((key) => key.path === SETTINGS_PATH);
    expect(root?.values.find((value) => value.name === 'Disabled')?.value).toEqual(dword(0));
    expect(settings?.values.some((value) => value.name === 'Extra')).toBe(false);
    expect(settings?.values.find((value) => value.name === 'TaskbarHeight')?.value).toEqual(
      dword(48),
    );
    const marker = root?.values.find((value) => value.name === 'SettingsChangeTime')?.value;
    expect(marker?.type).toBe('dword');
    if (marker?.type === 'dword') {
      expect(marker.value).toBe(Math.floor(Date.parse(FIXED_NOW) / 1000) & 0x7fffffff);
      expect(marker.value).toBeGreaterThan(100);
      expect(marker.value).toBeLessThanOrEqual(0x7fffffff);
    }
  });

  it('can merge ordered apply batches into one registry call', async () => {
    const preRun = workspaceSnapshot();
    const fx = await fixture(preRun);
    const plan = applyPlanFor(preRun);

    const result = await fx.makeExecutor({ mergeApplyBatches: true }).execute(plan);

    expect(result.status).toBe('succeeded');
    expect(fx.gateway.applyCalls).toHaveLength(1);
    const ops = fx.gateway.applyCalls[0] ?? [];
    expect(ops.some((op) => op.name === 'TaskbarHeight')).toBe(true);
    expect(ops[ops.length - 1]?.name).toBe('SettingsChangeTime');
  });

  it('rolls back when the helper watchdog expires instead of killing a write', async () => {
    const preRun = workspaceSnapshot();
    const fx = await fixture(preRun);
    const plan = applyPlanFor(preRun);

    const result = await fx.makeExecutor({ watchdogMs: 0 }).execute(plan);

    expect(result.status).toBe('rolled-back');
    expect(result.message).toMatch(/watchdog expired/i);
    expect(result.rollback?.status).toBe('succeeded');
    expect(fx.gateway.exportCalls).toHaveLength(1);
    expect(fx.gateway.applyCalls).toEqual([]);

    const journal = await fx.journalInner.read();
    expect(journal?.state).toBe('rolled-back');
    expect(journal?.result?.status).toBe('rolled-back');
  });

  it('refuses an unconfirmed delete-all plan before snapshots or writes', async () => {
    const preRun = workspaceSnapshot();
    const fx = await fixture(preRun);
    const plan = applyPlanFor(preRun, {
      requiredMods: [managedMod({ modId: MOD_ID, settings: {} })],
    });

    await expect(fx.executor.execute(plan)).rejects.toBeInstanceOf(ValidationError);
    expect(await fx.snapshotStore.list()).toEqual([]);
    expect(await fx.journalInner.read()).toBeNull();
    expect(fx.gateway.applyCalls).toEqual([]);
  });

  it('rejects a blocked theme-pack plan before any snapshot or write', async () => {
    const preRun = workspaceSnapshot();
    const fx = await fixture(preRun);
    const plan = buildPlan(
      makeProfile({
        requiredMods: [managedMod({ modId: MOD_ID }), managedMod({ modId: 'missing-theme-mod' })],
      }),
      preRun,
      environment(),
      planOptions({ requireAllRequiredMods: true }),
    );

    await expect(fx.executor.execute(plan)).rejects.toBeInstanceOf(CompatibilityError);
    expect(await fx.snapshotStore.list()).toEqual([]);
    expect(await fx.journalInner.read()).toBeNull();
    expect(fx.gateway.applyCalls).toEqual([]);
  });

  it('executes a confirmed delete-all plan and deletes the settings', async () => {
    const preRun = workspaceSnapshot();
    const fx = await fixture(preRun);
    const plan = buildPlan(
      makeProfile({
        requiredMods: [managedMod({ modId: MOD_ID, settings: {} })],
      }),
      preRun,
      environment(),
      planOptions({ confirmDeleteAllSettings: true }),
    );

    const result = await fx.executor.execute(plan);

    expect(result.status).toBe('succeeded');
    const settings = fx.gateway
      .getSnapshot()
      .keys.find((key) => key.path === SETTINGS_PATH)?.values;
    expect(settings).toEqual([]);
  });

  it('does not write SettingsChangeTime for a disabled-only transition', async () => {
    const preRun = workspaceSnapshot({ enabled: true, marker: 123 });
    const fx = await fixture(preRun);
    const plan = applyPlanFor(preRun, {
      requiredMods: [managedMod({ modId: MOD_ID, state: 'disabled', mode: 'merge' })],
    });

    const result = await fx.executor.execute(plan);

    expect(result.status).toBe('succeeded');
    expect(fx.gateway.applyCalls).toHaveLength(1);
    expect(fx.gateway.applyCalls[0]).toEqual([
      {
        kind: 'set',
        path: modRootPath(MOD_ID),
        name: 'Disabled',
        value: dword(1),
      },
    ]);
    const after = fx.gateway.getSnapshot();
    const root = after.keys.find((key) => key.path === modRootPath(MOD_ID));
    expect(root?.values.find((value) => value.name === 'SettingsChangeTime')?.value).toEqual(
      dword(123),
    );
    expect(root?.values.find((value) => value.name === 'Disabled')?.value).toEqual(dword(1));
  });

  it('writes Disabled=1 first, then settings, then the marker for a disable with updates', async () => {
    const preRun = workspaceSnapshot({ enabled: true, taskbarHeight: 40, theme: 'default' });
    const fx = await fixture(preRun);
    const plan = applyPlanFor(preRun, {
      requiredMods: [
        managedMod({
          modId: MOD_ID,
          state: 'disabled',
          settings: { TaskbarHeight: dword(48), Theme: stringValue('macOS') },
        }),
      ],
    });

    await fx.executor.execute(plan);

    expect(fx.gateway.applyCalls).toHaveLength(3);
    expect(fx.gateway.applyCalls[0]?.map((op) => op.name)).toEqual(['Disabled']);
    const disableOp = fx.gateway.applyCalls[0]?.[0];
    expect(disableOp?.kind).toBe('set');
    if (disableOp?.kind === 'set') {
      expect(disableOp.value).toEqual(dword(1));
    }
    expect(fx.gateway.applyCalls[1]?.every((op) => op.path === SETTINGS_PATH)).toBe(true);
    expect(fx.gateway.applyCalls[2]?.map((op) => op.name)).toEqual(['SettingsChangeTime']);
  });

  it('writes settings and the marker before Disabled=0 for an enable', async () => {
    const preRun = workspaceSnapshot({
      enabled: false,
      taskbarHeight: 40,
      theme: 'default',
    });
    const fx = await fixture(preRun);
    const plan = applyPlanFor(preRun, {
      requiredMods: [
        managedMod({
          modId: MOD_ID,
          state: 'enabled',
          settings: { TaskbarHeight: dword(48), Theme: stringValue('macOS') },
        }),
      ],
    });

    await fx.executor.execute(plan);

    expect(fx.gateway.applyCalls).toHaveLength(3);
    expect(fx.gateway.applyCalls[0]?.every((op) => op.path === SETTINGS_PATH)).toBe(true);
    expect(fx.gateway.applyCalls[1]?.map((op) => op.name)).toEqual(['SettingsChangeTime']);
    expect(fx.gateway.applyCalls[2]).toEqual([
      {
        kind: 'set',
        path: modRootPath(MOD_ID),
        name: 'Disabled',
        value: dword(0),
      },
    ]);
  });

  it('performs no writes, journaling, snapshotting, or service checks in a dry run', async () => {
    const preRun = workspaceSnapshot();
    const fx = await fixture(preRun);
    const plan = applyPlanFor(preRun);

    const result = await fx.executor.execute(plan, { dryRun: true });

    expect(result.status).toBe('dry-run');
    expect(result.changedMods).toEqual([MOD_ID]);
    expect(result.reload.requested).toBe(false);
    expect(fx.gateway.applyCalls).toEqual([]);
    expect(fx.gateway.exportCalls).toEqual([]);
    expect(fx.gateway.readCalls).toBe(1);
    expect(await fx.snapshotStore.list()).toEqual([]);
    expect(await fx.journalInner.read()).toBeNull();
    expect(fx.service.statusCalls).toBe(0);
    expect(fx.journal.updateStates).toEqual([]);
  });

  it('rejects a stale beforeHash before snapshot, journal, or service work', async () => {
    const preRun = workspaceSnapshot();
    const fx = await fixture(preRun);
    const plan = applyPlanFor(preRun);
    fx.gateway.setSnapshot(workspaceSnapshot({ taskbarHeight: 41 }));

    await expect(fx.executor.execute(plan)).rejects.toBeInstanceOf(StalePlanError);
    expect(fx.gateway.applyCalls).toEqual([]);
    expect(await fx.snapshotStore.list()).toEqual([]);
    expect(await fx.journalInner.read()).toBeNull();
    expect(fx.service.statusCalls).toBe(0);
  });

  it('rejects a stale unlisted mod state when the profile disables all others', async () => {
    const preRun = makeSnapshot([
      ...workspaceSnapshot().keys,
      ...modKeys('extra-mod', { enabled: false }),
    ]);
    const fx = await fixture(preRun);
    const plan = applyPlanFor(preRun, { unlistedMods: 'disable' });
    fx.gateway.setSnapshot(
      makeSnapshot([...workspaceSnapshot().keys, ...modKeys('extra-mod', { enabled: true })]),
    );

    await expect(fx.executor.execute(plan)).rejects.toBeInstanceOf(StalePlanError);
    expect(await fx.snapshotStore.list()).toEqual([]);
    expect(fx.gateway.applyCalls).toEqual([]);
  });

  it('rejects a mod installed after a disable-all plan even when no unlisted mod was listed', async () => {
    const preRun = workspaceSnapshot();
    const fx = await fixture(preRun);
    const plan = applyPlanFor(preRun, { unlistedMods: 'disable' });
    expect(plan.unlistedMods).toEqual([]);
    fx.gateway.setSnapshot(
      makeSnapshot([...preRun.keys, ...modKeys('late-mod', { enabled: true })]),
    );

    await expect(fx.executor.execute(plan)).rejects.toBeInstanceOf(StalePlanError);
    expect(await fx.snapshotStore.list()).toEqual([]);
    expect(fx.gateway.applyCalls).toEqual([]);
  });

  it('rejects a mod installed between preflight and snapshot capture', async () => {
    const preRun = workspaceSnapshot();
    const fx = await fixture(preRun);
    const plan = applyPlanFor(preRun, { unlistedMods: 'disable' });
    fx.gateway.tamperExport = (snapshot) =>
      makeSnapshot([...snapshot.keys, ...modKeys('during-capture', { enabled: true })]);

    await expect(fx.executor.execute(plan)).rejects.toBeInstanceOf(StalePlanError);
    expect(await fx.snapshotStore.list()).toHaveLength(1);
    expect(await fx.journalInner.read()).toBeNull();
    expect(fx.gateway.applyCalls).toEqual([]);
  });

  it('rejects a stale per-mod settingsHash even when beforeHash still matches', async () => {
    const preRun = workspaceSnapshot();
    const fx = await fixture(preRun);
    const plan = tamperSettingsHash(applyPlanFor(preRun));

    await expect(fx.executor.execute(plan)).rejects.toThrow(/Settings for/u);
    expect(fx.gateway.applyCalls).toEqual([]);
    expect(await fx.snapshotStore.list()).toEqual([]);
    expect(await fx.journalInner.read()).toBeNull();
    expect(fx.service.statusCalls).toBe(0);
  });

  it('aborts before journaling when the captured snapshot hash differs from beforeHash', async () => {
    const preRun = workspaceSnapshot();
    const fx = await fixture(preRun);
    const plan = applyPlanFor(preRun);
    fx.gateway.tamperExport = (snapshot) =>
      applyMutationsToSnapshot(snapshot, [
        {
          kind: 'set',
          path: SETTINGS_PATH,
          name: 'TaskbarHeight',
          value: dword(999),
        },
      ]);

    await expect(fx.executor.execute(plan)).rejects.toBeInstanceOf(StalePlanError);
    expect(fx.gateway.exportCalls).toHaveLength(1);
    expect(fx.gateway.applyCalls).toEqual([]);
    expect(await fx.snapshotStore.list()).toHaveLength(1);
    expect(await fx.journalInner.read()).toBeNull();
  });

  it('rejects a second execution through the journal lock', async () => {
    const preRun = workspaceSnapshot();
    const fx = await fixture(preRun);
    const plan = applyPlanFor(preRun);
    await fx.journalInner.begin({
      plan,
      snapshotId: plan.snapshotId,
      startedAt: SNAPSHOT_AT,
    });

    await expect(fx.executor.execute(plan)).rejects.toBeInstanceOf(JournalLockError);
    expect(fx.gateway.applyCalls).toEqual([]);
    expect((await fx.journalInner.read())?.state).toBe('journaling');
  });

  it('rejects one of two concurrent executions through the journal lock', async () => {
    const preRun = workspaceSnapshot();
    const fx = await fixture(preRun);
    const plan = applyPlanFor(preRun);
    const barrier = new BarrierSnapshotPort(fx.snapshotStore);
    const first = fx.makeExecutor({ snapshotStore: barrier });
    const second = fx.makeExecutor({ snapshotStore: barrier });

    const results = await Promise.allSettled([first.execute(plan), second.execute(plan)]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(JournalLockError);
    expect((await fx.journalInner.read())?.state).toBe('privileged-complete');
  });

  it('returns failed with no journal when the snapshot export fails', async () => {
    const preRun = workspaceSnapshot();
    const fx = await fixture(preRun);
    const plan = applyPlanFor(preRun);
    fx.gateway.failExport = new Error('export failed');

    const result = await fx.executor.execute(plan);

    expect(result.status).toBe('failed');
    expect(result.error?.message).toMatch(/export failed/u);
    expect(result.rollback).toBeNull();
    expect(fx.gateway.applyCalls).toEqual([]);
    expect(await fx.snapshotStore.list()).toEqual([]);
    expect(await fx.journalInner.read()).toBeNull();
  });

  it('returns failed when the journal cannot be created', async () => {
    const preRun = workspaceSnapshot();
    const fx = await fixture(preRun);
    const plan = applyPlanFor(preRun);
    fx.journal.failBegin = new Error('journal disk full');

    const result = await fx.executor.execute(plan);

    expect(result.status).toBe('failed');
    expect(result.error?.message).toMatch(/journal disk full/u);
    expect(fx.gateway.applyCalls).toEqual([]);
    expect(await fx.journalInner.read()).toBeNull();
    expect(await fx.snapshotStore.list()).toHaveLength(1);
  });

  it('returns failed and leaves an unfinished journal if applying cannot be recorded', async () => {
    const preRun = workspaceSnapshot();
    const fx = await fixture(preRun);
    const plan = applyPlanFor(preRun);
    fx.journal.failUpdateOnceAt = 'applying';

    const result = await fx.executor.execute(plan);

    expect(result.status).toBe('failed');
    expect(fx.gateway.applyCalls).toEqual([]);
    const journal = await fx.journalInner.read();
    expect(journal?.state).toBe('journaling');
    expect(await fx.journalInner.activeSnapshotIds()).toEqual(new Set([journal?.snapshotId]));
  });

  it('rolls back when the disable batch fails', async () => {
    const preRun = workspaceSnapshot({ enabled: true });
    const fx = await fixture(preRun);
    const plan = applyPlanFor(preRun, {
      requiredMods: [
        managedMod({
          modId: MOD_ID,
          state: 'disabled',
          settings: { TaskbarHeight: dword(48) },
        }),
      ],
    });
    fx.gateway.failApplyCalls.add(0);

    const result = await fx.executor.execute(plan);

    expect(result.status).toBe('rolled-back');
    expect(result.rollback?.status).toBe('succeeded');
    expect(result.error?.message).toMatch(/Injected registry write failure/u);
    expect(computeManagedHash([MOD_ID], fx.gateway.getSnapshot())).toBe(
      computeManagedHash([MOD_ID], preRun),
    );
    expect((await fx.journalInner.read())?.state).toBe('rolled-back');
    expect(fx.journal.updateStates).toContain('rolling-back');
    expect(fx.service.state).toBe('running');
  });

  it('rolls back when the settings batch fails', async () => {
    const preRun = workspaceSnapshot({ enabled: true });
    const fx = await fixture(preRun);
    const plan = applyPlanFor(preRun, {
      requiredMods: [
        managedMod({
          modId: MOD_ID,
          state: 'disabled',
          settings: { TaskbarHeight: dword(48) },
        }),
      ],
    });
    fx.gateway.failApplyCalls.add(1);

    const result = await fx.executor.execute(plan);

    expect(result.status).toBe('rolled-back');
    expect(computeManagedHash([MOD_ID], fx.gateway.getSnapshot())).toBe(
      computeManagedHash([MOD_ID], preRun),
    );
    expect((await fx.journalInner.read())?.state).toBe('rolled-back');
    expect(fx.gateway.applyCalls.length).toBeGreaterThanOrEqual(3);
  });

  it('rolls back when the marker batch fails', async () => {
    const preRun = workspaceSnapshot({ enabled: true });
    const fx = await fixture(preRun);
    const plan = applyPlanFor(preRun, {
      requiredMods: [
        managedMod({
          modId: MOD_ID,
          state: 'disabled',
          settings: { TaskbarHeight: dword(48) },
        }),
      ],
    });
    fx.gateway.failApplyCalls.add(2);

    const result = await fx.executor.execute(plan);

    expect(result.status).toBe('rolled-back');
    expect(computeManagedHash([MOD_ID], fx.gateway.getSnapshot())).toBe(
      computeManagedHash([MOD_ID], preRun),
    );
    expect((await fx.journalInner.read())?.state).toBe('rolled-back');
  });

  it('deletes settings values added by the failed run during rollback', async () => {
    const preRun = workspaceSnapshot({ enabled: true, taskbarHeight: 40 });
    const fx = await fixture(preRun);
    const plan = applyPlanFor(preRun, {
      requiredMods: [
        managedMod({
          modId: MOD_ID,
          state: 'enabled',
          mode: 'merge',
          settings: { TaskbarHeight: dword(48), AddedByRun: dword(7) },
        }),
      ],
    });
    fx.gateway.failApplyCalls.add(1);

    const result = await fx.executor.execute(plan);

    expect(result.status).toBe('rolled-back');
    const settings = fx.gateway
      .getSnapshot()
      .keys.find((key) => key.path === SETTINGS_PATH)?.values;
    expect(settings?.some((value) => value.name === 'AddedByRun')).toBe(false);
    expect(settings?.find((value) => value.name === 'TaskbarHeight')?.value).toEqual(dword(40));
    expect(computeManagedHash([MOD_ID], fx.gateway.getSnapshot())).toBe(
      computeManagedHash([MOD_ID], preRun),
    );
  });

  it('rolls back when the enable batch fails', async () => {
    const preRun = workspaceSnapshot({ enabled: false });
    const fx = await fixture(preRun);
    const plan = applyPlanFor(preRun, {
      requiredMods: [
        managedMod({
          modId: MOD_ID,
          state: 'enabled',
          settings: { TaskbarHeight: dword(48) },
        }),
      ],
    });
    fx.gateway.failApplyCalls.add(2);

    const result = await fx.executor.execute(plan);

    expect(result.status).toBe('rolled-back');
    expect(computeManagedHash([MOD_ID], fx.gateway.getSnapshot())).toBe(
      computeManagedHash([MOD_ID], preRun),
    );
    expect((await fx.journalInner.read())?.state).toBe('rolled-back');
  });

  it('rolls back when settling fails', async () => {
    const preRun = workspaceSnapshot();
    const fx = await fixture(preRun);
    const plan = applyPlanFor(preRun);
    let calls = 0;
    const executor = fx.makeExecutor({
      sleep: async () => {
        calls += 1;
        if (calls === 1) throw new Error('settle failed');
      },
    });

    const result = await executor.execute(plan);

    expect(result.status).toBe('rolled-back');
    expect(result.rollback?.status).toBe('succeeded');
    expect(computeManagedHash([MOD_ID], fx.gateway.getSnapshot())).toBe(
      computeManagedHash([MOD_ID], preRun),
    );
    expect((await fx.journalInner.read())?.state).toBe('rolled-back');
    expect(calls).toBe(2);
  });

  it('rolls back when verification sees a different value', async () => {
    const preRun = workspaceSnapshot();
    const fx = await fixture(preRun);
    const plan = applyPlanFor(preRun);
    fx.gateway.tamperReadAtCall = 2;
    fx.gateway.tamperRead = (snapshot) =>
      applyMutationsToSnapshot(snapshot, [
        {
          kind: 'set',
          path: SETTINGS_PATH,
          name: 'TaskbarHeight',
          value: dword(999),
        },
      ]);

    const result = await fx.executor.execute(plan);

    expect(result.status).toBe('rolled-back');
    expect(result.error?.message).toMatch(/Verification failed/u);
    expect(computeManagedHash([MOD_ID], fx.gateway.getSnapshot())).toBe(
      computeManagedHash([MOD_ID], preRun),
    );
    expect((await fx.journalInner.read())?.state).toBe('rolled-back');
  });

  it('rolls back when the Windhawk service stops before verification completes', async () => {
    const preRun = workspaceSnapshot();
    const fx = await fixture(preRun);
    const plan = applyPlanFor(preRun);
    let stopped = false;
    const executor = fx.makeExecutor({
      sleep: async () => {
        if (stopped) return;
        stopped = true;
        fx.service.setState('stopped');
      },
    });

    const result = await executor.execute(plan);

    expect(result.status).toBe('rolled-back');
    expect(result.error?.message).toMatch(/service is stopped/i);
    expect(fx.service.state).toBe('running');
    expect(fx.service.startCalls).toBe(1);
    expect(computeManagedHash([MOD_ID], fx.gateway.getSnapshot())).toBe(
      computeManagedHash([MOD_ID], preRun),
    );
  });

  it('verifies the original touched mods even when rollback planned no writes', async () => {
    const preRun = workspaceSnapshot();
    const fx = await fixture(preRun);
    const plan = applyPlanFor(preRun);
    fx.gateway.failApplyCalls.add(0);
    fx.gateway.tamperReadAtCall = 3;
    fx.gateway.tamperRead = (snapshot) =>
      applyMutationsToSnapshot(snapshot, [
        {
          kind: 'set',
          path: SETTINGS_PATH,
          name: 'TaskbarHeight',
          value: dword(999),
        },
      ]);

    const result = await fx.executor.execute(plan);

    expect(result.status).toBe('rollback-failed');
    expect(result.rollback?.status).toBe('failed');
    expect(result.message).toMatch(/manual/iu);
    expect(fx.gateway.readCalls).toBe(3);
  });

  it('retries a transient journal failure while recording a successful rollback', async () => {
    const preRun = workspaceSnapshot();
    const fx = await fixture(preRun);
    const plan = applyPlanFor(preRun);
    fx.gateway.failApplyCalls.add(1);
    fx.journal.failCompleteOnce = true;

    const result = await fx.executor.execute(plan);

    expect(result.status).toBe('rolled-back');
    expect((await fx.journalInner.read())?.state).toBe('rolled-back');
  });

  it('reports a verified rollback with a warning when the journal cannot be finalized', async () => {
    const preRun = workspaceSnapshot();
    const fx = await fixture(preRun);
    const plan = applyPlanFor(preRun);
    fx.gateway.failApplyCalls.add(1);
    fx.journal.failCompleteAlways = true;

    const result = await fx.executor.execute(plan);

    expect(result.status).toBe('rolled-back');
    expect(result.verification.status).toBe('verified');
    expect(result.rollback?.status).toBe('succeeded');
    expect(result.warnings.join(' ')).toMatch(/journal could not be finalized/i);
    expect((await fx.journalInner.read())?.state).toBe('rolling-back');
  });

  it('reports a verified rollback with a warning when the service cannot restart', async () => {
    const preRun = workspaceSnapshot();
    const fx = await fixture(preRun);
    const plan = applyPlanFor(preRun);
    let stopped = false;
    fx.service.failStart = new Error('service start failed');
    const executor = fx.makeExecutor({
      sleep: async () => {
        if (stopped) return;
        stopped = true;
        fx.service.setState('stopped');
      },
    });

    const result = await executor.execute(plan);

    expect(result.status).toBe('rolled-back');
    expect(result.verification.status).toBe('verified');
    expect(result.rollback?.status).toBe('succeeded');
    expect(result.warnings.join(' ')).toMatch(/service could not be started/i);
    expect((await fx.journalInner.read())?.state).toBe('rolled-back');
  });

  it('returns rollback-failed with retained journal and snapshot when rollback writing fails', async () => {
    const preRun = workspaceSnapshot();
    const fx = await fixture(preRun);
    const plan = applyPlanFor(preRun);
    fx.gateway.failApplyCalls.add(1);
    fx.gateway.failApplyCalls.add(2);

    const result = await fx.executor.execute(plan);

    expect(result.status).toBe('rollback-failed');
    expect(result.rollback?.status).toBe('failed');
    expect(result.message).toMatch(/manual/iu);
    expect(result.message).toMatch(/snapshot/u);
    const journal = await fx.journalInner.read();
    expect(journal?.state).toBe('rollback-failed');
    expect(await fx.journalInner.activeSnapshotIds()).toEqual(new Set([journal?.snapshotId]));
    expect(await fx.snapshotStore.list()).toHaveLength(1);
  });

  it('rejects a stale profile revision before any snapshot or write', async () => {
    const preRun = workspaceSnapshot();
    const fx = await fixture(preRun);
    const plan = applyPlanFor(preRun);
    const executor = fx.makeExecutor({
      currentProfileRevision: async () => plan.profileRevision + 1,
    });

    await expect(executor.execute(plan)).rejects.toBeInstanceOf(StaleProfileError);
    expect(fx.gateway.applyCalls).toEqual([]);
    expect(await fx.snapshotStore.list()).toEqual([]);
  });

  it('rejects a tampered plan hash before reading the registry', async () => {
    const preRun = workspaceSnapshot();
    const fx = await fixture(preRun);
    const plan = applyPlanFor(preRun);
    const tampered = parsePlan({
      ...plan,
      planHash: `sha256:${'2'.repeat(64)}`,
    });

    await expect(fx.executor.execute(tampered)).rejects.toBeInstanceOf(ValidationError);
    expect(fx.gateway.readCalls).toBe(0);
    expect(fx.gateway.applyCalls).toEqual([]);
  });
});

describe('ApplyExecutor restore', () => {
  const fixtures: Fixture[] = [];

  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map((fixture) => dispose(fixture)));
  });

  function sourceSnapshot(): RegistrySnapshot {
    return makeSnapshot([
      ...modKeys('alpha', {
        enabled: false,
        version: '1.0',
        settings: {
          Old: stringValue('source'),
          Shared: dword(1),
        },
        extraRootValues: {
          Include: stringValue('alpha-source.exe'),
          SettingsChangeTime: dword(500),
        },
      }),
      ...modKeys('missing', {
        enabled: true,
        version: '1.0',
        settings: { Gone: dword(1) },
      }),
      ...modKeys('newer', {
        enabled: true,
        version: '1.0',
        settings: { X: dword(1) },
      }),
      ...modKeys('stable', {
        enabled: true,
        version: '1.0',
        settings: { Y: dword(1) },
      }),
    ]);
  }

  function currentSnapshot(): RegistrySnapshot {
    return makeSnapshot([
      ...modKeys('alpha', {
        enabled: true,
        version: '1.0',
        settings: {
          Old: stringValue('current'),
          Extra: dword(9),
        },
        extraRootValues: {
          Include: stringValue('alpha-current.exe'),
          SettingsChangeTime: dword(300),
        },
      }),
      ...modKeys('newer', {
        enabled: true,
        version: '2.0',
        settings: { X: dword(2) },
      }),
      ...modKeys('stable', {
        enabled: true,
        version: '1.0',
        settings: { Y: dword(2) },
      }),
      ...modKeys('extra', {
        enabled: true,
        version: '1.0',
        settings: { Keep: dword(1) },
      }),
    ]);
  }

  async function setup(): Promise<{
    readonly fx: Fixture;
    readonly source: { metadata: { id: string }; registry: RegistrySnapshot };
    readonly current: RegistrySnapshot;
    readonly plan: ReturnType<typeof makeRestorePlanForTest>;
  }> {
    const source = sourceSnapshot();
    const fx = await createFixture(source);
    fixtures.push(fx);
    const captured = await fx.snapshotStore.capture('manual', {
      environment: environment(),
      profileId: null,
    });
    const current = currentSnapshot();
    fx.gateway.setSnapshot(current);
    const plan = makeRestorePlanForTest({
      source: captured,
      current,
      confirmTargeting: true,
    });
    return { fx, source: captured, current, plan };
  }

  function valueAt(snapshot: RegistrySnapshot, path: string, name: string) {
    return snapshot.keys
      .find((key) => key.path.toLowerCase() === path.toLowerCase())
      ?.values.find((value) => value.name.toLowerCase() === name.toLowerCase())?.value;
  }

  it('reconciles disabled, settings, and targeting, and restores updated mods in place', async () => {
    const { fx, plan } = await setup();

    const result = await fx.executor.execute(plan);

    expect(parseApplyResult(result).status).toBe('succeeded');
    expect(result.changedMods.sort()).toEqual(['alpha', 'newer', 'stable']);
    const skipped = new Map(result.skippedMods.map((entry) => [entry.modId, entry.reason]));
    expect(skipped.get('missing')).toBe('missing-key');
    expect(skipped.has('newer')).toBe(false);
    expect(skipped.get('extra')).toBe('newer-than-snapshot');
    expect(result.warnings.some((warning) => /newer/u.test(warning))).toBe(true);
    expect(result.warnings.some((warning) => /installed after/u.test(warning))).toBe(true);

    const ops = flattenOps(fx.gateway.applyCalls);
    expect(ops.some((op) => ['libraryfilename', 'version'].includes(op.name.toLowerCase()))).toBe(
      false,
    );
    expect(ops.some((op) => op.path.toLowerCase().includes('\\missing'))).toBe(false);
    expect(ops.some((op) => op.path.toLowerCase().includes('\\newer'))).toBe(true);
    expect(ops.some((op) => op.path.toLowerCase().includes('\\extra'))).toBe(false);

    const after = fx.gateway.getSnapshot();
    expect(valueAt(after, modRootPath('alpha'), 'Disabled')).toEqual(dword(1));
    expect(valueAt(after, modRootPath('alpha'), 'Include')).toEqual(
      stringValue('alpha-source.exe'),
    );
    expect(valueAt(after, `${modRootPath('alpha')}\\Settings`, 'Old')).toEqual(
      stringValue('source'),
    );
    expect(valueAt(after, `${modRootPath('alpha')}\\Settings`, 'Shared')).toEqual(dword(1));
    expect(valueAt(after, `${modRootPath('alpha')}\\Settings`, 'Extra')).toBeUndefined();
    expect(valueAt(after, modRootPath('alpha'), 'Version')).toEqual(stringValue('1.0'));

    expect(valueAt(after, `${modRootPath('stable')}\\Settings`, 'Y')).toEqual(dword(1));
    expect(valueAt(after, `${modRootPath('newer')}\\Settings`, 'X')).toEqual(dword(1));
    expect(valueAt(after, modRootPath('newer'), 'Version')).toEqual(stringValue('2.0'));
    expect(valueAt(after, `${modRootPath('extra')}\\Settings`, 'Keep')).toEqual(dword(1));
    expect(after.keys.some((key) => key.path.toLowerCase().includes('\\missing'))).toBe(false);

    expect(fx.gateway.applyCalls[0]?.some((op) => op.name === 'Disabled')).toBe(true);
    expect((await fx.journalInner.read())?.state).toBe('privileged-complete');

    const snapshots = await fx.snapshotStore.list();
    expect(snapshots).toHaveLength(2);
    expect(snapshots.some((item) => item.metadata.trigger === 'pre-restore')).toBe(true);
  });

  it('keeps an automatic restore source until the journal is active', async () => {
    const fx = await createFixture(sourceSnapshot(), { automaticRetentionLimit: 1 });
    fixtures.push(fx);
    const source = await fx.snapshotStore.capture('pre-apply', {
      environment: environment(),
      profileId: null,
    });
    fx.gateway.setSnapshot(currentSnapshot());
    const plan = makeRestorePlanForTest({
      source,
      current: currentSnapshot(),
      confirmTargeting: true,
    });

    const result = await fx.executor.execute(plan);

    expect(result.status).toBe('succeeded');
    await expect(fx.snapshotStore.get(source.metadata.id)).resolves.toBeDefined();
    expect((await fx.snapshotStore.list()).map((item) => item.metadata.id)).toContain(
      source.metadata.id,
    );
  });

  function rehashedRestorePlan(
    plan: ReturnType<typeof makeRestorePlanForTest>,
    overrides: Record<string, unknown>,
  ) {
    const base = { ...plan, ...overrides };
    return parsePlan({
      ...base,
      planHash: hashCanonical(canonicalPlanHashInput(base)),
    });
  }

  it('rejects a restore whose source snapshot checksum changed before any write', async () => {
    const { fx, plan } = await setup();
    const stale = rehashedRestorePlan(plan, {
      sourceSnapshotSha256: `sha256:${'f'.repeat(64)}`,
    });

    await expect(fx.executor.execute(stale)).rejects.toBeInstanceOf(StalePlanError);
    expect(fx.gateway.applyCalls).toEqual([]);
    expect(await fx.journalInner.read()).toBeNull();
    expect(await fx.snapshotStore.list()).toHaveLength(1);
  });

  it('rejects a restore plan that does not bind the source checksum', async () => {
    const { fx, source, current } = await setup();
    const unbound = makeRestorePlanForTest({
      source: { metadata: { id: source.metadata.id }, registry: source.registry },
      current,
      confirmTargeting: true,
    });

    await expect(fx.executor.execute(unbound)).rejects.toBeInstanceOf(ValidationError);
    expect(fx.gateway.applyCalls).toEqual([]);
    expect(await fx.journalInner.read()).toBeNull();
  });

  it('rejects unconfirmed machine-specific targeting before any write', async () => {
    const { fx, source, current } = await setup();
    const unconfirmed = makeRestorePlanForTest({
      source,
      current,
      confirmTargeting: false,
    });

    await expect(fx.executor.execute(unconfirmed)).rejects.toBeInstanceOf(ValidationError);
    expect(fx.gateway.applyCalls).toEqual([]);
    expect(await fx.journalInner.read()).toBeNull();
    expect(await fx.snapshotStore.list()).toHaveLength(1);
  });

  it('rolls back to the pre-restore snapshot when a restore write fails', async () => {
    const { fx, current, plan } = await setup();
    fx.gateway.failApplyCalls.add(1);

    const result = await fx.executor.execute(plan);

    expect(result.status).toBe('rolled-back');
    expect(result.rollback?.status).toBe('succeeded');
    expect(computeRestoreManagedHash(fx.gateway.getSnapshot(), restoreSourceModIds(current))).toBe(
      computeRestoreManagedHash(current, restoreSourceModIds(current)),
    );
    expect((await fx.journalInner.read())?.state).toBe('rolled-back');
    expect(fx.service.state).toBe('running');
    const snapshots = await fx.snapshotStore.list();
    expect(snapshots.some((item) => item.metadata.trigger === 'pre-restore')).toBe(true);
  });
});
