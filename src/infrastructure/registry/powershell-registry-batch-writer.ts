import { join } from 'node:path';
import type { CommandRunner } from '@core/process/command-runner';
import { resolveSystemRoot, system32Path } from '@infra/elevation/system-paths';
import type { RegistryValue } from '@shared/domain';
import { ApplyError, EnvironmentError, ValidationError } from '@shared/errors';

const MISSING_KEY_MARKER = 'WPM_MISSING_KEY=';

const REGISTRY_HIVE_NAMES =
  /^(HKLM|HKCU|HKCR|HKU|HKCC|HKEY_LOCAL_MACHINE|HKEY_CURRENT_USER|HKEY_CLASSES_ROOT|HKEY_USERS|HKEY_CURRENT_CONFIG)$/i;

/**
 * Runs inside Windows PowerShell. Values and names travel in the JSON payload
 * on stdin; this script is constant so no registry data is ever interpolated
 * into a command line, and it never writes a file.
 *
 * Every target key is opened (and, for Settings, created only after its mod
 * key opened) before the first mutation. A missing mod key throws the marker
 * that the TypeScript side maps to an ApplyError; any other failure exits 3.
 */
const POWERSHELL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$deadlineUtc = [DateTime]::UtcNow.AddSeconds(120)

$baseKeys = @{}
$keyCache = @{}
$pendingSettings = New-Object System.Collections.Generic.List[object]

function Stop-MissingKey([string]$displayPath) {
  throw ('WPM_MISSING_KEY=' + $displayPath)
}

function Get-Hive([string]$name) {
  switch ($name.ToUpperInvariant()) {
    'HKLM' { return [Microsoft.Win32.RegistryHive]::LocalMachine }
    'HKEY_LOCAL_MACHINE' { return [Microsoft.Win32.RegistryHive]::LocalMachine }
    'HKCU' { return [Microsoft.Win32.RegistryHive]::CurrentUser }
    'HKEY_CURRENT_USER' { return [Microsoft.Win32.RegistryHive]::CurrentUser }
    'HKCR' { return [Microsoft.Win32.RegistryHive]::ClassesRoot }
    'HKEY_CLASSES_ROOT' { return [Microsoft.Win32.RegistryHive]::ClassesRoot }
    'HKU' { return [Microsoft.Win32.RegistryHive]::Users }
    'HKEY_USERS' { return [Microsoft.Win32.RegistryHive]::Users }
    'HKCC' { return [Microsoft.Win32.RegistryHive]::CurrentConfig }
    'HKEY_CURRENT_CONFIG' { return [Microsoft.Win32.RegistryHive]::CurrentConfig }
  }
  throw ('Unsupported registry hive: ' + $name)
}

function Get-BaseKey([string]$hiveName) {
  $cacheKey = $hiveName.ToUpperInvariant()
  if ($script:baseKeys.ContainsKey($cacheKey)) { return $script:baseKeys[$cacheKey] }
  $baseKey = [Microsoft.Win32.RegistryKey]::OpenBaseKey((Get-Hive $hiveName), [Microsoft.Win32.RegistryView]::Registry64)
  $script:baseKeys[$cacheKey] = $baseKey
  return $baseKey
}

function Get-ExistingKey([string]$hiveName, [string]$subkey, [string]$displayPath, [bool]$requiredForSet) {
  $baseKey = Get-BaseKey $hiveName
  $key = $baseKey.OpenSubKey($subkey, $true)
  if ($null -eq $key) {
    if ($requiredForSet) { Stop-MissingKey $displayPath }
    throw ('The registry key is missing: ' + $displayPath)
  }
  return $key
}

