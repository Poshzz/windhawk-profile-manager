import {
  SCHEMA_VERSION,
  canonicalPlanHashInput,
  isAbsoluteWindowsPath,
  parsePlan,
  type ApplyPlan,
  type Environment,
  type PlanBlocker,
  type PlanModChange,
  type PlanPaths,
  type PlanSkippedMod,
  type PlanWarning,
  type Profile,
  type ProfileActions,
  type RegistrySnapshot,
  type UnlistedMod,
} from '@shared/domain';
import { CompatibilityError, ValidationError } from '@shared/errors';
import {
  computeBeforeHash,
  computeSettingsHash,
  diffProfileSettings,
  hashCanonical,
  readInstalledMods,
} from './registry-state';

export const PLAN_WARNING_CODES = {
  missingMod: 'missing-mod',
  versionMismatch: 'version-mismatch',
  serviceStopped: 'service-stopped',
  portableMode: 'portable-mode',
  nonHklmRoot: 'non-hklm-root',
  perUserConfigActive: 'per-user-config-active',
  machineSpecificValue: 'machine-specific-value',
  deleteAllSettings: 'delete-all-settings',
  requiredModMissing: 'required-missing',
} as const;

export interface ThemePackModHint {
  readonly modId: string;
  readonly testedVersion: string;
}

export interface ApplyPlanOptions {
  readonly runId: string;
  readonly snapshotId: string;
  readonly paths: PlanPaths;
  readonly themePackMods?: readonly ThemePackModHint[];
  readonly explorerRestart?: ProfileActions['restartExplorer'];
  /** App-level preference used only when the profile action is "ask". */
  readonly explorerFallback?: ProfileActions['restartExplorer'];
  readonly confirmDeleteAllSettings?: boolean;
  /** Filled by HomeService from the non-elevated process identity. */
  readonly invokingUser?: string;
  /** Persisted automatic-snapshot retention for the helper. */
  readonly snapshotRetentionLimit?: number;
  /** A bundled theme-pack profile must not apply with a required mod missing. */
  readonly requireAllRequiredMods?: boolean;
}

const MAX_WARNING_VALUE_LENGTH = 200;

