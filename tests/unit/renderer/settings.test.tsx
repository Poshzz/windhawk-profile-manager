// @vitest-environment jsdom
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Diagnostics, RecoveryInfo, RecoveryResolution, WpmApi } from '@shared/ipc';
import {
  parseAppState,
  parseApplyResult,
  type AppState,
  type ApplyResult,
  type Environment,
  type SettingsPatch,
} from '@shared/domain';
import { createI18n } from '../../../src/renderer/i18n';
import { FirstRun } from '../../../src/renderer/screens/FirstRun';
import { RecoveryDialog } from '../../../src/renderer/screens/RecoveryDialog';
import { Settings } from '../../../src/renderer/screens/Settings';
import { makeEnvironment } from '../planner/support';

const STATE: AppState = parseAppState({ schemaVersion: 1 });
const COMPLETED_STATE: AppState = parseAppState({ schemaVersion: 1, firstRunCompleted: true });

const WRITABLE_ENV: Environment = makeEnvironment({
  mods: [
    { modId: 'windows-11-taskbar-styler', version: '1.7.10' },
    { modId: 'translucent-windows', version: '1.8.2' },
    { modId: 'taskbar-clock-customization', version: '1.4.0' },
  ],
});

const DIAGNOSTICS: Diagnostics = {
  appVersion: '0.1.0',
  windowsBuild: '22631',
  windowsSupported: true,
  windhawkVersion: '1.7.3',
  storageMode: 'registry',
  registryRoot: 'HKLM\\SOFTWARE\\Windhawk',
  serviceState: 'running',
  modCount: 3,
  lastRun: {
    runId: 'run-2026-10-22T20-05-00-000Z',
    status: 'succeeded',
    completedAt: '2026-10-22T20:05:04.000Z',
  },
};

const RECOVERY: RecoveryInfo = {
  runId: 'run-2026-10-22T20-05-00-000Z',
  snapshotId: '2026-10-22T20-00-00-000Z',
  state: 'applying',
  kind: 'apply',
  startedAt: '2026-10-22T20:05:00.000Z',
};

