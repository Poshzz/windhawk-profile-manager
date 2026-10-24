import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { EnvironmentError } from '@shared/errors';
import { resolveSystemRoot } from './system-paths';

export interface ElevationLaunchRequest {
  readonly helperPath: string;
  readonly arguments: readonly string[];
  readonly workingDirectory: string;
}

export interface ElevationLaunchResult {
  readonly exitCode: number;
}

export interface ElevationLauncher {
  launch(request: ElevationLaunchRequest): Promise<ElevationLaunchResult>;
}

/**
 * CommandLineToArgvW-compatible quoting for the single lpParameters string that
 * ShellExecuteEx accepts. No shell is involved at any point.
 */
export function quoteWindowsArgument(argument: string): string {
  if (argument.length === 0) return '""';
  if (!/[\s"]/.test(argument)) return argument;

  let result = '"';
  let backslashes = 0;
  for (const character of argument) {
    if (character === '\\') {
      backslashes += 1;
      continue;
    }
    if (character === '"') {
      result += `${'\\'.repeat(backslashes * 2 + 1)}"`;
      backslashes = 0;
      continue;
    }
    result += `${'\\'.repeat(backslashes)}${character}`;
    backslashes = 0;
  }
  result += `${'\\'.repeat(backslashes * 2)}"`;
  return result;
}

export function buildHelperParameters(args: readonly string[]): string {
  return args.map(quoteWindowsArgument).join(' ');
}

const SHELL_EXECUTE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$helper = $env:WPM_HELPER
$parameters = $env:WPM_PARAMETERS
$workingDirectory = $env:WPM_CWD

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class WpmShellExecute
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct SHELLEXECUTEINFO
    {
        public int cbSize;
        public uint fMask;
        public IntPtr hwnd;
        [MarshalAs(UnmanagedType.LPWStr)] public string lpVerb;
        [MarshalAs(UnmanagedType.LPWStr)] public string lpFile;
        [MarshalAs(UnmanagedType.LPWStr)] public string lpParameters;
        [MarshalAs(UnmanagedType.LPWStr)] public string lpDirectory;
        public int nShow;
        public IntPtr hInstApp;
        public IntPtr lpIDList;
        [MarshalAs(UnmanagedType.LPWStr)] public string lpClass;
        public IntPtr hkeyClass;
        public uint dwHotKey;
        public IntPtr hIcon;
        public IntPtr hProcess;
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool ShellExecuteExW(ref SHELLEXECUTEINFO lpExecInfo);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr hObject);
}
'@

$info = New-Object 'WpmShellExecute+SHELLEXECUTEINFO'
$info.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type]'WpmShellExecute+SHELLEXECUTEINFO')
$info.fMask = 0x00000040
$info.hwnd = [IntPtr]::Zero
$info.lpVerb = 'runas'
$info.lpFile = $helper
$info.lpParameters = $parameters
$info.lpDirectory = $workingDirectory
$info.nShow = 0
$info.hProcess = [IntPtr]::Zero

if (-not [WpmShellExecute]::ShellExecuteExW([ref]$info)) {
    exit ([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())
}
if ($info.hProcess -eq [IntPtr]::Zero) {
    exit 1
}

try {
    [void][WpmShellExecute]::WaitForSingleObject($info.hProcess, [uint32]::MaxValue)
    [uint32]$exitCode = 0
    if (-not [WpmShellExecute]::GetExitCodeProcess($info.hProcess, [ref]$exitCode)) {
        exit 1
    }
    exit ([int]$exitCode)
}
finally {
    [void][WpmShellExecute]::CloseHandle($info.hProcess)
}
`;

export function buildPowerShellArguments(): string[] {
  const encoded = Buffer.from(SHELL_EXECUTE_SCRIPT, 'utf16le').toString('base64');
  return [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-WindowStyle',
    'Hidden',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    encoded,
  ];
}

export interface ShellExecuteExLauncherOptions {
  readonly powershellExe?: string;
  readonly systemRoot?: string;
}

/**
 * Node has no native ShellExecuteEx binding. A fixed PowerShell host calls
 * ShellExecuteExW with the runas verb and SEE_MASK_NOCLOSEPROCESS so UAC
 * cancellation (1223) and the helper's exit code propagate without Start-Process
 * or shell:true.
 */
export class ShellExecuteExLauncher implements ElevationLauncher {
  private readonly powershellExe: string;
  private readonly systemRoot: string;

  constructor(options: ShellExecuteExLauncherOptions = {}) {
    this.systemRoot = resolveSystemRoot(options.systemRoot);
    this.powershellExe =
      options.powershellExe ??
      join(this.systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  }

  launch(request: ElevationLaunchRequest): Promise<ElevationLaunchResult> {
    const parameters = buildHelperParameters(request.arguments);

    return new Promise((resolve, reject) => {
      const child = spawn(this.powershellExe, buildPowerShellArguments(), {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
        env: {
          ...process.env,
          SystemRoot: this.systemRoot,
          WINDIR: this.systemRoot,
          WPM_HELPER: request.helperPath,
          WPM_PARAMETERS: parameters,
          WPM_CWD: request.workingDirectory,
        },
      });

      let stderr = '';
      let settled = false;

      child.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length < 16_384) stderr += chunk.toString('utf8');
      });

      child.once('error', (error) => {
        if (settled) return;
        settled = true;
        reject(
          new EnvironmentError('The elevated helper could not be launched.', {
            cause: error,
          }),
        );
      });

      child.once('close', (code) => {
        if (settled) return;
        settled = true;
        if (code === null) {
          reject(
            new EnvironmentError(
              `The elevated helper launcher exited without a status.${stderr.length > 0 ? ` ${stderr}` : ''}`,
            ),
          );
          return;
        }
        resolve({ exitCode: code });
      });
    });
  }
}
