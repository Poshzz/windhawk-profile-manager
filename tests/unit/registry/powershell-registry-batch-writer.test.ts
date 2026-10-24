import { basename } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PowerShellRegistryBatchWriter,
  type RegistryBatchOperation,
} from '@infra/registry/powershell-registry-batch-writer';
import { ApplyError, EnvironmentError, ValidationError } from '@shared/errors';
import { FakeCommandRunner, type RecordedCommand } from '../support/fake-command-runner';

const MOD_ROOT = 'HKLM\\SOFTWARE\\Windhawk\\Engine\\Mods\\demo-mod';
const SETTINGS = `${MOD_ROOT}\\Settings`;

interface PayloadOperation {
  readonly kind: 'set' | 'deleteValue';
  readonly path: string;
  readonly name: string;
  readonly type?: string;
  readonly value?: string | number;
}

interface Payload {
  readonly operations: readonly PayloadOperation[];
}

function parsePayload(command: RecordedCommand): Payload {
  const stdin = command.options.stdin;
  if (stdin === undefined) throw new Error('Expected stdin to carry the batch payload.');
  return JSON.parse(stdin) as Payload;
}

function makeWriter(runner: FakeCommandRunner): PowerShellRegistryBatchWriter {
  return new PowerShellRegistryBatchWriter({
    commandRunner: runner,
    powershellExe: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  });
}

