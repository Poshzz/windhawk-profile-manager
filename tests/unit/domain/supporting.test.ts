import { describe, expect, it } from 'vitest';
import {
  ApplyResultSchema,
  AppStateSchema,
  CompatibilitySchema,
  DriftEntrySchema,
  InstallInfoSchema,
  InstalledModSchema,
  JournalStateSchema,
  SettingsPatchSchema,
  SettingsSchema,
  isTerminalJournalState,
  migrate,
  parseApplyResult,
  parseAppState,
  parseDrift,
  parseEnvironment,
  parseJournal,
  parsePlanJson,
  parseSnapshotMetadataJson,
  parseThemePack,
} from '@shared/domain';
import { ValidationError } from '@shared/errors';
import { parseJson } from '@shared/validation/json';
import { formatIssuePath } from '@shared/validation/schema';
import { readFixture, readJsonFixture } from './test-fixtures';

function validationError(run: () => unknown): ValidationError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ValidationError);
    return error as ValidationError;
  }
  throw new Error('Expected a ValidationError.');
}

describe('snapshot metadata', () => {
  it('parses valid metadata and records the snapshot scope', () => {
    const metadata = parseSnapshotMetadataJson(readFixture('snapshots/valid-metadata.json'));

    expect(metadata.scope).toBe('engine-mods-configuration');
    expect(metadata.registryView).toBe('64-bit');
    expect(metadata.windhawkStorageMode).toBe('registry');
    expect(metadata.windhawkRegistryRoot).toBeNull();
  });

  it('rejects a registry file name containing a path', () => {
    const error = validationError(() =>
      parseSnapshotMetadataJson(readFixture('snapshots/invalid-registry-file.json')),
    );

    expect(error.details.map((detail) => formatIssuePath(detail.path))).toContain('registryFile');
  });

  it('rejects a malformed checksum', () => {
    const metadata = readJsonFixture('snapshots/valid-metadata.json') as Record<string, unknown>;
    metadata.registrySha256 = 'sha256:nope';

    const error = validationError(() => parseSnapshotMetadataJson(JSON.stringify(metadata)));
    expect(error.details.map((detail) => formatIssuePath(detail.path))).toContain('registrySha256');
  });

  it('rejects an out-of-scope snapshot', () => {
    const metadata = readJsonFixture('snapshots/valid-metadata.json') as Record<string, unknown>;
    metadata.scope = 'entire-machine';

    const error = validationError(() => parseSnapshotMetadataJson(JSON.stringify(metadata)));
    expect(error.details.map((detail) => formatIssuePath(detail.path))).toContain('scope');
  });

  it('rejects an unknown snapshot trigger', () => {
    const metadata = readJsonFixture('snapshots/valid-metadata.json') as Record<string, unknown>;
    metadata.trigger = 'scheduled';

    const error = validationError(() => parseSnapshotMetadataJson(JSON.stringify(metadata)));
    expect(error.details.map((detail) => formatIssuePath(detail.path))).toContain('trigger');
  });

  it('rejects a snapshot file name with a control character', () => {
    const metadata = readJsonFixture('snapshots/valid-metadata.json') as Record<string, unknown>;
    metadata.registryFile = 'snap\u0000.reg';

    const error = validationError(() => parseSnapshotMetadataJson(JSON.stringify(metadata)));
    expect(error.details.map((detail) => formatIssuePath(detail.path))).toContain('registryFile');
  });

  it('rejects unknown snapshot metadata fields', () => {
    const metadata = readJsonFixture('snapshots/valid-metadata.json') as Record<string, unknown>;
    metadata.extra = true;

    const error = validationError(() => parseSnapshotMetadataJson(JSON.stringify(metadata)));
    expect(error.details.map((detail) => formatIssuePath(detail.path))).toContain('extra');
  });
});

