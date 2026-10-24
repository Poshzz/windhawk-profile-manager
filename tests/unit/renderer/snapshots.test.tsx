// @vitest-environment jsdom
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ApplyProgressEvent,
  AppVersions,
  SnapshotDetail,
  SnapshotSummary,
  WpmApi,
} from '@shared/ipc';
import {
  parseApplyResult,
  parsePlan,
  parseRegistrySnapshot,
  parseSnapshotMetadata,
  type ApplyResult,
  type RegistrySnapshot,
  type RestorePlan,
  type SnapshotMetadata,
  type SnapshotTrigger,
} from '@shared/domain';
import { createI18n } from '../../../src/renderer/i18n';
import { Snapshots } from '../../../src/renderer/screens/Snapshots';

const VERSIONS: AppVersions = {
  app: '0.1.0',
  electron: '45.0.0',
  chrome: '142.0.0',
  node: '24.0.0',
};

const RUN_ID = 'run-2026-10-22T20-05-00-000Z';
const RESTORE_SNAPSHOT_ID = '2026-10-22T20-05-00-000Z';
const PLAN_HASH = `sha256:${'c'.repeat(64)}`;

const SNAPSHOTS_EN = {
  eyebrow: 'History',
  title: 'Snapshots',
  body: 'Review snapshot evidence, verify checksums, restore a captured state, and export or delete .reg files.',
  refresh: 'Refresh',
  loading: 'Loading snapshots…',
  errorTitle: 'Snapshots could not be read',
  timeline: 'Timeline',
  timelineLabel: 'Snapshot timeline',
  count: '{{count}} snapshots',
  retained: 'Retained',
  automatic: 'Automatic',
  noProfile: 'No profile',
  profile: 'Profile {{id}}',
  modCount: '{{count}} mods',
  trigger: {
    preApply: 'Pre-apply',
    preRestore: 'Pre-restore',
    manual: 'Manual',
    imported: 'Imported',
  },
  actions: {
    import: 'Import .reg snapshot',
    importing: 'Importing…',
    restore: 'Restore',
    export: 'Export .reg',
    exporting: 'Exporting…',
    delete: 'Delete',
  },
  size: {
    bytes: 'B',
    kb: 'KB',
    mb: 'MB',
    unknown: 'Unknown size',
  },
  storage: {
    registry: 'Registry',
    portable: 'Portable',
    unknown: 'Unknown',
  },
  service: {
    running: 'running',
    stopped: 'stopped',
    missing: 'missing',
    unknown: 'unknown',
  },
  retention: {
    title: 'Retention',
    body: 'The 20 newest automatic snapshots are kept. Manual and imported snapshots stay until you delete them. Snapshots are stored with user-only access and are never uploaded.',
    link: 'Retention settings',
  },
  empty: {
    title: 'No snapshots yet',
    body: 'A snapshot is created automatically before every apply. Apply a profile to create one, or import a .reg file as evidence.',
    action: 'Choose a profile',
  },
  row: {
    expand: 'Show details for snapshot from {{at}}',
    collapse: 'Hide details for snapshot from {{at}}',
  },
  detail: {
    label: 'Snapshot details',
    captured: 'Captured',
    trigger: 'Trigger',
    profile: 'Profile',
    mods: 'Mods',
    size: 'Size',
    windowsBuild: 'Windows build',
    windhawkVersion: 'Windhawk version',
    storageMode: 'Storage',
    serviceState: 'Service at capture',
    rainmeter: 'Rainmeter at capture',
    rainmeterRunning: 'Running',
    rainmeterNotRunning: 'Not running',
    id: 'Snapshot ID',
    registryFile: 'Registry file',
    checksum: 'SHA-256',
    checkingChecksum: 'Checking checksum…',
    checksumVerified: 'Checksum verified',
    checksumError: 'Checksum could not be verified',
  },
  importSuccessTitle: 'Snapshot imported',
  importSuccessBody: 'Snapshot {{id}} was added with {{count}} mods.',
  importErrorTitle: 'Import failed',
  exportSuccessTitle: 'Snapshot exported',
  exportSuccessBody: 'Saved to {{path}}',
  exportErrorTitle: 'Export failed',
  deleteSuccessTitle: 'Snapshot deleted',
  deleteSuccessBody: 'Snapshot from {{date}} was deleted.',
  delete: {
    title: 'Delete this snapshot?',
    body: 'This deletes the snapshot metadata and its .reg evidence file. It cannot be undone.',
    confirm: 'Delete snapshot',
    pending: 'Deleting…',
    errorTitle: 'Snapshot could not be deleted',
  },
  restore: {
    title: 'Restore this snapshot?',
    description: 'Review what a restore changes before Windows asks for administrator approval.',
    fullState:
      'This is a full-state restore: every captured mod is reverted, including unlisted mods.',
    noDlls: 'Mod DLLs and ModsWritable mod storage are not restored.',
    preRestore: 'A pre-restore snapshot is created before the first registry write.',
    service: 'The Windhawk service stays running; the engine reloads changed settings.',
    newerMods: 'Mods installed after this snapshot are left in place.',
    missingKeys: 'Captured mods whose registry key no longer exists are skipped and listed.',
    warningsTitle: 'Warnings',
    planSummaryTitle: 'Planned writes',
    writes: 'Registry operations',
    writesValue: '{{set}} set, {{deleted}} deleted across {{mods}} mods',
    targetingTitle: 'This snapshot restores machine-specific targeting',
    targetingBody: 'These values control which processes receive the mod.',
    targetingConfirm: 'I understand these targeting values will be written',
    targetingConfirmBody: 'Review the values above before restoring.',
    loadingPlan: 'Building the restore plan…',
    errorTitle: 'Restore could not continue',
    restoreNow: 'Restore now',
    cannotClose: 'Restore in progress — cannot close',
    progressHeading: 'Restoring snapshot',
    progressBody:
      'The run cannot be interrupted after elevation. The service stays running while captured values are reconciled.',
    progressLabel: 'Restore progress',
    stepsLabel: 'Restore steps',
    progress: {
      preflight: 'Preflight',
      snapshotting: 'Snapshot',
      journaling: 'Journal',
      applying: 'Applying registry changes',
      settling: 'Settling',
      verifying: 'Verifying',
      finishing: 'Finishing',
      rollingBack: 'Rolling back',
    },
    status: {
      succeeded: 'Restored',
      'succeeded-with-warning': 'Restored with warnings',
      'rolled-back': 'Rolled back',
      'rollback-failed': 'Rollback failed',
      failed: 'Restore failed',
      canceled: 'Canceled',
      'dry-run': 'Dry run',
    },
    preRestoreKept: 'A pre-restore snapshot was created and is available in the list.',
    rolledBackTitle: 'Restore rolled back',
    rolledBackBody:
      'The registry was returned to its pre-restore state. The pre-restore snapshot is still available.',
    manualRecoveryTitle: 'Manual recovery needed',
    manualRecoveryBody:
      'Automatic rollback failed. The pre-restore snapshot was kept. Restore it from the list, or review the journal before closing Windhawk.',
    failedBody: 'The pre-restore snapshot is kept so you can try again or roll back manually.',
    rollbackResult: 'Rollback: {{status}} — {{message}}',
    skippedTitle: 'Skipped mods',
    uacCanceled: 'The UAC prompt was canceled; no changes were made.',
  },
};

