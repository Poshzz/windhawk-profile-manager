import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NodeSnapshotFileSystem, type SnapshotAcl } from '@infra/storage/snapshot-file-system';
import {
  MAX_SNAPSHOT_REG_BYTES,
  SnapshotStore,
  type SnapshotContext,
  type SnapshotStoreWarning,
} from '@infra/snapshots/snapshot-store';
import type { RegistryGateway } from '@core/registry/registry-gateway';
import { parseEnvironment, type Environment, type RegistrySnapshot } from '@shared/domain';
import { NotFoundError, ValidationError } from '@shared/errors';
import { readFixtureBytes } from '../domain/test-fixtures';

const CAPTURED_AT = '2026-10-22T12:00:00.000Z';

class FixtureGateway implements RegistryGateway {
  readonly exportCalls: string[] = [];

  constructor(private readonly bytes: Uint8Array) {}

  async read(): Promise<RegistrySnapshot> {
    throw new Error('read() is not used by SnapshotStore tests.');
  }

  async applyOps(): Promise<void> {
    throw new Error('applyOps() is not used by SnapshotStore tests.');
  }

  async applyRestoreOps(): Promise<void> {
    throw new Error('applyRestoreOps() is not used by SnapshotStore tests.');
  }

  async exportReg(path: string): Promise<void> {
    this.exportCalls.push(path);
    await writeFile(path, this.bytes);
  }

  async reconcile(): Promise<void> {
    throw new Error('reconcile() is not used by SnapshotStore tests.');
  }
}

class RecordingAcl implements SnapshotAcl {
  readonly calls: Array<{ path: string; kind: 'file' | 'directory' }> = [];

  async apply(path: string, kind: 'file' | 'directory'): Promise<void> {
    this.calls.push({ path, kind });
  }
}

class FailingMetadataFileSystem extends NodeSnapshotFileSystem {
  override async writeText(): Promise<void> {
    throw new Error('simulated metadata write failure');
  }
}

function makeEnvironment(): Environment {
  return parseEnvironment({
    schemaVersion: 1,
    probedAt: '2026-10-22T11:00:00.000Z',
    windows: {
      version: 'Windows 11 Pro',
      build: '22631',
      supported: true,
    },
    windhawk: {
      installed: true,
      installDir: 'C:\\Program Files\\Windhawk',
      iniPath: 'C:\\ProgramData\\Windhawk\\config.ini',
      version: '1.7.3',
      engineVersion: '1.7.3',
      storageMode: 'registry',
      portable: false,
      registryRoot: 'HKLM\\SOFTWARE\\Windhawk',
    },
    service: {
      name: 'Windhawk',
      state: 'running',
    },
    mods: [],
    rainmeter: {
      installed: true,
      running: true,
      path: 'C:\\Program Files\\Rainmeter\\Rainmeter.exe',
    },
    perUserConfig: {
      present: false,
      active: false,
      sid: null,
    },
    compatibility: {
      mode: 'writable',
      canApply: true,
      issues: [],
    },
  });
}

function clock(start = CAPTURED_AT, stepMs = 1000): () => Date {
  let time = Date.parse(start);
  return () => {
    const value = new Date(time);
    time += stepMs;
    return value;
  };
}

function makeContext(): SnapshotContext {
  return {
    environment: makeEnvironment(),
    profileId: 'mac-blur-glass',
    appVersion: '0.1.0',
  };
}