describe('PowerShellRegistryBatchWriter', () => {
  it('writes every operation through a single PowerShell process', async () => {
    const runner = new FakeCommandRunner();
    const writer = makeWriter(runner);
    const operations: RegistryBatchOperation[] = [
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

    await writer.write(operations);

    expect(runner.calls).toHaveLength(1);
    const call = runner.calls[0];
    if (call === undefined) throw new Error('Expected one command.');
    expect(basename(call.executable).toLowerCase()).toBe('powershell.exe');
    expect(call.args).toContain('-NoProfile');
    expect(call.args).toContain('-EncodedCommand');
    expect(call.args).not.toContain('-File');
    expect(call.args.join(' ')).not.toMatch(/\breg(\.exe)?\b/i);
    expect(call.args.join(' ')).not.toMatch(/\bimport\b/i);
    expect(call.options.timeoutMs).toBe(300_000);
    expect(parsePayload(call)).toEqual({
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
  });

  it('uses one process for a 192-operation batch', async () => {
    const runner = new FakeCommandRunner();
    const writer = makeWriter(runner);
    const operations: RegistryBatchOperation[] = Array.from({ length: 192 }, (_, index) => ({
      kind: 'set',
      path: `${SETTINGS}`,
      name: `Setting${String(index)}`,
      value: { type: 'dword', value: index },
    }));

    await writer.write(operations);

    expect(runner.calls).toHaveLength(1);
    const call = runner.calls[0];
    if (call === undefined) throw new Error('Expected one command.');
    expect(parsePayload(call).operations).toHaveLength(192);
  });

  it('preserves every writable registry type and the default value name', async () => {
    const runner = new FakeCommandRunner();
    const writer = makeWriter(runner);
    const operations: RegistryBatchOperation[] = [
      {
        kind: 'set',
        path: MOD_ROOT,
        name: 'Disabled',
        value: { type: 'dword', value: 0xffffffff },
      },
      {
        kind: 'set',
        path: SETTINGS,
        name: 'Big',
        value: { type: 'qword', value: '18446744073709551615' },
      },
      {
        kind: 'set',
        path: SETTINGS,
        name: 'Path',
        value: { type: 'expandString', value: '%SystemRoot%\\temp' },
      },
      {
        kind: 'set',
        path: SETTINGS,
        name: 'Blob',
        value: { type: 'binary', value: '00ff10' },
      },
      {
        kind: 'set',
        path: SETTINGS,
        name: '',
        value: { type: 'string', value: '' },
      },
      { kind: 'deleteValue', path: SETTINGS, name: '' },
    ];

    await writer.write(operations);

    const call = runner.calls[0];
    if (call === undefined) throw new Error('Expected one command.');
    expect(parsePayload(call).operations).toEqual([
      { kind: 'set', path: MOD_ROOT, name: 'Disabled', type: 'dword', value: 0xffffffff },
      {
        kind: 'set',
        path: SETTINGS,
        name: 'Big',
        type: 'qword',
        value: '18446744073709551615',
      },
      {
        kind: 'set',
        path: SETTINGS,
        name: 'Path',
        type: 'expandString',
        value: '%SystemRoot%\\temp',
      },
      { kind: 'set', path: SETTINGS, name: 'Blob', type: 'binary', value: '00ff10' },
      { kind: 'set', path: SETTINGS, name: '', type: 'string', value: '' },
      { kind: 'deleteValue', path: SETTINGS, name: '' },
    ]);
  });

  it('keeps value text out of the command line and inside stdin only', async () => {
    const runner = new FakeCommandRunner();
    const writer = makeWriter(runner);
    const sentinel = '"; Remove-Item C:\\ -Recurse; "';
    const operations: RegistryBatchOperation[] = [
      {
        kind: 'set',
        path: SETTINGS,
        name: 'Injection',
        value: { type: 'string', value: sentinel },
      },
    ];

    await writer.write(operations);

    const call = runner.calls[0];
    if (call === undefined) throw new Error('Expected one command.');
    expect(call.args.join('\n')).not.toContain(sentinel);
    expect(call.options.stdin).toContain(JSON.stringify(sentinel).slice(1, -1));
  });

  it('maps a missing key to an ApplyError and never creates it', async () => {
    const runner = new FakeCommandRunner();
    runner.handler = () => ({
      exitCode: 2,
      stdout: '',
      stderr: `WPM_MISSING_KEY=${MOD_ROOT}`,
    });
    const writer = makeWriter(runner);

    const error = await writer
      .write([
        {
          kind: 'set',
          path: SETTINGS,
          name: 'Theme',
          value: { type: 'string', value: 'macOS' },
        },
      ])
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApplyError);
    expect((error as Error).message).toContain(MOD_ROOT);
    expect((error as Error).message).toMatch(/refusing to create/i);
    expect(runner.calls).toHaveLength(1);
  });

  it('maps any other script failure to an EnvironmentError', async () => {
    const runner = new FakeCommandRunner();
    runner.handler = () => ({ exitCode: 3, stdout: '', stderr: 'boom' });
    const writer = makeWriter(runner);

    const error = await writer
      .write([
        {
          kind: 'set',
          path: SETTINGS,
          name: 'Theme',
          value: { type: 'string', value: 'macOS' },
        },
      ])
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(EnvironmentError);
    expect((error as Error).message).toContain('exit code 3');
    expect(runner.calls).toHaveLength(1);
  });

  it('does not spawn a process when the batch is empty', async () => {
    const runner = new FakeCommandRunner();
    const writer = makeWriter(runner);

    await writer.write([]);

    expect(runner.calls).toHaveLength(0);
  });

  it.runIf(process.platform === 'win32')(
    'resolves powershell.exe from the trusted Windows system root by default',
    async () => {
      const runner = new FakeCommandRunner();
      const writer = new PowerShellRegistryBatchWriter({ commandRunner: runner });

      await writer.write([
        {
          kind: 'set',
          path: SETTINGS,
          name: 'Theme',
          value: { type: 'string', value: 'macOS' },
        },
      ]);

      const call = runner.calls[0];
      if (call === undefined) throw new Error('Expected one command.');
      expect(call.executable).toMatch(
        /^[A-Za-z]:\\Windows\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i,
      );
    },
  );

  it('keeps the encoded script within the Windows command-line limit', async () => {
    const runner = new FakeCommandRunner();
    const writer = makeWriter(runner);

    await writer.write([
      {
        kind: 'set',
        path: SETTINGS,
        name: 'Theme',
        value: { type: 'string', value: 'macOS' },
      },
    ]);

    const call = runner.calls[0];
    if (call === undefined) throw new Error('Expected one command.');
    const flagIndex = call.args.indexOf('-EncodedCommand');
    const encoded = call.args[flagIndex + 1];
    if (encoded === undefined) throw new Error('Expected an encoded command argument.');
    expect(encoded.length).toBeLessThan(30_000);
  });

  it.each(['multiString', 'none'] as const)('rejects %s values before spawning', async (type) => {
    const runner = new FakeCommandRunner();
    const writer = makeWriter(runner);
    const value = type === 'multiString' ? { type, value: ['a', 'b'] } : { type, value: null };

    await expect(
      writer.write([
        {
          kind: 'set',
          path: SETTINGS,
          name: 'Unsupported',
          value: value as never,
        },
      ]),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(runner.calls).toHaveLength(0);
  });

  it.each([
    ['a relative path', 'SOFTWARE\\Windhawk'],
    ['an unsupported hive', 'HKXX\\SOFTWARE\\Windhawk'],
    ['a trailing separator', `${SETTINGS}\\`],
    ['an empty segment', 'HKLM\\\\SOFTWARE'],
    ['a newline', `HKLM\\SOFTWARE\\bad\npath`],
    ['a forward slash', `HKLM\\SOFTWARE\\bad/path`],
  ])('rejects %s before spawning', async (_label, path) => {
    const runner = new FakeCommandRunner();
    const writer = makeWriter(runner);

    await expect(
      writer.write([
        {
          kind: 'set',
          path,
          name: 'Theme',
          value: { type: 'string', value: 'macOS' },
        },
      ]),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(runner.calls).toHaveLength(0);
  });
});
