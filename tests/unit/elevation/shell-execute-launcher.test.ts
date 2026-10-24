import { describe, expect, it } from 'vitest';
import {
  buildHelperParameters,
  buildPowerShellArguments,
  quoteWindowsArgument,
} from '@infra/elevation/shell-execute-launcher';

describe('quoteWindowsArgument', () => {
  it('leaves simple arguments unchanged', () => {
    expect(quoteWindowsArgument('--helper')).toBe('--helper');
    expect(quoteWindowsArgument('sha256:abc')).toBe('sha256:abc');
  });

  it('quotes spaces and empty strings', () => {
    expect(quoteWindowsArgument('C:\\Program Files\\App\\app.exe')).toBe(
      '"C:\\Program Files\\App\\app.exe"',
    );
    expect(quoteWindowsArgument('')).toBe('""');
  });

  it('escapes quotes and backslashes using CommandLineToArgvW rules', () => {
    expect(quoteWindowsArgument('a"b')).toBe('"a\\"b"');
    expect(quoteWindowsArgument('C:\\path with space\\')).toBe('"C:\\path with space\\\\"');
    expect(quoteWindowsArgument('a\\\\"b')).toBe('"a\\\\\\\\\\"b"');
  });

  it('joins arguments with a single lpParameters string', () => {
    expect(buildHelperParameters(['--helper', '--plan', 'C:\\ProgramData\\run 1\\plan.json'])).toBe(
      '--helper --plan "C:\\ProgramData\\run 1\\plan.json"',
    );
  });
});

describe('buildPowerShellArguments', () => {
  it('uses an encoded fixed ShellExecuteEx host, not Start-Process', () => {
    const args = buildPowerShellArguments();
    expect(args).toContain('-EncodedCommand');
    expect(args).toContain('-NoProfile');
    const encoded = args[args.indexOf('-EncodedCommand') + 1];
    expect(encoded).toBeDefined();
    const script = Buffer.from(encoded!, 'base64').toString('utf16le');

    expect(script).toContain('ShellExecuteExW');
    expect(script).toContain('SHELLEXECUTEINFO');
    expect(script).toContain('0x00000040');
    expect(script).toContain("$info.lpVerb = 'runas'");
    expect(script).toContain('WaitForSingleObject');
    expect(script).toContain('GetExitCodeProcess');
    expect(script).toContain('$env:WPM_HELPER');
    expect(script).toContain('$env:WPM_PARAMETERS');
    expect(script).not.toContain('Start-Process');
  });
});
