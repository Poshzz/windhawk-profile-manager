// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppVersions, WpmApi } from '@shared/ipc';
import {
  parseAppState,
  parseDrift,
  parseSnapshotMetadata,
  type Drift,
  type Environment,
  type Profile,
  type SnapshotMetadata,
} from '@shared/domain';
import { createI18n } from '../../../src/renderer/i18n';
import { Home } from '../../../src/renderer/screens/Home';
import { makeEnvironment, makeProfile, managedMod } from '../planner/support';

const VERSIONS: AppVersions = {
  app: '0.1.0',
  electron: '45.0.0',
  chrome: '142.0.0',
  node: '24.0.0',
};

const PROFILE: Profile = makeProfile({
  requiredMods: Array.from({ length: 10 }, (_, index) =>
    managedMod({
      modId: `mod-${index}`,
      settings: { Theme: { type: 'string', value: 'macOS' } },
    }),
  ),
});

const BASE_ENVIRONMENT: Environment = makeEnvironment({
  mods: Array.from({ length: 10 }, (_, index) => ({
    modId: `mod-${index}`,
    version: '1.0',
  })),
});
const ENVIRONMENT: Environment = {
  ...BASE_ENVIRONMENT,
  rainmeter: { ...BASE_ENVIRONMENT.rainmeter, running: true },
};

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
  registrySha256: `sha256:${'b'.repeat(64)}`,
  modCount: 10,
  scope: 'engine-mods-configuration',
  excludedPaths: [],
});

const STATE = parseAppState({
  schemaVersion: 1,
  activeProfileId: PROFILE.id,
  lastAppliedAt: '2026-10-22T20:02:20.000Z',
  lastRunId: 'run-2026-10-22T20-02-14-123Z',
});

const MATCHING_DRIFT: Drift = parseDrift({
  schemaVersion: 1,
  profileId: PROFILE.id,
  status: 'matches',
  checkedAt: '2026-10-22T20:03:00.000Z',
  entries: [],
  reason: null,
});

const DIFFERENT_DRIFT: Drift = parseDrift({
  schemaVersion: 1,
  profileId: PROFILE.id,
  status: 'different',
  checkedAt: '2026-10-22T20:03:00.000Z',
  entries: [
    {
      modId: 'mod-0',
      kind: 'enabled-state',
      message: 'Mod "mod-0" is disabled but the profile wants it enabled.',
      current: 'disabled',
      desired: 'enabled',
    },
  ],
  reason: null,
});

