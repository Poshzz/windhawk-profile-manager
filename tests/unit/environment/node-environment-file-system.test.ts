import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NodeEnvironmentFileSystem } from '@infra/environment/node-environment-file-system';

let tempDirectory: string;
let files: NodeEnvironmentFileSystem;

beforeEach(async () => {
  tempDirectory = await mkdtemp(join(tmpdir(), 'wpm-environment-files-'));
  files = new NodeEnvironmentFileSystem();
});

afterEach(async () => {
  await rm(tempDirectory, { recursive: true, force: true });
});

describe('NodeEnvironmentFileSystem', () => {
  it('reads text files and reports missing files as null', async () => {
    const path = join(tempDirectory, 'windhawk.ini');
    await writeFile(path, '[Storage]\nPortable=0\n', 'utf8');

    await expect(files.readTextFile(path)).resolves.toBe('[Storage]\nPortable=0\n');
    await expect(files.readTextFile(join(tempDirectory, 'missing.ini'))).resolves.toBeNull();
  });

  it('lists only directories and reports a missing directory as null', async () => {
    await mkdir(join(tempDirectory, 'Engine', '1.7.3'), { recursive: true });
    await writeFile(join(tempDirectory, 'Engine', 'notes.txt'), 'ignored', 'utf8');

    await expect(files.readDirectory(join(tempDirectory, 'Engine'))).resolves.toEqual(['1.7.3']);
    await expect(files.readDirectory(join(tempDirectory, 'Missing'))).resolves.toBeNull();
  });

  it('checks files without treating directories as files', async () => {
    const executable = join(tempDirectory, 'windhawk.exe');
    await writeFile(executable, '', 'utf8');

    await expect(files.fileExists(executable)).resolves.toBe(true);
    await expect(files.fileExists(tempDirectory)).resolves.toBe(false);
    await expect(files.fileExists(join(tempDirectory, 'missing.exe'))).resolves.toBe(false);
  });
});
