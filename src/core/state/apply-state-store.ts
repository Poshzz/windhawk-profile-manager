export interface ApplyStateRecord {
  readonly profileId: string | null;
  readonly appliedAt: string;
  readonly runId: string;
}

export interface ApplyStateStore {
  recordApply(input: ApplyStateRecord): Promise<void>;
}

export class FakeApplyStateStore implements ApplyStateStore {
  readonly records: ApplyStateRecord[] = [];
  failWith: Error | null = null;

  async recordApply(input: ApplyStateRecord): Promise<void> {
    if (this.failWith !== null) throw this.failWith;
    this.records.push(input);
  }
}
