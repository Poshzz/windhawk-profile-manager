import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { EnvironmentError } from '@shared/errors';
import { resolveSystemRoot } from './system-paths';

const ACCESS_CHECK_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class WpmPathAccess
{
    private const int SeFileObject = 1;
    private const uint OwnerSecurityInformation = 0x00000001;
    private const uint GroupSecurityInformation = 0x00000002;
    private const uint DaclSecurityInformation = 0x00000004;
    private const uint TokenQuery = 0x00000008;
    private const uint TokenDuplicate = 0x00000002;
    private const uint MaximumAllowed = 0x02000000;
    private const uint FileWriteData = 0x00000002;

    [StructLayout(LayoutKind.Sequential)]
    private struct GenericMapping
    {
        public uint GenericRead;
        public uint GenericWrite;
        public uint GenericExecute;
        public uint GenericAll;
    }

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetNamedSecurityInfo(
        string objectName,
        int objectType,
        uint securityInfo,
        out IntPtr owner,
        out IntPtr group,
        out IntPtr dacl,
        out IntPtr sacl,
        out IntPtr securityDescriptor);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AccessCheck(
        IntPtr securityDescriptor,
        IntPtr clientToken,
        uint desiredAccess,
        ref GenericMapping genericMapping,
        IntPtr privilegeSet,
        ref uint privilegeSetLength,
        out uint grantedAccess,
        out int accessStatus);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool OpenProcessToken(
        IntPtr processHandle,
        uint desiredAccess,
        out IntPtr tokenHandle);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DuplicateTokenEx(
        IntPtr existingToken,
        uint desiredAccess,
        IntPtr tokenAttributes,
        int impersonationLevel,
        int tokenType,
        out IntPtr newToken);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr handle);

    public static bool CanWrite(string path)
    {
        IntPtr token = IntPtr.Zero;
        IntPtr impersonationToken = IntPtr.Zero;
        IntPtr descriptor = IntPtr.Zero;
        IntPtr privileges = IntPtr.Zero;
        try
        {
            if (!OpenProcessToken(GetCurrentProcess(), TokenQuery | TokenDuplicate, out token))
                throw new Win32Exception(Marshal.GetLastWin32Error());

            // AccessCheck requires an impersonation token. Duplicate the process
            // token so the check uses the same filtered token and group attributes.
            if (!DuplicateTokenEx(token, MaximumAllowed, IntPtr.Zero, 2, 2, out impersonationToken))
                throw new Win32Exception(Marshal.GetLastWin32Error());

            IntPtr owner;
            IntPtr group;
            IntPtr dacl;
            IntPtr sacl;
            uint error = GetNamedSecurityInfo(
                path,
                SeFileObject,
                OwnerSecurityInformation | GroupSecurityInformation | DaclSecurityInformation,
                out owner,
                out group,
                out dacl,
                out sacl,
                out descriptor);
            if (error != 0)
                throw new Win32Exception((int)error);

            var mapping = new GenericMapping
            {
                GenericRead = 0x120089,
                GenericWrite = 0x120116,
                GenericExecute = 0x1200A0,
                GenericAll = 0x1F01FF,
            };
            uint privilegeLength = 1024;
            privileges = Marshal.AllocHGlobal((int)privilegeLength);
            uint granted;
            int status;
            if (!AccessCheck(
                descriptor,
                impersonationToken,
                FileWriteData,
                ref mapping,
                privileges,
                ref privilegeLength,
                out granted,
                out status))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            return status != 0 && (granted & FileWriteData) != 0;
        }
        finally
        {
            if (privileges != IntPtr.Zero) Marshal.FreeHGlobal(privileges);
            if (impersonationToken != IntPtr.Zero) CloseHandle(impersonationToken);
            if (token != IntPtr.Zero) CloseHandle(token);
            if (descriptor != IntPtr.Zero) LocalFree(descriptor);
        }
    }
}
'@

