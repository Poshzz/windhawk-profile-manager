// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppVersions, ApplyPlanOptions, ApplyProgressEvent, WpmApi } from '@shared/ipc';
import {
  parseApplyResult,
  type ApplyPlan,
  type ApplyResult,
  type Environment,
  type Profile,
} from '@shared/domain';
import { buildPlan } from '@core/planner/apply-planner';
import { createI18n } from '../../../src/renderer/i18n';
import { ApplyDialog } from '../../../src/renderer/screens/apply/ApplyDialog';
import {
  dword,
  makeEnvironment,
  makeProfile,
  makeSnapshot,
  managedMod,
  modKeys,
  planOptions,
  stringValue,
} from '../planner/support';

const VERSIONS: AppVersions = {
  app: '0.1.0',
  electron: '45.0.0',
  chrome: '142.0.0',
  node: '24.0.0',
};

const MOD = 'windows-11-taskbar-styler';
const PROFILE: Profile = makeProfile({ restartExplorer: 'never' });
const ENVIRONMENT: Environment = makeEnvironment({
  mods: [{ modId: MOD, version: '1.0' }],
});
const CURRENT = makeSnapshot([
  ...modKeys(MOD, {
    enabled: true,
    settings: { TaskbarHeight: dword(40), Theme: stringValue('default') },
  }),
]);
const PLAN: ApplyPlan = buildPlan(PROFILE, CURRENT, ENVIRONMENT, planOptions());

function makeResult(overrides: Partial<ApplyResult> = {}): ApplyResult {
  return parseApplyResult({
    schemaVersion: 1,
    runId: PLAN.runId,
    kind: 'apply',
    status: 'succeeded',
    message: 'Applied; reload requested, not confirmed loaded.',
    startedAt: '2026-10-22T20:00:00.000Z',
    completedAt: '2026-10-22T20:00:04.000Z',
    changedMods: [MOD],
    skippedMods: [],
    warnings: [],
    reload: {
      requested: true,
      confirmed: false,
      message: 'Applied; the Windhawk reload was requested but is not confirmed loaded.',
    },
    verification: {
      status: 'verified',
      checkedAt: '2026-10-22T20:00:04.000Z',
      message: 'Verified.',
    },
    actions: {
      rainmeter: { status: 'skipped' },
      explorer: { status: 'skipped' },
    },
    rollback: null,
    error: null,
    ...overrides,
  });
}

function installApi(overrides: Partial<WpmApi> = {}): {
  api: WpmApi;
  progress: (state: ApplyProgressEvent['state']) => void;
} {
  let listener: ((event: ApplyProgressEvent) => void) | null = null;
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
    listThemePacks: vi.fn(async () => []),
    getThemePack: vi.fn(async () => {
      throw new Error('not used');
    }),
    startService: vi.fn(),
    captureSnapshot: vi.fn(),
    planApply: vi.fn(async () => PLAN),
    runApply: vi.fn(async () => makeResult()),
    onApplyProgress: vi.fn((next: (event: ApplyProgressEvent) => void) => {
      listener = next;
      return () => undefined;
    }),
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
  return {
    api,
    progress: (state) => listener?.({ planHash: PLAN.planHash, state }),
  };
}

beforeEach(() => vi.clearAllMocks());

