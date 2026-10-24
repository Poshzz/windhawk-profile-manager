import { describe, expect, it } from 'vitest';
import {
  nextSettingsChangeTime,
  planApplyWrites,
  planRollbackWrites,
  planRestoreWrites,
  registryValueAt,
  valuesEqual,
  type PlannedWrites,
} from '@core/executor/registry-writes';
import { buildPlan } from '@core/planner/apply-planner';
import { RESTORE_ROOT_VALUE_NAMES } from '@core/registry/reconcile';
import {
  REGISTRY_MODS_ROOT,
  type ApplyPlan,
  type RegistryOp,
  type RegistrySnapshot,
  type RegistryValue,
} from '@shared/domain';
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

const NOW_MS = 1_000_000_000;
const NOW_SECONDS = 1_000_000;
const MAX_SETTINGS_CHANGE_TIME = 0x7fffffff;

const ALPHA = 'alpha-mod';
const BETA = 'beta-mod';
const GAMMA = 'gamma-mod';
const DELTA = 'delta-mod';
const GONE = 'gone-mod';
const NEWER = 'newer-mod';
const INSTALLED_AFTER = 'installed-after-mod';

const TARGETING_NAMES = [...RESTORE_ROOT_VALUE_NAMES].filter((name) => name !== 'disabled');
const ROOT_FORBIDDEN_NAMES = new Set(['libraryfilename', 'version', 'settingschangetime']);

function modRoot(modId: string): string {
  return `${REGISTRY_MODS_ROOT}\\${modId}`;
}

function settingsPath(modId: string): string {
  return `${modRoot(modId)}\\Settings`;
}

function setOp(path: string, name: string, value: RegistryValue): RegistryOp {
  return { kind: 'set', path, name, value };
}

function deleteOp(path: string, name: string): RegistryOp {
  return { kind: 'deleteValue', path, name };
}

function stageOps(
  writes: PlannedWrites,
  stage: PlannedWrites['batches'][number]['stage'],
): RegistryOp[] {
  const batch = writes.batches.find((entry) => entry.stage === stage);
  if (batch === undefined) throw new Error(`Missing batch "${stage}".`);
  return [...batch.ops];
}

function expectBatches(writes: PlannedWrites): void {
  expect(writes.batches).toHaveLength(4);
  expect(writes.batches.map((batch) => batch.stage)).toEqual([
    'disable',
    'settings',
    'marker',
    'enable',
  ]);
  expect(writes.allOps).toEqual(writes.batches.flatMap((batch) => batch.ops));
}

function expectNoForbiddenRootWrites(writes: PlannedWrites, markerModIds: readonly string[]): void {
  const forbidden = writes.allOps.filter((operation) =>
    ROOT_FORBIDDEN_NAMES.has(operation.name.toLowerCase()),
  );

  expect(forbidden).toEqual(
    markerModIds.map((modId) => setOp(modRoot(modId), 'SettingsChangeTime', dword(NOW_SECONDS))),
  );
}

function richApplyFixture(): { current: RegistrySnapshot; plan: ApplyPlan } {
  const current = makeSnapshot([
    ...modKeys(ALPHA, {
      enabled: true,
      version: '1.2.3',
      settings: {
        Shared: stringValue('same'),
        Mode: stringValue('old'),
        Extra: stringValue('remove'),
      },
      extraRootValues: { SettingsChangeTime: dword(2_000_000) },
    }),
    ...modKeys(BETA, {
      enabled: false,
      version: '2.0.0',
      settings: { Size: dword(10) },
      extraRootValues: { SettingsChangeTime: dword(5) },
    }),
    ...modKeys(GAMMA, {
      enabled: true,
      settings: { Theme: stringValue('keep') },
    }),
    ...modKeys(DELTA, { enabled: true }),
  ]);

  const profile = makeProfile({
    requiredMods: [
      managedMod({
        modId: ALPHA,
        settings: { Shared: stringValue('same'), Mode: stringValue('new') },
      }),
      managedMod({
        modId: BETA,
        mode: 'merge',
        settings: { Size: dword(20) },
      }),
      managedMod({
        modId: GAMMA,
        state: 'disabled',
        mode: 'merge',
        settings: { Theme: stringValue('keep') },
      }),
    ],
    unlistedMods: 'disable',
  });

  return { current, plan: buildPlan(profile, current, makeEnvironment(), planOptions()) };
}

