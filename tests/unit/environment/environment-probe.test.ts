import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeEnvironmentProbe } from '@core/environment/environment-probe';
import { FakeEnvironmentFileSystem } from '@core/environment/environment-file-system';
import { FakeSystemRegistryReader } from '@core/environment/system-registry-reader';
import { FakeProcessController } from '@core/process/process-controller';
import { FakeRegistryGateway } from '@core/registry/fake-registry-gateway';
import { FakeServiceController } from '@core/services/service-controller';
import { WindowsEnvironmentProbe } from '@infra/environment/windows-environment-probe';
import { parseEnvironment, type RegistrySnapshot } from '@shared/domain';
import { readFixture } from '../domain/test-fixtures';
import { dword, makeSnapshot, modKeys, modRootPath, stringValue } from '../planner/support';

const PROBED_AT = '2026-10-23T00:00:00.000Z';
const INSTALL_DIR = 'C:\\Program Files\\Windhawk';
const INSTALLER_KEY = 'HKLM\\SOFTWARE\\WOW6432Node\\Windhawk';
const WINDOWS_KEY = 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion';
const RAINMETER_PATH = 'C:\\Program Files\\Rainmeter\\Rainmeter.exe';

const DEFAULT_SNAPSHOT = makeSnapshot([
  ...modKeys('alpha', {
    version: '1.2.0',
    settings: {
      Theme: stringValue('macOS'),
      TaskbarHeight: dword(48),
    },
  }),
  ...modKeys('beta', {
    enabled: false,
    libraryFileName: 'beta.dll',
  }),
]);

function defaultFiles(): FakeEnvironmentFileSystem {
  const files = new FakeEnvironmentFileSystem({
    files: {
      [join(INSTALL_DIR, 'windhawk.exe')]: '',
      [join(INSTALL_DIR, 'windhawk.ini')]: readFixture('windhawk/registry.ini'),
    },
    directories: {
      [join(INSTALL_DIR, 'Engine')]: ['1.6.9', '1.7.3', 'not-a-version'],
    },
  });
  return files;
}

function defaultSystemRegistry(): FakeSystemRegistryReader {
  return new FakeSystemRegistryReader({
    [INSTALLER_KEY]: { install_dir: INSTALL_DIR },
    [WINDOWS_KEY]: { CurrentBuildNumber: '26300' },
  });
}

interface ProbeOverrides {
  readonly snapshot?: RegistrySnapshot;
  readonly files?: FakeEnvironmentFileSystem;
  readonly systemRegistry?: FakeSystemRegistryReader;
  readonly service?: FakeServiceController;
  readonly process?: FakeProcessController;
  readonly systemVersion?: string;
  readonly architecture?: string;
}

function makeProbe(overrides: ProbeOverrides = {}) {
  const registry = new FakeRegistryGateway({
    snapshot: overrides.snapshot ?? DEFAULT_SNAPSHOT,
  });
  const systemRegistry = overrides.systemRegistry ?? defaultSystemRegistry();
  const service =
    overrides.service ??
    new FakeServiceController({
      state: 'running',
      imagePath: join(INSTALL_DIR, 'windhawk.exe'),
    });
  const processController =
    overrides.process ??
    new FakeProcessController({
      rainmeter: { installed: true, running: true, path: RAINMETER_PATH },
    });
  const files = overrides.files ?? defaultFiles();
  const probe = new WindowsEnvironmentProbe({
    registry,
    systemRegistry,
    service,
    process: processController,
    files,
    programFiles: 'C:\\Program Files',
    systemVersion: () => overrides.systemVersion ?? '10.0.26300.9711',
    architecture: overrides.architecture ?? 'x64',
    now: () => new Date(PROBED_AT),
  });

  return { probe, registry, systemRegistry, service, processController, files };
}

