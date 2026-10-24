import { describe, expect, it } from 'vitest';
import { WindowsUserOnlyAcl } from '@infra/storage/snapshot-file-system';
import { EnvironmentError, ValidationError } from '@shared/errors';
import { FakeCommandRunner } from '../support/fake-command-runner';

describe('WindowsUserOnlyAcl', () => {
  it('grants the invoking user plus Administrators and SYSTEM with inheritance', async () => {
    const runner = new FakeCommandRunner();
    const acl = new WindowsUserOnlyAcl(runner, 'TEST\\alice');

    await acl.apply('C:\\snapshots', 'directory');

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.executable.toLowerCase()).toContain('icacls.exe');
    expect(runner.calls[0]?.args).toEqual([
      'C:\\snapshots',
      '/inheritance:r',
      '/grant:r',
      'TEST\\alice:(OI)(CI)F',
      '/grant:r',
      '*S-1-5-32-544:(OI)(CI)F',
      '/grant:r',
      '*S-1-5-18:(OI)(CI)F',
      '/Q',
    ]);
  });

  it('grants file-level access without inheritance flags', async () => {
    const runner = new FakeCommandRunner();
    const acl = new WindowsUserOnlyAcl(runner, 'TEST\\alice');

    await acl.apply('C:\\snapshots\\one.reg', 'file');

    expect(runner.calls[0]?.args).toEqual([
      'C:\\snapshots\\one.reg',
      '/inheritance:r',
      '/grant:r',
      'TEST\\alice:F',
      '/grant:r',
      '*S-1-5-32-544:F',
      '/grant:r',
      '*S-1-5-18:F',
      '/Q',
    ]);
  });

  it('uses the invoking SID instead of the elevated process account', async () => {
    const runner = new FakeCommandRunner();
    const acl = new WindowsUserOnlyAcl(runner, 'S-1-5-21-1000-1001-1002-1003');

    await acl.apply('C:\\snapshots', 'directory');

    expect(runner.calls[0]?.args).toContain('*S-1-5-21-1000-1001-1002-1003:(OI)(CI)F');
    expect(runner.calls[0]?.args.join(' ')).not.toContain(process.env.USERNAME ?? '\u0000');
  });

  it('rejects an unsafe ACL principal before spawning icacls', () => {
    const runner = new FakeCommandRunner();

    expect(() => new WindowsUserOnlyAcl(runner, 'TEST\\alice:(OI)(CI)F')).toThrow(ValidationError);
    expect(runner.calls).toHaveLength(0);
  });

  it('reports an icacls failure instead of silently continuing', async () => {
    const runner = new FakeCommandRunner();
    runner.handler = () => ({ exitCode: 5, stdout: '', stderr: 'Access is denied.' });
    const acl = new WindowsUserOnlyAcl(runner, 'TEST\\alice');

    await expect(acl.apply('C:\\snapshots', 'directory')).rejects.toBeInstanceOf(EnvironmentError);
  });
});