const SETTINGS_EN = {
  eyebrow: 'Preferences',
  title: 'Settings',
  body: 'Language, appearance, Explorer restarts, retention, and support diagnostics.',
  refresh: 'Refresh',
  saveErrorTitle: 'Setting could not be saved',
  preferences: {
    title: 'Preferences',
    body: 'Changes apply immediately and are saved for the next launch.',
  },
  language: {
    title: 'Language',
    body: 'Follow Windows or pick Thai or English.',
    system: 'System (Windows language)',
    thai: 'Thai',
    english: 'English',
  },
  appearance: {
    title: 'Appearance',
    body: 'Use the Windows theme or force light or dark.',
    system: 'System',
    light: 'Light',
    dark: 'Dark',
  },
  explorer: {
    title: 'Restart Explorer',
    body: 'Choose whether applying may restart Explorer when a mod needs it.',
    ask: 'Ask every time',
    always: 'Always restart',
    never: 'Never restart',
  },
  retention: {
    title: 'Snapshot retention',
    body: 'How many automatic pre-apply snapshots to keep.',
    inputLabel: 'Automatic snapshots to keep',
    save: 'Save retention',
    saving: 'Saving…',
    saved: 'Snapshot retention saved.',
    current: 'Current: {{count}}',
    range: 'Choose a whole number from 5 to 50.',
    invalid: 'Enter a whole number from 5 to 50.',
    note: 'Manual and imported snapshots are never deleted automatically.',
    viewSnapshots: 'View snapshots',
  },
  stateErrorTitle: 'Settings could not be loaded',
  stateStale: 'Settings could not be refreshed; showing the last values.',
  environmentErrorTitle: 'Environment could not be read',
  environment: {
    readyTitle: 'This PC is writable',
    readyBody: 'Windhawk is installed and compatible.',
    readOnlyTitle: 'Read-only mode',
    unsupportedTitle: 'Unsupported system',
    issuesFallback: 'Registry writes are unavailable.',
    mode: {
      writable: 'Writable',
      'read-only': 'Read-only',
      unsupported: 'Unsupported',
    },
  },
  diagnostics: {
    title: 'Diagnostics',
    body: 'Support information without registry values or personal paths.',
    appVersion: 'App version',
    windows: 'Windows',
    windowsValue: 'Build {{build}}',
    supported: 'Supported',
    unsupported: 'Unsupported',
    windhawkVersion: 'Windhawk version',
    storageMode: 'Storage mode',
    registryRoot: 'Registry root',
    service: 'Service',
    modCount: 'Installed mods',
    modCountValue: '{{count}} mods',
    lastRun: 'Last run',
    lastRunValue: '{{status}} · {{at}}',
    noLastRun: 'No completed runs yet',
    stale: 'Diagnostics could not be refreshed; showing the last result.',
    storage: { registry: 'Registry', portable: 'Portable', unknown: 'Unknown' },
    serviceState: {
      running: 'Running',
      stopped: 'Stopped',
      missing: 'Missing',
      unknown: 'Unknown',
    },
    runStatus: {
      succeeded: 'Succeeded',
      'succeeded-with-warning': 'Succeeded with warnings',
      'rolled-back': 'Rolled back',
      'rollback-failed': 'Rollback failed',
      failed: 'Failed',
      canceled: 'Canceled',
      'dry-run': 'Dry run',
    },
  },
  diagnosticsErrorTitle: 'Diagnostics could not be read',
  actions: {
    title: 'Support actions',
    body: 'Logs and data stay on this PC.',
    openLogs: 'Open logs folder',
    openData: 'Open data folder',
    opening: 'Opening…',
    copyDiagnostics: 'Copy diagnostics',
    copied: 'Diagnostics copied',
    copyFailed: 'Diagnostics could not be copied.',
    openFailed: 'The folder could not be opened',
  },
  footer: 'No registry values or personal paths are included in diagnostics.',
};

const FIRST_RUN_EN = {
  eyebrow: 'First run',
  title: 'Welcome to Windhawk Profile Manager',
  body: 'This quick tour explains what changes before anything is written.',
  loading: 'Checking this PC…',
  loadErrorTitle: 'This PC could not be checked',
  partialError: 'Some system details could not be loaded.',
  introTitle: 'What this app changes',
  introLabel: 'What this app changes',
  choicesTitle: 'Where do you want to start?',
  completeError: 'First-run setup could not be saved.',
  hint: 'You can change any of this later in Settings.',
  footer: 'No network requests are made.',
  points: {
    changes: { title: 'Only Windhawk mod settings change', body: 'Enabled state and values only.' },
    snapshot: { title: 'A snapshot comes first', body: 'Every apply captures the previous state.' },
    uac: { title: 'Admin only when applying', body: 'Browsing and editing need no elevation.' },
    service: {
      title: 'The Windhawk service keeps running',
      body: 'The engine reloads on its own.',
    },
    network: { title: 'No network requests', body: 'Everything stays on this PC.' },
  },
  readOnly: {
    title: 'This PC is read-only',
    unsupportedTitle: 'This PC is not supported',
    issuesFallback: 'Registry writes are unavailable.',
    applyDisabled: 'Apply is disabled in this mode. Continue to explore, or resolve the issue.',
  },
  environment: {
    title: 'This PC',
    windows: 'Windows {{version}} (build {{build}})',
    windhawk: 'Windhawk {{version}}',
    windhawkMissing: 'Windhawk not found',
    mods: '{{count}} mods installed',
    mode: { writable: 'Ready to apply', 'read-only': 'Read-only', unsupported: 'Unsupported' },
  },
  actions: {
    continue: 'Continue to Home',
    capture: 'Capture my current setup',
    pack: 'Open Mac Blur Glass pack',
    busy: 'Saving…',
  },
  choice: {
    home: 'Start with the dashboard.',
    capture: 'Review Profiles and capture what is enabled now.',
    pack: 'Open the Mac Blur Glass checklist.',
  },
};

