import { describe, expect, it } from 'vitest';
import {
  RegistryKeyPathSchema,
  RegistryKeySchema,
  RegistryOpSchema,
  RegistryValueNameSchema,
  RegistryValueSchema,
  RegistryWritePathSchema,
  getModIdFromRegistryPath,
  parseRegistryOps,
  parseRegistrySnapshot,
  parseRegistrySnapshotJson,
} from '@shared/domain';
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

describe('registry schemas', () => {
  it('round-trips every registry value type', () => {
    const snapshot = parseRegistrySnapshotJson(readFixture('snapshots/valid-registry.json'));
    const types = new Set(
      snapshot.keys.flatMap((key) => key.values.map((entry) => entry.value.type)),
    );

    expect(types).toEqual(
      new Set(['dword', 'qword', 'string', 'expandString', 'multiString', 'binary', 'none']),
    );
    expect(parseRegistrySnapshot(snapshot)).toEqual(snapshot);

    for (const key of snapshot.keys) {
      for (const entry of key.values) {
        expect(RegistryValueSchema.parse(entry.value)).toEqual(entry.value);
      }
    }
  });

  it.each([
    'HKCU\\SOFTWARE\\Windhawk\\Engine\\Mods\\mac-blur-glass',
    'HKLM\\SOFTWARE\\Windhawk\\Engine\\ModsWritable\\mac-blur-glass',
    'HKLM\\SOFTWARE\\Windhawk\\Engine\\Mods\\mac-blur-glass\\..\\other',
    'HKLM\\SOFTWARE\\Windhawk\\Engine\\Mods\\Mac_Blur',
    'HKLM\\SOFTWARE\\Windhawk\\Engine',
  ])('rejects registry key path %s', (path) => {
    expect(RegistryKeyPathSchema.safeParse(path).success).toBe(false);
  });

  it('rejects a snapshot key outside the Windhawk mods root with a field path', () => {
    const error = validationError(() =>
      parseRegistrySnapshotJson(readFixture('snapshots/invalid-outside-root.json')),
    );

    expect(error.details.map((detail) => formatIssuePath(detail.path))).toContain('keys[0].path');
  });

  it('rejects an invalid mod ID inside the registry root with a field path', () => {
    const error = validationError(() =>
      parseRegistrySnapshotJson(readFixture('snapshots/invalid-mod-id.json')),
    );

    expect(error.details.map((detail) => formatIssuePath(detail.path))).toContain('keys[0].path');
  });

  it.each([
    ['negative dword', { type: 'dword', value: -1 }],
    ['dword overflow', { type: 'dword', value: 0x1_0000_0000 }],
    ['qword overflow', { type: 'qword', value: '18446744073709551616' }],
    ['qword non-decimal', { type: 'qword', value: '0x10' }],
    ['odd-length binary', { type: 'binary', value: '0' }],
    ['multi-string with a non-string', { type: 'multiString', value: [1] }],
    ['none with data', { type: 'none', value: 'x' }],
    ['unknown type', { type: 'unknown', value: null }],
  ])('rejects %s', (_label, value) => {
    expect(RegistryValueSchema.safeParse(value).success).toBe(false);
  });

  it('parses typed set and delete-value operations only', () => {
    const path = 'HKLM\\SOFTWARE\\Windhawk\\Engine\\Mods\\mac-blur-glass\\Settings';
    const operations = [
      {
        kind: 'set',
        path,
        name: 'TaskbarHeight',
        value: { type: 'dword', value: 48 },
      },
      { kind: 'deleteValue', path, name: 'LegacyTheme' },
    ];

    expect(parseRegistryOps(operations)).toEqual(operations);
    expect(RegistryOpSchema.safeParse({ kind: 'deleteKey', path, name: 'Settings' }).success).toBe(
      false,
    );
  });

  it('accepts writes only to a mod key or its Settings subkey', () => {
    const root = 'HKLM\\SOFTWARE\\Windhawk\\Engine\\Mods\\mac-blur-glass';
    const settings = `${root}\\Settings`;

    expect(RegistryWritePathSchema.safeParse(root).success).toBe(true);
    expect(RegistryWritePathSchema.safeParse(settings).success).toBe(true);
    expect(RegistryWritePathSchema.safeParse(`${root}\\Users\\S-1-5-21`).success).toBe(false);
    expect(RegistryWritePathSchema.safeParse(`${settings}\\Nested`).success).toBe(false);
  });

  it('rejects Windhawk-owned root values but allows a setting named Version', () => {
    const root = 'HKLM\\SOFTWARE\\Windhawk\\Engine\\Mods\\mac-blur-glass';
    const settings = `${root}\\Settings`;

    expect(
      RegistryOpSchema.safeParse({
        kind: 'set',
        path: root,
        name: 'Versions',
        value: { type: 'string', value: 'x' },
      }).success,
    ).toBe(true);
    expect(
      RegistryOpSchema.safeParse({
        kind: 'set',
        path: root,
        name: 'LibraryFileName',
        value: { type: 'string', value: 'x.dll' },
      }).success,
    ).toBe(false);
    expect(
      RegistryOpSchema.safeParse({
        kind: 'set',
        path: root,
        name: 'Version',
        value: { type: 'string', value: '1.0' },
      }).success,
    ).toBe(false);
    expect(
      RegistryOpSchema.safeParse({
        kind: 'set',
        path: settings,
        name: 'Version',
        value: { type: 'string', value: '1.0' },
      }).success,
    ).toBe(true);
  });

  it('accepts the Windhawk mods root as a snapshot key but not as a write target', () => {
    const root = 'HKLM\\SOFTWARE\\Windhawk\\Engine\\Mods';

    expect(RegistryKeyPathSchema.safeParse(root).success).toBe(true);
    expect(RegistryWritePathSchema.safeParse(root).success).toBe(false);
    expect(getModIdFromRegistryPath(root)).toBeNull();
    expect(
      RegistryKeySchema.safeParse({
        path: root,
        values: [{ name: 'Unexpected', value: { type: 'dword', value: 1 } }],
      }).success,
    ).toBe(false);
  });

  it('rejects registry value names containing NUL', () => {
    expect(RegistryValueNameSchema.safeParse('bad\u0000name').success).toBe(false);
  });

  it('extracts the mod ID from an allowlisted key path', () => {
    expect(
      getModIdFromRegistryPath(
        'HKLM\\SOFTWARE\\Windhawk\\Engine\\Mods\\windows-11-taskbar-styler\\Settings',
      ),
    ).toBe('windows-11-taskbar-styler');
    expect(getModIdFromRegistryPath('HKCU\\Software\\Windhawk')).toBeNull();
  });
});
