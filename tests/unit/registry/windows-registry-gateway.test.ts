import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { serializeRegFile } from '@core/registry/reg-codec';
import {
  REGISTRY_MODS_ROOT,
  parseRegistrySnapshot,
  type RegistryKey,
  type RegistryOp,
  type RegistrySnapshot,
} from '@shared/domain';
import { ApplyError, EnvironmentError, ValidationError } from '@shared/errors';
import { WindowsRegistryGateway } from '@infra/registry/windows-registry-gateway';
import { readFixtureBytes } from '../domain/test-fixtures';
import {
  FakeCommandRunner,
  type CommandHandler,
  type RecordedCommand,
} from '../support/fake-command-runner';

const CAPTURED_AT = '2026-10-22T12:00:00.000Z';
const MOD_ROOT = `${REGISTRY_MODS_ROOT}\\demo-mod`;
const SETTINGS = `${MOD_ROOT}\\Settings`;
const POWERSHELL_EXE = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

interface BatchPayloadOperation {
  readonly kind: 'set' | 'deleteValue';
  readonly path: string;
  readonly name: string;
  readonly type?: string;
  readonly value?: string | number;
}

function batchOf(call: RecordedCommand | undefined): {
  operations: readonly BatchPayloadOperation[];
} {
  if (call === undefined) throw new Error('Expected a batch write call.');
  const stdin = call.options.stdin;
  if (stdin === undefined) throw new Error('Expected the batch payload on stdin.');
  return JSON.parse(stdin) as { operations: readonly BatchPayloadOperation[] };
}

function assertOneBatchWrite(runner: FakeCommandRunner): RecordedCommand {
  expect(runner.calls).toHaveLength(1);
  const call = runner.calls[0];
  if (call === undefined) throw new Error('Expected a batch write call.');
  expect(call.executable).toBe(POWERSHELL_EXE);
  expect(call.args).toContain('-EncodedCommand');
  expect(call.args).not.toContain('-File');
  return call;
}

function assertNoRegWriteCommands(runner: FakeCommandRunner): void {
  const regWrites = runner.calls.filter(
    (call) =>
      call.executable.toLowerCase().endsWith('reg.exe') &&
      ['add', 'delete', 'query', 'import'].includes(call.args[0] ?? ''),
  );
  expect(regWrites).toEqual([]);
}

function makeSnapshot(keys: RegistryKey[], capturedAt = CAPTURED_AT): RegistrySnapshot {
  return parseRegistrySnapshot({
    schemaVersion: 1,
    capturedAt,
    registryView: '64-bit',
    keys,
  });
}

function ok(): { exitCode: number; stdout: string; stderr: string } {
  return { exitCode: 0, stdout: '', stderr: '' };
}

function exportHandler(snapshot: RegistrySnapshot): CommandHandler {
  return async (command: RecordedCommand) => {
    if (command.args[0] === 'export') {
      const path = command.args[2];
      if (path === undefined) throw new Error('Missing export path.');
      await writeFile(path, Buffer.from(serializeRegFile(snapshot)));
    }
    return ok();
  };
}

function assertEveryCallUsesReg64(runner: FakeCommandRunner): void {
  for (const call of runner.calls) {
    if (call.executable.toLowerCase().endsWith('powershell.exe')) continue;
    expect(call.args).toContain('/reg:64');
    expect(call.args).not.toContain('import');
  }
}

let tempDirectory: string;
let runner: FakeCommandRunner;
let gateway: WindowsRegistryGateway;

beforeEach(async () => {
  tempDirectory = await mkdtemp(join(tmpdir(), 'wpm-registry-gateway-'));
  runner = new FakeCommandRunner();
  gateway = new WindowsRegistryGateway({
    commandRunner: runner,
    tempDirectory,
    regExe: 'reg.exe',
    powershellExe: POWERSHELL_EXE,
    now: () => new Date(CAPTURED_AT),
  });
});

afterEach(async () => {
  await rm(tempDirectory, { recursive: true, force: true });
});