function normalizeRegistryRoot(value: string): string {
  return value.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

/**
 * Precedence: an explicit always/never dialog choice wins, then a concrete
 * profile action, then the app preference. "ask" is unresolved, not a result.
 */
function resolveExplorerRestart(
  profileAction: ProfileActions['restartExplorer'],
  override: ProfileActions['restartExplorer'] | undefined,
  fallback: ProfileActions['restartExplorer'] | undefined,
): ProfileActions['restartExplorer'] {
  if (override !== undefined && override !== 'ask') return override;
  if (profileAction !== 'ask') return profileAction;
  return fallback ?? 'ask';
}

function appendEnvironmentWarnings(
  environment: Environment,
  options: ApplyPlanOptions,
  warnings: PlanWarning[],
): void {
  const versions = new Map<string, string | null>();
  for (const mod of environment.mods) versions.set(mod.modId.toLowerCase(), mod.version);

  for (const hint of options.themePackMods ?? []) {
    const installedVersion = versions.get(hint.modId.toLowerCase());
    if (installedVersion === undefined || installedVersion === null) continue;
    if (installedVersion === hint.testedVersion) continue;

    warnings.push({
      code: PLAN_WARNING_CODES.versionMismatch,
      modId: hint.modId,
      message: `Mod "${hint.modId}" is installed at ${installedVersion}; the theme pack was tested with ${hint.testedVersion}.`,
    });
  }

  if (environment.service.state !== 'running') {
    warnings.push({
      code: PLAN_WARNING_CODES.serviceStopped,
      message:
        environment.service.state === 'missing'
          ? `The Windhawk service "${environment.service.name}" is not registered; the app cannot start it.`
          : `The Windhawk service is ${environment.service.state}; the app will start it before writing.`,
    });
  }

  if (environment.windhawk.storageMode === 'portable' || environment.windhawk.portable) {
    warnings.push({
      code: PLAN_WARNING_CODES.portableMode,
      message:
        'Windhawk is running in portable mode; registry-based profile switching may not affect it.',
    });
  }

  const registryRoot = environment.windhawk.registryRoot;
  if (registryRoot !== null && normalizeRegistryRoot(registryRoot) !== 'hklm\\software\\windhawk') {
    warnings.push({
      code: PLAN_WARNING_CODES.nonHklmRoot,
      message: `Windhawk is configured under "${registryRoot}" instead of HKLM\\SOFTWARE\\Windhawk.`,
    });
  }

  if (environment.perUserConfig.active) {
    warnings.push({
      code: PLAN_WARNING_CODES.perUserConfigActive,
      message:
        'An active per-user Windhawk configuration is present; global writes are blocked until it is removed.',
    });
  }
}

function appendMachineSpecificWarnings(profile: Profile, warnings: PlanWarning[]): void {
  for (const mod of profile.requiredMods) {
    for (const [name, setting] of Object.entries(mod.settings)) {
      if (setting.type !== 'string' || !isAbsoluteWindowsPath(setting.value)) continue;
      const shown =
        setting.value.length > MAX_WARNING_VALUE_LENGTH
          ? `${setting.value.slice(0, MAX_WARNING_VALUE_LENGTH - 3)}...`
          : setting.value;

      warnings.push({
        code: PLAN_WARNING_CODES.machineSpecificValue,
        modId: mod.modId,
        message: `Setting "${name}" contains the absolute path "${shown}" and may be machine-specific.`,
      });
    }
  }
}

export function buildPlan(
  profile: Profile,
  current: RegistrySnapshot,
  environment: Environment,
  options: ApplyPlanOptions,
): ApplyPlan {
  const installed = readInstalledMods(current);
  const managedIds = new Set(profile.requiredMods.map((mod) => mod.modId.toLowerCase()));
  const modChanges: PlanModChange[] = [];
  const effectiveChanges: boolean[] = [];
  const missingMods: PlanSkippedMod[] = [];
  const warnings: PlanWarning[] = [];

  for (const mod of profile.requiredMods) {
    const state = installed.get(mod.modId.toLowerCase());
    if (state === undefined) {
      missingMods.push({
        modId: mod.modId,
        reason: 'missing',
        message: `Mod "${mod.modId}" is not installed and will be skipped.`,
      });
      warnings.push({
        code: PLAN_WARNING_CODES.missingMod,
        modId: mod.modId,
        message: `Mod "${mod.modId}" is not installed; it will be skipped.`,
      });
      continue;
    }

    const diff = diffProfileSettings(mod.settings, state, mod.mode);
    const transitioned = (mod.state === 'enabled') !== state.enabled;

    modChanges.push({
      modId: mod.modId,
      state: mod.state,
      mode: mod.mode,
      settings: mod.settings,
      deleteValues: [...diff.deleteValues],
      settingsChanged: diff.settingsChanged,
      deleteAllSettings: diff.deleteAllSettings,
      settingsHash: computeSettingsHash(state),
    });
    effectiveChanges.push(transitioned || diff.settingsChanged || diff.deleteAllSettings);

    if (diff.deleteAllSettings && options.confirmDeleteAllSettings !== true) {
      warnings.push({
        code: PLAN_WARNING_CODES.deleteAllSettings,
        modId: mod.modId,
        message: `Mode "replace" with an empty settings map deletes every setting for "${mod.modId}"; explicit confirmation is required.`,
      });
    }
  }

  const unlistedMods: UnlistedMod[] = [...installed.values()]
    .filter((state) => !managedIds.has(state.modId))
    .sort((left, right) => left.modId.localeCompare(right.modId))
    .map((state) => ({
      modId: state.modId,
      state: state.enabled ? 'enabled' : 'disabled',
      policy: profile.unlistedMods,
      willDisable: profile.unlistedMods === 'disable' && state.enabled,
    }));

  appendEnvironmentWarnings(environment, options, warnings);
  appendMachineSpecificWarnings(profile, warnings);

  const actions: ProfileActions = {
    rainmeter: profile.actions.rainmeter,
    restartExplorer: resolveExplorerRestart(
      profile.actions.restartExplorer,
      options.explorerRestart,
      options.explorerFallback,
    ),
  };

  const blockers: PlanBlocker[] = [];
  if (options.requireAllRequiredMods === true && missingMods.length > 0) {
    const modIds = missingMods.map((mod) => mod.modId);
    blockers.push({
      code: 'required-missing',
      message: `This theme-pack profile cannot be applied until every required mod is installed. Missing: ${modIds.join(', ')}.`,
      modIds,
    });
  }

  const hasRegistryChange =
    effectiveChanges.some(Boolean) || unlistedMods.some((mod) => mod.willDisable);
  const hasAction = actions.rainmeter !== 'unchanged' || actions.restartExplorer === 'always';
  const noOp = !hasRegistryChange && !hasAction;

  const planBase = {
    schemaVersion: SCHEMA_VERSION,
    kind: 'apply' as const,
    runId: options.runId,
    snapshotId: options.snapshotId,
    profileId: profile.id,
    profileRevision: profile.revision,
    beforeHash: computeBeforeHash(profile, current),
    paths: options.paths,
    actions,
    ...(options.invokingUser === undefined ? {} : { invokingUser: options.invokingUser }),
    ...(options.snapshotRetentionLimit === undefined
      ? {}
      : { snapshotRetention: options.snapshotRetentionLimit }),
    modChanges,
    missingMods,
    unlistedMods,
    unlistedPolicy: profile.unlistedMods,
    noOp,
    deleteAllSettingsConfirmed: options.confirmDeleteAllSettings === true,
    blockers,
    warnings,
  };
  const planHash = hashCanonical(canonicalPlanHashInput({ ...planBase, planHash: '' }));
  const parsed = parsePlan({ ...planBase, planHash });
  if (parsed.kind !== 'apply') {
    throw new ValidationError('The planner produced a non-apply plan.');
  }

  return parsed;
}

export class ApplyPlanner {
  static buildPlan(
    profile: Profile,
    current: RegistrySnapshot,
    environment: Environment,
    options: ApplyPlanOptions,
  ): ApplyPlan {
    return buildPlan(profile, current, environment, options);
  }
}

export function planRequiresDeleteAllSettingsConfirmation(plan: ApplyPlan): boolean {
  return (
    plan.modChanges.some((change) => change.deleteAllSettings) && !plan.deleteAllSettingsConfirmed
  );
}

/** The backend readiness gate shared by planning, running, and the helper. */
export function planBlockingError(plan: ApplyPlan): CompatibilityError | null {
  const blocker = plan.blockers[0];
  if (blocker === undefined) return null;
  return new CompatibilityError(blocker.message, {
    details: blocker.modIds.map((modId) => ({
      path: ['blockers', blocker.code, modId],
      message: `Required mod "${modId}" is not installed.`,
    })),
  });
}
