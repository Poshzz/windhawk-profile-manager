import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  IPC,
  type AppConfig,
  type AppVersions,
  type ApplyPlanOptions,
  type ApplyProgressEvent,
  type CaptureProfileInput,
  type Diagnostics,
  type PingResult,
  type ProfileInput,
  type RecoveryInfo,
  type RecoveryResolution,
  type ResolvedTheme,
  type RunApplyOptions,
  type RunRestoreOptions,
  type SnapshotDetail,
  type SnapshotSummary,
  type ThemeSource,
  type WpmApi,
} from '@shared/ipc';
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

const api: WpmApi = {
  ping: async (): Promise<PingResult> => {
    const result = (await ipcRenderer.invoke(IPC.ping)) as PingResult;
    return {
      ...result,
      rendererSandboxed:
        (process as NodeJS.Process & { readonly sandboxed?: boolean }).sandboxed === true,
    };
  },
  getVersions: () => ipcRenderer.invoke(IPC.versions) as Promise<AppVersions>,
  getConfig: () => ipcRenderer.invoke(IPC.config) as Promise<AppConfig>,
  setThemeSource: (theme: ThemeSource) =>
    ipcRenderer.invoke(IPC.themeSetSource, { theme }) as Promise<void>,
  getEnvironment: () => ipcRenderer.invoke(IPC.environmentProbe) as Promise<Environment>,
  listProfiles: () => ipcRenderer.invoke(IPC.profilesList) as Promise<Profile[]>,
  getProfile: (id: string) => ipcRenderer.invoke(IPC.profilesGet, { id }) as Promise<Profile>,
  createProfile: (input: ProfileInput) =>
    ipcRenderer.invoke(IPC.profilesCreate, { input }) as Promise<Profile>,
  updateProfile: (id: string, expectedRevision: number, input: ProfileInput) =>
    ipcRenderer.invoke(IPC.profilesUpdate, {
      id,
      expectedRevision,
      input,
    }) as Promise<Profile>,
  deleteProfile: (id: string, expectedRevision: number) =>
    ipcRenderer.invoke(IPC.profilesDelete, { id, expectedRevision }) as Promise<void>,
  duplicateProfile: (id: string, name?: string) =>
    ipcRenderer.invoke(IPC.profilesDuplicate, {
      id,
      ...(name === undefined ? {} : { name }),
    }) as Promise<Profile>,
  captureProfile: (input: CaptureProfileInput) =>
    ipcRenderer.invoke(IPC.profilesCapture, input) as Promise<Profile>,
  importProfile: () => ipcRenderer.invoke(IPC.profilesImport) as Promise<Profile | null>,
  exportProfile: (id: string) =>
    ipcRenderer.invoke(IPC.profilesExport, { id }) as Promise<string | null>,
  getState: () => ipcRenderer.invoke(IPC.stateGet) as Promise<AppState>,
  updateSettings: (patch: SettingsPatch) =>
    ipcRenderer.invoke(IPC.settingsUpdate, { patch }) as Promise<AppState>,
  completeFirstRun: () => ipcRenderer.invoke(IPC.firstRunComplete) as Promise<AppState>,
  getRecovery: () => ipcRenderer.invoke(IPC.recoveryGet) as Promise<RecoveryInfo | null>,
  resolveRecovery: (action: 'restore' | 'dismiss' | 'finish') =>
    ipcRenderer.invoke(IPC.recoveryResolve, { action }) as Promise<RecoveryResolution>,
  getDiagnostics: () => ipcRenderer.invoke(IPC.diagnosticsGet) as Promise<Diagnostics>,
  openLogsFolder: () => ipcRenderer.invoke(IPC.logsOpen) as Promise<void>,
  openDataFolder: () => ipcRenderer.invoke(IPC.dataOpen) as Promise<void>,
  listSnapshots: () => ipcRenderer.invoke(IPC.snapshotsList) as Promise<SnapshotMetadata[]>,
  listSnapshotSummaries: () =>
    ipcRenderer.invoke(IPC.snapshotsSummaries) as Promise<SnapshotSummary[]>,
  getSnapshot: (id: string) =>
    ipcRenderer.invoke(IPC.snapshotsGet, { id }) as Promise<SnapshotDetail>,
  deleteSnapshot: (id: string) => ipcRenderer.invoke(IPC.snapshotsDelete, { id }) as Promise<void>,
  importSnapshot: () => ipcRenderer.invoke(IPC.snapshotsImport) as Promise<SnapshotSummary | null>,
  exportSnapshot: (id: string) =>
    ipcRenderer.invoke(IPC.snapshotsExport, { id }) as Promise<string | null>,
  planRestore: (snapshotId: string) =>
    ipcRenderer.invoke(IPC.planRestore, { snapshotId }) as Promise<RestorePlan>,
  runRestore: (options: RunRestoreOptions) =>
    ipcRenderer.invoke(IPC.runRestore, options) as Promise<ApplyResult>,
  getDrift: (profileId: string) =>
    ipcRenderer.invoke(IPC.driftGet, { profileId }) as Promise<Drift>,
  listThemePacks: () => ipcRenderer.invoke(IPC.themePacksList) as Promise<ThemePack[]>,
  getThemePack: (id: string) => ipcRenderer.invoke(IPC.themePacksGet, { id }) as Promise<ThemePack>,
  startService: () => ipcRenderer.invoke(IPC.serviceStart) as Promise<Environment>,
  captureSnapshot: (profileId: string | null) =>
    ipcRenderer.invoke(IPC.snapshotsCapture, { profileId }) as Promise<SnapshotMetadata>,
  planApply: (profileId: string, options: ApplyPlanOptions = {}) =>
    ipcRenderer.invoke(IPC.planApply, { profileId, ...options }) as Promise<ApplyPlan>,
  runApply: (profileId: string, options: RunApplyOptions) =>
    ipcRenderer.invoke(IPC.runApply, { profileId, ...options }) as Promise<ApplyResult>,
  onApplyProgress: (listener: (progress: ApplyProgressEvent) => void) => {
    const handler = (_event: IpcRendererEvent, progress: ApplyProgressEvent): void => {
      listener(progress);
    };
    ipcRenderer.on(IPC.applyProgress, handler);
    return () => {
      ipcRenderer.removeListener(IPC.applyProgress, handler);
    };
  },
  openExternal: (url: string) => ipcRenderer.invoke(IPC.openExternal, { url }) as Promise<void>,
  onSystemThemeChange: (listener: (theme: ResolvedTheme) => void) => {
    const handler = (_event: IpcRendererEvent, theme: ResolvedTheme): void => {
      listener(theme);
    };
    ipcRenderer.on(IPC.themeSystemChanged, handler);
    return () => {
      ipcRenderer.removeListener(IPC.themeSystemChanged, handler);
    };
  },
  windowControls: {
    minimize: () => {
      ipcRenderer.send(IPC.windowMinimize);
    },
    toggleMaximize: () => {
      ipcRenderer.send(IPC.windowToggleMaximize);
    },
    close: () => {
      ipcRenderer.send(IPC.windowClose);
    },
    onMaximizedChange: (listener) => {
      const handler = (_event: IpcRendererEvent, isMaximized: boolean): void => {
        listener(isMaximized);
      };
      ipcRenderer.on(IPC.windowMaximizedChanged, handler);
      return () => {
        ipcRenderer.removeListener(IPC.windowMaximizedChanged, handler);
      };
    },
  },
};

contextBridge.exposeInMainWorld('api', api);