describe('journal and apply result', () => {
  const plan = parsePlanJson(readFixture('plans/valid-apply.json'));

  it.each(JournalStateSchema.options)('accepts journal state %s', (state) => {
    expect(JournalStateSchema.parse(state)).toBe(state);
  });

  it('rejects an unknown journal state', () => {
    expect(JournalStateSchema.safeParse('applying ').success).toBe(false);
  });

  it('parses a journal with a validated plan', () => {
    const journal = parseJournal({
      schemaVersion: 1,
      runId: 'run-2026-10-22T20-02-14-123Z',
      state: 'applying',
      startedAt: '2026-10-22T20:02:14.123Z',
      updatedAt: '2026-10-22T20:02:18.000Z',
      snapshotId: '2026-10-22T20-02-14-123Z',
      planHash: plan.planHash,
      beforeHash: plan.beforeHash,
      profileRevision: plan.profileRevision,
      plan,
      result: null,
    });

    expect(journal.state).toBe('applying');
    expect(journal.result).toBeNull();
  });

  it('reports unfinished journal states', () => {
    expect(isTerminalJournalState('applying')).toBe(false);
    expect(isTerminalJournalState('succeeded')).toBe(true);
  });

  it('rejects a journal missing its execution plan', () => {
    const error = validationError(() =>
      parseJournal({
        schemaVersion: 1,
        runId: 'run-2026-10-22T20-02-14-123Z',
        state: 'applying',
        startedAt: '2026-10-22T20:02:14.123Z',
        updatedAt: '2026-10-22T20:02:18.000Z',
        snapshotId: '2026-10-22T20-02-14-123Z',
        planHash: plan.planHash,
        beforeHash: plan.beforeHash,
        profileRevision: plan.profileRevision,
        result: null,
      }),
    );

    expect(error.details.map((detail) => formatIssuePath(detail.path))).toContain('plan');
  });

  it('parses a terminal apply result', () => {
    const result = parseApplyResult({
      schemaVersion: 1,
      runId: 'run-2026-10-22T20-02-14-123Z',
      kind: 'apply',
      status: 'succeeded',
      message: 'Applied',
      startedAt: '2026-10-22T20:02:14.123Z',
      completedAt: '2026-10-22T20:02:20.000Z',
      changedMods: ['windows-11-taskbar-styler'],
      skippedMods: [],
      warnings: [],
      reload: {
        requested: true,
        confirmed: false,
        message: 'applied, reload requested, not confirmed loaded',
      },
      verification: {
        status: 'verified',
        checkedAt: '2026-10-22T20:02:20.000Z',
        message: 'All values verified.',
      },
      actions: {
        rainmeter: { status: 'succeeded' },
        explorer: { status: 'skipped' },
      },
      rollback: null,
      error: null,
    });

    expect(result.status).toBe('succeeded');
    expect(result.reload.confirmed).toBe(false);
  });

  it('rejects an incomplete apply result', () => {
    expect(ApplyResultSchema.safeParse({ schemaVersion: 1 }).success).toBe(false);
  });
});

describe('app state and settings', () => {
  it('applies settings defaults', () => {
    expect(SettingsSchema.parse({})).toEqual({
      language: 'system',
      appearance: 'system',
      explorerRestart: 'ask',
      snapshotRetention: 20,
    });
  });

  it.each([4, 51])('rejects snapshot retention %s', (snapshotRetention) => {
    expect(SettingsSchema.safeParse({ snapshotRetention }).success).toBe(false);
  });

  it('rejects an unsupported language', () => {
    expect(SettingsSchema.safeParse({ language: 'fr' }).success).toBe(false);
  });

  it('does not apply defaults to a settings patch', () => {
    expect(SettingsPatchSchema.parse({ language: 'th' })).toEqual({ language: 'th' });
    expect(SettingsPatchSchema.parse({})).toEqual({});
    expect(SettingsPatchSchema.safeParse({ language: 'fr' }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ unexpected: true }).success).toBe(false);
  });

  it('parses an app state with defaults for optional fields', () => {
    const state = parseAppState({ schemaVersion: 1 });

    expect(state.activeProfileId).toBeNull();
    expect(state.lastAppliedAt).toBeNull();
    expect(state.lastRunId).toBeNull();
    expect(state.firstRunCompleted).toBe(false);
    expect(state.language).toBe('system');
  });

  it('rejects an unknown app state field', () => {
    expect(AppStateSchema.safeParse({ schemaVersion: 1, extra: true }).success).toBe(false);
  });
});

