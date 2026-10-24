import type {
  Environment,
  RegistrySnapshot,
  SnapshotMetadata,
  SnapshotTrigger,
} from '@shared/domain';

export interface SnapshotRecord {
  readonly metadata: SnapshotMetadata;
  readonly registry: RegistrySnapshot;
}

export interface SnapshotCaptureContext {
  readonly environment: Environment;
  readonly profileId?: string | null;
  readonly appVersion?: string;
  readonly registryView?: '64-bit';
}

export interface SnapshotCaptureOptions {
  /** The executor defers retention until the journal protects the new snapshot. */
  readonly prune?: boolean;
}

/** The part of SnapshotStore the executor depends on. */
export interface SnapshotPort {
  capture(
    trigger: SnapshotTrigger,
    context: SnapshotCaptureContext,
    options?: SnapshotCaptureOptions,
  ): Promise<SnapshotRecord>;
  get(id: string): Promise<SnapshotRecord>;
  prune(): Promise<unknown>;
}