function restoreFixtures(): { source: RegistrySnapshot; current: RegistrySnapshot } {
  const targeting: Record<string, RegistryValue> = {};
  for (const name of TARGETING_NAMES) {
    targeting[name] = stringValue(`captured-${name}`);
  }

  const source = makeSnapshot([
    ...modKeys(ALPHA, {
      enabled: false,
      version: '2.0.0',
      libraryFileName: 'alpha-captured.dll',
      settings: {
        Theme: stringValue('captured'),
        Removed: stringValue('captured-extra'),
      },
      extraRootValues: {
        ...targeting,
        SettingsChangeTime: dword(123),
      },
    }),
    ...modKeys(BETA, {
      enabled: true,
      version: '1.0.0',
      settings: { Mode: stringValue('restored') },
      extraRootValues: { SettingsChangeTime: dword(456) },
    }),
    ...modKeys(GONE, { enabled: true, version: '1.0.0' }),
    ...modKeys(NEWER, {
      enabled: true,
      version: '1.0.0',
      settings: { Theme: stringValue('snapshot-theme') },
    }),
  ]);

  const current = makeSnapshot([
    ...modKeys(ALPHA, {
      enabled: true,
      version: '2.0.0',
      libraryFileName: 'alpha-updated.dll',
      settings: {
        Theme: stringValue('live'),
        Added: stringValue('after-capture'),
      },
      extraRootValues: {
        Include: stringValue('live-include'),
        Architecture: stringValue('arm64'),
        SettingsChangeTime: dword(500),
        UnknownRoot: stringValue('leave-me'),
      },
    }),
    ...modKeys(BETA, {
      enabled: false,
      version: '1.0.0',
      settings: { Mode: stringValue('live') },
      extraRootValues: { SettingsChangeTime: dword(900) },
    }),
    ...modKeys(NEWER, {
      enabled: true,
      version: '2.0.0',
      settings: { Theme: stringValue('live-newer') },
      extraRootValues: { SettingsChangeTime: dword(42) },
    }),
    ...modKeys(INSTALLED_AFTER, {
      enabled: true,
      version: '1.0.0',
      settings: { Fresh: stringValue('installed-after') },
    }),
  ]);

  return { source, current };
}

function rollbackFixtures(): { preRun: RegistrySnapshot; current: RegistrySnapshot } {
  const preRun = makeSnapshot([
    ...modKeys(ALPHA, {
      enabled: true,
      version: '1.0.0',
      settings: { Theme: stringValue('pre'), Legacy: stringValue('pre-extra') },
      extraRootValues: {
        Include: stringValue('pre-include'),
        SettingsChangeTime: dword(300),
      },
    }),
    ...modKeys(GONE, { enabled: true, version: '1.0.0' }),
  ]);

  const current = makeSnapshot([
    ...modKeys(ALPHA, {
      enabled: false,
      version: '1.1.0',
      libraryFileName: 'alpha-run.dll',
      settings: {
        Theme: stringValue('changed'),
        AddedAfter: stringValue('new'),
      },
      extraRootValues: {
        Include: stringValue('run-include'),
        Architecture: stringValue('arm64'),
        SettingsChangeTime: dword(999),
        UnknownRoot: stringValue('leave-me'),
      },
    }),
  ]);

  return { preRun, current };
}

describe('nextSettingsChangeTime', () => {
  it('uses max(masked Unix seconds, previous + 1)', () => {
    expect(nextSettingsChangeTime(0, 500_000)).toBe(500);
    expect(nextSettingsChangeTime(10, 500_000)).toBe(500);
    expect(nextSettingsChangeTime(500, 500_000)).toBe(501);
    expect(nextSettingsChangeTime(900, 500_000)).toBe(901);
  });

  it('truncates milliseconds to Unix seconds before masking', () => {
    expect(nextSettingsChangeTime(0, 500_999)).toBe(500);
    expect(nextSettingsChangeTime(0, 999)).toBe(1);
    expect(nextSettingsChangeTime(0, 1_999)).toBe(1);
  });

  it('masks the clock to a positive 31-bit value', () => {
    expect(nextSettingsChangeTime(0, 0x7fffffff * 1000)).toBe(0x7fffffff);
    expect(nextSettingsChangeTime(0, (0x80000000 + 77) * 1000)).toBe(77);
    expect(nextSettingsChangeTime(0, 0xffffffff * 1000)).toBe(0x7fffffff);
    expect(nextSettingsChangeTime(0, 0)).toBe(1);
  });

  it('wraps to 1 when the next value would exceed 0x7fffffff', () => {
    expect(nextSettingsChangeTime(MAX_SETTINGS_CHANGE_TIME, 0)).toBe(1);
    expect(nextSettingsChangeTime(MAX_SETTINGS_CHANGE_TIME, MAX_SETTINGS_CHANGE_TIME * 1000)).toBe(
      1,
    );
    expect(nextSettingsChangeTime(0, 0x80000000 * 1000)).toBe(1);
  });

  it('is strictly greater than the previous value and never zero', () => {
    for (const previous of [0, 1, 2, 12_345, MAX_SETTINGS_CHANGE_TIME - 1]) {
      const next = nextSettingsChangeTime(previous, 0);
      expect(next).toBeGreaterThan(previous);
      expect(next).toBeGreaterThan(0);
      expect(next).toBeLessThanOrEqual(MAX_SETTINGS_CHANGE_TIME);
    }
  });

  it('treats a missing or invalid previous value as zero', () => {
    for (const previous of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0, 1.5]) {
      expect(nextSettingsChangeTime(previous, 0)).toBe(1);
    }
  });
});

