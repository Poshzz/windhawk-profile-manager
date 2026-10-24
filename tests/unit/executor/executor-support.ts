import { writeFile } from 'node:fs/promises';
import {
  canonicalPlanHashInput,
  parsePlan,
  type ApplyResult,
  type ExecutionPlan,
  type Journal,
  type JournalState,
  type RegistryOp,
  type RegistrySnapshot,
  type RestorePlan,
  type SnapshotTrigger,
} from '@shared/domain';
import { hashCanonical } from '@core/planner/registry-state';
import {
  computeRestoreManagedHash,
  restoreSourceModIds,
  restoreTargetingValues,
} from '@core/planner/restore-state';
import type {
  JournalBeginInput,
  JournalClearOptions,
  JournalStore,
  JournalUpdateOptions,
} from '@core/journal/journal-store';
import type {
  SnapshotCaptureContext,
  SnapshotPort,
  SnapshotRecord,
} from '@core/executor/snapshot-port';
import { FakeRegistryGateway } from '@core/registry/fake-registry-gateway';
import { serializeRegFile } from '@core/registry/reg-codec';
import type { RegistryGateway } from '@core/registry/registry-gateway';
import type { SnapshotAcl } from '@infra/storage/snapshot-file-system';

export class BarrierSnapshotPort implements SnapshotPort {
  private arrivals = 0;
  private release: (() => void) | null = null;

  constructor(
    private readonly inner: SnapshotPort,
    private readonly parties = 2,
  ) {}

  async capture(
    trigger: SnapshotTrigger,
    context: SnapshotCaptureContext,
    options?: { readonly prune?: boolean },
  ): Promise<SnapshotRecord> {
    const record = await this.inner.capture(trigger, context, options);
    this.arrivals += 1;
    if (this.arrivals >= this.parties) {
      this.release?.();
      this.release = null;
      return record;
    }
    await new Promise<void>((resolve) => {
      this.release = resolve;
    });
    return record;
  }

  async get(id: string): Promise<SnapshotRecord> {
    return this.inner.get(id);
  }

  async prune(): Promise<unknown> {
    return this.inner.prune();
  }
}

export class RecordingAcl implements SnapshotAcl {
  readonly calls: { path: string; kind: 'file' | 'directory' }[] = [];

  async apply(path: string, kind: 'file' | 'directory'): Promise<void> {
    this.calls.push({ path, kind });
  }
}

export class ScriptedRegistryGateway implements RegistryGateway {
  readonly inner: FakeRegistryGateway;
  readonly applyCalls: RegistryOp[][] = [];
  readonly exportCalls: string[] = [];
  readonly failApplyCalls = new Set<number>();
  failExport: Error | null = null;
  tamperExport: ((snapshot: RegistrySnapshot) => RegistrySnapshot) | null = null;
  tamperReadAtCall: number | null = null;
  tamperRead: ((snapshot: RegistrySnapshot) => RegistrySnapshot) | null = null;
  readCalls = 0;

  constructor(snapshot: RegistrySnapshot) {
    this.inner = new FakeRegistryGateway({ snapshot });
  }

  async read(): Promise<RegistrySnapshot> {
    this.readCalls += 1;
    const snapshot = await this.inner.read();
    if (this.tamperReadAtCall === this.readCalls && this.tamperRead !== null) {
      const tamper = this.tamperRead;
      this.tamperReadAtCall = null;
      return tamper(snapshot);
    }
    return snapshot;
  }

  async applyOps(ops: RegistryOp[]): Promise<void> {
    const index = this.applyCalls.length;
    this.applyCalls.push(structuredClone(ops));
    if (this.failApplyCalls.has(index)) {
      this.failApplyCalls.delete(index);
      throw new Error(`Injected registry write failure at call ${index}.`);
    }
    await this.inner.applyOps(ops);
  }

  async applyRestoreOps(ops: RegistryOp[]): Promise<void> {
    const index = this.applyCalls.length;
    this.applyCalls.push(structuredClone(ops));
    if (this.failApplyCalls.has(index)) {
      this.failApplyCalls.delete(index);
      throw new Error(`Injected registry write failure at call ${index}.`);
    }
    await this.inner.applyRestoreOps(ops);
  }

  async exportReg(path: string): Promise<void> {
    this.exportCalls.push(path);
    if (this.failExport !== null) {
      const error = this.failExport;
      this.failExport = null;
      throw error;
    }
    let snapshot = await this.inner.read();
    if (this.tamperExport !== null) {
      const tamper = this.tamperExport;
      this.tamperExport = null;
      snapshot = tamper(snapshot);
    }
    await writeFile(path, serializeRegFile(snapshot));
  }

