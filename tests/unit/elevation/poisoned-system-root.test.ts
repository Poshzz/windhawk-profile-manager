import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EnvironmentFileSystem } from '@core/environment/environment-file-system';
import type { ProcessLauncher } from '@core/process/process-launcher';
import { EnvironmentError } from '@shared/errors';
import { ShellExecuteExLauncher } from '@infra/elevation/shell-execute-launcher';
import { WindowsPathAccessChecker } from '@infra/elevation/windows-path-access';
import { WindowsRunDirectoryAcl } from '@infra/elevation/run-directory';
import { RegExeSystemRegistryReader } from '@infra/environment/reg-exe-system-registry-reader';
import { WindowsProcessController } from '@infra/process/windows-process-controller';
import { WindowsServiceController } from '@infra/services/windows-service-controller';
import { NodeSnapshotFileSystem } from '@infra/storage/snapshot-file-system';
import { FakeCommandRunner } from '../support/fake-command-runner';

const runner = new FakeCommandRunner();
const launcher: ProcessLauncher = { launch: async () => undefined };
const files = { fileExists: async () => false } as Pick<EnvironmentFileSystem, 'fileExists'>;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('poisoned SystemRoot fails closed', () => {
  it('rejects every system-binary adapter before spawning a command', () => {
    vi.stubEnv('SystemRoot', 'C:\\Users\\Test\\Windows');
    vi.stubEnv('WINDIR', 'C:\\Users\\Test\\Windows');

    expect(() => new WindowsServiceController({ runner })).toThrow(EnvironmentError);
    expect(() => new RegExeSystemRegistryReader({ runner })).toThrow(EnvironmentError);
    expect(() => new WindowsProcessController({ runner, launcher, files })).toThrow(
      EnvironmentError,
    );
    expect(() => new NodeSnapshotFileSystem()).toThrow(EnvironmentError);
    expect(() => new WindowsRunDirectoryAcl({ runner })).toThrow(EnvironmentError);
    expect(() => new ShellExecuteExLauncher()).toThrow(EnvironmentError);
    expect(() => new WindowsPathAccessChecker()).toThrow(EnvironmentError);

    expect(runner.calls).toHaveLength(0);
  });
});
