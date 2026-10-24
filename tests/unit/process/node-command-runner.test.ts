import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NodeCommandRunner } from '@infra/process/node-command-runner';
import { EnvironmentError } from '@shared/errors';

const runner = new NodeCommandRunner();
const nodeExecutable = process.execPath;

describe('NodeCommandRunner', () => {
  it('captures stdout, stderr, and a zero exit code', async () => {
    const result = await runner.run(nodeExecutable, [
      '-e',
      'process.stdout.write("out"); process.stderr.write("err");',
    ]);

    expect(result).toEqual({ exitCode: 0, stdout: 'out', stderr: 'err' });
  });

  it('returns a non-zero exit code and captured stderr', async () => {
    const result = await runner.run(nodeExecutable, [
      '-e',
      'process.stderr.write("bad"); process.exit(3);',
    ]);

    expect(result.exitCode).toBe(3);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('bad');
  });

  it('writes the supplied stdin and closes the stream', async () => {
    const result = await runner.run(
      nodeExecutable,
      [
        '-e',
        'let body = ""; process.stdin.on("data", (chunk) => { body += chunk; }); process.stdin.on("end", () => { process.stdout.write(body); });',
      ],
      { stdin: 'payload-from-parent' },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('payload-from-parent');
  });

  it('closes stdin when no input is supplied', async () => {
    const result = await runner.run(nodeExecutable, [
      '-e',
      'process.stdin.resume(); process.stdin.on("end", () => { process.stdout.write("closed"); });',
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('closed');
  });

  it('passes arguments as an array without invoking a shell', async () => {
    const result = await runner.run(nodeExecutable, [
      '-e',
      'process.stdout.write(process.argv[1])',
      'a & b',
    ]);

    expect(result.stdout).toBe('a & b');
  });

  it('rejects with an environment error when the command times out', async () => {
    const error = await runner
      .run(nodeExecutable, ['-e', 'setTimeout(() => {}, 5000);'], { timeoutMs: 100 })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(EnvironmentError);
    expect(error).toHaveProperty('message', 'The command timed out.');
  });

  it('rejects with an environment error when the executable cannot be spawned', async () => {
    const missing = join(process.cwd(), `missing-command-${Date.now()}.exe`);
    const error = await runner.run(missing, []).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(EnvironmentError);
    expect((error as Error).message).toContain('Could not run');
  });
});
