import { describe, expect, it } from 'vitest';
import type { CommandResult, CommandRunner } from '@core/process/command-runner';
import { EnvironmentError } from '@shared/errors';
import { currentWindowsSid, WindowsRunDirectoryAcl } from '@infra/elevation/run-directory';

class RecordingRunner implements CommandRunner {
  readonly calls: Array<{ executable: string; args: readonly string[] }> = [];
  result: CommandResult = { exitCode: 0, stdout: '', stderr: '' };

  async run(executable: string, args: readonly string[]): Promise<CommandResult> {
    this.calls.push({ executable, args });
    return this.result;
  }
}

describe('currentWindowsSid', () => {
  it('reads the authenticated token SID rather than USERNAME', async () => {
    const runner = new RecordingRunner();
    runner.result = {
      exitCode: 0,
      stdout: '"DOMAIN\\alice","S-1-5-21-1000-2000-3000-1001"\r\n',
      stderr: '',
    };

    await expect(currentWindowsSid(runner)).resolves.toBe('S-1-5-21-1000-2000-3000-1001');
  });

  it('fails closed when whoami does not return a SID', async () => {
    const runner = new RecordingRunner();
    runner.result = { exitCode: 0, stdout: 'DOMAIN\\alice\r\n', stderr: '' };

    await expect(currentWindowsSid(runner)).rejects.toBeInstanceOf(EnvironmentError);
  });
});

describe('WindowsRunDirectoryAcl', () => {
  it('grants the invoking user, Administrators, and SYSTEM full control without inheritance', async () => {
    const runner = new RecordingRunner();
    const acl = new WindowsRunDirectoryAcl({
      runner,
      user: 'MACHINE\\Test',
      icaclsExe: 'C:\\Windows\\System32\\icacls.exe',
    });

    await acl.apply('C:\\ProgramData\\WindhawkProfileManager\\runs\\run-1');

    expect(runner.calls).toHaveLength(1);
    const call = runner.calls[0]!;
    expect(call.executable).toBe('C:\\Windows\\System32\\icacls.exe');
    expect(call.args).toContain('/inheritance:r');
    expect(call.args).toContain('MACHINE\\Test:(OI)(CI)F');
    expect(call.args).toContain('*S-1-5-32-544:(OI)(CI)F');
    expect(call.args).toContain('*S-1-5-18:(OI)(CI)F');
    expect(call.args).toContain('/Q');
  });

  it('turns a failed icacls call into an environment error', async () => {
    const runner = new RecordingRunner();
    runner.result = { exitCode: 5, stdout: '', stderr: 'Access is denied.' };
    const acl = new WindowsRunDirectoryAcl({
      runner,
      user: 'MACHINE\\Test',
      icaclsExe: 'icacls.exe',
    });

    await expect(acl.apply('C:\\ProgramData\\run')).rejects.toBeInstanceOf(EnvironmentError);
  });
});
