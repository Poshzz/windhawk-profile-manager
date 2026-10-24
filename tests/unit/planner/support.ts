import {
  parseEnvironment,
  parseProfile,
  parseRegistrySnapshot,
  type Environment,
  type Profile,
  type RegistryKey,
  type RegistrySnapshot,
  type RegistryValue,
  type RegistryValueEntry,
} from '@shared/domain';
import type { ApplyPlanOptions } from '@core/planner/apply-planner';

export function dword(value: number): { readonly type: 'dword'; readonly value: number } {
  return { type: 'dword', value };
}

export function stringValue(value: string): { readonly type: 'string'; readonly value: string } {
  return { type: 'string', value };
}

export function expandString(value: string): RegistryValue {
  return { type: 'expandString', value };
}

export function modRootPath(modId: string): string {
  return `HKLM\\SOFTWARE\\Windhawk\\Engine\\Mods\\${modId}`;
}

export interface ModKeyOptions {
  readonly enabled?: boolean;
  readonly libraryFileName?: string | null;
  readonly version?: string | null;
  readonly settings?: Readonly<Record<string, RegistryValue>>;
  readonly extraRootValues?: Readonly<Record<string, RegistryValue>>;
}

export function modKeys(modId: string, options: ModKeyOptions = {}): RegistryKey[] {
  const rootPath = modRootPath(modId);
  const rootValues: RegistryValueEntry[] = [];
  const libraryFileName =
    options.libraryFileName === undefined ? `${modId}.dll` : options.libraryFileName;
  if (libraryFileName !== null) {
    rootValues.push({ name: 'LibraryFileName', value: stringValue(libraryFileName) });
  }
  if (options.version !== undefined && options.version !== null) {
    rootValues.push({ name: 'Version', value: stringValue(options.version) });
  }
  rootValues.push({ name: 'Disabled', value: dword(options.enabled === false ? 1 : 0) });
  for (const [name, value] of Object.entries(options.extraRootValues ?? {})) {
    rootValues.push({ name, value });
  }

  const keys: RegistryKey[] = [{ path: rootPath, values: rootValues }];
  if (options.settings !== undefined) {
    keys.push({
      path: `${rootPath}\\Settings`,
      values: Object.entries(options.settings).map(([name, value]) => ({ name, value })),
    });
  }
  return keys;
}

export function makeSnapshot(keys: readonly RegistryKey[]): RegistrySnapshot {
  return parseRegistrySnapshot({
    schemaVersion: 1,
    capturedAt: '2026-10-22T19:30:00.000Z',
    registryView: '64-bit',
    keys: [...keys],
  });
}

export interface ManagedModInput {
  readonly modId: string;
  readonly state?: 'enabled' | 'disabled';
  readonly mode?: 'replace' | 'merge';
  readonly settings?: Readonly<Record<string, RegistryValue>>;
}

export function managedMod(input: ManagedModInput): Record<string, unknown> {
  return {
    modId: input.modId,
    state: input.state ?? 'enabled',
    mode: input.mode ?? 'replace',
    settings: input.settings ?? {},
  };
}

export interface ProfileOverrides {
  readonly requiredMods?: readonly Record<string, unknown>[];
  readonly unlistedMods?: 'leave' | 'disable';
  readonly revision?: number;
  readonly rainmeter?: 'start' | 'stop' | 'unchanged';
  readonly restartExplorer?: 'ask' | 'always' | 'never';
}

export function makeProfile(overrides: ProfileOverrides = {}): Profile {
  return parseProfile({
    schemaVersion: 1,
    id: 'mac-blur-glass',
    name: 'Mac Blur Glass',
    description: 'macOS-style blur, dock, and menu treatment.',
    source: 'builtin',
    basedOn: null,
    revision: overrides.revision ?? 1,
    createdAt: '2026-10-22T12:00:00.000Z',
    updatedAt: '2026-10-22T12:00:00.000Z',
    requiredMods: overrides.requiredMods ?? [
      managedMod({
        modId: 'windows-11-taskbar-styler',
        settings: { TaskbarHeight: dword(48), Theme: stringValue('macOS') },
      }),
    ],
    unlistedMods: overrides.unlistedMods ?? 'leave',
    actions: {
      rainmeter: overrides.rainmeter ?? 'unchanged',
      restartExplorer: overrides.restartExplorer ?? 'ask',
    },
  });
}

export interface EnvironmentOverrides {
  readonly serviceState?: 'running' | 'stopped' | 'missing' | 'unknown';
  readonly storageMode?: 'registry' | 'portable' | 'unknown';
  readonly portable?: boolean;
  readonly registryRoot?: string | null;
  readonly perUserActive?: boolean;
  readonly mods?: readonly {
    readonly modId: string;
    readonly version: string | null;
    readonly enabled?: boolean;
    readonly libraryFileName?: string;
  }[];
}

export function makeEnvironment(overrides: EnvironmentOverrides = {}): Environment {
  return parseEnvironment({
    schemaVersion: 1,
    probedAt: '2026-10-22T19:00:00.000Z',
    windows: { version: 'Windows 11 Pro', build: '22631', supported: true },
    windhawk: {
      installed: true,
      installDir: 'C:\\Program Files\\Windhawk',
      iniPath: 'C:\\ProgramData\\Windhawk\\config.ini',
      version: '1.7.3',
      engineVersion: '1.7.3',
      storageMode: overrides.storageMode ?? 'registry',
      portable: overrides.portable ?? false,
      registryRoot:
        overrides.registryRoot === undefined ? 'HKLM\\SOFTWARE\\Windhawk' : overrides.registryRoot,
    },
    service: { name: 'Windhawk', state: overrides.serviceState ?? 'running' },
    mods: (overrides.mods ?? []).map((mod) => ({
      modId: mod.modId,
      libraryFileName: mod.libraryFileName ?? `${mod.modId}.dll`,
      version: mod.version,
      enabled: mod.enabled ?? true,
      settingsCount: 0,
      perUserConfig: false,
    })),
    rainmeter: {
      installed: true,
      running: false,
      path: 'C:\\Program Files\\Rainmeter\\Rainmeter.exe',
    },
    perUserConfig: {
      present: overrides.perUserActive ?? false,
      active: overrides.perUserActive ?? false,
      sid: overrides.perUserActive ? 'S-1-5-21-1000' : null,
    },
    compatibility: { mode: 'writable', canApply: true, issues: [] },
  });
}

export function planOptions(overrides: Partial<ApplyPlanOptions> = {}): ApplyPlanOptions {
  const runId = overrides.runId ?? 'run-2026-10-22T20-02-14-123Z';
  const snapshotId = overrides.snapshotId ?? '2026-10-22T20-02-14-123Z';
  return {
    invokingUser: 'TEST\\Test',
    snapshotRetentionLimit: 20,
    runId,
    snapshotId,
    paths: {
      plan: `C:\\ProgramData\\WindhawkProfileManager\\runs\\${runId}\\plan.json`,
      snapshotRegistry: `C:\\Users\\Test\\AppData\\Local\\WindhawkProfileManager\\snapshots\\${snapshotId}.reg`,
      journal: 'C:\\Users\\Test\\AppData\\Local\\WindhawkProfileManager\\journal.json',
      result: `C:\\ProgramData\\WindhawkProfileManager\\runs\\${runId}\\result.json`,
    },
    ...overrides,
  };
}
