import type { CommandResult, CommandRunOptions, CommandRunner } from '@core/process/command-runner';

export interface RecordedCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly options: CommandRunOptions;
}

export type CommandHandler = (command: RecordedCommand) => Promise<CommandResult> | CommandResult;

export class FakeCommandRunner implements CommandRunner {
  readonly calls: RecordedCommand[] = [];
  handler: CommandHandler | null = null;

  async run(
    executable: string,
    args: readonly string[],
    options: CommandRunOptions = {},
  ): Promise<CommandResult> {
    const command: RecordedCommand = {
      executable,
      args: [...args],
      options,
    };
    this.calls.push(command);

    if (this.handler !== null) return this.handler(command);
    return { exitCode: 0, stdout: '', stderr: '' };
  }
}
