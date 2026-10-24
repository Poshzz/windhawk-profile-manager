import { join } from 'node:path';
import type { CommandRunner } from '@core/process/command-runner';
import { system32Path } from '../elevation/system-paths';
import type { ProcessLauncher } from '@core/process/process-launcher';
import type {
  ExplorerRestartOutcome,
  ExplorerRestartResult,
  ProcessController,
} from '@core/process/process-controller';
import type { EnvironmentFileSystem } from '@core/environment/environment-file-system';
import { isAbsoluteWindowsPath, type RainmeterInfo } from '@shared/domain';
import { EnvironmentError } from '@shared/errors';

export interface ProcessEntry {
  readonly imageName: string;
  readonly pid: number;
}

export interface WindowsProcessControllerOptions {
  readonly runner: CommandRunner;
  readonly launcher: ProcessLauncher;
  readonly files: Pick<EnvironmentFileSystem, 'fileExists'>;
  readonly programFiles?: string;
  readonly tasklistExe?: string;
  readonly taskkillExe?: string;
  readonly wmicExe?: string;
  readonly timeoutMs?: number;
  readonly shellWaitTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_SHELL_WAIT_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const RAINMETER_EXE = 'Rainmeter.exe';
const EXPLORER_EXE = 'explorer.exe';

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (character === ',' && !quoted) {
      fields.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  fields.push(current);
  return fields;
}

export function parseTasklist(stdout: string): ProcessEntry[] {
  const entries: ProcessEntry[] = [];

  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const fields = parseCsvLine(trimmed);
    const imageName = fields[0]?.trim();
    const pidText = fields[1]?.trim();
    if (imageName === undefined || imageName.length === 0 || pidText === undefined) continue;
    const pid = Number(pidText);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    entries.push({ imageName, pid });
  }

  return entries;
}

export function parseWmicExecutablePath(stdout: string): string | null {
  const value = /^\s*ExecutablePath\s*=\s*(.+)$/im.exec(stdout)?.[1]?.trim();
  return value !== undefined && value.length > 0 ? value : null;
}

