import { parseRegistrySnapshot, type RegistrySnapshot } from '@shared/domain';
import type { RegistryMutation } from './reconcile';

export function applyMutationsToSnapshot(
  snapshot: RegistrySnapshot,
  mutations: readonly RegistryMutation[],
): RegistrySnapshot {
  const validated = parseRegistrySnapshot(snapshot);
  const keys = validated.keys.map((key) => ({
    path: key.path,
    values: [...key.values],
  }));

  for (const mutation of mutations) {
    const keyIndex = keys.findIndex(
      (key) => key.path.toLowerCase() === mutation.path.toLowerCase(),
    );
    const normalizedName = mutation.name.toLowerCase();

    if (mutation.kind === 'deleteValue') {
      if (keyIndex === -1) continue;
      const key = keys[keyIndex];
      if (key !== undefined) {
        key.values = key.values.filter((entry) => entry.name.toLowerCase() !== normalizedName);
      }
      continue;
    }

    if (keyIndex === -1) {
      keys.push({
        path: mutation.path,
        values: [{ name: mutation.name, value: mutation.value }],
      });
      continue;
    }

    const key = keys[keyIndex];
    if (key === undefined) continue;
    const valueIndex = key.values.findIndex((entry) => entry.name.toLowerCase() === normalizedName);
    if (valueIndex === -1) {
      key.values.push({ name: mutation.name, value: mutation.value });
    } else {
      key.values[valueIndex] = { name: mutation.name, value: mutation.value };
    }
  }

  return parseRegistrySnapshot({ ...validated, keys });
}
