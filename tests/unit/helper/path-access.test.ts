import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ValidationError } from '@shared/errors';
import { NODE_HELPER_PATH_ACCESS } from '../../../src/main/helper/helper-paths';
import { windowsShortPath } from '../support/windows-short-path';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'wpm-helper-paths-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }).catch(() => undefined)),
  );
});

describe('NODE_HELPER_PATH_ACCESS reparse hardening', () => {
  it.runIf(process.platform === 'win32')(
    'accepts an 8.3 short path that resolves to a real directory',
    async () => {
      const root = await temporaryDirectory();
      const shortRoot = windowsShortPath(root);
      if (shortRoot === null) return;

      await expect(
        NODE_HELPER_PATH_ACCESS.ensureWritableDirectory(
          join(shortRoot, 'nested'),
          'test directory',
        ),
      ).resolves.toBeUndefined();
    },
  );

  it.runIf(process.platform === 'win32')('rejects a directory beneath a junction', async () => {
    const root = await temporaryDirectory();
    const target = join(root, 'target');
    const junction = join(root, 'junction');
    await mkdir(target, { recursive: true });
    await symlink(target, junction, 'junction');

    await expect(
      NODE_HELPER_PATH_ACCESS.ensureWritableDirectory(join(junction, 'nested'), 'test directory'),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
