import type {
  AppState,
  ApplyPlan,
  ApplyResult,
  Drift,
  Environment,
  Profile,
  RestorePlan,
  SettingsPatch,
  SnapshotMetadata,
  ThemePack,
} from '@shared/domain';
import type {
  ApplyProgressState,
  CaptureProfileInput,
  ProfileInput,
  Diagnostics,
  RecoveryInfo,
  RecoveryResolution,
  RunRestoreOptions,
  SnapshotDetail,
  SnapshotSummary,
} from '@shared/ipc';

export interface SnapshotExportData {
  readonly filename: string;
  readonly metadataJson: string;
  readonly registryBytes: Uint8Array;
}

export interface PlanApplyOptions {
  readonly explorerRestart?: Profile['actions']['restartExplorer'];
  readonly confirmDeleteAllSettings?: boolean;
}

export interface RunApplyOptions extends PlanApplyOptions {
  readonly expectedRevision: number;
  readonly expectedPlanHash: string;
  readonly runId: string;
  readonly snapshotId: string;
  readonly onProgress?: (state: ApplyProgressState) => void;
}

/**
 * The main-process data surface used by the Home and apply dialogs. Each read
 * method is independent so the renderer can render and retry sections
 * separately.
 */
export interface HomeService {
  probeEnvironment(): Promise<Environment>;
  listProfiles(): Promise<Profile[]>;
  getProfile(id: string): Promise<Profile>;
  createProfile(input: ProfileInput): Promise<Profile>;
  updateProfile(id: string, expectedRevision: number, input: ProfileInput): Promise<Profile>;
  deleteProfile(id: string, confirm: boolean): Promise<void>;
  duplicateProfile(id: string, name?: string): Promise<Profile>;
  captureProfile(input: CaptureProfileInput): Promise<Profile>;
  importProfileJson(json: string): Promise<Profile>;
  exportProfileJson(id: string): Promise<string>;
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
  deleteSnapshot(id: string, confirm: boolean): Promise<void>;
  importSnapshot(path: string): Promise<SnapshotSummary>;
  exportSnapshot(id: string): Promise<SnapshotExportData>;
  createRestorePlan(snapshotId: string): Promise<RestorePlan>;
  runRestore(
    options: RunRestoreOptions,
    onProgress?: (state: ApplyProgressState) => void,
  ): Promise<ApplyResult>;
  getDrift(profileId: string): Promise<Drift>;
  listThemePacks(): Promise<ThemePack[]>;
  getThemePack(id: string): Promise<ThemePack>;
  startService(): Promise<Environment>;
  captureSnapshot(profileId: string | null): Promise<SnapshotMetadata>;
  createApplyPlan(profileId: string, options?: PlanApplyOptions): Promise<ApplyPlan>;
  runApply(profileId: string, options: RunApplyOptions): Promise<ApplyResult>;
}