function isImage(entry: ProcessEntry, imageName: string): boolean {
  return entry.imageName.toLowerCase() === imageName.toLowerCase();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class WindowsProcessController implements ProcessController {
  private readonly runner: CommandRunner;
  private readonly launcher: ProcessLauncher;
  private readonly files: Pick<EnvironmentFileSystem, 'fileExists'>;
  private readonly programFiles: string;
  private readonly tasklistExe: string;
  private readonly taskkillExe: string;
  private readonly wmicExe: string;
  private readonly timeoutMs: number;
  private readonly shellWaitTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;

  constructor(options: WindowsProcessControllerOptions) {
    this.runner = options.runner;
    this.launcher = options.launcher;
    this.files = options.files;
    this.programFiles = options.programFiles ?? process.env.ProgramFiles ?? 'C:\\Program Files';
    this.tasklistExe = options.tasklistExe ?? system32Path('tasklist.exe');
    this.taskkillExe = options.taskkillExe ?? system32Path('taskkill.exe');
    this.wmicExe = options.wmicExe ?? join(system32Path('wbem'), 'WMIC.exe');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.shellWaitTimeoutMs = options.shellWaitTimeoutMs ?? DEFAULT_SHELL_WAIT_TIMEOUT_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.sleep =
      options.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.now = options.now ?? (() => Date.now());
  }

  async rainmeterStatus(): Promise<RainmeterInfo> {
    const processes = await this.listProcesses(RAINMETER_EXE);
    const running = processes.some((entry) => isImage(entry, RAINMETER_EXE));
    let path: string | null = running ? await this.runningPath(RAINMETER_EXE) : null;

    if (path === null) {
      const fallback = join(this.programFiles, 'Rainmeter', RAINMETER_EXE);
      if (await this.files.fileExists(fallback)) path = fallback;
    }

    return { installed: running || path !== null, running, path };
  }

  async startRainmeter(): Promise<void> {
    const status = await this.rainmeterStatus();
    if (!status.installed || status.path === null) {
      throw new EnvironmentError('Rainmeter is not installed or its executable path is unknown.');
    }
    await this.launcher.launch(status.path);
  }

  async quitRainmeter(): Promise<void> {
    const status = await this.rainmeterStatus();
    if (!status.running) return;
    if (status.path === null) {
      throw new EnvironmentError('Rainmeter is running but its executable path is unknown.');
    }

    const result = await this.runner.run(status.path, ['!Quit'], { timeoutMs: this.timeoutMs });
    if (result.exitCode !== 0) {
      throw new EnvironmentError(
        `Rainmeter did not accept the !Quit command (exit code ${result.exitCode}).`,
      );
    }
  }

  async restartExplorer(): Promise<ExplorerRestartResult> {
    let beforePids = new Set<number>();
    let kill: ExplorerRestartOutcome;

    try {
      const before = await this.listProcesses(EXPLORER_EXE);
      beforePids = new Set(
        before.filter((entry) => isImage(entry, EXPLORER_EXE)).map((entry) => entry.pid),
      );
      kill = await this.killExplorer(beforePids);
    } catch (error) {
      kill = {
        attempted: false,
        succeeded: false,
        detail: `Could not inspect the Explorer process: ${errorMessage(error)}`,
      };
    }

    let start: ExplorerRestartOutcome;
    try {
      await this.launcher.launch('explorer.exe');
      start = { attempted: true, succeeded: true, detail: 'Explorer was started.' };
    } catch (error) {
      start = {
        attempted: true,
        succeeded: false,
        detail: `Explorer could not be started: ${errorMessage(error)}`,
      };
    }

    const shellRestarted = await this.waitForNewExplorer(beforePids);
    return { kill, start, shellRestarted };
  }

  private async listProcesses(imageName?: string): Promise<ProcessEntry[]> {
    const filter = imageName === undefined ? [] : ['/FI', `IMAGENAME eq ${imageName}`];
    const result = await this.runner.run(this.tasklistExe, [...filter, '/FO', 'CSV', '/NH'], {
      timeoutMs: this.timeoutMs,
    });
    if (result.exitCode !== 0) {
      throw new EnvironmentError(`tasklist failed with exit code ${result.exitCode}.`);
    }
    return parseTasklist(result.stdout);
  }

  private async runningPath(imageName: string): Promise<string | null> {
    try {
      const result = await this.runner.run(
        this.wmicExe,
        ['process', 'where', `name='${imageName}'`, 'get', 'ExecutablePath', '/value'],
        { timeoutMs: this.timeoutMs },
      );
      if (result.exitCode !== 0) return null;
      const path = parseWmicExecutablePath(result.stdout);
      if (path === null || !isAbsoluteWindowsPath(path)) return null;
      return (await this.files.fileExists(path)) ? path : null;
    } catch {
      return null;
    }
  }

  private async killExplorer(pids: ReadonlySet<number>): Promise<ExplorerRestartOutcome> {
    if (pids.size === 0) {
      return {
        attempted: false,
        succeeded: false,
        detail: 'No explorer.exe process was found before the restart.',
      };
    }

    const failures: string[] = [];
    for (const pid of pids) {
      try {
        const result = await this.runner.run(this.taskkillExe, ['/PID', String(pid), '/F'], {
          timeoutMs: this.timeoutMs,
        });
        if (result.exitCode !== 0) {
          failures.push(`PID ${pid} exited with code ${result.exitCode}`);
        }
      } catch (error) {
        failures.push(`PID ${pid}: ${errorMessage(error)}`);
      }
    }

    return failures.length === 0
      ? {
          attempted: true,
          succeeded: true,
          detail: `Stopped Explorer PID(s) ${[...pids].join(', ')}.`,
        }
      : {
          attempted: true,
          succeeded: false,
          detail: `Explorer could not be fully stopped: ${failures.join('; ')}.`,
        };
  }

  private async waitForNewExplorer(beforePids: ReadonlySet<number>): Promise<boolean> {
    const deadline = this.now() + this.shellWaitTimeoutMs;

    for (;;) {
      try {
        const current = await this.listProcesses(EXPLORER_EXE);
        if (current.some((entry) => isImage(entry, EXPLORER_EXE) && !beforePids.has(entry.pid))) {
          return true;
        }
      } catch {
        // Keep polling; the shell may be starting while tasklist is briefly unavailable.
      }

      if (this.now() >= deadline) return false;
      await this.sleep(this.pollIntervalMs);
    }
  }
}
