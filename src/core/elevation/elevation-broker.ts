import type { ApplyResult, ExecutionPlan } from '@shared/domain';

export interface ElevationRunOptions {
  readonly dryRun?: boolean;
}

/**
 * The main-process face of the elevated helper. Implementations launch the fixed
 * per-machine helper, never an executable or command line supplied by a profile
 * or the renderer.
 */
export interface ElevationBroker {
  run(plan: ExecutionPlan, options?: ElevationRunOptions): Promise<ApplyResult>;
  /** Optional service-only elevation path used by the Home action. */
  startService?(): Promise<void>;
}

export class FakeElevationBroker implements ElevationBroker {
  readonly calls: Array<{
    readonly plan: ExecutionPlan;
    readonly options: ElevationRunOptions;
  }> = [];

  constructor(
    private readonly handler: (
      plan: ExecutionPlan,
      options: ElevationRunOptions,
    ) => Promise<ApplyResult>,
  ) {}

  async run(plan: ExecutionPlan, options: ElevationRunOptions = {}): Promise<ApplyResult> {
    this.calls.push({ plan, options });
    return this.handler(plan, options);
  }
}
