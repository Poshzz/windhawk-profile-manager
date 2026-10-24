import {
  REGISTRY_MODS_ROOT,
  getModIdFromRegistryPath,
  stableStringify,
  type ApplyPlan,
  type PlanSkippedMod,
  type RegistryOp,
  type RegistrySnapshot,
  type RegistryValue,
} from '@shared/domain';
import { compareVersions } from '@core/environment/windhawk-ini';
import { isWritableSettingValue, planReconcileOperations } from '@core/registry/reconcile';
import { applyMutationsToSnapshot } from '@core/registry/snapshot-operations';
import { filterSnapshotToMods, restoreSourceModIds } from '@core/planner/restore-state';
import { profileSettingEquals, readInstalledMods } from '@core/planner/registry-state';
import { ValidationError } from '@shared/errors';

export const SETTINGS_CHANGE_TIME = 'SettingsChangeTime';

export type WriteStage = 'disable' | 'settings' | 'marker' | 'enable';

export interface WriteBatch {
  readonly stage: WriteStage;
  readonly ops: RegistryOp[];
}

export interface PlannedWrites {
  readonly batches: readonly WriteBatch[];
  readonly allOps: RegistryOp[];
  readonly touchedModIds: string[];
  readonly expectedSnapshot: RegistrySnapshot;
  readonly skippedMods: PlanSkippedMod[];
  readonly warnings: string[];
  readonly unrestorableModIds: string[];
}

const SETTINGS_SUFFIX = '\\settings';

function keyFor(snapshot: RegistrySnapshot, path: string) {
  const normalized = path.toLowerCase();
  return snapshot.keys.find((key) => key.path.toLowerCase() === normalized);
}

function valueFor(snapshot: RegistrySnapshot, path: string, name: string): RegistryValue | null {
  const key = keyFor(snapshot, path);
  const entry = key?.values.find((value) => value.name.toLowerCase() === name.toLowerCase());
  return entry?.value ?? null;
}

export function registryValueAt(
  snapshot: RegistrySnapshot,
  path: string,
  name: string,
): RegistryValue | null {
  return valueFor(snapshot, path, name);
}

function rootPath(modId: string): string {
  return `${REGISTRY_MODS_ROOT}\\${modId}`;
}

function settingsPath(modId: string): string {
  return `${rootPath(modId)}\\Settings`;
}

export function valuesEqual(left: RegistryValue, right: RegistryValue): boolean {
  return stableStringify(left) === stableStringify(right);
}

/**
 * SettingsChangeTime is a positive 31-bit DWORD of Unix seconds. `nowMs` is the
 * epoch-millisecond clock used by the executor. The result is strictly greater
 * than the previous value and wraps to 1 instead of crossing 0x7fffffff.
 */
export function nextSettingsChangeTime(previous: number, nowMs: number): number {
  const normalizedPrevious = Number.isInteger(previous) && previous > 0 ? previous : 0;
  const candidate = Math.floor(nowMs / 1000) & 0x7fffffff;
  let next = Math.max(candidate, normalizedPrevious + 1);
  if (next > 0x7fffffff || next <= 0) next = 1;
  return next;
}

function previousSettingsChangeTime(snapshot: RegistrySnapshot, modId: string): number {
  const value = valueFor(snapshot, rootPath(modId), SETTINGS_CHANGE_TIME);
  return value?.type === 'dword' ? value.value : 0;
}

function assertWritableCurrentDisabled(snapshot: RegistrySnapshot, modId: string): void {
  const value = valueFor(snapshot, rootPath(modId), 'Disabled');
  if (value !== null && value.type !== 'dword') {
    throw new ValidationError(
      `The current Disabled value for "${modId}" has type "${value.type}", which cannot be restored if the apply needs to roll back.`,
    );
  }
}

function mutationHasEffect(op: RegistryOp, current: RegistrySnapshot): boolean {
  const existing = valueFor(current, op.path, op.name);
  if (op.kind === 'deleteValue') return existing !== null;
  return existing === null || !valuesEqual(existing, op.value);
}

function filterEffectiveOps(
  operations: readonly RegistryOp[],
  current: RegistrySnapshot,
): RegistryOp[] {
  return operations.filter((operation) => mutationHasEffect(operation, current));
}

function appendUnique(operations: RegistryOp[], seen: Set<string>, operation: RegistryOp): void {
  const key = `${operation.kind}\u0000${operation.path.toLowerCase()}\u0000${operation.name.toLowerCase()}`;
  if (seen.has(key)) return;
  seen.add(key);
  operations.push(operation);
}

