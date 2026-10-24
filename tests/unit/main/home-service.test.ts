import { mkdir, mkdtemp, readFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseApplyResult, parseProfile, type Environment, type Profile } from '@shared/domain';
import {
  CompatibilityError,
  ElevationCanceledError,
  JournalLockError,
  ValidationError,
} from '@shared/errors';
import { FakeElevationBroker } from '@core/elevation/elevation-broker';
import { buildPlan } from '@core/planner/apply-planner';
import type { EnvironmentProbe } from '@core/environment/environment-probe';
import { FakeProcessController } from '@core/process/process-controller';
import { FileJournalStore } from '@infra/journal/file-journal-store';
import { SnapshotStore } from '@infra/snapshots/snapshot-store';
import { NodeSnapshotFileSystem, type SnapshotAcl } from '@infra/storage/snapshot-file-system';
import { FileApplyStateStore } from '@infra/state/file-apply-state-store';
import { createWindowsHomeService } from '../../../src/main/home-service';
import {
  makeEnvironment,
  makeProfile,
  makeSnapshot,
  modKeys,
  planOptions,
} from '../planner/support';
import { ScriptedRegistryGateway } from '../executor/executor-support';

class RecordingAcl implements SnapshotAcl {
  async apply(): Promise<void> {
    // No icacls in unit tests.
  }
}

const temporaryDirectories: string[] = [];
const resourcesDirectory = join(process.cwd(), 'resources');

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'wpm-home-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }).catch(() => undefined)),
  );
});

function fakeProbe(environment: Environment): EnvironmentProbe {
  return { probe: async () => environment };
}

async function macProfile(): Promise<Profile> {
  const text = await readFile(join(resourcesDirectory, 'profiles', 'mac-blur-glass.json'), 'utf8');
  return parseProfile(JSON.parse(text));
}

async function createService(
  registry: ScriptedRegistryGateway,
  environment: Environment,
  options: {
    readonly journalPath: string;
    readonly snapshotDirectory: string;
    readonly statePath: string;
    readonly broker?: FakeElevationBroker;
    readonly snapshotStore?: SnapshotStore;
    readonly processController?: FakeProcessController;
    readonly probe?: EnvironmentProbe;
    readonly profileDirectory?: string;
    readonly localAppData?: string;
  },
) {
  const journalStore = new FileJournalStore({ path: options.journalPath });
  const snapshotStore =
    options.snapshotStore ??
    new SnapshotStore({
      gateway: registry,
      directory: options.snapshotDirectory,
      fileSystem: new NodeSnapshotFileSystem(new RecordingAcl()),
      activeJournalSnapshotIds: () => journalStore.activeSnapshotIds(),
    });

  return {
    journalStore,
    snapshotStore,
    service: await createWindowsHomeService(
      { resourcesDirectory },
      {
        registry,
        probe: options.probe ?? fakeProbe(environment),
        journalStore,
        snapshotStore,
        stateStore: new FileApplyStateStore({ path: options.statePath }),
        ...(options.broker === undefined ? {} : { broker: options.broker }),
        ...(options.processController === undefined
          ? {}
          : { processController: options.processController }),
        profileDirectory: options.profileDirectory ?? join(dirname(options.statePath), 'profiles'),
        ...(options.localAppData === undefined ? {} : { localAppData: options.localAppData }),
      },
    ),
  };
}

