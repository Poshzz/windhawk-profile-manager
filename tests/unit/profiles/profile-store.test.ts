import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ProfileStore,
  slugifyProfileName,
  type ProfileStoreWarning,
} from '@infra/profiles/profile-store';
import { NodeAtomicFileSystem, type AtomicFileSystem } from '@infra/storage/atomic-json-file';
import { parseProfile, parseProfileJson } from '@shared/domain';
import { NotFoundError, StaleProfileError, ValidationError } from '@shared/errors';
import { readFixture } from '../domain/test-fixtures';
import { ToggleFileSystem } from '../support/toggle-file-system';

const macBlurGlass = parseProfileJson(readFixture('profiles/valid-mac-blur-glass.json'));
const defaultWindows = parseProfile({
  ...macBlurGlass,
  id: 'default-windows',
  name: 'Default Windows',
  description: 'Stock Windows 11 behavior.',
});
const builtins = [macBlurGlass, defaultWindows] as const;

let rootDirectory: string;
let profilesDirectory: string;
let snapshotsDirectory: string;

beforeEach(async () => {
  rootDirectory = await mkdtemp(join(tmpdir(), 'wpm-profile-store-'));
  profilesDirectory = join(rootDirectory, 'profiles');
  snapshotsDirectory = join(rootDirectory, 'snapshots');
});

afterEach(async () => {
  await rm(rootDirectory, { recursive: true, force: true });
});

function makeStore(
  overrides: {
    fileSystem?: AtomicFileSystem;
    now?: () => Date;
    onWarning?: (warning: ProfileStoreWarning) => void;
  } = {},
): ProfileStore {
  return new ProfileStore({
    builtins,
    directory: profilesDirectory,
    ...overrides,
  });
}

function clock(start = '2026-10-22T12:00:00.000Z', stepMs = 1000): () => Date {
  let time = Date.parse(start);
  return () => {
    time += stepMs;
    return new Date(time);
  };
}

function profileFile(id: string): string {
  return join(profilesDirectory, `${id}.json`);
}