interface SummaryOptions {
  readonly id: string;
  readonly createdAt: string;
  readonly trigger: SnapshotTrigger;
  readonly profileId?: string | null;
  readonly modCount?: number;
  readonly sizeBytes?: number;
  readonly retained?: boolean;
  readonly digest?: string;
}

function makeMetadata(options: SummaryOptions): SnapshotMetadata {
  return parseSnapshotMetadata({
    schemaVersion: 1,
    id: options.id,
    createdAt: options.createdAt,
    trigger: options.trigger,
    profileId: options.profileId ?? null,
    appVersion: '0.1.0',
    windowsBuild: '22631',
    registryView: '64-bit',
    windhawkVersion: '1.7.3',
    windhawkStorageMode: 'registry',
    windhawkRegistryRoot: 'HKLM\\SOFTWARE\\Windhawk',
    windhawkServiceName: 'Windhawk',
    windhawkServiceState: 'running',
    rainmeterRunning: false,
    registryFile: `${options.id}.reg`,
    registrySha256: `sha256:${(options.digest ?? 'a').repeat(64)}`,
    modCount: options.modCount ?? 2,
    scope: 'engine-mods-configuration',
    excludedPaths: [],
  });
}

function makeSummary(options: SummaryOptions): SnapshotSummary {
  return {
    metadata: makeMetadata(options),
    retained: options.retained ?? !['pre-apply', 'pre-restore'].includes(options.trigger),
    sizeBytes: options.sizeBytes ?? 2048,
  };
}

