import { describe, expect, it } from 'vitest';
import {
  planReconcileOperations,
  parseRestoreRegistryOps,
  RESTORE_ROOT_VALUE_NAMES,
} from '@core/registry/reconcile';
import { REGISTRY_MODS_ROOT, parseRegistrySnapshot, type RegistrySnapshot } from '@shared/domain';
import { ValidationError } from '@shared/errors';

const CAPTURED_AT = '2026-10-22T12:00:00.000Z';
const MOD_ROOT = `${REGISTRY_MODS_ROOT}\\demo-mod`;
const SETTINGS = `${MOD_ROOT}\\Settings`;

function makeSnapshot(
  keys: Array<{
    path: string;
    values: Array<{
      name: string;
      value: RegistrySnapshot['keys'][number]['values'][number]['value'];
    }>;
  }>,
): RegistrySnapshot {
  return parseRegistrySnapshot({
    schemaVersion: 1,
    capturedAt: CAPTURED_AT,
    registryView: '64-bit',
    keys,
  });
}

describe('restore reconciliation', () => {
  it('sets captured settings and targeting values, skips Windhawk-owned values, and deletes only extras', () => {
    const current = makeSnapshot([
      {
        path: MOD_ROOT,
        values: [
          { name: 'Disabled', value: { type: 'dword', value: 0 } },
          { name: 'LibraryFileName', value: { type: 'string', value: 'old.dll' } },
          { name: 'Version', value: { type: 'string', value: '1.0' } },
          { name: 'Include', value: { type: 'string', value: '*' } },
          { name: 'SettingsChangeTime', value: { type: 'dword', value: 1 } },
          { name: 'UnknownRoot', value: { type: 'string', value: 'leave' } },
        ],
      },
      {
        path: SETTINGS,
        values: [
          { name: 'Theme', value: { type: 'string', value: 'old' } },
          { name: 'Removed', value: { type: 'string', value: 'old' } },
          { name: 'Version', value: { type: 'string', value: '1.0' } },
        ],
      },
    ]);
    const desired = makeSnapshot([
      {
        path: MOD_ROOT,
        values: [
          { name: 'Disabled', value: { type: 'dword', value: 1 } },
          { name: 'LibraryFileName', value: { type: 'string', value: 'new.dll' } },
          { name: 'Version', value: { type: 'string', value: '2.0' } },
          { name: 'Include', value: { type: 'string', value: 'custom' } },
          { name: 'Architecture', value: { type: 'string', value: 'amd64' } },
          { name: 'SettingsChangeTime', value: { type: 'dword', value: 9 } },
        ],
      },
      {
        path: SETTINGS,
        values: [
          { name: 'Theme', value: { type: 'string', value: 'new' } },
          { name: 'Version', value: { type: 'string', value: '2.0' } },
        ],
      },
    ]);

    const operations = planReconcileOperations(desired, current);

    expect(operations).toEqual([
      { kind: 'set', path: MOD_ROOT, name: 'Disabled', value: { type: 'dword', value: 1 } },
      { kind: 'set', path: MOD_ROOT, name: 'Include', value: { type: 'string', value: 'custom' } },
      {
        kind: 'set',
        path: MOD_ROOT,
        name: 'Architecture',
        value: { type: 'string', value: 'amd64' },
      },
      { kind: 'set', path: SETTINGS, name: 'Theme', value: { type: 'string', value: 'new' } },
      { kind: 'set', path: SETTINGS, name: 'Version', value: { type: 'string', value: '2.0' } },
      { kind: 'deleteValue', path: SETTINGS, name: 'Removed' },
    ]);
    expect(operations.some((operation) => operation.name === 'LibraryFileName')).toBe(false);
    expect(
      operations.some((operation) => operation.path === MOD_ROOT && operation.name === 'Version'),
    ).toBe(false);
    expect(operations.some((operation) => operation.name === 'SettingsChangeTime')).toBe(false);
    expect(operations.some((operation) => operation.name === 'UnknownRoot')).toBe(false);
  });

  it('accepts targeting values from restore snapshots but not arbitrary root values', () => {
    for (const name of RESTORE_ROOT_VALUE_NAMES) {
      const value =
        name === 'disabled' ? { type: 'dword', value: 1 } : { type: 'string', value: '*' };
      expect(() =>
        parseRestoreRegistryOps([{ kind: 'set', path: MOD_ROOT, name, value }]),
      ).not.toThrow();
    }

    expect(() =>
      parseRestoreRegistryOps([
        {
          kind: 'set',
          path: MOD_ROOT,
          name: 'LibraryFileName',
          value: { type: 'string', value: 'demo.dll' },
        },
      ]),
    ).toThrow(ValidationError);
    expect(() =>
      parseRestoreRegistryOps([
        {
          kind: 'set',
          path: MOD_ROOT,
          name: 'Version',
          value: { type: 'string', value: '1.0' },
        },
      ]),
    ).toThrow(ValidationError);
    expect(() =>
      parseRestoreRegistryOps([
        {
          kind: 'set',
          path: MOD_ROOT,
          name: 'SettingsChangeTime',
          value: { type: 'dword', value: 1 },
        },
      ]),
    ).toThrow(ValidationError);
    expect(() =>
      parseRestoreRegistryOps([
        {
          kind: 'set',
          path: MOD_ROOT,
          name: 'UnknownRoot',
          value: { type: 'string', value: 'x' },
        },
      ]),
    ).toThrow(ValidationError);
  });

  it('rejects the wrong value types for Disabled and targeting values', () => {
    expect(() =>
      parseRestoreRegistryOps([
        { kind: 'set', path: MOD_ROOT, name: 'Disabled', value: { type: 'string', value: '1' } },
      ]),
    ).toThrow(ValidationError);
    expect(() =>
      parseRestoreRegistryOps([
        { kind: 'set', path: MOD_ROOT, name: 'Include', value: { type: 'dword', value: 1 } },
      ]),
    ).toThrow(ValidationError);
  });

  it('allows a setting named Version under Settings', () => {
    expect(() =>
      parseRestoreRegistryOps([
        {
          kind: 'set',
          path: SETTINGS,
          name: 'Version',
          value: { type: 'string', value: '1.0' },
        },
      ]),
    ).not.toThrow();
  });

  it('rejects writes to ModsWritable or Users paths', () => {
    expect(() =>
      parseRestoreRegistryOps([
        {
          kind: 'set',
          path: `${REGISTRY_MODS_ROOT}Writable\\demo-mod`,
          name: 'Disabled',
          value: { type: 'dword', value: 1 },
        },
      ]),
    ).toThrow(ValidationError);
    expect(() =>
      parseRestoreRegistryOps([
        {
          kind: 'set',
          path: `${MOD_ROOT}\\Users\\S-1-5-21`,
          name: 'Disabled',
          value: { type: 'dword', value: 1 },
        },
      ]),
    ).toThrow(ValidationError);
  });
});
