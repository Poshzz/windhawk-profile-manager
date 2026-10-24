export interface CommandRunOptions {
  readonly timeoutMs?: number;
  readonly cwd?: string;
  /** Environment overrides merged over the parent process environment. */
  readonly env?: NodeJS.ProcessEnv;
  /** Data written to standard input, followed by EOF. Omit to send an empty stream. */
  readonly stdin?: string;
}

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CommandRunner {
  run(
    executable: string,
    args: readonly string[],
    options?: CommandRunOptions,
  ): Promise<CommandResult>;
}