function makeRegistrySnapshot(): RegistrySnapshot {
  return parseRegistrySnapshot({
    schemaVersion: 1,
    capturedAt: '2026-10-22T20:00:00.000Z',
    registryView: '64-bit',
    keys: [
      {
        path: 'HKLM\\SOFTWARE\\Windhawk\\Engine\\Mods\\windows-11-taskbar-styler',
        values: [{ name: 'Disabled', value: { type: 'dword', value: 0 } }],
      },
    ],
  });
}

function makeDetail(summary: SnapshotSummary): SnapshotDetail {
  return { metadata: summary.metadata, registry: makeRegistrySnapshot() };
}

function makeRestorePlan(sourceSnapshotId: string): RestorePlan {
  const plan = parsePlan({
    schemaVersion: 1,
    kind: 'restore',
    runId: RUN_ID,
    snapshotId: RESTORE_SNAPSHOT_ID,
    profileId: null,
    profileRevision: 0,
    beforeHash: `sha256:${'b'.repeat(64)}`,
    actions: { rainmeter: 'unchanged', restartExplorer: 'ask' },
    planHash: PLAN_HASH,
    sourceSnapshotId,
    paths: {
      plan: `C:\\ProgramData\\WindhawkProfileManager\\runs\\${RUN_ID}\\plan.json`,
      snapshotRegistry: `C:\\Users\\Test\\AppData\\Local\\WindhawkProfileManager\\snapshots\\${RESTORE_SNAPSHOT_ID}.reg`,
      journal: 'C:\\Users\\Test\\AppData\\Local\\WindhawkProfileManager\\journal.json',
      result: `C:\\ProgramData\\WindhawkProfileManager\\runs\\${RUN_ID}\\result.json`,
      sourceSnapshotRegistry: `C:\\Users\\Test\\AppData\\Local\\WindhawkProfileManager\\snapshots\\${sourceSnapshotId}.reg`,
    },
    warnings: [],
  });
  if (plan.kind !== 'restore') throw new Error('Expected a restore plan fixture.');
  return plan;
}

function makeResult(overrides: Partial<ApplyResult> = {}): ApplyResult {
  return parseApplyResult({
    schemaVersion: 1,
    runId: RUN_ID,
    kind: 'restore',
    status: 'succeeded',
    message: 'Restored 2 mods; the Windhawk service stayed running.',
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
    actions: {
      rainmeter: { status: 'skipped' },
      explorer: { status: 'skipped' },
    },
    rollback: null,
    error: null,
    ...overrides,
  });
}

interface ApiHarness {
  readonly api: WpmApi;
  readonly progress: (state: ApplyProgressEvent['state'], planHash?: string) => void;
}

