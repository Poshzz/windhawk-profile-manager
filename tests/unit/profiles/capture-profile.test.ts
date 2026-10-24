import { describe, expect, it } from 'vitest';
import { ValidationError } from '@shared/errors';
import { captureProfileMods } from '@core/profiles/capture-profile';
import { dword, makeSnapshot, modKeys, stringValue } from '../planner/support';

describe('captureProfileMods', () => {
  it('captures enabled and disabled installed mods with full replace settings', () => {
    const snapshot = makeSnapshot([
      ...modKeys('alpha-mod', {
        enabled: true,
        settings: {
          Theme: stringValue('macOS'),
          Height: dword(48),
          Unsupported: { type: 'multiString', value: ['a', 'b'] },
        },
        extraRootValues: {
          Include: stringValue('*'),
          Exclude: stringValue(''),
          Architecture: stringValue(''),
        },
      }),
      ...modKeys('beta-mod', {
        enabled: false,
        settings: { EnabledFlag: dword(0) },
      }),
      ...modKeys('not-installed', { libraryFileName: null }),
    ]);

    const mods = captureProfileMods(snapshot, true);

    expect(mods).toEqual([
      {
        modId: 'alpha-mod',
        state: 'enabled',
        mode: 'replace',
        settings: { Height: dword(48), Theme: stringValue('macOS') },
      },
      {
        modId: 'beta-mod',
        state: 'disabled',
        mode: 'replace',
        settings: { EnabledFlag: dword(0) },
      },
    ]);
    expect(JSON.stringify(mods)).not.toMatch(
      /Include|Exclude|Architecture|LibraryFileName|Version/,
    );
  });

  it('captures a locally-added Windhawk mod using its local@ ID', () => {
    const snapshot = makeSnapshot([
      ...modKeys('local@windows-11-notification-center-styler-fork', {
        enabled: true,
        settings: { Theme: stringValue('macOS') },
      }),
    ]);

    expect(captureProfileMods(snapshot, true)).toEqual([
      {
        modId: 'local@windows-11-notification-center-styler-fork',
        state: 'enabled',
        mode: 'replace',
        settings: { Theme: stringValue('macOS') },
      },
    ]);
  });

  it('can omit disabled mods', () => {
    const snapshot = makeSnapshot([
      ...modKeys('enabled-mod', { enabled: true }),
      ...modKeys('disabled-mod', { enabled: false }),
    ]);

    expect(captureProfileMods(snapshot, false).map((mod) => mod.modId)).toEqual(['enabled-mod']);
  });

  it('fails when no installed mods were captured', () => {
    const snapshot = makeSnapshot([...modKeys('not-installed', { libraryFileName: null })]);

    expect(() => captureProfileMods(snapshot, true)).toThrow(ValidationError);
  });
});
