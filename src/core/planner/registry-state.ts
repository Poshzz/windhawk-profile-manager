import { createHash } from 'node:crypto';
import {
  FORBIDDEN_PROFILE_VALUE_NAMES,
  REGISTRY_MODS_ROOT,
  getModIdFromRegistryPath,
  stableStringify,
  type Profile,
  type ProfileSetting,
  type ProfileSettingsMap,
  type RegistryKey,
  type RegistrySnapshot,
  type RegistryValue,
  type RegistryValueEntry,
} from '@shared/domain';

export interface ManagedModState {
  readonly modId: string;
  readonly installed: boolean;
  readonly enabled: boolean;
  readonly libraryFileName: string;
  readonly version: string | null;
  readonly settingsCount: number;
  readonly perUserConfig: boolean;
  readonly settings: ReadonlyMap<string, RegistryValueEntry>;
}

export interface SettingsWrite {
  readonly name: string;
  readonly value: ProfileSetting;
}

export interface SettingsDiff {
  readonly writes: readonly SettingsWrite[];
  readonly deleteValues: readonly string[];
  readonly deleteAllSettings: boolean;
  readonly settingsChanged: boolean;
}

export type SettingsMode = 'replace' | 'merge';

function compareNames(left: string, right: string): number {
  return left.toLowerCase().localeCompare(right.toLowerCase());
}

function isModRootPath(path: string): boolean {
  if (getModIdFromRegistryPath(path) === null) return false;
  return path.slice(REGISTRY_MODS_ROOT.length + 1).split('\\').length === 1;
}

function readLibraryFileName(key: RegistryKey): string | null {
  const entry = key.values.find((value) => value.name.toLowerCase() === 'libraryfilename');
  if (entry === undefined || entry.value.type !== 'string') return null;
  const name = entry.value.value.trim();
  return name.length > 0 ? name : null;
}

function readEnabled(key: RegistryKey): boolean {
  const entry = key.values.find((value) => value.name.toLowerCase() === 'disabled');
  if (entry === undefined || entry.value.type !== 'dword') return true;
  return entry.value.value === 0;
}

function readVersion(key: RegistryKey): string | null {
  const entry = key.values.find((value) => value.name.toLowerCase() === 'version');
  if (entry === undefined || entry.value.type !== 'string') return null;
  const version = entry.value.value.trim();
  return version.length > 0 && version.length <= 64 ? version : null;
}

function readPerUserRoots(snapshot: RegistrySnapshot): ReadonlySet<string> {
  const roots = new Set<string>();
  const modsPrefix = `${REGISTRY_MODS_ROOT}\\`.toLowerCase();

  for (const key of snapshot.keys) {
    const lower = key.path.toLowerCase();
    if (!lower.startsWith(modsPrefix)) continue;
    const segments = lower.slice(modsPrefix.length).split('\\');
    const modId = segments[0];
    if (modId === undefined || modId.length === 0) continue;
    if (segments[1] === 'users') roots.add(`${modsPrefix}${modId}`);
  }

  return roots;
}

export function readInstalledMods(snapshot: RegistrySnapshot): Map<string, ManagedModState> {
  const keysByPath = new Map<string, RegistryKey>();
  for (const key of snapshot.keys) keysByPath.set(key.path.toLowerCase(), key);
  const perUserRoots = readPerUserRoots(snapshot);

  const installed = new Map<string, ManagedModState>();
  for (const key of snapshot.keys) {
    if (!isModRootPath(key.path)) continue;
    const modId = getModIdFromRegistryPath(key.path);
    if (modId === null) continue;
    const normalizedModId = modId.toLowerCase();
    if (installed.has(normalizedModId)) continue;
    const libraryFileName = readLibraryFileName(key);
    if (libraryFileName === null) continue;

    const settings = new Map<string, RegistryValueEntry>();
    const settingsKey = keysByPath.get(`${key.path}\\Settings`.toLowerCase());
    for (const entry of settingsKey?.values ?? []) {
      const normalizedName = entry.name.toLowerCase();
      if (FORBIDDEN_PROFILE_VALUE_NAMES.has(normalizedName)) continue;
      settings.set(normalizedName, entry);
    }

    installed.set(normalizedModId, {
      modId: normalizedModId,
      installed: true,
      enabled: readEnabled(key),
      libraryFileName,
      version: readVersion(key),
      settingsCount: settingsKey?.values.length ?? 0,
      perUserConfig: perUserRoots.has(key.path.toLowerCase()),
      settings,
    });
  }

  return installed;
}

