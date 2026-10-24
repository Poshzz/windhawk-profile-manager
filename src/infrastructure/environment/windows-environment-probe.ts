import { dirname, join } from 'node:path';
import { release } from 'node:os';
import type { EnvironmentFileSystem } from '@core/environment/environment-file-system';
import type { EnvironmentProbe } from '@core/environment/environment-probe';
import type { SystemRegistryReader } from '@core/environment/system-registry-reader';
import {
  engineVersionFromPath,
  parseWindhawkIni,
  pickHighestVersion,
  type WindhawkIni,
} from '@core/environment/windhawk-ini';
import { readInstalledMods } from '@core/planner/registry-state';
import type { ProcessController } from '@core/process/process-controller';
import type { RegistryGateway } from '@core/registry/registry-gateway';
import type { ServiceController } from '@core/services/service-controller';
import {
  REGISTRY_MODS_ROOT,
  isAbsoluteWindowsPath,
  parseEnvironment,
  type CompatibilityIssue,
  type Environment,
  type InstalledMod,
  type PerUserConfig,
  type RegistrySnapshot,
  type ServiceInfo,
} from '@shared/domain';

export interface WindowsEnvironmentProbeOptions {
  readonly registry: RegistryGateway;
  readonly systemRegistry: SystemRegistryReader;
  readonly service: ServiceController;
  readonly process: ProcessController;
  readonly files: EnvironmentFileSystem;
  readonly programFiles?: string;
  readonly systemVersion?: () => string;
  readonly architecture?: string;
  readonly now?: () => Date;
}

interface IniResult {
  readonly path: string;
  readonly values: WindhawkIni;
}

interface SnapshotReadResult {
  readonly snapshot: RegistrySnapshot | null;
  readonly error: string | null;
}

const INSTALLER_KEY = 'HKLM\\SOFTWARE\\WOW6432Node\\Windhawk';
const WINDOWS_BUILD_KEY = 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion';
const DEFAULT_REGISTRY_ROOT = 'HKLM\\SOFTWARE\\Windhawk';
const SUPPORTED_BUILD = 22_000;
const SUPPORTED_ARCHITECTURES = new Set(['x64']);

