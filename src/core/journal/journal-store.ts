import type { ApplyResult, ExecutionPlan, Journal, JournalState } from '@shared/domain';

export interface JournalBeginInput {
  readonly plan: ExecutionPlan;
  readonly snapshotId: string;
  readonly startedAt: string;
}

export interface JournalUpdateOptions {
  readonly result?: ApplyResult | null;
  /** Compare-and-set guard for crash-recovery finishing. */
  readonly expectedState?: JournalState;
}

export interface JournalClearOptions {
  readonly force?: boolean;
}

export interface JournalStore {
  begin(input: JournalBeginInput): Promise<Journal>;
  update(state: JournalState, options?: JournalUpdateOptions): Promise<Journal>;
  complete(state: JournalState, result: ApplyResult): Promise<Journal>;
  read(): Promise<Journal | null>;
  clear(options?: JournalClearOptions): Promise<void>;
  activeSnapshotIds(): Promise<ReadonlySet<string>>;
  /** Optional because lightweight test doubles do not own a durable lease. */
  isRunLive?(): Promise<boolean>;
}
