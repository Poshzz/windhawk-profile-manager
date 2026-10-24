import { describe, expect, it } from 'vitest';
import { parseRegFile, serializeRegFile } from '@core/registry/reg-codec';
import { REGISTRY_MODS_ROOT, parseRegistrySnapshot, type RegistrySnapshot } from '@shared/domain';
import { ValidationError } from '@shared/errors';
import { readFixtureBytes } from '../domain/test-fixtures';

const CAPTURED_AT = '2026-10-22T12:00:00.000Z';

function parseFixture(relativePath: string): RegistrySnapshot {
  return parseRegFile(readFixtureBytes(relativePath), { capturedAt: CAPTURED_AT });
}

describe('.reg codec', () => {
  it('parses the Mac fixture into its full snapshot shape', () => {
    const snapshot = parseFixture('Mac_BlurGlass_Profile.reg');
    const values = snapshot.keys.flatMap((key) => key.values);
    const modRoots = snapshot.keys.filter((key) => {
      const suffix = key.path.slice(REGISTRY_MODS_ROOT.length + 1);
      return key.path.toLowerCase() !== REGISTRY_MODS_ROOT.toLowerCase() && !suffix.includes('\\');
    });

    expect(snapshot.capturedAt).toBe(CAPTURED_AT);
    expect(snapshot.registryView).toBe('64-bit');
    expect(snapshot.keys).toHaveLength(21);
    expect(modRoots).toHaveLength(10);
    expect(values).toHaveLength(244);
    expect(values.filter((entry) => entry.value.type === 'string')).toHaveLength(193);
    expect(values.filter((entry) => entry.value.type === 'dword')).toHaveLength(51);
    expect(
      values.filter((entry) => entry.value.type === 'string' && entry.value.value.includes('"')),
    ).toHaveLength(26);
  });

  it('parses the reset fixture as ten disabled mods with no settings', () => {
    const snapshot = parseFixture('Reset_Default_Windows.reg');
    const values = snapshot.keys.flatMap((key) => key.values);

    expect(snapshot.keys).toHaveLength(10);
    expect(values).toHaveLength(10);
    expect(values.every((entry) => entry.name === 'Disabled')).toBe(true);
    expect(values.every((entry) => entry.value.type === 'dword' && entry.value.value === 1)).toBe(
      true,
    );
    expect(snapshot.keys.some((key) => key.path.toLowerCase().endsWith('\\settings'))).toBe(false);
  });

  it('emits canonical UTF-16LE with a BOM and is stable after export and reparse', () => {
    const snapshot = parseFixture('Mac_BlurGlass_Profile.reg');
    const first = serializeRegFile(snapshot);

    expect(Array.from(first.subarray(0, 2))).toEqual([0xff, 0xfe]);

    const reparsed = parseRegFile(first, { capturedAt: snapshot.capturedAt });
    const second = serializeRegFile(reparsed);

    expect(second).toEqual(first);
  });

  it('accepts UTF-16LE without a BOM', () => {
    const bytes = readFixtureBytes('Mac_BlurGlass_Profile.reg');
    const snapshot = parseRegFile(bytes.subarray(2), { capturedAt: CAPTURED_AT });

    expect(snapshot.keys).toHaveLength(21);
    expect(snapshot.keys.flatMap((key) => key.values)).toHaveLength(244);
  });

  it('round-trips every snapshot value type exactly', () => {
    const modRoot = `${REGISTRY_MODS_ROOT}\\demo-mod`;
    const snapshot: RegistrySnapshot = parseRegistrySnapshot({
      schemaVersion: 1,
      capturedAt: CAPTURED_AT,
      registryView: '64-bit',
      keys: [
        { path: REGISTRY_MODS_ROOT, values: [] },
        {
          path: modRoot,
          values: [
            { name: 'Disabled', value: { type: 'dword', value: 0 } },
            { name: 'Include', value: { type: 'string', value: '*' } },
          ],
        },
        {
          path: `${modRoot}\\Settings`,
          values: [
            { name: 'Empty', value: { type: 'string', value: '' } },
            { name: 'Quoted', value: { type: 'string', value: 'a"b\\c' } },
            { name: 'Expand', value: { type: 'expandString', value: '%SystemRoot%\\demo' } },
            { name: 'Multi', value: { type: 'multiString', value: ['one', '', 'three'] } },
            { name: 'Qword', value: { type: 'qword', value: '18446744073709551615' } },
            { name: 'Binary', value: { type: 'binary', value: '00ff10' } },
            { name: 'None', value: { type: 'none', value: null } },
          ],
        },
      ],
    });

    const reparsed = parseRegFile(serializeRegFile(snapshot), { capturedAt: snapshot.capturedAt });

    expect(reparsed.keys.map((key) => key.path)).toEqual(snapshot.keys.map((key) => key.path));
    expect(serializeRegFile(reparsed)).toEqual(serializeRegFile(snapshot));
  });

  it('ignores comments and blank lines and accepts LF line endings', () => {
    const text = [
      'Windows Registry Editor Version 5.00',
      '',
      '; exported by a test',
      `[HKEY_LOCAL_MACHINE\\SOFTWARE\\Windhawk\\Engine\\Mods\\demo-mod]`,
      '"Disabled"=dword:00000000',
      '',
      '; end',
    ].join('\n');

    const snapshot = parseRegFile(text, { capturedAt: CAPTURED_AT });

    expect(snapshot.keys).toHaveLength(1);
    expect(snapshot.keys[0]?.values).toEqual([
      { name: 'Disabled', value: { type: 'dword', value: 0 } },
    ]);
  });

  it('accepts a locally-added mod key from a Windhawk registry export', () => {
    const text = [
      'Windows Registry Editor Version 5.00',
      '',
      '[HKEY_LOCAL_MACHINE\\SOFTWARE\\Windhawk\\Engine\\Mods\\local@windows-11-notification-center-styler-fork]',
      '"Disabled"=dword:00000000',
    ].join('\r\n');

    const snapshot = parseRegFile(text, { capturedAt: CAPTURED_AT });

    expect(snapshot.keys[0]?.path).toBe(
      'HKLM\\SOFTWARE\\Windhawk\\Engine\\Mods\\local@windows-11-notification-center-styler-fork',
    );
  });

  it('supports line continuations for hex data', () => {
    const text = [
      'Windows Registry Editor Version 5.00',
      '',
      `[HKEY_LOCAL_MACHINE\\SOFTWARE\\Windhawk\\Engine\\Mods\\demo-mod\\Settings]`,
      '"Blob"=hex:00,01,\\',
      '  02,ff',
    ].join('\r\n');

    const snapshot = parseRegFile(text, { capturedAt: CAPTURED_AT });

    expect(snapshot.keys[0]?.values[0]?.value).toEqual({ type: 'binary', value: '000102ff' });
  });

  it.each([
    ['key deletion', '[-HKEY_LOCAL_MACHINE\\SOFTWARE\\Windhawk\\Engine\\Mods\\demo-mod]'],
    ['value deletion', '"Disabled"=-'],
  ])('recognizes and rejects %s directives', (_label, directive) => {
    const text = [
      'Windows Registry Editor Version 5.00',
      '',
      `[HKEY_LOCAL_MACHINE\\SOFTWARE\\Windhawk\\Engine\\Mods\\demo-mod]`,
      directive,
    ].join('\r\n');

    expect(() => parseRegFile(text, { capturedAt: CAPTURED_AT })).toThrow(ValidationError);
    expect(() => parseRegFile(text, { capturedAt: CAPTURED_AT })).toThrow(/deletion/i);
  });

  it('rejects a missing or unsupported header', () => {
    expect(() =>
      parseRegFile('[HKEY_LOCAL_MACHINE\\SOFTWARE\\Windhawk\\Engine\\Mods]', {
        capturedAt: CAPTURED_AT,
      }),
    ).toThrow(/header/i);
  });

  it('rejects a key outside the Windhawk mods subtree', () => {
    const text = [
      'Windows Registry Editor Version 5.00',
      '',
      '[HKEY_CURRENT_USER\\Software\\Windhawk\\Engine\\Mods\\demo-mod]',
      '"Disabled"=dword:00000000',
    ].join('\r\n');

    expect(() => parseRegFile(text, { capturedAt: CAPTURED_AT })).toThrow(/outside/i);
  });
});