function groupOperations(
  operations: readonly RegistryOp[],
  current: RegistrySnapshot,
  nowMs: number,
): {
  batches: WriteBatch[];
  touchedModIds: string[];
  allOps: RegistryOp[];
} {
  const disable: RegistryOp[] = [];
  const middle: RegistryOp[] = [];
  const enable: RegistryOp[] = [];
  const touched = new Map<string, string>();
  const settingsChanged = new Map<string, string>();

  for (const operation of operations) {
    const modId = getModIdFromRegistryPath(operation.path);
    if (modId === null) continue;
    const normalizedModId = modId.toLowerCase();
    touched.set(normalizedModId, modId);

    const isRoot = operation.path.toLowerCase() === rootPath(modId).toLowerCase();
    if (isRoot && operation.name.toLowerCase() === 'disabled') {
      if (
        operation.kind === 'set' &&
        operation.value.type === 'dword' &&
        operation.value.value !== 0
      ) {
        disable.push(operation);
      } else {
        enable.push(operation);
      }
      continue;
    }

    middle.push(operation);
    if (operation.path.toLowerCase().endsWith(SETTINGS_SUFFIX)) {
      settingsChanged.set(normalizedModId, modId);
    }
  }

  const marker: RegistryOp[] = [];
  for (const [normalizedModId, modId] of settingsChanged) {
    marker.push({
      kind: 'set',
      path: rootPath(modId),
      name: SETTINGS_CHANGE_TIME,
      value: {
        type: 'dword',
        value: nextSettingsChangeTime(previousSettingsChangeTime(current, normalizedModId), nowMs),
      },
    });
  }

  const allOps = [...disable, ...middle, ...marker, ...enable];
  return {
    batches: [
      { stage: 'disable', ops: disable },
      { stage: 'settings', ops: middle },
      { stage: 'marker', ops: marker },
      { stage: 'enable', ops: enable },
    ],
    touchedModIds: [...touched.values()],
    allOps,
  };
}

function finalize(
  batches: WriteBatch[],
  allOps: RegistryOp[],
  touchedModIds: string[],
  skippedMods: PlanSkippedMod[],
  warnings: string[],
  unrestorableModIds: string[],
  current: RegistrySnapshot,
): PlannedWrites {
  return {
    batches,
    allOps,
    touchedModIds,
    expectedSnapshot: applyMutationsToSnapshot(current, allOps),
    skippedMods,
    warnings,
    unrestorableModIds,
  };
}

export function planApplyWrites(
  plan: ApplyPlan,
  current: RegistrySnapshot,
  nowMs: number,
): PlannedWrites {
  const installed = readInstalledMods(current);
  const operations: RegistryOp[] = [];
  const seen = new Set<string>();
  const skippedMods: PlanSkippedMod[] = [...plan.missingMods];
  const warnings: string[] = [];

  for (const change of plan.modChanges) {
    const state = installed.get(change.modId.toLowerCase());
    if (state === undefined) {
      skippedMods.push({
        modId: change.modId,
        reason: 'missing',
        message: `Mod "${change.modId}" is no longer installed and was skipped.`,
      });
      continue;
    }

    if (change.state === 'disabled' && state.enabled) {
      assertWritableCurrentDisabled(current, change.modId);
      appendUnique(operations, seen, {
        kind: 'set',
        path: rootPath(change.modId),
        name: 'Disabled',
        value: { type: 'dword', value: 1 },
      });
    }

    for (const [name, setting] of Object.entries(change.settings)) {
      const currentValue = state.settings.get(name.toLowerCase())?.value;
      if (currentValue !== undefined && profileSettingEquals(setting, currentValue)) continue;
      if (currentValue !== undefined && !isWritableSettingValue(currentValue)) {
        throw new ValidationError(
          `Setting "${name}" for "${change.modId}" has type "${currentValue.type}", which cannot be restored if the apply needs to roll back.`,
        );
      }
      appendUnique(operations, seen, {
        kind: 'set',
        path: settingsPath(change.modId),
        name,
        value: setting,
      });
    }

    const deletes = new Set(change.deleteValues.map((name) => name.toLowerCase()));
    if (change.deleteAllSettings) {
      for (const entry of state.settings.values()) deletes.add(entry.name.toLowerCase());
    }
    for (const entry of state.settings.values()) {
      if (!deletes.has(entry.name.toLowerCase())) continue;
      if (!isWritableSettingValue(entry.value)) {
        throw new ValidationError(
          `Setting "${entry.name}" for "${change.modId}" has type "${entry.value.type}", which cannot be restored if the apply needs to roll back.`,
        );
      }
      appendUnique(operations, seen, {
        kind: 'deleteValue',
        path: settingsPath(change.modId),
        name: entry.name,
      });
    }

    if (change.state === 'enabled' && !state.enabled) {
      assertWritableCurrentDisabled(current, change.modId);
      appendUnique(operations, seen, {
        kind: 'set',
        path: rootPath(change.modId),
        name: 'Disabled',
        value: { type: 'dword', value: 0 },
      });
    }
  }

  for (const unlisted of plan.unlistedMods) {
    if (!unlisted.willDisable) continue;
    const state = installed.get(unlisted.modId.toLowerCase());
    if (state === undefined) {
      skippedMods.push({
        modId: unlisted.modId,
        reason: 'missing',
        message: `Unlisted mod "${unlisted.modId}" is no longer installed and was skipped.`,
      });
      continue;
    }
    if (!state.enabled) continue;
    assertWritableCurrentDisabled(current, unlisted.modId);
    appendUnique(operations, seen, {
      kind: 'set',
      path: rootPath(unlisted.modId),
      name: 'Disabled',
      value: { type: 'dword', value: 1 },
    });
  }

  const grouped = groupOperations(operations, current, nowMs);
  return finalize(
    grouped.batches,
    grouped.allOps,
    grouped.touchedModIds,
    skippedMods,
    warnings,
    [],
    current,
  );
}