describe('WindowsEnvironmentProbe', () => {
  it('reports the installed registry-mode environment and its mods', async () => {
    const { probe } = makeProbe();
    const environment = await probe.probe();

    expect(environment.probedAt).toBe(PROBED_AT);
    expect(environment.windows).toEqual({
      version: '10.0.26300.9711',
      build: '26300',
      supported: true,
    });
    expect(environment.windhawk).toEqual({
      installed: true,
      installDir: INSTALL_DIR,
      iniPath: join(INSTALL_DIR, 'windhawk.ini'),
      version: '1.7.3',
      engineVersion: '1.7.3',
      storageMode: 'registry',
      portable: false,
      registryRoot: 'HKLM\\SOFTWARE\\Windhawk',
    });
    expect(environment.service).toEqual({ name: 'Windhawk', state: 'running' });
    expect(environment.mods).toEqual([
      {
        modId: 'alpha',
        libraryFileName: 'alpha.dll',
        version: '1.2.0',
        enabled: true,
        settingsCount: 2,
        perUserConfig: false,
      },
      {
        modId: 'beta',
        libraryFileName: 'beta.dll',
        version: null,
        enabled: false,
        settingsCount: 0,
        perUserConfig: false,
      },
    ]);
    expect(environment.rainmeter).toEqual({
      installed: true,
      running: true,
      path: RAINMETER_PATH,
    });
    expect(environment.perUserConfig).toEqual({ present: false, active: false, sid: null });
    expect(environment.compatibility).toEqual({
      mode: 'writable',
      canApply: true,
      issues: [],
    });
  });

  it('reports missing Windhawk as unsupported and does not read mods', async () => {
    const { probe, registry } = makeProbe({
      files: new FakeEnvironmentFileSystem(),
      systemRegistry: new FakeSystemRegistryReader(),
      service: new FakeServiceController({ state: 'missing', imagePath: null }),
      process: new FakeProcessController(),
      snapshot: DEFAULT_SNAPSHOT,
    });

    const environment = await probe.probe();

    expect(environment.windhawk.installed).toBe(false);
    expect(environment.windhawk.installDir).toBeNull();
    expect(environment.windhawk.iniPath).toBeNull();
    expect(environment.windhawk.storageMode).toBe('unknown');
    expect(environment.windhawk.registryRoot).toBeNull();
    expect(environment.service).toEqual({ name: 'Windhawk', state: 'missing' });
    expect(environment.mods).toEqual([]);
    expect(environment.rainmeter.installed).toBe(false);
    expect(environment.compatibility.mode).toBe('unsupported');
    expect(environment.compatibility.canApply).toBe(false);
    expect(environment.compatibility.issues.map((issue) => issue.code)).toEqual([
      'windhawk-missing',
    ]);
    expect(registry.readCalls).toBe(0);
  });

  it('keeps apply available while the service is stopped', async () => {
    const { probe } = makeProbe({
      service: new FakeServiceController({
        state: 'stopped',
        imagePath: join(INSTALL_DIR, 'windhawk.exe'),
      }),
    });

    const environment = await probe.probe();

    expect(environment.service.state).toBe('stopped');
    expect(environment.compatibility.mode).toBe('writable');
    expect(environment.compatibility.canApply).toBe(true);
    expect(environment.compatibility.issues).toEqual([]);
  });

  it('reports missing Rainmeter without blocking apply', async () => {
    const { probe } = makeProbe({ process: new FakeProcessController() });

    const environment = await probe.probe();

    expect(environment.rainmeter).toEqual({ installed: false, running: false, path: null });
    expect(environment.compatibility.canApply).toBe(true);
  });

  it('blocks apply on an unsupported Windows build', async () => {
    const systemRegistry = new FakeSystemRegistryReader({
      [INSTALLER_KEY]: { install_dir: INSTALL_DIR },
      [WINDOWS_KEY]: { CurrentBuildNumber: '19045' },
    });
    const { probe } = makeProbe({
      systemRegistry,
      systemVersion: '10.0.19045.4291',
    });

    const environment = await probe.probe();

    expect(environment.windows).toEqual({
      version: '10.0.19045.4291',
      build: '19045',
      supported: false,
    });
    expect(environment.compatibility.mode).toBe('unsupported');
    expect(environment.compatibility.canApply).toBe(false);
    expect(environment.compatibility.issues.map((issue) => issue.code)).toContain(
      'windows-version',
    );
  });

  it('reports portable Windhawk as read-only and skips registry mods', async () => {
    const files = new FakeEnvironmentFileSystem({
      files: {
        [join(INSTALL_DIR, 'windhawk.exe')]: '',
        [join(INSTALL_DIR, 'windhawk.ini')]: readFixture('windhawk/portable.ini'),
      },
      directories: {
        [join(INSTALL_DIR, 'Engine')]: ['1.7.3'],
      },
    });
    const { probe, registry } = makeProbe({ files });

    const environment = await probe.probe();

    expect(environment.windhawk.storageMode).toBe('portable');
    expect(environment.windhawk.portable).toBe(true);
    expect(environment.windhawk.registryRoot).toBeNull();
    expect(environment.mods).toEqual([]);
    expect(environment.compatibility.mode).toBe('read-only');
    expect(environment.compatibility.canApply).toBe(false);
    expect(environment.compatibility.issues.map((issue) => issue.code)).toEqual(['portable']);
    expect(registry.readCalls).toBe(0);
  });

  it('reports a non-default registry root as read-only', async () => {
    const ini = readFixture('windhawk/portable.ini').replace('Portable=1', 'Portable=0');
    const files = new FakeEnvironmentFileSystem({
      files: {
        [join(INSTALL_DIR, 'windhawk.exe')]: '',
        [join(INSTALL_DIR, 'windhawk.ini')]: ini,
      },
      directories: {
        [join(INSTALL_DIR, 'Engine')]: ['1.7.3'],
      },
    });
    const { probe, registry } = makeProbe({ files });

    const environment = await probe.probe();

    expect(environment.windhawk.storageMode).toBe('registry');
    expect(environment.windhawk.registryRoot).toBe('HKCU\\SOFTWARE\\Windhawk');
    expect(environment.mods).toEqual([]);
    expect(environment.compatibility.mode).toBe('read-only');
    expect(environment.compatibility.issues.map((issue) => issue.code)).toEqual(['non-hklm-root']);
    expect(registry.readCalls).toBe(0);
  });

  it('blocks apply when a per-user configuration is active', async () => {
    const sid = 'S-1-5-21-1000-2000-3000-1001';
    const snapshot = makeSnapshot([
      ...modKeys('alpha', {
        version: '1.2.0',
        settings: { Theme: stringValue('macOS') },
      }),
      {
        path: `${modRootPath('alpha')}\\Users\\${sid}`,
        values: [
          { name: 'Disabled', value: dword(1) },
          { name: 'UserScoped', value: dword(1) },
        ],
      },
      ...modKeys('beta', { libraryFileName: 'beta.dll' }),
    ]);
    const { probe } = makeProbe({ snapshot });

    const environment = await probe.probe();

    expect(environment.perUserConfig).toEqual({ present: true, active: true, sid });
    expect(environment.mods.map((mod) => mod.perUserConfig)).toEqual([true, false]);
    expect(environment.compatibility.mode).toBe('read-only');
    expect(environment.compatibility.canApply).toBe(false);
    expect(environment.compatibility.issues.map((issue) => issue.code)).toEqual(['user-scoped']);
  });

  it('does not block apply when a per-user configuration is present but inactive', async () => {
    const sid = 'S-1-5-21-1000-2000-3000-1001';
    const snapshot = makeSnapshot([
      ...modKeys('alpha', { libraryFileName: 'alpha.dll' }),
      {
        path: `${modRootPath('alpha')}\\Users\\${sid}`,
        values: [
          { name: 'Disabled', value: dword(0) },
          { name: 'UserScoped', value: dword(0) },
        ],
      },
    ]);
    const { probe } = makeProbe({ snapshot });

    const environment = await probe.probe();

    expect(environment.perUserConfig).toEqual({ present: true, active: false, sid });
    expect(environment.compatibility.mode).toBe('writable');
    expect(environment.compatibility.canApply).toBe(true);
  });

  it('uses the service image path when installer metadata is absent', async () => {
    const files = defaultFiles();
    const { probe } = makeProbe({
      files,
      systemRegistry: new FakeSystemRegistryReader({
        [WINDOWS_KEY]: { CurrentBuildNumber: '26300' },
      }),
      service: new FakeServiceController({
        state: 'running',
        imagePath: join(INSTALL_DIR, 'windhawk.exe'),
      }),
    });

    const environment = await probe.probe();

    expect(environment.windhawk.installed).toBe(true);
    expect(environment.windhawk.installDir).toBe(INSTALL_DIR);
  });

  it('falls back to Program Files when installer metadata and the service path are absent', async () => {
    const files = defaultFiles();
    const { probe } = makeProbe({
      files,
      systemRegistry: new FakeSystemRegistryReader({
        [WINDOWS_KEY]: { CurrentBuildNumber: '26300' },
      }),
      service: new FakeServiceController({ state: 'missing', imagePath: null }),
    });

    const environment = await probe.probe();

    expect(environment.windhawk.installed).toBe(true);
    expect(environment.windhawk.installDir).toBe(INSTALL_DIR);
  });

  it('discovers the engine version from the Engine folder when windhawk.ini is silent', async () => {
    const ini = readFixture('windhawk/registry.ini').replace('EnginePath=Engine\\1.7.3\r\n', '');
    const files = new FakeEnvironmentFileSystem({
      files: {
        [join(INSTALL_DIR, 'windhawk.exe')]: '',
        [join(INSTALL_DIR, 'windhawk.ini')]: ini,
      },
      directories: {
        [join(INSTALL_DIR, 'Engine')]: ['1.6.9', '1.7.3', 'not-a-version'],
      },
    });
    const { probe } = makeProbe({ files });

    const environment = await probe.probe();

    expect(environment.windhawk.engineVersion).toBe('1.7.3');
    expect(environment.windhawk.version).toBe('1.7.3');
  });

  it('reports a registry read failure as read-only', async () => {
    const { probe, registry } = makeProbe();
    registry.failRead = new Error('Access is denied.');

    const environment = await probe.probe();

    expect(environment.mods).toEqual([]);
    expect(environment.compatibility.mode).toBe('read-only');
    expect(environment.compatibility.canApply).toBe(false);
    expect(environment.compatibility.issues.map((issue) => issue.code)).toEqual(['other']);
    expect(environment.compatibility.issues[0]?.message).toContain('Access is denied.');
  });
});

