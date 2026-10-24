import type { CommandResult, CommandRunner } from '@core/process/command-runner';
import { system32Path } from '../elevation/system-paths';
import {
  parseScImagePath,
  parseScQuery,
  type EnsureServiceRunningResult,
  type ServiceController,
} from '@core/services/service-controller';
import type { ServiceInfo } from '@shared/domain';
import { EnvironmentError } from '@shared/errors';

export interface WindowsServiceControllerOptions {
  readonly runner: CommandRunner;
  readonly name?: string;
  readonly scExe?: string;
  readonly timeoutMs?: number;
  readonly startTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_START_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const ERROR_SERVICE_ALREADY_RUNNING = 1056;

export class WindowsServiceController implements ServiceController {
  readonly name: string;
  private readonly runner: CommandRunner;
  private readonly scExe: string;
  private readonly timeoutMs: number;
  private readonly startTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;

  constructor(options: WindowsServiceControllerOptions) {
    this.runner = options.runner;
    this.name = options.name ?? 'Windhawk';
    this.scExe = options.scExe ?? system32Path('sc.exe');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.sleep =
      options.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.now = options.now ?? (() => Date.now());
  }

  async status(): Promise<ServiceInfo> {
    try {
      const result = await this.runSc(['query', this.name]);
      if (result.exitCode === 0) return parseScQuery(result.stdout, this.name);
      if (
        result.exitCode === 1060 ||
        /does not exist|FAILED\s+1060/i.test(`${result.stdout}\n${result.stderr}`)
      ) {
        return { name: this.name, state: 'missing' };
      }
      return { name: this.name, state: 'unknown' };
    } catch {
      return { name: this.name, state: 'unknown' };
    }
  }

  async ensureRunning(): Promise<EnsureServiceRunningResult> {
    const current = await this.status();
    if (current.state === 'running') return { service: current, started: false };
    if (current.state === 'missing') {
      throw new EnvironmentError(`The ${this.name} service is not installed.`);
    }

    let started: CommandResult;
    try {
      started = await this.runSc(['start', this.name]);
    } catch (error) {
      throw new EnvironmentError(`Timed out while trying to start the ${this.name} service.`, {
        cause: error,
      });
    }

    if (started.exitCode !== 0 && started.exitCode !== ERROR_SERVICE_ALREADY_RUNNING) {
      throw new EnvironmentError(
        `The ${this.name} service could not be started (exit code ${started.exitCode}).`,
        {
          details: [
            {
              path: [],
              message: (started.stderr.trim() || started.stdout.trim()).slice(0, 1000),
            },
          ],
        },
      );
    }

    const deadline = this.now() + this.startTimeoutMs;
    for (;;) {
      const service = await this.status();
      if (service.state === 'running') return { service, started: true };
      if (service.state === 'missing') {
        throw new EnvironmentError(`The ${this.name} service disappeared while starting.`);
      }
      if (this.now() >= deadline) {
        throw new EnvironmentError(
          `Timed out waiting for the ${this.name} service to reach the running state.`,
        );
      }
      await this.sleep(this.pollIntervalMs);
    }
  }

  async imagePath(): Promise<string | null> {
    try {
      const result = await this.runSc(['qc', this.name]);
      return result.exitCode === 0 ? parseScImagePath(result.stdout) : null;
    } catch {
      return null;
    }
  }

  private runSc(args: readonly string[]): Promise<CommandResult> {
    return this.runner.run(this.scExe, args, { timeoutMs: this.timeoutMs });
  }
}