describe('registry value helpers', () => {
  it('compares values by type and content, ignoring key order', () => {
    expect(valuesEqual(dword(1), { value: 1, type: 'dword' })).toBe(true);
    expect(valuesEqual(dword(1), dword(2))).toBe(false);
    expect(valuesEqual(dword(1), stringValue('1'))).toBe(false);
    expect(valuesEqual(stringValue('macOS'), stringValue('macOS'))).toBe(true);
    expect(valuesEqual(stringValue('macOS'), stringValue('macos'))).toBe(false);
  });

  it('finds values case-insensitively and returns null when absent', () => {
    const snapshot = makeSnapshot(modKeys(ALPHA, { settings: { Theme: stringValue('macOS') } }));

    expect(registryValueAt(snapshot, modRoot(ALPHA).toUpperCase(), 'DISABLED')).toEqual(dword(0));
    expect(registryValueAt(snapshot, settingsPath(ALPHA).toLowerCase(), 'theme')).toEqual(
      stringValue('macOS'),
    );
    expect(registryValueAt(snapshot, modRoot(ALPHA), 'Missing')).toBeNull();
    expect(registryValueAt(snapshot, modRoot('absent-mod'), 'Disabled')).toBeNull();
  });
});

describe('planApplyWrites', () => {
  it('orders Disabled=1 before settings, the marker after settings, and Disabled=0 last', () => {
    const { current, plan } = richApplyFixture();
    const writes = planApplyWrites(plan, current, NOW_MS);

    expectBatches(writes);
    expect(writes.batches.filter((batch) => batch.stage === 'marker')).toHaveLength(1);

    expect(stageOps(writes, 'disable')).toEqual([
      setOp(modRoot(GAMMA), 'Disabled', dword(1)),
      setOp(modRoot(DELTA), 'Disabled', dword(1)),
    ]);
    expect(stageOps(writes, 'settings')).toEqual([
      setOp(settingsPath(ALPHA), 'Mode', stringValue('new')),
      deleteOp(settingsPath(ALPHA), 'Extra'),
      setOp(settingsPath(BETA), 'Size', dword(20)),
    ]);
    expect(stageOps(writes, 'marker')).toEqual([
      setOp(modRoot(ALPHA), 'SettingsChangeTime', dword(2_000_001)),
      setOp(modRoot(BETA), 'SettingsChangeTime', dword(NOW_SECONDS)),
    ]);
    expect(stageOps(writes, 'enable')).toEqual([setOp(modRoot(BETA), 'Disabled', dword(0))]);

    expect(writes.touchedModIds).toEqual([ALPHA, BETA, GAMMA, DELTA]);
    expect(writes.skippedMods).toEqual([]);
    expect(writes.warnings).toEqual([]);
    expect(writes.unrestorableModIds).toEqual([]);

    const expected = writes.expectedSnapshot;
    expect(registryValueAt(expected, modRoot(ALPHA), 'Disabled')).toEqual(dword(0));
    expect(registryValueAt(expected, modRoot(ALPHA), 'SettingsChangeTime')).toEqual(
      dword(2_000_001),
    );
    expect(registryValueAt(expected, settingsPath(ALPHA), 'Shared')).toEqual(stringValue('same'));
    expect(registryValueAt(expected, settingsPath(ALPHA), 'Mode')).toEqual(stringValue('new'));
    expect(registryValueAt(expected, settingsPath(ALPHA), 'Extra')).toBeNull();
    expect(registryValueAt(expected, modRoot(BETA), 'Disabled')).toEqual(dword(0));
    expect(registryValueAt(expected, modRoot(BETA), 'SettingsChangeTime')).toEqual(
      dword(NOW_SECONDS),
    );
    expect(registryValueAt(expected, settingsPath(BETA), 'Size')).toEqual(dword(20));
    expect(registryValueAt(expected, modRoot(GAMMA), 'Disabled')).toEqual(dword(1));
    expect(registryValueAt(expected, settingsPath(GAMMA), 'Theme')).toEqual(stringValue('keep'));
    expect(registryValueAt(expected, modRoot(DELTA), 'Disabled')).toEqual(dword(1));
  });

  it('refuses to delete a setting type that rollback could not write back', () => {
    const current = makeSnapshot([
      ...modKeys(ALPHA, {
        enabled: true,
        settings: { Weird: { type: 'multiString', value: ['one', 'two'] } },
      }),
    ]);
    const profile = makeProfile({
      requiredMods: [managedMod({ modId: ALPHA, settings: {} })],
    });
    const plan = buildPlan(profile, current, makeEnvironment(), planOptions());

    expect(() => planApplyWrites(plan, current, NOW_MS)).toThrow(/cannot be restored/i);
  });

  it('refuses to overwrite a setting type that rollback could not write back', () => {
    const current = makeSnapshot([
      ...modKeys(ALPHA, {
        enabled: true,
        settings: { Weird: { type: 'multiString', value: ['one', 'two'] } },
      }),
    ]);
    const profile = makeProfile({
      requiredMods: [managedMod({ modId: ALPHA, settings: { Weird: stringValue('replacement') } })],
    });
    const plan = buildPlan(profile, current, makeEnvironment(), planOptions());

    expect(() => planApplyWrites(plan, current, NOW_MS)).toThrow(/cannot be restored/i);
  });

  it('refuses to overwrite a malformed Disabled value', () => {
    const keys = modKeys(ALPHA, { enabled: true }).map((key) => ({
      ...key,
      values: key.values.map((entry) =>
        entry.name === 'Disabled' ? { name: 'Disabled', value: stringValue('bad') } : entry,
      ),
    }));
    const current = makeSnapshot(keys);
    const profile = makeProfile({
      requiredMods: [managedMod({ modId: ALPHA, state: 'disabled', mode: 'merge' })],
    });
    const plan = buildPlan(profile, current, makeEnvironment(), planOptions());

    expect(() => planApplyWrites(plan, current, NOW_MS)).toThrow(
      /Disabled value.*cannot be restored/i,
    );
  });

  it('writes only Disabled=1 for a Disabled-only transition and leaves the marker unchanged', () => {
    const current = makeSnapshot([
      ...modKeys(ALPHA, {
        enabled: true,
        settings: { TaskbarHeight: dword(48), Theme: stringValue('macOS') },
        extraRootValues: { SettingsChangeTime: dword(77) },
      }),
    ]);
    const profile = makeProfile({
      requiredMods: [
        managedMod({
          modId: ALPHA,
          state: 'disabled',
          settings: { TaskbarHeight: dword(48), Theme: stringValue('macOS') },
        }),
      ],
    });
    const plan = buildPlan(profile, current, makeEnvironment(), planOptions());

    expect(plan.modChanges[0]?.state).toBe('disabled');
    expect(plan.modChanges[0]?.settingsChanged).toBe(false);

    const writes = planApplyWrites(plan, current, NOW_MS);

    expectBatches(writes);
    expect(writes.allOps).toEqual([setOp(modRoot(ALPHA), 'Disabled', dword(1))]);
    expect(stageOps(writes, 'disable')).toEqual([setOp(modRoot(ALPHA), 'Disabled', dword(1))]);
    expect(stageOps(writes, 'settings')).toEqual([]);
    expect(stageOps(writes, 'marker')).toEqual([]);
    expect(stageOps(writes, 'enable')).toEqual([]);
    expect(writes.touchedModIds).toEqual([ALPHA]);
    expect(
      writes.allOps.some((operation) => operation.name.toLowerCase() === 'settingschangetime'),
    ).toBe(false);
    expect(registryValueAt(writes.expectedSnapshot, modRoot(ALPHA), 'SettingsChangeTime')).toEqual(
      dword(77),
    );
    expect(registryValueAt(writes.expectedSnapshot, modRoot(ALPHA), 'Disabled')).toEqual(dword(1));
  });

  it('writes a marker for a settings change while leaving Disabled untouched', () => {
    const current = makeSnapshot([
      ...modKeys(ALPHA, {
        enabled: true,
        settings: { Theme: stringValue('old') },
        extraRootValues: { SettingsChangeTime: dword(42) },
      }),
    ]);
    const profile = makeProfile({
      requiredMods: [managedMod({ modId: ALPHA, settings: { Theme: stringValue('new') } })],
    });
    const plan = buildPlan(profile, current, makeEnvironment(), planOptions());
    const writes = planApplyWrites(plan, current, NOW_MS);

    expectBatches(writes);
    expect(stageOps(writes, 'disable')).toEqual([]);
    expect(stageOps(writes, 'settings')).toEqual([
      setOp(settingsPath(ALPHA), 'Theme', stringValue('new')),
    ]);
    expect(stageOps(writes, 'marker')).toEqual([
      setOp(modRoot(ALPHA), 'SettingsChangeTime', dword(NOW_SECONDS)),
    ]);
    expect(stageOps(writes, 'enable')).toEqual([]);
    expect(writes.touchedModIds).toEqual([ALPHA]);
    expect(registryValueAt(writes.expectedSnapshot, modRoot(ALPHA), 'Disabled')).toEqual(dword(0));
    expect(registryValueAt(writes.expectedSnapshot, modRoot(ALPHA), 'SettingsChangeTime')).toEqual(
      dword(NOW_SECONDS),
    );
  });

  it('deletes settings absent from a replace-mode profile and re-stamps the marker', () => {
    const current = makeSnapshot([
      ...modKeys(ALPHA, {
        enabled: true,
        settings: { Keep: stringValue('live'), Stale: stringValue('old') },
        extraRootValues: { SettingsChangeTime: dword(9) },
      }),
    ]);
    const profile = makeProfile({
      requiredMods: [managedMod({ modId: ALPHA, settings: { Keep: stringValue('live') } })],
    });
    const plan = buildPlan(profile, current, makeEnvironment(), planOptions());

    expect(plan.modChanges[0]?.deleteValues).toEqual(['Stale']);

    const writes = planApplyWrites(plan, current, NOW_MS);

    expectBatches(writes);
    expect(stageOps(writes, 'disable')).toEqual([]);
    expect(stageOps(writes, 'settings')).toEqual([deleteOp(settingsPath(ALPHA), 'Stale')]);
    expect(stageOps(writes, 'marker')).toEqual([
      setOp(modRoot(ALPHA), 'SettingsChangeTime', dword(NOW_SECONDS)),
    ]);
    expect(stageOps(writes, 'enable')).toEqual([]);
    expect(registryValueAt(writes.expectedSnapshot, settingsPath(ALPHA), 'Keep')).toEqual(
      stringValue('live'),
    );
    expect(registryValueAt(writes.expectedSnapshot, settingsPath(ALPHA), 'Stale')).toBeNull();
    expect(registryValueAt(writes.expectedSnapshot, modRoot(ALPHA), 'SettingsChangeTime')).toEqual(
      dword(NOW_SECONDS),
    );
  });

  it('deletes every current setting for deleteAllSettings', () => {
    const current = makeSnapshot([
      ...modKeys(ALPHA, {
        enabled: true,
        settings: { A: stringValue('1'), B: dword(2) },
        extraRootValues: { SettingsChangeTime: dword(3) },
      }),
    ]);
    const profile = makeProfile({
      requiredMods: [managedMod({ modId: ALPHA, settings: {} })],
    });
    const plan = buildPlan(
      profile,
      current,
      makeEnvironment(),
      planOptions({ confirmDeleteAllSettings: true }),
    );

    expect(plan.modChanges[0]?.deleteAllSettings).toBe(true);

    const writes = planApplyWrites(plan, current, NOW_MS);

    expectBatches(writes);
    expect(stageOps(writes, 'settings')).toEqual([
      deleteOp(settingsPath(ALPHA), 'A'),
      deleteOp(settingsPath(ALPHA), 'B'),
    ]);
    expect(stageOps(writes, 'marker')).toEqual([
      setOp(modRoot(ALPHA), 'SettingsChangeTime', dword(NOW_SECONDS)),
    ]);
    expect(writes.touchedModIds).toEqual([ALPHA]);
    expect(registryValueAt(writes.expectedSnapshot, settingsPath(ALPHA), 'A')).toBeNull();
    expect(registryValueAt(writes.expectedSnapshot, settingsPath(ALPHA), 'B')).toBeNull();
    expect(registryValueAt(writes.expectedSnapshot, settingsPath(ALPHA), 'Missing')).toBeNull();
  });

  it('disables an unlisted mod when willDisable is set', () => {
    const current = makeSnapshot([
      ...modKeys(ALPHA, { settings: { Theme: stringValue('same') } }),
      ...modKeys(DELTA, { enabled: true }),
    ]);
    const profile = makeProfile({
      requiredMods: [managedMod({ modId: ALPHA, settings: { Theme: stringValue('same') } })],
      unlistedMods: 'disable',
    });
    const plan = buildPlan(profile, current, makeEnvironment(), planOptions());

    expect(plan.unlistedMods.find((mod) => mod.modId === DELTA)?.willDisable).toBe(true);

    const writes = planApplyWrites(plan, current, NOW_MS);

    expectBatches(writes);
    expect(stageOps(writes, 'disable')).toEqual([setOp(modRoot(DELTA), 'Disabled', dword(1))]);
    expect(stageOps(writes, 'settings')).toEqual([]);
    expect(stageOps(writes, 'marker')).toEqual([]);
    expect(stageOps(writes, 'enable')).toEqual([]);
    expect(writes.touchedModIds).toEqual([DELTA]);
    expect(registryValueAt(writes.expectedSnapshot, modRoot(DELTA), 'Disabled')).toEqual(dword(1));
    expect(registryValueAt(writes.expectedSnapshot, modRoot(ALPHA), 'Disabled')).toEqual(dword(0));
  });

  it('filters values that already match the current registry', () => {
    const current = makeSnapshot([
      ...modKeys(ALPHA, {
        enabled: true,
        settings: { Keep: stringValue('same'), Change: stringValue('old') },
        extraRootValues: { SettingsChangeTime: dword(12) },
      }),
    ]);
    const profile = makeProfile({
      requiredMods: [
        managedMod({
          modId: ALPHA,
          settings: { Keep: stringValue('same'), Change: stringValue('new') },
        }),
      ],
    });
    const plan = buildPlan(profile, current, makeEnvironment(), planOptions());
    const writes = planApplyWrites(plan, current, NOW_MS);

    expectBatches(writes);
    expect(stageOps(writes, 'disable')).toEqual([]);
    expect(stageOps(writes, 'settings')).toEqual([
      setOp(settingsPath(ALPHA), 'Change', stringValue('new')),
    ]);
    expect(stageOps(writes, 'marker')).toEqual([
      setOp(modRoot(ALPHA), 'SettingsChangeTime', dword(NOW_SECONDS)),
    ]);
    expect(stageOps(writes, 'enable')).toEqual([]);
    expect(
      writes.allOps.some(
        (operation) =>
          operation.path.toLowerCase() === settingsPath(ALPHA).toLowerCase() &&
          operation.name === 'Keep',
      ),
    ).toBe(false);
  });

  it('returns four empty batches and an unchanged snapshot for a no-op apply', () => {
    const current = makeSnapshot([
      ...modKeys(ALPHA, {
        enabled: true,
        settings: { Theme: stringValue('macOS') },
      }),
    ]);
    const profile = makeProfile({
      requiredMods: [managedMod({ modId: ALPHA, settings: { Theme: stringValue('macOS') } })],
    });
    const plan = buildPlan(profile, current, makeEnvironment(), planOptions());

    expect(plan.noOp).toBe(true);

    const writes = planApplyWrites(plan, current, NOW_MS);

    expectBatches(writes);
    expect(writes.batches.map((batch) => batch.ops)).toEqual([[], [], [], []]);
    expect(writes.allOps).toEqual([]);
    expect(writes.touchedModIds).toEqual([]);
    expect(writes.skippedMods).toEqual([]);
    expect(writes.warnings).toEqual([]);
    expect(writes.unrestorableModIds).toEqual([]);
    expect(writes.expectedSnapshot).toEqual(current);
  });
});