describe('ApplyDialog', () => {
  it('shows the plan, streams real progress, and renders the success result', async () => {
    let resolveRun!: (value: ApplyResult) => void;
    const runPromise = new Promise<ApplyResult>((resolve) => {
      resolveRun = resolve;
    });
    const { api, progress } = installApi({
      runApply: vi.fn(async () => runPromise),
    });
    Object.defineProperty(window, 'api', { configurable: true, value: api });
    const i18n = createI18n('en');
    render(
      <I18nextProvider i18n={i18n}>
        <ApplyDialog profileId="mac-blur-glass" onClose={vi.fn()} onNavigate={vi.fn()} />
      </I18nextProvider>,
    );
    const user = userEvent.setup();

    expect(await screen.findByRole('heading', { name: 'Review Mac Blur Glass' })).toBeTruthy();
    expect(screen.getByText('A snapshot will be created before any registry write.')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Apply now' }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(screen.getByText('Preflight')).toBeTruthy();
    expect(screen.getByText('Registry')).toBeTruthy();
    expect(screen.getByText(/Unchanged/)).toBeTruthy();
    expect(screen.getByText('2 settings')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Apply now' }));
    await waitFor(() => expect(api.runApply).toHaveBeenCalledTimes(1));
    expect(api.runApply).toHaveBeenCalledWith(
      'mac-blur-glass',
      expect.objectContaining({
        expectedPlanHash: PLAN.planHash,
        runId: PLAN.runId,
        snapshotId: PLAN.snapshotId,
      }),
    );

    act(() => progress('applying'));
    expect(await screen.findByText('Applying registry changes')).toBeTruthy();

    await act(async () => {
      resolveRun(makeResult());
      await runPromise;
    });
    expect(await screen.findByText('Applied; reload requested, not confirmed loaded.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'View snapshot' })).toBeTruthy();
  });

  it('returns to the plan with a neutral notice when UAC is canceled', async () => {
    const { api } = installApi({
      runApply: vi.fn(async () => {
        throw new Error('The UAC prompt was canceled; no changes were made.');
      }),
    });
    Object.defineProperty(window, 'api', { configurable: true, value: api });
    const i18n = createI18n('en');
    render(
      <I18nextProvider i18n={i18n}>
        <ApplyDialog profileId="mac-blur-glass" onClose={vi.fn()} onNavigate={vi.fn()} />
      </I18nextProvider>,
    );
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Apply now' }));

    expect(await screen.findByText(/UAC prompt was canceled/)).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Apply now' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('requires a second confirmation for delete-all settings', async () => {
    const emptyProfile = makeProfile({
      requiredMods: [managedMod({ modId: MOD, settings: {} })],
      restartExplorer: 'never',
    });
    const unconfirmed = buildPlan(emptyProfile, CURRENT, ENVIRONMENT, planOptions());
    const confirmed = buildPlan(
      emptyProfile,
      CURRENT,
      ENVIRONMENT,
      planOptions({ confirmDeleteAllSettings: true }),
    );
    const planApply = vi.fn(
      async (_id: string, options?: ApplyPlanOptions) =>
        options?.confirmDeleteAllSettings === true ? confirmed : unconfirmed,
    );
    const { api } = installApi({ planApply, listProfiles: vi.fn(async () => [emptyProfile]) });
    Object.defineProperty(window, 'api', { configurable: true, value: api });
    const i18n = createI18n('en');
    render(
      <I18nextProvider i18n={i18n}>
        <ApplyDialog profileId="mac-blur-glass" onClose={vi.fn()} onNavigate={vi.fn()} />
      </I18nextProvider>,
    );
    const user = userEvent.setup();

    const applyButton = await screen.findByRole('button', { name: 'Apply now' });
    expect((applyButton as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole('checkbox'));
    await waitFor(() =>
      expect(planApply).toHaveBeenLastCalledWith(
        'mac-blur-glass',
        expect.objectContaining({ confirmDeleteAllSettings: true }),
      ),
    );
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Apply now' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
  });

  it('shows manual recovery instructions for a rollback failure', async () => {
    const { api } = installApi({
      runApply: vi.fn(async () =>
        makeResult({
          status: 'rollback-failed',
          message:
            'Automatic rollback failed. The journal and snapshot were kept. Restore this snapshot manually.',
          rollback: { status: 'failed', message: 'rollback failed' },
          verification: { status: 'not-verified', checkedAt: null, message: 'not verified' },
          error: {
            code: 'ROLLBACK_FAILED',
            name: 'RollbackError',
            message: 'rollback failed',
            details: [],
          },
        }),
      ),
    });
    Object.defineProperty(window, 'api', { configurable: true, value: api });
    const i18n = createI18n('en');
    render(
      <I18nextProvider i18n={i18n}>
        <ApplyDialog profileId="mac-blur-glass" onClose={vi.fn()} onNavigate={vi.fn()} />
      </I18nextProvider>,
    );
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Apply now' }));

    expect(await screen.findByText('Rollback failed')).toBeTruthy();
    expect(screen.getByText(/Restore this snapshot manually/)).toBeTruthy();
    expect(screen.getByText('ROLLBACK_FAILED: RollbackError')).toBeTruthy();
  });
});
