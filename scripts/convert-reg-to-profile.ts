import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRegFile } from '../src/core/registry/reg-codec';
import {
  ProfileSettingNameSchema,
  REGISTRY_MODS_ROOT,
  getModIdFromRegistryPath,
  isAbsoluteWindowsPath,
  parseProfile,
  type Profile,
  type ProfileMod,
  type ProfileSetting,
  type RegistrySnapshot,
} from '../src/shared/domain';
import { ValidationError } from '../src/shared/errors';

const DEFAULT_TIMESTAMP = '2026-10-22T12:00:00.000Z';
const MACHINE_SPECIFIC_SETTING_NAMES = new Set(['themepaths', 'themefolder']);

export interface ConvertRegOptions {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly state: 'enabled' | 'disabled';
  readonly mode: 'replace' | 'merge';
  readonly includeSettings: boolean;
  readonly rainmeter: 'start' | 'stop' | 'unchanged';
  readonly timestamp?: string;
}

export interface ConvertRegResult {
  readonly profile: Profile;
  readonly machineSpecificSettings: readonly string[];
}

function findKey(snapshot: RegistrySnapshot, path: string) {
  const normalized = path.toLowerCase();
  return snapshot.keys.find((key) => key.path.toLowerCase() === normalized);
}

function modIds(snapshot: RegistrySnapshot): string[] {
  const ids = new Set<string>();
  for (const key of snapshot.keys) {
    const modId = getModIdFromRegistryPath(key.path);
    if (modId === null) continue;
    const suffix = key.path.slice(REGISTRY_MODS_ROOT.length + 1);
    if (suffix.toLowerCase() === modId.toLowerCase()) ids.add(modId);
  }
  return [...ids].sort((left, right) => left.localeCompare(right));
}

function isProfileSettingName(name: string): boolean {
  return ProfileSettingNameSchema.safeParse(name).success;
}

function settingValue(value: { readonly type: string; readonly value: unknown }): ProfileSetting {
  if (value.type === 'string' || value.type === 'dword') {
    return value as ProfileSetting;
  }
  throw new ValidationError(
    `Setting type "${value.type}" cannot be represented in a profile; only REG_SZ and REG_DWORD are supported.`,
  );
}

function readProfileMods(
  snapshot: RegistrySnapshot,
  options: ConvertRegOptions,
): { mods: ProfileMod[]; machineSpecificSettings: string[] } {
  const machineSpecificSettings: string[] = [];
  const mods: ProfileMod[] = [];

  for (const modId of modIds(snapshot)) {
    const settings: Record<string, ProfileSetting> = {};
    if (options.includeSettings) {
      const settingsKey = findKey(snapshot, `${REGISTRY_MODS_ROOT}\\${modId}\\Settings`);
      for (const entry of settingsKey?.values ?? []) {
        if (!isProfileSettingName(entry.name)) continue;
        const normalizedName = entry.name.toLowerCase();
        if (
          MACHINE_SPECIFIC_SETTING_NAMES.has(normalizedName) &&
          entry.value.type === 'string' &&
          entry.value.value.length > 0 &&
          isAbsoluteWindowsPath(entry.value.value)
        ) {
          machineSpecificSettings.push(`${modId}\\${entry.name}`);
          continue;
        }
        settings[entry.name] = settingValue(entry.value);
      }
    }

    mods.push({
      modId,
      state: options.state,
      mode: options.mode,
      settings,
    });
  }

  return { mods, machineSpecificSettings };
}

export function convertRegToProfile(
  registryBytes: Uint8Array,
  options: ConvertRegOptions,
): ConvertRegResult {
  const snapshot = parseRegFile(registryBytes, {
    capturedAt: options.timestamp ?? DEFAULT_TIMESTAMP,
  });
  const { mods, machineSpecificSettings } = readProfileMods(snapshot, options);
  if (mods.length === 0) {
    throw new ValidationError('The registry file contains no Windhawk mod keys.');
  }

  const timestamp = options.timestamp ?? DEFAULT_TIMESTAMP;
  const profile = parseProfile({
    schemaVersion: 1,
    id: options.id,
    name: options.name,
    description: options.description,
    source: 'builtin',
    basedOn: null,
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    requiredMods: mods,
    unlistedMods: 'leave',
    actions: {
      rainmeter: options.rainmeter,
      restartExplorer: 'ask',
    },
  });

  return { profile, machineSpecificSettings };
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => sortValue(entry));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortValue((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

export function serializeProfile(profile: Profile): string {
  return `${JSON.stringify(sortValue(profile), null, 2)}\n`;
}

function argumentValue(args: readonly string[], name: string): string | null {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return null;
  return args[index + 1] ?? null;
}

function hasFlag(args: readonly string[], name: string): boolean {
  return args.includes(`--${name}`);
}

function requiredArgument(args: readonly string[], name: string): string {
  const value = argumentValue(args, name);
  if (value === null || value.length === 0) {
    throw new ValidationError(`Missing --${name}.`);
  }
  return value;
}

export function runConverter(args: readonly string[]): void {
  const input = resolve(requiredArgument(args, 'input'));
  const output = resolve(requiredArgument(args, 'output'));
  const state = argumentValue(args, 'state') ?? 'enabled';
  const mode = argumentValue(args, 'mode') ?? 'replace';
  const rainmeter = argumentValue(args, 'rainmeter') ?? 'start';
  if (state !== 'enabled' && state !== 'disabled') {
    throw new ValidationError('--state must be enabled or disabled.');
  }
  if (mode !== 'replace' && mode !== 'merge') {
    throw new ValidationError('--mode must be replace or merge.');
  }
  if (rainmeter !== 'start' && rainmeter !== 'stop' && rainmeter !== 'unchanged') {
    throw new ValidationError('--rainmeter must be start, stop, or unchanged.');
  }

  const result = convertRegToProfile(readFileSync(input), {
    id: requiredArgument(args, 'id'),
    name: requiredArgument(args, 'name'),
    description: argumentValue(args, 'description') ?? '',
    state,
    mode,
    includeSettings: !hasFlag(args, 'no-settings'),
    rainmeter,
  });

  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, serializeProfile(result.profile), 'utf8');
  if (result.machineSpecificSettings.length > 0) {
    process.stderr.write(
      `Machine-specific settings omitted: ${result.machineSpecificSettings.join(', ')}\n`,
    );
  }
}

function isMainModule(): boolean {
  if (process.argv[1] === undefined) return false;
  try {
    return resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  try {
    runConverter(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