try {
  $raw = [Console]::In.ReadToEnd()
  if ([string]::IsNullOrWhiteSpace($raw)) { throw 'The registry batch payload is empty.' }
  $payload = ConvertFrom-Json $raw
  if ($null -eq $payload -or $null -eq $payload.operations) {
    throw 'The registry batch payload has no operations.'
  }
  $operations = @($payload.operations)
  $setPaths = @{}
  foreach ($operation in $operations) {
    if ($operation.kind -eq 'set') { $setPaths[[string]$operation.path] = $true }
  }

  foreach ($operation in $operations) {
    $path = [string]$operation.path
    $separator = $path.IndexOf('\')
    if ($separator -lt 1 -or $separator -eq ($path.Length - 1)) {
      throw ('Invalid registry path: ' + $path)
    }
    if ($keyCache.ContainsKey($path)) { continue }

    $isSetPath = $setPaths.ContainsKey($path)
    $hiveName = $path.Substring(0, $separator)
    $subkey = $path.Substring($separator + 1)
    if ($subkey -match '\\Settings$') {
      $parentPath = $path.Substring(0, $path.Length - 9)
      $parentSubkey = $subkey.Substring(0, $subkey.Length - 9)
      $parentKey = Get-ExistingKey $hiveName $parentSubkey $parentPath $isSetPath
      $settingsKey = $parentKey.OpenSubKey('Settings', $true)
      if ($null -eq $settingsKey) {
        if (-not $isSetPath) { throw ('The registry key is missing: ' + $path) }
        $pendingSettings.Add([pscustomobject]@{ Path = $path; Parent = $parentKey })
      } else {
        $keyCache[$path] = $settingsKey
      }
    } else {
      $keyCache[$path] = Get-ExistingKey $hiveName $subkey $path $isSetPath
    }
  }

  foreach ($pending in $pendingSettings) {
    $keyCache[$pending.Path] = $pending.Parent.CreateSubKey('Settings', $true)
  }

  foreach ($operation in $operations) {
    $key = $keyCache[[string]$operation.path]
    if ($null -eq $key) { throw ('The registry key was not opened: ' + [string]$operation.path) }
    $name = [string]$operation.name

    if ($operation.kind -eq 'deleteValue') {
      $key.DeleteValue($name, $true) | Out-Null
      continue
    }
    if ($operation.kind -ne 'set') {
      throw ('Unsupported registry operation: ' + [string]$operation.kind)
    }

    switch ([string]$operation.type) {
      'dword' {
        $unsigned = [uint32]$operation.value
        $value = [System.BitConverter]::ToInt32([System.BitConverter]::GetBytes($unsigned), 0)
        $key.SetValue($name, $value, [Microsoft.Win32.RegistryValueKind]::DWord)
        break
      }
      'qword' {
        $unsigned = [uint64]::Parse([string]$operation.value, [System.Globalization.CultureInfo]::InvariantCulture)
        $value = [System.BitConverter]::ToInt64([System.BitConverter]::GetBytes($unsigned), 0)
        $key.SetValue($name, $value, [Microsoft.Win32.RegistryValueKind]::QWord)
        break
      }
      'string' {
        $key.SetValue($name, [string]$operation.value, [Microsoft.Win32.RegistryValueKind]::String)
        break
      }
      'expandString' {
        $key.SetValue($name, [string]$operation.value, [Microsoft.Win32.RegistryValueKind]::ExpandString)
        break
      }
      'binary' {
        $hex = [string]$operation.value
        if (($hex.Length % 2) -ne 0) { throw 'A binary registry value has an odd number of hex digits.' }
        $bytes = [System.Runtime.Remoting.Metadata.W3cXsd2001.SoapHexBinary]::Parse($hex).Value
        $key.SetValue($name, $bytes, [Microsoft.Win32.RegistryValueKind]::Binary)
        break
      }
      default { throw ('Unsupported registry value type: ' + [string]$operation.type) }
    }
    if ([DateTime]::UtcNow -gt $deadlineUtc) {
      throw 'WPM_BATCH_DEADLINE'
    }
  }

  exit 0
}
catch {
  $message = [string]$_.Exception.Message
  if ($message.StartsWith('WPM_MISSING_KEY=')) {
    [Console]::Error.WriteLine($message)
    exit 2
  }
  [Console]::Error.WriteLine('WPM_REGISTRY_FAILURE=' + $message)
  exit 3
}
`;

export interface RegistryBatchSet {
  readonly kind: 'set';
  readonly path: string;
  readonly name: string;
  readonly value: RegistryValue;
}

export interface RegistryBatchDelete {
  readonly kind: 'deleteValue';
  readonly path: string;
  readonly name: string;
}

export type RegistryBatchOperation = RegistryBatchSet | RegistryBatchDelete;

// Last-resort bound only. The script exits itself after 120 s between mutating
// operations; this avoids an unbounded hung child while preserving the normal
// in-flight write completion contract.
const WRITE_TIMEOUT_MS = 300_000;

const ROOT_PROBE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
try {
  $root = $env:WPM_REGISTRY_ROOT
  if ([string]::IsNullOrEmpty($root) -or -not $root.StartsWith('HKLM\')) { exit 2 }
  $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey(
    [Microsoft.Win32.RegistryHive]::LocalMachine,
    [Microsoft.Win32.RegistryView]::Registry64
  )
  $key = $base.OpenSubKey($root.Substring(5), $false)
  if ($null -eq $key) { exit 1 }
  exit 0
} catch {
  exit 2
}
`;

export interface PowerShellRegistryBatchWriterOptions {
  readonly commandRunner: CommandRunner;
  /** Test seam. Production resolves powershell.exe from the trusted system root. */
  readonly powershellExe?: string;
}

interface PayloadOperationSet {
  readonly kind: 'set';
  readonly path: string;
  readonly name: string;
  readonly type: string;
  readonly value: string | number;
}

interface PayloadOperationDelete {
  readonly kind: 'deleteValue';
  readonly path: string;
  readonly name: string;
}

type PayloadOperation = PayloadOperationSet | PayloadOperationDelete;

function assertBatchPath(path: string): void {
  if (path.includes('\0') || path.includes('\r') || path.includes('\n')) {
    throw new ValidationError('A registry batch path cannot contain NUL or newlines.');
  }
  if (path.includes('/')) {
    throw new ValidationError('A registry batch path cannot contain forward slashes.');
  }

  const separator = path.indexOf('\\');
  if (separator <= 0 || separator === path.length - 1) {
    throw new ValidationError('A registry batch path must be an absolute hive path.');
  }
  if (!REGISTRY_HIVE_NAMES.test(path.slice(0, separator))) {
    throw new ValidationError('A registry batch path must start with a supported registry hive.');
  }
  const segments = path.slice(separator + 1).split('\\');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new ValidationError('A registry batch path cannot contain empty or relative segments.');
  }
}