try {
    $paths = @()
    if (-not [string]::IsNullOrEmpty($env:WPM_ACCESS_PATHS)) {
        $paths = ConvertFrom-Json $env:WPM_ACCESS_PATHS
    } elseif (-not [string]::IsNullOrEmpty($env:WPM_ACCESS_PATH)) {
        $paths = $env:WPM_ACCESS_PATH
    }
    $paths = @($paths)
    if ($paths.Count -eq 0 -or $null -eq $paths[0]) {
        [Console]::Error.WriteLine('The access check path is empty.')
        exit 2
    }
    foreach ($path in $paths) {
        if ([WpmPathAccess]::CanWrite([string]$path)) {
            [Console]::Out.WriteLine('1')
        } else {
            [Console]::Out.WriteLine('0')
        }
    }
    exit 0
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 2
}
`;

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_ERROR_TEXT = 500;

function encodeCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function clip(value: string): string {
  return value.length <= MAX_ERROR_TEXT ? value : `${value.slice(0, MAX_ERROR_TEXT - 1)}…`;
}

export interface WindowsPathAccessCheckerOptions {
  readonly powershell?: string;
  readonly systemRoot?: string;
  readonly timeoutMs?: number;
}

/**
 * Tests effective write access for a path with the current filtered token.
 * `fs.access(W_OK)` is not usable on Windows for this: it reports Program Files
 * and its files as writable for a standard user because it checks the read-only
 * attribute rather than the ACL. AccessCheck is the same authority the kernel
 * uses for the actual write.
 */
export class WindowsPathAccessChecker {
  private readonly powershell: string;
  private readonly systemRoot: string;
  private readonly timeoutMs: number;

  constructor(options: WindowsPathAccessCheckerOptions = {}) {
    this.systemRoot = resolveSystemRoot(options.systemRoot);
    this.powershell =
      options.powershell ??
      join(this.systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async canWrite(path: string): Promise<boolean> {
    const [writable] = await this.canWriteMany([path]);
    return writable === true;
  }

  async canWriteMany(paths: readonly string[]): Promise<boolean[]> {
    if (paths.length === 0) return [];
    const script = encodeCommand(ACCESS_CHECK_SCRIPT);
    const result = await new Promise<{
      exitCode: number | null;
      stdout: string;
      stderr: string;
    }>((resolve, reject) => {
      const child = spawn(
        this.powershell,
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-WindowStyle',
          'Hidden',
          '-EncodedCommand',
          script,
        ],
        {
          env: {
            ...process.env,
            SystemRoot: this.systemRoot,
            WINDIR: this.systemRoot,
            WPM_ACCESS_PATHS: JSON.stringify(paths),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        },
      );

      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (error: Error | null, code: number | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error !== null) reject(error);
        else resolve({ exitCode: code, stdout, stderr });
      };
      const timer = setTimeout(() => {
        child.kill();
        finish(
          new EnvironmentError('The helper path permission check timed out.', {
            cause: new Error(`PowerShell did not finish within ${this.timeoutMs} ms.`),
          }),
          null,
        );
      }, this.timeoutMs);

      child.stdout?.on('data', (chunk: Buffer) => {
        if (stdout.length < 16_384) stdout += chunk.toString('utf8');
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderr.length < MAX_ERROR_TEXT) stderr += chunk.toString('utf8');
      });
      child.once('error', (error) => {
        finish(
          new EnvironmentError('The helper path permission check could not start.', {
            cause: error,
          }),
          null,
        );
      });
      child.once('close', (code) => finish(null, code));
    });

    if (result.exitCode === 2) {
      const detail = clip(result.stderr.trim());
      throw new EnvironmentError(
        detail.length === 0
          ? 'The helper path permission check failed; the helper location cannot be trusted.'
          : `The helper path permission check failed; the helper location cannot be trusted: ${detail}`,
      );
    }
    if (result.exitCode !== 0) {
      throw new EnvironmentError('The helper path permission check failed unexpectedly.');
    }

    const answers = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line === '0' || line === '1');
    if (answers.length !== paths.length) {
      throw new EnvironmentError('The helper path permission check returned an incomplete result.');
    }
    return answers.map((answer) => answer === '1');
  }
}
