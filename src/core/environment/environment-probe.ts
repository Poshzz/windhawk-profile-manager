import { parseEnvironment, type Environment } from '@shared/domain';

export interface EnvironmentProbe {
  probe(): Promise<Environment>;
}

export class FakeEnvironmentProbe implements EnvironmentProbe {
  private environment: Environment;
  failWith: Error | null = null;
  probeCalls = 0;

  constructor(environment: Environment) {
    this.environment = parseEnvironment(environment);
  }

  setEnvironment(environment: Environment): void {
    this.environment = parseEnvironment(environment);
  }

  async probe(): Promise<Environment> {
    this.probeCalls += 1;
    if (this.failWith !== null) throw this.failWith;
    return structuredClone(this.environment);
  }
}
