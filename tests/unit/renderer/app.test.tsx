// @vitest-environment jsdom
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig, ThemeSource, WpmApi } from '@shared/ipc';
import { createPingResult } from '@shared/ipc';
import {
  parseAppState,
  parseDrift,
  parseSnapshotMetadata,
  parseThemePack,
  type Environment,
  type Profile,
  type SnapshotMetadata,
  type ThemePack,
} from '@shared/domain';
import { makeEnvironment, makeProfile } from '../planner/support';
import { App } from '../../../src/renderer/App';
import { createI18n } from '../../../src/renderer/i18n';
import th from '../../../src/renderer/i18n/locales/th.json';
import { resetUiStoreForTests, useUiStore } from '../../../src/renderer/state/ui-store';

const CONFIG: AppConfig = {
  titlebarMode: 'overlay',
  systemLocale: 'en',
  systemTheme: 'light',
  backgroundMaterial: 'opaque',
};

const PROFILE: Profile = makeProfile();
const ENVIRONMENT: Environment = makeEnvironment({
  mods: [{ modId: 'windows-11-taskbar-styler', version: '1.0' }],
});
const SNAPSHOT: SnapshotMetadata = parseSnapshotMetadata({
  schemaVersion: 1,
  id: '2026-10-22T20-02-14-123Z',
  createdAt: '2026-10-22T20:02:14.123Z',
  trigger: 'pre-apply',
  profileId: PROFILE.id,
  appVersion: '0.1.0',
  windowsBuild: '22631',
  registryView: '64-bit',
  windhawkVersion: '1.7.3',
  windhawkStorageMode: 'registry',
  windhawkRegistryRoot: 'HKLM\\SOFTWARE\\Windhawk',
  windhawkServiceName: 'Windhawk',
  windhawkServiceState: 'running',
  rainmeterRunning: true,
  registryFile: '2026-10-22T20-02-14-123Z.reg',
  registrySha256: `sha256:${'a'.repeat(64)}`,
  modCount: 1,
  scope: 'engine-mods-configuration',
  excludedPaths: [],
});
const STATE = parseAppState({
  schemaVersion: 1,
  activeProfileId: PROFILE.id,
  lastAppliedAt: '2026-10-22T20:02:20.000Z',
  lastRunId: 'run-2026-10-22T20-02-14-123Z',
  firstRunCompleted: true,
});
const DRIFT = parseDrift({
  schemaVersion: 1,
  profileId: PROFILE.id,
  status: 'matches',
  checkedAt: '2026-10-22T20:03:00.000Z',
  entries: [],
  reason: null,
});
const PACK: ThemePack = parseThemePack({
  schemaVersion: 1,
  id: 'mac-blur-glass',
  name: 'Mac Blur Glass',
  description: 'macOS-style blur, dock, and menu treatment.',
  version: '1.0.0',
  testedAppVersion: '0.1.0',
  mods: [
    {
      modId: 'windows-11-taskbar-styler',
      name: 'Windows 11 Taskbar Styler',
      pageUrl: 'https://windhawk.net/mods/windows-11-taskbar-styler',
      testedVersion: '1.0',
      required: true,
      notes: [],
    },
  ],
  profiles: ['mac-blur-glass'],
  notes: [],
});

