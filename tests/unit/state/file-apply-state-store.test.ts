import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseAppState } from '@shared/domain';
import { FileApplyStateStore } from '@infra/state/file-apply-state-store';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function storeFixture(): Promise<{
  directory: string;
  path: string;
  store: FileApplyStateStore;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'wpm-state-'));
  directories.push(directory);
  const path = join(directory, 'state.json');
  return { directory, path, store: new FileApplyStateStore({ path }) };
}

describe('FileApplyStateStore', () => {
  it('returns defaults when no state file exists', async () => {
    const { store } = await storeFixture();
    await expect(store.get()).resolves.toEqual(
      parseAppState({
        schemaVersion: 1,
        activeProfileId: null,
        lastAppliedAt: null,
        lastRunId: null,
        firstRunCompleted: false,
        language: 'system',
        appearance: 'system',
        explorerRestart: 'ask',
        snapshotRetention: 20,
      }),
    );
  });

  it('records the active profile and preserves unrelated settings', async () => {
    const { path, store } = await storeFixture();
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        activeProfileId: 'old',
        lastAppliedAt: null,
        lastRunId: null,
        firstRunCompleted: true,
        language: 'th',
        appearance: 'dark',
        explorerRestart: 'never',
        snapshotRetention: 30,
      }),
      'utf8',
    );

    await store.recordApply({
      profileId: 'mac-blur-glass',
      appliedAt: '2026-10-22T20:02:20.000Z',
      runId: 'run-2026-10-22T20-02-14-123Z',
    });

    await expect(store.get()).resolves.toMatchObject({
      activeProfileId: 'mac-blur-glass',
      lastAppliedAt: '2026-10-22T20:02:20.000Z',
      lastRunId: 'run-2026-10-22T20-02-14-123Z',
      firstRunCompleted: true,
      language: 'th',
      appearance: 'dark',
      explorerRestart: 'never',
      snapshotRetention: 30,
    });
  });

  it('clears the active profile after a restore', async () => {
    const { store } = await storeFixture();
    await store.recordApply({
      profileId: 'mac-blur-glass',
      appliedAt: '2026-10-22T20:02:20.000Z',
      runId: 'run-1',
    });
    await store.recordApply({
      profileId: null,
      appliedAt: '2026-10-22T20:03:20.000Z',
      runId: 'run-2',
    });

    await expect(store.get()).resolves.toMatchObject({
      activeProfileId: null,
      lastRunId: 'run-2',
    });
  });

  it('persists settings patches and completes first run', async () => {
    const { store } = await storeFixture();

    await expect(
      store.updateSettings({
        language: 'th',
        appearance: 'dark',
        explorerRestart: 'always',
        snapshotRetention: 45,
      }),
    ).resolves.toMatchObject({
      language: 'th',
      appearance: 'dark',
      explorerRestart: 'always',
      snapshotRetention: 45,
    });
    await store.completeFirstRun();
    await store.completeFirstRun();

    await expect(store.get()).resolves.toMatchObject({
      firstRunCompleted: true,
      language: 'th',
      appearance: 'dark',
      explorerRestart: 'always',
      snapshotRetention: 45,
    });
  });

  it('serializes concurrent settings updates without losing fields', async () => {
    const { store } = await storeFixture();

    await Promise.all([
      store.updateSettings({ language: 'th' }),
      store.updateSettings({ appearance: 'dark' }),
      store.recordApply({
        profileId: 'mac-blur-glass',
        appliedAt: '2026-10-22T20:02:20.000Z',
        runId: 'run-1',
      }),
    ]);

    await expect(store.get()).resolves.toMatchObject({
      language: 'th',
      appearance: 'dark',
      activeProfileId: 'mac-blur-glass',
    });
  });

  it('rejects an out-of-range retention patch without writing', async () => {
    const { store } = await storeFixture();

    await expect(store.updateSettings({ snapshotRetention: 51 })).rejects.toThrow();
    await expect(store.get()).resolves.toMatchObject({ snapshotRetention: 20 });
  });

  it('rejects a malformed existing state file instead of overwriting it', async () => {
    const { path, store } = await storeFixture();
    await writeFile(path, JSON.stringify({ schemaVersion: 1, language: 'xx' }), 'utf8');
    await expect(
      store.recordApply({ profileId: null, appliedAt: '2026-10-22T20:02:20.000Z', runId: 'run' }),
    ).rejects.toThrow();
  });
});
