import type { CommandRunner } from '@core/process/command-runner';
import { system32Path } from '../elevation/system-paths';
import type { SystemRegistryReader } from '@core/environment/system-registry-reader';

export interface RegExeSystemRegistryReaderOptions {
  readonly runner: CommandRunner;
  readonly regExe?: string;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export class RegExeSystemRegistryReader implements SystemRegistryReader {
  private readonly runner: CommandRunner;
  private readonly regExe: string;
  private readonly timeoutMs: number;

  constructor(options: RegExeSystemRegistryReaderOptions) {
    this.runner = options.runner;
    this.regExe = options.regExe ?? system32Path('reg.exe');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async readString(keyPath: string, valueName: string): Promise<string | null> {
    try {
      const result = await this.runner.run(
        this.regExe,
        ['query', keyPath, '/v', valueName, '/reg:64'],
        { timeoutMs: this.timeoutMs },
      );
      if (result.exitCode !== 0) return null;

      for (const line of result.stdout.split(/\r?\n/)) {
        const match = /^\s+(.+?)\s{2,}(REG_[A-Z_]+)\s{2,}(.*)$/.exec(line);
        if (match === null) continue;
        if (match[1]?.trim().toLowerCase() !== valueName.toLowerCase()) continue;
        return match[3] ?? '';
      }
      return null;
    } catch {
      return null;
    }
  }
}