function sourceDisplayModIds(snapshot: RegistrySnapshot): Map<string, string> {
  const result = new Map<string, string>();
  for (const key of snapshot.keys) {
    const modId = getModIdFromRegistryPath(key.path);
    if (modId === null) continue;
    result.set(modId.toLowerCase(), modId);
  }
  return result;
}

function versionFor(snapshot: RegistrySnapshot, modId: string): string | null {
  const value = valueFor(snapshot, rootPath(modId), 'Version');
  return value?.type === 'string' ? value.value.trim() : null;
}

export function planRestoreWrites(
  source: RegistrySnapshot,
  current: RegistrySnapshot,
  nowMs: number,
): PlannedWrites {
  const sourceInstalled = readInstalledMods(source);
  const currentInstalled = readInstalledMods(current);
  const displayIds = sourceDisplayModIds(source);
  const currentDisplayIds = sourceDisplayModIds(current);
  const included: string[] = [];
  const skippedMods: PlanSkippedMod[] = [];
  const warnings: string[] = [];

  for (const modId of restoreSourceModIds(source)) {
    const sourceState = sourceInstalled.get(modId);
    const currentState = currentInstalled.get(modId);
    const displayId = displayIds.get(modId) ?? modId;

    if (sourceState === undefined || currentState === undefined) {
      skippedMods.push({
        modId: displayId,
        reason: 'missing-key',
        message: `Captured mod "${displayId}" is no longer installed; its key was left intact.`,
      });
      continue;
    }

    const sourceVersion = sourceState.version ?? versionFor(source, modId);
    const currentVersion = currentState.version;
    if (
      sourceVersion !== null &&
      currentVersion !== null &&
      compareVersions(currentVersion, sourceVersion) > 0
    ) {
      // A mod update must not defeat the undo button: the captured Disabled,
      // settings, and targeting values are still reconciled. Version and
      // LibraryFileName are never written, so the newer DLL keeps running.
      warnings.push(
        `Mod "${displayId}" is newer (${currentVersion}) than the snapshot (${sourceVersion}); its captured configuration will still be restored.`,
      );
    }

    included.push(modId);
  }

  for (const modId of [...currentInstalled.keys()].sort((left, right) =>
    left.localeCompare(right),
  )) {
    if (sourceInstalled.has(modId)) continue;
    const displayId = currentDisplayIds.get(modId) ?? modId;
    const message = `Mod "${displayId}" was installed after the snapshot; it was left intact.`;
    skippedMods.push({
      modId: displayId,
      reason: 'newer-than-snapshot',
      message,
    });
    warnings.push(message);
  }

  const filtered = filterSnapshotToMods(source, included);
  const mutations = planReconcileOperations(filtered, current, {
    requireRestorableCurrent: true,
  });
  const effective = filterEffectiveOps(mutations, current);
  const grouped = groupOperations(effective, current, nowMs);

  return finalize(
    grouped.batches,
    grouped.allOps,
    grouped.touchedModIds,
    skippedMods,
    warnings,
    [],
    current,
  );
}

export function planRollbackWrites(
  preRun: RegistrySnapshot,
  current: RegistrySnapshot,
  nowMs: number,
): PlannedWrites {
  const preRunIds = restoreSourceModIds(preRun);
  const currentInstalled = readInstalledMods(current);
  const included: string[] = [];
  const unrestorable: string[] = [];

  for (const modId of preRunIds) {
    if (!currentInstalled.has(modId)) {
      unrestorable.push(modId);
      continue;
    }
    included.push(modId);
  }

  const filtered = filterSnapshotToMods(preRun, included);
  const mutations = planReconcileOperations(filtered, current);
  const effective = filterEffectiveOps(mutations, current);
  const grouped = groupOperations(effective, current, nowMs);

  return finalize(
    grouped.batches,
    grouped.allOps,
    grouped.touchedModIds,
    [],
    [],
    unrestorable,
    current,
  );
}
