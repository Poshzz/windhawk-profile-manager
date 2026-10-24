// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WpmApi } from '@shared/ipc';
import {
  parseThemePack,
  type Environment,
  type ThemePack,
} from '@shared/domain';
import { createI18n } from '../../../src/renderer/i18n';
import { ThemePacks } from '../../../src/renderer/screens/ThemePacks';
import { makeEnvironment } from '../planner/support';

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
      testedVersion: '1.10',
      required: true,
      notes: [],
    },
    {
      modId: 'translucent-windows',
      name: 'Translucent Windows',
      pageUrl: 'https://windhawk.net/mods/translucent-windows',
      testedVersion: '1.8.2',
      required: true,
      notes: ['Requires a restart after changing the theme.'],
    },
  ],
  profiles: ['mac-blur-glass'],
  notes: ['Machine-specific theme paths are not shipped.'],
});

function environment(
  mods: Array<{ modId: string; version: string | null; enabled?: boolean }>,
  mode: Environment['compatibility']['mode'] = 'writable',
): Environment {
  const base = makeEnvironment({
    mods: mods.map((mod) => ({
      modId: mod.modId,
      version: mod.version,
      enabled: mod.enabled ?? true,
    })),
    ...(mode === 'read-only'
      ? {
          storageMode: 'portable',
          portable: true,
          registryRoot: null,
        }
      : {}),
  });
  if (mode === 'writable') return base;
  return {
    ...base,
    compatibility: {
      mode,
      canApply: false,
      issues: [{ code: mode === 'read-only' ? 'portable' : 'windhawk-missing', message: `${mode} mode` }],
    },
  };
}

