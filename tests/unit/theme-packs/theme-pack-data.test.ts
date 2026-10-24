import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseRegFile } from '@core/registry/reg-codec';
import { readInstalledMods } from '@core/planner/registry-state';
import {
  FORBIDDEN_PROFILE_VALUE_NAMES,
  parseProfile,
  parseThemePack,
  type Profile,
} from '@shared/domain';
import {
  convertRegToProfile,
  serializeProfile,
  type ConvertRegOptions,
} from '../../../scripts/convert-reg-to-profile';
import { readFixtureBytes } from '../domain/test-fixtures';

const resources = resolve(process.cwd(), 'resources');
const MAC_DESCRIPTION = 'macOS-style blur, dock, menu, and control styling for Windows 11.';
const WINDOWS_DESCRIPTION = 'Stock Windows 11 appearance with the Mac Blur Glass mods disabled.';

const MAC_OPTIONS: ConvertRegOptions = {
  id: 'mac-blur-glass',
  name: 'Mac Blur Glass',
  description: MAC_DESCRIPTION,
  state: 'enabled',
  mode: 'replace',
  includeSettings: true,
  rainmeter: 'start',
};

const WINDOWS_OPTIONS: ConvertRegOptions = {
  id: 'default-windows',
  name: 'Default Windows',
  description: WINDOWS_DESCRIPTION,
  state: 'disabled',
  mode: 'merge',
  includeSettings: false,
  rainmeter: 'stop',
};

function readProfile(name: string): Profile {
  return parseProfile(
    JSON.parse(readFileSync(resolve(resources, 'profiles', `${name}.json`), 'utf8')) as unknown,
  );
}

describe('bundled Mac Blur Glass data', () => {
  it('validates the theme pack and every official mod link', () => {
    const pack = parseThemePack(
      JSON.parse(
        readFileSync(resolve(resources, 'theme-packs', 'mac-blur-glass', 'pack.json'), 'utf8'),
      ) as unknown,
    );

    expect(pack.mods).toHaveLength(10);
    expect(pack.profiles).toEqual(['mac-blur-glass', 'default-windows']);
    for (const mod of pack.mods) {
      expect(mod.pageUrl).toBe(`https://windhawk.net/mods/${mod.modId}`);
      expect(mod.required).toBe(true);
    }
    expect(pack.notes.join(' ')).toMatch(/themePaths|machine-specific/i);
  });

  it('converts the original kit byte-for-byte into the shipped Mac profile', () => {
    const converted = convertRegToProfile(
      readFixtureBytes('Mac_BlurGlass_Profile.reg'),
      MAC_OPTIONS,
    );
    const shipped = readFileSync(resolve(resources, 'profiles', 'mac-blur-glass.json'), 'utf8');

    expect(converted.machineSpecificSettings).toEqual([]);
    expect(serializeProfile(converted.profile)).toBe(shipped);
  });

  it('converts the reset fixture byte-for-byte into the shipped Default Windows profile', () => {
    const converted = convertRegToProfile(
      readFixtureBytes('Reset_Default_Windows.reg'),
      WINDOWS_OPTIONS,
    );
    const shipped = readFileSync(resolve(resources, 'profiles', 'default-windows.json'), 'utf8');

    expect(serializeProfile(converted.profile)).toBe(shipped);
  });

  it('preserves every captured non-excluded Mac setting and its exact type', () => {
    const profile = readProfile('mac-blur-glass');
    const snapshot = parseRegFile(readFixtureBytes('Mac_BlurGlass_Profile.reg'), {
      capturedAt: '2026-10-22T12:00:00.000Z',
    });
    const installed = readInstalledMods(snapshot);

    expect(profile.requiredMods).toHaveLength(10);
    for (const mod of profile.requiredMods) {
      const original = installed.get(mod.modId);
      expect(original).toBeDefined();
      expect(mod.state).toBe('enabled');
      expect(mod.mode).toBe('replace');

      const shippedSettings = Object.entries(mod.settings);
      expect(shippedSettings).toHaveLength(original?.settings.size ?? 0);
      for (const [name, setting] of shippedSettings) {
        expect(FORBIDDEN_PROFILE_VALUE_NAMES.has(name.toLowerCase())).toBe(false);
        expect(setting.type === 'string' || setting.type === 'dword').toBe(true);
        expect(setting).toEqual(original?.settings.get(name.toLowerCase())?.value);
      }
    }

    const serialized = JSON.stringify(profile);
    expect(serialized).not.toMatch(
      /LibraryFileName|SettingsChangeTime|"Include"|"Exclude"|"Architecture"|IncludeCustom|ExcludeCustom/,
    );
  });

  it('builds Default Windows as a merge-only disable profile', () => {
    const profile = readProfile('default-windows');

    expect(profile.requiredMods).toHaveLength(10);
    expect(profile.actions.rainmeter).toBe('stop');
    for (const mod of profile.requiredMods) {
      expect(mod.state).toBe('disabled');
      expect(mod.mode).toBe('merge');
      expect(mod.settings).toEqual({});
    }
  });
});
