import type {
  AppState,
  ApplyPlan,
  ApplyResult,
  Drift,
  Environment,
  JournalState,
  Profile,
  ProfileActions,
  ProfileMod,
  RegistrySnapshot,
  RestorePlan,
  SettingsPatch,
  SnapshotMetadata,
  ThemePack,
} from './domain';
export const IPC = {
  ping: 'app:ping',
  versions: 'app:get-versions',
  config: 'app:get-config',
  environmentProbe: 'environment:probe',
  profilesList: 'profiles:list',
  profilesGet: 'profiles:get',
  profilesCreate: 'profiles:create',
  profilesUpdate: 'profiles:update',
  profilesDelete: 'profiles:delete',
  profilesDuplicate: 'profiles:duplicate',
  profilesImport: 'profiles:import',
  profilesExport: 'profiles:export',
  profilesCapture: 'profiles:capture',
  snapshotsList: 'snapshots:list',
  snapshotsSummaries: 'snapshots:summaries',
  snapshotsGet: 'snapshots:get',
  snapshotsCapture: 'snapshots:capture',
  snapshotsDelete: 'snapshots:delete',
  snapshotsImport: 'snapshots:import',
  snapshotsExport: 'snapshots:export',
  driftGet: 'drift:get',
  planApply: 'plan:apply',
  planRestore: 'plan:restore',
  runApply: 'run:apply',
  runRestore: 'run:restore',
  applyProgress: 'apply:progress',
  stateGet: 'state:get',
  settingsUpdate: 'settings:update',
  firstRunComplete: 'first-run:complete',
  recoveryGet: 'recovery:get',
  recoveryResolve: 'recovery:resolve',
  diagnosticsGet: 'diagnostics:get',
  logsOpen: 'diagnostics:open-logs',
  dataOpen: 'diagnostics:open-data',
  themePacksList: 'theme-packs:list',
  themePacksGet: 'theme-packs:get',
  serviceStart: 'service:start',
  openExternal: 'app:open-external',
  windowMinimize: 'window:minimize',
  windowToggleMaximize: 'window:toggle-maximize',
  windowClose: 'window:close',
  windowMaximizedChanged: 'window:maximized-changed',
  themeSetSource: 'theme:set-source',
  themeSystemChanged: 'theme:system-changed',
} as const;

export type TitlebarMode = 'overlay' | 'custom';
export type AppLocale = 'en' | 'th';
export type ThemeSource = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';
export type BackgroundMaterial = 'mica' | 'acrylic' | 'opaque';

export type ApplyProgressState =
  | 'preflight'
  | 'snapshotting'
  | 'journaling'
  | 'applying'
  | 'settling'
  | 'verifying'
  | 'privileged-complete'
  | 'finishing'
  | 'rolling-back'
  | 'succeeded'
  | 'succeeded-with-warning'
  | 'rolled-back'
  | 'rollback-failed'
  | 'failed'
  | 'canceled'
  | 'dry-run';

export interface ApplyProgressEvent {
  readonly planHash: string;
  readonly state: ApplyProgressState;
}

export interface ProfileInput {
  readonly name: string;
  readonly description?: string;
  readonly requiredMods?: ProfileMod[];
  readonly unlistedMods?: Profile['unlistedMods'];
  readonly actions?: Partial<ProfileActions>;
}

export interface CaptureProfileInput {
  readonly name: string;
  readonly includeDisabled: boolean;
}

export interface SnapshotSummary {
  readonly metadata: SnapshotMetadata;
  readonly retained: boolean;
  readonly sizeBytes: number;
}

export interface SnapshotDetail {
  readonly metadata: SnapshotMetadata;
  readonly registry: RegistrySnapshot;
}

export interface RunRestoreOptions {
  readonly sourceSnapshotId: string;
  readonly expectedPlanHash: string;
  readonly runId: string;
  readonly snapshotId: string;
  readonly confirmTargeting?: boolean;
}

export interface RecoveryInfo {
  readonly runId: string;
  readonly snapshotId: string;
  readonly state: JournalState;
  readonly kind: 'apply' | 'restore';
  readonly startedAt: string;
  /** True when the elevated helper still holds the run lease. */
  readonly inProgress?: boolean;
  /** The privileged phase succeeded; only finishing actions remain. */
  readonly canFinish?: boolean;
  /** Rainmeter action implied by the pre-run snapshot. */
  readonly rainmeterAction?: 'start' | 'stop' | null;
  /** The journal could not be parsed; only a force-close is safe. */
  readonly problem?: 'corrupt';
}

