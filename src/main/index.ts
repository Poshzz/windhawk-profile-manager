import { readFile, stat, writeFile } from 'node:fs/promises';
import { release } from 'node:os';
import { join } from 'node:path';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  screen,
  session,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type WebContents,
  type WebFrameMain,
} from 'electron';
import {
  APP_ID,
  HELPER_EXIT_CODES,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  PRODUCT_NAME,
  TITLEBAR_HEIGHT,
} from '@shared/constants';
import {
  IPC,
  createPingResult,
  type AppConfig,
  type AppVersions,
  type BackgroundMaterial,
  type ProfileInput,
  type ResolvedTheme,
  type ThemeSource,
  type TitlebarMode,
} from '@shared/ipc';
import { StaleProfileError, ValidationError } from '@shared/errors';
import type { SettingsPatch } from '@shared/domain';
import { logger } from './logger';
import { isAllowedExternalUrl, isTrustedRendererFrame, sameOrigin } from './ipc-trust';
import { parseHelperArguments } from './helper/arguments';
import { runHelperMode, runHelperServiceStart } from './helper/run-helper';
import { createWindowsHomeService } from './home-service';
import { createFakeHomeService, type FakeApplyMode, type FakeHomeMode } from './fake-home-service';
import type { HomeService } from '@core/home/home-service';
import {
  resolveAppLocale,
  resolveTitlebarMode,
  supportsMica,
  titlebarOptions,
} from './window-options';
import {
  fitWindowBounds,
  loadWindowState,
  saveWindowState,
  type WindowState,
} from './window-state';

const MAX_PROFILE_IMPORT_BYTES = 1024 * 1024;

let mainWindow: BrowserWindow | null = null;
let titlebarMode: TitlebarMode = 'overlay';
let micaEnabled = false;
let backgroundMaterial: BackgroundMaterial = 'opaque';
let windowStatePath: string | null = null;
let savedWindowState: WindowState | null = null;

function themeColors(): { background: string; symbol: string } {
  return nativeTheme.shouldUseDarkColors
    ? { background: '#0b0b0f', symbol: '#e8e8ed' }
    : { background: '#eef0f5', symbol: '#171b24' };
}

function currentSystemTheme(): ResolvedTheme {
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}

function sendSystemTheme(): void {
  if (mainWindow === null || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(IPC.themeSystemChanged, currentSystemTheme());
}

function updateTitlebarTheme(): void {
  if (mainWindow === null || mainWindow.isDestroyed()) return;
  const colors = themeColors();
  if (titlebarMode === 'overlay') {
    mainWindow.setTitleBarOverlay({
      color: '#00000000',
      symbolColor: colors.symbol,
      height: TITLEBAR_HEIGHT,
    });
  }
  if (!micaEnabled) {
    mainWindow.setBackgroundColor(colors.background);
  }
  sendSystemTheme();
}

function isThemeSource(value: unknown): value is ThemeSource {
  return value === 'system' || value === 'light' || value === 'dark';
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError('Invalid request body.');
  }
  return value as Record<string, unknown>;
}

function resolveFakeHomeMode(value: string): FakeHomeMode {
  switch (value) {
    case 'missing':
    case 'readonly':
    case 'stopped':
    case 'drift':
      return value;
    default:
      return 'ready';
  }
}

function resolveFakeApplyMode(value: string | undefined): FakeApplyMode {
  switch (value) {
    case 'noop':
    case 'partial':
    case 'warning':
    case 'rollback':
    case 'rollback-failed':
    case 'cancel':
      return value;
    default:
      return 'success';
  }
}

function rememberWindowState(): void {
  if (mainWindow === null || mainWindow.isDestroyed() || windowStatePath === null) return;
  const bounds = mainWindow.getNormalBounds();
  saveWindowState(windowStatePath, {
    ...bounds,
    maximized: mainWindow.isMaximized(),
  });
}

function isTrusted(sender: WebContents): boolean {
  return mainWindow !== null && sender === mainWindow.webContents;
}

