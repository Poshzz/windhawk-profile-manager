import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { NodeCommandRunner } from '@infra/process/node-command-runner';

const describeWindows = process.platform === 'win32' ? describe : describe.skip;

describeWindows('reg.exe integration', () => {
  const runner = new NodeCommandRunner();
  const testKey = `HKCU\\Software\\WindhawkProfileManagerTests\\${randomUUID()}`;

  afterAll(async () => {
    await runner.run('reg.exe', ['delete', testKey, '/reg:64', '/f'], { timeoutMs: 10_000 });
  });

  it('writes, queries, and deletes a disposable HKCU value', async () => {
    const add = await runner.run(
      'reg.exe',
      ['add', testKey, '/reg:64', '/v', 'TestValue', '/t', 'REG_SZ', '/d', 'hello', '/f'],
      { timeoutMs: 10_000 },
    );
    expect(add.exitCode).toBe(0);

    const query = await runner.run('reg.exe', ['query', testKey, '/reg:64', '/v', 'TestValue'], {
      timeoutMs: 10_000,
    });
    expect(query.exitCode).toBe(0);
    expect(query.stdout).toContain('TestValue');

    const remove = await runner.run('reg.exe', ['delete', testKey, '/reg:64', '/f'], {
      timeoutMs: 10_000,
    });
    expect(remove.exitCode).toBe(0);
  });
});