  async reconcile(snapshot: RegistrySnapshot): Promise<void> {
    await this.inner.reconcile(snapshot);
  }

  getSnapshot(): RegistrySnapshot {
    return this.inner.getSnapshot();
  }

  setSnapshot(snapshot: RegistrySnapshot): void {
    this.inner.setSnapshot(snapshot);
  }
}

export class FlakyJournalStore implements JournalStore {
  readonly updateStates: JournalState[] = [];
  failBegin: Error | null = null;
  failUpdateOnceAt: JournalState | null = null;
  failCompleteOnce = false;
  failCompleteAlways = false;

  constructor(readonly inner: JournalStore) {}

  async begin(input: JournalBeginInput): Promise<Journal> {
    if (this.failBegin !== null) {
      const error = this.failBegin;
      this.failBegin = null;
      throw error;
    }
    return this.inner.begin(input);
  }

  async update(state: JournalState, options: JournalUpdateOptions = {}): Promise<Journal> {
    this.updateStates.push(state);
    if (this.failUpdateOnceAt === state) {
      this.failUpdateOnceAt = null;
      throw new Error(`Injected journal update failure at "${state}".`);
    }
    return this.inner.update(state, options);
  }

  async complete(state: JournalState, result: ApplyResult): Promise<Journal> {
    if (this.failCompleteAlways) {
      throw new Error('Injected persistent journal completion failure.');
    }
    if (this.failCompleteOnce) {
      this.failCompleteOnce = false;
      throw new Error('Injected journal completion failure.');
    }
    return this.inner.complete(state, result);
  }

  async read(): Promise<Journal | null> {
    return this.inner.read();
  }

  async clear(options: JournalClearOptions = {}): Promise<void> {
    return this.inner.clear(options);
  }

  async activeSnapshotIds(): Promise<ReadonlySet<string>> {
    return this.inner.activeSnapshotIds();
  }
}

export interface RestorePlanFixtureInput {
  readonly source: {
    readonly metadata: { readonly id: string; readonly registrySha256?: string };
    readonly registry: RegistrySnapshot;
  };
  readonly current: RegistrySnapshot;
  readonly runId?: string;
  readonly snapshotId?: string;
  readonly confirmTargeting?: boolean;
}

export function makeRestorePlanForTest(input: RestorePlanFixtureInput): RestorePlan {
  const sourceIds = restoreSourceModIds(input.source.registry);
  const targetingValues = restoreTargetingValues(input.source.registry);
  const runId = input.runId ?? 'run-restore-2026-10-22T20-10-00-000Z';
  const snapshotId = input.snapshotId ?? '2026-10-22T20-10-00-000Z';
  const appData = 'C:\\Users\\Test\\AppData\\Local\\WindhawkProfileManager';
  const base = {
    schemaVersion: 1 as const,
    kind: 'restore' as const,
    runId,
    snapshotId,
    profileId: null,
    profileRevision: 0,
    beforeHash: computeRestoreManagedHash(input.current, sourceIds),
    actions: { rainmeter: 'unchanged' as const, restartExplorer: 'ask' as const },
    sourceSnapshotId: input.source.metadata.id,
    ...(input.source.metadata.registrySha256 === undefined
      ? {}
      : { sourceSnapshotSha256: input.source.metadata.registrySha256 }),
    targetingValues,
    targetingConfirmed: input.confirmTargeting === true,
    summary: { setValues: 0, deleteValues: 0, touchedMods: 0, skippedMods: [] },
    paths: {
      plan: `C:\\ProgramData\\WindhawkProfileManager\\runs\\${runId}\\plan.json`,
      snapshotRegistry: `${appData}\\snapshots\\${snapshotId}.reg`,
      journal: `${appData}\\journal.json`,
      result: `C:\\ProgramData\\WindhawkProfileManager\\runs\\${runId}\\result.json`,
      sourceSnapshotRegistry: `${appData}\\snapshots\\${input.source.metadata.id}.reg`,
    },
    warnings: [],
    planHash: `sha256:${'0'.repeat(64)}`,
  };

  const planHash = hashCanonical(canonicalPlanHashInput(base));
  return parsePlan({ ...base, planHash }) as RestorePlan;
}

export function flattenOps(calls: readonly RegistryOp[][]): RegistryOp[] {
  return calls.flatMap((call) => call);
}

export function withoutSettingsChangeTime(snapshot: RegistrySnapshot): RegistrySnapshot {
  return {
    ...snapshot,
    keys: snapshot.keys.map((key) => ({
      path: key.path,
      values: key.values.filter((value) => value.name.toLowerCase() !== 'settingschangetime'),
    })),
  };
}

export function planHashForTest(plan: ExecutionPlan): string {
  return hashCanonical(canonicalPlanHashInput(plan));
}
