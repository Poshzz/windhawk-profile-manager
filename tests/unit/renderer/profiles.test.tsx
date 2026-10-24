// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WpmApi } from '@shared/ipc';
import {
  parseAppState,
  parseProfile,
  type AppState,
  type Environment,
  type Profile,
} from '@shared/domain';
import { createI18n } from '../../../src/renderer/i18n';
import { Profiles } from '../../../src/renderer/screens/Profiles';
import {
  dword,
  makeEnvironment,
  makeProfile,
  managedMod,
  stringValue,
} from '../planner/support';

const PROFILES_EN = {
  eyebrow: 'Profile library',
  title: 'Profiles',
  body: 'Switch between complete Windhawk setups. Capture the current machine, edit a copy, and keep built-in profiles read-only.',
  refresh: 'Refresh',
  actions: {
    createBlank: 'Create blank',
    creating: 'Creating…',
    capture: 'Capture current setup',
    import: 'Import',
    importing: 'Importing…',
    apply: 'Apply',
    edit: 'Edit',
    duplicate: 'Duplicate',
    duplicating: 'Duplicating…',
    delete: 'Delete',
    export: 'Export',
    exporting: 'Exporting…',
  },
  newProfileName: 'New profile',
  source: { builtin: 'Built-in', user: 'User', imported: 'Imported' },
  section: { builtin: 'Built-in profiles', user: 'Your profiles' },
  managedMods: '{{count}} managed mods',
  missingMods: '{{count}} missing',
  missingUnknown: 'Missing mods unknown',
  missingHint:
    'Apply skips missing mods and reports them. Install them in Windhawk for the full setup.',
  allModsInstalled: 'All mods installed',
  active: 'Active',
  lastApplied: 'Last applied {{at}}',
  never: 'never',
  basedOn: 'Based on {{name}}',
  builtInReadOnly: 'Read-only. Duplicate this profile to customize it.',
  zeroManaged: 'No managed mods',
  applyUnavailable: 'Apply is unavailable on this machine.',
  applyUnavailableZero: 'Apply is unavailable because this profile manages no mods.',
  emptyTitle: 'No profiles found',
  emptyBody: 'Capture the current Windhawk setup to create your first profile.',
  emptyUserTitle: 'No user profiles yet',
  emptyUserBody:
    'Capture the current Windhawk setup, or start blank and add mods in the editor.',
  loading: 'Loading profiles…',
  profilesErrorTitle: 'Profiles could not be read',
  environmentErrorTitle: 'Windhawk status could not be read',
  environmentErrorBody:
    'Missing-mod counts are unknown until the status refreshes. {{message}}',
  stateErrorTitle: 'Active profile status could not be read',
  importSuccessTitle: 'Profile imported',
  importSuccessBody: '"{{name}}" was added to your profiles.',
  importErrorTitle: 'Import failed',
  exportSuccessTitle: 'Profile exported',
  exportSuccessBody: 'Saved to {{path}}',
  exportErrorTitle: 'Export failed',
  createErrorTitle: 'Could not create a blank profile',
  duplicateSuccessTitle: 'Profile duplicated',
  duplicateSuccessBody: '"{{name}}" is ready to edit.',
  duplicateErrorTitle: 'Duplicate failed',
  deleteSuccessTitle: 'Profile deleted',
  deleteSuccessBody: '"{{name}}" was deleted. Snapshots are unchanged.',
  deleteErrorTitle: 'Delete failed',
  delete: {
    title: 'Delete {{name}}?',
    body: 'This profile will be removed. Snapshots are never deleted.',
    confirm: 'Delete profile',
    pending: 'Deleting…',
  },
  capture: {
    title: 'Capture current setup',
    description:
      'Create a profile from the Windhawk mods and settings on this machine.',
    name: 'Profile name',
    namePlaceholder: 'My setup',
    defaultName: 'My setup — {{date}}',
    nameRequired: 'Enter a profile name.',
    summaryTitle: 'Capture summary',
    summaryInstalled: '{{count}} installed mods',
    summaryEnabled: '{{count}} enabled',
    summarySettings: '{{count}} setting values',
    summaryIncluded: '{{count}} mods will be captured with this choice.',
    includeDisabled: 'Include disabled mods',
    includeDisabledBody:
      'Disabled mods keep their settings and disabled state in the captured profile.',
    note: 'Only string and dword settings are captured. Include, Exclude, Architecture, and other targeting values stay with Windhawk.',
    submit: 'Capture profile',
    pending: 'Capturing…',
    successTitle: 'Profile captured',
    successBody: '"{{name}}" now reproduces this machine\'s current setup.',
    openProfile: 'Open profile',
    errorTitle: 'Capture failed',
    environmentUnavailable:
      'Windhawk status could not be read. Capture may fail until the environment refreshes.',
  },
  editor: {
    eyebrow: 'Profile editor',
    title: 'Edit {{name}}',
    description:
      'Choose the installed mods this profile manages, their desired state, and the actions applied with it.',
    back: 'Back to profiles',
    detailsTitle: 'Profile details',
    name: 'Name',
    nameRequired: 'A profile name is required.',
    descriptionLabel: 'Description',
    descriptionPlaceholder: 'What is this profile for?',
    save: 'Save profile',
    saving: 'Saving…',
    saved: 'Profile saved',
    savedBody: '"{{name}}" was saved.',
    saveError: 'Profile could not be saved',
    staleTitle: 'This profile changed',
    staleBody:
      'Another edit changed this profile. Reload the latest revision before saving again.',
    reload: 'Reload profile',
    reloading: 'Reloading…',
    reloadError: 'Profile could not be reloaded',
    zeroManagedTitle: 'This profile manages no mods',
    zeroManagedBody:
      'Saving is allowed, but apply is unavailable until you add at least one mod.',
    missingTitle: 'Some managed mods are missing',
    missingBody:
      '{{count}} managed mods are not installed. You can save; apply will skip them and report it.',
    modsTitle: 'Managed mods',
    modsBody:
      'Check an installed mod to make this profile manage it. Unchecked mods are left untouched.',
    modeHint:
      "Replace treats this profile's settings as complete and deletes values it omits. Merge writes these values and leaves the rest.",
    newModMergeHint:
      'Newly added mods start in merge mode so their existing settings survive until settings are captured.',
    noInstalledMods: 'No installed mods were found. Capture needs at least one installed mod.',
    missingBadge: 'Missing',
    unknownBadge: 'Install status unknown',
    installedDescription: 'Installed · {{state}} · version {{version}}',
    missingModDescription: 'Not installed. Apply will skip this mod.',
    unknownModDescription:
      'Installed status is unknown until Windhawk status refreshes.',
    desiredState: 'Desired state',
    stateFor: 'Desired state for {{mod}}',
    state: { enabled: 'Enabled', disabled: 'Disabled' },
    settingsMode: 'Settings mode',
    modeFor: 'Settings mode for {{mod}}',
    mode: { merge: 'Merge', replace: 'Replace' },
    deleteAllWarning: 'Replace mode with no settings deletes every setting for this mod.',
    settingsCount: '{{count}} setting values',
    noSettings: 'No settings captured for this mod.',
    settingsTitle: 'Settings overrides',
    settingsReadOnly:
      'Settings are read-only in this version. Values come from capture or import and are never invented here.',
    settingsSummary: '{{count}} setting values across {{mods}} managed mods',
    settingsExpand: 'Show captured settings',
    settingLine: '{{mod}} · {{name}} = {{type}}:{{value}}',
    settingType: { string: 'string', dword: 'dword' },
    targetingTitle: 'Process targeting stays with Windhawk',
    targetingBody:
      'Include, Exclude, Architecture, and custom targeting lists are not stored in profiles and cannot be edited here. Windhawk keeps managing them.',
    actionsTitle: 'Apply actions',
    rainmeterLabel: 'Rainmeter',
    rainmeter: {
      start: 'Start Rainmeter',
      stop: 'Stop Rainmeter',
      unchanged: 'Leave unchanged',
    },
    unlistedLabel: 'Unlisted mods',
    unlisted: { leave: 'Leave untouched', disable: 'Disable all others' },
    explorerLabel: 'Restart Explorer',
    explorer: { ask: 'Ask during apply', always: 'Always', never: 'Never' },
    applyUnavailable: 'Apply is unavailable on this machine.',
  },
};

