import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AtomicJsonFile,
  NodeAtomicFileSystem,
  renameWithRetry,
} from '@infra/storage/atomic-json-file';
import { ValidationError } from '@shared/errors';
import { ToggleFileSystem } from '../support/toggle-file-system';

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'wpm-atomic-json-'));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('renameWithRetry', () => {
  it('retries transient Windows rename errors', async () => {
    let attempts = 0;

    await renameWithRetry(
      async () => {
        attempts += 1;
        if (attempts < 3) {
          throw Object.assign(new Error('busy'), { code: 'EBUSY' });
        }
      },
      'from',
      'to',
    );

    expect(attempts).toBe(3);
  });

  it('does not retry non-transient errors', async () => {
    let attempts = 0;

    await expect(
      renameWithRetry(
        async () => {
          attempts += 1;
          throw Object.assign(new Error('gone'), { code: 'ENOENT' });
        },
        'from',
        'to',
      ),
    ).rejects.toThrow('gone');
    expect(attempts).toBe(1);
  });
});

describe('AtomicJsonFile', () => {
  it('writes, reads, lists, and deletes a JSON document', async () => {
    const file = new AtomicJsonFile(directory);
    const document = { schemaVersion: 1, name: 'Test', values: [1, 2, 3] };

    await file.write('profile.json', document);

    await expect(file.read('profile.json')).resolves.toEqual(document);
    await expect(file.list()).resolves.toEqual(['profile.json']);

    await file.delete('profile.json');
    await expect(file.list()).resolves.toEqual([]);
  });

  it('returns an empty list when the directory does not exist', async () => {
    const file = new AtomicJsonFile(join(directory, 'missing'));

    await expect(file.list()).resolves.toEqual([]);
  });

  it('leaves the previous file intact when the final rename fails', async () => {
    const filesystem = new ToggleFileSystem(new NodeAtomicFileSystem());
    const file = new AtomicJsonFile(directory, filesystem);
    await file.write('profile.json', { revision: 1 });

    filesystem.failRename = true;
    await expect(file.write('profile.json', { revision: 2 })).rejects.toThrow(
      'simulated rename failure',
    );

    await expect(file.read('profile.json')).resolves.toEqual({ revision: 1 });
    await expect(readdir(directory)).resolves.toEqual(['profile.json']);
  });

  it('leaves the previous file intact when the temporary write fails', async () => {
    const filesystem = new ToggleFileSystem(new NodeAtomicFileSystem());
    const file = new AtomicJsonFile(directory, filesystem);
    await file.write('profile.json', { revision: 1 });

    filesystem.failWrite = true;
    await expect(file.write('profile.json', { revision: 2 })).rejects.toThrow(
      'simulated write failure',
    );

    await expect(file.read('profile.json')).resolves.toEqual({ revision: 1 });
    await expect(readdir(directory)).resolves.toEqual(['profile.json']);
  });

  it('cleans up a temporary file when a partial write fails', async () => {
    const filesystem = new ToggleFileSystem(new NodeAtomicFileSystem());
    const file = new AtomicJsonFile(directory, filesystem);
    await file.write('profile.json', { revision: 1 });

    filesystem.failAfterWrite = true;
    await expect(file.write('profile.json', { revision: 2 })).rejects.toThrow(
      'simulated post-write failure',
    );

    await expect(file.read('profile.json')).resolves.toEqual({ revision: 1 });
    await expect(readdir(directory)).resolves.toEqual(['profile.json']);
  });

  it('lists JSON files with a case-insensitive extension', async () => {
    const file = new AtomicJsonFile(directory);
    await writeFile(join(directory, 'profile.JSON'), '{"safe":true}', 'utf8');

    await expect(file.list()).resolves.toEqual(['profile.JSON']);
  });

  it.each(['con.json', 'LPT1.json', 'nul.json'])(
    'rejects reserved Windows device file name %s',
    async (name) => {
      const file = new AtomicJsonFile(directory);

      await expect(file.write(name, { safe: false })).rejects.toBeInstanceOf(ValidationError);
      await expect(file.read(name)).rejects.toBeInstanceOf(ValidationError);
      await expect(file.delete(name)).rejects.toBeInstanceOf(ValidationError);
    },
  );

  it.each(['../escape.json', 'nested/profile.json', 'nested\\profile.json', '.', '..'])(
    'rejects unsafe file name %s',
    async (name) => {
      const file = new AtomicJsonFile(directory);

      await expect(file.write(name, { safe: false })).rejects.toBeInstanceOf(ValidationError);
      await expect(file.read(name)).rejects.toBeInstanceOf(ValidationError);
      await expect(file.delete(name)).rejects.toBeInstanceOf(ValidationError);
    },
  );

  it('rejects invalid JSON with a validation error', async () => {
    const file = new AtomicJsonFile(directory);
    await writeFile(join(directory, 'broken.json'), '{', 'utf8');

    await expect(file.read('broken.json')).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects dangerous JSON keys while reading', async () => {
    const file = new AtomicJsonFile(directory);
    await writeFile(join(directory, 'danger.json'), '{"__proto__":{"polluted":true}}', 'utf8');

    await expect(file.read('danger.json')).rejects.toBeInstanceOf(ValidationError);
  });

  it('does not overwrite a file through a tracked temporary name', async () => {
    const file = new AtomicJsonFile(directory);
    await writeFile(join(directory, '.profile.json.known.tmp'), 'old', 'utf8');

    await file.write('profile.json', { revision: 1 });

    await expect(readFile(join(directory, '.profile.json.known.tmp'), 'utf8')).resolves.toBe('old');
  });
});
