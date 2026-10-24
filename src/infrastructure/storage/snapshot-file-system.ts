import { userInfo } from 'node:os';
import {
  lstat as lstatFile,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename as renameFile,
  unlink,
} from 'node:fs/promises';
import { dirname } from 'node:path';
import { isWindowsPrincipal } from '@shared/domain';
import type { CommandRunner } from '@core/process/command-runner';
import { EnvironmentError, ValidationError } from '@shared/errors';
import { isNotFoundError, renameWithRetry, type AtomicFileSystem } from './atomic-json-file';
import { NodeCommandRunner } from '../process/node-command-runner';
import { system32Path } from '../elevation/system-paths';

export interface SnapshotFileInfo {
  readonly size: number;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly isSymbolicLink: boolean;
}

export interface SnapshotFileSystem extends AtomicFileSystem {
  readBytes(path: string): Promise<Uint8Array>;
  writeBytes(path: string, contents: Uint8Array): Promise<void>;
  stat(path: string): Promise<SnapshotFileInfo>;
  applyUserOnlyAcl(path: string, kind: 'file' | 'directory'): Promise<void>;
}

export interface SnapshotAcl {
  apply(path: string, kind: 'file' | 'directory'): Promise<void>;
}

export function currentWindowsUser(): string {
  const username = process.env.USERNAME;
  const domain = process.env.USERDOMAIN;
  if (username !== undefined && username.length > 0) {
    if (username.includes('\\')) return username;
    return domain !== undefined && domain.length > 0 ? `${domain}\\${username}` : username;
  }

  try {
    return userInfo().username;
  } catch (error) {
    throw new EnvironmentError('The current Windows user could not be determined.', {
      cause: error,
    });
  }
}

export class WindowsUserOnlyAcl implements SnapshotAcl {
  private readonly commandRunner: CommandRunner;
  private readonly user: string;
  private readonly icaclsPath: string;

  constructor(commandRunner: CommandRunner = new NodeCommandRunner(), user?: string) {
    this.commandRunner = commandRunner;
    this.user = user ?? currentWindowsUser();
    if (!isWindowsPrincipal(this.user)) {
      throw new ValidationError(
        'The invoking Windows account for the snapshot ACL is not a valid SID or account name.',
      );
    }
    this.icaclsPath = system32Path('icacls.exe');
  }

  async apply(path: string, kind: 'file' | 'directory'): Promise<void> {
    // The invoking user keeps access even when the helper runs as a different
    // administrator. Built-in groups use SIDs so the ACL is locale-independent.
    const principal = this.user.startsWith('S-1-') ? `*${this.user}` : this.user;
    const inheritance = kind === 'directory' ? '(OI)(CI)F' : 'F';
    const result = await this.commandRunner.run(
      this.icaclsPath,
      [
        path,
        '/inheritance:r',
        '/grant:r',
        `${principal}:${inheritance}`,
        '/grant:r',
        `*S-1-5-32-544:${inheritance}`,
        '/grant:r',
        `*S-1-5-18:${inheritance}`,
        '/Q',
      ],
      { timeoutMs: 15_000 },
    );

    if (result.exitCode !== 0) {
      throw new EnvironmentError(
        `The snapshot ACL could not be restricted to the current user (exit code ${result.exitCode}).`,
        {
          details: [
            {
              path: [],
              message: `icacls.exe exited with code ${result.exitCode}.`,
            },
          ],
        },
      );
    }
  }
}