function installApi(config: AppConfig = CONFIG): WpmApi {
  const api: WpmApi = {
    ping: vi.fn(async () => createPingResult(new Date('2026-01-02T03:04:00.000Z'))),
    getVersions: vi.fn(async () => ({
      app: '0.1.0',
      electron: '45.0.0',
      chrome: '142.0.0',
      node: '24.0.0',
    })),
    getConfig: vi.fn(async () => config),
    getEnvironment: vi.fn(async () => structuredClone(ENVIRONMENT)),
    listProfiles: vi.fn(async () => structuredClone([PROFILE])),
    getProfile: vi.fn(async () => structuredClone(PROFILE)),
    createProfile: vi.fn(async () => structuredClone(PROFILE)),
    updateProfile: vi.fn(async () => structuredClone(PROFILE)),
    deleteProfile: vi.fn(async () => undefined),
    duplicateProfile: vi.fn(async () => structuredClone(PROFILE)),
    captureProfile: vi.fn(async () => structuredClone(PROFILE)),
    importProfile: vi.fn(async () => null),
    exportProfile: vi.fn(async () => null),
    getState: vi.fn(async () => structuredClone(STATE)),
    updateSettings: vi.fn(async (patch) => structuredClone({ ...STATE, ...patch })),
    completeFirstRun: vi.fn(async () => structuredClone(STATE)),
    getRecovery: vi.fn(async () => null),
    resolveRecovery: vi.fn(async () => ({ action: 'dismissed' as const, result: null })),
    getDiagnostics: vi.fn(async () => ({
      appVersion: '0.1.0',
      windowsBuild: '22631',
      windowsSupported: true,
      windhawkVersion: '1.7.3',
      storageMode: 'registry',
      registryRoot: 'HKLM\\SOFTWARE\\Windhawk',
      serviceState: 'running',
      modCount: 1,
      lastRun: null,
    })),
    openLogsFolder: vi.fn(async () => undefined),
    openDataFolder: vi.fn(async () => undefined),
    listSnapshots: vi.fn(async () => structuredClone([SNAPSHOT])),
    listSnapshotSummaries: vi.fn(async () => []),
    getSnapshot: vi.fn(),
    deleteSnapshot: vi.fn(async () => undefined),
    importSnapshot: vi.fn(async () => null),
    exportSnapshot: vi.fn(async () => null),
    planRestore: vi.fn(),
    runRestore: vi.fn(),
    getDrift: vi.fn(async () => structuredClone(DRIFT)),
    listThemePacks: vi.fn(async () => structuredClone([PACK])),
    getThemePack: vi.fn(async () => structuredClone(PACK)),
    startService: vi.fn(async () => structuredClone(ENVIRONMENT)),
    captureSnapshot: vi.fn(async () => structuredClone(SNAPSHOT)),
    planApply: vi.fn(),
    runApply: vi.fn(),
    onApplyProgress: vi.fn(() => () => undefined),
    openExternal: vi.fn(async (_url: string) => undefined),
    setThemeSource: vi.fn(async (_theme: ThemeSource) => undefined),
    onSystemThemeChange: vi.fn((_listener: (theme: 'light' | 'dark') => void) => () => undefined),
    windowControls: {
      minimize: vi.fn(),
      toggleMaximize: vi.fn(),
      close: vi.fn(),
      onMaximizedChange: vi.fn(
        (_listener: (isMaximized: boolean) => void) => () => undefined,
      ),
    },
  };
  Object.defineProperty(window, 'api', { configurable: true, value: api });
  return api;
}

function renderApp(options: {
  config?: AppConfig;
  locale?: 'en' | 'th';
  useInitialConfig?: boolean;
}): { api: WpmApi; i18n: ReturnType<typeof createI18n> } {
  const config = options.config ?? CONFIG;
  const api = installApi(config);
  resetUiStoreForTests();
  const i18n = createI18n(options.locale ?? 'en');
  const initialProps = options.useInitialConfig === false ? {} : { initialConfig: config };
  render(
    <I18nextProvider i18n={i18n}>
      <App {...initialProps} />
    </I18nextProvider>,
  );
  return { api, i18n };
}