function payloadForValue(value: RegistryValue): Pick<PayloadOperationSet, 'type' | 'value'> {
  switch (value.type) {
    case 'dword':
      return { type: 'dword', value: value.value };
    case 'qword':
      return { type: 'qword', value: value.value };
    case 'string':
      return { type: 'string', value: value.value };
    case 'expandString':
      return { type: 'expandString', value: value.value };
    case 'binary':
      return { type: 'binary', value: value.value };
    case 'multiString':
      throw new ValidationError(
        'Writing REG_MULTI_SZ is not supported by the registry gateway; Windhawk settings use REG_SZ and REG_DWORD.',
      );
    case 'none':
      throw new ValidationError('Writing REG_NONE is not supported by the registry gateway.');
  }
}

function payloadFor(operation: RegistryBatchOperation): PayloadOperation {
  assertBatchPath(operation.path);
  if (operation.kind === 'deleteValue') {
    return {
      kind: 'deleteValue',
      path: operation.path,
      name: operation.name,
    };
  }
  return {
    kind: 'set',
    path: operation.path,
    name: operation.name,
    ...payloadForValue(operation.value),
  };
}

/**
 * Writes a batch of validated registry mutations with one PowerShell process.
 * Path authorization stays with the caller (the gateway's allowlists); this
 * class guarantees only safe path shape, typed values, and a guarded Settings
 * creation. It never deletes keys.
 */
export class PowerShellRegistryBatchWriter {
  private readonly commandRunner: CommandRunner;
  private readonly configuredPowershellExe: string | undefined;
  private resolvedPowershellExe: string | null = null;

  constructor(options: PowerShellRegistryBatchWriterOptions) {
    this.commandRunner = options.commandRunner;
    this.configuredPowershellExe = options.powershellExe;
  }

  async probeRoot(root: string): Promise<'present' | 'missing' | 'denied'> {
    if (!/^HKLM\\SOFTWARE\\Windhawk\\Engine\\Mods$/i.test(root)) {
      throw new ValidationError('The registry root probe only accepts the Windhawk mods root.');
    }
    const result = await this.commandRunner.run(
      this.powershellExe(),
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(ROOT_PROBE_SCRIPT, 'utf16le').toString('base64'),
      ],
      {
        timeoutMs: WRITE_TIMEOUT_MS,
        env: {
          SystemRoot: resolveSystemRoot(),
          WINDIR: resolveSystemRoot(),
          WPM_REGISTRY_ROOT: root,
        },
      },
    );
    if (result.exitCode === 0) return 'present';
    if (result.exitCode === 1) return 'missing';
    throw new EnvironmentError(
      `The Windhawk registry root could not be inspected (exit code ${result.exitCode}).`,
    );
  }

  async write(operations: readonly RegistryBatchOperation[]): Promise<void> {
    if (operations.length === 0) return;

    const payload = JSON.stringify({ operations: operations.map(payloadFor) });
    const result = await this.commandRunner.run(
      this.powershellExe(),
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(POWERSHELL_SCRIPT, 'utf16le').toString('base64'),
      ],
      {
        stdin: payload,
        timeoutMs: WRITE_TIMEOUT_MS,
        env: { SystemRoot: resolveSystemRoot(), WINDIR: resolveSystemRoot() },
      },
    );

    if (result.exitCode === 0) return;

    if (result.exitCode === 2) {
      const marker = result.stderr
        .split(/\r?\n/)
        .find((line) => line.startsWith(MISSING_KEY_MARKER));
      const missingKey = marker?.slice(MISSING_KEY_MARKER.length) ?? '<unknown>';
      throw new ApplyError(
        `The mod key "${missingKey}" is missing or inaccessible; refusing to create a key for a missing mod.`,
      );
    }

    throw new EnvironmentError(
      `The Windows registry command failed while trying to apply registry values (exit code ${result.exitCode}).`,
      {
        details: [
          {
            path: [],
            message: `PowerShell exited with code ${result.exitCode}.`,
          },
        ],
      },
    );
  }

  private powershellExe(): string {
    if (this.configuredPowershellExe !== undefined) return this.configuredPowershellExe;
    if (this.resolvedPowershellExe === null) {
      this.resolvedPowershellExe = join(
        system32Path('WindowsPowerShell'),
        'v1.0',
        'powershell.exe',
      );
    }
    return this.resolvedPowershellExe;
  }
}
