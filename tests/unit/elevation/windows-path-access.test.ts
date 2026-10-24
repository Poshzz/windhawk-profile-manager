import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { EnvironmentError } from '@shared/errors';
import { WindowsPathAccessChecker } from '@infra/elevation/windows-path-access';

const execFileAsync = promisify(execFile);
const describeWindows = process.platform === 'win32' ? describe : describe.skip;
const roots: string[] = [];
const cleanups: Array<() => Promise<void>> = [];
const currentUser =
  process.env.USERDOMAIN !== undefined && process.env.USERNAME !== undefined
    ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}`
    : null;
const icacls = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe');

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup().catch(() => undefined);
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'wpm-access-'));
  roots.push(directory);
  return directory;
}

async function denyWrite(path: string, scope: '' | '(OI)(CI)' = ''): Promise<void> {
  if (currentUser === null) throw new Error('The current Windows user could not be determined.');
  await execFileAsync(icacls, [path, '/deny', `${currentUser}:${scope}(W)`]);
  cleanups.push(async () => {
    await execFileAsync(icacls, [path, '/remove:d', currentUser]);
  });
}

describeWindows('WindowsPathAccessChecker', () => {
  it('agrees with the filesystem for writable directories and files', async () => {
    const directory = await root();
    const file = join(directory, 'WindhawkProfileManager.exe');
    await writeFile(file, 'fake helper', 'utf8');
    const checker = new WindowsPathAccessChecker();

    await expect(checker.canWrite(directory)).resolves.toBe(true);
    await expect(checker.canWrite(file)).resolves.toBe(true);
  }, 30_000);

  it('detects an explicit write deny on a directory and on a file', async () => {
    const directory = await root();
    const protectedDirectory = join(directory, 'protected-directory');
    await mkdir(protectedDirectory);
    await denyWrite(protectedDirectory, '(OI)(CI)');

    const protectedFile = join(directory, 'protected-file.exe');
    await writeFile(protectedFile, 'fake helper', 'utf8');
    await denyWrite(protectedFile);

    const checker = new WindowsPathAccessChecker();
    await expect(checker.canWrite(protectedDirectory)).resolves.toBe(false);
    await expect(checker.canWrite(protectedFile)).resolves.toBe(false);
  }, 30_000);

  it('checks multiple paths in one process without losing the array', async () => {
    const directory = await root();
    const writable = join(directory, 'writable.exe');
    await writeFile(writable, 'fake helper', 'utf8');
    const denied = join(directory, 'denied.exe');
    await writeFile(denied, 'fake helper', 'utf8');
    await denyWrite(denied);
    const checker = new WindowsPathAccessChecker();

    await expect(checker.canWriteMany([writable, denied])).resolves.toEqual([true, false]);
  }, 30_000);

  it('fails closed when the path cannot be inspected', async () => {
    const directory = await root();
    const checker = new WindowsPathAccessChecker();
    await expect(checker.canWrite(join(directory, 'missing'))).rejects.toBeInstanceOf(
      EnvironmentError,
    );
  }, 30_000);
});