function assertTrusted(event: {
  readonly sender: WebContents;
  readonly senderFrame: WebFrameMain | null;
}): void {
  if (!isTrusted(event.sender) || mainWindow === null) {
    logger.warn('Rejected IPC from an untrusted sender');
    throw new Error('Untrusted IPC sender');
  }

  const frame = event.senderFrame;
  if (frame === null || frame !== mainWindow.webContents.mainFrame) {
    logger.warn('Rejected IPC from a non-main frame');
    throw new Error('Untrusted IPC frame');
  }

  const currentUrl = mainWindow.webContents.getURL();
  const developmentUrl = app.isPackaged ? undefined : process.env['ELECTRON_RENDERER_URL'];
  if (!isTrustedRendererFrame(frame.url, currentUrl, app.isPackaged, developmentUrl)) {
    logger.warn('Rejected IPC from an untrusted renderer origin');
    throw new Error('Untrusted IPC origin');
  }
}

function registerContentSecurityPolicy(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const development = !app.isPackaged && Boolean(process.env['ELECTRON_RENDERER_URL']);
    const scriptSrc = development ? "script-src 'self' 'unsafe-inline'" : "script-src 'self'";
    const connectSrc = development
      ? "connect-src 'self' http://localhost:* ws://localhost:*"
      : "connect-src 'self'";
    const policy = [
      "default-src 'self'",
      scriptSrc,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self' data:",
      connectSrc,
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
      "worker-src 'self' blob:",
    ].join('; ');

    callback({
      responseHeaders: {
        ...(details.responseHeaders ?? {}),
        'Content-Security-Policy': [policy],
      },
    });
  });

  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler(() => false);
}

interface ProfileIpcOptions {
  readonly fakeIoDirectory?: string;
}

