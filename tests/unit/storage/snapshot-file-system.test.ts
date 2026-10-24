import { access, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ValidationError } from '@shared/errors';
import { NodeSnapshotFileSystem, type SnapshotAcl } from '@infra/storage/snapshot-file-system';
import { windowsShortPath } from '../support/windows-short-path';

class RecordingAcl implements SnapshotAcl {
  readonly calls: { path: string; kind: 'file' | 'directory' }[] = [];

  async apply(path: string, kind: 'file' | 'directory'): Promise<void> {
    this.calls.push({ path, kind });
  }
}

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'wpm-fs-'));
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

describe('NodeSnapshotFileSystem reparse-point hardening', () => {
  it('creates and ACLs a real snapshot directory', async () => {
    const root = await temporaryDirectory();
    const acl = new RecordingAcl();
    const files = new NodeSnapshotFileSystem(acl);
    const directory = join(root, 'snapshots');

    await files.ensureDirectory(directory);
    await files.ensureDirectory(directory);

    expect(acl.calls).toEqual([{ path: directory, kind: 'directory' }]);
  });

  it.runIf(process.platform === 'win32')(
    'accepts an 8.3 short path that resolves to a real directory',
    async () => {
      const root = await temporaryDirectory();
      const shortRoot = windowsShortPath(root);
      if (shortRoot === null) return;

      const files = new NodeSnapshotFileSystem(new RecordingAcl());
      await expect(files.ensureDirectory(join(shortRoot, 'snapshots'))).resolves.toBeUndefined();
    },
  );

  it.runIf(process.platform === 'win32')(
    'rejects a snapshots directory that is a junction',
    async () => {
      const root = await temporaryDirectory();
      const target = join(root, 'target');
      const junction = join(root, 'snapshots');
      await mkdir(target, { recursive: true });
      await symlink(target, junction, 'junction');
      const acl = new RecordingAcl();
      const files = new NodeSnapshotFileSystem(acl);

      await expect(files.ensureDirectory(junction)).rejects.toBeInstanceOf(ValidationError);
      expect(acl.calls).toEqual([]);
    },
  );

  it.runIf(process.platform === 'win32')(
    'rejects an app root that is a junction before creating the snapshots directory',
    async () => {
      const root = await temporaryDirectory();
      const realApp = join(root, 'real-app');
      const appLink = join(root, 'app-link');
      await mkdir(realApp, { recursive: true });
      await symlink(realApp, appLink, 'junction');
      const acl = new RecordingAcl();
      const files = new NodeSnapshotFileSystem(acl);

      await expect(files.ensureDirectory(join(appLink, 'snapshots'))).rejects.toBeInstanceOf(
        ValidationError,
      );
      expect(acl.calls).toEqual([]);
      await expect(access(join(realApp, 'snapshots'))).rejects.toThrow();
    },
  );

  it.runIf(process.platform === 'win32')(
    'rejects reading a file through a junctioned snapshots directory',
    async () => {
      const root = await temporaryDirectory();
      const target = join(root, 'target');
      const junction = join(root, 'snapshots');
      await mkdir(target, { recursive: true });
      await writeFile(join(target, 'a.reg'), 'REGEDIT4\n', 'utf8');
      await symlink(target, junction, 'junction');
      const files = new NodeSnapshotFileSystem(new RecordingAcl());

      await expect(files.readBytes(join(junction, 'a.reg'))).rejects.toBeInstanceOf(
        ValidationError,
      );
    },
  );
});
