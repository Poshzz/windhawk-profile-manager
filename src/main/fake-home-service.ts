import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import {
  REGISTRY_MODS_ROOT,
  parseAppState,
  parseApplyResult,
  parseEnvironment,
  parseProfile,
  parseProfileJson,
  parseRegistrySnapshot,
  parseSnapshotMetadata,
  type AppState,
  type ApplyPlan,
  type ApplyResult,
  type Environment,
  type Profile,
  type RegistrySnapshot,
  type RestorePlan,
  type SettingsPatch,
  type SnapshotMetadata,
  type ThemePack,
} from '@shared/domain';
import type {
  ApplyProgressState,
  Diagnostics,
  ProfileInput,
  RecoveryInfo,
  RecoveryResolution,
  RunRestoreOptions,
  SnapshotDetail,
  SnapshotSummary,
} from '@shared/ipc';
import { buildPlan } from '@core/planner/apply-planner';
import { buildRestorePlan } from '@core/planner/restore-planner';
import { DriftService } from '@core/planner/drift-service';
import { parseRegFile, serializeRegFile } from '@core/registry/reg-codec';
import type { HomeService, PlanApplyOptions } from '@core/home/home-service';
import { loadBundledContent } from '@infra/resources/bundled-content';
import {
  ElevationCanceledError,
  StalePlanError,
  StaleProfileError,
  ValidationError,
} from '@shared/errors';

export type FakeHomeMode = 'ready' | 'missing' | 'readonly' | 'stopped' | 'drift';
export type FakeApplyMode =
  'success' | 'noop' | 'partial' | 'warning' | 'rollback' | 'rollback-failed' | 'cancel';

const FIXED_NOW = '2026-10-22T20:00:00.000Z';
const SNAPSHOT_IDS = [
  '2026-10-22T19-58-00-000Z',
  '2026-10-22T19-30-00-000Z',
  '2026-10-21T18-00-00-000Z',
];

function makeSnapshotMetadata(id: string, trigger: SnapshotMetadata['trigger'], modCount: number) {
  const timestamp = id.replace(/-(\d\d)-(\d\d)-(\d\d\d)Z$/, ':$1:$2.$3Z');
  return parseSnapshotMetadata({
    schemaVersion: 1,
    id,
    createdAt: /^\d{4}-\d{2}-\d{2}T/.test(timestamp) ? timestamp : '2026-10-22T20:05:00.000Z',
    trigger,
    profileId: 'mac-blur-glass',
    appVersion: '0.1.0',
    windowsBuild: '22631',
    registryView: '64-bit',
    windhawkVersion: '1.7.3',
    windhawkStorageMode: 'registry',
    windhawkRegistryRoot: 'HKLM\\SOFTWARE\\Windhawk',
    windhawkServiceName: 'Windhawk',
    windhawkServiceState: 'running',
    rainmeterRunning: true,
    registryFile: `${id}.reg`,
    registrySha256: `sha256:${'0'.repeat(64)}`,
    modCount,
    scope: 'engine-mods-configuration',
    excludedPaths: [],
  });
}