describe('HomeService theme-pack readiness', () => {
  it('rejects a bundled profile with 9 of 10 mods but keeps user and reset behavior', async () => {
    const root = await temporaryDirectory();
    const profile = await macProfile();
    const installed = profile.requiredMods.slice(0, 9);
    const missing = profile.requiredMods[9];
    if (missing === undefined) throw new Error('Expected ten bundled mods.');
    const environment = makeEnvironment({
      mods: installed.map((mod) => ({ modId: mod.modId, version: '1.7.3' })),
    });
    const registry = new ScriptedRegistryGateway(
      makeSnapshot(installed.flatMap((mod) => modKeys(mod.modId, { version: '1.7.3' }))),
    );
    await new FileApplyStateStore({ path: join(root, 'state.json') }).updateSettings({
      explorerRestart: 'always',
      snapshotRetention: 7,
    });
    const { service } = await createService(registry, environment, {
      journalPath: join(root, 'journal.json'),
      snapshotDirectory: join(root, 'snapshots'),
      statePath: join(root, 'state.json'),
      localAppData: root,
    });

    const blockedPlan = await service.createApplyPlan('mac-blur-glass');
    expect(blockedPlan.blockers).toEqual([
      expect.objectContaining({
        code: 'required-missing',
        modIds: [missing.modId],
      }),
    ]);
    await expect(
      service.runApply('mac-blur-glass', {
        expectedRevision: profile.revision,
        expectedPlanHash: blockedPlan.planHash,
        runId: blockedPlan.runId,
        snapshotId: blockedPlan.snapshotId,
      }),
    ).rejects.toBeInstanceOf(CompatibilityError);

    const user = await service.createProfile({
      name: 'User profile with a missing mod',
      requiredMods: [{ modId: missing.modId, state: 'enabled', mode: 'replace', settings: {} }],
    });
    const userPlan = await service.createApplyPlan(user.id);
    expect(userPlan.blockers).toEqual([]);
    expect(userPlan.missingMods).toHaveLength(1);
    expect(userPlan.actions.restartExplorer).toBe('always');
    expect(userPlan.snapshotRetention).toBe(7);

    const resetPlan = await service.createApplyPlan('default-windows');
    expect(resetPlan.blockers).toEqual([]);
    expect(resetPlan.actions.restartExplorer).toBe('always');
  });
});