describe('App shell', () => {
  beforeEach(() => {
    resetUiStoreForTests();
  });

  it('renders the home screen and navigates through all five sections', async () => {
    const user = userEvent.setup();
    renderApp({});
    expect(
      await screen.findByRole('heading', { name: 'Windhawk Profile Manager' }),
    ).toBeTruthy();

    const nav = screen.getByRole('navigation', { name: 'Primary' });
    const screens = [
      [
        'Profiles',
        'Switch between complete Windhawk setups. Capture the current machine, edit a copy, and keep built-in profiles read-only.',
      ],
      [
        'Snapshots',
        'Review snapshot evidence, verify checksums, restore a captured state, and export or delete .reg files.',
      ],
      ['Theme Packs', 'Mac Blur Glass'],
      [
        'Settings',
        'Control language, appearance, Explorer restarts, snapshot retention, and support diagnostics. Everything stays on this PC.',
      ],
    ] as const;

    for (const [label, body] of screens) {
      const button = within(nav).getByRole('button', { name: label });
      await user.click(button);
      expect(button.getAttribute('aria-current')).toBe('page');
      expect(await screen.findByText(body)).toBeTruthy();
    }

    await user.click(within(nav).getByRole('button', { name: 'Home' }));
    expect(
      screen.getByRole('heading', { name: 'Windhawk Profile Manager' }),
    ).toBeTruthy();
  });

  it('switches the whole shell between English and Thai without a restart', async () => {
    const user = userEvent.setup();
    const { i18n } = renderApp({
      config: { ...CONFIG, titlebarMode: 'custom' },
    });
    await screen.findByRole('heading', { name: 'Windhawk Profile Manager' });

    await user.click(screen.getByRole('button', { name: 'TH' }));
    await waitFor(() => expect(document.documentElement.lang).toBe('th'));

    expect(i18n.language).toBe('th');
    expect(screen.getByRole('navigation', { name: th.a11y.primaryNavigation })).toBeTruthy();
    expect(screen.getByRole('button', { name: th.nav.profiles })).toBeTruthy();
    expect(screen.getByText(th.home.body)).toBeTruthy();
    expect(screen.getByRole('button', { name: th.a11y.closeWindow })).toBeTruthy();
    expect(screen.getByText(th.home.activeProfile)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'EN' }));
    await waitFor(() => expect(document.documentElement.lang).toBe('en'));
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeTruthy();
  });

  it('applies light, dark, and system themes and forwards them to the native shell', async () => {
    const user = userEvent.setup();
    const { api } = renderApp({});
    await screen.findByRole('heading', { name: 'Windhawk Profile Manager' });
    const themeSelect = screen.getByRole('combobox', { name: 'Theme' });

    await user.selectOptions(themeSelect, 'dark');
    await waitFor(() => expect(document.documentElement.dataset['theme']).toBe('dark'));
    expect(useUiStore.getState().theme).toBe('dark');
    expect(vi.mocked(api.setThemeSource)).toHaveBeenLastCalledWith('dark');

    await user.selectOptions(themeSelect, 'light');
    await waitFor(() => expect(document.documentElement.dataset['theme']).toBe('light'));

    await user.selectOptions(themeSelect, 'system');
    await waitFor(() => {
      expect(useUiStore.getState().theme).toBe('system');
      expect(document.documentElement.dataset['theme']).toBe('light');
    });

    const systemThemeListener = vi.mocked(api.onSystemThemeChange).mock.calls[0]?.[0];
    expect(systemThemeListener).toBeDefined();
    act(() => systemThemeListener?.('dark'));
    await waitFor(() => expect(document.documentElement.dataset['theme']).toBe('dark'));
  });

  it('renders working custom titlebar controls in custom mode', async () => {
    const user = userEvent.setup();
    const { api } = renderApp({
      config: { ...CONFIG, titlebarMode: 'custom' },
    });
    await screen.findByRole('heading', { name: 'Windhawk Profile Manager' });

    await user.click(screen.getByRole('button', { name: 'Maximize window' }));
    expect(api.windowControls.toggleMaximize).toHaveBeenCalledTimes(1);

    await user.dblClick(screen.getByRole('banner'));
    expect(api.windowControls.toggleMaximize).toHaveBeenCalledTimes(2);

    await user.click(screen.getByRole('button', { name: 'Minimize window' }));
    expect(api.windowControls.minimize).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Close window' }));
    expect(api.windowControls.close).toHaveBeenCalledTimes(1);
  });

  it('opens the dev-only component gallery and dialog', async () => {
    const user = userEvent.setup();
    renderApp({});
    await screen.findByRole('heading', { name: 'Windhawk Profile Manager' });

    await user.click(screen.getByRole('button', { name: 'Component gallery' }));
    expect(screen.getByRole('heading', { name: 'Component gallery' })).toBeTruthy();

    const checkbox = screen.getByRole('checkbox', {
      name: 'Show the apply plan before writing',
    });
    expect(checkbox.getAttribute('aria-checked')).toBe('false');
    await user.click(checkbox);
    expect(checkbox.getAttribute('aria-checked')).toBe('true');

    const toggle = screen.getByRole('switch', { name: 'Restart Explorer after apply' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    await user.click(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('false');

    const progress = screen.getByRole('progressbar', { name: 'Applying profile' });
    expect(progress.getAttribute('aria-valuenow')).toBe('64');

    await user.click(screen.getByRole('button', { name: 'Open dialog' }));
    const dialog = await screen.findByRole('dialog', { name: 'Example dialog' });
    expect(within(dialog).getByText('Dialogs trap focus and close with Escape.')).toBeTruthy();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('shows a localizable error toast when startup IPC fails', async () => {
    const api = installApi();
    vi.mocked(api.getConfig).mockRejectedValueOnce(new Error('config failed'));
    const i18n = createI18n('en');
    resetUiStoreForTests();
    render(
      <I18nextProvider i18n={i18n}>
        <App />
      </I18nextProvider>,
    );

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Could not read app information')).toBeTruthy();
    expect(within(alert).getByText('config failed')).toBeTruthy();
  });
});