describe('WindowsRegistryGateway', () => {
  it('writes typed values and deletes only the requested value', async () => {
    const operations: RegistryOp[] = [
      {
        kind: 'set',
        path: MOD_ROOT,
        name: 'Disabled',
        value: { type: 'dword', value: 1 },
      },
      {
        kind: 'set',
        path: SETTINGS,
        name: 'Theme',
        value: { type: 'string', value: 'macOS' },
      },
      { kind: 'deleteValue', path: SETTINGS, name: 'LegacyTheme' },
    ];

    await gateway.applyOps(operations);

    const call = assertOneBatchWrite(runner);
    expect(batchOf(call)).toEqual({
      operations: [
        {
          kind: 'set',
          path: MOD_ROOT,
          name: 'Disabled',
          type: 'dword',
          value: 1,
        },
        {
          kind: 'set',
          path: SETTINGS,
          name: 'Theme',
          type: 'string',
          value: 'macOS',
        },
        {
          kind: 'deleteValue',
          path: SETTINGS,
          name: 'LegacyTheme',
        },
      ],
    });
    assertNoRegWriteCommands(runner);
  });

  it('uses one PowerShell process for a 192-operation batch', async () => {
    const operations: RegistryOp[] = Array.from({ length: 192 }, (_, index) => ({
      kind: 'set',
      path: SETTINGS,
      name: `Setting${String(index)}`,
      value: { type: 'dword', value: index },
    }));

    await gateway.applyOps(operations);

    const call = assertOneBatchWrite(runner);
    expect(batchOf(call).operations).toHaveLength(192);
    expect(runner.calls.filter((candidate) => candidate.args[0] === 'query')).toEqual([]);
    assertNoRegWriteCommands(runner);
  });

  it('rejects targeting values in apply operations before spawning reg.exe', async () => {
    await expect(
      gateway.applyOps([
        {
          kind: 'set',
          path: MOD_ROOT,
          name: 'Include',
          value: { type: 'string', value: '*' },
        },
      ]),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(runner.calls).toHaveLength(0);
  });

  it('writes restore targeting and settings values through the restore allowlist', async () => {
    await gateway.applyRestoreOps([
      {
        kind: 'set',
        path: MOD_ROOT,
        name: 'Disabled',
        value: { type: 'dword', value: 0 },
      },
      {
        kind: 'set',
        path: MOD_ROOT,
        name: 'Include',
        value: { type: 'string', value: '*' },
      },
      {
        kind: 'set',
        path: MOD_ROOT,
        name: 'Architecture',
        value: { type: 'string', value: 'amd64' },
      },
      {
        kind: 'set',
        path: SETTINGS,
        name: 'Theme',
        value: { type: 'string', value: 'macOS' },
      },
      { kind: 'deleteValue', path: SETTINGS, name: 'LegacyTheme' },
    ]);

    const call = assertOneBatchWrite(runner);
    expect(batchOf(call)).toEqual({
      operations: [
        {
          kind: 'set',
          path: MOD_ROOT,
          name: 'Disabled',
          type: 'dword',
          value: 0,
        },
        {
          kind: 'set',
          path: MOD_ROOT,
          name: 'Include',
          type: 'string',
          value: '*',
        },
        {
          kind: 'set',
          path: MOD_ROOT,
          name: 'Architecture',
          type: 'string',
          value: 'amd64',
        },
        {
          kind: 'set',
          path: SETTINGS,
          name: 'Theme',
          type: 'string',
          value: 'macOS',
        },
        { kind: 'deleteValue', path: SETTINGS, name: 'LegacyTheme' },
      ],
    });
    assertNoRegWriteCommands(runner);
  });

  it.each(['LibraryFileName', 'Version'])(
    'rejects %s in restore operations before spawning reg.exe',
    async (name) => {
      await expect(
        gateway.applyRestoreOps([
          {
            kind: 'set',
            path: MOD_ROOT,
            name,
            value: { type: 'string', value: 'forbidden' },
          },
        ]),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(runner.calls).toHaveLength(0);
    },
  );

  it.each([
    [
      'LibraryFileName',
      {
        kind: 'set',
        path: MOD_ROOT,
        name: 'LibraryFileName',
        value: { type: 'string', value: 'demo.dll' },
      },
    ],
    [
      'Version',
      {
        kind: 'set',
        path: MOD_ROOT,
        name: 'Version',
        value: { type: 'string', value: '1.0' },
      },
    ],
    [
      'ModsWritable',
      {
        kind: 'set',
        path: `${REGISTRY_MODS_ROOT}Writable\\demo-mod`,
        name: 'Disabled',
        value: { type: 'dword', value: 1 },
      },
    ],
    [
      'Users SID',
      {
        kind: 'set',
        path: `${MOD_ROOT}\\Users\\S-1-5-21`,
        name: 'Disabled',
        value: { type: 'dword', value: 1 },
      },
    ],
  ])('rejects %s writes before spawning reg.exe', async (_label, operation) => {
    await expect(gateway.applyOps([operation as RegistryOp])).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(runner.calls).toHaveLength(0);
  });

  it.each([
    ['HKCU', 'HKCU\\SOFTWARE\\Windhawk\\Engine\\Mods\\demo-mod'],
    ['another HKLM path', 'HKLM\\SOFTWARE\\Other\\Engine\\Mods\\demo-mod'],
    ['a mod ID containing a slash', `${REGISTRY_MODS_ROOT}\\bad/id`],
    ['a traversal segment', `${REGISTRY_MODS_ROOT}\\demo-mod\\..\\other`],
  ])('rejects %s before spawning reg.exe', async (_label, path) => {
    await expect(
      gateway.applyOps([
        {
          kind: 'set',
          path,
          name: 'Disabled',
          value: { type: 'dword', value: 1 },
        } as RegistryOp,
      ]),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(runner.calls).toHaveLength(0);
  });

  it('writes an empty REG_SZ value explicitly', async () => {
    await gateway.applyOps([
      {
        kind: 'set',
        path: SETTINGS,
        name: 'Empty',
        value: { type: 'string', value: '' },
      },
    ]);

    const call = assertOneBatchWrite(runner);
    expect(batchOf(call)).toEqual({
      operations: [
        {
          kind: 'set',
          path: SETTINGS,
          name: 'Empty',
          type: 'string',
          value: '',
        },
      ],
    });
    assertNoRegWriteCommands(runner);
  });

  it('refuses to recreate a mod key that disappeared before a write', async () => {
    runner.handler = () => ({
      exitCode: 2,
      stdout: '',
      stderr: `WPM_MISSING_KEY=${MOD_ROOT}`,
    });

    const error = await gateway
      .applyOps([
        {
          kind: 'set',
          path: SETTINGS,
          name: 'Theme',
          value: { type: 'string', value: 'macOS' },
        },
      ])
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApplyError);
    expect((error as Error).message).toMatch(/refusing to create/i);
    expect((error as Error).message).toContain(MOD_ROOT);
    assertOneBatchWrite(runner);
    assertNoRegWriteCommands(runner);
  });

  it('returns an empty snapshot when the Windhawk key is missing', async () => {
    runner.handler = () => ({ exitCode: 1, stdout: '', stderr: 'not found' });

    await expect(gateway.read()).resolves.toEqual({
      schemaVersion: 1,
      capturedAt: CAPTURED_AT,
      registryView: '64-bit',
      keys: [],
    });
    assertEveryCallUsesReg64(runner);
  });

  it('treats a locale-independent missing root as an empty snapshot', async () => {
    runner.handler = (command) =>
      command.options.env?.['WPM_REGISTRY_ROOT'] === undefined
        ? {
            exitCode: 1,
            stdout: '',
            stderr: 'Der angegebene Registrierungsschlüssel wurde nicht gefunden.',
          }
        : { exitCode: 1, stdout: '', stderr: '' };

    await expect(gateway.read()).resolves.toEqual({
      schemaVersion: 1,
      capturedAt: CAPTURED_AT,
      registryView: '64-bit',
      keys: [],
    });
  });

  it('does not pretend an access-denied export is an empty registry snapshot', async () => {
    runner.handler = (command) =>
      command.options.env?.['WPM_REGISTRY_ROOT'] === undefined
        ? { exitCode: 1, stdout: '', stderr: 'Access is denied.' }
        : { exitCode: 2, stdout: '', stderr: 'Access is denied.' };

    await expect(gateway.read()).rejects.toBeInstanceOf(EnvironmentError);
  });

  it('parses a reg.exe export into a snapshot', async () => {
    runner.handler = async (command) => {
      if (command.args[0] !== 'export') throw new Error('Unexpected command.');
      const path = command.args[2];
      if (path === undefined) throw new Error('Missing export path.');
      await writeFile(path, Buffer.from(readFixtureBytes('Mac_BlurGlass_Profile.reg')));
      return ok();
    };

    const snapshot = await gateway.read();

    expect(snapshot.keys).toHaveLength(21);
    expect(snapshot.keys.flatMap((key) => key.values)).toHaveLength(244);
    expect(snapshot.capturedAt).toBe(CAPTURED_AT);
    assertEveryCallUsesReg64(runner);
  });

  it('exports raw registry evidence using /reg:64', async () => {
    const path = join(tempDirectory, 'evidence.reg');

    await gateway.exportReg(path);

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.args).toEqual(['export', REGISTRY_MODS_ROOT, path, '/reg:64', '/y']);
    assertEveryCallUsesReg64(runner);
  });

  it('rejects a relative export path before spawning reg.exe', async () => {
    await expect(gateway.exportReg('evidence.reg')).rejects.toBeInstanceOf(ValidationError);
    expect(runner.calls).toHaveLength(0);
  });

  it('reconciles targeting and settings values while preserving Windhawk-owned values', async () => {
    const current = makeSnapshot([
      {
        path: MOD_ROOT,
        values: [
          { name: 'Disabled', value: { type: 'dword', value: 0 } },
          { name: 'LibraryFileName', value: { type: 'string', value: 'old.dll' } },
          { name: 'Version', value: { type: 'string', value: '1.0' } },
          { name: 'Include', value: { type: 'string', value: '*' } },
          { name: 'SettingsChangeTime', value: { type: 'dword', value: 5 } },
          { name: 'ExtraRoot', value: { type: 'string', value: 'leave-me' } },
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
    runner.handler = exportHandler(current);

    await gateway.reconcile(desired);

    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[0]?.args[0]).toBe('export');
    const writeCall = runner.calls[1];
    if (writeCall === undefined) throw new Error('Expected a batch write call.');
    expect(writeCall.executable).toBe(POWERSHELL_EXE);
    const operations = batchOf(writeCall).operations;
    const setOperations = operations.filter((operation) => operation.kind === 'set');
    const deleteOperations = operations.filter((operation) => operation.kind === 'deleteValue');
    expect(setOperations).toHaveLength(5);
    expect(deleteOperations).toEqual([{ kind: 'deleteValue', path: SETTINGS, name: 'Removed' }]);
    expect(setOperations.some((operation) => operation.name === 'LibraryFileName')).toBe(false);
    expect(setOperations.some((operation) => operation.name === 'SettingsChangeTime')).toBe(false);
    expect(
      setOperations.some(
        (operation) => operation.path === MOD_ROOT && operation.name === 'Version',
      ),
    ).toBe(false);
    expect(
      setOperations.some(
        (operation) => operation.path === SETTINGS && operation.name === 'Version',
      ),
    ).toBe(true);
    expect(setOperations.some((operation) => operation.name === 'ExtraRoot')).toBe(false);
    expect(setOperations.some((operation) => operation.name === 'Architecture')).toBe(true);
    assertNoRegWriteCommands(runner);
  });

  it('validates the whole snapshot before reconciling and writes nothing on failure', async () => {
    const invalid = {
      schemaVersion: 1,
      capturedAt: CAPTURED_AT,
      registryView: '64-bit',
      keys: [
        {
          path: REGISTRY_MODS_ROOT,
          values: [{ name: 'Unexpected', value: { type: 'dword', value: 1 } }],
        },
      ],
    } as unknown as RegistrySnapshot;

    await expect(gateway.reconcile(invalid)).rejects.toBeInstanceOf(ValidationError);
    expect(runner.calls).toHaveLength(0);
  });
});
