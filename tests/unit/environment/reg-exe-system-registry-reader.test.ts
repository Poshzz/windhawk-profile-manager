import { describe, expect, it } from 'vitest';
import { RegExeSystemRegistryReader } from '@infra/environment/reg-exe-system-registry-reader';
import { readFixture } from '../domain/test-fixtures';
import { FakeCommandRunner } from '../support/fake-command-runner';

const INSTALLER_KEY = 'HKLM\\SOFTWARE\\WOW6432Node\\Windhawk';

describe('RegExeSystemRegistryReader', () => {
  it('reads a REG_SZ value through the 64-bit view', async () => {
    const runner = new FakeCommandRunner();
    runner.handler = () => ({
      exitCode: 0,
      stdout: readFixture('registry/query-install-dir.txt'),
      stderr: '',
    });
    const reader = new RegExeSystemRegistryReader({ runner, regExe: 'reg.exe' });

    await expect(reader.readString(INSTALLER_KEY, 'install_dir')).resolves.toBe(
      'C:\\Program Files\\Windhawk',
    );
    expect(runner.calls[0]?.args).toEqual(['query', INSTALLER_KEY, '/v', 'install_dir', '/reg:64']);
    expect(runner.calls[0]?.args).not.toContain('import');
  });

  it('returns null when the value is absent', async () => {
    const runner = new FakeCommandRunner();
    runner.handler = () => ({ exitCode: 1, stdout: '', stderr: 'not found' });
    const reader = new RegExeSystemRegistryReader({ runner, regExe: 'reg.exe' });

    await expect(reader.readString(INSTALLER_KEY, 'install_dir')).resolves.toBeNull();
  });

  it('returns null when the command cannot run', async () => {
    const runner = new FakeCommandRunner();
    runner.handler = () => {
      throw new Error('reg.exe timed out');
    };
    const reader = new RegExeSystemRegistryReader({ runner, regExe: 'reg.exe' });

    await expect(reader.readString(INSTALLER_KEY, 'install_dir')).resolves.toBeNull();
  });
});