function makeEnvironment(
  mode: FakeHomeMode,
  profiles: readonly Profile[],
  pack: ThemePack,
): Environment {
  const profile = profiles.find((entry) => entry.id === 'mac-blur-glass') ?? profiles[0];
  const mods =
    mode === 'missing'
      ? []
      : (profile?.requiredMods ?? []).map((mod) => ({
          modId: mod.modId,
          libraryFileName: `${mod.modId}.dll`,
          version: pack.mods.find((hint) => hint.modId === mod.modId)?.testedVersion ?? null,
          enabled: mod.state === 'enabled',
          settingsCount: Object.keys(mod.settings).length,
          perUserConfig: false,
        }));
  const missing = mode === 'missing';
  const readOnly = mode === 'readonly';

  return parseEnvironment({
    schemaVersion: 1,
    probedAt: FIXED_NOW,
    windows: { version: 'Windows 11 Pro', build: '22631', supported: true },
    windhawk: {
      installed: !missing,
      installDir: missing ? null : 'C:\\Program Files\\Windhawk',
      iniPath: missing ? null : 'C:\\ProgramData\\Windhawk\\windhawk.ini',
      version: missing ? null : '1.7.3',
      engineVersion: missing ? null : '1.7.3',
      storageMode: missing ? 'unknown' : readOnly ? 'portable' : 'registry',
      portable: readOnly,
      registryRoot: missing || readOnly ? null : 'HKLM\\SOFTWARE\\Windhawk',
    },
    service: {
      name: 'Windhawk',
      state: missing ? 'missing' : mode === 'stopped' ? 'stopped' : 'running',
    },
    mods,
    rainmeter: {
      installed: true,
      running: !missing,
      path: 'C:\\Program Files\\Rainmeter\\Rainmeter.exe',
    },
    perUserConfig: { present: false, active: false, sid: null },
    compatibility: {
      mode: missing ? 'unsupported' : readOnly ? 'read-only' : 'writable',
      canApply: !missing && !readOnly,
      issues: missing
        ? [
            {
              code: 'windhawk-missing',
              message: 'Windhawk was not found. Install it, then refresh.',
            },
          ]
        : readOnly
          ? [{ code: 'portable', message: 'Windhawk is running in portable mode.' }]
          : [],
    },
  });
}

function makeRegistrySnapshot(profile: Profile, drift: boolean): RegistrySnapshot {
  const keys = profile.requiredMods.flatMap((mod, index) => {
    const root = {
      path: `${REGISTRY_MODS_ROOT}\\${mod.modId}`,
      values: [
        { name: 'LibraryFileName', value: { type: 'string' as const, value: `${mod.modId}.dll` } },
        { name: 'Version', value: { type: 'string' as const, value: '1.0' } },
        {
          name: 'Disabled',
          value: { type: 'dword' as const, value: drift && index === 0 ? 1 : 0 },
        },
      ],
    };
    const settings = {
      path: `${REGISTRY_MODS_ROOT}\\${mod.modId}\\Settings`,
      values: Object.entries(mod.settings).map(([name, value]) => ({ name, value })),
    };
    return [root, settings];
  });

  return parseRegistrySnapshot({
    schemaVersion: 1,
    capturedAt: FIXED_NOW,
    registryView: '64-bit',
    keys,
  });
}