export interface RecoveryResolution {
  readonly action: 'restored' | 'dismissed' | 'finished';
  readonly result: ApplyResult | null;
}

export interface Diagnostics {
  readonly appVersion: string;
  readonly windowsBuild: string;
  readonly windowsSupported: boolean;
  readonly windhawkVersion: string | null;
  readonly storageMode: string;
  readonly registryRoot: string | null;
  readonly serviceState: string;
  readonly modCount: number;
  readonly lastRun: {
    readonly runId: string;
    readonly status: ApplyResult['status'];
    readonly completedAt: string | null;
  } | null;
}

export interface PingResult {
  ok: true;
  message: 'pong';
  at: string;
  /** Reported by the sandboxed preload, for packaged smoke evidence. */
  rendererSandboxed?: boolean;
}

export interface AppVersions {
  app: string;
  electron: string;
  chrome: string;
  node: string;
}

export interface AppConfig {
  titlebarMode: TitlebarMode;
  systemLocale: AppLocale;
  systemTheme: ResolvedTheme;
  backgroundMaterial: BackgroundMaterial;
}

export interface WindowControls {
  minimize(): void;
  toggleMaximize(): void;
  close(): void;
  onMaximizedChange(listener: (isMaximized: boolean) => void): () => void;
}

export interface WpmApi {
  ping(): Promise<PingResult>;
  getVersions(): Promise<AppVersions>;
  getConfig(): Promise<AppConfig>;
  setThemeSource(theme: ThemeSource): Promise<void>;
  onSystemThemeChange(listener: (theme: ResolvedTheme) => void): () => void;
  getEnvironment(): Promise<Environment>;
  listProfiles(): Promise<Profile[]>;
  getProfile(id: string): Promise<Profile>;
  createProfile(input: ProfileInput): Promise<Profile>;
  updateProfile(id: string, expectedRevision: number, input: ProfileInput): Promise<Profile>;
  deleteProfile(id: string, expectedRevision: number): Promise<void>;
  duplicateProfile(id: string, name?: string): Promise<Profile>;
  captureProfile(input: CaptureProfileInput): Promise<Profile>;
  importProfile(): Promise<Profile | null>;
  exportProfile(id: string): Promise<string | null>;
  getState(): Promise<AppState>;
  updateSettings(patch: SettingsPatch): Promise<AppState>;
  completeFirstRun(): Promise<AppState>;
  getRecovery(): Promise<RecoveryInfo | null>;
  resolveRecovery(action: 'restore' | 'dismiss' | 'finish'): Promise<RecoveryResolution>;
  getDiagnostics(): Promise<Diagnostics>;
  openLogsFolder(): Promise<void>;
  openDataFolder(): Promise<void>;
  listSnapshots(): Promise<SnapshotMetadata[]>;
  listSnapshotSummaries(): Promise<SnapshotSummary[]>;
  getSnapshot(id: string): Promise<SnapshotDetail>;
  deleteSnapshot(id: string): Promise<void>;
  importSnapshot(): Promise<SnapshotSummary | null>;
  exportSnapshot(id: string): Promise<string | null>;
  planRestore(snapshotId: string): Promise<RestorePlan>;
  runRestore(options: RunRestoreOptions): Promise<ApplyResult>;
  getDrift(profileId: string): Promise<Drift>;
  listThemePacks(): Promise<ThemePack[]>;
  getThemePack(id: string): Promise<ThemePack>;
  startService(): Promise<Environment>;
  captureSnapshot(profileId: string | null): Promise<SnapshotMetadata>;
  planApply(profileId: string, options?: ApplyPlanOptions): Promise<ApplyPlan>;
  runApply(profileId: string, options: RunApplyOptions): Promise<ApplyResult>;
  onApplyProgress(listener: (progress: ApplyProgressEvent) => void): () => void;
  openExternal(url: string): Promise<void>;
  windowControls: WindowControls;
}

export interface ApplyPlanOptions {
  readonly explorerRestart?: Profile['actions']['restartExplorer'];
  readonly confirmDeleteAllSettings?: boolean;
}

