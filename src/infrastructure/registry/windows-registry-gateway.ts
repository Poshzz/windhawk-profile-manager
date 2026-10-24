import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { CommandResult, CommandRunner } from '@core/process/command-runner';
import { assertApplyOpsAllowed } from '@core/registry/apply-allowlist';
import { parseRegFile } from '@core/registry/reg-codec';
import {
  planReconcileOperations,
  parseRestoreRegistryOps,
  type RegistryMutation,
} from '@core/registry/reconcile';
import { createEmptyRegistrySnapshot, type RegistryGateway } from '@core/registry/registry-gateway';
import {
  REGISTRY_MODS_ROOT,
  isAbsoluteWindowsPath,
  parseRegistryOps,
  parseRegistrySnapshot,
  type RegistryOp,
  type RegistrySnapshot,
  type RegistryValue,
} from '@shared/domain';
import { EnvironmentError, ValidationError } from '@shared/errors';
import { system32Path } from '../elevation/system-paths';
import { PowerShellRegistryBatchWriter } from './powershell-registry-batch-writer';

export interface WindowsRegistryGatewayOptions {
  readonly commandRunner: CommandRunner;
  readonly tempDirectory: string;
  readonly regExe?: string;
  readonly powershellExe?: string;
  readonly now?: () => Date;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function assertWritableValue(value: RegistryValue): void {
  switch (value.type) {
    case 'dword':
    case 'qword':
    case 'string':
    case 'expandString':
    case 'binary':
      return;
    case 'multiString':
      throw new ValidationError(
        'Writing REG_MULTI_SZ is not supported by the registry gateway; Windhawk settings use REG_SZ and REG_DWORD.',
      );
    case 'none':
      throw new ValidationError('Writing REG_NONE is not supported by the registry gateway.');
  }
}

function toMutations(operations: readonly RegistryOp[]): RegistryMutation[] {
  return operations.map((operation) =>
    operation.kind === 'set'
      ? {
          kind: 'set',
          path: operation.path,
          name: operation.name,
          value: operation.value,
        }
      : {
          kind: 'deleteValue',
          path: operation.path,
          name: operation.name,
        },
  );
}

function assertExecutableMutations(mutations: readonly RegistryMutation[]): void {
  for (const mutation of mutations) {
    if (mutation.kind === 'set') assertWritableValue(mutation.value);
  }
}

export class WindowsRegistryGateway implements RegistryGateway {
  private readonly commandRunner: CommandRunner;
  private readonly tempDirectory: string;
  private readonly regExe: string;
  private readonly now: () => Date;
  private readonly batchWriter: PowerShellRegistryBatchWriter;

  constructor(options: WindowsRegistryGatewayOptions) {
    this.commandRunner = options.commandRunner;
    this.tempDirectory = options.tempDirectory;
    this.regExe = options.regExe ?? system32Path('reg.exe');
    this.now = options.now ?? (() => new Date());
    this.batchWriter = new PowerShellRegistryBatchWriter({
      commandRunner: options.commandRunner,
      powershellExe: options.powershellExe,
    });
  }

  async read(): Promise<RegistrySnapshot> {
    await mkdir(this.tempDirectory, { recursive: true });
    const tempPath = join(this.tempDirectory, `wpm-reg-read-${randomUUID()}.reg`);

    try {
      const result = await this.runReg(['export', REGISTRY_MODS_ROOT, tempPath, '/reg:64']);
      const fileExists = await exists(tempPath);

      if (result.exitCode !== 0) {
        const emptyExport = !fileExists || (await stat(tempPath)).size === 0;
        if (emptyExport && (await this.batchWriter.probeRoot(REGISTRY_MODS_ROOT)) === 'missing') {
          return createEmptyRegistrySnapshot(this.now().toISOString());
        }
        throw this.commandFailure('read', result.exitCode);
      }
      if (!fileExists) throw this.commandFailure('read', result.exitCode);

      const bytes = await readFile(tempPath);
      return parseRegFile(bytes, { capturedAt: this.now().toISOString() });
    } finally {
      await rm(tempPath, { force: true }).catch(() => undefined);
    }
  }

  async applyOps(ops: RegistryOp[]): Promise<void> {
    const parsed = parseRegistryOps(ops);
    assertApplyOpsAllowed(parsed);
    const mutations = toMutations(parsed);

    assertExecutableMutations(mutations);
    await this.batchWriter.write(mutations);
  }

  async applyRestoreOps(ops: RegistryOp[]): Promise<void> {
    const parsed = parseRegistryOps(ops);
    const restore = parseRestoreRegistryOps(toMutations(parsed));
    assertExecutableMutations(restore);
    await this.batchWriter.write(restore);
  }

  async exportReg(path: string): Promise<void> {
    if (!isAbsoluteWindowsPath(path) || !path.toLowerCase().endsWith('.reg')) {
      throw new ValidationError('Expected an absolute path to a .reg file.');
    }

    const result = await this.runReg(['export', REGISTRY_MODS_ROOT, path, '/reg:64', '/y']);
    if (result.exitCode !== 0) throw this.commandFailure('export', result.exitCode);
  }

  async reconcile(snapshot: RegistrySnapshot): Promise<void> {
    const desired = parseRegistrySnapshot(snapshot);
    const current = await this.read();
    const operations = planReconcileOperations(desired, current, {
      requireRestorableCurrent: true,
    });
    const parsed = parseRestoreRegistryOps(operations);
    assertExecutableMutations(parsed);
    await this.batchWriter.write(parsed);
  }

  private async runReg(args: readonly string[]): Promise<CommandResult> {
    if (!args.some((arg) => arg.toLowerCase() === '/reg:64')) {
      throw new Error('Internal error: every reg.exe call must use /reg:64.');
    }
    return this.commandRunner.run(this.regExe, args, { timeoutMs: 30_000 });
  }

  private commandFailure(action: string, exitCode: number): EnvironmentError {
    return new EnvironmentError(
      `The Windows registry command failed while trying to ${action} (exit code ${exitCode}).`,
      {
        details: [
          {
            path: [],
            message: `reg.exe exited with code ${exitCode}.`,
          },
        ],
      },
    );
  }
}