function hash(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

let rootDirectory: string;
let snapshotsDirectory: string;

beforeEach(async () => {
  rootDirectory = await mkdtemp(join(tmpdir(), 'wpm-snapshot-store-'));
  snapshotsDirectory = join(rootDirectory, 'snapshots');
});

afterEach(async () => {
  await rm(rootDirectory, { recursive: true, force: true });
});

function makeStore(
  overrides: {
    readonly bytes?: Uint8Array;
    readonly now?: () => Date;
    readonly activeJournalSnapshotIds?: () => Promise<ReadonlySet<string>>;
    readonly automaticRetentionLimit?: number;
    readonly onWarning?: (warning: SnapshotStoreWarning) => void;
  } = {},
): {
  store: SnapshotStore;
  gateway: FixtureGateway;
  acl: RecordingAcl;
} {
  const gateway = new FixtureGateway(
    overrides.bytes ?? readFixtureBytes('Mac_BlurGlass_Profile.reg'),
  );
  const acl = new RecordingAcl();
  const store = new SnapshotStore({
    gateway,
    directory: snapshotsDirectory,
    fileSystem: new NodeSnapshotFileSystem(acl),
    now: overrides.now ?? clock(),
    ...(overrides.activeJournalSnapshotIds === undefined
      ? {}
      : { activeJournalSnapshotIds: overrides.activeJournalSnapshotIds }),
    ...(overrides.automaticRetentionLimit === undefined
      ? {}
      : { automaticRetentionLimit: overrides.automaticRetentionLimit }),
    ...(overrides.onWarning === undefined ? {} : { onWarning: overrides.onWarning }),
  });
  return { store, gateway, acl };
}

describe('SnapshotStore', () => {
  it('captures raw evidence, parsed values, and checksummed metadata', async () => {
    const fixtureBytes = readFixtureBytes('Mac_BlurGlass_Profile.reg');
    const { store, gateway, acl } = makeStore({ bytes: fixtureBytes });
    const record = await store.capture('manual', makeContext());
    const { metadata } = record;

    expect(metadata).toMatchObject({
      id: '2026-10-22T12-00-00-000Z',
      createdAt: CAPTURED_AT,
      trigger: 'manual',
      profileId: 'mac-blur-glass',
      appVersion: '0.1.0',
      windowsBuild: '22631',
      registryView: '64-bit',
      windhawkVersion: '1.7.3',
      windhawkStorageMode: 'registry',
      windhawkServiceName: 'Windhawk',
      windhawkServiceState: 'running',
      rainmeterRunning: true,
      registryFile: '2026-10-22T12-00-00-000Z.reg',
      modCount: 10,
      scope: 'engine-mods-configuration',
    });
    expect(metadata.excludedPaths).toContain('HKLM\\SOFTWARE\\Windhawk\\Engine\\ModsWritable');

    const registryPath = join(snapshotsDirectory, metadata.registryFile);
    const metadataPath = join(snapshotsDirectory, `${metadata.id}.json`);
    const registryBytes = await readFile(registryPath);
    expect(registryBytes).toEqual(Buffer.from(fixtureBytes));
    expect(metadata.registrySha256).toBe(hash(registryBytes));
    expect(record.registry.keys).toHaveLength(21);
    expect(record.registry.keys.flatMap((key) => key.values)).toHaveLength(244);
    expect(gateway.exportCalls).toEqual([registryPath]);

    const metadataJson = JSON.parse(await readFile(metadataPath, 'utf8')) as unknown;
    expect(metadataJson).toEqual(metadata);
    expect(acl.calls).toContainEqual({ path: snapshotsDirectory, kind: 'directory' });
    expect(acl.calls).toContainEqual({ path: registryPath, kind: 'file' });
    expect(acl.calls).toContainEqual({ path: metadataPath, kind: 'file' });

    await expect(store.get(metadata.id)).resolves.toEqual(record);
    await expect(store.verify(metadata.id)).resolves.toEqual(metadata);
  });

  it('captures at the ID and absolute path supplied by a helper plan', async () => {
    const { store, gateway } = makeStore();
    const id = 'planned-2026-10-22T20-02-14-123Z';
    const registryPath = join(snapshotsDirectory, `${id}.reg`);

    const record = await store.captureAt('pre-apply', makeContext(), { id, registryPath });

    expect(record.metadata.id).toBe(id);
    expect(record.metadata.registryFile).toBe(`${id}.reg`);
    expect(gateway.exportCalls).toEqual([registryPath]);
    expect(await store.get(id)).toEqual(record);
  });

  it('rejects a planned snapshot path outside the store or with the wrong name', async () => {
    const { store } = makeStore();
    await expect(
      store.captureAt('pre-apply', makeContext(), {
        id: 'planned-id',
        registryPath: join(snapshotsDirectory, 'other.reg'),
      }),
    ).rejects.toThrow(/match its snapshot ID/);

    await expect(
      store.captureAt('pre-apply', makeContext(), {
        id: 'planned-id',
        registryPath: join(rootDirectory, 'planned-id.reg'),
      }),
    ).rejects.toThrow(/inside the snapshot directory/);
  });

  it('lists newest-first and marks manual snapshots as retained', async () => {
    const { store } = makeStore();
    const preApply = await store.capture('pre-apply', makeContext());
    const manual = await store.capture('manual', makeContext());
    const preRestore = await store.capture('pre-restore', makeContext());

    const items = await store.list();

    expect(items.map((item) => item.metadata.id)).toEqual([
      preRestore.metadata.id,
      manual.metadata.id,
      preApply.metadata.id,
    ]);
    expect(items.map((item) => item.retained)).toEqual([false, true, false]);
  });

  it('keeps 20 automatic snapshots, deletes the older evidence, and retains manual snapshots', async () => {
    const { store } = makeStore({
      bytes: readFixtureBytes('Reset_Default_Windows.reg'),
      now: clock(CAPTURED_AT, 1000),
    });
    const captured = [];
    for (let index = 0; index < 25; index += 1) {
      captured.push(await store.capture('pre-apply', makeContext()));
    }

    const items = await store.list();
    expect(items).toHaveLength(20);
    expect(items.map((item) => item.metadata.id)).toEqual(
      captured
        .slice(5)
        .reverse()
        .map((record) => record.metadata.id),
    );

    const names = await readdir(snapshotsDirectory);
    expect(names.filter((name) => name.endsWith('.json'))).toHaveLength(20);
    expect(names.filter((name) => name.endsWith('.reg'))).toHaveLength(20);
    for (const record of captured.slice(0, 5)) {
      await expect(access(join(snapshotsDirectory, `${record.metadata.id}.reg`))).rejects.toThrow();
      await expect(
        access(join(snapshotsDirectory, `${record.metadata.id}.json`)),
      ).rejects.toThrow();
    }

    const manual = await store.capture('manual', makeContext());
    const afterManual = await store.list();
    expect(afterManual).toHaveLength(21);
    expect(afterManual.find((item) => item.metadata.id === manual.metadata.id)?.retained).toBe(
      true,
    );
  }, 20_000);

  it('never deletes an automatic snapshot referenced by an unfinished journal', async () => {
    const activeIds = new Set<string>();
    const { store } = makeStore({
      bytes: readFixtureBytes('Reset_Default_Windows.reg'),
      now: clock(CAPTURED_AT, 1000),
      activeJournalSnapshotIds: async () => new Set(activeIds),
    });
    const captured = [];
    for (let index = 0; index < 20; index += 1) {
      captured.push(await store.capture('pre-apply', makeContext()));
    }

    const oldest = captured[0]?.metadata.id;
    expect(oldest).toBeDefined();
    activeIds.add(oldest ?? '');

    await store.capture('pre-apply', makeContext());
    expect((await store.list()).some((item) => item.metadata.id === oldest)).toBe(true);
    await expect(store.delete(oldest ?? '', { confirm: true })).rejects.toThrow(
      /unfinished journal/i,
    );

    activeIds.delete(oldest ?? '');
    await store.delete(oldest ?? '', { confirm: true });
    expect((await store.list()).some((item) => item.metadata.id === oldest)).toBe(false);
  }, 20_000);

  it('can defer retention so a caller can establish its protection first', async () => {
    const { store } = makeStore({
      bytes: readFixtureBytes('Reset_Default_Windows.reg'),
      now: clock(CAPTURED_AT, 1000),
      automaticRetentionLimit: 1,
    });

    const first = await store.capture('pre-apply', makeContext(), { prune: false });
    const second = await store.capture('pre-apply', makeContext(), { prune: false });

    expect((await store.list()).map((item) => item.metadata.id)).toEqual([
      second.metadata.id,
      first.metadata.id,
    ]);

    await store.prune();
    expect((await store.list()).map((item) => item.metadata.id)).toEqual([second.metadata.id]);
  });

  it('accepts a valid mod id containing the word modswritable', async () => {
    const bytes = Buffer.from(
      [
        'Windows Registry Editor Version 5.00',
        '',
        '[HKEY_LOCAL_MACHINE\\SOFTWARE\\Windhawk\\Engine\\Mods\\modswritable]',
        '"LibraryFileName"="modswritable.dll"',
        '"Disabled"=dword:00000000',
      ].join('\r\n'),
      'utf8',
    );
    const { store } = makeStore({ bytes });

    const record = await store.capture('manual', makeContext());

    expect(record.registry.keys[0]?.path).toBe(
      'HKLM\\SOFTWARE\\Windhawk\\Engine\\Mods\\modswritable',
    );
    await expect(store.get(record.metadata.id)).resolves.toEqual(record);
  });

  it('never deletes the snapshot it just wrote when the clock moves backwards', async () => {
    let tick = 0;
    const times = [CAPTURED_AT, '2026-10-22T11:59:59.000Z'];
    const { store } = makeStore({
      bytes: readFixtureBytes('Reset_Default_Windows.reg'),
      now: () => new Date(times[tick++] ?? CAPTURED_AT),
      automaticRetentionLimit: 1,
    });

    const future = await store.capture('pre-apply', makeContext());
    const past = await store.capture('pre-apply', makeContext());

    expect((await store.list()).map((item) => item.metadata.id)).toEqual([
      future.metadata.id,
      past.metadata.id,
    ]);
    await expect(store.get(past.metadata.id)).resolves.toEqual(past);
  });

  it('imports a valid .reg as an imported snapshot without using the gateway', async () => {
    const { store, gateway } = makeStore();
    const sourcePath = join(rootDirectory, 'source.reg');
    const sourceBytes = readFixtureBytes('Reset_Default_Windows.reg');
    await writeFile(sourcePath, sourceBytes);

    const record = await store.import(sourcePath, makeContext());

    expect(record.metadata).toMatchObject({
      trigger: 'imported',
      profileId: null,
      modCount: 10,
      registryFile: `${record.metadata.id}.reg`,
    });
    expect(record.metadata.registrySha256).toBe(hash(sourceBytes));
    expect(record.registry.keys).toHaveLength(10);
    expect(gateway.exportCalls).toHaveLength(0);
    expect((await store.list())[0]?.retained).toBe(true);

    const copiedBytes = await readFile(join(snapshotsDirectory, record.metadata.registryFile));
    expect(copiedBytes).toEqual(Buffer.from(sourceBytes));
    await expect(store.get(record.metadata.id)).resolves.toEqual(record);
  });

  it('rejects malformed imports without creating snapshot files', async () => {
    const { store } = makeStore();
    const sourcePath = join(rootDirectory, 'malformed.reg');
    await writeFile(sourcePath, 'not a registry file\r\n');

    await expect(store.import(sourcePath, makeContext())).rejects.toBeInstanceOf(ValidationError);
    await expect(access(snapshotsDirectory)).rejects.toThrow();
    expect(await store.list()).toEqual([]);
  });

  it('rejects out-of-allowlist imports without creating snapshot files', async () => {
    const { store } = makeStore();
    const sourcePath = join(rootDirectory, 'foreign.reg');
    await writeFile(
      sourcePath,
      [
        'Windows Registry Editor Version 5.00',
        '',
        '[HKEY_CURRENT_USER\\SOFTWARE\\Windhawk\\Engine\\Mods\\demo-mod]',
        '"Disabled"=dword:00000000',
      ].join('\r\n'),
    );

    await expect(store.import(sourcePath, makeContext())).rejects.toBeInstanceOf(ValidationError);
    await expect(access(snapshotsDirectory)).rejects.toThrow();
    expect(await store.list()).toEqual([]);
  });

  it('rejects ModsWritable imports without creating snapshot files', async () => {
    const { store } = makeStore();
    const sourcePath = join(rootDirectory, 'mods-writable.reg');
    await writeFile(
      sourcePath,
      [
        'Windows Registry Editor Version 5.00',
        '',
        '[HKEY_LOCAL_MACHINE\\SOFTWARE\\Windhawk\\Engine\\ModsWritable\\demo-mod]',
        '"Disabled"=dword:00000000',
      ].join('\r\n'),
    );

    await expect(store.import(sourcePath, makeContext())).rejects.toBeInstanceOf(ValidationError);
    await expect(access(snapshotsDirectory)).rejects.toThrow();
    expect(await store.list()).toEqual([]);
  });

  it('rejects oversized imports before reading or creating files', async () => {
    const { store } = makeStore();
    const sourcePath = join(rootDirectory, 'oversized.reg');
    await writeFile(sourcePath, Buffer.alloc(MAX_SNAPSHOT_REG_BYTES + 1, 0x20));

    await expect(store.import(sourcePath, makeContext())).rejects.toThrow(/size limit/i);
    await expect(access(snapshotsDirectory)).rejects.toThrow();
    expect(await store.list()).toEqual([]);
  });

  it('reports a checksum mismatch instead of silently accepting it', async () => {
    const { store } = makeStore();
    const record = await store.capture('manual', makeContext());
    const registryPath = join(snapshotsDirectory, record.metadata.registryFile);

    await writeFile(registryPath, readFixtureBytes('Reset_Default_Windows.reg'));

    await expect(store.get(record.metadata.id)).rejects.toThrow(/checksum/i);
    await expect(store.verify(record.metadata.id)).rejects.toThrow(/checksum/i);
  });

  it('requires confirmation, removes both files, and reports missing snapshots', async () => {
    const { store } = makeStore();
    const record = await store.capture('manual', makeContext());
    const registryPath = join(snapshotsDirectory, record.metadata.registryFile);
    const metadataPath = join(snapshotsDirectory, `${record.metadata.id}.json`);

    await expect(store.delete(record.metadata.id, { confirm: false })).rejects.toThrow(
      /confirmation/i,
    );
    await expect(access(registryPath)).resolves.toBeUndefined();
    await expect(access(metadataPath)).resolves.toBeUndefined();

    await store.delete(record.metadata.id, { confirm: true });
    await expect(access(registryPath)).rejects.toThrow();
    await expect(access(metadataPath)).rejects.toThrow();
    await expect(store.get(record.metadata.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rejects a snapshot directory that is a regular file before export', async () => {
    const { store, gateway } = makeStore();
    await writeFile(snapshotsDirectory, 'not a directory');

    await expect(store.capture('manual', makeContext())).rejects.toThrow(/directory/i);
    expect(gateway.exportCalls).toHaveLength(0);
  });

  it('returns exported metadata and raw registry bytes', async () => {
    const { store } = makeStore();
    const record = await store.capture('manual', makeContext());

    const exported = await store.export(record.metadata.id);

    expect(exported.metadata).toEqual(record.metadata);
    expect(JSON.parse(exported.metadataJson)).toEqual(record.metadata);
    expect(Buffer.from(exported.registryBytes)).toEqual(
      Buffer.from(readFixtureBytes('Mac_BlurGlass_Profile.reg')),
    );
  });

  it('does not call registry writes other than export during capture', async () => {
    const { store, gateway } = makeStore();
    await store.capture('pre-apply', makeContext());

    expect(gateway.exportCalls).toHaveLength(1);
    expect(gateway.exportCalls[0]).toMatch(/\.reg$/);
  });

  it('serializes concurrent captures and gives each snapshot a unique ID', async () => {
    const { store } = makeStore({
      bytes: readFixtureBytes('Reset_Default_Windows.reg'),
      now: () => new Date(CAPTURED_AT),
    });

    const records = await Promise.all([
      store.capture('pre-apply', makeContext()),
      store.capture('pre-apply', makeContext()),
      store.capture('pre-apply', makeContext()),
    ]);

    expect(new Set(records.map((record) => record.metadata.id)).size).toBe(3);
    expect(await store.list()).toHaveLength(3);
  });

  it('keeps imported snapshots when automatic retention runs', async () => {
    const { store } = makeStore({
      bytes: readFixtureBytes('Reset_Default_Windows.reg'),
      now: clock(CAPTURED_AT, 1000),
    });
    const sourcePath = join(rootDirectory, 'source.reg');
    await writeFile(sourcePath, readFixtureBytes('Reset_Default_Windows.reg'));
    const imported = await store.import(sourcePath, makeContext());

    for (let index = 0; index < 25; index += 1) {
      await store.capture('pre-apply', makeContext());
    }

    const items = await store.list();
    expect(items).toHaveLength(21);
    expect(items.some((item) => item.metadata.id === imported.metadata.id)).toBe(true);
    expect(items.find((item) => item.metadata.id === imported.metadata.id)?.retained).toBe(true);
  }, 20_000);

  it('rejects malformed metadata during list but keeps the store usable', async () => {
    const warnings: SnapshotStoreWarning[] = [];
    const { store } = makeStore({ onWarning: (warning) => warnings.push(warning) });
    const record = await store.capture('manual', makeContext());
    const metadataPath = join(snapshotsDirectory, `${record.metadata.id}.json`);
    await writeFile(metadataPath, '{"schemaVersion": 1, "id": "wrong"}');

    expect(await store.list()).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.operation).toBe('list');
  });

  it('creates the snapshot directory on demand', async () => {
    const { store } = makeStore();
    await expect(access(snapshotsDirectory)).rejects.toThrow();
    await store.capture('manual', makeContext());
    await expect(access(snapshotsDirectory)).resolves.toBeUndefined();
  });

  it('does not create a snapshot when metadata validation fails', async () => {
    const { store, gateway } = makeStore();
    const context = { ...makeContext(), appVersion: '' };

    await expect(store.capture('manual', context)).rejects.toBeInstanceOf(ValidationError);
    expect(gateway.exportCalls).toHaveLength(1);
    await expect(access(snapshotsDirectory)).resolves.toBeUndefined();
    expect(await readdir(snapshotsDirectory)).toEqual([]);
  });

  it('exposes a parsed registry snapshot for preview', async () => {
    const { store } = makeStore();
    const record = await store.capture('manual', makeContext());
    const values = record.registry.keys.flatMap((key) => key.values);

    expect(values.some((entry) => entry.name === 'Disabled')).toBe(true);
    expect(record.registry.capturedAt).toBe(record.metadata.createdAt);
  });

  it('rejects capture with an imported trigger', async () => {
    const { store, gateway } = makeStore();
    await expect(store.capture('imported', makeContext())).rejects.toThrow(/import/i);
    expect(gateway.exportCalls).toHaveLength(0);
  });

  it('rejects unknown snapshot IDs and malformed metadata', async () => {
    const { store } = makeStore();
    const record = await store.capture('manual', makeContext());

    await expect(store.get('../escape')).rejects.toThrow(/invalid snapshot id/i);
    await expect(store.verify('missing')).rejects.toBeInstanceOf(NotFoundError);
    expect(record.metadata.id).toBeTruthy();
  });

  it('does not leave partial files when metadata writing fails', async () => {
    const failingStore = new SnapshotStore({
      gateway: new FixtureGateway(readFixtureBytes('Reset_Default_Windows.reg')),
      directory: snapshotsDirectory,
      fileSystem: new FailingMetadataFileSystem(new RecordingAcl()),
      now: clock(),
    });

    await expect(failingStore.capture('manual', makeContext())).rejects.toThrow(
      'simulated metadata write failure',
    );
    expect(await readdir(snapshotsDirectory)).toEqual([]);
  });
});