describe('ProfileStore', () => {
  it('creates a blank user profile with defaults and revision 1', async () => {
    const store = makeStore({ now: clock() });
    const profile = await store.create({ name: 'Blank' });

    expect(profile).toMatchObject({
      id: 'blank',
      name: 'Blank',
      source: 'user',
      basedOn: null,
      revision: 1,
      requiredMods: [],
      unlistedMods: 'leave',
      actions: { rainmeter: 'unchanged', restartExplorer: 'ask' },
    });
    await expect(store.get('blank')).resolves.toEqual(profile);
  });

  it('lists built-ins first and user profiles by updatedAt descending', async () => {
    const store = makeStore({ now: clock() });
    const alpha = await store.create({ name: 'Alpha' });
    const beta = await store.create({ name: 'Beta' });
    await store.update(alpha.id, 1, { description: 'Updated alpha.' });

    const profiles = await store.list();

    expect(profiles.map((profile) => profile.id)).toEqual([
      'mac-blur-glass',
      'default-windows',
      alpha.id,
      beta.id,
    ]);
    expect(profiles[0]).not.toBe(macBlurGlass);
  });

  it('duplicates a built-in into an editable user profile with basedOn set', async () => {
    const store = makeStore({ now: clock() });
    const copy = await store.duplicate(macBlurGlass.id);

    expect(copy).toMatchObject({
      id: 'mac-blur-glass-copy',
      source: 'user',
      basedOn: macBlurGlass.id,
      revision: 1,
    });

    const edited = await store.update(copy.id, copy.revision, { name: 'My Mac' });
    expect(edited).toMatchObject({ id: copy.id, name: 'My Mac', revision: 2 });
  });

  it('rejects updates and deletes of built-in profiles', async () => {
    const store = makeStore();

    await expect(
      store.update(macBlurGlass.id, macBlurGlass.revision, { name: 'Nope' }),
    ).rejects.toThrow(/read-only/i);
    await expect(store.delete(macBlurGlass.id, { confirm: true })).rejects.toThrow(/read-only/i);
  });

  it('requires explicit confirmation to delete a user profile and leaves snapshots alone', async () => {
    const store = makeStore({ now: clock() });
    await mkdir(snapshotsDirectory, { recursive: true });
    await writeFile(join(snapshotsDirectory, 'keep.reg'), 'evidence', 'utf8');
    const profile = await store.create({ name: 'Delete Me' });

    await expect(store.delete(profile.id, { confirm: false })).rejects.toThrow(/confirm/i);
    await expect(store.get(profile.id)).resolves.toEqual(profile);

    await store.delete(profile.id, { confirm: true });

    await expect(store.get(profile.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(readFile(join(snapshotsDirectory, 'keep.reg'), 'utf8')).resolves.toBe('evidence');
  });

  it.each([
    ['unknown field', 'profiles/invalid-unknown-field.json'],
    ['dangerous key', 'profiles/invalid-dangerous-key.json'],
    ['bad mod ID', 'profiles/invalid-mod-id.json'],
    ['targeting value', 'profiles/invalid-targeting-value.json'],
    ['unsupported setting type', 'profiles/invalid-binary-setting.json'],
  ])('rejects import of %s before writing', async (_label, fixture) => {
    const store = makeStore();

    await expect(store.import(readFixture(fixture))).rejects.toBeInstanceOf(ValidationError);
    await expect(store.list()).resolves.toHaveLength(builtins.length);
    await expect(readdir(profilesDirectory).catch(() => [])).resolves.toEqual([]);
  });

  it('round-trips export and import, preserving revision and basedOn', async () => {
    const store = makeStore({ now: clock() });
    const copy = await store.duplicate(macBlurGlass.id);
    const updated = await store.update(copy.id, copy.revision, {
      description: 'Round-trip profile.',
    });

    const exported = await store.export(copy.id);
    await store.delete(copy.id, { confirm: true });
    const imported = await store.import(exported);

    expect(imported).toEqual(updated);
    expect(imported.revision).toBe(2);
    expect(imported.basedOn).toBe(macBlurGlass.id);
    await expect(store.get(imported.id)).resolves.toEqual(updated);
  });

  it('rejects importing a profile that claims built-in source', async () => {
    const store = makeStore();
    const fakeBuiltin = parseProfile({
      ...macBlurGlass,
      id: 'imported-builtin',
      name: 'Imported Builtin',
      source: 'builtin',
    });

    await expect(store.import(JSON.stringify(fakeBuiltin))).rejects.toThrow(/built-in/i);
    await expect(store.list()).resolves.toHaveLength(builtins.length);
  });

  it('rejects import when the profile ID already exists', async () => {
    const store = makeStore({ now: clock() });
    const profile = await store.create({ name: 'Existing' });
    const exported = await store.export(profile.id);

    await expect(store.import(exported)).rejects.toThrow(/already exists/i);
  });

  it('fails a stale update with StaleProfileError and leaves the file unchanged', async () => {
    const store = makeStore({ now: clock() });
    const profile = await store.create({ name: 'Stale' });
    const before = await readFile(profileFile(profile.id), 'utf8');

    await expect(
      store.update(profile.id, profile.revision + 1, { name: 'Changed' }),
    ).rejects.toBeInstanceOf(StaleProfileError);

    await expect(readFile(profileFile(profile.id), 'utf8')).resolves.toBe(before);
  });

  it('serializes overlapping updates and rejects the stale one', async () => {
    const store = makeStore({ now: clock() });
    const profile = await store.create({ name: 'Concurrent' });
    const results = await Promise.allSettled([
      store.update(profile.id, profile.revision, { name: 'First' }),
      store.update(profile.id, profile.revision, { name: 'Second' }),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    const rejected = results.find((result) => result.status === 'rejected');
    if (rejected === undefined || rejected.status !== 'rejected') {
      throw new Error('Expected one rejected update.');
    }
    expect(rejected.reason).toBeInstanceOf(StaleProfileError);

    const current = await store.get(profile.id);
    expect(current.revision).toBe(2);
    expect(['First', 'Second']).toContain(current.name);
    await expect(
      store.update(profile.id, 2, { description: 'Queue still works.' }),
    ).resolves.toMatchObject({
      revision: 3,
    });
  });

  it('leaves the previous file intact when an atomic write fails', async () => {
    const filesystem = new ToggleFileSystem(new NodeAtomicFileSystem());
    const store = makeStore({ fileSystem: filesystem, now: clock() });
    const profile = await store.create({ name: 'Atomic' });
    const before = await readFile(profileFile(profile.id), 'utf8');

    filesystem.failRename = true;
    await expect(store.update(profile.id, profile.revision, { name: 'Changed' })).rejects.toThrow(
      'simulated rename failure',
    );

    await expect(readFile(profileFile(profile.id), 'utf8')).resolves.toBe(before);
    await expect(readdir(profilesDirectory)).resolves.toEqual([`${profile.id}.json`]);
  });

  it('slugifies names and adds collision suffixes', async () => {
    const store = makeStore({ now: clock() });
    const first = await store.create({ name: 'My Setup' });
    const second = await store.create({ name: 'my setup' });
    const builtinCollision = await store.create({ name: 'Mac Blur Glass' });

    expect(first.id).toBe('my-setup');
    expect(second.id).toBe('my-setup-2');
    expect(builtinCollision.id).toBe('mac-blur-glass-2');
  });

  it('serializes concurrent creates and allocates distinct IDs', async () => {
    const store = makeStore({ now: clock() });
    const [first, second] = await Promise.all([
      store.create({ name: 'Same' }),
      store.create({ name: 'Same' }),
    ]);

    expect([first.id, second.id].sort()).toEqual(['same', 'same-2']);
    await expect(
      store.list().then((profiles) => profiles.filter((profile) => profile.source === 'user')),
    ).resolves.toHaveLength(2);
  });

  it('sees a .JSON file when allocating IDs and does not overwrite it', async () => {
    await mkdir(profilesDirectory, { recursive: true });
    const existingJson = JSON.stringify(
      parseProfile({ ...macBlurGlass, id: 'foo', name: 'Foo', source: 'user' }),
    );
    await writeFile(join(profilesDirectory, 'foo.JSON'), existingJson, 'utf8');
    const store = makeStore({ now: clock() });

    const created = await store.create({ name: 'Foo' });

    expect(created.id).toBe('foo-2');
    await expect(readFile(join(profilesDirectory, 'foo.JSON'), 'utf8')).resolves.toBe(existingJson);
  });

  it('skips corrupt profile files in list and still allows deleting them', async () => {
    await mkdir(profilesDirectory, { recursive: true });
    await writeFile(profileFile('broken'), '{', 'utf8');
    const warnings: ProfileStoreWarning[] = [];
    const store = makeStore({ onWarning: (warning) => warnings.push(warning) });
    const valid = await store.create({ name: 'Valid' });

    const profiles = await store.list();

    expect(profiles.map((profile) => profile.id)).toEqual([
      ...builtins.map((profile) => profile.id),
      valid.id,
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.fileName).toBe('broken.json');

    await store.delete('broken', { confirm: true });
    await expect(readdir(profilesDirectory)).resolves.toEqual([`${valid.id}.json`]);
  });

  it('slugifies accents and protects reserved Windows names', () => {
    expect(slugifyProfileName('Café Déjà Vu')).toBe('cafe-deja-vu');
    expect(slugifyProfileName('CON')).toBe('con-profile');
    expect(slugifyProfileName('   ')).toBe('profile');
  });

  it('rejects a missing profile with NotFoundError', async () => {
    const store = makeStore();

    await expect(store.get('missing')).rejects.toBeInstanceOf(NotFoundError);
  });
});