export interface RunApplyOptions extends ApplyPlanOptions {
  readonly expectedRevision: number;
  readonly expectedPlanHash: string;
  readonly runId: string;
  readonly snapshotId: string;
}

export interface IpcContract {
  [IPC.ping]: { request: void; response: PingResult };
  [IPC.versions]: { request: void; response: AppVersions };
  [IPC.config]: { request: void; response: AppConfig };
  [IPC.environmentProbe]: { request: void; response: Environment };

  [IPC.profilesList]: { request: void; response: Profile[] };
  [IPC.profilesGet]: { request: { id: string }; response: Profile };
  [IPC.profilesCreate]: { request: { input: ProfileInput }; response: Profile };
  [IPC.profilesUpdate]: {
    request: { id: string; expectedRevision: number; input: ProfileInput };
    response: Profile;
  };
  [IPC.profilesDelete]: {
    request: { id: string; expectedRevision: number };
    response: void;
  };
  [IPC.profilesDuplicate]: { request: { id: string; name?: string }; response: Profile };
  [IPC.profilesCapture]: { request: CaptureProfileInput; response: Profile };
  [IPC.profilesImport]: { request: void; response: Profile | null };
  [IPC.profilesExport]: { request: { id: string }; response: string | null };

  [IPC.snapshotsList]: { request: void; response: SnapshotMetadata[] };
  [IPC.snapshotsSummaries]: { request: void; response: SnapshotSummary[] };
  [IPC.snapshotsGet]: { request: { id: string }; response: SnapshotDetail };
  [IPC.snapshotsCapture]: {
    request: { profileId: string | null };
    response: SnapshotMetadata;
  };
  [IPC.snapshotsDelete]: { request: { id: string }; response: void };
  [IPC.snapshotsImport]: { request: void; response: SnapshotSummary | null };
  [IPC.snapshotsExport]: { request: { id: string }; response: string | null };

  [IPC.driftGet]: { request: { profileId: string }; response: Drift };
  [IPC.planApply]: {
    request: { profileId: string } & ApplyPlanOptions;
    response: ApplyPlan;
  };
  [IPC.planRestore]: { request: { snapshotId: string }; response: RestorePlan };
  [IPC.runApply]: {
    request: { profileId: string } & RunApplyOptions;
    response: ApplyResult;
  };
  [IPC.runRestore]: { request: RunRestoreOptions; response: ApplyResult };

  [IPC.stateGet]: { request: void; response: AppState };
  [IPC.settingsUpdate]: { request: { patch: SettingsPatch }; response: AppState };
  [IPC.firstRunComplete]: { request: void; response: AppState };
  [IPC.recoveryGet]: { request: void; response: RecoveryInfo | null };
  [IPC.recoveryResolve]: {
    request: { action: 'restore' | 'dismiss' | 'finish' };
    response: RecoveryResolution;
  };
  [IPC.diagnosticsGet]: { request: void; response: Diagnostics };
  [IPC.logsOpen]: { request: void; response: void };
  [IPC.dataOpen]: { request: void; response: void };
  [IPC.themePacksList]: { request: void; response: ThemePack[] };
  [IPC.themePacksGet]: { request: { id: string }; response: ThemePack };
  [IPC.serviceStart]: { request: void; response: Environment };
  [IPC.openExternal]: { request: { url: string }; response: void };

  [IPC.windowMinimize]: { request: void; response: void };
  [IPC.windowToggleMaximize]: { request: void; response: void };
  [IPC.windowClose]: { request: void; response: void };
  [IPC.themeSetSource]: { request: { theme: ThemeSource }; response: void };
}

export interface IpcEventContract {
  [IPC.windowMaximizedChanged]: boolean;
  [IPC.themeSystemChanged]: ResolvedTheme;
  [IPC.applyProgress]: ApplyProgressEvent;
}

export type IpcChannel = keyof IpcContract;
export type IpcRequest<Channel extends IpcChannel> = IpcContract[Channel]['request'];
export type IpcResponse<Channel extends IpcChannel> = IpcContract[Channel]['response'];
export type IpcEventChannel = keyof IpcEventContract;

export function createPingResult(now: Date = new Date()): PingResult {
  return {
    ok: true,
    message: 'pong',
    at: now.toISOString(),
  };
}
