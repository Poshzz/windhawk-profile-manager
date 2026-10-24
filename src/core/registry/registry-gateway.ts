import type { RegistryOp, RegistrySnapshot } from '@shared/domain';

export interface RegistryGateway {
  read(): Promise<RegistrySnapshot>;
  applyOps(ops: RegistryOp[]): Promise<void>;
  applyRestoreOps(ops: RegistryOp[]): Promise<void>;
  exportReg(path: string): Promise<void>;
  reconcile(snapshot: RegistrySnapshot): Promise<void>;
}

export function createEmptyRegistrySnapshot(capturedAt: string): RegistrySnapshot {
  return {
    schemaVersion: 1,
    capturedAt,
    registryView: '64-bit',
    keys: [],
  };
}