function registerIpc(homeService: HomeService, options: ProfileIpcOptions = {}): void {
  ipcMain.handle(IPC.ping, (event: IpcMainInvokeEvent) => {
    assertTrusted(event);
    return createPingResult();
  });

  ipcMain.handle(IPC.versions, (event: IpcMainInvokeEvent): AppVersions => {
    assertTrusted(event);
    return {
      app: app.getVersion(),
      electron: process.versions.electron ?? 'unknown',
      chrome: process.versions.chrome ?? 'unknown',
      node: process.versions.node,
    };
  });

  ipcMain.handle(IPC.config, (event: IpcMainInvokeEvent): AppConfig => {
    assertTrusted(event);
    return {
      titlebarMode,
      systemLocale: resolveAppLocale(process.env['WPM_LOCALE'] ?? app.getLocale()),
      systemTheme: currentSystemTheme(),
      backgroundMaterial,
    };
  });

  ipcMain.handle(IPC.environmentProbe, (event: IpcMainInvokeEvent) => {
    assertTrusted(event);
    return homeService.probeEnvironment();
  });

  ipcMain.handle(IPC.profilesList, (event: IpcMainInvokeEvent) => {
    assertTrusted(event);
    return homeService.listProfiles();
  });

  ipcMain.handle(
    IPC.profilesGet,
    (event: IpcMainInvokeEvent, request: { id?: unknown } | undefined) => {
      assertTrusted(event);
      if (typeof request?.id !== 'string') throw new ValidationError('Invalid profile ID.');
      return homeService.getProfile(request.id);
    },
  );

  ipcMain.handle(
    IPC.profilesCreate,
    (event: IpcMainInvokeEvent, request: { input?: unknown } | undefined) => {
      assertTrusted(event);
      return homeService.createProfile(asRecord(request?.input) as unknown as ProfileInput);
    },
  );

  ipcMain.handle(
    IPC.profilesUpdate,
    (
      event: IpcMainInvokeEvent,
      request: { id?: unknown; expectedRevision?: unknown; input?: unknown } | undefined,
    ) => {
      assertTrusted(event);
      if (typeof request?.id !== 'string' || typeof request.expectedRevision !== 'number') {
        throw new ValidationError('Invalid profile update request.');
      }
      return homeService.updateProfile(
        request.id,
        request.expectedRevision,
        asRecord(request.input) as unknown as ProfileInput,
      );
    },
  );

  ipcMain.handle(
    IPC.profilesDelete,
    async (
      event: IpcMainInvokeEvent,
      request: { id?: unknown; expectedRevision?: unknown } | undefined,
    ) => {
      assertTrusted(event);
      if (typeof request?.id !== 'string' || typeof request.expectedRevision !== 'number') {
        throw new ValidationError('Invalid profile delete request.');
      }
      const profile = await homeService.getProfile(request.id);
      if (profile.revision !== request.expectedRevision) {
        throw new StaleProfileError(`Profile "${request.id}" changed; reload it before deleting.`);
      }
      await homeService.deleteProfile(request.id, true);
    },
  );

  ipcMain.handle(
    IPC.profilesDuplicate,
    (event: IpcMainInvokeEvent, request: { id?: unknown; name?: unknown } | undefined) => {
      assertTrusted(event);
      if (typeof request?.id !== 'string') throw new ValidationError('Invalid profile ID.');
      if (request.name !== undefined && typeof request.name !== 'string') {
        throw new ValidationError('Invalid profile name.');
      }
      return homeService.duplicateProfile(request.id, request.name);
    },
  );

  ipcMain.handle(
    IPC.profilesCapture,
    (
      event: IpcMainInvokeEvent,
      request: { name?: unknown; includeDisabled?: unknown } | undefined,
    ) => {
      assertTrusted(event);
      if (typeof request?.name !== 'string' || typeof request.includeDisabled !== 'boolean') {
        throw new ValidationError('Invalid capture request.');
      }
      return homeService.captureProfile({
        name: request.name,
        includeDisabled: request.includeDisabled,
      });
    },
  );

  ipcMain.handle(IPC.profilesImport, async (event: IpcMainInvokeEvent) => {
    assertTrusted(event);
    let filePath: string;
    if (options.fakeIoDirectory !== undefined) {
      filePath = join(options.fakeIoDirectory, 'import-profile.json');
    } else {
      const dialogOptions = {
        title: 'Import Windhawk profile',
        filters: [{ name: 'Profile JSON', extensions: ['json'] }],
        properties: ['openFile' as const],
      };
      const result =
        mainWindow === null
          ? await dialog.showOpenDialog(dialogOptions)
          : await dialog.showOpenDialog(mainWindow, dialogOptions);
      if (result.canceled || result.filePaths[0] === undefined) return null;
      filePath = result.filePaths[0];
    }
    const info = await stat(filePath);
    if (info.size > MAX_PROFILE_IMPORT_BYTES) {
      throw new ValidationError('The profile file is too large.');
    }
    return homeService.importProfileJson(await readFile(filePath, 'utf8'));
  });

  ipcMain.handle(
    IPC.profilesExport,
    async (event: IpcMainInvokeEvent, request: { id?: unknown } | undefined) => {
      assertTrusted(event);
      if (typeof request?.id !== 'string') throw new ValidationError('Invalid profile ID.');
      const json = await homeService.exportProfileJson(request.id);
      let filePath: string;
      if (options.fakeIoDirectory !== undefined) {
        filePath = join(options.fakeIoDirectory, `${request.id}-export.json`);
      } else {
        const result =
          mainWindow === null
            ? await dialog.showSaveDialog({
                title: 'Export Windhawk profile',
                defaultPath: join(app.getPath('documents'), `${request.id}.json`),
                filters: [{ name: 'Profile JSON', extensions: ['json'] }],
              })
            : await dialog.showSaveDialog(mainWindow, {
                title: 'Export Windhawk profile',
                defaultPath: join(app.getPath('documents'), `${request.id}.json`),
                filters: [{ name: 'Profile JSON', extensions: ['json'] }],
              });
        if (result.canceled || result.filePath === undefined) return null;
        filePath = result.filePath;
      }
      await writeFile(filePath, json, 'utf8');
      return filePath;
    },
  );

  ipcMain.handle(IPC.themePacksList, (event: IpcMainInvokeEvent) => {
    assertTrusted(event);
    return homeService.listThemePacks();
  });

  ipcMain.handle(
    IPC.themePacksGet,
    (event: IpcMainInvokeEvent, request: { id?: unknown } | undefined) => {
      assertTrusted(event);
      if (typeof request?.id !== 'string' || request.id.length === 0) {
        throw new Error('Invalid theme pack ID');
      }
      return homeService.getThemePack(request.id);
    },
  );

  ipcMain.handle(IPC.stateGet, (event: IpcMainInvokeEvent) => {
    assertTrusted(event);
    return homeService.getState();
  });

  ipcMain.handle(
    IPC.settingsUpdate,
    (event: IpcMainInvokeEvent, request: { patch?: unknown } | undefined) => {
      assertTrusted(event);
      return homeService.updateSettings(asRecord(request?.patch) as SettingsPatch);
    },
  );

  ipcMain.handle(IPC.firstRunComplete, (event: IpcMainInvokeEvent) => {
    assertTrusted(event);
    return homeService.completeFirstRun();
  });

  ipcMain.handle(IPC.recoveryGet, (event: IpcMainInvokeEvent) => {
    assertTrusted(event);
    return homeService.getRecovery();
  });

  ipcMain.handle(
    IPC.recoveryResolve,
    (event: IpcMainInvokeEvent, request: { action?: unknown } | undefined) => {
      assertTrusted(event);
      if (
        request?.action !== 'restore' &&
        request?.action !== 'dismiss' &&
        request?.action !== 'finish'
      ) {
        throw new ValidationError('Invalid recovery action.');
      }
      return homeService.resolveRecovery(request.action);
    },
  );

  ipcMain.handle(IPC.diagnosticsGet, (event: IpcMainInvokeEvent) => {
    assertTrusted(event);
    return homeService.getDiagnostics();
  });

  ipcMain.handle(IPC.logsOpen, (event: IpcMainInvokeEvent) => {
    assertTrusted(event);
    return homeService.openLogsFolder();
  });

  ipcMain.handle(IPC.dataOpen, (event: IpcMainInvokeEvent) => {
    assertTrusted(event);
    return homeService.openDataFolder();
  });

  ipcMain.handle(IPC.snapshotsList, (event: IpcMainInvokeEvent) => {
    assertTrusted(event);
    return homeService.listSnapshots();
  });

  ipcMain.handle(IPC.snapshotsSummaries, (event: IpcMainInvokeEvent) => {
    assertTrusted(event);
    return homeService.listSnapshotSummaries();
  });

  ipcMain.handle(
    IPC.snapshotsGet,
    (event: IpcMainInvokeEvent, request: { id?: unknown } | undefined) => {
      assertTrusted(event);
      if (typeof request?.id !== 'string') throw new ValidationError('Invalid snapshot ID.');
      return homeService.getSnapshot(request.id);
    },
  );

  ipcMain.handle(
    IPC.snapshotsDelete,
    async (event: IpcMainInvokeEvent, request: { id?: unknown } | undefined) => {
      assertTrusted(event);
      if (typeof request?.id !== 'string') throw new ValidationError('Invalid snapshot ID.');
      await homeService.deleteSnapshot(request.id, true);
    },
  );

  ipcMain.handle(IPC.snapshotsImport, async (event: IpcMainInvokeEvent) => {
    assertTrusted(event);
    let filePath: string;
    if (options.fakeIoDirectory !== undefined) {
      filePath = join(options.fakeIoDirectory, 'import-snapshot.reg');
    } else {
      const dialogOptions = {
        title: 'Import Windhawk snapshot',
        filters: [{ name: 'Registry snapshot', extensions: ['reg'] }],
        properties: ['openFile' as const],
      };
      const result =
        mainWindow === null
          ? await dialog.showOpenDialog(dialogOptions)
          : await dialog.showOpenDialog(mainWindow, dialogOptions);
      if (result.canceled || result.filePaths[0] === undefined) return null;
      filePath = result.filePaths[0];
    }
    return homeService.importSnapshot(filePath);
  });

  ipcMain.handle(
    IPC.snapshotsExport,
    async (event: IpcMainInvokeEvent, request: { id?: unknown } | undefined) => {
      assertTrusted(event);
      if (typeof request?.id !== 'string') throw new ValidationError('Invalid snapshot ID.');
      const exported = await homeService.exportSnapshot(request.id);
      let filePath: string;
      if (options.fakeIoDirectory !== undefined) {
        filePath = join(options.fakeIoDirectory, `${request.id}-export.reg`);
      } else {
        const dialogOptions = {
          title: 'Export Windhawk snapshot',
          defaultPath: join(app.getPath('documents'), exported.filename),
          filters: [{ name: 'Registry snapshot', extensions: ['reg'] }],
        };
        const result =
          mainWindow === null
            ? await dialog.showSaveDialog(dialogOptions)
            : await dialog.showSaveDialog(mainWindow, dialogOptions);
        if (result.canceled || result.filePath === undefined) return null;
        filePath = result.filePath;
      }
      await writeFile(filePath, exported.registryBytes);
      const metadataPath = filePath.toLowerCase().endsWith('.reg')
        ? `${filePath.slice(0, -4)}.json`
        : `${filePath}.json`;
      await writeFile(metadataPath, exported.metadataJson, 'utf8');
      return filePath;
    },
  );

  ipcMain.handle(
    IPC.planRestore,
    (event: IpcMainInvokeEvent, request: { snapshotId?: unknown } | undefined) => {
      assertTrusted(event);
      if (typeof request?.snapshotId !== 'string') {
        throw new ValidationError('Invalid snapshot ID.');
      }
      return homeService.createRestorePlan(request.snapshotId);
    },
  );

  ipcMain.handle(
    IPC.runRestore,
    (event: IpcMainInvokeEvent, request: Record<string, unknown> | undefined) => {
      assertTrusted(event);
      const sourceSnapshotId = request?.['sourceSnapshotId'];
      const expectedPlanHash = request?.['expectedPlanHash'];
      const runId = request?.['runId'];
      const snapshotId = request?.['snapshotId'];
      const confirmTargeting = request?.['confirmTargeting'];
      if (
        typeof sourceSnapshotId !== 'string' ||
        typeof expectedPlanHash !== 'string' ||
        typeof runId !== 'string' ||
        typeof snapshotId !== 'string' ||
        (confirmTargeting !== undefined && typeof confirmTargeting !== 'boolean')
      ) {
        throw new ValidationError('Invalid restore request.');
      }
      return homeService.runRestore(
        {
          sourceSnapshotId,
          expectedPlanHash,
          runId,
          snapshotId,
          ...(confirmTargeting === true ? { confirmTargeting: true } : {}),
        },
        (state) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send(IPC.applyProgress, { planHash: expectedPlanHash, state });
          }
        },
      );
    },
  );

  ipcMain.handle(
    IPC.driftGet,
    (event: IpcMainInvokeEvent, request: { profileId?: unknown } | undefined) => {
      assertTrusted(event);
      if (typeof request?.profileId !== 'string' || request.profileId.length === 0) {
        throw new Error('Invalid profile ID');
      }
      return homeService.getDrift(request.profileId);
    },
  );

  ipcMain.handle(IPC.serviceStart, (event: IpcMainInvokeEvent) => {
    assertTrusted(event);
    return homeService.startService();
  });

  ipcMain.handle(
    IPC.snapshotsCapture,
    (event: IpcMainInvokeEvent, request: { profileId?: unknown } | undefined) => {
      assertTrusted(event);
      if (request?.profileId !== null && typeof request?.profileId !== 'string') {
        throw new Error('Invalid profile ID');
      }
      return homeService.captureSnapshot(request.profileId);
    },
  );

  ipcMain.handle(
    IPC.planApply,
    (event: IpcMainInvokeEvent, request: Record<string, unknown> | undefined) => {
      assertTrusted(event);
      const profileId = request?.['profileId'];
      if (typeof profileId !== 'string') throw new Error('Invalid profile ID');
      const explorerRestart = request?.['explorerRestart'];
      const confirmDeleteAllSettings = request?.['confirmDeleteAllSettings'];
      if (
        explorerRestart !== undefined &&
        explorerRestart !== 'ask' &&
        explorerRestart !== 'always' &&
        explorerRestart !== 'never'
      ) {
        throw new Error('Invalid Explorer preference');
      }
      if (confirmDeleteAllSettings !== undefined && typeof confirmDeleteAllSettings !== 'boolean') {
        throw new Error('Invalid delete-all confirmation');
      }
      return homeService.createApplyPlan(profileId, {
        ...(explorerRestart === undefined ? {} : { explorerRestart }),
        ...(confirmDeleteAllSettings === undefined ? {} : { confirmDeleteAllSettings }),
      });
    },
  );

  ipcMain.handle(
    IPC.runApply,
    (event: IpcMainInvokeEvent, request: Record<string, unknown> | undefined) => {
      assertTrusted(event);
      const profileId = request?.['profileId'];
      const expectedRevision = request?.['expectedRevision'];
      const expectedPlanHash = request?.['expectedPlanHash'];
      const runId = request?.['runId'];
      const snapshotId = request?.['snapshotId'];
      if (
        typeof profileId !== 'string' ||
        typeof expectedRevision !== 'number' ||
        typeof expectedPlanHash !== 'string' ||
        typeof runId !== 'string' ||
        typeof snapshotId !== 'string'
      ) {
        throw new Error('Invalid apply request');
      }
      const explorerRestart = request?.['explorerRestart'];
      const confirmDeleteAllSettings = request?.['confirmDeleteAllSettings'];
      if (
        explorerRestart !== undefined &&
        explorerRestart !== 'ask' &&
        explorerRestart !== 'always' &&
        explorerRestart !== 'never'
      ) {
        throw new Error('Invalid Explorer preference');
      }
      if (confirmDeleteAllSettings !== undefined && typeof confirmDeleteAllSettings !== 'boolean') {
        throw new Error('Invalid delete-all confirmation');
      }
      return homeService.runApply(profileId, {
        expectedRevision,
        expectedPlanHash,
        runId,
        snapshotId,
        ...(explorerRestart === undefined ? {} : { explorerRestart }),
        ...(confirmDeleteAllSettings === undefined ? {} : { confirmDeleteAllSettings }),
        onProgress: (state) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send(IPC.applyProgress, { planHash: expectedPlanHash, state });
          }
        },
      });
    },
  );

  ipcMain.handle(
    IPC.openExternal,
    async (event: IpcMainInvokeEvent, request: { url?: unknown } | undefined) => {
      assertTrusted(event);
      if (typeof request?.url !== 'string' || !isAllowedExternalUrl(request.url)) {
        throw new Error('External URL is not allowed');
      }
      await shell.openExternal(request.url);
    },
  );

  ipcMain.handle(
    IPC.themeSetSource,
    (event: IpcMainInvokeEvent, request: { theme?: unknown } | undefined): void => {
      assertTrusted(event);
      if (!isThemeSource(request?.theme)) {
        throw new Error('Invalid theme source');
      }
      nativeTheme.themeSource = request.theme;
      updateTitlebarTheme();
    },
  );

  ipcMain.on(IPC.windowMinimize, (event: IpcMainEvent) => {
    assertTrusted(event);
    mainWindow?.minimize();
  });

  ipcMain.on(IPC.windowToggleMaximize, (event: IpcMainEvent) => {
    assertTrusted(event);
    if (mainWindow === null) return;
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  });

  ipcMain.on(IPC.windowClose, (event: IpcMainEvent) => {
    assertTrusted(event);
    mainWindow?.close();
  });
}

