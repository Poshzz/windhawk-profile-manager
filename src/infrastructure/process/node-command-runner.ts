import { spawn } from 'node:child_process';
import type { CommandResult, CommandRunOptions, CommandRunner } from '@core/process/command-runner';
import { EnvironmentError } from '@shared/errors';

const MAX_CAPTURED_OUTPUT = 1024 * 1024;

export class NodeCommandRunner implements CommandRunner {
  run(
    executable: string,
    args: readonly string[],
    options: CommandRunOptions = {},
  ): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(executable, [...args], {
        shell: false,
        windowsHide: true,
        cwd: options.cwd,
        ...(options.env === undefined ? {} : { env: { ...process.env, ...options.env } }),
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      let timer: NodeJS.Timeout | undefined;

      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        callback();
      };

      const append = (current: string, chunk: Buffer): string => {
        if (current.length >= MAX_CAPTURED_OUTPUT) return current;
        return (current + chunk.toString('utf8')).slice(0, MAX_CAPTURED_OUTPUT);
      };

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout = append(stdout, chunk);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr = append(stderr, chunk);
      });
      child.once('error', (error) => {
        finish(() =>
          reject(new EnvironmentError(`Could not run ${executable}.`, { cause: error })),
        );
      });
      child.once('close', (code, signal) => {
        finish(() =>
          resolve({
            exitCode: code ?? (signal === null ? 0 : -1),
            stdout,
            stderr,
          }),
        );
      });

      // A child may exit before reading all input (for example after a parse
      // failure). EPIPE on stdin must not become an uncaught stream error; the
      // exit code remains the authoritative result.
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(options.stdin ?? '', 'utf8');

      if (options.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          child.kill();
          finish(() => reject(new EnvironmentError('The command timed out.')));
        }, options.timeoutMs);
      }
    });
  }
}