const RECOVERY_EN = {
  title: 'Recover an unfinished run',
  description: 'Run {{runId}} did not finish. Review it before continuing.',
  warningTitle: 'An apply was interrupted',
  warning: 'Some registry changes may already be in place; the snapshot is still available.',
  runId: 'Run',
  snapshotId: 'Pre-apply snapshot',
  runType: 'Run type',
  kind: { apply: 'Apply', restore: 'Restore' },
  state: 'Last journal state',
  startedAt: 'Started',
  restoreNote: 'Restoring applies the captured pre-apply state through the normal reconcile path.',
  dismissNote: 'Keeping the current state closes the run without changing the registry.',
  actions: {
    restore: 'Restore pre-apply snapshot',
    dismiss: 'Keep current state and close',
  },
  restoring: 'Restoring the pre-apply snapshot…',
  restoringNote: 'Do not close the app while the restore is running.',
  cannotClose: 'Restore in progress — cannot close',
  errorTitle: 'Recovery could not continue',
  result: {
    kept: 'The snapshot is kept.',
    close: 'Close',
    manualRecovery: 'Automatic rollback failed. Keep the snapshot and review the logs.',
    status: {
      succeeded: 'Restored',
      'succeeded-with-warning': 'Restored with warnings',
      'rolled-back': 'Rolled back',
      'rollback-failed': 'Rollback failed',
      failed: 'Restore failed',
      canceled: 'Canceled',
      'dry-run': 'Dry run',
    },
  },
};

function translation() {
  const i18n = createI18n('en');
  i18n.addResourceBundle(
    'en',
    'translation',
    { settings: SETTINGS_EN, firstRun: FIRST_RUN_EN, recovery: RECOVERY_EN },
    true,
    true,
  );
  return i18n;
}

function createApi(overrides: Partial<WpmApi> = {}): WpmApi {
  const api: WpmApi = {
    ping: vi.fn(),
    getVersions: vi.fn(),
    getConfig: vi.fn(),
    getEnvironment: vi.fn(async () => structuredClone(WRITABLE_ENV)),
    listProfiles: vi.fn(),
    getProfile: vi.fn(),
    createProfile: vi.fn(),
    updateProfile: vi.fn(),
    deleteProfile: vi.fn(),
    duplicateProfile: vi.fn(),
    captureProfile: vi.fn(),
    importProfile: vi.fn(),
    exportProfile: vi.fn(),
    getState: vi.fn(async () => structuredClone(STATE)),
    updateSettings: vi.fn(async (patch: SettingsPatch): Promise<AppState> => ({
      ...structuredClone(STATE),
      ...patch,
    })),
    completeFirstRun: vi.fn(async () => structuredClone(COMPLETED_STATE)),
    getRecovery: vi.fn(async () => null),
    resolveRecovery: vi.fn(async (action: 'restore' | 'dismiss'): Promise<RecoveryResolution> => ({
      action: action === 'restore' ? 'restored' : 'dismissed',
      result: null,
    })),
    getDiagnostics: vi.fn(async () => structuredClone(DIAGNOSTICS)),
    openLogsFolder: vi.fn(async () => undefined),
    openDataFolder: vi.fn(async () => undefined),
    listSnapshots: vi.fn(),
    listSnapshotSummaries: vi.fn(),
    getSnapshot: vi.fn(),
    deleteSnapshot: vi.fn(),
    importSnapshot: vi.fn(),
    exportSnapshot: vi.fn(),
    planRestore: vi.fn(),
    runRestore: vi.fn(),
    getDrift: vi.fn(),
    listThemePacks: vi.fn(),
    getThemePack: vi.fn(),
    startService: vi.fn(),
    captureSnapshot: vi.fn(),
    planApply: vi.fn(),
    runApply: vi.fn(),
    onApplyProgress: vi.fn(() => () => undefined),
    openExternal: vi.fn(async () => undefined),
    setThemeSource: vi.fn(),
    onSystemThemeChange: vi.fn(() => () => undefined),
    windowControls: {
      minimize: vi.fn(),
      toggleMaximize: vi.fn(),
      close: vi.fn(),
      onMaximizedChange: vi.fn(() => () => undefined),
    },
    ...overrides,
  };
  Object.defineProperty(window, 'api', { configurable: true, value: api });
  return api;
}

