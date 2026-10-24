import { StaleProfileError } from '@shared/errors';
import type {
  Environment,
  Profile,
  ProfileMod,
  ProfileSetting,
  ProfileSettingsMap,
} from '@shared/domain';
import type { ProfileInput } from '@shared/ipc';

export interface DraftProfileMod {
  modId: string;
  state: ProfileMod['state'];
  mode: ProfileMod['mode'];
  settings: ProfileSettingsMap;
}

export interface ProfileDraft {
  name: string;
  description: string;
  mods: DraftProfileMod[];
  unlistedMods: Profile['unlistedMods'];
  rainmeter: Profile['actions']['rainmeter'];
  restartExplorer: Profile['actions']['restartExplorer'];
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isStaleProfileError(error: unknown): boolean {
  if (error instanceof StaleProfileError) return true;
  if (typeof error === 'object' && error !== null) {
    const code = (error as { readonly code?: unknown }).code;
    if (code === 'STALE_PROFILE') return true;
    const name = (error as { readonly name?: unknown }).name;
    if (name === 'StaleProfileError') return true;
  }
  return /changed/i.test(errorMessage(error));
}

function cloneSettings(settings: ProfileSettingsMap): ProfileSettingsMap {
  return Object.fromEntries(
    Object.entries(settings).map(([name, setting]) => [name, { ...setting }]),
  );
}

export function draftFromProfile(profile: Profile): ProfileDraft {
  return {
    name: profile.name,
    description: profile.description,
    mods: profile.requiredMods.map((mod) => ({
      modId: mod.modId,
      state: mod.state,
      mode: mod.mode,
      settings: cloneSettings(mod.settings),
    })),
    unlistedMods: profile.unlistedMods,
    rainmeter: profile.actions.rainmeter,
    restartExplorer: profile.actions.restartExplorer,
  };
}

export function draftToInput(draft: ProfileDraft): ProfileInput {
  return {
    name: draft.name.trim(),
    description: draft.description,
    requiredMods: draft.mods.map((mod) => ({
      modId: mod.modId,
      state: mod.state,
      mode: mod.mode,
      settings: mod.settings,
    })),
    unlistedMods: draft.unlistedMods,
    actions: {
      rainmeter: draft.rainmeter,
      restartExplorer: draft.restartExplorer,
    },
  };
}

/** Only string and dword values exist in profiles; filter defensively at render time. */
export function summarizableSettings(
  settings: ProfileSettingsMap,
): Array<[string, ProfileSetting]> {
  return Object.entries(settings).filter(
    ([, setting]) => setting.type === 'string' || setting.type === 'dword',
  );
}

export function countSettings(mods: readonly DraftProfileMod[]): number {
  return mods.reduce((total, mod) => total + summarizableSettings(mod.settings).length, 0);
}

export function formatSettingValue(setting: ProfileSetting): string {
  if (setting.type === 'dword') return String(setting.value);
  return JSON.stringify(setting.value) ?? `"${setting.value}"`;
}

export function countMissingMods(
  requiredMods: readonly Pick<ProfileMod, 'modId'>[],
  environment: Environment | null,
): number | null {
  if (environment === null) return null;
  const installed = new Set(environment.mods.map((mod) => mod.modId.toLowerCase()));
  return requiredMods.filter((mod) => !installed.has(mod.modId.toLowerCase())).length;
}

function sortProfiles(profiles: readonly Profile[]): Profile[] {
  const builtins = profiles.filter((profile) => profile.source === 'builtin');
  const users = profiles
    .filter((profile) => profile.source !== 'builtin')
    .slice()
    .sort((left, right) => {
      const difference = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
      return difference === 0 ? left.id.localeCompare(right.id) : difference;
    });
  return [...builtins, ...users];
}

export function upsertProfile(profiles: readonly Profile[], profile: Profile): Profile[] {
  return sortProfiles([...profiles.filter((entry) => entry.id !== profile.id), profile]);
}

export function removeProfile(profiles: readonly Profile[], id: string): Profile[] {
  return profiles.filter((profile) => profile.id !== id);
}

export function formatCaptureDate(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}
