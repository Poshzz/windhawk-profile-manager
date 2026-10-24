import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NodeEnvironmentFileSystem } from '@infra/environment/node-environment-file-system';
import { RegExeSystemRegistryReader } from '@infra/environment/reg-exe-system-registry-reader';
import { WindowsEnvironmentProbe } from '@infra/environment/windows-environment-probe';
import { NodeCommandRunner } from '@infra/process/node-command-runner';
import { NodeProcessLauncher } from '@infra/process/node-process-launcher';
import { WindowsProcessController } from '@infra/process/windows-process-controller';
import { WindowsRegistryGateway } from '@infra/registry/windows-registry-gateway';
import { WindowsServiceController } from '@infra/services/windows-service-controller';

const RUN_SMOKE = process.env['WPM_ENVIRONMENT_SMOKE'] === '1';

describe.runIf(RUN_SMOKE)('real Windows environment probe', () => {
  let tempDirectory = '';

  beforeAll(async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), 'wpm-environment-smoke-'));
  });

  afterAll(async () => {
    if (tempDirectory.length > 0) {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it('reports Windhawk, the running service, mods, and Rainmeter on this machine', async () => {
    const runner = new NodeCommandRunner();
    const files = new NodeEnvironmentFileSystem();
    const registry = new WindowsRegistryGateway({
      commandRunner: runner,
      tempDirectory,
    });
    const probe = new WindowsEnvironmentProbe({
      registry,
      systemRegistry: new RegExeSystemRegistryReader({ runner }),
      service: new WindowsServiceController({ runner }),
      process: new WindowsProcessController({
        runner,
        launcher: new NodeProcessLauncher(),
        files,
      }),
      files,
      programFiles: process.env.ProgramFiles ?? 'C:\\Program Files',
    });

    const environment = await probe.probe();

    expect(environment.windows.supported).toBe(true);
    expect(Number(environment.windows.build)).toBeGreaterThanOrEqual(22_000);

    expect(environment.windhawk.installed).toBe(true);
    expect(environment.windhawk.installDir?.toLowerCase()).toBe('c:\\program files\\windhawk');
    expect(environment.windhawk.storageMode).toBe('registry');
    expect(environment.windhawk.portable).toBe(false);
    expect(environment.windhawk.registryRoot?.toLowerCase()).toBe('hklm\\software\\windhawk');

    expect(environment.service.state).toBe('running');
    expect(environment.mods).toHaveLength(10);
    expect(environment.rainmeter.installed).toBe(true);
    expect(environment.perUserConfig.active).toBe(false);
    expect(environment.compatibility.mode).toBe('writable');
    expect(environment.compatibility.canApply).toBe(true);
  }, 30_000);
});