const BUILTIN: Profile = makeProfile({
  requiredMods: [
    managedMod({
      modId: 'windows-11-taskbar-styler',
      settings: { TaskbarHeight: dword(48), Theme: stringValue('macOS') },
    }),
  ],
});

interface UserProfileOptions {
  readonly id?: string;
  readonly name?: string;
  readonly description?: string;
  readonly requiredMods?: readonly Record<string, unknown>[];
  readonly revision?: number;
  readonly source?: Profile['source'];
}

function userProfile(options: UserProfileOptions = {}): Profile {
  const base = makeProfile({
    requiredMods:
      options.requiredMods ??
      [
        managedMod({
          modId: 'windows-11-taskbar-styler',
          state: 'enabled',
          mode: 'merge',
          settings: { TaskbarHeight: dword(48), Theme: stringValue('macOS') },
        }),
        managedMod({
          modId: 'legacy-mod',
          state: 'disabled',
          mode: 'merge',
          settings: {},
        }),
      ],
    revision: options.revision ?? 3,
  });
  return parseProfile({
    ...base,
    id: options.id ?? 'my-setup',
    name: options.name ?? 'My Setup',
    description: options.description ?? 'Everyday setup.',
    source: options.source ?? 'user',
    basedOn: null,
    revision: options.revision ?? 3,
  });
}

