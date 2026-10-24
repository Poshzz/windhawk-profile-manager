import {
  SCHEMA_VERSION,
  canonicalPlanHashInput,
  parsePlan,
  type PlanWarning,
  type ProfileActions,
  type RegistrySnapshot,
  type RestorePaths,
  type RestorePlan,
  type SnapshotMetadata,
} from '@shared/domain';
import { ValidationError } from '@shared/errors';
import { planRestoreWrites } from '@core/executor/registry-writes';
import { hashCanonical } from './registry-state';
import {
  computeRestoreManagedHash,
  restoreSourceModIds,
  restoreTargetingValues,
} from './restore-state';

export const RESTORE_WARNING_CODES = {
  targetingValues: 'machine-specific-targeting',
} as const;

export interface BuildRestorePlanOptions {
  readonly runId: string;
  readonly snapshotId: string;
  readonly paths: RestorePaths;
  readonly restartExplorer?: ProfileActions['restartExplorer'];
  /** Filled by HomeService from the non-elevated process identity. */
  readonly invokingUser?: string;
  /** Persisted automatic-snapshot retention for the helper. */
  readonly snapshotRetentionLimit?: number;
  /** True only after the user confirmed machine-specific targeting values. */
  readonly confirmTargeting?: boolean;
}

export interface RestoreSource {
  readonly metadata: SnapshotMetadata;
  readonly registry: RegistrySnapshot;
}

/** Builds the same hashed ExecutionPlan envelope used by apply. */
export function buildRestorePlan(
  source: RestoreSource,
  current: RegistrySnapshot,
  options: BuildRestorePlanOptions,
): RestorePlan {
  const sourceIds = restoreSourceModIds(source.registry);
  const targetingValues = restoreTargetingValues(source.registry);
  const preview = planRestoreWrites(source.registry, current, Date.now());
  const summary = {
    setValues: preview.allOps.filter(
      (operation) =>
        operation.kind === 'set' && operation.name.toLowerCase() !== 'settingschangetime',
    ).length,
    deleteValues: preview.allOps.filter((operation) => operation.kind === 'deleteValue').length,
    touchedMods: preview.touchedModIds.length,
    skippedMods: preview.skippedMods,
  };
  const warnings: PlanWarning[] = preview.warnings.map((message) => ({
    code: 'restore-version',
    message,
  }));
  if (targetingValues.length > 0) {
    const trigger = source.metadata.trigger === 'imported' ? 'imported snapshot' : 'snapshot';
    warnings.push({
      code: RESTORE_WARNING_CODES.targetingValues,
      message: `This ${trigger} contains machine-specific targeting values (${[...new Set(targetingValues.map((value) => value.name))].join(', ')}); restoring them changes which processes receive Windhawk mods.`,
    });
  }

  const planBase = {
    schemaVersion: SCHEMA_VERSION,
    kind: 'restore' as const,
    runId: options.runId,
    snapshotId: options.snapshotId,
    profileId: null,
    profileRevision: 0,
    beforeHash: computeRestoreManagedHash(current, sourceIds),
    actions: {
      rainmeter: source.metadata.rainmeterRunning ? ('start' as const) : ('stop' as const),
      restartExplorer: options.restartExplorer ?? ('ask' as const),
    },
    ...(options.invokingUser === undefined ? {} : { invokingUser: options.invokingUser }),
    ...(options.snapshotRetentionLimit === undefined
      ? {}
      : { snapshotRetention: options.snapshotRetentionLimit }),
    sourceSnapshotId: source.metadata.id,
    sourceSnapshotSha256: source.metadata.registrySha256,
    targetingValues,
    targetingConfirmed: options.confirmTargeting === true,
    summary,
    paths: options.paths,
    warnings,
  };
  const planHash = hashCanonical(canonicalPlanHashInput({ ...planBase, planHash: '' }));
  const parsed = parsePlan({ ...planBase, planHash });
  if (parsed.kind !== 'restore') {
    throw new ValidationError('The restore planner produced a non-restore plan.');
  }
  return parsed;
}