describe('HomeService restore confirmation', () => {
  it('requires targeting confirmation after verifying the preview hash', async () => {
    const root = await temporaryDirectory();
    const appRoot = join(root, 'WindhawkProfileManager');
    const snapshotDirectory = join(appRoot, 'snapshots');
    await mkdir(snapshotDirectory, { recursive: true });
    const environment = makeEnvironment();
    const registry = new ScriptedRegistryGateway(
      makeSnapshot(
        modKeys('windows-11-taskbar-styler', {
          version: '1.0.0',
          extraRootValues: { Include: { type: 'string', value: 'explorer.exe' } },
        }),
      ),
    );
    const journalPath = join(appRoot, 'journal.json');
    const journalStore = new FileJournalStore({ path: journalPath });
    const snapshotStore = new SnapshotStore({
      gateway: registry,
      directory: snapshotDirectory,
      fileSystem: new NodeSnapshotFileSystem(new RecordingAcl()),
      activeJournalSnapshotIds: () => journalStore.activeSnapshotIds(),
    });
    const source = await snapshotStore.capture('manual', {
      environment,
      profileId: null,
    });
    const broker = new FakeElevationBroker(async () => {
      throw new ElevationCanceledError('stop before elevation');
    });
    const { service } = await createService(registry, environment, {
      journalPath,
      snapshotDirectory,
      statePath: join(root, 'state.json'),
      snapshotStore,
      localAppData: root,
      broker,
      processController: new FakeProcessController(),
    });
    const preview = await service.createRestorePlan(source.metadata.id);
    expect(preview.targetingConfirmed).toBe(false);
    expect(preview.targetingValues).toHaveLength(1);
    expect(preview.warnings.some((warning) => warning.code === 'machine-specific-targeting')).toBe(
      true,
    );

    const options = {
      sourceSnapshotId: source.metadata.id,
      runId: preview.runId,
      snapshotId: preview.snapshotId,
    };
    await expect(
      service.runRestore({ ...options, expectedPlanHash: `sha256:${'0'.repeat(64)}` }),
    ).rejects.toMatchObject({ code: 'STALE_PLAN' });
    await expect(
      service.runRestore({ ...options, expectedPlanHash: preview.planHash }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(broker.calls).toHaveLength(0);

    await expect(
      service.runRestore({
        ...options,
        expectedPlanHash: preview.planHash,
        confirmTargeting: true,
      }),
    ).rejects.toBeInstanceOf(ElevationCanceledError);
    expect(broker.calls).toHaveLength(1);
    expect(broker.calls[0]?.plan.kind).toBe('restore');
    if (broker.calls[0]?.plan.kind !== 'restore') throw new Error('Expected a restore plan.');
    expect(broker.calls[0].plan.targetingConfirmed).toBe(true);
    expect(broker.calls[0].plan.sourceSnapshotSha256).toBe(source.metadata.registrySha256);
  });
});

describe('HomeService recovery lease', () => {
  it('reports a live run, refuses to resolve it, and preserves the journal after a failed restore', async () => {
    const root = await temporaryDirectory();
    const environment = makeEnvironment();
    const registry = new ScriptedRegistryGateway(
      makeSnapshot(modKeys('windows-11-taskbar-styler', { version: '1.0.0' })),
    );
    const appRoot = join(root, 'WindhawkProfileManager');
    const journalPath = join(appRoot, 'journal.json');
    const snapshotDirectory = join(appRoot, 'snapshots');
    await mkdir(snapshotDirectory, { recursive: true });

    const journalStore = new FileJournalStore({ path: journalPath });
    const snapshotStore = new SnapshotStore({
      gateway: registry,
      directory: snapshotDirectory,
      fileSystem: new NodeSnapshotFileSystem(new RecordingAcl()),
      activeJournalSnapshotIds: () => journalStore.activeSnapshotIds(),
    });
    const source = await snapshotStore.capture('pre-apply', {
      environment,
      profileId: 'mac-blur-glass',
    });
    const plan = buildPlan(
      makeProfile(),
      registry.getSnapshot(),
      environment,
      planOptions({
        runId: 'run-recovery-2026-10-24T10-00-00-000Z',
        snapshotId: source.metadata.id,
      }),
    );
    await journalStore.begin({
      plan,
      snapshotId: source.metadata.id,
      startedAt: '2026-10-24T10:00:00.000Z',
    });

    const { service } = await createService(registry, environment, {
      journalPath,
      snapshotDirectory,
      statePath: join(root, 'state.json'),
      snapshotStore,
      localAppData: root,
      broker: new FakeElevationBroker(async () => {
        throw new ElevationCanceledError('The UAC prompt was canceled; no changes were made.');
      }),
    });

    const recovery = await service.getRecovery();
    expect(recovery?.runId).toBe(plan.runId);
    expect(recovery?.inProgress).toBe(true);
    await expect(service.resolveRecovery('dismiss')).rejects.toBeInstanceOf(JournalLockError);
    expect(await journalStore.read()).not.toBeNull();

    await unlink(`${journalPath}.lease`);
    await expect(service.resolveRecovery('restore')).rejects.toBeInstanceOf(ElevationCanceledError);

    const preserved = await service.getRecovery();
    expect(preserved?.runId).toBe(plan.runId);
    expect(preserved?.inProgress).toBe(false);

    await service.resolveRecovery('dismiss');
    expect(await service.getRecovery()).toBeNull();
  });

  it('clears the recovery record after a successful restore', async () => {
    const root = await temporaryDirectory();
    const environment = makeEnvironment();
    const registry = new ScriptedRegistryGateway(
      makeSnapshot(modKeys('windows-11-taskbar-styler', { version: '1.0.0' })),
    );
    const appRoot = join(root, 'WindhawkProfileManager');
    const journalPath = join(appRoot, 'journal.json');
    const snapshotDirectory = join(appRoot, 'snapshots');
    await mkdir(snapshotDirectory, { recursive: true });

    const journalStore = new FileJournalStore({ path: journalPath });
    const snapshotStore = new SnapshotStore({
      gateway: registry,
      directory: snapshotDirectory,
      fileSystem: new NodeSnapshotFileSystem(new RecordingAcl()),
      activeJournalSnapshotIds: () => journalStore.activeSnapshotIds(),
    });
    const source = await snapshotStore.capture('pre-apply', {
      environment,
      profileId: 'mac-blur-glass',
    });
    const plan = buildPlan(
      makeProfile(),
      registry.getSnapshot(),
      environment,
      planOptions({
        runId: 'run-recovery-success-2026-10-24T10-00-00-000Z',
        snapshotId: source.metadata.id,
      }),
    );
    await journalStore.begin({
      plan,
      snapshotId: source.metadata.id,
      startedAt: '2026-10-24T10:00:00.000Z',
    });
    await unlink(`${journalPath}.lease`);

    const broker = new FakeElevationBroker(async (helperPlan) => {
      const startedAt = '2026-10-24T10:05:00.000Z';
      const result = parseApplyResult({
        schemaVersion: 1,
        runId: helperPlan.runId,
        kind: 'restore',
        status: 'succeeded',
        message: 'Restored.',
        startedAt,
        completedAt: startedAt,
        changedMods: [],
        skippedMods: [],
        warnings: [],
        reload: { requested: false, confirmed: false, message: 'No reload.' },
        verification: { status: 'verified', checkedAt: startedAt, message: 'Verified.' },
        actions: {
          rainmeter: { status: 'skipped' },
          explorer: { status: 'skipped' },
        },
        rollback: null,
        error: null,
      });
      const helperJournal = new FileJournalStore({
        path: journalPath,
        runId: helperPlan.runId,
      });
      await helperJournal.begin({
        plan: helperPlan,
        snapshotId: helperPlan.snapshotId,
        startedAt,
      });
      await helperJournal.update('privileged-complete', { result });
      return result;
    });

    const { service } = await createService(registry, environment, {
      journalPath,
      snapshotDirectory,
      statePath: join(root, 'state.json'),
      snapshotStore,
      localAppData: root,
      broker,
      processController: new FakeProcessController(),
    });

    const resolution = await service.resolveRecovery('restore');

    expect(resolution.action).toBe('restored');
    expect(resolution.result?.status).toBe('succeeded');
    expect(await service.getRecovery()).toBeNull();
  });
});

describe('HomeService real apply composition', () => {
  it('runs a plan through the coordinator, persists active state, and reports progress', async () => {
    const root = await temporaryDirectory();
    const profile = await macProfile();
    const environment = makeEnvironment({
      mods: profile.requiredMods.map((mod) => ({
        modId: mod.modId,
        version: '1.0.0',
        enabled: mod.state === 'enabled',
      })),
    });
    const current = makeSnapshot(
      profile.requiredMods.flatMap((mod) =>
        modKeys(mod.modId, {
          enabled: mod.state === 'enabled',
          settings: {},
        }),
      ),
    );
    const registry = new ScriptedRegistryGateway(current);
    const appRoot = join(root, 'WindhawkProfileManager');
    const journalPath = join(appRoot, 'journal.json');
    const snapshotDirectory = join(appRoot, 'snapshots');
    await mkdir(snapshotDirectory, { recursive: true });
    const journalStore = new FileJournalStore({ path: journalPath });
    const snapshotStore = new SnapshotStore({
      gateway: registry,
      directory: snapshotDirectory,
      fileSystem: new NodeSnapshotFileSystem(new RecordingAcl()),
      activeJournalSnapshotIds: () => journalStore.activeSnapshotIds(),
    });
    let helperPlan: ReturnType<typeof buildPlan> | null = null;
    const broker = new FakeElevationBroker(async (plan) => {
      if (plan.kind !== 'apply') throw new Error('Expected an apply plan.');
      helperPlan = plan;
      const startedAt = '2026-10-24T11:00:00.000Z';
      const result = parseApplyResult({
        schemaVersion: 1,
        runId: plan.runId,
        kind: 'apply',
        status: 'succeeded',
        message: 'Applied.',
        startedAt,
        completedAt: startedAt,
        changedMods: plan.modChanges.map((change) => change.modId),
        skippedMods: [],
        warnings: [],
        reload: { requested: true, confirmed: false, message: 'Reload requested.' },
        verification: { status: 'verified', checkedAt: startedAt, message: 'Verified.' },
        actions: {
          rainmeter: { status: 'skipped' },
          explorer: { status: 'skipped' },
        },
        rollback: null,
        error: null,
      });
      const helperJournal = new FileJournalStore({ path: plan.paths.journal, runId: plan.runId });
      await helperJournal.begin({
        plan,
        snapshotId: plan.snapshotId,
        startedAt,
      });
      await helperJournal.update('privileged-complete', { result });
      return result;
    });
    const { service } = await createService(registry, environment, {
      journalPath,
      snapshotDirectory,
      statePath: join(root, 'state.json'),
      snapshotStore,
      broker,
      processController: new FakeProcessController(),
      localAppData: root,
    });

    const plan = await service.createApplyPlan('mac-blur-glass', {
      explorerRestart: 'never',
    });
    await snapshotStore.captureAt(
      'pre-apply',
      { environment, profileId: 'mac-blur-glass' },
      { id: plan.snapshotId, registryPath: plan.paths.snapshotRegistry },
    );
    const progress: string[] = [];
    const result = await service.runApply('mac-blur-glass', {
      expectedRevision: plan.profileRevision,
      expectedPlanHash: plan.planHash,
      runId: plan.runId,
      snapshotId: plan.snapshotId,
      explorerRestart: 'never',
      onProgress: (state) => progress.push(state),
    });

    expect(result.status).toBe('succeeded');
    expect(helperPlan).not.toBeNull();
    expect(await service.getState()).toMatchObject({
      activeProfileId: 'mac-blur-glass',
      lastRunId: plan.runId,
    });
    expect((await journalStore.read())?.state).toBe('succeeded');
    expect(progress).toContain('snapshotting');
    expect(progress).toContain('succeeded');
    expect((await service.listSnapshots()).some((item) => item.id === plan.snapshotId)).toBe(true);
  });
});

describe('HomeService recovery finish', () => {
  it('finishes a successful privileged phase without rolling it back', async () => {
    const root = await temporaryDirectory();
    const environment = makeEnvironment({
      mods: [{ modId: 'windows-11-taskbar-styler', version: '1.0.0' }],
    });
    const registry = new ScriptedRegistryGateway(
      makeSnapshot(modKeys('windows-11-taskbar-styler', { enabled: true })),
    );
    const appRoot = join(root, 'WindhawkProfileManager');
    const journalPath = join(appRoot, 'journal.json');
    const plan = buildPlan(
      makeProfile({
        requiredMods: [
          { modId: 'windows-11-taskbar-styler', state: 'enabled', mode: 'replace', settings: {} },
        ],
      }),
      registry.getSnapshot(),
      environment,
      planOptions({
        runId: 'run-finish-2026-10-24T12-00-00-000Z',
        snapshotId: 'snapshot-finish-2026-10-24T12-00-00-000Z',
        paths: {
          plan: `C:\\ProgramData\\WindhawkProfileManager\\runs\\run-finish-2026-10-24T12-00-00-000Z\\plan.json`,
          snapshotRegistry: join(
            appRoot,
            'snapshots',
            'snapshot-finish-2026-10-24T12-00-00-000Z.reg',
          ),
          journal: journalPath,
          result: `C:\\ProgramData\\WindhawkProfileManager\\runs\\run-finish-2026-10-24T12-00-00-000Z\\result.json`,
        },
      }),
    );
    const journalStore = new FileJournalStore({ path: journalPath });
    await journalStore.begin({
      plan,
      snapshotId: plan.snapshotId,
      startedAt: '2026-10-24T12:00:00.000Z',
    });
    const result = parseApplyResult({
      schemaVersion: 1,
      runId: plan.runId,
      kind: 'apply',
      status: 'succeeded',
      message: 'Applied.',
      startedAt: '2026-10-24T12:00:00.000Z',
      completedAt: '2026-10-24T12:00:04.000Z',
      changedMods: ['windows-11-taskbar-styler'],
      skippedMods: [],
      warnings: [],
      reload: { requested: true, confirmed: false, message: 'Reload requested.' },
      verification: {
        status: 'verified',
        checkedAt: '2026-10-24T12:00:04.000Z',
        message: 'Verified.',
      },
      actions: {
        rainmeter: { status: 'skipped' },
        explorer: { status: 'skipped' },
      },
      rollback: null,
      error: null,
    });
    await journalStore.update('privileged-complete', { result });
    await unlink(`${journalPath}.lease`);

    const { service } = await createService(registry, environment, {
      journalPath,
      snapshotDirectory: join(appRoot, 'snapshots'),
      statePath: join(root, 'state.json'),
      processController: new FakeProcessController(),
      localAppData: root,
    });

    expect(await service.getRecovery()).toMatchObject({ canFinish: true });
    const resolution = await service.resolveRecovery('finish');

    expect(resolution.action).toBe('finished');
    expect((await service.getState()).activeProfileId).toBe(plan.profileId);
    expect((await journalStore.read())?.state).toBe('succeeded');
  });
});

describe('HomeService probe cache', () => {
  it('shares one probe across environment, diagnostics, and a repeated refresh', async () => {
    const root = await temporaryDirectory();
    const environment = makeEnvironment();
    const registry = new ScriptedRegistryGateway(
      makeSnapshot(modKeys('windows-11-taskbar-styler', { version: '1.0.0' })),
    );
    const probe: EnvironmentProbe = { probe: vi.fn(async () => environment) };
    const appRoot = join(root, 'WindhawkProfileManager');
    const { service } = await createService(registry, environment, {
      journalPath: join(appRoot, 'journal.json'),
      snapshotDirectory: join(appRoot, 'snapshots'),
      statePath: join(root, 'state.json'),
      probe,
      localAppData: root,
    });

    await Promise.all([
      service.probeEnvironment(),
      service.getDiagnostics(),
      service.probeEnvironment(),
    ]);

    expect(probe.probe).toHaveBeenCalledTimes(1);
  });
});