const USER: Profile = userProfile();

const BASE_ENVIRONMENT = makeEnvironment({
  mods: [{ modId: 'windows-11-taskbar-styler', version: '1.10' }],
});

const STATE: AppState = parseAppState({
  schemaVersion: 1,
  activeProfileId: 'my-setup',
  lastAppliedAt: '2026-10-22T20:02:20.000Z',
  lastRunId: 'run-2026-10-22T20-02-14-123Z',
});

function captureEnvironment(): Environment {
  return {
    ...BASE_ENVIRONMENT,
    mods: [
      {
        ...BASE_ENVIRONMENT.mods[0]!,
        settingsCount: 4,
      },
      {
        ...BASE_ENVIRONMENT.mods[0]!,
        modId: 'legacy-mod',
        libraryFileName: 'legacy-mod.dll',
        enabled: false,
        settingsCount: 2,
      },
    ],
  };
}

interface RenderOptions {
  readonly profiles?: readonly Profile[];
  readonly environment?: Environment;
  readonly state?: AppState;
  readonly api?: Partial<WpmApi>;
}

function createApi(options: RenderOptions): WpmApi {
  const profiles = options.profiles ?? [BUILTIN, USER];
  const environment = options.environment ?? BASE_ENVIRONMENT;
  const state = options.state ?? STATE;
  const api: WpmApi = {
    ping: vi.fn(),
    getVersions: vi.fn(),
    getConfig: vi.fn(),
    getEnvironment: vi.fn(async () => structuredClone(environment)),
    listProfiles: vi.fn(async () => structuredClone([...profiles])),
    getProfile: vi.fn(async (id: string) => {
      const found = profiles.find((profile) => profile.id === id);
      if (found === undefined) throw new Error(`Profile "${id}" was not found.`);
      return structuredClone(found);
    }),
    createProfile: vi.fn(async (input) =>
      structuredClone(userProfile({ id: 'new-profile', name: input.name })),
    ),
    updateProfile: vi.fn(async () => structuredClone(USER)),
    deleteProfile: vi.fn(async () => undefined),
    duplicateProfile: vi.fn(async () =>
      structuredClone(userProfile({ id: 'copy', name: 'Copy' })),
    ),
    captureProfile: vi.fn(async () =>
      structuredClone(userProfile({ id: 'captured', name: 'Captured' })),
    ),
    importProfile: vi.fn(async () => null),
    exportProfile: vi.fn(async () => null),
    getState: vi.fn(async () => structuredClone(state)),
    updateSettings: vi.fn(),
    completeFirstRun: vi.fn(),
    getRecovery: vi.fn(),
    resolveRecovery: vi.fn(),
    getDiagnostics: vi.fn(),
    openLogsFolder: vi.fn(),
    openDataFolder: vi.fn(),
    listSnapshots: vi.fn(async () => []),
    listSnapshotSummaries: vi.fn(async () => []),
    getSnapshot: vi.fn(),
    deleteSnapshot: vi.fn(),
    importSnapshot: vi.fn(),
    exportSnapshot: vi.fn(),
    planRestore: vi.fn(),
    runRestore: vi.fn(),
    getDrift: vi.fn(),
    listThemePacks: vi.fn(async () => []),
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
    ...options.api,
  };
  Object.defineProperty(window, 'api', { configurable: true, value: api });
  return api;
}

