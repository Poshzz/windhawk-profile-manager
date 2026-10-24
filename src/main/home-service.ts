import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { shell } from 'electron';
import { logger } from './logger';
import type { HomeService, PlanApplyOptions, SnapshotExportData } from '@core/home/home-service';
import type { EnvironmentProbe } from '@core/environment/environment-probe';
import { ApplyCoordinator } from '@core/elevation/apply-coordinator';
import { DriftService } from '@core/planner/drift-service';
import { computeManagedHash, readInstalledMods } from '@core/planner/registry-state';
import { buildPlan, planBlockingError } from '@core/planner/apply-planner';
import { buildRestorePlan } from '@core/planner/restore-planner';
import type { RegistryGateway } from '@core/registry/registry-gateway';
import type { ElevationBroker } from '@core/elevation/elevation-broker';
import type { ProcessController } from '@core/process/process-controller';
import type { ServiceController } from '@core/services/service-controller';
import type { SnapshotFileSystem } from '@infra/storage/snapshot-file-system';
import { captureProfileMods } from '@core/profiles/capture-profile';
import { FileJournalStore } from '@infra/journal/file-journal-store';
import { WindowsElevationBroker } from '@infra/elevation/windows-elevation-broker';
import { NodeCommandRunner } from '@infra/process/node-command-runner';
import { NodeProcessLauncher } from '@infra/process/node-process-launcher';
import { WindowsProcessController } from '@infra/process/windows-process-controller';
import { WindowsRegistryGateway } from '@infra/registry/windows-registry-gateway';
import { WindowsServiceController } from '@infra/services/windows-service-controller';
import { NodeEnvironmentFileSystem } from '@infra/environment/node-environment-file-system';
import { RegExeSystemRegistryReader } from '@infra/environment/reg-exe-system-registry-reader';
import { WindowsEnvironmentProbe } from '@infra/environment/windows-environment-probe';
import { loadBundledContent } from '@infra/resources/bundled-content';
import { ProfileStore } from '@infra/profiles/profile-store';
import { DEFAULT_AUTOMATIC_RETENTION, SnapshotStore } from '@infra/snapshots/snapshot-store';
import { NodeSnapshotFileSystem } from '@infra/storage/snapshot-file-system';
import { currentWindowsSid } from '@infra/elevation/run-directory';
import { resolveLocalAppData, resolveProgramData } from '@infra/elevation/system-paths';
import { FileApplyStateStore } from '@infra/state/file-apply-state-store';
import {
  ElevationCanceledError,
  EnvironmentError,
  JournalLockError,
  NotFoundError,
  StalePlanError,
  StaleProfileError,
  ValidationError,
} from '@shared/errors';
import type {
  ApplyProgressState,
  CaptureProfileInput,
  Diagnostics,
  ProfileInput,
  RecoveryInfo,
  RecoveryResolution,
  RunRestoreOptions,
  SnapshotDetail,
  SnapshotSummary,
} from '@shared/ipc';
import { isUnfinishedJournalState } from '@shared/domain';
import type {
  ApplyPlan,
  Environment,
  ExecutionPlan,
  Journal,
  JournalState,
  PlanPaths,
  Profile,
  RegistrySnapshot,
  RestorePlan,
  RestorePaths,
  SettingsPatch,
  ThemePack,
} from '@shared/domain';

export interface WindowsHomeServiceOptions {
  readonly resourcesDirectory: string;
  readonly appVersion?: string;
}

export const DEFAULT_WINDOWS_PROFILE_ID = 'default-windows';

/** A bundled theme-pack profile must be applied whole; Default Windows resets. */
export function requiresThemePackReadiness(
  profile: Pick<Profile, 'id' | 'source'>,
  themePacks: readonly Pick<ThemePack, 'profiles'>[],
): boolean {
  if (profile.source !== 'builtin' || profile.id === DEFAULT_WINDOWS_PROFILE_ID) return false;
  return themePacks.some((pack) => pack.profiles.includes(profile.id));
}

