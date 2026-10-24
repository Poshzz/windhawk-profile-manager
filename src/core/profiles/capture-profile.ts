import { readInstalledMods } from '@core/planner/registry-state';
import { ValidationError } from '@shared/errors';
import type { ProfileMod, ProfileSetting, RegistrySnapshot } from '@shared/domain';

/**
 * Captures the installed Windhawk configuration as profile mod entries. Only
 * REG_SZ and REG_DWORD settings can be represented in a profile; targeting and
 * metadata stay in Windhawk's registry keys and are never copied.
 */
export function captureProfileMods(
  snapshot: RegistrySnapshot,
  includeDisabled: boolean,
): ProfileMod[] {
  const installed = [...readInstalledMods(snapshot).values()].sort((left, right) =>
    left.modId.localeCompare(right.modId),
  );
  const mods = installed
    .filter((mod) => includeDisabled || mod.enabled)
    .map((mod) => {
      const settings: Record<string, ProfileSetting> = {};
      for (const entry of mod.settings.values()) {
        if (entry.value.type === 'string' || entry.value.type === 'dword') {
          settings[entry.name] = entry.value;
        }
      }
      return {
        modId: mod.modId,
        state: mod.enabled ? ('enabled' as const) : ('disabled' as const),
        mode: 'replace' as const,
        settings,
      };
    });

  if (mods.length === 0) {
    throw new ValidationError('No installed Windhawk mods were captured.');
  }
  return mods;
}