function makeFakeResult(plan: ApplyPlan, mode: FakeApplyMode): ApplyResult {
  const base = {
    schemaVersion: 1 as const,
    runId: plan.runId,
    kind: plan.kind,
    startedAt: FIXED_NOW,
    completedAt: '2026-10-22T20:00:04.000Z',
    changedMods: plan.modChanges.map((change) => change.modId),
    skippedMods: [],
    warnings: [] as string[],
    reload: {
      requested: true,
      confirmed: false as const,
      message: 'Applied; the Windhawk reload was requested but is not confirmed loaded.',
    },
    verification: {
      status: 'verified' as const,
      checkedAt: '2026-10-22T20:00:04.000Z',
      message: 'Verified after a settle.',
    },
    actions: {
      rainmeter: { status: 'succeeded' as const, message: 'Rainmeter action completed.' },
      explorer: { status: 'skipped' as const, message: 'Explorer restart was not requested.' },
    },
    rollback: null,
    error: null,
  };

  switch (mode) {
    case 'noop':
      return parseApplyResult({
        ...base,
        status: 'succeeded',
        message: 'No registry writes were needed.',
        changedMods: [],
        reload: {
          requested: false,
          confirmed: false,
          message: 'No registry values changed; no reload was requested.',
        },
        verification: {
          status: 'verified',
          checkedAt: base.verification.checkedAt,
          message: 'No touched registry values needed verification.',
        },
      });
    case 'partial':
      return parseApplyResult({
        ...base,
        status: 'succeeded',
        message: 'Applied; reload requested, not confirmed loaded.',
        skippedMods: [
          {
            modId: 'missing-mod',
            reason: 'missing',
            message: 'A managed mod is not installed and was skipped.',
          },
        ],
        warnings: ['A managed mod is not installed and was skipped.'],
      });
    case 'warning':
      return parseApplyResult({
        ...base,
        status: 'succeeded-with-warning',
        message:
          'Applied; reload requested, not confirmed loaded. Finishing actions completed with warnings.',
        warnings: ['Rainmeter could not be started.'],
        actions: {
          rainmeter: { status: 'failed', message: 'Rainmeter could not be started.' },
          explorer: { status: 'skipped', message: 'Explorer restart was not requested.' },
        },
      });
    case 'rollback':
      return parseApplyResult({
        ...base,
        status: 'rolled-back',
        message: 'The apply failed and the pre-run snapshot was restored. Injected failure.',
        rollback: { status: 'succeeded', message: 'Restored the pre-run snapshot.' },
        verification: {
          status: 'verified',
          checkedAt: base.verification.checkedAt,
          message: 'Rollback verified after a settle.',
        },
        error: {
          code: 'APPLY_FAILED',
          name: 'ApplyError',
          message: 'Injected apply failure.',
          details: [],
        },
      });
    case 'rollback-failed':
      return parseApplyResult({
        ...base,
        status: 'rollback-failed',
        message: `Automatic rollback failed. The journal and snapshot "${plan.paths.snapshotRegistry}" were kept. Restore this snapshot manually from the Snapshots screen, then clear the journal.`,
        warnings: ['Automatic rollback failed; restore the snapshot manually.'],
        rollback: { status: 'failed', message: 'Injected rollback failure.' },
        verification: {
          status: 'not-verified',
          checkedAt: null,
          message: 'Rollback verification did not complete.',
        },
        error: {
          code: 'ROLLBACK_FAILED',
          name: 'RollbackError',
          message: 'Injected rollback failure.',
          details: [],
        },
      });
    case 'cancel':
      return parseApplyResult({
        ...base,
        status: 'canceled',
        message: 'Elevation was canceled; no changes were made.',
        changedMods: [],
        reload: { requested: false, confirmed: false, message: 'No reload was requested.' },
        verification: { status: 'not-run', checkedAt: null, message: 'Not run.' },
      });
    default:
      return parseApplyResult({
        ...base,
        status: 'succeeded',
        message: 'Applied; reload requested, not confirmed loaded.',
      });
  }
}

function makeFakeRestoreResult(plan: RestorePlan): ApplyResult {
  return parseApplyResult({
    schemaVersion: 1,
    runId: plan.runId,
    kind: 'restore',
    status: 'succeeded',
    message: 'Restored the captured snapshot; reload requested, not confirmed loaded.',
    startedAt: FIXED_NOW,
    completedAt: '2026-10-22T20:00:04.000Z',
    changedMods: [],
    skippedMods: [],
    warnings: [],
    reload: {
      requested: true,
      confirmed: false,
      message: 'The Windhawk reload was requested but is not confirmed loaded.',
    },
    verification: {
      status: 'verified',
      checkedAt: '2026-10-22T20:00:04.000Z',
      message: 'Restore verified after a settle.',
    },
    actions: {
      rainmeter: { status: 'succeeded', message: 'Rainmeter state restored.' },
      explorer: { status: 'skipped', message: 'Explorer restart was not requested.' },
    },
    rollback: null,
    error: null,
  });
}

