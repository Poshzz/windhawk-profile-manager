import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NodeCommandRunner } from '@infra/process/node-command-runner';
import {
  PowerShellRegistryBatchWriter,
  type RegistryBatchOperation,
} from '@infra/registry/powershell-registry-batch-writer';
import { ApplyError, EnvironmentError } from '@shared/errors';

const describeWindows = process.platform === 'win32' ? describe : describe.skip;

describeWindows('PowerShellRegistryBatchWriter integration', () => {
  const runner = new NodeCommandRunner();
  const writer = new PowerShellRegistryBatchWriter({ commandRunner: runner });
  const testRoot = `HKCU\\Software\\WindhawkProfileManagerTests\\${randomUUID()}`;
  const settingsKey = `${testRoot}\\Settings`;

  const reg = (args: readonly string[]) => runner.run('reg.exe', args, { timeoutMs: 30_000 });

  beforeAll(async () => {
    const created = await reg(['add', testRoot, '/reg:64', '/f']);
    expect(created.exitCode).toBe(0);
  });

  afterAll(async () => {
    await reg(['delete', testRoot, '/reg:64', '/f']);
  });

  it('creates a missing Settings subkey and preserves typed values', async () => {
    const missing = await reg(['query', settingsKey, '/reg:64']);
    expect(missing.exitCode).not.toBe(0);

    const operations: RegistryBatchOperation[] = [
      {
        kind: 'set',
        path: testRoot,
        name: 'Disabled',
        value: { type: 'dword', value: 1 },
      },
      {
        kind: 'set',
        path: settingsKey,
        name: 'Mask',
        value: { type: 'dword', value: 0xffffffff },
      },
      {
        kind: 'set',
        path: settingsKey,
        name: 'Theme',
        value: { type: 'string', value: 'macOS "quoted" \\ path' },
      },
      {
        kind: 'set',
        path: settingsKey,
        name: 'Size',
        value: { type: 'qword', value: '18446744073709551615' },
      },
      {
        kind: 'set',
        path: settingsKey,
        name: 'Expand',
        value: { type: 'expandString', value: '%SystemRoot%\\temp' },
      },
      {
        kind: 'set',
        path: settingsKey,
        name: 'Blob',
        value: { type: 'binary', value: '00ff10a0' },
      },
      {
        kind: 'set',
        path: settingsKey,
        name: 'Empty',
        value: { type: 'string', value: '' },
      },
      {
        kind: 'set',
        path: settingsKey,
        name: '',
        value: { type: 'string', value: 'default-value' },
      },
    ];

    await writer.write(operations);

    const disabled = await reg(['query', testRoot, '/reg:64', '/v', 'Disabled']);
    expect(disabled.exitCode).toBe(0);
    expect(disabled.stdout).toMatch(/0x1\b/i);

    const mask = await reg(['query', settingsKey, '/reg:64', '/v', 'Mask']);
    expect(mask.exitCode).toBe(0);
    expect(mask.stdout.toLowerCase()).toContain('0xffffffff');

    const theme = await reg(['query', settingsKey, '/reg:64', '/v', 'Theme']);
    expect(theme.exitCode).toBe(0);
    expect(theme.stdout).toContain('macOS');

    const size = await reg(['query', settingsKey, '/reg:64', '/v', 'Size']);
    expect(size.exitCode).toBe(0);
    expect(size.stdout.toLowerCase()).toContain('0xffffffffffffffff');

    const expand = await reg(['query', settingsKey, '/reg:64', '/v', 'Expand']);
    expect(expand.exitCode).toBe(0);
    expect(expand.stdout).toMatch(/REG_EXPAND_SZ/i);
    expect(expand.stdout).toContain('%SystemRoot%');

    const blob = await reg(['query', settingsKey, '/reg:64', '/v', 'Blob']);
    expect(blob.exitCode).toBe(0);
    expect(blob.stdout).toMatch(/00\s*FF\s*10\s*A0/i);

    const empty = await reg(['query', settingsKey, '/reg:64', '/v', 'Empty']);
    expect(empty.exitCode).toBe(0);
    expect(empty.stdout).toMatch(/REG_SZ/i);

    const defaultValue = await reg(['query', settingsKey, '/reg:64', '/ve']);
    expect(defaultValue.exitCode).toBe(0);
    expect(defaultValue.stdout).toContain('default-value');
  });

  it('deletes only the requested value', async () => {
    await writer.write([{ kind: 'deleteValue', path: settingsKey, name: 'Theme' }]);

    const deleted = await reg(['query', settingsKey, '/reg:64', '/v', 'Theme']);
    expect(deleted.exitCode).not.toBe(0);

    const kept = await reg(['query', settingsKey, '/reg:64', '/v', 'Blob']);
    expect(kept.exitCode).toBe(0);
  });

  it('fails when deleting a value that no longer exists', async () => {
    const error = await writer
      .write([{ kind: 'deleteValue', path: settingsKey, name: 'Theme' }])
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(EnvironmentError);
  });

  it('refuses to create a missing parent key and leaves it absent', async () => {
    const missingParent = `${testRoot}\\missing-parent\\Settings`;

    const error = await writer
      .write([
        {
          kind: 'set',
          path: missingParent,
          name: 'Theme',
          value: { type: 'string', value: 'must-not-exist' },
        },
      ])
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApplyError);
    expect((error as Error).message).toMatch(/refusing to create/i);

    const query = await reg(['query', `${testRoot}\\missing-parent`, '/reg:64']);
    expect(query.exitCode).not.toBe(0);
  });

  it('refuses to create a missing mod-style key', async () => {
    const missingMod = `${testRoot}\\missing-mod`;

    const error = await writer
      .write([
        {
          kind: 'set',
          path: missingMod,
          name: 'Disabled',
          value: { type: 'dword', value: 1 },
        },
      ])
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApplyError);

    const query = await reg(['query', missingMod, '/reg:64']);
    expect(query.exitCode).not.toBe(0);
  });

  it('does not create a key for a delete-only batch', async () => {
    const missingDelete = `${testRoot}\\missing-delete`;

    const error = await writer
      .write([{ kind: 'deleteValue', path: missingDelete, name: 'Gone' }])
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(EnvironmentError);

    const query = await reg(['query', missingDelete, '/reg:64']);
    expect(query.exitCode).not.toBe(0);
  });
});
