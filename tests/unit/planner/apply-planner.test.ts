import { describe, expect, it } from 'vitest';
import {
  ApplyPlanner,
  PLAN_WARNING_CODES,
  buildPlan,
  planBlockingError,
  planRequiresDeleteAllSettingsConfirmation,
} from '@core/planner/apply-planner';
import {
  diffProfileSettings,
  hashCanonical,
  readInstalledMods,
} from '@core/planner/registry-state';
import { canonicalPlanHashInput, parseProfile } from '@shared/domain';
import {
  dword,
  makeEnvironment,
  makeProfile,
  makeSnapshot,
  managedMod,
  modKeys,
  planOptions,
  stringValue,
} from './support';

const TASKBAR_MOD = 'windows-11-taskbar-styler';

function matchingTaskbarKeys(): ReturnType<typeof modKeys> {
  return modKeys(TASKBAR_MOD, {
    settings: { TaskbarHeight: dword(48), Theme: stringValue('macOS') },
  });
}

describe('ApplyPlanner', () => {
  it('produces a stable plan hash and beforeHash regardless of key order', () => {
    const keys = matchingTaskbarKeys();
    const reversedKeys = [...keys]
      .reverse()
      .map((key) => ({ path: key.path, values: [...key.values].reverse() }));
    const profile = makeProfile();
    const firstMod = profile.requiredMods[0];
    if (firstMod === undefined) throw new Error('Expected a managed mod.');

    const reorderedProfile = parseProfile({
      ...profile,
      requiredMods: [
        {
          ...firstMod,
          settings: { Theme: stringValue('macOS'), TaskbarHeight: dword(48) },
        },
      ],
    });

    const options = planOptions();
    const left = buildPlan(profile, makeSnapshot(keys), makeEnvironment(), options);
    const right = buildPlan(
      reorderedProfile,
      makeSnapshot(reversedKeys),
      makeEnvironment(),
      options,
    );
    const viaClass = ApplyPlanner.buildPlan(
      profile,
      makeSnapshot(keys),
      makeEnvironment(),
      options,
    );

    expect(left.planHash).toBe(right.planHash);
    expect(left.beforeHash).toBe(right.beforeHash);
    expect(left.planHash).toBe(viaClass.planHash);
    expect(hashCanonical(canonicalPlanHashInput(left))).toBe(left.planHash);
  });

  it('marks a profile that already matches the registry as a no-op', () => {
    const plan = buildPlan(
      makeProfile(),
      makeSnapshot(matchingTaskbarKeys()),
      makeEnvironment(),
      planOptions(),
    );

    expect(plan.noOp).toBe(true);
    expect(plan.modChanges).toHaveLength(1);
    const change = plan.modChanges[0];
    expect(change?.settingsChanged).toBe(false);
    expect(change?.deleteValues).toEqual([]);
    expect(change?.deleteAllSettings).toBe(false);
  });

  it('sets settingsChanged=false for a Disabled-only transition', () => {
    const plan = buildPlan(
      makeProfile({
        requiredMods: [
          managedMod({
            modId: TASKBAR_MOD,
            state: 'disabled',
            settings: { TaskbarHeight: dword(48), Theme: stringValue('macOS') },
          }),
        ],
      }),
      makeSnapshot(matchingTaskbarKeys()),
      makeEnvironment(),
      planOptions(),
    );

    expect(plan.modChanges[0]?.state).toBe('disabled');
    expect(plan.modChanges[0]?.settingsChanged).toBe(false);
    expect(plan.noOp).toBe(false);
  });

  it('reports only settings whose current value differs from the profile', () => {
    const installed = readInstalledMods(
      makeSnapshot(
        modKeys(TASKBAR_MOD, {
          settings: {
            TaskbarHeight: dword(40),
            Theme: stringValue('macOS'),
            LegacyTheme: stringValue('old'),
          },
        }),
      ),
    );
    const state = installed.get(TASKBAR_MOD);

    const diff = diffProfileSettings(
      { TaskbarHeight: dword(48), Theme: stringValue('macOS') },
      state,
      'replace',
    );

    expect(diff.writes.map((write) => write.name)).toEqual(['TaskbarHeight']);
    expect(diff.deleteValues).toEqual(['LegacyTheme']);
    expect(diff.settingsChanged).toBe(true);
  });

  it('lists deletions for replace mode and none for merge mode', () => {
    const current = makeSnapshot(
      modKeys(TASKBAR_MOD, {
        settings: { Theme: stringValue('macOS'), LegacyTheme: stringValue('old') },
      }),
    );
    const replacePlan = buildPlan(
      makeProfile({
        requiredMods: [
          managedMod({ modId: TASKBAR_MOD, settings: { Theme: stringValue('macOS') } }),
        ],
      }),
      current,
      makeEnvironment(),
      planOptions(),
    );
    const mergePlan = buildPlan(
      makeProfile({
        requiredMods: [
          managedMod({
            modId: TASKBAR_MOD,
            mode: 'merge',
            settings: { Theme: stringValue('macOS') },
          }),
        ],
      }),
      current,
      makeEnvironment(),
      planOptions(),
    );

    expect(replacePlan.modChanges[0]?.deleteValues).toEqual(['LegacyTheme']);
    expect(replacePlan.modChanges[0]?.settingsChanged).toBe(true);
    expect(mergePlan.modChanges[0]?.deleteValues).toEqual([]);
    expect(mergePlan.modChanges[0]?.settingsChanged).toBe(false);
    expect(mergePlan.noOp).toBe(true);
  });

  it('flags a replace mod with an empty settings map as delete-all and requires confirmation', () => {
    const current = makeSnapshot(
      modKeys(TASKBAR_MOD, {
        settings: { TaskbarHeight: dword(48), Theme: stringValue('macOS') },
      }),
    );
    const profile = makeProfile({
      requiredMods: [managedMod({ modId: TASKBAR_MOD, settings: {} })],
    });

    const plan = buildPlan(profile, current, makeEnvironment(), planOptions());
    const change = plan.modChanges[0];
    expect(change?.deleteAllSettings).toBe(true);
    expect(change?.deleteValues).toEqual(['TaskbarHeight', 'Theme']);
    expect(change?.settingsChanged).toBe(true);
    expect(plan.noOp).toBe(false);
    expect(planRequiresDeleteAllSettingsConfirmation(plan)).toBe(true);
    expect(
      plan.warnings.some((warning) => warning.code === PLAN_WARNING_CODES.deleteAllSettings),
    ).toBe(true);

    const confirmed = buildPlan(
      profile,
      current,
      makeEnvironment(),
      planOptions({ confirmDeleteAllSettings: true }),
    );
    expect(confirmed.modChanges[0]?.deleteAllSettings).toBe(true);
    expect(confirmed.deleteAllSettingsConfirmed).toBe(true);
    expect(planRequiresDeleteAllSettingsConfirmation(confirmed)).toBe(false);
    expect(
      confirmed.warnings.some((warning) => warning.code === PLAN_WARNING_CODES.deleteAllSettings),
    ).toBe(false);
  });

  it('never treats delete-all with an empty current map as a no-op', () => {
    const plan = buildPlan(
      makeProfile({ requiredMods: [managedMod({ modId: TASKBAR_MOD, settings: {} })] }),
      makeSnapshot(modKeys(TASKBAR_MOD, { settings: {} })),
      makeEnvironment(),
      planOptions(),
    );

    expect(plan.modChanges[0]?.deleteAllSettings).toBe(true);
    expect(plan.modChanges[0]?.settingsChanged).toBe(false);
    expect(plan.noOp).toBe(false);
  });

  it('keeps missing mods out of the write set and never creates their key', () => {
    const plan = buildPlan(
      makeProfile({ requiredMods: [managedMod({ modId: 'missing-mod' })] }),
      makeSnapshot(modKeys('other-mod')),
      makeEnvironment(),
      planOptions(),
    );

    expect(plan.missingMods.map((mod) => mod.modId)).toEqual(['missing-mod']);
    expect(plan.modChanges).toEqual([]);
    expect(JSON.stringify(plan.modChanges)).not.toContain('missing-mod');
    expect(plan.warnings.some((warning) => warning.code === PLAN_WARNING_CODES.missingMod)).toBe(
      true,
    );
  });

  it('lists unlisted mods with their policy and only disables them on demand', () => {
    const current = makeSnapshot([...matchingTaskbarKeys(), ...modKeys('misc-mod')]);

    const leavePlan = buildPlan(makeProfile(), current, makeEnvironment(), planOptions());
    expect(leavePlan.unlistedMods).toEqual([
      { modId: 'misc-mod', state: 'enabled', policy: 'leave', willDisable: false },
    ]);
    expect(leavePlan.modChanges.some((change) => change.modId === 'misc-mod')).toBe(false);
    expect(leavePlan.noOp).toBe(true);

    const disablePlan = buildPlan(
      makeProfile({ unlistedMods: 'disable' }),
      current,
      makeEnvironment(),
      planOptions(),
    );
    expect(disablePlan.unlistedMods[0]).toMatchObject({
      modId: 'misc-mod',
      policy: 'disable',
      willDisable: true,
    });
    expect(disablePlan.noOp).toBe(false);
  });

  it('includes unlisted mods in beforeHash only when the policy disables them', () => {
    const current = makeSnapshot([...matchingTaskbarKeys(), ...modKeys('misc-mod')]);
    const leavePlan = buildPlan(makeProfile(), current, makeEnvironment(), planOptions());
    const disablePlan = buildPlan(
      makeProfile({ unlistedMods: 'disable' }),
      current,
      makeEnvironment(),
      planOptions(),
    );
    const changed = makeSnapshot([
      ...matchingTaskbarKeys(),
      ...modKeys('misc-mod', { enabled: false }),
    ]);
    const changedPlan = buildPlan(
      makeProfile({ unlistedMods: 'disable' }),
      changed,
      makeEnvironment(),
      planOptions(),
    );

    expect(leavePlan.beforeHash).not.toBe(disablePlan.beforeHash);
    expect(disablePlan.beforeHash).not.toBe(changedPlan.beforeHash);
  });

  it('never lists targeting, version, or reload-marker values for deletion', () => {
    const current = makeSnapshot(
      modKeys(TASKBAR_MOD, {
        settings: {
          TaskbarHeight: dword(48),
          Theme: stringValue('macOS'),
          Include: stringValue('not-a-profile-setting'),
          SettingsChangeTime: dword(99),
          LibraryFileName: stringValue('owned-by-windhawk.dll'),
        },
        extraRootValues: {
          Include: stringValue('%SystemRoot%\\explorer.exe'),
          SettingsChangeTime: dword(1),
          Version: stringValue('9.9.9'),
        },
      }),
    );

    const plan = buildPlan(makeProfile(), current, makeEnvironment(), planOptions());
    const change = plan.modChanges[0];

    expect(change?.deleteValues).toEqual([]);
    expect(change?.settingsChanged).toBe(false);
    expect(JSON.stringify(plan.modChanges)).not.toMatch(
      /Include|SettingsChangeTime|LibraryFileName|"Version"/,
    );
    expect(plan.noOp).toBe(true);
  });

  it('keeps a Rainmeter or Explorer action from being reported as a no-op', () => {
    const current = makeSnapshot(matchingTaskbarKeys());

    const rainmeter = buildPlan(
      makeProfile({ rainmeter: 'start' }),
      current,
      makeEnvironment(),
      planOptions(),
    );
    expect(rainmeter.actions.rainmeter).toBe('start');
    expect(rainmeter.noOp).toBe(false);

    const explorer = buildPlan(
      makeProfile({ restartExplorer: 'ask' }),
      current,
      makeEnvironment(),
      planOptions({ explorerRestart: 'always' }),
    );
    expect(explorer.actions.restartExplorer).toBe('always');
    expect(explorer.noOp).toBe(false);
  });

  it.each([
    {
      name: 'a stopped service',
      profile: makeProfile(),
      environment: makeEnvironment({ serviceState: 'stopped' }),
      options: planOptions(),
      code: PLAN_WARNING_CODES.serviceStopped,
    },
    {
      name: 'portable mode',
      profile: makeProfile(),
      environment: makeEnvironment({ storageMode: 'portable' }),
      options: planOptions(),
      code: PLAN_WARNING_CODES.portableMode,
    },
    {
      name: 'a non-HKLM registry root',
      profile: makeProfile(),
      environment: makeEnvironment({ registryRoot: 'HKCU\\SOFTWARE\\Windhawk' }),
      options: planOptions(),
      code: PLAN_WARNING_CODES.nonHklmRoot,
    },
    {
      name: 'an active per-user configuration',
      profile: makeProfile(),
      environment: makeEnvironment({ perUserActive: true }),
      options: planOptions(),
      code: PLAN_WARNING_CODES.perUserConfigActive,
    },
    {
      name: 'a version mismatch against the theme pack',
      profile: makeProfile(),
      environment: makeEnvironment({
        mods: [{ modId: TASKBAR_MOD, version: '1.6.0' }],
      }),
      options: planOptions({
        themePackMods: [{ modId: TASKBAR_MOD, testedVersion: '1.7.3' }],
      }),
      code: PLAN_WARNING_CODES.versionMismatch,
    },
    {
      name: 'a machine-specific absolute path',
      profile: makeProfile({
        requiredMods: [
          managedMod({
            modId: TASKBAR_MOD,
            settings: { IconTheme: stringValue('C:\\Themes\\Mac') },
          }),
        ],
      }),
      environment: makeEnvironment(),
      options: planOptions(),
      code: PLAN_WARNING_CODES.machineSpecificValue,
    },
  ])('warns about $name', ({ profile, environment, options, code }) => {
    const plan = buildPlan(profile, makeSnapshot(matchingTaskbarKeys()), environment, options);
    expect(plan.warnings.some((warning) => warning.code === code)).toBe(true);
  });

  it('binds the invoking user and retention limit into the hashed plan', () => {
    const base = buildPlan(
      makeProfile(),
      makeSnapshot(matchingTaskbarKeys()),
      makeEnvironment(),
      planOptions({ invokingUser: 'TEST\\alice', snapshotRetentionLimit: 7 }),
    );
    const changedRetention = buildPlan(
      makeProfile(),
      makeSnapshot(matchingTaskbarKeys()),
      makeEnvironment(),
      planOptions({ invokingUser: 'TEST\\alice', snapshotRetentionLimit: 9 }),
    );

    expect(base.invokingUser).toBe('TEST\\alice');
    expect(base.snapshotRetention).toBe(7);
    expect(changedRetention.planHash).not.toBe(base.planHash);
    expect(hashCanonical(canonicalPlanHashInput(base))).toBe(base.planHash);
  });

  it.each([
    {
      name: 'an explicit dialog choice wins over the profile',
      profile: 'always' as const,
      override: 'never' as const,
      fallback: 'always' as const,
      expected: 'never' as const,
    },
    {
      name: 'an unresolved ask override falls back to the profile action',
      profile: 'always' as const,
      override: 'ask' as const,
      fallback: 'never' as const,
      expected: 'always' as const,
    },
    {
      name: 'the app preference resolves a profile ask action',
      profile: 'ask' as const,
      override: undefined,
      fallback: 'always' as const,
      expected: 'always' as const,
    },
    {
      name: 'an unresolved ask stays ask when the app preference is ask',
      profile: 'ask' as const,
      override: 'ask' as const,
      fallback: 'ask' as const,
      expected: 'ask' as const,
    },
    {
      name: 'a profile never action outranks the app preference',
      profile: 'never' as const,
      override: undefined,
      fallback: 'always' as const,
      expected: 'never' as const,
    },
  ])('resolves Explorer restart: $name', ({ profile, override, fallback, expected }) => {
    const plan = buildPlan(
      makeProfile({ restartExplorer: profile }),
      makeSnapshot(matchingTaskbarKeys()),
      makeEnvironment(),
      planOptions({
        ...(override === undefined ? {} : { explorerRestart: override }),
        explorerFallback: fallback,
      }),
    );

    expect(plan.actions.restartExplorer).toBe(expected);
  });

  it('blocks a bundled theme-pack profile when any of its ten mods is missing', () => {
    const mods = Array.from({ length: 10 }, (_, index) => `theme-pack-mod-${index}`);
    const profile = makeProfile({
      requiredMods: mods.map((modId) => managedMod({ modId })),
    });
    const snapshot = makeSnapshot(mods.slice(0, 9).flatMap((modId) => modKeys(modId)));

    const blocked = buildPlan(
      profile,
      snapshot,
      makeEnvironment(),
      planOptions({ requireAllRequiredMods: true }),
    );
    expect(blocked.missingMods.map((mod) => mod.modId)).toEqual(['theme-pack-mod-9']);
    expect(blocked.blockers).toEqual([
      expect.objectContaining({
        code: 'required-missing',
        modIds: ['theme-pack-mod-9'],
      }),
    ]);
    expect(planBlockingError(blocked)).toMatchObject({ code: 'COMPATIBILITY' });

    const userProfile = buildPlan(
      profile,
      snapshot,
      makeEnvironment(),
      planOptions({ requireAllRequiredMods: false }),
    );
    expect(userProfile.blockers).toEqual([]);
    expect(userProfile.missingMods).toHaveLength(1);
    expect(planBlockingError(userProfile)).toBeNull();
  });
});