function comparablePath(path: string): string {
  return path
    .replace(/\//g, '\\')
    .replace(/^\\\\\?\\/, '')
    .replace(/\\+$/, '')
    .toLowerCase();
}

export class NodeSnapshotFileSystem implements SnapshotFileSystem {
  private readonly acl: SnapshotAcl;
  /**
   * realpath() is comparatively expensive on Windows. A directory verified in
   * this process is re-checked with lstat on every access, but its ancestor
   * chain is resolved only once. A new process always verifies from scratch.
   */
  private readonly verifiedDirectories = new Set<string>();
  private readonly aclDirectories = new Set<string>();

  constructor(acl: SnapshotAcl = new WindowsUserOnlyAcl()) {
    this.acl = acl;
  }

  async ensureDirectory(directory: string): Promise<void> {
    let info: SnapshotFileInfo;
    try {
      info = await this.stat(directory);
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
      // Validate every existing ancestor before the elevated process creates
      // the leaf; otherwise a junction could redirect mkdir itself.
      await this.assertNoReparseAncestors(directory);
      await mkdir(directory, { recursive: true });
      info = await this.stat(directory);
    }

    if (info.isSymbolicLink || !info.isDirectory) {
      throw new ValidationError('The snapshot directory must be a regular directory.');
    }
    await this.assertDirectoryIsReal(directory);

    const key = directory.replace(/\//g, '\\').toLowerCase();
    if (this.aclDirectories.has(key)) return;
    await this.acl.apply(directory, 'directory');
    this.aclDirectories.add(key);
  }

  async readBytes(path: string): Promise<Uint8Array> {
    await this.assertRegularFile(path);
    return new Uint8Array(await readFile(path));
  }

  async writeBytes(path: string, contents: Uint8Array): Promise<void> {
    await this.assertDirectoryIsReal(dirname(path));
    const handle = await open(path, 'wx', 0o600);
    try {
      await handle.writeFile(contents);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async readText(path: string): Promise<string> {
    await this.assertRegularFile(path);
    return readFile(path, 'utf8');
  }

  async writeText(path: string, contents: string): Promise<void> {
    await this.assertDirectoryIsReal(dirname(path));
    const handle = await open(path, 'wx', 0o600);
    try {
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async rename(from: string, to: string): Promise<void> {
    await this.assertDirectoryIsReal(dirname(from));
    await this.assertDirectoryIsReal(dirname(to));
    await renameWithRetry(renameFile, from, to);
  }

  async remove(path: string): Promise<void> {
    await this.assertDirectoryIsReal(dirname(path));
    await unlink(path);
  }

  async listNames(directory: string): Promise<string[]> {
    await this.assertDirectoryIsReal(directory);
    return readdir(directory);
  }

  async stat(path: string): Promise<SnapshotFileInfo> {
    const info = await lstatFile(path);
    return {
      size: info.size,
      isFile: info.isFile(),
      isDirectory: info.isDirectory(),
      isSymbolicLink: info.isSymbolicLink(),
    };
  }

  async applyUserOnlyAcl(path: string, kind: 'file' | 'directory'): Promise<void> {
    await this.assertDirectoryIsReal(dirname(path));
    await this.acl.apply(path, kind);
  }

  private async assertRegularFile(path: string): Promise<void> {
    await this.assertDirectoryIsReal(dirname(path));
    const info = await this.stat(path);
    if (info.isSymbolicLink || !info.isFile) {
      throw new ValidationError('Expected a regular snapshot file, not a symlink or directory.');
    }
  }

  private async assertNoReparseAncestors(path: string): Promise<void> {
    let current = dirname(path);
    for (;;) {
      try {
        await this.assertDirectoryIsReal(current);
      } catch (error) {
        if (!isNotFoundError(error)) throw error;
      }
      const parent = dirname(current);
      if (parent === current) return;
      current = parent;
    }
  }

  /**
   * A junction/symlink anywhere below the drive root would let the elevated
   * helper read or write a directory the user only appears to own. realpath
   * resolves the whole chain; any difference from the lexical path is a
   * reparse point and is rejected.
   */
  private async assertDirectoryIsReal(directory: string): Promise<void> {
    const key = comparablePath(directory);
    const info = await this.stat(directory);
    if (info.isSymbolicLink || !info.isDirectory) {
      throw new ValidationError(
        'The snapshot path must not be a junction, symbolic link, or non-directory.',
      );
    }
    if (this.verifiedDirectories.has(key)) return;

    const resolved = await realpath(directory);
    if (comparablePath(resolved) !== key) {
      throw new ValidationError('The snapshot path must not traverse a junction or symbolic link.');
    }
    this.verifiedDirectories.add(key);
  }
}