function readOnlyEnvironment(mode: 'read-only' | 'unsupported', message: string): Environment {
  return {
    ...structuredClone(WRITABLE_ENV),
    compatibility: {
      mode,
      canApply: false,
      issues: [{ code: mode === 'read-only' ? 'portable' : 'windows-version', message }],
    },
  };
}

function makeResult(status: ApplyResult['status'], message: string): ApplyResult {
  return parseApplyResult({
    schemaVersion: 1,
    runId: RECOVERY.runId,
    kind: 'restore',
    status,
    message,
    startedAt: '2026-10-22T20:05:00.000Z',
    completedAt: '2026-10-22T20:05:04.000Z',
    changedMods: ['windows-11-taskbar-styler'],
    skippedMods: [],
    warnings: [],
    reload: {
      requested: true,
      confirmed: false,
      message: 'Reload requested, not confirmed loaded.',
    },
    verification: {
      status: 'verified',
      checkedAt: '2026-10-22T20:05:04.000Z',
      message: 'Verified.',
    },
    actions: { rainmeter: { status: 'skipped' }, explorer: { status: 'skipped' } },
    rollback:
      status === 'rollback-failed'
        ? { status: 'failed', message: 'Automatic rollback failed.' }
        : null,
    error:
      status === 'rollback-failed'
        ? {
            code: 'ROLLBACK_FAILED',
            name: 'RollbackError',
            message: 'rollback failed',
            details: [],
          }
        : null,
  });
}

function alertContaining(text: string): HTMLElement {
  const match = screen
    .getAllByRole('alert')
    .find((element) => within(element).queryByText(text) !== null);
  if (match === undefined) throw new Error(`No alert contained "${text}".`);
  return match;
}

function renderSettings(
  options: {
    readonly state?: AppState;
    readonly environment?: Environment;
    readonly diagnostics?: Diagnostics;
    readonly api?: Partial<WpmApi>;
  } = {},
): {
  api: WpmApi;
  onPreferencesChange: ReturnType<typeof vi.fn>;
  onNavigate: ReturnType<typeof vi.fn>;
} {
  const api = createApi({
    getState: vi.fn(async () => structuredClone(options.state ?? STATE)),
    getEnvironment: vi.fn(async () => structuredClone(options.environment ?? WRITABLE_ENV)),
    getDiagnostics: vi.fn(async () => structuredClone(options.diagnostics ?? DIAGNOSTICS)),
    ...options.api,
  });
  const onPreferencesChange = vi.fn();
  const onNavigate = vi.fn();
  render(
    <I18nextProvider i18n={translation()}>
      <Settings onPreferencesChange={onPreferencesChange} onNavigate={onNavigate} />
    </I18nextProvider>,
  );
  return { api, onPreferencesChange, onNavigate };
}

function renderFirstRun(
  options: {
    readonly state?: AppState;
    readonly environment?: Environment;
    readonly api?: Partial<WpmApi>;
  } = {},
): { api: WpmApi; onComplete: ReturnType<typeof vi.fn> } {
  const api = createApi({
    getState: vi.fn(async () => structuredClone(options.state ?? STATE)),
    getEnvironment: vi.fn(async () => structuredClone(options.environment ?? WRITABLE_ENV)),
    ...options.api,
  });
  const onComplete = vi.fn();
  render(
    <I18nextProvider i18n={translation()}>
      <FirstRun onComplete={onComplete} />
    </I18nextProvider>,
  );
  return { api, onComplete };
}

