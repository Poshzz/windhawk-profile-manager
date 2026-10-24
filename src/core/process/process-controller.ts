import type { RainmeterInfo } from '@shared/domain';

export interface ExplorerRestartOutcome {
  readonly attempted: boolean;
  readonly succeeded: boolean;
  readonly detail: string;
}

export interface ExplorerRestartResult {
  readonly kill: ExplorerRestartOutcome;
  readonly start: ExplorerRestartOutcome;
  readonly shellRestarted: boolean;
}

export interface ProcessController {
  rainmeterStatus(): Promise<RainmeterInfo>;
  startRainmeter(): Promise<void>;
  quitRainmeter(): Promise<void>;
  restartExplorer(): Promise<ExplorerRestartResult>;
}

const DEFAULT_RAINMETER: RainmeterInfo = {
  installed: false,
  running: false,
  path: null,
};

const DEFAULT_EXPLORER_RESULT: ExplorerRestartResult = {
  kill: { attempted: false, succeeded: false, detail: 'Explorer was not restarted.' },
  start: { attempted: false, succeeded: false, detail: 'Explorer was not restarted.' },
  shellRestarted: false,
};

export interface FakeProcessControllerOptions {
  readonly rainmeter?: RainmeterInfo;
  readonly explorerResult?: ExplorerRestartResult;
}

export class FakeProcessController implements ProcessController {
  private rainmeter: RainmeterInfo;
  explorerResult: ExplorerRestartResult;
  rainmeterStatusCalls = 0;
  startRainmeterCalls = 0;
  quitRainmeterCalls = 0;
  restartExplorerCalls = 0;
  failRainmeterStatus: Error | null = null;
  failStartRainmeter: Error | null = null;
  failQuitRainmeter: Error | null = null;
  failRestartExplorer: Error | null = null;

  constructor(options: FakeProcessControllerOptions = {}) {
    this.rainmeter = options.rainmeter ?? DEFAULT_RAINMETER;
    this.explorerResult = options.explorerResult ?? DEFAULT_EXPLORER_RESULT;
  }

  setRainmeter(info: RainmeterInfo): void {
    this.rainmeter = info;
  }

  async rainmeterStatus(): Promise<RainmeterInfo> {
    this.rainmeterStatusCalls += 1;
    if (this.failRainmeterStatus !== null) throw this.failRainmeterStatus;
    return { ...this.rainmeter };
  }

  async startRainmeter(): Promise<void> {
    this.startRainmeterCalls += 1;
    if (this.failStartRainmeter !== null) throw this.failStartRainmeter;
  }

  async quitRainmeter(): Promise<void> {
    this.quitRainmeterCalls += 1;
    if (this.failQuitRainmeter !== null) throw this.failQuitRainmeter;
  }

  async restartExplorer(): Promise<ExplorerRestartResult> {
    this.restartExplorerCalls += 1;
    if (this.failRestartExplorer !== null) throw this.failRestartExplorer;
    return structuredClone(this.explorerResult);
  }
}