describe('environment and drift', () => {
  const environment = {
    schemaVersion: 1,
    probedAt: '2026-10-22T20:02:14.123Z',
    windows: { version: 'Windows 11', build: '22631', supported: true },
    windhawk: {
      installed: true,
      installDir: 'C:\\Program Files\\Windhawk',
      iniPath: 'C:\\Program Files\\Windhawk\\windhawk.ini',
      version: '1.7.3',
      engineVersion: '1.7.3',
      storageMode: 'registry',
      portable: false,
      registryRoot: 'HKLM\\SOFTWARE\\Windhawk',
    },
    service: { name: 'Windhawk', state: 'running' },
    mods: [
      {
        modId: 'windows-11-taskbar-styler',
        libraryFileName: 'windows-11-taskbar-styler.dll',
        version: '1.7.3',
        enabled: true,
        settingsCount: 2,
        perUserConfig: false,
      },
    ],
    rainmeter: {
      installed: true,
      running: true,
      path: 'C:\\Program Files\\Rainmeter\\Rainmeter.exe',
    },
    perUserConfig: { present: false, active: false, sid: null },
    compatibility: { mode: 'writable', canApply: true, issues: [] },
  } as const;

  it('parses a writable environment', () => {
    const parsed = parseEnvironment(environment);

    expect(parsed.windhawk.storageMode).toBe('registry');
    expect(parsed.mods).toHaveLength(1);
    expect(parsed.compatibility.canApply).toBe(true);
  });

  it('rejects a non-numeric Windows build with a field path', () => {
    const invalid = {
      ...environment,
      windows: { ...environment.windows, build: '22H2' },
    };
    const error = validationError(() => parseEnvironment(invalid));

    expect(error.details.map((detail) => formatIssuePath(detail.path))).toContain('windows.build');
  });

  it('parses drift entries with optional current and desired values', () => {
    const drift = parseDrift({
      schemaVersion: 1,
      profileId: 'mac-blur-glass',
      status: 'different',
      checkedAt: '2026-10-22T20:02:14.123Z',
      entries: [
        {
          modId: 'windows-11-taskbar-styler',
          kind: 'settings',
          message: 'TaskbarHeight differs.',
        },
      ],
      reason: null,
    });

    expect(drift.status).toBe('different');
    expect(drift.entries[0]?.current).toBeNull();
    expect(drift.entries[0]?.desired).toBeNull();
  });

  it('rejects an unknown drift status', () => {
    const invalid = {
      schemaVersion: 1,
      profileId: 'mac-blur-glass',
      status: 'stale',
      checkedAt: '2026-10-22T20:02:14.123Z',
      entries: [],
      reason: null,
    };

    expect(() => parseDrift(invalid)).toThrow(ValidationError);
  });

  it('rejects a relative Windhawk install path', () => {
    const install = {
      ...environment.windhawk,
      installDir: 'Program Files\\Windhawk',
    };

    expect(InstallInfoSchema.safeParse(install).success).toBe(false);
  });

  it('rejects an installed mod with a path as its library file name', () => {
    const mod = {
      ...environment.mods[0],
      libraryFileName: 'mods\\windows-11-taskbar-styler.dll',
    };

    expect(InstalledModSchema.safeParse(mod).success).toBe(false);
  });

  it('rejects an unknown compatibility issue code', () => {
    const compatibility = {
      ...environment.compatibility,
      issues: [{ code: 'made-up', message: 'Not real.' }],
    };

    expect(CompatibilitySchema.safeParse(compatibility).success).toBe(false);
  });

  it('rejects an unknown drift entry kind', () => {
    const entry = {
      modId: 'windows-11-taskbar-styler',
      kind: 'cosmetic',
      message: 'Unknown kind.',
    };

    expect(DriftEntrySchema.safeParse(entry).success).toBe(false);
  });
});

describe('theme packs', () => {
  const pack = {
    schemaVersion: 1,
    id: 'mac-blur-glass',
    name: 'Mac Blur Glass',
    description: 'A macOS-inspired theme.',
    version: '1.0.0',
    testedAppVersion: '0.1.0',
    mods: [
      {
        modId: 'windows-11-taskbar-styler',
        name: 'Taskbar Styler',
        pageUrl: 'https://windhawk.net/mods/windows-11-taskbar-styler',
        testedVersion: '1.7.3',
        required: true,
        notes: [],
      },
    ],
    profiles: ['mac-blur-glass'],
    notes: [],
  };

  it('parses the bundled theme pack metadata', () => {
    const parsed = parseThemePack(pack);

    expect(parsed.mods[0]?.modId).toBe('windows-11-taskbar-styler');
    expect(parsed.mods[0]?.pageUrl).toBe('https://windhawk.net/mods/windows-11-taskbar-styler');
  });

  it('rejects a non-official mod page URL', () => {
    const invalid = {
      ...pack,
      mods: [{ ...pack.mods[0], pageUrl: 'https://example.com/mods/windows-11-taskbar-styler' }],
    };

    expect(() => parseThemePack(invalid)).toThrow(ValidationError);
  });

  it('rejects duplicate mods in a pack', () => {
    const invalid = { ...pack, mods: [pack.mods[0], pack.mods[0]] };

    expect(() => parseThemePack(invalid)).toThrow(ValidationError);
  });

  it('rejects a pack without at least one profile', () => {
    const invalid = { ...pack, profiles: [] };

    expect(() => parseThemePack(invalid)).toThrow(ValidationError);
  });
});

describe('JSON and migration seams', () => {
  it('parses JSON into null-prototype objects', () => {
    const parsed = parseJson('{"a":1}');

    expect(parsed).toEqual({ a: 1 });
    expect(Object.getPrototypeOf(parsed)).toBeNull();
  });

  it('rejects dangerous keys at any depth with the field path', () => {
    const error = validationError(() => parseJson('{"outer":{"constructor":1}}'));

    expect(error.details.map((detail) => formatIssuePath(detail.path))).toContain(
      'outer.constructor',
    );
  });

  it('rejects invalid JSON', () => {
    expect(() => parseJson('{')).toThrow(ValidationError);
  });

  it('is the identity migration for schemaVersion 1', () => {
    const value = { schemaVersion: 1, id: 'mac-blur-glass' };
    expect(migrate('profile', value)).toBe(value);
  });

  it('rejects a document from a newer schema version', () => {
    const error = validationError(() => migrate('profile', { schemaVersion: 2 }));
    expect(error.details.map((detail) => formatIssuePath(detail.path))).toContain('schemaVersion');
  });
});