describe('FakeEnvironmentProbe', () => {
  it('returns an isolated copy of the configured environment', async () => {
    const environment = parseEnvironment({
      schemaVersion: 1,
      probedAt: PROBED_AT,
      windows: { version: '10.0.26300.9711', build: '26300', supported: true },
      windhawk: {
        installed: false,
        installDir: null,
        iniPath: null,
        version: null,
        engineVersion: null,
        storageMode: 'unknown',
        portable: false,
        registryRoot: null,
      },
      service: { name: 'Windhawk', state: 'missing' },
      mods: [],
      rainmeter: { installed: false, running: false, path: null },
      perUserConfig: { present: false, active: false, sid: null },
      compatibility: { mode: 'unsupported', canApply: false, issues: [] },
    });
    const fake = new FakeEnvironmentProbe(environment);

    const first = await fake.probe();
    first.mods.push({
      modId: 'alpha',
      libraryFileName: 'alpha.dll',
      version: null,
      enabled: true,
      settingsCount: 0,
      perUserConfig: false,
    });

    await expect(fake.probe()).resolves.toEqual(environment);
    expect(fake.probeCalls).toBe(2);
  });

  it('can simulate a probe failure', async () => {
    const fake = new FakeEnvironmentProbe(
      parseEnvironment({
        schemaVersion: 1,
        probedAt: PROBED_AT,
        windows: { version: '10.0.26300.9711', build: '26300', supported: true },
        windhawk: {
          installed: false,
          installDir: null,
          iniPath: null,
          version: null,
          engineVersion: null,
          storageMode: 'unknown',
          portable: false,
          registryRoot: null,
        },
        service: { name: 'Windhawk', state: 'missing' },
        mods: [],
        rainmeter: { installed: false, running: false, path: null },
        perUserConfig: { present: false, active: false, sid: null },
        compatibility: { mode: 'unsupported', canApply: false, issues: [] },
      }),
    );
    fake.failWith = new Error('Probe failed.');

    await expect(fake.probe()).rejects.toThrow('Probe failed.');
  });
});