describe('planRestoreWrites', () => {
  it('reconciles captured Disabled, settings, and targeting values with a marker', () => {
    const { source, current } = restoreFixtures();
    const writes = planRestoreWrites(source, current, NOW_MS);

    expectBatches(writes);

    expect(stageOps(writes, 'disable')).toEqual([setOp(modRoot(ALPHA), 'Disabled', dword(1))]);
    expect(stageOps(writes, 'settings')).toEqual([
      ...TARGETING_NAMES.map((name) =>
        setOp(modRoot(ALPHA), name, stringValue(`captured-${name}`)),
      ),
      setOp(settingsPath(ALPHA), 'Theme', stringValue('captured')),
      setOp(settingsPath(ALPHA), 'Removed', stringValue('captured-extra')),
      deleteOp(settingsPath(ALPHA), 'Added'),
      setOp(settingsPath(BETA), 'Mode', stringValue('restored')),
      setOp(settingsPath(NEWER), 'Theme', stringValue('snapshot-theme')),
    ]);
    expect(stageOps(writes, 'marker')).toEqual([
      setOp(modRoot(ALPHA), 'SettingsChangeTime', dword(NOW_SECONDS)),
      setOp(modRoot(BETA), 'SettingsChangeTime', dword(NOW_SECONDS)),
      setOp(modRoot(NEWER), 'SettingsChangeTime', dword(NOW_SECONDS)),
    ]);
    expect(stageOps(writes, 'enable')).toEqual([setOp(modRoot(BETA), 'Disabled', dword(0))]);

    expect(writes.touchedModIds).toEqual([ALPHA, BETA, NEWER]);
    expect(writes.skippedMods.map((mod) => mod.modId)).toEqual([GONE, INSTALLED_AFTER]);
    expect(writes.warnings).toHaveLength(2);
    expect(writes.unrestorableModIds).toEqual([]);

    const expected = writes.expectedSnapshot;
    expect(registryValueAt(expected, modRoot(ALPHA), 'Disabled')).toEqual(dword(1));
    expect(registryValueAt(expected, modRoot(ALPHA), 'LibraryFileName')).toEqual(
      stringValue('alpha-updated.dll'),
    );
    expect(registryValueAt(expected, modRoot(ALPHA), 'Version')).toEqual(stringValue('2.0.0'));
    for (const name of TARGETING_NAMES) {
      expect(registryValueAt(expected, modRoot(ALPHA), name)).toEqual(
        stringValue(`captured-${name}`),
      );
    }
    expect(registryValueAt(expected, modRoot(ALPHA), 'UnknownRoot')).toEqual(
      stringValue('leave-me'),
    );
    expect(registryValueAt(expected, modRoot(ALPHA), 'SettingsChangeTime')).toEqual(
      dword(NOW_SECONDS),
    );
    expect(registryValueAt(expected, settingsPath(ALPHA), 'Theme')).toEqual(
      stringValue('captured'),
    );
    expect(registryValueAt(expected, settingsPath(ALPHA), 'Removed')).toEqual(
      stringValue('captured-extra'),
    );
    expect(registryValueAt(expected, settingsPath(ALPHA), 'Added')).toBeNull();
    expect(registryValueAt(expected, modRoot(BETA), 'Disabled')).toEqual(dword(0));
    expect(registryValueAt(expected, modRoot(BETA), 'SettingsChangeTime')).toEqual(
      dword(NOW_SECONDS),
    );
    expect(registryValueAt(expected, settingsPath(BETA), 'Mode')).toEqual(stringValue('restored'));
    expect(registryValueAt(expected, settingsPath(NEWER), 'Theme')).toEqual(
      stringValue('snapshot-theme'),
    );
    expect(registryValueAt(expected, modRoot(NEWER), 'Version')).toEqual(stringValue('2.0.0'));
    expect(registryValueAt(expected, modRoot(NEWER), 'SettingsChangeTime')).toEqual(
      dword(NOW_SECONDS),
    );
  });

  it('rejects a captured settings type the registry gateway cannot restore', () => {
    const source = makeSnapshot([
      ...modKeys(ALPHA, {
        enabled: true,
        settings: { Weird: { type: 'multiString', value: ['one', 'two'] } },
      }),
    ]);
    const current = makeSnapshot([...modKeys(ALPHA, { enabled: true })]);

    expect(() => planRestoreWrites(source, current, NOW_MS)).toThrow(/cannot restore/i);
  });

  it('rejects a restore that would overwrite a current value it cannot restore', () => {
    const source = makeSnapshot([
      ...modKeys(ALPHA, { enabled: true, settings: { Weird: stringValue('safe') } }),
    ]);
    const current = makeSnapshot([
      ...modKeys(ALPHA, {
        enabled: true,
        settings: { Weird: { type: 'multiString', value: ['one', 'two'] } },
      }),
    ]);

    expect(() => planRestoreWrites(source, current, NOW_MS)).toThrow(
      /cannot be restored if the operation fails/i,
    );
  });

  it('rejects a restore that would delete a current value it cannot restore', () => {
    const source = makeSnapshot([...modKeys(ALPHA, { enabled: true })]);
    const current = makeSnapshot([
      ...modKeys(ALPHA, {
        enabled: true,
        settings: { Weird: { type: 'multiString', value: ['one', 'two'] } },
      }),
    ]);

    expect(() => planRestoreWrites(source, current, NOW_MS)).toThrow(
      /cannot be restored if the operation fails/i,
    );
  });

  it('leaves an unchanged unsupported setting untouched during restore', () => {
    const weird = { type: 'multiString' as const, value: ['one', 'two'] };
    const source = makeSnapshot([...modKeys(ALPHA, { enabled: true, settings: { Weird: weird } })]);
    const current = makeSnapshot([
      ...modKeys(ALPHA, { enabled: true, settings: { Weird: weird } }),
    ]);

    const writes = planRestoreWrites(source, current, NOW_MS);

    expect(writes.allOps).toEqual([]);
    expect(writes.touchedModIds).toEqual([]);
  });

  it('never restores captured LibraryFileName, Version, or SettingsChangeTime values', () => {
    const { source, current } = restoreFixtures();
    const writes = planRestoreWrites(source, current, NOW_MS);

    expectNoForbiddenRootWrites(writes, [ALPHA, BETA, NEWER]);
    expect(
      writes.allOps.some((operation) => operation.name.toLowerCase() === 'libraryfilename'),
    ).toBe(false);

    const expected = writes.expectedSnapshot;
    expect(registryValueAt(expected, modRoot(ALPHA), 'LibraryFileName')).toEqual(
      stringValue('alpha-updated.dll'),
    );
    expect(registryValueAt(expected, modRoot(ALPHA), 'Version')).toEqual(stringValue('2.0.0'));
    expect(registryValueAt(expected, modRoot(ALPHA), 'SettingsChangeTime')).toEqual(
      dword(NOW_SECONDS),
    );
    expect(registryValueAt(expected, modRoot(ALPHA), 'SettingsChangeTime')).not.toEqual(dword(123));
    expect(registryValueAt(expected, modRoot(BETA), 'SettingsChangeTime')).not.toEqual(dword(456));
  });

  it('skips mods missing from the current registry with reason missing-key', () => {
    const { source, current } = restoreFixtures();
    const writes = planRestoreWrites(source, current, NOW_MS);

    expect(writes.skippedMods.map(({ modId, reason }) => ({ modId, reason }))).toEqual([
      { modId: GONE, reason: 'missing-key' },
      { modId: INSTALLED_AFTER, reason: 'newer-than-snapshot' },
    ]);
    expect(writes.skippedMods[0]?.message).toContain('no longer installed');
    expect(writes.warnings).toHaveLength(2);
    expect(writes.warnings[0]).toContain(NEWER);
    expect(writes.warnings[0]).toContain('2.0.0');
    expect(writes.warnings[0]).toContain('1.0.0');
    expect(writes.warnings[1]).toContain(INSTALLED_AFTER);
    expect(writes.warnings[1]).toContain('installed after');

    expect(writes.allOps.some((operation) => operation.path.includes(GONE))).toBe(false);
    expect(
      writes.expectedSnapshot.keys.some(
        (key) => key.path.toLowerCase() === modRoot(GONE).toLowerCase(),
      ),
    ).toBe(false);
  });

  it('restores a newer mod configuration while leaving its installed version untouched', () => {
    const { source, current } = restoreFixtures();
    const writes = planRestoreWrites(source, current, NOW_MS);

    expect(writes.allOps.some((operation) => operation.path.includes(NEWER))).toBe(true);
    expect(writes.touchedModIds).toContain(NEWER);
    expect(
      writes.allOps.some(
        (operation) =>
          operation.name.toLowerCase() === 'version' ||
          operation.name.toLowerCase() === 'libraryfilename',
      ),
    ).toBe(false);
    expect(writes.warnings.some((warning) => warning.includes('will still be restored'))).toBe(
      true,
    );

    const expected = writes.expectedSnapshot;
    expect(registryValueAt(expected, modRoot(NEWER), 'Disabled')).toEqual(dword(0));
    expect(registryValueAt(expected, modRoot(NEWER), 'Version')).toEqual(stringValue('2.0.0'));
    expect(registryValueAt(expected, modRoot(NEWER), 'SettingsChangeTime')).toEqual(
      dword(NOW_SECONDS),
    );
    expect(registryValueAt(expected, settingsPath(NEWER), 'Theme')).toEqual(
      stringValue('snapshot-theme'),
    );
  });

  it('lists mods installed after the snapshot as newer and leaves them untouched', () => {
    const { source, current } = restoreFixtures();
    const writes = planRestoreWrites(source, current, NOW_MS);

    const installedAfter = writes.skippedMods.find((entry) => entry.modId === INSTALLED_AFTER);
    expect(installedAfter?.reason).toBe('newer-than-snapshot');
    expect(installedAfter?.message).toContain('installed after');
    expect(writes.allOps.some((operation) => operation.path.includes(INSTALLED_AFTER))).toBe(false);
    expect(writes.touchedModIds).not.toContain(INSTALLED_AFTER);

    const expected = writes.expectedSnapshot;
    expect(registryValueAt(expected, modRoot(INSTALLED_AFTER), 'Disabled')).toEqual(dword(0));
    expect(registryValueAt(expected, settingsPath(INSTALLED_AFTER), 'Fresh')).toEqual(
      stringValue('installed-after'),
    );
  });

  it('returns four empty batches when the captured state already matches', () => {
    const snapshot = makeSnapshot([
      ...modKeys(ALPHA, {
        enabled: true,
        settings: { Theme: stringValue('same') },
        extraRootValues: { SettingsChangeTime: dword(10) },
      }),
    ]);

    const writes = planRestoreWrites(snapshot, snapshot, NOW_MS);

    expectBatches(writes);
    expect(writes.batches.map((batch) => batch.ops)).toEqual([[], [], [], []]);
    expect(writes.allOps).toEqual([]);
    expect(writes.touchedModIds).toEqual([]);
    expect(writes.skippedMods).toEqual([]);
    expect(writes.warnings).toEqual([]);
    expect(writes.unrestorableModIds).toEqual([]);
    expect(writes.expectedSnapshot).toEqual(snapshot);
  });
});