/** Adapter seam for composition tests; production passes no overrides. */
export interface WindowsHomeServiceDependencies {
  readonly registry?: RegistryGateway;
  readonly probe?: EnvironmentProbe;
  readonly service?: ServiceController;
  readonly processController?: ProcessController;
  readonly broker?: ElevationBroker;
  readonly journalStore?: FileJournalStore;
  readonly snapshotStore?: SnapshotStore;
  readonly stateStore?: FileApplyStateStore;
  readonly profileStore?: ProfileStore;
  /** Overrides the profile directory for composition tests; production uses APPDATA. */
  readonly profileDirectory?: string;
  /** Overrides the data root for composition tests; production uses LOCALAPPDATA. */
  readonly localAppData?: string;
}

export interface GuiSnapshotStoreOptions {
  readonly gateway: RegistryGateway;
  readonly journalStore: FileJournalStore;
  readonly automaticRetentionLimit: number;
  readonly directory?: string;
  readonly fileSystem?: SnapshotFileSystem;
  readonly now?: () => Date;
}

/** The non-elevated snapshot store, wired to the persisted retention setting. */
export function createGuiSnapshotStore(options: GuiSnapshotStoreOptions): SnapshotStore {
  return new SnapshotStore({
    gateway: options.gateway,
    ...(options.directory === undefined ? {} : { directory: options.directory }),
    fileSystem: options.fileSystem ?? new NodeSnapshotFileSystem(),
    activeJournalSnapshotIds: () => options.journalStore.activeSnapshotIds(),
    automaticRetentionLimit: options.automaticRetentionLimit,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

function managedIdsForApply(plan: ApplyPlan, snapshot: RegistrySnapshot): string[] {
  const ids = [
    ...plan.modChanges.map((change) => change.modId),
    ...plan.missingMods.map((mod) => mod.modId),
    ...(plan.unlistedPolicy === 'disable' ? plan.unlistedMods.map((mod) => mod.modId) : []),
  ];
  if (plan.unlistedPolicy === 'disable') {
    const known = new Set(ids.map((modId) => modId.toLowerCase()));
    for (const modId of readInstalledMods(snapshot).keys()) {
      if (!known.has(modId)) ids.push(modId);
    }
  }
  return ids;
}

export async function createWindowsHomeService(
  options: WindowsHomeServiceOptions,
  dependencies: WindowsHomeServiceDependencies = {},
): Promise<HomeService> {
  const content = await loadBundledContent(options.resourcesDirectory);
  const runner = new NodeCommandRunner();
  const files = new NodeEnvironmentFileSystem();
  const service = dependencies.service ?? new WindowsServiceController({ runner });
  const registry =
    dependencies.registry ??
    new WindowsRegistryGateway({
      commandRunner: runner,
      tempDirectory: join(tmpdir(), 'WindhawkProfileManager', 'main-registry'),
    });
  const processController =
    dependencies.processController ??
    new WindowsProcessController({
      runner,
      launcher: new NodeProcessLauncher(),
      files,
    });
  const probe: EnvironmentProbe =
    dependencies.probe ??
    new WindowsEnvironmentProbe({
      registry,
      systemRegistry: new RegExeSystemRegistryReader({ runner }),
      service,
      process: processController,
      files,
    });
  const PROBE_CACHE_MS = 2_000;
  let probeCache: { readonly at: number; readonly value: Environment } | null = null;
  let probeInFlight: Promise<Environment> | null = null;
  const cachedProbe = async (refresh = false): Promise<Environment> => {
    if (!refresh && probeCache !== null && Date.now() - probeCache.at < PROBE_CACHE_MS) {
      return probeCache.value;
    }
    if (probeInFlight !== null) return probeInFlight;
    const pending = probe
      .probe()
      .then((value) => {
        probeCache = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        probeInFlight = null;
      });
    probeInFlight = pending;
    return pending;
  };
  const invalidateProbe = (): void => {
    probeCache = null;
  };
  const PLAN_CACHE_MS = 5 * 60_000;
  const planCache = new Map<string, { readonly at: number; readonly plan: ApplyPlan }>();
  const cachePlan = (plan: ApplyPlan): void => {
    planCache.set(plan.runId, { at: Date.now(), plan });
    while (planCache.size > 8) {
      const oldest = planCache.keys().next().value;
      if (oldest === undefined) break;
      planCache.delete(oldest);
    }
  };
  const cachedPlan = (runId: string, planHash: string): ApplyPlan | null => {
    const entry = planCache.get(runId);
    if (entry === undefined || Date.now() - entry.at > PLAN_CACHE_MS) {
      planCache.delete(runId);
      return null;
    }
    return entry.plan.planHash === planHash ? entry.plan : null;
  };

  const localAppData = dependencies.localAppData ?? resolveLocalAppData();
  const appRoot = join(localAppData, 'WindhawkProfileManager');
  const stateStore =
    dependencies.stateStore ?? new FileApplyStateStore({ path: join(appRoot, 'state.json') });
  let automaticRetentionLimit = DEFAULT_AUTOMATIC_RETENTION;
  try {
    automaticRetentionLimit = (await stateStore.get()).snapshotRetention;
  } catch (error) {
    // A corrupt state file must not take the whole app down; plans still fail
    // later when they need settings, while the GUI can show the normal error.
    logger.warn('The persisted snapshot retention could not be loaded.', error);
  }
  const journalStore =
    dependencies.journalStore ?? new FileJournalStore({ path: join(appRoot, 'journal.json') });
  const snapshotStore =
    dependencies.snapshotStore ??
    createGuiSnapshotStore({
      gateway: registry,
      journalStore,
      directory: join(appRoot, 'snapshots'),
      automaticRetentionLimit,
    });
  const profileStore =
    dependencies.profileStore ??
    new ProfileStore({
      builtins: content.profiles,
      ...(dependencies.profileDirectory === undefined
        ? {}
        : { directory: dependencies.profileDirectory }),
    });
  const drift = new DriftService();
  const readProfileRevision = async (profileId: string): Promise<number | null> => {
    try {
      return (await profileStore.get(profileId)).revision;
    } catch (error) {
      if (error instanceof NotFoundError) return null;
      throw error;
    }
  };
  const broker = dependencies.broker ?? new WindowsElevationBroker();
  const coordinator = new ApplyCoordinator({
    broker,
    journalStoreFor: (plan) =>
      new FileJournalStore({ path: plan.paths.journal, runId: plan.runId }),
    processController,
    stateStore,
    readProfileRevision,
  });

  const createPlan = async (
    profileId: string,
    planOptions: PlanApplyOptions = {},
    identity: { readonly runId: string; readonly snapshotId: string } = {
      runId: `run-${randomUUID()}`,
      snapshotId: `snapshot-${randomUUID()}`,
    },
  ) => {
    const profile = await profileStore.get(profileId);
    const appState = await stateStore.get();
    const environment = await cachedProbe();
    const current = await registry.read();
    if (localAppData === undefined || localAppData.length === 0) {
      throw new EnvironmentError('LOCALAPPDATA is not set; apply paths cannot be created.');
    }
    const appRoot = join(localAppData, 'WindhawkProfileManager');
    const programData = resolveProgramData();
    const { runId, snapshotId } = identity;
    const runDirectory = join(programData, 'WindhawkProfileManager', 'runs', runId);
    const paths: PlanPaths = {
      plan: join(runDirectory, 'plan.json'),
      snapshotRegistry: join(appRoot, 'snapshots', `${snapshotId}.reg`),
      journal: join(appRoot, 'journal.json'),
      result: join(runDirectory, 'result.json'),
    };
    const plan = buildPlan(profile, current, environment, {
      runId,
      snapshotId,
      paths,
      themePackMods: content.themePacks.flatMap((pack) =>
        pack.mods.map((mod) => ({
          modId: mod.modId,
          testedVersion: mod.testedVersion,
        })),
      ),
      invokingUser: await currentWindowsSid(),
      snapshotRetentionLimit: appState.snapshotRetention,
      explorerFallback: appState.explorerRestart,
      requireAllRequiredMods: requiresThemePackReadiness(profile, content.themePacks),
      ...(planOptions.explorerRestart === undefined
        ? {}
        : { explorerRestart: planOptions.explorerRestart }),
      ...(planOptions.confirmDeleteAllSettings === undefined
        ? {}
        : { confirmDeleteAllSettings: planOptions.confirmDeleteAllSettings }),
    });
    // The plan carries blockers so every UI can explain why Apply is disabled.
    cachePlan(plan);
    return plan;
  };

  const executePlan = async (
    plan: ExecutionPlan,
    onProgress?: (state: ApplyProgressState) => void,
  ) => {
    const emit = (state: ApplyProgressState): void => {
      try {
        onProgress?.(state);
      } catch {
        // Progress reporting must never change the outcome of an execution.
      }
    };

    emit('preflight');
    let done = false;
    let lastState: ApplyProgressState | null = null;
    const journalStore = new FileJournalStore({
      path: plan.paths.journal,
      runId: plan.runId,
    });
    const polling = (async () => {
      while (!done) {
        try {
          const journal = await journalStore.read();
          if (journal !== null && journal.runId === plan.runId) {
            const state = progressFromJournal(journal.state);
            if (state !== null && state !== lastState) {
              lastState = state;
              emit(state);
            }
          }
        } catch {
          // A journal read failure is reported by the coordinator itself.
        }
        await delay(200);
      }
    })();

    emit('snapshotting');
    try {
      const result = await coordinator.run(plan);
      invalidateProbe();
      emit(result.status);
      return result;
    } catch (error) {
      emit(error instanceof ElevationCanceledError ? 'canceled' : 'failed');
      throw error;
    } finally {
      done = true;
      await polling.catch(() => undefined);
    }
  };

  return {
    async probeEnvironment() {
      return cachedProbe();
    },

    async listProfiles() {
      return profileStore.list();
    },

    async getProfile(id: string) {
      return profileStore.get(id);
    },

    async createProfile(input: ProfileInput) {
      return profileStore.create({
        name: input.name,
        description: input.description,
        requiredMods: input.requiredMods,
        unlistedMods: input.unlistedMods,
        actions: input.actions,
      });
    },

    async updateProfile(id: string, expectedRevision: number, input: ProfileInput) {
      return profileStore.update(id, expectedRevision, {
        name: input.name,
        description: input.description,
        requiredMods: input.requiredMods,
        unlistedMods: input.unlistedMods,
        actions: input.actions,
      });
    },

    async deleteProfile(id: string, confirm: boolean) {
      return profileStore.delete(id, { confirm });
    },

    async duplicateProfile(id: string, name?: string) {
      return profileStore.duplicate(id, name);
    },

    async captureProfile(input: CaptureProfileInput) {
      const current = await registry.read();
      const requiredMods = captureProfileMods(current, input.includeDisabled);
      return profileStore.create({
        name: input.name,
        description: 'Captured from this machine.',
        requiredMods,
        unlistedMods: 'leave',
        actions: { rainmeter: 'unchanged', restartExplorer: 'ask' },
      });
    },

    async importProfileJson(json: string) {
      return profileStore.import(json);
    },

    async exportProfileJson(id: string) {
      return profileStore.export(id);
    },

    async getState() {
      return stateStore.get();
    },

    async updateSettings(patch: SettingsPatch) {
      const next = await stateStore.updateSettings(patch);
      planCache.clear();
      if (patch.snapshotRetention !== undefined) {
        await snapshotStore.setAutomaticRetentionLimit(patch.snapshotRetention);
      }
      return next;
    },

    async completeFirstRun() {
      return stateStore.completeFirstRun();
    },

    async getRecovery(): Promise<RecoveryInfo | null> {
      let journal;
      try {
        journal = await journalStore.read();
      } catch {
        return {
          runId: 'corrupt-journal',
          snapshotId: 'unknown',
          state: 'rollback-failed',
          kind: 'apply',
          startedAt: new Date().toISOString(),
          inProgress: false,
          canFinish: false,
          rainmeterAction: null,
          problem: 'corrupt',
        };
      }
      if (journal === null) return null;
      if (!isUnfinishedJournalState(journal.state) && journal.state !== 'rollback-failed') {
        return null;
      }
      const planAction = journal.plan.actions.rainmeter;
      const rainmeterAction: 'start' | 'stop' | null =
        planAction === 'start' || planAction === 'stop' ? planAction : null;
      return {
        runId: journal.runId,
        snapshotId: journal.snapshotId,
        state: journal.state,
        kind: journal.plan.kind,
        startedAt: journal.startedAt,
        inProgress: await journalStore.isRunLive(),
        canFinish:
          (journal.state === 'privileged-complete' || journal.state === 'finishing') &&
          (journal.result?.status === 'succeeded' ||
            journal.result?.status === 'succeeded-with-warning'),
        rainmeterAction,
      };
    },

    async resolveRecovery(action): Promise<RecoveryResolution> {
      let journal;
      try {
        journal = await journalStore.read();
      } catch (error) {
        if (action === 'dismiss') {
          await journalStore.archiveCorrupt();
          return { action: 'dismissed', result: null };
        }
        throw new ValidationError(
          'The journal is corrupt; close and archive it before starting another run.',
          [],
          { cause: error },
        );
      }
      if (journal === null) {
        throw new ValidationError('There is no interrupted run to resolve.');
      }
      if (await journalStore.isRunLive()) {
        throw new JournalLockError(
          'The interrupted run is still owned by a live helper process; wait for it to finish or exit before resolving it.',
        );
      }
      const successPrivilegedPhase =
        (journal.state === 'privileged-complete' || journal.state === 'finishing') &&
        (journal.result?.status === 'succeeded' ||
          journal.result?.status === 'succeeded-with-warning');
      if (action === 'finish') {
        if (!successPrivilegedPhase || journal.result === null) {
          throw new ValidationError(
            'This interrupted run has no successful privileged phase to finish.',
          );
        }
        const result = await coordinator.finish(journal.plan, journal.result);
        return { action: 'finished', result };
      }
      if (action === 'dismiss') {
        if (successPrivilegedPhase && journal.result !== null && journal.plan.kind === 'apply') {
          try {
            await stateStore.recordApply({
              profileId: journal.plan.profileId,
              appliedAt: journal.result.completedAt ?? journal.updatedAt,
              runId: journal.runId,
            });
          } catch {
            // Dismiss still closes the run if the active-profile record cannot be written.
          }
        }
        await journalStore.clear({ force: true });
        return { action: 'dismissed', result: null };
      }
      if (successPrivilegedPhase) {
        throw new ValidationError(
          'The privileged phase completed successfully; finish the run instead of rolling it back.',
        );
      }

      const source = await snapshotStore.get(journal.snapshotId);
      const appState = await stateStore.get();
      const current = await registry.read();
      if (localAppData === undefined || localAppData.length === 0) {
        throw new EnvironmentError('LOCALAPPDATA is not set; recovery paths cannot be created.');
      }
      const appRoot = join(localAppData, 'WindhawkProfileManager');
      const programData = resolveProgramData();
      const runId = `run-${randomUUID()}`;
      const preRestoreId = `snapshot-${randomUUID()}`;
      const runDirectory = join(programData, 'WindhawkProfileManager', 'runs', runId);
      const paths: RestorePaths = {
        plan: join(runDirectory, 'plan.json'),
        snapshotRegistry: join(appRoot, 'snapshots', `${preRestoreId}.reg`),
        journal: join(appRoot, 'journal.json'),
        result: join(runDirectory, 'result.json'),
        sourceSnapshotRegistry: join(appRoot, 'snapshots', `${source.metadata.id}.reg`),
      };
      const plan = buildRestorePlan(source, current, {
        runId,
        snapshotId: preRestoreId,
        paths,
        invokingUser: await currentWindowsSid(),
        snapshotRetentionLimit: appState.snapshotRetention,
        // Recovery is an explicit user action on the user's own pre-run
        // snapshot, so captured targeting values are part of the restore.
        confirmTargeting: true,
      });
      const previousJournal: Journal = journal;
      await journalStore.clear({ force: true });
      try {
        const result = await executePlan(plan);
        if (result.status !== 'succeeded' && result.status !== 'succeeded-with-warning') {
          try {
            await journalStore.restore(previousJournal);
          } catch (restoreError) {
            logger.error(
              'The interrupted-run journal could not be restored after a non-successful recovery.',
              { error: restoreError },
            );
          }
        }
        return { action: 'restored', result };
      } catch (error) {
        try {
          await journalStore.restore(previousJournal);
        } catch (restoreError) {
          logger.error(
            'The interrupted-run journal could not be restored after a failed recovery.',
            {
              error: restoreError,
            },
          );
        }
        throw error;
      }
    },

    async getDiagnostics(): Promise<Diagnostics> {
      const environment = await cachedProbe();
      let lastRun: Diagnostics['lastRun'] = null;
      try {
        const journal = await journalStore.read();
        if (journal?.result != null) {
          lastRun = {
            runId: journal.runId,
            status: journal.result.status,
            completedAt: journal.result.completedAt,
          };
        }
      } catch {
        // Diagnostics still render without last-run details.
      }
      return {
        appVersion: options.appVersion ?? 'unknown',
        windowsBuild: environment.windows.build,
        windowsSupported: environment.windows.supported,
        windhawkVersion: environment.windhawk.version,
        storageMode: environment.windhawk.storageMode,
        registryRoot: environment.windhawk.registryRoot,
        serviceState: environment.service.state,
        modCount: environment.mods.length,
        lastRun,
      };
    },

    async openLogsFolder() {
      const path = dirname(logger.transports.file.getFile().path);
      await mkdir(path, { recursive: true });
      const failure = await shell.openPath(path);
      if (failure.length > 0) {
        throw new EnvironmentError(`The logs folder could not be opened: ${failure}`);
      }
    },

    async openDataFolder() {
      const localAppData = process.env.LOCALAPPDATA;
      if (localAppData === undefined || localAppData.length === 0) {
        throw new EnvironmentError('LOCALAPPDATA is not set.');
      }
      const path = join(localAppData, 'WindhawkProfileManager');
      await mkdir(path, { recursive: true });
      const failure = await shell.openPath(path);
      if (failure.length > 0) {
        throw new EnvironmentError(`The data folder could not be opened: ${failure}`);
      }
    },

    async listSnapshots() {
      return (await snapshotStore.list()).map((item) => item.metadata);
    },

    async listSnapshotSummaries(): Promise<SnapshotSummary[]> {
      return (await snapshotStore.list()).map((item) => ({
        metadata: item.metadata,
        retained: item.retained,
        sizeBytes: item.sizeBytes,
      }));
    },

    async getSnapshot(id: string): Promise<SnapshotDetail> {
      return snapshotStore.get(id);
    },

    async deleteSnapshot(id: string, confirm: boolean): Promise<void> {
      await snapshotStore.delete(id, { confirm });
    },

    async importSnapshot(path: string): Promise<SnapshotSummary> {
      const environment = await cachedProbe();
      const record = await snapshotStore.import(path, {
        environment,
        profileId: null,
        registryView: '64-bit',
      });
      const item = (await snapshotStore.list()).find(
        (entry) => entry.metadata.id === record.metadata.id,
      );
      return {
        metadata: record.metadata,
        retained: item?.retained ?? true,
        sizeBytes: item?.sizeBytes ?? 0,
      };
    },

    async exportSnapshot(id: string): Promise<SnapshotExportData> {
      const exported = await snapshotStore.export(id);
      return {
        filename: exported.metadata.registryFile,
        metadataJson: exported.metadataJson,
        registryBytes: exported.registryBytes,
      };
    },

    async createRestorePlan(snapshotId: string): Promise<RestorePlan> {
      const source = await snapshotStore.get(snapshotId);
      const appState = await stateStore.get();
      const current = await registry.read();
      if (localAppData === undefined || localAppData.length === 0) {
        throw new EnvironmentError('LOCALAPPDATA is not set; restore paths cannot be created.');
      }
      const appRoot = join(localAppData, 'WindhawkProfileManager');
      const programData = resolveProgramData();
      const runId = `run-${randomUUID()}`;
      const preRestoreId = `snapshot-${randomUUID()}`;
      const runDirectory = join(programData, 'WindhawkProfileManager', 'runs', runId);
      const paths: RestorePaths = {
        plan: join(runDirectory, 'plan.json'),
        snapshotRegistry: join(appRoot, 'snapshots', `${preRestoreId}.reg`),
        journal: join(appRoot, 'journal.json'),
        result: join(runDirectory, 'result.json'),
        sourceSnapshotRegistry: join(appRoot, 'snapshots', `${source.metadata.id}.reg`),
      };
      return buildRestorePlan(source, current, {
        runId,
        snapshotId: preRestoreId,
        paths,
        invokingUser: await currentWindowsSid(),
        snapshotRetentionLimit: appState.snapshotRetention,
        // The preview is unconfirmed by default; the UI must confirm targeting.
        confirmTargeting: false,
      });
    },

    async runRestore(runRestoreOptions: RunRestoreOptions, onProgress?) {
      const source = await snapshotStore.get(runRestoreOptions.sourceSnapshotId);
      const appState = await stateStore.get();
      const current = await registry.read();
      if (localAppData === undefined || localAppData.length === 0) {
        throw new EnvironmentError('LOCALAPPDATA is not set; restore paths cannot be created.');
      }
      const appRoot = join(localAppData, 'WindhawkProfileManager');
      const programData = resolveProgramData();
      const runDirectory = join(
        programData,
        'WindhawkProfileManager',
        'runs',
        runRestoreOptions.runId,
      );
      const paths: RestorePaths = {
        plan: join(runDirectory, 'plan.json'),
        snapshotRegistry: join(appRoot, 'snapshots', `${runRestoreOptions.snapshotId}.reg`),
        journal: join(appRoot, 'journal.json'),
        result: join(runDirectory, 'result.json'),
        sourceSnapshotRegistry: join(appRoot, 'snapshots', `${source.metadata.id}.reg`),
      };
      const preview = buildRestorePlan(source, current, {
        runId: runRestoreOptions.runId,
        snapshotId: runRestoreOptions.snapshotId,
        paths,
        invokingUser: await currentWindowsSid(),
        snapshotRetentionLimit: appState.snapshotRetention,
        confirmTargeting: false,
      });
      if (preview.planHash !== runRestoreOptions.expectedPlanHash) {
        throw new StalePlanError(
          'The snapshot or registry changed since the restore was previewed; rebuild the restore plan.',
        );
      }

      let plan = preview;
      if (preview.targetingValues.length > 0) {
        if (runRestoreOptions.confirmTargeting !== true) {
          throw new ValidationError(
            'This restore writes machine-specific targeting values; confirm the targeting warning before restoring.',
          );
        }
        plan = buildRestorePlan(source, current, {
          runId: runRestoreOptions.runId,
          snapshotId: runRestoreOptions.snapshotId,
          paths,
          invokingUser: await currentWindowsSid(),
          snapshotRetentionLimit: appState.snapshotRetention,
          confirmTargeting: true,
        });
      }

      return executePlan(plan, onProgress);
    },

    async getDrift(profileId) {
      const profile = await profileStore.get(profileId);
      let current = null;
      try {
        current = await registry.read();
      } catch {
        // Drift is unknown when the registry cannot be read; the Home screen
        // still renders the profile and environment sections.
      }
      return drift.compare(profile, current);
    },

    async listThemePacks() {
      return structuredClone(content.themePacks);
    },

    async getThemePack(id) {
      const pack = content.themePacks.find((entry) => entry.id === id);
      if (pack === undefined) {
        throw new NotFoundError(`Theme pack "${id}" was not found.`);
      }
      return structuredClone(pack);
    },

    async startService() {
      if (broker.startService === undefined) {
        throw new EnvironmentError(
          'The elevated helper does not support the service-start action.',
        );
      }
      await broker.startService();
      return cachedProbe(true);
    },

    async captureSnapshot(profileId) {
      const environment = await cachedProbe();
      const record = await snapshotStore.capture('manual', {
        environment,
        profileId,
        registryView: '64-bit',
        ...(options.appVersion === undefined ? {} : { appVersion: options.appVersion }),
      });
      return record.metadata;
    },

    async createApplyPlan(profileId, planOptions = {}) {
      return createPlan(profileId, planOptions);
    },

    async runApply(profileId, runOptions) {
      let plan = cachedPlan(runOptions.runId, runOptions.expectedPlanHash);
      if (
        plan !== null &&
        (plan.profileId !== profileId || plan.profileRevision !== runOptions.expectedRevision)
      ) {
        plan = null;
      }
      if (plan !== null) {
        const current = await registry.read();
        if (computeManagedHash(managedIdsForApply(plan, current), current) !== plan.beforeHash) {
          plan = null;
        }
      }
      if (plan === null) {
        plan = await createPlan(profileId, runOptions, {
          runId: runOptions.runId,
          snapshotId: runOptions.snapshotId,
        });
      }
      const blocking = planBlockingError(plan);
      if (blocking !== null) throw blocking;
      if (plan.profileRevision !== runOptions.expectedRevision) {
        throw new StaleProfileError(`Profile "${profileId}" changed; rebuild the apply plan.`);
      }
      if (plan.planHash !== runOptions.expectedPlanHash) {
        throw new StalePlanError(
          'The registry or profile changed since the plan was previewed; rebuild the apply plan.',
        );
      }

      try {
        return await executePlan(plan, runOptions.onProgress);
      } finally {
        planCache.delete(plan.runId);
      }
    },
  };
}

function progressFromJournal(state: JournalState): ApplyProgressState {
  return state;
}