function renderRecovery(
  options: {
    readonly info?: RecoveryInfo;
    readonly api?: Partial<WpmApi>;
  } = {},
): {
  api: WpmApi;
  onResolved: ReturnType<typeof vi.fn>;
  onClose: ReturnType<typeof vi.fn>;
} {
  const api = createApi(options.api);
  const onResolved = vi.fn();
  const onClose = vi.fn();
  render(
    <I18nextProvider i18n={translation()}>
      <RecoveryDialog info={options.info ?? RECOVERY} onResolved={onResolved} onClose={onClose} />
    </I18nextProvider>,
  );
  return { api, onResolved, onClose };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Settings', () => {
  it('saves language, appearance, and Explorer preferences and applies them live', async () => {
    let current = structuredClone(STATE);
    const updateSettings = vi.fn(async (patch: SettingsPatch): Promise<AppState> => {
      current = { ...current, ...patch };
      return structuredClone(current);
    });
    const { onPreferencesChange } = renderSettings({ api: { updateSettings } });
    const user = userEvent.setup();

    const language = await screen.findByLabelText('Language');
    await user.selectOptions(language, 'th');
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ language: 'th' }));
    await waitFor(() =>
      expect(onPreferencesChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ language: 'th' }),
      ),
    );

    const appearance = screen.getByLabelText('Appearance');
    await user.selectOptions(appearance, 'dark');
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ appearance: 'dark' }));
    await waitFor(() =>
      expect(onPreferencesChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ language: 'th', appearance: 'dark' }),
      ),
    );

    const explorer = screen.getByLabelText('Restart Explorer');
    await user.selectOptions(explorer, 'never');
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ explorerRestart: 'never' }));

    expect(onPreferencesChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ language: 'th', appearance: 'dark', explorerRestart: 'never' }),
    );
    expect((screen.getByLabelText('Language') as HTMLSelectElement).value).toBe('th');
    expect((screen.getByLabelText('Appearance') as HTMLSelectElement).value).toBe('dark');
    expect((screen.getByLabelText('Restart Explorer') as HTMLSelectElement).value).toBe('never');
  });

  it('rejects retention values outside 5–50 and saves the bounds', async () => {
    const updateSettings = vi.fn(async (patch: SettingsPatch): Promise<AppState> => ({
      ...structuredClone(STATE),
      ...patch,
    }));
    const { onPreferencesChange } = renderSettings({ api: { updateSettings } });
    const user = userEvent.setup();

    const input = await screen.findByLabelText('Automatic snapshots to keep');
    expect(screen.getByText('Current: 20')).toBeTruthy();

    for (const invalid of ['4', '51', '5.5']) {
      await user.clear(input);
      await user.type(input, invalid);
      await user.click(screen.getByRole('button', { name: 'Save retention' }));
      expect(screen.getByText('Enter a whole number from 5 to 50.')).toBeTruthy();
      expect(updateSettings).not.toHaveBeenCalled();
    }

    await user.clear(input);
    await user.type(input, '5');
    await user.click(screen.getByRole('button', { name: 'Save retention' }));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ snapshotRetention: 5 }));
    await waitFor(() =>
      expect(onPreferencesChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ snapshotRetention: 5 }),
      ),
    );
    expect(await screen.findByText('Snapshot retention saved.')).toBeTruthy();

    await user.clear(input);
    await user.type(input, '50');
    await user.click(screen.getByRole('button', { name: 'Save retention' }));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ snapshotRetention: 50 }));

    await user.click(screen.getByRole('button', { name: 'View snapshots' }));
    expect(onPreferencesChange).toHaveBeenCalled();
  });

  it('links retention to snapshots', async () => {
    const { onNavigate } = renderSettings();
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'View snapshots' }));
    expect(onNavigate).toHaveBeenCalledWith('snapshots');
  });

  it('shows diagnostics, copies them as JSON, and opens both folders', async () => {
    const writeText = vi.spyOn(navigator.clipboard, 'writeText');
    const { api } = renderSettings();
    const user = userEvent.setup();

    expect(await screen.findByText('0.1.0')).toBeTruthy();
    expect(screen.getByText('Build 22631')).toBeTruthy();
    expect(screen.getByText('Supported')).toBeTruthy();
    expect(screen.getByText('1.7.3')).toBeTruthy();
    expect(screen.getByText('Registry', { exact: true })).toBeTruthy();
    expect(screen.getByText('HKLM\\SOFTWARE\\Windhawk')).toBeTruthy();
    expect(screen.getByText('Running')).toBeTruthy();
    expect(screen.getByText('3 mods')).toBeTruthy();
    expect(screen.getByText(/Succeeded/)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Copy diagnostics' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const copied = String(writeText.mock.calls[0]?.[0]);
    expect(JSON.parse(copied)).toEqual(DIAGNOSTICS);
    expect(screen.queryByText('C:\\Users\\Test')).toBeNull();
    expect(screen.getByRole('button', { name: 'Diagnostics copied' })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Open logs folder' }));
    await waitFor(() => expect(api.openLogsFolder).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole('button', { name: 'Open data folder' }));
    await waitFor(() => expect(api.openDataFolder).toHaveBeenCalledTimes(1));
  });

  it('loads state, environment, and diagnostics independently and retries the failures', async () => {
    const getEnvironment = vi
      .fn()
      .mockRejectedValueOnce(new Error('environment probe failed'))
      .mockResolvedValueOnce(structuredClone(WRITABLE_ENV));
    const getDiagnostics = vi
      .fn()
      .mockRejectedValueOnce(new Error('diagnostics failed'))
      .mockResolvedValueOnce(structuredClone(DIAGNOSTICS));
    renderSettings({ api: { getEnvironment, getDiagnostics } });
    const user = userEvent.setup();

    expect(await screen.findByText('Environment could not be read')).toBeTruthy();
    expect(await screen.findByText('Diagnostics could not be read')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Preferences' })).toBeTruthy();
    expect(screen.getByLabelText('Language')).toBeTruthy();

    const environmentAlert = alertContaining('Environment could not be read');
    await user.click(within(environmentAlert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('This PC is writable')).toBeTruthy();
    expect(getEnvironment).toHaveBeenCalledTimes(2);

    const diagnosticsAlert = alertContaining('Diagnostics could not be read');
    await user.click(within(diagnosticsAlert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('0.1.0')).toBeTruthy();
    expect(getDiagnostics).toHaveBeenCalledTimes(2);
  });

  it('retries a failed settings load without hiding diagnostics', async () => {
    const getState = vi
      .fn()
      .mockRejectedValueOnce(new Error('state file is unreadable'))
      .mockResolvedValueOnce(structuredClone(STATE));
    renderSettings({ api: { getState } });
    const user = userEvent.setup();

    expect(await screen.findByText('Settings could not be loaded')).toBeTruthy();
    expect(screen.queryByLabelText('Language')).toBeNull();
    expect(screen.getByText('0.1.0')).toBeTruthy();

    const stateAlert = alertContaining('Settings could not be loaded');
    await user.click(within(stateAlert).getByRole('button', { name: 'Retry' }));

    expect(await screen.findByLabelText('Language')).toBeTruthy();
    expect(getState).toHaveBeenCalledTimes(2);
  });

  it('shows a read-only compatibility banner for a non-writable environment', async () => {
    renderSettings({
      environment: readOnlyEnvironment('read-only', 'Windhawk is installed in portable mode.'),
    });

    expect(await screen.findByText('Read-only mode')).toBeTruthy();
    expect(screen.getByText('Windhawk is installed in portable mode.')).toBeTruthy();
    expect(screen.getByLabelText('Language')).toBeTruthy();
  });
});

describe('FirstRun', () => {
  it('explains the safety rules and completes onboarding into Home', async () => {
    const { api, onComplete } = renderFirstRun();
    const user = userEvent.setup();

    expect(await screen.findByText('Only Windhawk mod settings change')).toBeTruthy();
    expect(screen.getByText('A snapshot comes first')).toBeTruthy();
    expect(screen.getByText('Admin only when applying')).toBeTruthy();
    expect(screen.getByText('The Windhawk service keeps running')).toBeTruthy();
    expect(screen.getByText('No network requests')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Continue to Home' }));

    await waitFor(() => expect(api.completeFirstRun).toHaveBeenCalledTimes(1));
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({ firstRunCompleted: true }),
      'home',
    );
  });

  it.each([
    ['profiles', 'Capture my current setup'],
    ['packs', 'Open Mac Blur Glass pack'],
  ] as const)('completes onboarding with the %s destination', async (destination, label) => {
    const { api, onComplete } = renderFirstRun();
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: label }));

    await waitFor(() => expect(api.completeFirstRun).toHaveBeenCalledTimes(1));
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({ firstRunCompleted: true }),
      destination,
    );
  });

  it.each([
    ['read-only', 'This PC is read-only', 'Windhawk is portable.'],
    ['unsupported', 'This PC is not supported', 'This Windows build is not supported.'],
  ] as const)('explains why Apply is disabled in %s mode', async (mode, title, message) => {
    renderFirstRun({ environment: readOnlyEnvironment(mode, message) });

    expect(await screen.findByText(title)).toBeTruthy();
    expect(screen.getByText(message)).toBeTruthy();
    expect(screen.getByText(/Apply is disabled/)).toBeTruthy();
  });

  it('shows a partial load error and refreshes the environment', async () => {
    const getEnvironment = vi
      .fn()
      .mockRejectedValueOnce(new Error('probe failed'))
      .mockResolvedValueOnce(structuredClone(WRITABLE_ENV));
    renderFirstRun({ api: { getEnvironment } });
    const user = userEvent.setup();

    expect(await screen.findByText('Some system details could not be loaded.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Continue to Home' })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Ready to apply')).toBeTruthy();
    expect(getEnvironment).toHaveBeenCalledTimes(2);
  });

  it('shows a full load error and retries both probes', async () => {
    const getEnvironment = vi
      .fn()
      .mockRejectedValueOnce(new Error('probe failed'))
      .mockResolvedValueOnce(structuredClone(WRITABLE_ENV));
    const getState = vi
      .fn()
      .mockRejectedValueOnce(new Error('state failed'))
      .mockResolvedValueOnce(structuredClone(STATE));
    renderFirstRun({ api: { getEnvironment, getState } });
    const user = userEvent.setup();

    expect(await screen.findByText('This PC could not be checked')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('Ready to apply')).toBeTruthy();
    expect(getEnvironment).toHaveBeenCalledTimes(2);
    expect(getState).toHaveBeenCalledTimes(2);
  });

  it('keeps the screen open and reports a completion failure', async () => {
    const completeFirstRun = vi
      .fn()
      .mockRejectedValueOnce(new Error('settings file is read-only'))
      .mockResolvedValueOnce(structuredClone(COMPLETED_STATE));
    const { onComplete } = renderFirstRun({ api: { completeFirstRun } });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Continue to Home' }));
    expect(await screen.findByText(/settings file is read-only/)).toBeTruthy();
    expect(onComplete).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Continue to Home' }));
    await waitFor(() =>
      expect(onComplete).toHaveBeenCalledWith(
        expect.objectContaining({ firstRunCompleted: true }),
        'home',
      ),
    );
  });
});

