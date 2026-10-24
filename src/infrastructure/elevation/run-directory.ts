import type { CommandRunner } from '@core/process/command-runner';
import { isWindowsPrincipal } from '@shared/domain';
import { EnvironmentError } from '@shared/errors';
import { NodeCommandRunner } from '../process/node-command-runner';
import { system32Path } from './system-paths';

export interface RunDirectoryAcl {
  apply(path: string, invokingUser?: string): Promise<void>;
}

const WHOAMI_TIMEOUT_MS = 5_000;

/** Reads the authenticated user's SID; names are not trusted for ACLs. */
export async function currentWindowsSid(
  runner: CommandRunner = new NodeCommandRunner(),
): Promise<string> {
  const result = await runner.run(system32Path('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], {
    timeoutMs: WHOAMI_TIMEOUT_MS,
  });
  if (result.exitCode === 0) {
    const match = /"([^"]+)","(S-1-(?:\d+-)+\d+)"/i.exec(result.stdout);
    if (match !== null && match[2] !== undefined) return match[2];
  }
  throw new EnvironmentError(
    'The invoking Windows user SID could not be determined; the snapshot ACL cannot be trusted.',
  );
}

export function currentWindowsUser(): string {
  const username = process.env.USERNAME;
  if (username === undefined || username.length === 0) {
    throw new EnvironmentError('The current Windows user could not be determined.');
  }
  const domain = process.env.USERDOMAIN;
  return domain === undefined || domain.length === 0 ? username : `${domain}\\${username}`;
}

export interface WindowsRunDirectoryAclOptions {
  readonly runner?: CommandRunner;
  readonly user?: string;
  readonly icaclsExe?: string;
}

/**
 * The run directory is readable by the invoking user and Administrators only.
 * SIDs are used for the built-in groups so the ACL is locale-independent.
 */
export class WindowsRunDirectoryAcl implements RunDirectoryAcl {
  private readonly runner: CommandRunner;
  private readonly user: string;
  private readonly icaclsExe: string;

  constructor(options: WindowsRunDirectoryAclOptions = {}) {
    this.runner = options.runner ?? new NodeCommandRunner();
    this.user = options.user ?? currentWindowsUser();
    this.icaclsExe = options.icaclsExe ?? system32Path('icacls.exe');
  }

  async apply(path: string, invokingUser?: string): Promise<void> {
    const user = invokingUser ?? this.user;
    if (!isWindowsPrincipal(user)) {
      throw new EnvironmentError('The run-directory ACL principal is not a valid SID or account.');
    }
    const principal = user.startsWith('S-1-') ? `*${user}` : user;
    const result = await this.runner.run(
      this.icaclsExe,
      [
        path,
        '/inheritance:r',
        '/grant:r',
        `${principal}:(OI)(CI)F`,
        '/grant:r',
        '*S-1-5-32-544:(OI)(CI)F',
        '/grant:r',
        '*S-1-5-18:(OI)(CI)F',
        '/Q',
      ],
      { timeoutMs: 10_000 },
    );

    if (result.exitCode !== 0) {
      throw new EnvironmentError(
        'The private run directory ACL could not be applied; the elevated helper was not launched.',
        { cause: new Error(result.stderr.trim() || `icacls exited with ${result.exitCode}.`) },
      );
    }
  }
}
