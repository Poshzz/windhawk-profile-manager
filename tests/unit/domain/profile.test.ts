import { describe, expect, it } from 'vitest';
import { parseProfile, parseProfileJson } from '@shared/domain';
import { ValidationError } from '@shared/errors';
import { formatIssuePath } from '@shared/validation/schema';
import { readFixture } from './test-fixtures';

function validationError(run: () => unknown): ValidationError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ValidationError);
    return error as ValidationError;
  }
  throw new Error('Expected a ValidationError.');
}

describe('profile schema', () => {
  it('parses the built-in Mac Blur Glass profile', () => {
    const profile = parseProfileJson(readFixture('profiles/valid-mac-blur-glass.json'));

    expect(profile.id).toBe('mac-blur-glass');
    expect(profile.source).toBe('builtin');
    expect(profile.requiredMods).toHaveLength(1);
    expect(profile.requiredMods[0]?.settings.TaskbarHeight).toEqual({
      type: 'dword',
      value: 48,
    });
    expect(profile.actions).toEqual({ rainmeter: 'start', restartExplorer: 'ask' });
  });

  const invalidCases = [
    {
      label: 'unknown field',
      file: 'profiles/invalid-unknown-field.json',
      path: 'unexpectedField',
      message: 'Unrecognized',
    },
    {
      label: 'dangerous JSON key',
      file: 'profiles/invalid-dangerous-key.json',
      path: 'requiredMods[0].settings.__proto__',
      message: '__proto__',
    },
    {
      label: 'targeted value',
      file: 'profiles/invalid-targeting-value.json',
      path: 'requiredMods[0].settings.Include',
      message: 'Targeting',
    },
    {
      label: 'binary setting',
      file: 'profiles/invalid-binary-setting.json',
      path: 'requiredMods[0].settings.Blob.type',
      message: 'string',
    },
    {
      label: 'invalid mod ID',
      file: 'profiles/invalid-mod-id.json',
      path: 'requiredMods[0].modId',
      message: 'Mod IDs must match',
    },
  ] as const;

  it.each(invalidCases)('rejects $label with the field path', ({ file, path, message }) => {
    let caught: unknown;
    try {
      parseProfileJson(readFixture(file));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ValidationError);
    const validationError = caught as ValidationError;
    expect(validationError.details.map((detail) => formatIssuePath(detail.path))).toContain(path);
    expect(validationError.message).toContain(message);
  });

  it.each([
    ['binary', { type: 'binary', value: '00ff' }],
    ['qword', { type: 'qword', value: '18446744073709551615' }],
    ['multiString', { type: 'multiString', value: ['one', 'two'] }],
    ['expandString', { type: 'expandString', value: '%SystemRoot%' }],
    ['none', { type: 'none', value: null }],
  ])('rejects a %s profile setting and names string/dword', (_label, setting) => {
    const profile = JSON.parse(readFixture('profiles/valid-mac-blur-glass.json')) as {
      requiredMods: Array<{ settings: Record<string, unknown> }>;
    };
    const firstMod = profile.requiredMods[0];
    if (firstMod === undefined) throw new Error('Fixture has no required mod.');
    firstMod.settings.Bad = setting;

    let caught: unknown;
    try {
      parseProfile(profile);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ValidationError);
    const message = (caught as ValidationError).message;
    expect(message).toContain('string');
    expect(message).toContain('dword');
  });

  it.each([
    'Include',
    'Exclude',
    'Architecture',
    'SettingsChangeTime',
    'LibraryFileName',
    'Version',
    'LoggingEnabled',
  ])('rejects the forbidden profile setting %s', (name) => {
    const profile = JSON.parse(readFixture('profiles/valid-mac-blur-glass.json')) as {
      requiredMods: Array<{ settings: Record<string, unknown> }>;
    };
    const firstMod = profile.requiredMods[0];
    if (firstMod === undefined) throw new Error('Fixture has no required mod.');
    firstMod.settings[name] = { type: 'string', value: 'x' };

    const error = validationError(() => parseProfile(profile));
    expect(error.details.map((detail) => formatIssuePath(detail.path))).toContain(
      `requiredMods[0].settings.${name}`,
    );
  });

  it('rejects duplicate setting names that differ only by case', () => {
    const profile = JSON.parse(readFixture('profiles/valid-mac-blur-glass.json')) as {
      requiredMods: Array<{ settings: Record<string, unknown> }>;
    };
    const firstMod = profile.requiredMods[0];
    if (firstMod === undefined) throw new Error('Fixture has no required mod.');
    firstMod.settings.theme = { type: 'string', value: 'dark' };

    const error = validationError(() => parseProfile(profile));
    expect(error.details.map((detail) => formatIssuePath(detail.path))).toContain(
      'requiredMods[0].settings.theme',
    );
  });
});
