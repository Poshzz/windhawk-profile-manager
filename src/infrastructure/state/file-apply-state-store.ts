import { basename, dirname, join } from 'node:path';
import {
  parseAppState,
  parseSettingsPatch,
  type AppState,
  type SettingsPatch,
} from '@shared/domain';
import { EnvironmentError } from '@shared/errors';
import type { ApplyStateRecord, ApplyStateStore } from '@core/state/apply-state-store';
import {
  AtomicJsonFile,
  isNotFoundError,
  NodeAtomicFileSystem,
  type AtomicFileSystem,
} from '../storage/atomic-json-file';

const STATE_FILE_NAME = 'state.json';

export function defaultStatePath(): string {
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData === undefined || localAppData.length === 0) {
    throw new EnvironmentError('LOCALAPPDATA is not set; the app state file cannot be located.');
  }
  return join(localAppData, 'WindhawkProfileManager', STATE_FILE_NAME);
}

export interface FileApplyStateStoreOptions {
  readonly path?: string;
  readonly fileSystem?: AtomicFileSystem;
}

/**
 * Records only the machine-specific apply outcome for now. Settings and
 * first-run state will be layered onto the same file by the settings ticket.
 */
export class FileApplyStateStore implements ApplyStateStore {
  private readonly path: string;
  private readonly files: AtomicJsonFile;
  private mutationQueue: Promise<unknown> = Promise.resolve();

  constructor(options: FileApplyStateStoreOptions = {}) {
    this.path = options.path ?? defaultStatePath();
    this.files = new AtomicJsonFile(
      dirname(this.path),
      options.fileSystem ?? new NodeAtomicFileSystem(),
    );
  }

  async get(): Promise<AppState> {
    try {
      return parseAppState(await this.files.read(basename(this.path)));
    } catch (error) {
      if (isNotFoundError(error)) return parseAppState({ schemaVersion: 1 });
      throw error;
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationQueue.then(operation, operation);
    this.mutationQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async recordApply(input: ApplyStateRecord): Promise<void> {
    await this.enqueue(async () => {
      const current = await this.get();
      const next = parseAppState({
        ...current,
        activeProfileId: input.profileId,
        lastAppliedAt: input.appliedAt,
        lastRunId: input.runId,
      });
      await this.files.write(basename(this.path), next);
    });
  }

  async updateSettings(patch: SettingsPatch): Promise<AppState> {
    const validated = parseSettingsPatch(patch);
    return this.enqueue(async () => {
      const current = await this.get();
      const next = parseAppState({ ...current, ...validated });
      await this.files.write(basename(this.path), next);
      return next;
    });
  }

  async completeFirstRun(): Promise<AppState> {
    return this.enqueue(async () => {
      const current = await this.get();
      if (current.firstRunCompleted) return current;
      const next = parseAppState({ ...current, firstRunCompleted: true });
      await this.files.write(basename(this.path), next);
      return next;
    });
  }
}