function installApi(
  env: Environment,
  overrides: Partial<WpmApi> = {},
): {
  api: WpmApi;
  onApply: (profileId: string) => void;
} {
  const onApply = vi.fn((_profileId: string): void => undefined);
  const api: WpmApi = {
    ping: vi.fn(),
    getVersions: vi.fn(),
    getConfig: vi.fn(),
    getEnvironment: vi.fn(async () => structuredClone(env)),
    listProfiles: vi.fn(),
    getProfile: vi.fn(),
    createProfile: vi.fn(),
    updateProfile: vi.fn(),
    deleteProfile: vi.fn(),
    duplicateProfile: vi.fn(),
    captureProfile: vi.fn(),
    importProfile: vi.fn(),
    exportProfile: vi.fn(),
    getState: vi.fn(),
    updateSettings: vi.fn(),
    completeFirstRun: vi.fn(),
    getRecovery: vi.fn(),
    resolveRecovery: vi.fn(),
    getDiagnostics: vi.fn(),
    openLogsFolder: vi.fn(),
    openDataFolder: vi.fn(),
    listSnapshots: vi.fn(),
    listSnapshotSummaries: vi.fn(),
    getSnapshot: vi.fn(),
    deleteSnapshot: vi.fn(),
    importSnapshot: vi.fn(),
    exportSnapshot: vi.fn(),
    planRestore: vi.fn(),
    runRestore: vi.fn(),
    getDrift: vi.fn(),
    listThemePacks: vi.fn(async () => structuredClone([PACK])),
    getThemePack: vi.fn(async () => structuredClone(PACK)),
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
  return { api, onApply };
}

function renderPacks(
  env: Environment,
  overrides: Partial<WpmApi> = {},
): {
  api: WpmApi;
  onApply: (profileId: string) => void;
} {
  const fixture = installApi(env, overrides);
  const i18n = createI18n('en');
  render(
    <I18nextProvider i18n={i18n}>
      <ThemePacks onApply={fixture.onApply} />
    </I18nextProvider>,
  );
  return fixture;
}

beforeEach(() => vi.clearAllMocks());

describe('ThemePacks', () => {
  it('reports Ready and opens the apply flow when every mod is installed', async () => {
    const { onApply } = renderPacks(
      environment([
        { modId: 'windows-11-taskbar-styler', version: '1.10' },
        { modId: 'translucent-windows', version: '1.8.2' },
      ]),
    );

    expect(await screen.findByText('All 2 required mods are installed.')).toBeTruthy();
    expect(screen.getAllByText('Ready').length).toBeGreaterThan(0);
    const apply = screen.getByRole('button', { name: 'Apply Mac Blur Glass' });
    expect((apply as HTMLButtonElement).disabled).toBe(false);
    await userEvent.setup().click(apply);
    expect(onApply).toHaveBeenCalledWith('mac-blur-glass');
  });

  it('disables apply and names a missing mod with its official link', async () => {
    const { api } = renderPacks(
      environment([{ modId: 'windows-11-taskbar-styler', version: '1.10' }]),
    );

    expect(await screen.findByText('1 required mods are missing.')).toBeTruthy();
    expect(screen.getAllByText('Translucent Windows').length).toBeGreaterThan(0);
    expect(
      (screen.getByRole('button', { name: 'Apply Mac Blur Glass' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    const link = screen.getAllByRole('button', { name: 'Open page' })[1];
    expect(link).toBeDefined();
    if (link !== undefined) await userEvent.setup().click(link);
    expect(api.openExternal).toHaveBeenCalledWith(
      'https://windhawk.net/mods/translucent-windows',
    );
  });

  it('warns about a version mismatch without blocking apply', async () => {
    renderPacks(
      environment([
        { modId: 'windows-11-taskbar-styler', version: '0.9' },
        { modId: 'translucent-windows', version: '1.8.2' },
      ]),
    );

    expect(await screen.findByText('Version mismatch')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Apply Mac Blur Glass' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('shows an installed-but-disabled mod as disabled and still allows apply', async () => {
    renderPacks(
      environment([
        { modId: 'windows-11-taskbar-styler', version: '1.10', enabled: false },
        { modId: 'translucent-windows', version: '1.8.2' },
      ]),
    );

    expect(await screen.findByText('Disabled', { exact: true })).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Apply Mac Blur Glass' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('disables apply and explains why in read-only mode', async () => {
    renderPacks(
      environment(
        [
          { modId: 'windows-11-taskbar-styler', version: '1.10' },
          { modId: 'translucent-windows', version: '1.8.2' },
        ],
        'read-only',
      ),
    );

    expect(await screen.findByText('This machine is read-only')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Apply Mac Blur Glass' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('copies the install list to the clipboard', async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText');
    renderPacks(environment([{ modId: 'windows-11-taskbar-styler', version: '1.10' }]));

    await user.click(await screen.findByRole('button', { name: 'Copy install list' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(String(writeText.mock.calls[0]?.[0])).toContain(
      'https://windhawk.net/mods/translucent-windows',
    );
    expect(await screen.findByText('Copied')).toBeTruthy();
  });

  it('refreshes the checklist from the current environment without a stale cache', async () => {
    let current = environment([{ modId: 'windows-11-taskbar-styler', version: '1.10' }]);
    const getEnvironment = vi.fn(async () => structuredClone(current));
    const user = userEvent.setup();
    renderPacks(current, { getEnvironment });

    expect(await screen.findByText('1 required mods are missing.')).toBeTruthy();
    current = environment([
      { modId: 'windows-11-taskbar-styler', version: '1.10' },
      { modId: 'translucent-windows', version: '1.8.2' },
    ]);
    await user.click(screen.getByRole('button', { name: 'Refresh' }));

    expect(await screen.findByText('All 2 required mods are installed.')).toBeTruthy();
  });

  it('shows an empty state when the bundled pack is missing', async () => {
    renderPacks(environment([]), { listThemePacks: vi.fn(async () => []) });

    expect(await screen.findByText('No theme packs found')).toBeTruthy();
  });

  it('shows a recoverable error when the environment probe fails', async () => {
    renderPacks(environment([]), {
      getEnvironment: vi.fn(async () => {
        throw new Error('probe failed');
      }),
    });

    expect(await screen.findByText('Environment status could not be read')).toBeTruthy();
    expect(screen.getByText('probe failed')).toBeTruthy();
  });
});