function normalizeRegistryRoot(value: string): string {
  return value.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

function isDefaultRegistryRoot(value: string): boolean {
  return normalizeRegistryRoot(value) === normalizeRegistryRoot(DEFAULT_REGISTRY_ROOT);
}

function buildNumberFromVersion(version: string): string {
  return /^\d+\.\d+\.(\d+)/.exec(version)?.[1] ?? '0';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultSystemVersion(): string {
  const getter = (process as NodeJS.Process & { readonly getSystemVersion?: () => string })
    .getSystemVersion;
  if (typeof getter === 'function') return getter();
  return release();
}

export function snapshotMods(snapshot: RegistrySnapshot): InstalledMod[] {
  return [...readInstalledMods(snapshot).values()]
    .filter(
      (state) =>
        state.libraryFileName.length <= 260 && /^[^\\/:*?"<>|]+$/.test(state.libraryFileName),
    )
    .map((state) => ({
      modId: state.modId,
      libraryFileName: state.libraryFileName,
      version: state.version,
      enabled: state.enabled,
      settingsCount: Math.min(state.settingsCount, 1_000_000),
      perUserConfig: state.perUserConfig,
    }))
    .sort((left, right) => left.modId.localeCompare(right.modId));
}

export function detectPerUserConfig(snapshot: RegistrySnapshot): PerUserConfig {
  const prefix = `${REGISTRY_MODS_ROOT}\\`.toLowerCase();
  let present = false;
  let activeFlag = false;
  let sid: string | null = null;

  for (const key of snapshot.keys) {
    const lower = key.path.toLowerCase();
    if (!lower.startsWith(prefix)) continue;

    const usersMarker = '\\users\\';
    const markerIndex = lower.indexOf(usersMarker);
    const isUsersKey = lower.endsWith('\\users');

    if (markerIndex !== -1 || isUsersKey) {
      present = true;
      if (markerIndex !== -1) {
        const candidate = key.path.slice(markerIndex + usersMarker.length).split('\\')[0] ?? '';
        if (sid === null && /^S-\d+-\d+(?:-\d+)*$/i.test(candidate)) sid = candidate;
      }
    }

    const userScoped = key.values.find((value) => value.name.toLowerCase() === 'userscoped');
    if (userScoped?.value.type === 'dword' && userScoped.value.value !== 0) {
      activeFlag = true;
    }
  }

  return { present, active: present && activeFlag, sid };
}

export class WindowsEnvironmentProbe implements EnvironmentProbe {
  private readonly registry: RegistryGateway;
  private readonly systemRegistry: SystemRegistryReader;
  private readonly service: ServiceController;
  private readonly process: ProcessController;
  private readonly files: EnvironmentFileSystem;
  private readonly programFiles: string;
  private readonly systemVersion: () => string;
  private readonly architecture: string;
  private readonly now: () => Date;

  constructor(options: WindowsEnvironmentProbeOptions) {
    this.registry = options.registry;
    this.systemRegistry = options.systemRegistry;
    this.service = options.service;
    this.process = options.process;
    this.files = options.files;
    this.programFiles = options.programFiles ?? process.env.ProgramFiles ?? 'C:\\Program Files';
    this.systemVersion = options.systemVersion ?? defaultSystemVersion;
    this.architecture = options.architecture ?? process.arch;
    this.now = options.now ?? (() => new Date());
  }

  async probe(): Promise<Environment> {
    const probedAt = this.now().toISOString();
    const systemVersion = this.systemVersion().trim() || 'unknown';
    const [registryBuild, executablePath, service, rainmeter] = await Promise.all([
      this.systemRegistry.readString(WINDOWS_BUILD_KEY, 'CurrentBuildNumber'),
      this.resolveExecutablePath(),
      this.readService(),
      this.readRainmeter(),
    ]);
    const build =
      registryBuild !== null && /^\d{1,10}$/.test(registryBuild.trim())
        ? registryBuild.trim()
        : buildNumberFromVersion(systemVersion);
    const windowsSupported = Number(build) >= SUPPORTED_BUILD;
    const architectureSupported = SUPPORTED_ARCHITECTURES.has(this.architecture.toLowerCase());

    const installed = executablePath !== null;
    const installDir = executablePath === null ? null : dirname(executablePath);
    const ini = installDir === null ? null : await this.readIni(installDir);
    const portable = installed && (ini?.values.portable ?? false);
    const registryRoot =
      !installed || portable ? null : (ini?.values.registryKey ?? DEFAULT_REGISTRY_ROOT);
    const storageMode = !installed ? 'unknown' : portable ? 'portable' : 'registry';
    const [engineVersion, snapshotResult] = await Promise.all([
      installDir === null ? Promise.resolve(null) : this.resolveEngineVersion(installDir, ini),
      this.readSnapshot({ installed, portable, registryRoot }),
    ]);
    const snapshot = snapshotResult.snapshot;
    const mods = snapshot === null ? [] : snapshotMods(snapshot);
    const perUserConfig =
      snapshot === null
        ? { present: false, active: false, sid: null }
        : detectPerUserConfig(snapshot);

    const issues: CompatibilityIssue[] = [];
    if (!windowsSupported) {
      issues.push({
        code: 'windows-version',
        message: `Windows build ${build} is unsupported; Windows 11 build ${SUPPORTED_BUILD} or newer is required.`,
      });
    }
    if (!architectureSupported) {
      issues.push({
        code: 'unsupported-architecture',
        message: `Windhawk Profile Manager v1 requires x64 Windows; ${this.architecture} is not supported.`,
      });
    }
    if (!installed) {
      issues.push({
        code: 'windhawk-missing',
        message: 'Windhawk was not found. Install Windhawk, then refresh.',
      });
    } else if (portable) {
      issues.push({
        code: 'portable',
        message:
          'Windhawk is running in portable mode. Registry profiles are read-only; switch to the installed version of Windhawk.',
      });
    } else if (registryRoot !== null && !isDefaultRegistryRoot(registryRoot)) {
      issues.push({
        code: 'non-hklm-root',
        message: `Windhawk uses ${registryRoot} instead of ${DEFAULT_REGISTRY_ROOT}; v1 can only write to the default root.`,
      });
    }
    if (perUserConfig.active) {
      issues.push({
        code: 'user-scoped',
        message: `A per-user Windhawk configuration is active${perUserConfig.sid === null ? '' : ` (${perUserConfig.sid})`}; global apply is blocked.`,
      });
    }
    if (snapshotResult.error !== null) {
      issues.push({
        code: 'other',
        message: `Could not read Windhawk mod configuration: ${snapshotResult.error}`,
      });
    }

    const unsupported = !windowsSupported || !architectureSupported || !installed;
    const mode: Environment['compatibility']['mode'] = unsupported
      ? 'unsupported'
      : issues.length > 0
        ? 'read-only'
        : 'writable';

    return parseEnvironment({
      schemaVersion: 1,
      probedAt,
      windows: {
        version: systemVersion,
        build,
        supported: windowsSupported,
      },
      windhawk: {
        installed,
        installDir,
        iniPath: ini?.path ?? null,
        version: engineVersion,
        engineVersion,
        storageMode,
        portable,
        registryRoot,
      },
      service,
      mods,
      rainmeter,
      perUserConfig,
      compatibility: {
        mode,
        canApply: issues.length === 0,
        issues,
      },
    });
  }

  private async resolveExecutablePath(): Promise<string | null> {
    const candidates: string[] = [];
    const installerPath = await this.systemRegistry.readString(INSTALLER_KEY, 'install_dir');
    if (installerPath !== null) candidates.push(join(installerPath, 'windhawk.exe'));

    try {
      const imagePath = await this.service.imagePath();
      if (imagePath !== null) candidates.push(imagePath);
    } catch {
      // Fall through to the default install directory.
    }

    candidates.push(join(this.programFiles, 'Windhawk', 'windhawk.exe'));

    for (const candidate of candidates) {
      if (!isAbsoluteWindowsPath(candidate)) continue;
      if (await this.files.fileExists(candidate)) return candidate;
    }
    return null;
  }

  private async readIni(installDir: string): Promise<IniResult | null> {
    const path = join(installDir, 'windhawk.ini');
    try {
      const text = await this.files.readTextFile(path);
      return text === null ? null : { path, values: parseWindhawkIni(text) };
    } catch {
      return null;
    }
  }

  private async resolveEngineVersion(
    installDir: string,
    ini: IniResult | null,
  ): Promise<string | null> {
    const configured = engineVersionFromPath(ini?.values.enginePath ?? null);
    if (configured !== null) return configured;

    try {
      const entries = await this.files.readDirectory(join(installDir, 'Engine'));
      return entries === null ? null : pickHighestVersion(entries);
    } catch {
      return null;
    }
  }

  private async readService(): Promise<ServiceInfo> {
    try {
      return await this.service.status();
    } catch {
      return { name: this.service.name, state: 'unknown' };
    }
  }

  private async readRainmeter(): Promise<Environment['rainmeter']> {
    try {
      return await this.process.rainmeterStatus();
    } catch {
      return { installed: false, running: false, path: null };
    }
  }

  private async readSnapshot(input: {
    readonly installed: boolean;
    readonly portable: boolean;
    readonly registryRoot: string | null;
  }): Promise<SnapshotReadResult> {
    if (
      !input.installed ||
      input.portable ||
      input.registryRoot === null ||
      !isDefaultRegistryRoot(input.registryRoot)
    ) {
      return { snapshot: null, error: null };
    }

    try {
      return { snapshot: await this.registry.read(), error: null };
    } catch (error) {
      return { snapshot: null, error: errorMessage(error) };
    }
  }
}