function installApi(overrides: Partial<WpmApi> = {}): ApiHarness {
  let listener: ((event: ApplyProgressEvent) => void) | null = null;
  const api: WpmApi = {
    ping: vi.fn(),
    getVersions: vi.fn(async () => VERSIONS),
    getConfig: vi.fn(),
    getEnvironment: vi.fn(),
    listProfiles: vi.fn(async () => []),
    getProfile: vi.fn(),
    createProfile: vi.fn(),
    updateProfile: vi.fn(),
    deleteProfile: vi.fn(),
    duplicateProfile: vi.fn(),
    captureProfile: vi.fn(),
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
    listSnapshots: vi.fn(async () => []),
    listSnapshotSummaries: vi.fn(async () => []),
    getSnapshot: vi.fn(async (id: string) => {
      throw new Error(`Snapshot "${id}" was not expected.`);
    }),
    deleteSnapshot: vi.fn(async () => undefined),
    importSnapshot: vi.fn(async () => null),
    exportSnapshot: vi.fn(async () => null),
    planRestore: vi.fn(async (id: string) => makeRestorePlan(id)),
    runRestore: vi.fn(async () => makeResult()),
    getDrift: vi.fn(),
    listThemePacks: vi.fn(async () => []),
    getThemePack: vi.fn(),
    startService: vi.fn(),
    captureSnapshot: vi.fn(),
    planApply: vi.fn(),
    runApply: vi.fn(),
    onApplyProgress: vi.fn((next: (event: ApplyProgressEvent) => void) => {
      listener = next;
      return () => {
        listener = null;
      };
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
  Object.defineProperty(window, 'api', { configurable: true, value: api });
  return {
    api,
    progress: (state, planHash = PLAN_HASH) => listener?.({ planHash, state }),
  };
}

interface RenderOptions {
  readonly summaries?: readonly SnapshotSummary[];
  readonly api?: Partial<WpmApi>;
}

function renderSnapshots(options: RenderOptions = {}): {
  api: WpmApi;
  onNavigate: ReturnType<typeof vi.fn>;
  progress: ApiHarness['progress'];
} {
  const summaries = options.summaries ?? [];
  const harness = installApi({
    listSnapshotSummaries: vi.fn(async () => structuredClone([...summaries])),
    ...options.api,
  });
  const onNavigate = vi.fn((_screen: 'settings' | 'profiles'): void => undefined);
  const i18n = createI18n('en');
  i18n.addResourceBundle('en', 'translation', { snapshots: SNAPSHOTS_EN }, true, true);
  render(
    <I18nextProvider i18n={i18n}>
      <Snapshots onNavigate={onNavigate} />
    </I18nextProvider>,
  );
  return { api: harness.api, onNavigate, progress: harness.progress };
}

async function firstRow(): Promise<HTMLElement> {
  const rows = await screen.findAllByRole('listitem');
  const row = rows[0];
  if (row === undefined) throw new Error('No snapshot row was rendered.');
  return row;
}

beforeEach(() => vi.clearAllMocks());

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Snapshots', () => {
  it('lists snapshots newest first with trigger, profile, mods, size, and retention marker', async () => {
    const manual = makeSummary({
      id: '2026-10-22T20-00-00-000Z',
      createdAt: '2026-10-22T20:00:00.000Z',
      trigger: 'manual',
      profileId: null,
      modCount: 4,
      sizeBytes: 1536,
      retained: true,
    });
    const automatic = makeSummary({
      id: '2026-10-22T19-00-00-000Z',
      createdAt: '2026-10-22T19:00:00.000Z',
      trigger: 'pre-apply',
      profileId: 'mac-blur-glass',
      modCount: 2,
      sizeBytes: 524288,
      retained: false,
    });
    renderSnapshots({ summaries: [automatic, manual] });

    const rows = await screen.findAllByRole('listitem');
    expect(rows).toHaveLength(2);
    const newest = rows[0];
    const oldest = rows[1];
    if (newest === undefined || oldest === undefined) throw new Error('Rows missing');

    expect(within(newest).getByText('Manual')).toBeTruthy();
    expect(within(newest).getByText('No profile')).toBeTruthy();
    expect(within(newest).getByText('4 mods')).toBeTruthy();
    expect(within(newest).getByText('1.5 KB')).toBeTruthy();
    expect(within(newest).getByText('Retained')).toBeTruthy();

    expect(within(oldest).getByText('Pre-apply')).toBeTruthy();
    expect(within(oldest).getByText(/mac-blur-glass/)).toBeTruthy();
    expect(within(oldest).getByText('2 mods')).toBeTruthy();
    expect(within(oldest).getByText('512 KB')).toBeTruthy();
    expect(within(oldest).getByText('Automatic')).toBeTruthy();
  });

  it('verifies a snapshot checksum when its row expands', async () => {
    const digest = 'b';
    const summary = makeSummary({
      id: '2026-10-22T20-00-00-000Z',
      createdAt: '2026-10-22T20:00:00.000Z',
      trigger: 'pre-apply',
      profileId: 'mac-blur-glass',
      digest,
    });
    const getSnapshot = vi.fn(async () => structuredClone(makeDetail(summary)));
    renderSnapshots({ summaries: [summary], api: { getSnapshot } });
    const user = userEvent.setup();

    const row = await firstRow();
    await user.click(within(row).getByRole('button'));

    expect(await screen.findByText('Checksum verified')).toBeTruthy();
    expect(getSnapshot).toHaveBeenCalledWith(summary.metadata.id);
    expect(screen.getByText(`sha256:${digest.repeat(64)}`)).toBeTruthy();
    expect(screen.getByText('1.7.3')).toBeTruthy();
    expect(screen.getByText('22631')).toBeTruthy();
  });

  it('imports a snapshot and treats a canceled import as a silent no-op', async () => {
    const existing = makeSummary({
      id: '2026-10-22T19-00-00-000Z',
      createdAt: '2026-10-22T19:00:00.000Z',
      trigger: 'pre-apply',
    });
    const imported = makeSummary({
      id: '2026-10-23T08-00-00-000Z',
      createdAt: '2026-10-23T08:00:00.000Z',
      trigger: 'imported',
      modCount: 3,
      sizeBytes: 2048,
    });
    const importSnapshot = vi
      .fn()
      .mockResolvedValueOnce(structuredClone(imported))
      .mockResolvedValueOnce(null);
    renderSnapshots({
      summaries: [existing],
      api: { importSnapshot },
    });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Import .reg snapshot' }));

    expect(await screen.findByText('Snapshot imported')).toBeTruthy();
    expect(importSnapshot).toHaveBeenCalledTimes(1);
    const rows = await screen.findAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toBeDefined();
    if (rows[0] === undefined) throw new Error('Imported row missing');
    expect(within(rows[0]).getByText('Imported')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(screen.queryByText('Snapshot imported')).toBeNull());

    await user.click(screen.getByRole('button', { name: 'Import .reg snapshot' }));
    await waitFor(() => expect(importSnapshot).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('Snapshot imported')).toBeNull();
    expect(screen.queryByText('Import failed')).toBeNull();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('exports a snapshot and treats a canceled export as a silent no-op', async () => {
    const summary = makeSummary({
      id: '2026-10-22T20-00-00-000Z',
      createdAt: '2026-10-22T20:00:00.000Z',
      trigger: 'manual',
      retained: true,
    });
    const exportSnapshot = vi
      .fn()
      .mockResolvedValueOnce('C:\\Users\\Test\\Desktop\\snapshot.reg')
      .mockResolvedValueOnce(null);
    renderSnapshots({ summaries: [summary], api: { exportSnapshot } });
    const user = userEvent.setup();

    const row = await firstRow();
    await user.click(within(row).getByRole('button'));
    await user.click(await within(row).findByRole('button', { name: 'Export .reg' }));

    expect(await screen.findByText('Snapshot exported')).toBeTruthy();
    expect(exportSnapshot).toHaveBeenCalledWith(summary.metadata.id);
    expect(screen.getByText(/snapshot\.reg/)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(screen.queryByText('Snapshot exported')).toBeNull());

    await user.click(within(row).getByRole('button', { name: 'Export .reg' }));
    await waitFor(() => expect(exportSnapshot).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('Snapshot exported')).toBeNull();
  });

  it('shows an export error', async () => {
    const summary = makeSummary({
      id: '2026-10-22T20-00-00-000Z',
      createdAt: '2026-10-22T20:00:00.000Z',
      trigger: 'manual',
      retained: true,
    });
    const exportSnapshot = vi.fn(async () => {
      throw new Error('The export folder is not writable.');
    });
    renderSnapshots({ summaries: [summary], api: { exportSnapshot } });
    const user = userEvent.setup();

    const row = await firstRow();
    await user.click(within(row).getByRole('button'));
    await user.click(await within(row).findByRole('button', { name: 'Export .reg' }));

    expect(await screen.findByText('Export failed')).toBeTruthy();
    expect(screen.getByText('The export folder is not writable.')).toBeTruthy();
  });

  it('deletes a snapshot after confirmation and removes it from the list', async () => {
    const summary = makeSummary({
      id: '2026-10-22T20-00-00-000Z',
      createdAt: '2026-10-22T20:00:00.000Z',
      trigger: 'manual',
      retained: true,
    });
    const deleteSnapshot = vi.fn(async () => undefined);
    renderSnapshots({ summaries: [summary], api: { deleteSnapshot } });
    const user = userEvent.setup();

    const row = await firstRow();
    await user.click(within(row).getByRole('button'));
    await user.click(await within(row).findByRole('button', { name: 'Delete' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Delete this snapshot?')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Delete snapshot' }));

    await waitFor(() => expect(deleteSnapshot).toHaveBeenCalledWith(summary.metadata.id));
    expect(await screen.findByText('Snapshot deleted')).toBeTruthy();
    expect(await screen.findByText('No snapshots yet')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps the delete dialog open and shows the active-journal rejection', async () => {
    const summary = makeSummary({
      id: '2026-10-22T20-00-00-000Z',
      createdAt: '2026-10-22T20:00:00.000Z',
      trigger: 'pre-apply',
    });
    const deleteSnapshot = vi.fn(async () => {
      throw new Error(
        `Snapshot "${summary.metadata.id}" is referenced by an unfinished journal and cannot be deleted.`,
      );
    });
    renderSnapshots({ summaries: [summary], api: { deleteSnapshot } });
    const user = userEvent.setup();

    const row = await firstRow();
    await user.click(within(row).getByRole('button'));
    await user.click(await within(row).findByRole('button', { name: 'Delete' }));

    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Delete snapshot' }));

    expect(await within(dialog).findByText(/unfinished journal/)).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getAllByRole('listitem', { hidden: true })).toHaveLength(1);
    expect(deleteSnapshot).toHaveBeenCalledWith(summary.metadata.id);
  });

  it('plans a restore, streams progress, and refreshes after success', async () => {
    const summary = makeSummary({
      id: '2026-10-22T20-00-00-000Z',
      createdAt: '2026-10-22T20:00:00.000Z',
      trigger: 'pre-apply',
      profileId: 'mac-blur-glass',
    });
    const plan = makeRestorePlan(summary.metadata.id);
    const listSnapshotSummaries = vi.fn(async () => [structuredClone(summary)]);
    const planRestore = vi.fn(async () => structuredClone(plan));
    let resolveRun!: (value: ApplyResult) => void;
    const runPromise = new Promise<ApplyResult>((resolve) => {
      resolveRun = resolve;
    });
    const runRestore = vi.fn(async () => runPromise);
    const { progress } = renderSnapshots({
      api: { listSnapshotSummaries, planRestore, runRestore },
    });
    const dispatch = vi.spyOn(window, 'dispatchEvent');
    const user = userEvent.setup();

    const row = await screen.findByRole('listitem');
    await user.click(within(row).getByRole('button'));
    await user.click(await within(row).findByRole('button', { name: 'Restore' }));

    const dialog = await screen.findByRole('dialog');
    expect(planRestore).toHaveBeenCalledWith(summary.metadata.id);
    expect(within(dialog).getByText(/full-state restore/)).toBeTruthy();
    expect(within(dialog).getByText(/Mod DLLs and ModsWritable/)).toBeTruthy();
    expect(within(dialog).getByText(/pre-restore snapshot is created/)).toBeTruthy();
    expect(within(dialog).getByText(/service stays running/)).toBeTruthy();
    expect(within(dialog).getByText(/installed after this snapshot/)).toBeTruthy();
    expect(within(dialog).getByText(/no longer exists/)).toBeTruthy();
    expect(within(dialog).getByText('Planned writes')).toBeTruthy();
    expect(within(dialog).getByText(/0 set, 0 deleted across 0 mods/)).toBeTruthy();

    await user.click(within(dialog).getByRole('button', { name: 'Restore now' }));
    await waitFor(() => expect(runRestore).toHaveBeenCalledTimes(1));
    expect(runRestore).toHaveBeenCalledWith({
      sourceSnapshotId: plan.sourceSnapshotId,
      expectedPlanHash: plan.planHash,
      runId: plan.runId,
      snapshotId: plan.snapshotId,
    });
    expect(
      (
        within(dialog).getByRole('button', {
          name: 'Restore in progress — cannot close',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('0');

    act(() => progress('applying'));
    await waitFor(() =>
      expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('3'),
    );

    await act(async () => {
      resolveRun(makeResult());
      await runPromise;
    });

    expect(
      await screen.findByText('Restored 2 mods; the Windhawk service stayed running.'),
    ).toBeTruthy();
    expect(screen.getByText('Restored')).toBeTruthy();
    expect(screen.getByText(/pre-restore snapshot was created/)).toBeTruthy();
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'wpm:applied' }));
    expect(listSnapshotSummaries.mock.calls.length).toBeGreaterThan(1);
  });

  it('requires explicit confirmation before restoring captured targeting values', async () => {
    const summary = makeSummary({
      id: '2026-10-22T20-00-00-000Z',
      createdAt: '2026-10-22T20:00:00.000Z',
      trigger: 'imported',
      profileId: null,
    });
    const plan: RestorePlan = {
      ...makeRestorePlan(summary.metadata.id),
      targetingValues: [{ modId: 'windows-11-taskbar-styler', name: 'Include', value: '*.exe' }],
      targetingConfirmed: false,
    };
    const runRestore = vi.fn(async () => makeResult());
    const { api } = renderSnapshots({
      summaries: [summary],
      api: { planRestore: vi.fn(async () => structuredClone(plan)), runRestore },
    });
    const user = userEvent.setup();

    const row = await screen.findByRole('listitem');
    await user.click(within(row).getByRole('button'));
    await user.click(await within(row).findByRole('button', { name: 'Restore' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('This snapshot restores machine-specific targeting')).toBeTruthy();
    expect(within(dialog).getByText(/Include/)).toBeTruthy();
    const restoreButton = within(dialog).getByRole('button', { name: 'Restore now' }) as HTMLButtonElement;
    expect(restoreButton.disabled).toBe(true);

    await user.click(within(dialog).getByRole('checkbox'));
    await waitFor(() => expect(restoreButton.disabled).toBe(false));
    await user.click(restoreButton);

    await waitFor(() =>
      expect(runRestore).toHaveBeenCalledWith(
        expect.objectContaining({
          confirmTargeting: true,
          expectedPlanHash: plan.planHash,
        }),
      ),
    );
    expect(api).toBeDefined();
  });

  it('shows manual recovery instructions when rollback fails', async () => {
    const summary = makeSummary({
      id: '2026-10-22T20-00-00-000Z',
      createdAt: '2026-10-22T20:00:00.000Z',
      trigger: 'pre-apply',
    });
    const listSnapshotSummaries = vi.fn(async () => [structuredClone(summary)]);
    const planRestore = vi.fn(async () => makeRestorePlan(summary.metadata.id));
    const runRestore = vi.fn(async () =>
      makeResult({
        status: 'rollback-failed',
        message: 'Automatic rollback failed. The journal and snapshot were kept.',
        rollback: { status: 'failed', message: 'rollback failed' },
        verification: {
          status: 'not-verified',
          checkedAt: null,
          message: 'not verified',
        },
        error: {
          code: 'ROLLBACK_FAILED',
          name: 'RollbackError',
          message: 'rollback failed',
          details: [],
        },
      }),
    );
    renderSnapshots({
      summaries: [summary],
      api: { listSnapshotSummaries, planRestore, runRestore },
    });
    const dispatch = vi.spyOn(window, 'dispatchEvent');
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: /Show details/ }));
    await user.click(await screen.findByRole('button', { name: 'Restore' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Restore now' }));

    expect(await screen.findByText('Manual recovery needed')).toBeTruthy();
    expect(screen.getByText(/pre-restore snapshot was kept/)).toBeTruthy();
    expect(
      screen.getByText('Automatic rollback failed. The journal and snapshot were kept.'),
    ).toBeTruthy();
    expect(screen.getByText('Rollback failed')).toBeTruthy();
    expect(screen.getByText('ROLLBACK_FAILED: RollbackError')).toBeTruthy();
    expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'wpm:applied' }));
    expect(listSnapshotSummaries.mock.calls.length).toBeGreaterThan(1);
  });

  it('shows the empty state with profile and settings navigation', async () => {
    const { onNavigate } = renderSnapshots({ summaries: [] });
    const user = userEvent.setup();

    expect(await screen.findByText('No snapshots yet')).toBeTruthy();
    expect(screen.getByText(/created automatically before every apply/)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Choose a profile' }));
    expect(onNavigate).toHaveBeenCalledWith('profiles');

    await user.click(screen.getByRole('button', { name: 'Retention settings' }));
    expect(onNavigate).toHaveBeenCalledWith('settings');
  });

  it('shows a list error and recovers through retry', async () => {
    const listSnapshotSummaries = vi
      .fn()
      .mockRejectedValueOnce(new Error('Snapshot directory is unreadable.'))
      .mockResolvedValueOnce([]);
    renderSnapshots({ api: { listSnapshotSummaries } });
    const user = userEvent.setup();

    expect(await screen.findByText('Snapshots could not be read')).toBeTruthy();
    expect(screen.getByText('Snapshot directory is unreadable.')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('No snapshots yet')).toBeTruthy();
    expect(listSnapshotSummaries).toHaveBeenCalledTimes(2);
  });
});
