import type { ServiceInfo, ServiceState } from '@shared/domain';
import { EnvironmentError } from '@shared/errors';

export interface EnsureServiceRunningResult {
  readonly service: ServiceInfo;
  readonly started: boolean;
}

export interface ServiceController {
  readonly name: string;
  status(): Promise<ServiceInfo>;
  ensureRunning(): Promise<EnsureServiceRunningResult>;
  imagePath(): Promise<string | null>;
}

export function parseScQuery(stdout: string, fallbackName: string): ServiceInfo {
  const reportedName = /^\s*SERVICE_NAME\s*:\s*(.+)$/im.exec(stdout)?.[1]?.trim();
  const name = reportedName !== undefined && reportedName.length > 0 ? reportedName : fallbackName;

  if (/does not exist|FAILED\s+1060/i.test(stdout)) {
    return { name, state: 'missing' };
  }

  const codeText = /^\s*STATE\s*:\s*(\d+)/im.exec(stdout)?.[1];
  if (codeText === undefined) return { name, state: 'unknown' };

  const code = Number(codeText);
  const state: ServiceState = code === 4 ? 'running' : code === 1 ? 'stopped' : 'unknown';
  return { name, state };
}

export function parseScImagePath(stdout: string): string | null {
  const raw = /^\s*BINARY_PATH_NAME\s*:\s*(.+)$/im.exec(stdout)?.[1]?.trim();
  if (raw === undefined || raw.length === 0) return null;

  if (raw.startsWith('"')) {
    const end = raw.indexOf('"', 1);
    return end > 1 ? raw.slice(1, end) : null;
  }

  return /^(.+?\.exe)(?:\s|$)/i.exec(raw)?.[1] ?? null;
}

export interface FakeServiceControllerOptions {
  readonly name?: string;
  readonly state?: ServiceState;
  readonly imagePath?: string | null;
  readonly stateAfterStart?: ServiceState;
  readonly transitionDelayMs?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export class FakeServiceController implements ServiceController {
  readonly name: string;
  private current: ServiceState;
  private executablePath: string | null;
  private stateAfterStart: ServiceState;
  private transitionDelayMs: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  statusCalls = 0;
  startCalls = 0;
  failStatus: Error | null = null;
  failStart: Error | null = null;

  constructor(options: FakeServiceControllerOptions = {}) {
    this.name = options.name ?? 'Windhawk';
    this.current = options.state ?? 'running';
    this.executablePath = options.imagePath ?? null;
    this.stateAfterStart = options.stateAfterStart ?? 'running';
    this.transitionDelayMs = options.transitionDelayMs ?? 0;
    this.sleep =
      options.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  get state(): ServiceState {
    return this.current;
  }

  setState(state: ServiceState): void {
    this.current = state;
  }

  setImagePath(path: string | null): void {
    this.executablePath = path;
  }

  setStateAfterStart(state: ServiceState): void {
    this.stateAfterStart = state;
  }

  setTransitionDelay(milliseconds: number): void {
    this.transitionDelayMs = milliseconds;
  }

  async status(): Promise<ServiceInfo> {
    this.statusCalls += 1;
    if (this.failStatus !== null) throw this.failStatus;
    return { name: this.name, state: this.current };
  }

  async ensureRunning(): Promise<EnsureServiceRunningResult> {
    const current = await this.status();
    if (current.state === 'running') return { service: current, started: false };
    if (current.state === 'missing') {
      throw new EnvironmentError(`The ${this.name} service is not installed.`);
    }

    this.startCalls += 1;
    if (this.failStart !== null) throw this.failStart;
    if (this.transitionDelayMs > 0) await this.sleep(this.transitionDelayMs);
    this.current = this.stateAfterStart;
    return { service: { name: this.name, state: this.current }, started: true };
  }

  async imagePath(): Promise<string | null> {
    return this.executablePath;
  }
}
