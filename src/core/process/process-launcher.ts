export interface ProcessLauncher {
  launch(executable: string, args?: readonly string[]): Promise<void>;
}

export interface LaunchedProcess {
  readonly executable: string;
  readonly args: readonly string[];
}

export class FakeProcessLauncher implements ProcessLauncher {
  readonly calls: LaunchedProcess[] = [];
  failWith: Error | null = null;
  failAt: number | null = null;

  async launch(executable: string, args: readonly string[] = []): Promise<void> {
    if (this.failWith !== null && (this.failAt === null || this.failAt === this.calls.length)) {
      throw this.failWith;
    }
    this.calls.push({ executable, args: [...args] });
  }
}