function renderProfiles(options: RenderOptions = {}): {
  api: WpmApi;
  onApply: (profileId: string) => void;
} {
  const api = createApi(options);
  const onApply = vi.fn((_profileId: string): void => undefined);
  const i18n = createI18n('en');
  i18n.addResourceBundle('en', 'translation', { profiles: PROFILES_EN }, true, true);
  render(
    <I18nextProvider i18n={i18n}>
      <Profiles onApply={onApply} />
    </I18nextProvider>,
  );
  return { api, onApply };
}

beforeEach(() => vi.clearAllMocks());

describe('Profiles', () => {
  it('groups built-in and user profiles and keeps built-ins read-only', async () => {
    renderProfiles();

    const builtin = await screen.findByRole('article', { name: 'Mac Blur Glass' });
    expect(within(builtin).getByText('Built-in')).toBeTruthy();
    expect(within(builtin).getByText('1 managed mods')).toBeTruthy();
    expect(within(builtin).getByText('All mods installed')).toBeTruthy();
    expect(within(builtin).queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(within(builtin).queryByRole('button', { name: 'Delete' })).toBeNull();
    expect(within(builtin).getByRole('button', { name: 'Duplicate' })).toBeTruthy();
    expect(within(builtin).queryByText(/Last applied/)).toBeNull();

    const user = screen.getByRole('article', { name: 'My Setup' });
    expect(within(user).getByText('User')).toBeTruthy();
    expect(within(user).getByText('2 managed mods')).toBeTruthy();
    expect(within(user).getByText('1 missing')).toBeTruthy();
    expect(within(user).getByText('Active')).toBeTruthy();
    expect(within(user).getByText(/Last applied/)).toBeTruthy();
    expect(within(user).getByRole('button', { name: 'Edit' })).toBeTruthy();
    expect(within(user).getByRole('button', { name: 'Delete' })).toBeTruthy();
  });

  it('shows an empty state with capture as the primary action', async () => {
    renderProfiles({ profiles: [] });

    expect(await screen.findByText('No profiles found')).toBeTruthy();
    const captureButtons = screen.getAllByRole('button', { name: 'Capture current setup' });
    expect(captureButtons.length).toBeGreaterThan(1);
    expect(
      (screen.getByRole('button', { name: 'Create blank' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('keeps built-ins visible when there are no user profiles', async () => {
    renderProfiles({ profiles: [BUILTIN] });

    expect(await screen.findByText('No user profiles yet')).toBeTruthy();
    expect(screen.getByRole('article', { name: 'Mac Blur Glass' })).toBeTruthy();
  });

  it('captures the current setup with disabled mods included by default', async () => {
    const environment = captureEnvironment();
    const captured = userProfile({ id: 'evening-setup', name: 'Evening setup' });
    const captureProfile = vi.fn(async () => structuredClone(captured));
    const user = userEvent.setup();
    renderProfiles({
      profiles: [],
      environment,
      api: { captureProfile },
    });

    const captureButtons = screen.getAllByRole('button', { name: 'Capture current setup' });
    const captureButton = captureButtons[0];
    expect(captureButton).toBeDefined();
    if (captureButton === undefined) throw new Error('Capture button not found');
    await user.click(captureButton);

    const dialog = await screen.findByRole('dialog');
    const includeDisabled = within(dialog).getByRole('checkbox', {
      name: 'Include disabled mods',
    });
    expect(includeDisabled.getAttribute('aria-checked')).toBe('true');
    expect(within(dialog).getByText('2 installed mods')).toBeTruthy();
    expect(within(dialog).getByText('1 enabled')).toBeTruthy();
    expect(within(dialog).getByText('6 setting values')).toBeTruthy();

    const name = within(dialog).getByLabelText('Profile name');
    await user.clear(name);
    await user.type(name, 'Evening setup');
    await user.click(within(dialog).getByRole('button', { name: 'Capture profile' }));

    await waitFor(() =>
      expect(captureProfile).toHaveBeenCalledWith({
        name: 'Evening setup',
        includeDisabled: true,
      }),
    );
    expect(await within(dialog).findByText('Profile captured')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Open profile' }));
    expect(
      await screen.findByRole('heading', { name: 'Edit Evening setup' }),
    ).toBeTruthy();
  });

  it('warns prominently when a profile manages no mods', async () => {
    const emptyProfile = userProfile({ name: 'Empty Profile', requiredMods: [] });
    const user = userEvent.setup();
    renderProfiles({ profiles: [emptyProfile] });

    const card = await screen.findByRole('article', { name: 'Empty Profile' });
    expect(
      (within(card).getByRole('button', { name: 'Apply' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(within(card).getByText('No managed mods')).toBeTruthy();

    await user.click(within(card).getByRole('button', { name: 'Edit' }));
    expect(await screen.findByText('This profile manages no mods')).toBeTruthy();
    expect(screen.getByText(/Saving is allowed/)).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Save profile' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('duplicates a built-in profile through the API', async () => {
    const copy = userProfile({ id: 'mac-blur-glass-copy', name: 'Mac Blur Glass copy' });
    const duplicateProfile = vi.fn(async () => structuredClone(copy));
    const user = userEvent.setup();
    renderProfiles({ profiles: [BUILTIN], api: { duplicateProfile } });

    const builtin = await screen.findByRole('article', { name: 'Mac Blur Glass' });
    await user.click(within(builtin).getByRole('button', { name: 'Duplicate' }));

    await waitFor(() => expect(duplicateProfile).toHaveBeenCalledWith('mac-blur-glass'));
    expect(await screen.findByText('Profile duplicated')).toBeTruthy();
    expect(
      await screen.findByRole('article', { name: 'Mac Blur Glass copy' }),
    ).toBeTruthy();
  });

  it('edits desired state and settings mode, then saves with the revision', async () => {
    const editable = userProfile({
      requiredMods: [
        managedMod({
          modId: 'windows-11-taskbar-styler',
          state: 'enabled',
          mode: 'merge',
          settings: { TaskbarHeight: dword(48), Theme: stringValue('macOS') },
        }),
      ],
    });
    const updated = parseProfile({
      ...editable,
      revision: 4,
      requiredMods: [
        managedMod({
          modId: 'windows-11-taskbar-styler',
          state: 'disabled',
          mode: 'replace',
          settings: { TaskbarHeight: dword(48), Theme: stringValue('macOS') },
        }),
      ],
    });
    const updateProfile = vi.fn(async () => structuredClone(updated));
    const user = userEvent.setup();
    renderProfiles({ profiles: [editable], api: { updateProfile } });

    const card = await screen.findByRole('article', { name: 'My Setup' });
    await user.click(within(card).getByRole('button', { name: 'Edit' }));
    expect(await screen.findByRole('heading', { name: 'Edit My Setup' })).toBeTruthy();

    await user.selectOptions(
      screen.getByLabelText('Desired state for windows-11-taskbar-styler'),
      'disabled',
    );
    await user.selectOptions(
      screen.getByLabelText('Settings mode for windows-11-taskbar-styler'),
      'replace',
    );
    await user.click(screen.getByRole('button', { name: 'Save profile' }));

    await waitFor(() => expect(updateProfile).toHaveBeenCalledTimes(1));
    expect(updateProfile).toHaveBeenCalledWith('my-setup', 3, {
      name: 'My Setup',
      description: 'Everyday setup.',
      requiredMods: [
        {
          modId: 'windows-11-taskbar-styler',
          state: 'disabled',
          mode: 'replace',
          settings: { TaskbarHeight: dword(48), Theme: stringValue('macOS') },
        },
      ],
      unlistedMods: 'leave',
      actions: { rainmeter: 'unchanged', restartExplorer: 'ask' },
    });
    expect(await screen.findByText('Profile saved')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Edit My Setup' })).toBeNull();
  });

  it('shows a reload prompt when a save is stale and reloads the profile', async () => {
    const editable = userProfile();
    const fresh = userProfile({ name: 'Fresh Setup', revision: 4 });
    const updateProfile = vi.fn(async () => {
      throw new Error(
        'Profile "my-setup" changed (expected revision 3, found 4). Reload it and try again.',
      );
    });
    const getProfile = vi.fn(async () => structuredClone(fresh));
    const user = userEvent.setup();
    renderProfiles({ profiles: [editable], api: { updateProfile, getProfile } });

    const card = await screen.findByRole('article', { name: 'My Setup' });
    await user.click(within(card).getByRole('button', { name: 'Edit' }));
    await screen.findByRole('heading', { name: 'Edit My Setup' });
    await user.click(screen.getByRole('button', { name: 'Save profile' }));

    expect(await screen.findByText('This profile changed')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Reload profile' }));

    await waitFor(() => expect(getProfile).toHaveBeenCalledWith('my-setup'));
    expect(
      await screen.findByRole('heading', { name: 'Edit Fresh Setup' }),
    ).toBeTruthy();
    await waitFor(() =>
      expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Fresh Setup'),
    );
    expect(
      (screen.getByRole('button', { name: 'Save profile' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('requires confirmation before deleting a profile', async () => {
    const deleteProfile = vi.fn(async () => undefined);
    const user = userEvent.setup();
    renderProfiles({ profiles: [USER], api: { deleteProfile } });

    const card = await screen.findByRole('article', { name: 'My Setup' });
    await user.click(within(card).getByRole('button', { name: 'Delete' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Delete My Setup?')).toBeTruthy();
    expect(deleteProfile).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'Delete profile' }));
    await waitFor(() => expect(deleteProfile).toHaveBeenCalledWith('my-setup', 3));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByRole('article', { name: 'My Setup' })).toBeNull();
    expect(await screen.findByText('Profile deleted')).toBeTruthy();
  });

  it('stays silent when import is canceled', async () => {
    const importProfile = vi.fn(async () => null);
    const user = userEvent.setup();
    renderProfiles({ api: { importProfile } });

    await user.click(await screen.findByRole('button', { name: 'Import' }));
    await waitFor(() => expect(importProfile).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('Profile imported')).toBeNull();
    expect(screen.queryByText('Import failed')).toBeNull();
  });

  it('imports a profile and reports success', async () => {
    const imported = parseProfile({
      ...userProfile({ id: 'imported-setup', name: 'Imported Setup' }),
      source: 'imported',
    });
    const importProfile = vi.fn(async () => structuredClone(imported));
    const user = userEvent.setup();
    renderProfiles({ api: { importProfile } });

    await user.click(await screen.findByRole('button', { name: 'Import' }));

    expect(await screen.findByText('Profile imported')).toBeTruthy();
    expect(
      await screen.findByRole('article', { name: 'Imported Setup' }),
    ).toBeTruthy();
    expect(screen.getByText('Imported')).toBeTruthy();
  });

  it('exports a profile and reports the saved path', async () => {
    const exportProfile = vi.fn(
      async () => 'C:\\Users\\Test\\Documents\\my-setup.json',
    );
    const user = userEvent.setup();
    renderProfiles({ profiles: [USER], api: { exportProfile } });

    const card = await screen.findByRole('article', { name: 'My Setup' });
    await user.click(within(card).getByRole('button', { name: 'Export' }));

    await waitFor(() => expect(exportProfile).toHaveBeenCalledWith('my-setup'));
    expect(await screen.findByText('Profile exported')).toBeTruthy();
    expect(
      screen.getByText('Saved to C:\\Users\\Test\\Documents\\my-setup.json'),
    ).toBeTruthy();
  });
});
