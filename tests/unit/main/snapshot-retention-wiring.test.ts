import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildPlan } from '@core/planner/apply-planner';
import { FileJournalStore } from '@infra/journal/file-journal-store';
import { FileApplyStateStore } from '@infra/state/file-apply-state-store';
import { NodeSnapshotFileSystem, type SnapshotAcl } from '@infra/storage/snapshot-file-system';
import { createGuiSnapshotStore } from '../../../src/main/home-service';
import { createHelperSnapshotStore } from '../../../src/main/helper/real-executor';
import {
  makeEnvironment,
  makeProfile,
  makeSnapshot,
  modKeys,
  planOptions,
} from '../planner/support';
import { ScriptedRegistryGateway } from '../executor/executor-support';

class RecordingAcl implements SnapshotAcl {
  readonly calls: { path: string; kind: 'file' | 'directory' }[] = [];

  async apply(path: string, kind: 'file' | 'directory'): Promise<void> {
    this.calls.push({ path, kind });
  }
}

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'wpm-retention-'));
  temporaryDirectories.push(directory);
  return directory;
}

function snapshot() {
  return makeSnapshot([
    ...modKeys('windows-11-taskbar-styler', {
      settings: { TaskbarHeight: { type: 'dword', value: 40 } },
    }),
  ]);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }).catch(() => undefined)),
  );
});

describe('persisted snapshot retention wiring', () => {
  it('loads the GUI store limit from the persisted app state', async () => {
    const root = await temporaryDirectory();
    const statePath = join(root, 'state.json');
    await new FileApplyStateStore({ path: statePath }).updateSettings({ snapshotRetention: 5 });
    const state = await new FileApplyStateStore({ path: statePath }).get();

    const journalStore = new FileJournalStore({ path: join(root, 'journal.json') });
    let tick = Date.parse('2026-10-24T10:00:00.000Z');
    const store = createGuiSnapshotStore({
      gateway: new ScriptedRegistryGateway(snapshot()),
      journalStore,
      automaticRetentionLimit: state.snapshotRetention,
      directory: join(root, 'snapshots'),
      fileSystem: new NodeSnapshotFileSystem(new RecordingAcl()),
      now: () => new Date((tick += 1000)),
    });

    for (let index = 0; index < 6; index += 1) {
      await store.capture('pre-apply', {
        environment: makeEnvironment(),
        profileId: 'mac-blur-glass',
      });
    }

    await expect(store.list()).resolves.toHaveLength(5);
  });

  it('refuses to fall back to the elevated process identity for snapshot ACLs', async () => {
    const root = await temporaryDirectory();
    const runId = 'run-no-user-2026-10-24T10-00-00-000Z';
    const snapshotId = '2026-10-24T10-00-00-000Z';
    const plan = buildPlan(
      makeProfile(),
      snapshot(),
      makeEnvironment(),
      planOptions({
        runId,
        snapshotId,
        invokingUser: undefined,
        paths: {
          plan: `C:\\ProgramData\\WindhawkProfileManager\\runs\\${runId}\\plan.json`,
          snapshotRegistry: join(root, 'snapshots', `${snapshotId}.reg`),
          journal: join(root, 'journal.json'),
          result: `C:\\ProgramData\\WindhawkProfileManager\\runs\\${runId}\\result.json`,
        },
      }),
    );

    expect(() =>
      createHelperSnapshotStore(
        plan,
        new ScriptedRegistryGateway(snapshot()),
        new FileJournalStore({ path: join(root, 'journal.json') }),
      ),
    ).toThrow(/invoking Windows account/i);
  });

  it('gives the helper store the retention limit from the hashed plan', async () => {
    const root = await temporaryDirectory();
    const statePath = join(root, 'state.json');
    await new FileApplyStateStore({ path: statePath }).updateSettings({ snapshotRetention: 5 });
    const state = await new FileApplyStateStore({ path: statePath }).get();

    const runId = 'run-retention-2026-10-24T10-00-00-000Z';
    const snapshotId = '2026-10-24T10-00-00-000Z';
    const plan = buildPlan(
      makeProfile(),
      snapshot(),
      makeEnvironment(),
      planOptions({
        runId,
        snapshotId,
        snapshotRetentionLimit: state.snapshotRetention,
        paths: {
          plan: `C:\\ProgramData\\WindhawkProfileManager\\runs\\${runId}\\plan.json`,
          snapshotRegistry: join(root, 'snapshots', `${snapshotId}.reg`),
          journal: join(root, 'journal.json'),
          result: `C:\\ProgramData\\WindhawkProfileManager\\runs\\${runId}\\result.json`,
        },
      }),
    );

    const journalStore = new FileJournalStore({ path: join(root, 'journal.json') });
    const store = createHelperSnapshotStore(
      plan,
      new ScriptedRegistryGateway(snapshot()),
      journalStore,
      new NodeSnapshotFileSystem(new RecordingAcl()),
    );

    for (let index = 0; index < 6; index += 1) {
      await store.capture('pre-apply', {
        environment: makeEnvironment(),
        profileId: null,
      });
    }

    await expect(store.list()).resolves.toHaveLength(5);
  });
});
