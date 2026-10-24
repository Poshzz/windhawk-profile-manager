import { applyMutationsToSnapshot } from './snapshot-operations';
import { assertApplyOpsAllowed } from './apply-allowlist';
import { createEmptyRegistrySnapshot, type RegistryGateway } from './registry-gateway';
import {
  parseRestoreRegistryOps,
  planReconcileOperations,
  type RegistryMutation,
} from './reconcile';
import {
  isAbsoluteWindowsPath,
  parseRegistryOps,
  parseRegistrySnapshot,
  type RegistryOp,
  type RegistrySnapshot,
} from '@shared/domain';
import { ValidationError } from '@shared/errors';

export interface FakeRegistryGatewayOptions {
  readonly snapshot?: RegistrySnapshot;
  readonly capturedAt?: string;
  readonly now?: () => Date;
}

export class FakeRegistryGateway implements RegistryGateway {
  private state: RegistrySnapshot;

  readonly applyCalls: RegistryOp[][] = [];
  readonly restoreApplyCalls: RegistryOp[][] = [];
  readonly reconcileCalls: RegistrySnapshot[] = [];
  readonly exportedPaths: string[] = [];
  readonly mutations: RegistryMutation[] = [];
  readCalls = 0;

  failRead: Error | null = null;
  failWriteAt: number | null = null;

  constructor(options: FakeRegistryGatewayOptions = {}) {
    this.state =
      options.snapshot === undefined
        ? createEmptyRegistrySnapshot(
            options.capturedAt ?? (options.now?.() ?? new Date()).toISOString(),
          )
        : parseRegistrySnapshot(options.snapshot);
  }

  getSnapshot(): RegistrySnapshot {
    return structuredClone(this.state);
  }

  setSnapshot(snapshot: RegistrySnapshot): void {
    this.state = parseRegistrySnapshot(snapshot);
  }

  async read(): Promise<RegistrySnapshot> {
    this.readCalls += 1;
    if (this.failRead !== null) throw this.failRead;
    return structuredClone(this.state);
  }

  async applyOps(ops: RegistryOp[]): Promise<void> {
    const parsed = parseRegistryOps(ops);
    assertApplyOpsAllowed(parsed);
    this.applyCalls.push(structuredClone(parsed));
    await this.writeMutations(parsed);
  }

  async applyRestoreOps(ops: RegistryOp[]): Promise<void> {
    const parsed = parseRegistryOps(ops);
    const mutations: RegistryMutation[] = parsed.map((operation) =>
      operation.kind === 'set'
        ? {
            kind: 'set',
            path: operation.path,
            name: operation.name,
            value: operation.value,
          }
        : {
            kind: 'deleteValue',
            path: operation.path,
            name: operation.name,
          },
    );
    const restore = parseRestoreRegistryOps(mutations);
    this.restoreApplyCalls.push(structuredClone(parsed));
    await this.writeMutations(restore);
  }

  async exportReg(path: string): Promise<void> {
    if (!isAbsoluteWindowsPath(path) || !path.toLowerCase().endsWith('.reg')) {
      throw new ValidationError('Expected an absolute path to a .reg file.');
    }
    this.exportedPaths.push(path);
  }

  async reconcile(snapshot: RegistrySnapshot): Promise<void> {
    const desired = parseRegistrySnapshot(snapshot);
    this.reconcileCalls.push(structuredClone(desired));
    const current = await this.read();
    const operations = planReconcileOperations(desired, current, {
      requireRestorableCurrent: true,
    });
    const parsed = parseRestoreRegistryOps(operations);
    await this.writeMutations(parsed);
  }

  private async writeMutations(mutations: readonly RegistryMutation[]): Promise<void> {
    for (const [index, mutation] of mutations.entries()) {
      if (this.failWriteAt === index) {
        throw new Error('Simulated registry write failure.');
      }
      this.mutations.push(structuredClone(mutation));
      this.state = applyMutationsToSnapshot(this.state, [mutation]);
    }
  }
}
