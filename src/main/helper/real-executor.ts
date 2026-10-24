import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  SnapshotCaptureContext,
  SnapshotPort,
  SnapshotRecord,
} from '@core/executor/snapshot-port';
import { ApplyExecutor } from '@core/executor/apply-executor';
import type { ExecutionPlan, SnapshotTrigger } from '@shared/domain';
import { HELPER_WATCHDOG_MS } from '@shared/constants';
import { ValidationError } from '@shared/errors';
import type { EnvironmentProbe } from '@core/environment/environment-probe';
import { FileJournalStore } from '@infra/journal/file-journal-store';
import { NodeCommandRunner } from '@infra/process/node-command-runner';
import { NodeProcessLauncher } from '@infra/process/node-process-launcher';
import { WindowsProcessController } from '@infra/process/windows-process-controller';
import { WindowsRegistryGateway } from '@infra/registry/windows-registry-gateway';
import { WindowsServiceController } from '@infra/services/windows-service-controller';
import { NodeEnvironmentFileSystem } from '@infra/environment/node-environment-file-system';
import { RegExeSystemRegistryReader } from '@infra/environment/reg-exe-system-registry-reader';
import {
  DEFAULT_AUTOMATIC_RETENTION,
  DEFAULT_SNAPSHOT_APP_VERSION,
  SnapshotStore,
} from '@infra/snapshots/snapshot-store';
import { WindowsEnvironmentProbe } from '@infra/environment/windows-environment-probe';
import {
  NodeSnapshotFileSystem,
  WindowsUserOnlyAcl,
  type SnapshotFileSystem,
} from '@infra/storage/snapshot-file-system';
import type { RegistryGateway } from '@core/registry/registry-gateway';
import type { JournalStore } from '@core/journal/journal-store';

/** Binds SnapshotStore's generated naming to the absolute path in the plan. */
class PlannedSnapshotPort implements SnapshotPort {
  constructor(
    private readonly store: SnapshotStore,
    private readonly plan: ExecutionPlan,
  ) {}

  async capture(
    trigger: SnapshotTrigger,
    context: SnapshotCaptureContext,
    options?: { readonly prune?: boolean },
  ): Promise<SnapshotRecord> {
    return this.store.captureAt(
      trigger,
      context,
      {
        id: this.plan.snapshotId,
        registryPath: this.plan.paths.snapshotRegistry,
      },
      options,
    );
  }

  async get(id: string): Promise<SnapshotRecord> {
    return this.store.get(id);
  }

  async prune(): Promise<unknown> {
    return this.store.prune();
  }
}

/**
 * The helper's snapshot store must grant the non-elevated invoking account, not
 * the elevated identity. Retention comes from the hashed plan so a setting the
 * user persisted in the GUI is honored by this separate process.
 */
export function createHelperSnapshotStore(
  plan: ExecutionPlan,
  gateway: RegistryGateway,
  journalStore: Pick<JournalStore, 'activeSnapshotIds'>,
  fileSystem?: SnapshotFileSystem,
): SnapshotStore {
  let snapshotFileSystem = fileSystem;
  if (snapshotFileSystem === undefined) {
    if (plan.invokingUser === undefined) {
      throw new ValidationError(
        'The helper plan does not bind the invoking Windows account; rebuild the plan before running it.',
      );
    }
    snapshotFileSystem = new NodeSnapshotFileSystem(
      new WindowsUserOnlyAcl(new NodeCommandRunner(), plan.invokingUser),
    );
  }

  return new SnapshotStore({
    gateway,
    directory: dirname(plan.paths.snapshotRegistry),
    fileSystem: snapshotFileSystem,
    activeJournalSnapshotIds: () => journalStore.activeSnapshotIds(),
    automaticRetentionLimit: plan.snapshotRetention ?? DEFAULT_AUTOMATIC_RETENTION,
  });
}

export async function createRealHelperExecutor(
  plan: ExecutionPlan,
  appVersion = DEFAULT_SNAPSHOT_APP_VERSION,
): Promise<ApplyExecutor> {
  if (process.arch !== 'x64') {
    throw new ValidationError('The elevated helper must run as an x64 process.');
  }

  const runner = new NodeCommandRunner();
  const files = new NodeEnvironmentFileSystem();
  const service = new WindowsServiceController({ runner });
  const registry = new WindowsRegistryGateway({
    commandRunner: runner,
    tempDirectory: join(tmpdir(), 'WindhawkProfileManager', 'helper-registry'),
  });
  const processController = new WindowsProcessController({
    runner,
    launcher: new NodeProcessLauncher(),
    files,
  });
  const probe: EnvironmentProbe = new WindowsEnvironmentProbe({
    registry,
    systemRegistry: new RegExeSystemRegistryReader({ runner }),
    service,
    process: processController,
    files,
  });
  const environment = await probe.probe();

  const journalStore = new FileJournalStore({ path: plan.paths.journal, runId: plan.runId });
  const snapshotStore = createHelperSnapshotStore(plan, registry, journalStore);

  return new ApplyExecutor({
    snapshotStore: new PlannedSnapshotPort(snapshotStore, plan),
    registry,
    service,
    journalStore,
    environment,
    appVersion,
    watchdogMs: HELPER_WATCHDOG_MS,
    mergeApplyBatches: true,
  });
}