export async function createFakeHomeService(
  resourcesDirectory: string,
  mode: FakeHomeMode,
  applyMode: FakeApplyMode = 'success',
  firstRun = false,
  recovery = false,
): Promise<HomeService> {
  const content = await loadBundledContent(resourcesDirectory);
  let profiles = structuredClone(content.profiles);
  const pack = content.themePacks[0];
  if (pack === undefined) throw new ValidationError('The fake environment needs a theme pack.');
  let environment = makeEnvironment(mode, profiles, pack);
  const initialActiveProfile =
    profiles.find((profile) => profile.id === 'mac-blur-glass') ?? profiles[0];
  if (initialActiveProfile === undefined)
    throw new ValidationError('The fake environment needs a profile.');
  let activeProfile: Profile = initialActiveProfile;
  let currentRegistry = makeRegistrySnapshot(activeProfile, mode === 'drift');
  let recoveryPending = recovery;
  const snapshots: SnapshotMetadata[] = SNAPSHOT_IDS.map((id, index) =>
    makeSnapshotMetadata(
      id,
      index === 2 ? 'manual' : 'pre-apply',
      activeProfile.requiredMods.length,
    ),
  );
  const historicalRegistry = makeRegistrySnapshot(activeProfile, true);
  const snapshotRegistries = new Map<string, RegistrySnapshot>(
    snapshots.map((metadata) => [metadata.id, structuredClone(historicalRegistry)]),
  );
  let state: AppState = parseAppState({
    schemaVersion: 1,
    activeProfileId: activeProfile.id,
    lastAppliedAt: '2026-10-22T19:58:00.000Z',
    lastRunId: 'run-2026-10-22T19-58-00-000Z',
    firstRunCompleted: !firstRun,
  });
  const drift = new DriftService({ now: () => new Date(FIXED_NOW) });
  const profileTimestamp = '2026-10-22T20:05:00.000Z';

  const findProfile = (id: string): Profile => {
    const profile = profiles.find((entry) => entry.id === id);
    if (profile === undefined) throw new ValidationError(`Profile "${id}" was not found.`);
    return profile;
  };

  const allocateProfileId = (name: string): string => {
    const base =
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64) || 'profile';
    const existing = new Set(profiles.map((profile) => profile.id.toLowerCase()));
    if (!existing.has(base)) return base;
    for (let index = 2; index < 10_000; index += 1) {
      const candidate = `${base.slice(0, 64 - String(index).length - 1)}-${index}`;
      if (!existing.has(candidate)) return candidate;
    }
    throw new ValidationError('Unable to allocate a fake profile ID.');
  };

  const createFakeUserProfile = (input: ProfileInput, source?: Profile): Profile => {
    const profile = parseProfile({
      schemaVersion: 1,
      id: allocateProfileId(input.name),
      name: input.name,
      description: input.description ?? source?.description ?? '',
      source: 'user',
      basedOn: source?.id ?? null,
      revision: 1,
      createdAt: profileTimestamp,
      updatedAt: profileTimestamp,
      requiredMods: input.requiredMods ?? source?.requiredMods ?? [],
      unlistedMods: input.unlistedMods ?? source?.unlistedMods ?? 'leave',
      actions: input.actions ?? source?.actions ?? {},
    });
    profiles = [...profiles, profile];
    return profile;
  };

  const createPlan = async (
    profileId: string,
    planOptions: PlanApplyOptions = {},
    identity: { readonly runId: string; readonly snapshotId: string } = {
      runId: `run-${randomUUID()}`,
      snapshotId: `snapshot-${randomUUID()}`,
    },
  ): Promise<ApplyPlan> => {
    const profile = profiles.find((entry) => entry.id === profileId);
    if (profile === undefined) throw new ValidationError(`Profile "${profileId}" was not found.`);
    const environment = makeEnvironment(mode, profiles, pack);
    const current = currentRegistry;
    const planProfile =
      applyMode === 'noop'
        ? {
            ...profile,
            actions: { ...profile.actions, rainmeter: 'unchanged' as const },
          }
        : profile;
    const appRoot = 'C:\\Users\\Test\\AppData\\Local\\WindhawkProfileManager';
    const runDirectory = `C:\\ProgramData\\WindhawkProfileManager\\runs\\${identity.runId}`;
    return buildPlan(planProfile, current, environment, {
      runId: identity.runId,
      snapshotId: identity.snapshotId,
      paths: {
        plan: `${runDirectory}\\plan.json`,
        snapshotRegistry: `${appRoot}\\snapshots\\${identity.snapshotId}.reg`,
        journal: `${appRoot}\\journal.json`,
        result: `${runDirectory}\\result.json`,
      },
      themePackMods: pack.mods.map((mod) => ({
        modId: mod.modId,
        testedVersion: mod.testedVersion,
      })),
      ...(planOptions.explorerRestart === undefined
        ? {}
        : { explorerRestart: planOptions.explorerRestart }),
      ...(planOptions.confirmDeleteAllSettings === undefined
        ? {}
        : { confirmDeleteAllSettings: planOptions.confirmDeleteAllSettings }),
    });
  };

  const getSnapshotDetail = (id: string): SnapshotDetail => {
    const metadata = snapshots.find((entry) => entry.id === id);
    if (metadata === undefined) throw new ValidationError(`Snapshot "${id}" was not found.`);
    return {
      metadata: structuredClone(metadata),
      registry: structuredClone(snapshotRegistries.get(id) ?? currentRegistry),
    };
  };

  return {
    async probeEnvironment() {
      return structuredClone(environment);
    },

    async listProfiles() {
      return structuredClone(profiles);
    },

    async getProfile(id) {
      return structuredClone(findProfile(id));
    },

    async createProfile(input) {
      return structuredClone(createFakeUserProfile(input));
    },

    async updateProfile(id, expectedRevision, input) {
      const current = findProfile(id);
      if (current.source === 'builtin') {
        throw new ValidationError('Built-in profiles are read-only.');
      }
      if (current.revision !== expectedRevision) {
        throw new StaleProfileError('The fake profile changed; reload it.');
      }
      const updated = parseProfile({
        ...current,
        name: input.name,
        description: input.description ?? current.description,
        requiredMods: input.requiredMods ?? current.requiredMods,
        unlistedMods: input.unlistedMods ?? current.unlistedMods,
        actions:
          input.actions === undefined ? current.actions : { ...current.actions, ...input.actions },
        revision: current.revision + 1,
        updatedAt: profileTimestamp,
      });
      profiles = profiles.map((profile) => (profile.id === id ? updated : profile));
      return structuredClone(updated);
    },

    async deleteProfile(id, confirm) {
      if (!confirm) throw new ValidationError('Deleting a profile requires confirmation.');
      const current = findProfile(id);
      if (current.source === 'builtin') {
        throw new ValidationError('Built-in profiles are read-only.');
      }
      profiles = profiles.filter((profile) => profile.id !== id);
    },

    async duplicateProfile(id, name) {
      const source = findProfile(id);
      return structuredClone(
        createFakeUserProfile(
          {
            name: name ?? `${source.name} copy`,
            description: source.description,
            requiredMods: source.requiredMods,
            unlistedMods: source.unlistedMods,
            actions: source.actions,
          },
          source,
        ),
      );
    },

    async captureProfile(input) {
      const requiredMods = activeProfile.requiredMods.filter(
        (mod) => input.includeDisabled || mod.state === 'enabled',
      );
      return structuredClone(
        createFakeUserProfile({
          name: input.name,
          description: 'Captured from this machine.',
          requiredMods,
          unlistedMods: 'leave',
          actions: { rainmeter: 'unchanged', restartExplorer: 'ask' },
        }),
      );
    },

    async importProfileJson(json) {
      const imported = parseProfileJson(json);
      if (imported.source === 'builtin') {
        throw new ValidationError('Built-in profiles cannot be imported.');
      }
      if (profiles.some((profile) => profile.id === imported.id)) {
        throw new ValidationError(`A profile with ID "${imported.id}" already exists.`);
      }
      profiles = [...profiles, imported];
      return structuredClone(imported);
    },

    async exportProfileJson(id) {
      return `${JSON.stringify(findProfile(id), null, 2)}\n`;
    },

    async getState() {
      return structuredClone(state);
    },

    async updateSettings(patch: SettingsPatch) {
      state = parseAppState({ ...state, ...patch });
      return structuredClone(state);
    },

    async completeFirstRun() {
      state = parseAppState({ ...state, firstRunCompleted: true });
      return structuredClone(state);
    },

    async getRecovery(): Promise<RecoveryInfo | null> {
      if (!recoveryPending) return null;
      const snapshot = snapshots[0];
      if (snapshot === undefined) return null;
      return {
        runId: 'run-fake-recovery',
        snapshotId: snapshot.id,
        state: 'applying',
        kind: 'apply',
        startedAt: FIXED_NOW,
        inProgress: false,
        rainmeterAction: snapshot.rainmeterRunning ? 'start' : 'stop',
      };
    },

    async resolveRecovery(action): Promise<RecoveryResolution> {
      if (action === 'dismiss') {
        recoveryPending = false;
        return { action: 'dismissed', result: null };
      }
      recoveryPending = false;
      const snapshot = snapshots[0];
      if (snapshot === undefined) throw new ValidationError('No snapshot is available.');
      const source = getSnapshotDetail(snapshot.id);
      const current = currentRegistry;
      const appRoot = 'C:\\Users\\Test\\AppData\\Local\\WindhawkProfileManager';
      const runId = `run-${randomUUID()}`;
      const preRestoreId = `snapshot-${randomUUID()}`;
      const runDirectory = `C:\\ProgramData\\WindhawkProfileManager\\runs\\${runId}`;
      const plan = buildRestorePlan(source, current, {
        runId,
        snapshotId: preRestoreId,
        paths: {
          plan: `${runDirectory}\\plan.json`,
          snapshotRegistry: `${appRoot}\\snapshots\\${preRestoreId}.reg`,
          journal: `${appRoot}\\journal.json`,
          result: `${runDirectory}\\result.json`,
          sourceSnapshotRegistry: `${appRoot}\\snapshots\\${source.metadata.id}.reg`,
        },
      });
      snapshotRegistries.set(preRestoreId, structuredClone(currentRegistry));
      snapshots.unshift(
        parseSnapshotMetadata({
          ...makeSnapshotMetadata(preRestoreId, 'pre-restore', source.metadata.modCount),
          profileId: null,
        }),
      );
      currentRegistry = structuredClone(source.registry);
      return { action: 'restored', result: makeFakeRestoreResult(plan) };
    },

    async getDiagnostics(): Promise<Diagnostics> {
      return {
        appVersion: '0.1.0',
        windowsBuild: environment.windows.build,
        windowsSupported: environment.windows.supported,
        windhawkVersion: environment.windhawk.version,
        storageMode: environment.windhawk.storageMode,
        registryRoot: environment.windhawk.registryRoot,
        serviceState: environment.service.state,
        modCount: environment.mods.length,
        lastRun: null,
      };
    },

    async openLogsFolder() {
      return undefined;
    },

    async openDataFolder() {
      return undefined;
    },

    async listSnapshots() {
      return structuredClone(snapshots);
    },

    async listSnapshotSummaries(): Promise<SnapshotSummary[]> {
      return snapshots.map((metadata) => ({
        metadata: structuredClone(metadata),
        retained: metadata.trigger === 'manual' || metadata.trigger === 'imported',
        sizeBytes: 512,
      }));
    },

    async getSnapshot(id: string): Promise<SnapshotDetail> {
      const metadata = snapshots.find((entry) => entry.id === id);
      if (metadata === undefined) throw new ValidationError(`Snapshot "${id}" was not found.`);
      return {
        metadata: structuredClone(metadata),
        registry: structuredClone(snapshotRegistries.get(id) ?? currentRegistry),
      };
    },

    async deleteSnapshot(id: string, confirm: boolean) {
      if (!confirm) throw new ValidationError('Deleting a snapshot requires confirmation.');
      if (!snapshots.some((entry) => entry.id === id)) {
        throw new ValidationError(`Snapshot "${id}" was not found.`);
      }
      const index = snapshots.findIndex((entry) => entry.id === id);
      snapshots.splice(index, 1);
      snapshotRegistries.delete(id);
    },

    async importSnapshot(path: string): Promise<SnapshotSummary> {
      const registry = parseRegFile(readFileSync(path), { capturedAt: FIXED_NOW });
      const id = `imported-${randomUUID()}`;
      const metadata = parseSnapshotMetadata({
        ...makeSnapshotMetadata(id, 'imported', registry.keys.length),
        profileId: null,
        registryFile: `${id}.reg`,
        registrySha256: `sha256:${'0'.repeat(64)}`,
      });
      snapshots.unshift(metadata);
      snapshotRegistries.set(metadata.id, structuredClone(registry));
      return {
        metadata: structuredClone(metadata),
        retained: true,
        sizeBytes: 512,
      };
    },

    async exportSnapshot(id: string) {
      const detail = getSnapshotDetail(id);
      return {
        filename: detail.metadata.registryFile,
        metadataJson: `${JSON.stringify(detail.metadata, null, 2)}\n`,
        registryBytes: serializeRegFile(detail.registry),
      };
    },

    async createRestorePlan(snapshotId: string): Promise<RestorePlan> {
      const source = getSnapshotDetail(snapshotId);
      const current = makeRegistrySnapshot(activeProfile, false);
      const appRoot = 'C:\\Users\\Test\\AppData\\Local\\WindhawkProfileManager';
      const runId = `run-${randomUUID()}`;
      const preRestoreId = `snapshot-${randomUUID()}`;
      const runDirectory = `C:\\ProgramData\\WindhawkProfileManager\\runs\\${runId}`;
      return buildRestorePlan(source, current, {
        runId,
        snapshotId: preRestoreId,
        paths: {
          plan: `${runDirectory}\\plan.json`,
          snapshotRegistry: `${appRoot}\\snapshots\\${preRestoreId}.reg`,
          journal: `${appRoot}\\journal.json`,
          result: `${runDirectory}\\result.json`,
          sourceSnapshotRegistry: `${appRoot}\\snapshots\\${source.metadata.id}.reg`,
        },
      });
    },

    async runRestore(runOptions: RunRestoreOptions, onProgress?) {
      const source = getSnapshotDetail(runOptions.sourceSnapshotId);
      const current = makeRegistrySnapshot(activeProfile, false);
      const appRoot = 'C:\\Users\\Test\\AppData\\Local\\WindhawkProfileManager';
      const runDirectory = `C:\\ProgramData\\WindhawkProfileManager\\runs\\${runOptions.runId}`;
      const plan = buildRestorePlan(source, current, {
        runId: runOptions.runId,
        snapshotId: runOptions.snapshotId,
        paths: {
          plan: `${runDirectory}\\plan.json`,
          snapshotRegistry: `${appRoot}\\snapshots\\${runOptions.snapshotId}.reg`,
          journal: `${appRoot}\\journal.json`,
          result: `${runDirectory}\\result.json`,
          sourceSnapshotRegistry: `${appRoot}\\snapshots\\${source.metadata.id}.reg`,
        },
      });
      if (plan.planHash !== runOptions.expectedPlanHash) {
        throw new StalePlanError('The fake snapshot changed; rebuild the restore plan.');
      }
      const sequence: ApplyProgressState[] = [
        'preflight',
        'snapshotting',
        'journaling',
        'applying',
        'settling',
        'verifying',
        'privileged-complete',
        'finishing',
        'succeeded',
      ];
      for (const state of sequence) {
        onProgress?.(state);
        await delay(60);
      }
      snapshotRegistries.set(runOptions.snapshotId, structuredClone(currentRegistry));
      currentRegistry = structuredClone(source.registry);
      snapshots.unshift(
        parseSnapshotMetadata({
          ...makeSnapshotMetadata(runOptions.snapshotId, 'pre-restore', source.metadata.modCount),
          profileId: null,
        }),
      );
      return makeFakeRestoreResult(plan);
    },

    async getDrift(profileId) {
      const profile = profiles.find((entry) => entry.id === profileId) ?? activeProfile;
      return drift.compare(profile, currentRegistry);
    },

    async listThemePacks() {
      return structuredClone(content.themePacks);
    },

    async getThemePack(id) {
      const found = content.themePacks.find((entry) => entry.id === id);
      if (found === undefined) throw new ValidationError(`Theme pack "${id}" was not found.`);
      return structuredClone(found);
    },

    async startService() {
      if (mode === 'missing') return structuredClone(environment);
      environment = parseEnvironment({
        ...environment,
        service: { ...environment.service, state: 'running' },
      });
      return structuredClone(environment);
    },

    async captureSnapshot(profileId) {
      const id = `manual-${randomUUID()}`;
      const metadata = parseSnapshotMetadata({
        ...makeSnapshotMetadata(id, 'manual', activeProfile.requiredMods.length),
        profileId,
      });
      snapshots.unshift(metadata);
      snapshotRegistries.set(metadata.id, structuredClone(currentRegistry));
      return metadata;
    },

    async createApplyPlan(profileId, planOptions = {}) {
      return createPlan(profileId, planOptions);
    },

    async runApply(profileId, runOptions) {
      const plan = await createPlan(profileId, runOptions, {
        runId: runOptions.runId,
        snapshotId: runOptions.snapshotId,
      });
      if (plan.profileRevision !== runOptions.expectedRevision) {
        throw new StalePlanError('The fake profile changed; rebuild the apply plan.');
      }
      if (plan.planHash !== runOptions.expectedPlanHash) {
        throw new StalePlanError('The fake registry changed; rebuild the apply plan.');
      }

      const emit = (state: ApplyProgressState): void => {
        try {
          runOptions.onProgress?.(state);
        } catch {
          // Ignore progress consumer failures.
        }
      };

      const sequence: ApplyProgressState[] = [
        'preflight',
        'snapshotting',
        'journaling',
        'applying',
        'settling',
        'verifying',
        'privileged-complete',
        'finishing',
      ];
      if (applyMode === 'cancel') {
        emit('preflight');
        emit('snapshotting');
        emit('canceled');
        throw new ElevationCanceledError('The UAC prompt was canceled; no changes were made.');
      }
      if (applyMode === 'rollback' || applyMode === 'rollback-failed') {
        sequence.push('rolling-back', applyMode === 'rollback' ? 'rolled-back' : 'rollback-failed');
      }
      for (const state of sequence) {
        emit(state);
        await delay(80);
      }
      const result = makeFakeResult(plan, applyMode);
      if (result.status === 'succeeded' || result.status === 'succeeded-with-warning') {
        const appliedProfile = findProfile(profileId);
        const preApplyRegistry = structuredClone(currentRegistry);
        activeProfile = appliedProfile;
        currentRegistry = makeRegistrySnapshot(appliedProfile, false);
        snapshotRegistries.set(runOptions.snapshotId, preApplyRegistry);
        state = parseAppState({
          ...state,
          activeProfileId: appliedProfile.id,
          lastAppliedAt: result.completedAt,
          lastRunId: plan.runId,
        });
        snapshots.unshift(
          parseSnapshotMetadata({
            ...makeSnapshotMetadata(
              runOptions.snapshotId,
              'pre-apply',
              appliedProfile.requiredMods.length,
            ),
            profileId: appliedProfile.id,
          }),
        );
      }
      emit(result.status);
      return result;
    },
  };
}
