import { describe, expect, it } from 'vitest';
import { EnvironmentError } from '@shared/errors';
import {
  resolveLocalAppData,
  resolveProgramData,
  resolveSystemRoot,
} from '@infra/elevation/system-paths';

describe('resolveSystemRoot', () => {
  it('rejects user-writable and non-Windows roots', () => {
    expect(() => resolveSystemRoot('C:\\Users\\Test\\Windows')).toThrow(EnvironmentError);
    expect(() => resolveSystemRoot('C:\\Public\\Windows')).toThrow(EnvironmentError);
    expect(() => resolveSystemRoot('D:\\Windows')).toThrow(EnvironmentError);
    expect(() => resolveSystemRoot('C:\\Windows\\Temp')).toThrow(EnvironmentError);
    expect(() => resolveSystemRoot('\\\\server\\share\\Windows')).toThrow(EnvironmentError);
  });

  it('rejects a redirected or public LocalAppData root', () => {
    expect(() => resolveLocalAppData('D:\\Users\\Test\\AppData\\Local')).toThrow(EnvironmentError);
    expect(() => resolveLocalAppData('C:\\Users\\Public\\AppData\\Local')).toThrow(
      EnvironmentError,
    );
    expect(() => resolveLocalAppData('C:\\Program Files\\Victim')).toThrow(EnvironmentError);
    expect(() => resolveLocalAppData('C:\\Users\\Default\\AppData\\Local')).toThrow(
      EnvironmentError,
    );
  });

  it('rejects a user-writable or non-canonical ProgramData root', () => {
    expect(() => resolveProgramData('C:\\Users\\Test\\AppData\\Local\\ProgramData')).toThrow(
      EnvironmentError,
    );
    expect(() => resolveProgramData('C:\\Public\\ProgramData')).toThrow(EnvironmentError);
    expect(() => resolveProgramData('C:\\Temp\\ProgramData')).toThrow(EnvironmentError);
  });
});
