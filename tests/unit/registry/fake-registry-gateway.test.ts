import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeRegistryGateway } from '@core/registry/fake-registry-gateway';
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

function baseSnapshot(): RegistrySnapshot {
  return makeSnapshot([
    {
      path: MOD_ROOT,
      values: [
        { name: 'Disabled', value: { type: 'dword', value: 0 } },
        { name: 'Include', value: { type: 'string', value: '*' } },
        { name: 'LibraryFileName', value: { type: 'string', value: 'demo.dll' } },
      ],
    },
    {
      path: SETTINGS,
      values: [
        { name: 'Theme', value: { type: 'string', value: 'old' } },
        { name: 'Keep', value: { type: 'string', value: 'keep' } },
        { name: 'Remove', value: { type: 'string', value: 'remove' } },
      ],
    },
  ]);
}

describe('FakeRegistryGateway', () => {
  it('applies only requested values and removes only the named value', async () => {
    const fake = new FakeRegistryGateway({ snapshot: baseSnapshot() });

    await fake.applyOps([
      { kind: 'set', path: MOD_ROOT, name: 'Disabled', value: { type: 'dword', value: 1 } },
      { kind: 'set', path: SETTINGS, name: 'Theme', value: { type: 'string', value: 'new' } },
      { kind: 'deleteValue', path: SETTINGS, name: 'Remove' },
    ]);

    const after = fake.getSnapshot();
    expect(after.keys).toHaveLength(2);
    expect(after.keys[0]?.values).toContainEqual({
      name: 'Include',
      value: { type: 'string', value: '*' },
    });
    expect(after.keys[0]?.values).toContainEqual({
      name: 'LibraryFileName',
      value: { type: 'string', value: 'demo.dll' },
    });
    expect(after.keys[1]?.values).toContainEqual({
      name: 'Keep',
      value: { type: 'string', value: 'keep' },
    });
    expect(after.keys[1]?.values).not.toContainEqual(expect.objectContaining({ name: 'Remove' }));
    expect(fake.applyCalls).toHaveLength(1);
  });

  it('rejects targeting values in apply operations without changing state', async () => {
    const fake = new FakeRegistryGateway({ snapshot: baseSnapshot() });
    const before = fake.getSnapshot();

    await expect(
      fake.applyOps([
        {
          kind: 'set',
          path: MOD_ROOT,
          name: 'Include',
          value: { type: 'string', value: 'custom' },
        },
      ]),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(fake.getSnapshot()).toEqual(before);
    expect(fake.mutations).toHaveLength(0);
  });

  it('applies restore targeting and settings values without Windhawk-owned writes', async () => {
    const fake = new FakeRegistryGateway({ snapshot: baseSnapshot() });

    await fake.applyRestoreOps([
      {
        kind: 'set',
        path: MOD_ROOT,
        name: 'Disabled',
        value: { type: 'dword', value: 1 },
      },
      {
        kind: 'set',
        path: MOD_ROOT,
        name: 'Include',
        value: { type: 'string', value: 'custom' },
      },
      {
        kind: 'set',
        path: SETTINGS,
        name: 'Theme',
        value: { type: 'string', value: 'new' },
      },
      { kind: 'deleteValue', path: SETTINGS, name: 'Remove' },
    ]);

    expect(fake.restoreApplyCalls).toHaveLength(1);
    expect(fake.getSnapshot().keys[0]?.values).toContainEqual({
      name: 'Include',
      value: { type: 'string', value: 'custom' },
    });
    expect(fake.getSnapshot().keys[0]?.values).toContainEqual({
      name: 'LibraryFileName',
      value: { type: 'string', value: 'demo.dll' },
    });
    expect(fake.getSnapshot().keys[1]?.values).toContainEqual({
      name: 'Theme',
      value: { type: 'string', value: 'new' },
    });

    await expect(
      fake.applyRestoreOps([
        {
          kind: 'set',
          path: MOD_ROOT,
          name: 'Version',
          value: { type: 'string', value: '9.9' },
        },
      ]),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('supports injected read failures', async () => {
    const fake = new FakeRegistryGateway({ snapshot: baseSnapshot() });
    fake.failRead = new Error('simulated read failure');

    await expect(fake.read()).rejects.toThrow('simulated read failure');
  });

  it('supports injected write failures without overwriting untouched values', async () => {
    const fake = new FakeRegistryGateway({ snapshot: baseSnapshot() });
    const before = fake.getSnapshot();
    fake.failWriteAt = 0;

    await expect(
      fake.applyOps([
        { kind: 'set', path: SETTINGS, name: 'Theme', value: { type: 'string', value: 'new' } },
      ]),
    ).rejects.toThrow(/simulated registry write failure/i);
    expect(fake.getSnapshot()).toEqual(before);

    fake.failWriteAt = 1;
    await expect(
      fake.applyOps([
        { kind: 'set', path: SETTINGS, name: 'Theme', value: { type: 'string', value: 'new' } },
        { kind: 'set', path: SETTINGS, name: 'Keep', value: { type: 'string', value: 'changed' } },
      ]),
    ).rejects.toThrow(/simulated registry write failure/i);
    expect(fake.getSnapshot().keys[1]?.values).toContainEqual({
      name: 'Theme',
      value: { type: 'string', value: 'new' },
    });
    expect(fake.getSnapshot().keys[1]?.values).toContainEqual({
      name: 'Keep',
      value: { type: 'string', value: 'keep' },
    });
  });

  it('reconciles targeting values, settings, and value deletions without deleting keys', async () => {
    const fake = new FakeRegistryGateway({ snapshot: baseSnapshot() });
    const desired = makeSnapshot([
      {
        path: MOD_ROOT,
        values: [
          { name: 'Disabled', value: { type: 'dword', value: 1 } },
          { name: 'Include', value: { type: 'string', value: 'custom' } },
          { name: 'LibraryFileName', value: { type: 'string', value: 'desired.dll' } },
        ],
      },
      {
        path: SETTINGS,
        values: [
          { name: 'Theme', value: { type: 'string', value: 'new' } },
          { name: 'Keep', value: { type: 'string', value: 'keep' } },
        ],
      },
    ]);

    await fake.reconcile(desired);

    const after = fake.getSnapshot();
    expect(after.keys).toHaveLength(2);
    expect(after.keys[0]?.values).toContainEqual({
      name: 'LibraryFileName',
      value: { type: 'string', value: 'demo.dll' },
    });
    expect(after.keys[0]?.values).toContainEqual({
      name: 'Include',
      value: { type: 'string', value: 'custom' },
    });
    expect(after.keys[1]?.values).not.toContainEqual(expect.objectContaining({ name: 'Remove' }));
    expect(fake.reconcileCalls).toHaveLength(1);
    expect(fake.mutations.some((mutation) => mutation.kind === 'deleteValue')).toBe(true);
  });

  it('records raw exports and rejects relative paths', async () => {
    const fake = new FakeRegistryGateway({ snapshot: baseSnapshot() });
    const absolute = join('C:\\', 'temp', 'evidence.reg');

    await fake.exportReg(absolute);
    expect(fake.exportedPaths).toEqual([absolute]);

    await expect(fake.exportReg('evidence.reg')).rejects.toBeInstanceOf(ValidationError);
    expect(fake.exportedPaths).toHaveLength(1);
  });
});