export function canonicalSettings(
  settings: ReadonlyMap<string, RegistryValueEntry>,
): ReadonlyArray<readonly [string, RegistryValue]> {
  return [...settings.entries()]
    .map(([name, entry]) => [name, entry.value] as const)
    .sort((left, right) => left[0].localeCompare(right[0]));
}

export function hashCanonical(value: unknown): string {
  return `sha256:${createHash('sha256').update(stableStringify(value)).digest('hex')}`;
}

export function computeSettingsHash(state: ManagedModState | undefined): string {
  const settings =
    state?.installed === true ? state.settings : new Map<string, RegistryValueEntry>();
  return hashCanonical(canonicalSettings(settings));
}

export function computeManagedHash(modIds: readonly string[], snapshot: RegistrySnapshot): string {
  const installed = readInstalledMods(snapshot);
  const unique = new Map<string, string>();
  for (const modId of modIds) {
    const normalized = modId.toLowerCase();
    if (!unique.has(normalized)) unique.set(normalized, modId);
  }

  const state = [...unique.entries()]
    .map(([normalized, modId]) => {
      const current = installed.get(normalized);
      return {
        modId,
        installed: current !== undefined,
        enabled: current?.enabled ?? null,
        settings: current === undefined ? [] : canonicalSettings(current.settings),
      };
    })
    .sort((left, right) => left.modId.localeCompare(right.modId));

  return hashCanonical(state);
}

export function computeBeforeHash(profile: Profile, snapshot: RegistrySnapshot): string {
  const requiredModIds = profile.requiredMods.map((mod) => mod.modId);
  if (profile.unlistedMods !== 'disable') {
    return computeManagedHash(requiredModIds, snapshot);
  }

  const required = new Set(requiredModIds.map((modId) => modId.toLowerCase()));
  const unlistedModIds = [...readInstalledMods(snapshot).keys()].filter(
    (modId) => !required.has(modId),
  );
  return computeManagedHash([...requiredModIds, ...unlistedModIds], snapshot);
}

export function profileSettingEquals(desired: ProfileSetting, current: RegistryValue): boolean {
  if (desired.type === 'string') {
    return current.type === 'string' && current.value === desired.value;
  }
  return current.type === 'dword' && current.value === desired.value;
}

export function diffProfileSettings(
  desired: ProfileSettingsMap,
  state: ManagedModState | undefined,
  mode: SettingsMode,
): SettingsDiff {
  const settings = state?.settings ?? new Map<string, RegistryValueEntry>();
  const desiredEntries = Object.entries(desired);
  const desiredNames = new Set(desiredEntries.map(([name]) => name.toLowerCase()));

  const writes = desiredEntries
    .filter(([name, setting]) => {
      const current = settings.get(name.toLowerCase());
      return current === undefined || !profileSettingEquals(setting, current.value);
    })
    .map(([name, value]) => ({ name, value }))
    .sort((left, right) => compareNames(left.name, right.name));

  const deleteValues =
    mode === 'replace'
      ? [...settings.values()]
          .filter((entry) => !desiredNames.has(entry.name.toLowerCase()))
          .map((entry) => entry.name)
          .sort(compareNames)
      : [];

  const deleteAllSettings = mode === 'replace' && desiredEntries.length === 0;

  return {
    writes,
    deleteValues,
    deleteAllSettings,
    settingsChanged: writes.length > 0 || deleteValues.length > 0,
  };
}

export function formatRegistryValue(value: RegistryValue): string {
  switch (value.type) {
    case 'dword':
      return `dword:${value.value}`;
    case 'qword':
      return `qword:${value.value}`;
    case 'string':
      return `string:${JSON.stringify(value.value)}`;
    case 'expandString':
      return `expandString:${JSON.stringify(value.value)}`;
    case 'multiString':
      return `multiString:[${value.value.map((entry) => JSON.stringify(entry)).join(',')}]`;
    case 'binary':
      return `binary:${value.value}`;
    case 'none':
      return 'none';
  }
}

export function formatProfileSetting(setting: ProfileSetting): string {
  return setting.type === 'string'
    ? `string:${JSON.stringify(setting.value)}`
    : `dword:${setting.value}`;
}