describe('planRollbackWrites', () => {
  it('restores pre-run values, deletes values added after the snapshot, and re-stamps markers', () => {
    const { preRun, current } = rollbackFixtures();
    const writes = planRollbackWrites(preRun, current, NOW_MS);

    expectBatches(writes);

    expect(stageOps(writes, 'disable')).toEqual([]);
    expect(stageOps(writes, 'settings')).toEqual([
      setOp(modRoot(ALPHA), 'Include', stringValue('pre-include')),
      deleteOp(modRoot(ALPHA), 'Architecture'),
      setOp(settingsPath(ALPHA), 'Theme', stringValue('pre')),
      setOp(settingsPath(ALPHA), 'Legacy', stringValue('pre-extra')),
      deleteOp(settingsPath(ALPHA), 'AddedAfter'),
    ]);
    expect(stageOps(writes, 'marker')).toEqual([
      setOp(modRoot(ALPHA), 'SettingsChangeTime', dword(NOW_SECONDS)),
    ]);
    expect(stageOps(writes, 'enable')).toEqual([setOp(modRoot(ALPHA), 'Disabled', dword(0))]);

    expect(writes.touchedModIds).toEqual([ALPHA]);
    expect(writes.skippedMods).toEqual([]);
    expect(writes.warnings).toEqual([]);
    expect(writes.unrestorableModIds).toEqual([GONE]);

    expect(writes.allOps.every((operation) => operation.path !== REGISTRY_MODS_ROOT)).toBe(true);
    expect(
      writes.allOps.every(
        (operation) => operation.kind === 'set' || operation.kind === 'deleteValue',
      ),
    ).toBe(true);
    expect(
      writes.allOps.every((operation) =>
        [modRoot(ALPHA), settingsPath(ALPHA)].includes(operation.path),
      ),
    ).toBe(true);

    const forbidden = writes.allOps.filter((operation) =>
      ROOT_FORBIDDEN_NAMES.has(operation.name.toLowerCase()),
    );
    expect(forbidden).toEqual([setOp(modRoot(ALPHA), 'SettingsChangeTime', dword(NOW_SECONDS))]);

    const expected = writes.expectedSnapshot;
    expect(registryValueAt(expected, modRoot(ALPHA), 'Disabled')).toEqual(dword(0));
    expect(registryValueAt(expected, modRoot(ALPHA), 'Include')).toEqual(
      stringValue('pre-include'),
    );
    expect(registryValueAt(expected, modRoot(ALPHA), 'Architecture')).toBeNull();
    expect(registryValueAt(expected, modRoot(ALPHA), 'UnknownRoot')).toEqual(
      stringValue('leave-me'),
    );
    expect(registryValueAt(expected, modRoot(ALPHA), 'Version')).toEqual(stringValue('1.1.0'));
    expect(registryValueAt(expected, modRoot(ALPHA), 'LibraryFileName')).toEqual(
      stringValue('alpha-run.dll'),
    );
    expect(registryValueAt(expected, modRoot(ALPHA), 'SettingsChangeTime')).toEqual(
      dword(NOW_SECONDS),
    );
    expect(registryValueAt(expected, modRoot(ALPHA), 'SettingsChangeTime')).not.toEqual(dword(300));
    expect(registryValueAt(expected, settingsPath(ALPHA), 'Theme')).toEqual(stringValue('pre'));
    expect(registryValueAt(expected, settingsPath(ALPHA), 'Legacy')).toEqual(
      stringValue('pre-extra'),
    );
    expect(registryValueAt(expected, settingsPath(ALPHA), 'AddedAfter')).toBeNull();
    expect(
      expected.keys.some((key) => key.path.toLowerCase() === modRoot(GONE).toLowerCase()),
    ).toBe(false);
  });

  it('reports unrestorable pre-run mods without creating their keys', () => {
    const preRun = makeSnapshot([
      ...modKeys(ALPHA, { settings: { Theme: stringValue('pre') } }),
      ...modKeys(GONE, { enabled: true }),
    ]);
    const current = makeSnapshot([...modKeys(ALPHA, { settings: { Theme: stringValue('pre') } })]);

    const writes = planRollbackWrites(preRun, current, NOW_MS);

    expectBatches(writes);
    expect(writes.unrestorableModIds).toEqual([GONE]);
    expect(writes.skippedMods).toEqual([]);
    expect(writes.warnings).toEqual([]);
    expect(writes.allOps).toEqual([]);
    expect(writes.touchedModIds).toEqual([]);
    expect(writes.expectedSnapshot).toEqual(current);
  });
});
