import { existsSync, realpathSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join, normalize } from 'node:path';
import { EnvironmentError } from '@shared/errors';

const FORBIDDEN_SYSTEM_ROOT_SEGMENTS = /\\users\\|\\appdata\\|\\temp\\|\\public\\|\\programdata\\/i;
const WINDOWS_ROOT_PATTERN = /^[A-Za-z]:\\Windows$/i;
const TRUSTED_SYSTEM_ROOT = 'C:\\Windows';
const TRUSTED_PROGRAM_DATA = 'C:\\ProgramData';

/**
 * Security-critical Windows binaries are resolved from the Windows directory.
 * A process environment is attacker-controlled, so reject roots that point at
 * a user profile, temp, public, or a non-Windows leaf. This is not a substitute
 * for a native known-folder API, but it blocks the documented poisoned-env
 * launch path while keeping a standard Windows layout working.
 */
export function resolveSystemRoot(
  value = process.env['SystemRoot'] ?? process.env['WINDIR'],
): string {
  const candidate = normalize(value === undefined || value.length === 0 ? 'C:\\Windows' : value);
  const withoutTrailingSeparators = candidate.replace(/[\\/]+$/, '');
  if (!WINDOWS_ROOT_PATTERN.test(withoutTrailingSeparators)) {
    throw new EnvironmentError(
      'The Windows system directory is not in a trusted location; the app cannot launch privileged components.',
    );
  }
  if (withoutTrailingSeparators.toLowerCase() !== TRUSTED_SYSTEM_ROOT.toLowerCase()) {
    throw new EnvironmentError(
      'The Windows system directory is not on the trusted system drive; this v1 build requires C:\\Windows.',
    );
  }
  if (FORBIDDEN_SYSTEM_ROOT_SEGMENTS.test(withoutTrailingSeparators)) {
    throw new EnvironmentError(
      'The Windows system directory points at a user-writable location; the app cannot launch privileged components.',
    );
  }
  if (!existsSync(join(withoutTrailingSeparators, 'System32', 'kernel32.dll'))) {
    throw new EnvironmentError(
      'The Windows system directory is missing its system libraries; the app cannot launch privileged components.',
    );
  }

  try {
    const real = realpathSync(withoutTrailingSeparators);
    if (real.toLowerCase() !== withoutTrailingSeparators.toLowerCase()) {
      throw new EnvironmentError(
        'The Windows system directory resolves through a reparse point; the app cannot launch privileged components.',
      );
    }
  } catch (error) {
    if (error instanceof EnvironmentError) throw error;
    throw new EnvironmentError(
      'The Windows system directory could not be verified; the app cannot launch privileged components.',
      { cause: error },
    );
  }

  return withoutTrailingSeparators;
}

export function system32Path(fileName: string, systemRoot = resolveSystemRoot()): string {
  return join(systemRoot, 'System32', fileName);
}

/**
 * The user data root is environment-derived. Require the canonical per-user
 * LocalAppData shape on the system drive so a substituted or public directory
 * cannot redirect elevated snapshot writes.
 */
export function resolveLocalAppData(value = process.env['LOCALAPPDATA']): string {
  const candidate = normalize(value === undefined || value.length === 0 ? '' : value).replace(
    /[\\/]+$/,
    '',
  );
  if (
    !/^C:\\Users\\[^\\/]+\\AppData\\Local$/i.test(candidate) ||
    /\\Users\\Public\\/i.test(candidate) ||
    !existsSync(candidate)
  ) {
    throw new EnvironmentError(
      'LocalAppData is not in a trusted per-user location; the app cannot create snapshot paths.',
    );
  }
  const profileName = candidate.split('\\')[2];
  let windowsUserName: string;
  try {
    windowsUserName = userInfo().username;
  } catch (error) {
    throw new EnvironmentError('The current Windows profile name could not be determined.', {
      cause: error,
    });
  }
  if (profileName === undefined || profileName.toLowerCase() !== windowsUserName.toLowerCase()) {
    throw new EnvironmentError(
      'LocalAppData does not belong to the authenticated Windows user; the app cannot create snapshot paths.',
    );
  }
  try {
    const real = realpathSync(candidate);
    if (real.toLowerCase() !== candidate.toLowerCase()) {
      throw new EnvironmentError(
        'LocalAppData resolves through a reparse point; the app cannot create snapshot paths.',
      );
    }
  } catch (error) {
    if (error instanceof EnvironmentError) throw error;
    throw new EnvironmentError('LocalAppData could not be verified.', { cause: error });
  }
  return candidate;
}

/**
 * The run directory lives under ProgramData. Reject a poisoned ProgramData
 * environment that points at a user-writable tree.
 */
export function resolveProgramData(value = process.env['ProgramData']): string {
  const candidate = normalize(
    value === undefined || value.length === 0 ? 'C:\\ProgramData' : value,
  ).replace(/[\\/]+$/, '');
  if (
    !/^[A-Za-z]:\\[^\\/]+$/i.test(candidate) ||
    candidate.split('\\').pop()?.toLowerCase() !== 'programdata' ||
    /\\users\\|\\appdata\\|\\temp\\|\\public\\/i.test(candidate) ||
    !existsSync(candidate)
  ) {
    throw new EnvironmentError(
      'ProgramData is not in a trusted location; the private helper directory cannot be created.',
    );
  }
  if (candidate.toLowerCase() !== TRUSTED_PROGRAM_DATA.toLowerCase()) {
    throw new EnvironmentError(
      'ProgramData is not on the trusted system drive; this v1 build requires C:\\ProgramData.',
    );
  }
  try {
    const real = realpathSync(candidate);
    if (real.toLowerCase() !== candidate.toLowerCase()) {
      throw new EnvironmentError(
        'ProgramData resolves through a reparse point; the private helper directory is not allowed.',
      );
    }
  } catch (error) {
    if (error instanceof EnvironmentError) throw error;
    throw new EnvironmentError('ProgramData could not be verified.', { cause: error });
  }
  return candidate;
}