function sendMaximizedState(isMaximized: boolean): void {
  if (mainWindow !== null && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC.windowMaximizedChanged, isMaximized);
  }
}

function createWindow(): void {
  titlebarMode = resolveTitlebarMode(process.env['WPM_TITLEBAR']);
  const mica = supportsMica(release());
  micaEnabled = mica;
  backgroundMaterial = mica ? 'mica' : 'opaque';
  const colors = themeColors();

  windowStatePath = join(app.getPath('userData'), 'window-state.json');
  savedWindowState = loadWindowState(windowStatePath);
  const primaryDisplay = screen.getPrimaryDisplay();
  const displays = screen.getAllDisplays().map((display) => ({
    ...display.workArea,
    primary: display.id === primaryDisplay.id,
  }));
  const bounds = fitWindowBounds(savedWindowState, displays, MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT);

  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: mica ? '#00000000' : colors.background,
    ...titlebarOptions(titlebarMode, colors.symbol),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });

  if (mica) {
    try {
      mainWindow.setBackgroundMaterial('mica');
    } catch (error) {
      micaEnabled = false;
      backgroundMaterial = 'opaque';
      mainWindow.setBackgroundColor(colors.background);
      logger.warn('Mica is unavailable; using the opaque fallback', error);
    }
  }

  mainWindow.setMenuBarVisibility(false);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const developmentUrl = app.isPackaged ? undefined : process.env['ELECTRON_RENDERER_URL'];
    if (developmentUrl !== undefined && sameOrigin(url, developmentUrl)) {
      return;
    }
    event.preventDefault();
  });

  mainWindow.on('maximize', () => sendMaximizedState(true));
  mainWindow.on('unmaximize', () => sendMaximizedState(false));
  mainWindow.on('enter-full-screen', () => sendMaximizedState(true));
  mainWindow.on('leave-full-screen', () => sendMaximizedState(mainWindow?.isMaximized() ?? false));
  mainWindow.on('ready-to-show', () => {
    if (savedWindowState?.maximized === true) mainWindow?.maximize();
    mainWindow?.show();
  });
  mainWindow.on('close', rememberWindowState);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.on('did-finish-load', () => {
    sendMaximizedState(mainWindow?.isMaximized() ?? false);
    sendSystemTheme();
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    logger.error('Renderer process exited', details);
  });

  const developmentUrl = app.isPackaged ? undefined : process.env['ELECTRON_RENDERER_URL'];
  if (app.isPackaged && process.env['ELECTRON_RENDERER_URL'] !== undefined) {
    logger.warn('Ignored ELECTRON_RENDERER_URL in a packaged build');
  }
  if (developmentUrl !== undefined) {
    void mainWindow.loadURL(developmentUrl);
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

function startHelper(helperArgv: readonly string[]): void {
  let arguments_: ReturnType<typeof parseHelperArguments>;
  try {
    arguments_ = parseHelperArguments(helperArgv);
  } catch {
    void app
      .whenReady()
      .then(() => app.exit(HELPER_EXIT_CODES.validationFailure))
      .catch(() => app.exit(HELPER_EXIT_CODES.validationFailure));
    return;
  }

  if (arguments_ === null) {
    void app
      .whenReady()
      .then(() => app.exit(HELPER_EXIT_CODES.validationFailure))
      .catch(() => app.exit(HELPER_EXIT_CODES.validationFailure));
    return;
  }

  void app
    .whenReady()
    .then(async () => {
      let exitCode: number;
      try {
        exitCode = arguments_.serviceStart
          ? await runHelperServiceStart()
          : await runHelperMode(arguments_, { appVersion: app.getVersion() });
      } catch {
        exitCode = HELPER_EXIT_CODES.applyFailure;
      }
      app.exit(exitCode);
    })
    .catch(() => app.exit(HELPER_EXIT_CODES.applyFailure));
}

function startGui(): void {
  if (app.isPackaged) {
    for (const name of [
      'no-sandbox',
      'disable-web-security',
      'inspect',
      'inspect-brk',
      'js-flags',
      'remote-debugging-pipe',
    ]) {
      if (app.commandLine.hasSwitch(name)) {
        logger.error(`Refusing to start with the unsafe Chromium switch --${name}.`);
        app.exit(1);
        return;
      }
    }
  }

  const hasSingleInstanceLock = app.requestSingleInstanceLock();
  if (!hasSingleInstanceLock) {
    app.quit();
    return;
  }

  app.on('second-instance', () => {
    if (mainWindow === null) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  void app
    .whenReady()
    .then(async () => {
      app.setAppUserModelId(APP_ID);
      Menu.setApplicationMenu(null);
      nativeTheme.on('updated', updateTitlebarTheme);
      registerContentSecurityPolicy();
      const resourcesDirectory = join(app.getAppPath(), 'resources');
      const fakeMode = app.isPackaged ? undefined : process.env['WPM_FAKE_ENV'];
      const homeService =
        fakeMode === undefined || fakeMode.length === 0
          ? await createWindowsHomeService({
              resourcesDirectory,
              appVersion: app.getVersion(),
            })
          : await createFakeHomeService(
              resourcesDirectory,
              resolveFakeHomeMode(fakeMode),
              resolveFakeApplyMode(process.env['WPM_FAKE_APPLY']),
              process.env['WPM_FAKE_FIRST_RUN'] === '1',
              process.env['WPM_FAKE_RECOVERY'] === '1',
            );
      const fakeIoDirectory = app.isPackaged ? undefined : process.env['WPM_FAKE_IO_DIR'];
      registerIpc(
        homeService,
        fakeIoDirectory === undefined || fakeIoDirectory.length === 0 ? {} : { fakeIoDirectory },
      );
      logger.info('Starting Windhawk Profile Manager', {
        version: app.getVersion(),
        electron: process.versions.electron,
        windowsBuild: release(),
      });
      createWindow();
    })
    .catch((error: unknown) => {
      logger.error('The application could not start.', error);
      app.quit();
    });
}

app.setName(PRODUCT_NAME);

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', reason);
});
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', error);
});

const helperIndex = process.argv.indexOf('--helper');
if (helperIndex >= 0) {
  // Helper mode must not take the singleton lock or create a BrowserWindow.
  startHelper(process.argv.slice(helperIndex));
} else {
  startGui();
}
