import {
  SCHEMA_VERSION,
  parseDrift,
  type Drift,
  type DriftEntry,
  type Profile,
  type ProfileMod,
  type RegistrySnapshot,
} from '@shared/domain';
import {
  diffProfileSettings,
  formatProfileSetting,
  formatRegistryValue,
  readInstalledMods,
  type ManagedModState,
} from './registry-state';

export interface DriftServiceOptions {
  readonly now?: () => Date;
}

const MAX_EVIDENCE_LENGTH = 1000;

function clampEvidence(value: string | null): string | null {
  if (value === null || value.length <= MAX_EVIDENCE_LENGTH) return value;
  return `${value.slice(0, MAX_EVIDENCE_LENGTH - 3)}...`;
}

function appendSettingsDrift(mod: ProfileMod, state: ManagedModState, entries: DriftEntry[]): void {
  const diff = diffProfileSettings(mod.settings, state, mod.mode);

  for (const write of diff.writes) {
    const currentEntry = state.settings.get(write.name.toLowerCase());
    entries.push({
      modId: mod.modId,
      kind: 'settings',
      message:
        currentEntry === undefined
          ? `Setting "${write.name}" is not set.`
          : `Setting "${write.name}" differs.`,
      current:
        currentEntry === undefined ? null : clampEvidence(formatRegistryValue(currentEntry.value)),
      desired: clampEvidence(formatProfileSetting(write.value)),
    });
  }

  if (mod.mode !== 'replace') return;

  for (const name of diff.deleteValues) {
    const currentEntry = state.settings.get(name.toLowerCase());
    entries.push({
      modId: mod.modId,
      kind: 'settings',
      message: `Setting "${name}" is not part of the profile (replace mode).`,
      current:
        currentEntry === undefined ? null : clampEvidence(formatRegistryValue(currentEntry.value)),
      desired: null,
    });
  }
}

export class DriftService {
  private readonly now: () => Date;

  constructor(options: DriftServiceOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  static compare(
    profile: Profile,
    current: RegistrySnapshot | null,
    options: DriftServiceOptions = {},
  ): Drift {
    return new DriftService(options).compare(profile, current);
  }

  compare(profile: Profile, current: RegistrySnapshot | null): Drift {
    const checkedAt = this.now().toISOString();
    if (current === null) {
      return parseDrift({
        schemaVersion: SCHEMA_VERSION,
        profileId: profile.id,
        status: 'unknown',
        checkedAt,
        entries: [],
        reason: 'The current registry state is unavailable.',
      });
    }

    const installed = readInstalledMods(current);
    const entries: DriftEntry[] = [];

    for (const mod of profile.requiredMods) {
      const state = installed.get(mod.modId.toLowerCase());
      if (state === undefined) {
        entries.push({
          modId: mod.modId,
          kind: 'missing',
          message: `Mod "${mod.modId}" is not installed.`,
          current: null,
          desired: mod.state,
        });
        continue;
      }

      if ((mod.state === 'enabled') !== state.enabled) {
        entries.push({
          modId: mod.modId,
          kind: 'enabled-state',
          message: `Mod "${mod.modId}" is ${state.enabled ? 'enabled' : 'disabled'} but the profile wants it ${mod.state}.`,
          current: state.enabled ? 'enabled' : 'disabled',
          desired: mod.state,
        });
      }

      appendSettingsDrift(mod, state, entries);
    }

    return parseDrift({
      schemaVersion: SCHEMA_VERSION,
      profileId: profile.id,
      status: entries.length === 0 ? 'matches' : 'different',
      checkedAt,
      entries,
      reason: null,
    });
  }
}