describe('RecoveryDialog', () => {
  it('restores the pre-apply snapshot, reports the result, and emits wpm:applied', async () => {
    const result = makeResult('succeeded', 'Restored 2 mods; the Windhawk service stayed running.');
    let resolveRestore!: (value: RecoveryResolution) => void;
    const pending = new Promise<RecoveryResolution>((resolve) => {
      resolveRestore = resolve;
    });
    const resolveRecovery = vi.fn(async () => pending);
    const { onResolved, onClose } = renderRecovery({ api: { resolveRecovery } });
    const dispatch = vi.spyOn(window, 'dispatchEvent');
    const user = userEvent.setup();

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Recover an unfinished run')).toBeTruthy();
    expect(within(dialog).getAllByText(RECOVERY.runId).length).toBeGreaterThan(0);
    expect(within(dialog).getByText(RECOVERY.snapshotId)).toBeTruthy();
    expect(within(dialog).getByText('Apply')).toBeTruthy();
    expect(within(dialog).getByText('applying')).toBeTruthy();

    await user.click(within(dialog).getByRole('button', { name: 'Restore pre-apply snapshot' }));
    await waitFor(() => expect(resolveRecovery).toHaveBeenCalledWith('restore'));
    expect(within(dialog).getByText('Restoring the pre-apply snapshot…')).toBeTruthy();
    expect(
      (
        within(dialog).getByRole('button', {
          name: 'Restore in progress — cannot close',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);

    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      resolveRestore({ action: 'restored', result });
      await pending;
    });

    expect(await within(dialog).findByText('Restored')).toBeTruthy();
    expect(
      within(dialog).getByText('Restored 2 mods; the Windhawk service stayed running.'),
    ).toBeTruthy();
    expect(within(dialog).getByText('The snapshot is kept.')).toBeTruthy();
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'wpm:applied' }));

    const closeButtons = within(dialog).getAllByRole('button', { name: 'Close' });
    await user.click(closeButtons[closeButtons.length - 1] as HTMLElement);
    await waitFor(() =>
      expect(onResolved).toHaveBeenCalledWith({
        action: 'restored',
        result: expect.objectContaining({ status: 'succeeded' }),
      }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('dismisses the run without touching the snapshot and closes', async () => {
    const resolveRecovery = vi.fn(async (): Promise<RecoveryResolution> => ({
      action: 'dismissed',
      result: null,
    }));
    const { onResolved, onClose } = renderRecovery({ api: { resolveRecovery } });
    const dispatch = vi.spyOn(window, 'dispatchEvent');
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Keep current state and close' }));

    await waitFor(() => expect(resolveRecovery).toHaveBeenCalledWith('dismiss'));
    expect(onResolved).toHaveBeenCalledWith({ action: 'dismissed', result: null });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'wpm:applied' }));
  });

  it('shows a restore error inline and keeps the dialog open', async () => {
    const resolveRecovery = vi.fn(async () => {
      throw new Error('Journal is locked.');
    });
    const { onResolved, onClose } = renderRecovery({ api: { resolveRecovery } });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Restore pre-apply snapshot' }));

    expect(await screen.findByText(/Journal is locked\./)).toBeTruthy();
    expect(screen.getByText(/Recovery could not continue/)).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(onResolved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(
      (screen.getByRole('button', { name: 'Restore pre-apply snapshot' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it('reports a failed rollback and leaves the snapshot in place', async () => {
    const result = makeResult(
      'rollback-failed',
      'Automatic rollback failed. The journal and snapshot were kept.',
    );
    const resolveRecovery = vi.fn(async (): Promise<RecoveryResolution> => ({
      action: 'restored',
      result,
    }));
    const { onResolved } = renderRecovery({ api: { resolveRecovery } });
    const dispatch = vi.spyOn(window, 'dispatchEvent');
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Restore pre-apply snapshot' }));

    expect(await screen.findByText('Rollback failed')).toBeTruthy();
    expect(
      screen.getByText('Automatic rollback failed. The journal and snapshot were kept.'),
    ).toBeTruthy();
    expect(screen.getByText('The snapshot is kept.')).toBeTruthy();
    expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'wpm:applied' }));

    const closeButtons = screen.getAllByRole('button', { name: 'Close' });
    await user.click(closeButtons[closeButtons.length - 1] as HTMLElement);
    await waitFor(() =>
      expect(onResolved).toHaveBeenCalledWith({
        action: 'restored',
        result: expect.objectContaining({ status: 'rollback-failed' }),
      }),
    );
  });
});
