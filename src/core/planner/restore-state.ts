import {
  REGISTRY_MODS_ROOT,
  getModIdFromRegistryPath,
  isRegistryWritePath,
  parseRegistrySnapshot,
  type RegistrySnapshot,
  type RegistryValue,
  type RestoreTargetingValue,
} from '@shared/domain';
import { RESTORE_ROOT_VALUE_NAMES } from '@core/registry/reconcile';
import { canonicalSettings, hashCanonical, readInstalledMods } from './registry-state';

const TARGETING_ROOT_VALUE_NAMES: ReadonlySet<string> = new Set(
  [...RESTORE_ROOT_VALUE_NAMES].filter((name) => name !== 'disabled'),
);

/**
 * Captured targeting values that a restore may reconcile. The list is part of
 * the hashed plan and the helper requires explicit confirmation when non-empty.
 */
export function restoreTargetingValues(snapshot: RegistrySnapshot): RestoreTargetingValue[] {
  const values: RestoreTargetingValue[] = [];
  for (const key of snapshot.keys) {
    const modId = getModIdFromRegistryPath(key.path);
    if (modId === null) continue;
    if (key.path.toLowerCase() !== `${REGISTRY_MODS_ROOT}\\${modId}`.toLowerCase()) continue;
    for (const entry of key.values) {
      if (!TARGETING_ROOT_VALUE_NAMES.has(entry.name.toLowerCase())) continue;
      if (entry.value.type !== 'string') continue;
      values.push({ modId, name: entry.name, value: entry.value.value });
    }
  }

  return values.sort(
    (left, right) =>
      left.modId.localeCompare(right.modId) ||
      left.name.toLowerCase().localeCompare(right.name.toLowerCase()),
  );
}

function findRootValue(
  snapshot: RegistrySnapshot,
  modId: string,
  name: string,
): RegistryValue | null {
  const path = `${REGISTRY_MODS_ROOT}\\${modId}`.toLowerCase();
  const key = snapshot.keys.find((entry) => entry.path.toLowerCase() === path);
  const value = key?.values.find((entry) => entry.name.toLowerCase() === name);
  return value?.value ?? null;
}

/**
 * Canonical state covered by restore: the captured Disabled value, settings, and
 * targeting strings. LibraryFileName and Version are intentionally excluded so
 * a mod update does not stale a restore plan; newer mods are skipped instead.
 */
export function computeRestoreManagedHash(
  snapshot: RegistrySnapshot,
  modIds: readonly string[],
): string {
  const installed = readInstalledMods(snapshot);
  const unique = [...new Set(modIds.map((modId) => modId.toLowerCase()))].sort();

  const state = unique.map((modId) => {
    const current = installed.get(modId);
    const root = snapshot.keys.find(
      (key) => key.path.toLowerCase() === `${REGISTRY_MODS_ROOT}\\${modId}`.toLowerCase(),
    );

    const targeting = (root?.values ?? [])
      .filter((entry) => TARGETING_ROOT_VALUE_NAMES.has(entry.name.toLowerCase()))
      .map((entry) => [entry.name.toLowerCase(), entry.value] as const)
      .sort((left, right) => left[0].localeCompare(right[0]));

    return {
      modId,
      installed: current !== undefined,
      disabled: findRootValue(snapshot, modId, 'disabled'),
      settings: current === undefined ? [] : canonicalSettings(current.settings),
      targeting,
    };
  });

  return hashCanonical(state);
}

export function restoreSourceModIds(snapshot: RegistrySnapshot): string[] {
  return [...readInstalledMods(snapshot).keys()].sort();
}

/**
 * Keep only captured mod root and Settings keys. Adds an empty Settings key when
 * the snapshot had none so removing settings added after the snapshot still works.
 * Never includes a key that did not exist in the source snapshot.
 */
export function filterSnapshotToMods(
  snapshot: RegistrySnapshot,
  modIds: readonly string[],
): RegistrySnapshot {
  const parsed = parseRegistrySnapshot(snapshot);
  const wanted = new Set(modIds.map((modId) => modId.toLowerCase()));
  const keys = parsed.keys
    .filter((key) => {
      const modId = getModIdFromRegistryPath(key.path);
      return modId !== null && wanted.has(modId.toLowerCase()) && isRegistryWritePath(key.path);
    })
    .map((key) => ({ path: key.path, values: [...key.values] }));

  const roots = keys.filter((key) => {
    const modId = getModIdFromRegistryPath(key.path);
    return (
      modId !== null && key.path.toLowerCase() === `${REGISTRY_MODS_ROOT}\\${modId}`.toLowerCase()
    );
  });

  for (const root of roots) {
    const settingsPath = `${root.path}\\Settings`.toLowerCase();
    if (keys.some((key) => key.path.toLowerCase() === settingsPath)) continue;
    keys.push({ path: `${root.path}\\Settings`, values: [] });
  }

  return parseRegistrySnapshot({
    schemaVersion: parsed.schemaVersion,
    capturedAt: parsed.capturedAt,
    registryView: parsed.registryView,
    keys,
  });
}