function installApi(overrides: Partial<WpmApi> = {}): WpmApi {
  const api: WpmApi = {
    ping: vi.fn(),
    getVersions: vi.fn(async () => VERSIONS),
    getConfig: vi.fn(),
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
    updateSettings: vi.fn(),
    completeFirstRun: vi.fn(),
    getRecovery: vi.fn(),
    resolveRecovery: vi.fn(),
    getDiagnostics: vi.fn(),
    openLogsFolder: vi.fn(),
    openDataFolder: vi.fn(),
    listSnapshots: vi.fn(async () => structuredClone([SNAPSHOT])),
    listSnapshotSummaries: vi.fn(async () => []),
    getSnapshot: vi.fn(),
    deleteSnapshot: vi.fn(async () => undefined),
    importSnapshot: vi.fn(async () => null),
    exportSnapshot: vi.fn(async () => null),
    planRestore: vi.fn(),
    runRestore: vi.fn(),
    getDrift: vi.fn(async () => structuredClone(MATCHING_DRIFT)),
    listThemePacks: vi.fn(async () => []),
    getThemePack: vi.fn(async () => {
      throw new Error('not used');
    }),
    startService: vi.fn(async () => structuredClone(ENVIRONMENT)),
    captureSnapshot: vi.fn(async () => structuredClone(SNAPSHOT)),
    planApply: vi.fn(),
    runApply: vi.fn(),
    onApplyProgress: vi.fn(() => () => undefined),
    openExternal: vi.fn(async () => undefined),
    setThemeSource: vi.fn(async () => undefined),
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

function renderHome(): ReturnType<typeof installApi> {
  const api = installApi();
  const i18n = createI18n('en');
  render(
    <I18nextProvider i18n={i18n}>
      <Home versions={VERSIONS} onNavigate={vi.fn()} onApply={vi.fn()} />
    </I18nextProvider>,
  );
  return api;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Home', () => {
  it('renders ten mods, a running service, registry mode, and Rainmeter', async () => {
    renderHome();

    expect(await screen.findByText('10 of 10 enabled')).toBeTruthy();
    expect(screen.getByText('Windhawk 1.7.3')).toBeTruthy();
    expect(screen.getByText('Running', { exact: true })).toBeTruthy();
    expect(screen.getByText(/HKLM\\SOFTWARE\\Windhawk/)).toBeTruthy();
    expect(screen.getByText('Mac Blur Glass', { exact: true })).toBeTruthy();
    expect(screen.getByText('Matches', { exact: true })).toBeTruthy();
  });

  it('shows a missing Windhawk state and disables apply', async () => {
    const missing: Environment = {
      ...ENVIRONMENT,
      windhawk: { ...ENVIRONMENT.windhawk, installed: false, version: null },
      mods: [],
      rainmeter: { ...ENVIRONMENT.rainmeter, running: false },
      service: { name: 'Windhawk', state: 'missing' },
      compatibility: { mode: 'unsupported', canApply: false, issues: [] },
    };
    installApi({ getEnvironment: vi.fn(async () => missing) });
    const i18n = createI18n('en');
    render(
      <I18nextProvider i18n={i18n}>
        <Home versions={VERSIONS} onNavigate={vi.fn()} onApply={vi.fn()} />
      </I18nextProvider>,
    );

    expect(await screen.findByText('Not found', { exact: true })).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Apply active profile' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('shows the read-only banner for portable Windhawk', async () => {
    const environment: Environment = {
      ...ENVIRONMENT,
      windhawk: {
        ...ENVIRONMENT.windhawk,
        storageMode: 'portable',
        portable: true,
        registryRoot: null,
      },
      compatibility: {
        mode: 'read-only',
        canApply: false,
        issues: [{ code: 'portable', message: 'Portable mode.' }],
      },
    };
    const api = installApi({ getEnvironment: vi.fn(async () => environment) });
    const i18n = createI18n('en');
    render(
      <I18nextProvider i18n={i18n}>
        <Home versions={VERSIONS} onNavigate={vi.fn()} onApply={vi.fn()} />
      </I18nextProvider>,
    );

    expect(await screen.findByText('Read-only mode')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Apply active profile' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Open Windhawk docs' }));
    expect(api.openExternal).toHaveBeenCalledWith('https://windhawk.net');
  });

  it('starts a stopped Windhawk service and clears the banner', async () => {
    const stopped = {
      ...ENVIRONMENT,
      service: { name: 'Windhawk', state: 'stopped' as const },
    };
    const api = installApi({
      getEnvironment: vi.fn(async () => stopped),
      startService: vi.fn(async () => ENVIRONMENT),
    });
    const i18n = createI18n('en');
    render(
      <I18nextProvider i18n={i18n}>
        <Home versions={VERSIONS} onNavigate={vi.fn()} onApply={vi.fn()} />
      </I18nextProvider>,
    );

    expect(await screen.findByText('Windhawk service is stopped')).toBeTruthy();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Start service' }));
    await waitFor(() => expect(api.startService).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText('Windhawk service is stopped')).toBeNull());
  });

  it('expands drift details and refreshes drift', async () => {
    const api = installApi({ getDrift: vi.fn(async () => structuredClone(DIFFERENT_DRIFT)) });
    const i18n = createI18n('en');
    render(
      <I18nextProvider i18n={i18n}>
        <Home versions={VERSIONS} onNavigate={vi.fn()} onApply={vi.fn()} />
      </I18nextProvider>,
    );

    expect(await screen.findByText('1 differences', { exact: true })).toBeTruthy();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Show drift details' }));
    expect(screen.getByText('mod-0', { exact: true })).toBeTruthy();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Refresh drift' }));
    await waitFor(() => expect(api.getDrift).toHaveBeenCalledTimes(2));
  });

  it('recovers from a failed environment probe', async () => {
    const api = installApi({
      getEnvironment: vi
        .fn()
        .mockRejectedValueOnce(new Error('probe failed'))
        .mockResolvedValueOnce(structuredClone(ENVIRONMENT)),
    });
    const i18n = createI18n('en');
    render(
      <I18nextProvider i18n={i18n}>
        <Home versions={VERSIONS} onNavigate={vi.fn()} onApply={vi.fn()} />
      </I18nextProvider>,
    );

    expect(await screen.findByText('Machine status could not be read')).toBeTruthy();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(api.getEnvironment).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('10 of 10 enabled')).toBeTruthy();
  });

  it('routes quick actions and captures a manual snapshot', async () => {
    const onNavigate = vi.fn();
    const onApply = vi.fn();
    const api = installApi();
    const i18n = createI18n('en');
    render(
      <I18nextProvider i18n={i18n}>
        <Home versions={VERSIONS} onNavigate={onNavigate} onApply={onApply} />
      </I18nextProvider>,
    );
    const user = userEvent.setup();
    await screen.findByText('10 of 10 enabled');

    await user.click(screen.getByRole('button', { name: 'Apply active profile' }));
    await user.click(screen.getByRole('button', { name: 'Reset to Default Windows' }));
    await user.click(screen.getByRole('button', { name: 'Capture current setup' }));
    expect(onApply.mock.calls.map((call) => call[0])).toEqual([
      PROFILE.id,
      'default-windows',
    ]);
    expect(onNavigate.mock.calls.map((call) => call[0])).toEqual(['profiles']);

    await user.click(screen.getByRole('button', { name: 'Back up now' }));
    await waitFor(() => expect(api.captureSnapshot).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/Snapshot saved at/)).toBeTruthy();
  });
});
