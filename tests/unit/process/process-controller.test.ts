import { describe, expect, it } from 'vitest';
import { FakeEnvironmentFileSystem } from '@core/environment/environment-file-system';
import { FakeProcessLauncher } from '@core/process/process-launcher';
import {
  parseTasklist,
  parseWmicExecutablePath,
  WindowsProcessController,
} from '@infra/process/windows-process-controller';
import { EnvironmentError } from '@shared/errors';
import { readFixture } from '../domain/test-fixtures';
import { FakeCommandRunner, type CommandHandler } from '../support/fake-command-runner';

const TASKLIST = 'tasklist.exe';
const TASKKILL = 'taskkill.exe';
const WMIC = 'wmic.exe';
const RAINMETER_PATH = 'C:\\Program Files\\Rainmeter\\Rainmeter.exe';
const EXPLORER = 'explorer.exe';
const RAINMETER = 'Rainmeter.exe';

function ok(stdout = '') {
  return { exitCode: 0, stdout, stderr: '' };
}

function tasklistLine(imageName: string, pid: number): string {
  return `"${imageName}","${pid}","Console","1","1,000 K"`;
}

function tasklistOf(...entries: readonly (readonly [string, number])[]): string {
  return `${entries.map(([imageName, pid]) => tasklistLine(imageName, pid)).join('\r\n')}\r\n`;
}

function makeController(
  handler: CommandHandler,
  options: {
    readonly files?: FakeEnvironmentFileSystem;
    readonly shellWaitTimeoutMs?: number;
    readonly sleep?: (milliseconds: number) => Promise<void>;
    readonly now?: () => number;
  } = {},
) {
  const runner = new FakeCommandRunner();
  runner.handler = handler;
  const launcher = new FakeProcessLauncher();
  const files = options.files ?? new FakeEnvironmentFileSystem();
  const controller = new WindowsProcessController({
    runner,
    launcher,
    files,
    programFiles: 'C:\\Program Files',
    tasklistExe: TASKLIST,
    taskkillExe: TASKKILL,
    wmicExe: WMIC,
    timeoutMs: 100,
    shellWaitTimeoutMs: options.shellWaitTimeoutMs ?? 100,
    pollIntervalMs: 1,
    sleep: options.sleep ?? (async () => undefined),
    now: options.now,
  });

  return { controller, runner, launcher, files };
}

function runningRainmeterHandler(): CommandHandler {
  return (command) => {
    if (command.executable === TASKLIST) return ok(readFixture('process/tasklist.csv'));
    if (command.executable === WMIC) return ok(readFixture('process/wmic-rainmeter.txt'));
    return ok();
  };
}

function rainmeterFiles(): FakeEnvironmentFileSystem {
  const files = new FakeEnvironmentFileSystem();
  files.setFile(RAINMETER_PATH, '');
  return files;
}

describe('process output parsing', () => {
  it('parses tasklist CSV rows', () => {
    expect(parseTasklist(readFixture('process/tasklist.csv'))).toEqual([
      { imageName: EXPLORER, pid: 33848 },
      { imageName: RAINMETER, pid: 8448 },
      { imageName: EXPLORER, pid: 26572 },
    ]);
  });

  it('parses the WMIC executable path', () => {
    expect(parseWmicExecutablePath(readFixture('process/wmic-rainmeter.txt'))).toBe(RAINMETER_PATH);
    expect(parseWmicExecutablePath('ExecutablePath=\r\n')).toBeNull();
    expect(parseWmicExecutablePath('')).toBeNull();
  });
});

describe('WindowsProcessController Rainmeter', () => {
  it('reports a running Rainmeter and its executable path', async () => {
    const { controller } = makeController(runningRainmeterHandler(), { files: rainmeterFiles() });

    await expect(controller.rainmeterStatus()).resolves.toEqual({
      installed: true,
      running: true,
      path: RAINMETER_PATH,
    });
  });

  it('detects an installed but stopped Rainmeter from Program Files', async () => {
    const { controller } = makeController(
      (command) =>
        command.executable === TASKLIST
          ? ok(tasklistOf([EXPLORER, 33848]))
          : { exitCode: 1, stdout: '', stderr: '' },
      { files: rainmeterFiles() },
    );

    await expect(controller.rainmeterStatus()).resolves.toEqual({
      installed: true,
      running: false,
      path: RAINMETER_PATH,
    });
  });

  it('reports Rainmeter as missing when no process or install exists', async () => {
    const { controller } = makeController((command) =>
      command.executable === TASKLIST
        ? ok(tasklistOf([EXPLORER, 33848]))
        : { exitCode: 1, stdout: '', stderr: '' },
    );

    await expect(controller.rainmeterStatus()).resolves.toEqual({
      installed: false,
      running: false,
      path: null,
    });
  });

  it('falls back to Program Files when the running process path is unavailable', async () => {
    const { controller } = makeController(
      (command) => {
        if (command.executable === TASKLIST) return ok(tasklistOf([RAINMETER, 8448]));
        return { exitCode: 1, stdout: '', stderr: '' };
      },
      { files: rainmeterFiles() },
    );

    await expect(controller.rainmeterStatus()).resolves.toEqual({
      installed: true,
      running: true,
      path: RAINMETER_PATH,
    });
  });

  it('starts Rainmeter with the detected executable path', async () => {
    const { controller, launcher } = makeController(runningRainmeterHandler(), {
      files: rainmeterFiles(),
    });

    await controller.startRainmeter();

    expect(launcher.calls).toEqual([{ executable: RAINMETER_PATH, args: [] }]);
  });

  it('rejects starting Rainmeter when it is not installed', async () => {
    const { controller, launcher } = makeController((command) =>
      command.executable === TASKLIST
        ? ok(tasklistOf([EXPLORER, 33848]))
        : { exitCode: 1, stdout: '', stderr: '' },
    );

    await expect(controller.startRainmeter()).rejects.toThrow(EnvironmentError);
    expect(launcher.calls).toHaveLength(0);
  });

  it('quits Rainmeter through the !Quit bang instead of taskkill', async () => {
    const { controller, runner } = makeController(runningRainmeterHandler(), {
      files: rainmeterFiles(),
    });

    await controller.quitRainmeter();

    expect(
      runner.calls.some((call) => call.executable === RAINMETER_PATH && call.args[0] === '!Quit'),
    ).toBe(true);
    expect(runner.calls.some((call) => call.executable === TASKKILL)).toBe(false);
  });

  it('does nothing when Rainmeter is not running', async () => {
    const { controller, runner } = makeController(
      (command) =>
        command.executable === TASKLIST
          ? ok(tasklistOf([EXPLORER, 33848]))
          : { exitCode: 1, stdout: '', stderr: '' },
      { files: rainmeterFiles() },
    );

    await controller.quitRainmeter();

    expect(runner.calls.some((call) => call.args[0] === '!Quit')).toBe(false);
  });
});

describe('WindowsProcessController Explorer restart', () => {
  it('kills Explorer, starts it, and detects the new shell process', async () => {
    let tasklistCalls = 0;
    const { controller, runner, launcher } = makeController((command) => {
      if (command.executable === TASKLIST) {
        tasklistCalls += 1;
        return ok(
          tasklistCalls === 1 ? tasklistOf([EXPLORER, 33848]) : tasklistOf([EXPLORER, 9000]),
        );
      }
      if (command.executable === TASKKILL) return ok();
      return { exitCode: 1, stdout: '', stderr: '' };
    });

    const result = await controller.restartExplorer();

    expect(result).toEqual({
      kill: {
        attempted: true,
        succeeded: true,
        detail: 'Stopped Explorer PID(s) 33848.',
      },
      start: { attempted: true, succeeded: true, detail: 'Explorer was started.' },
      shellRestarted: true,
    });
    expect(launcher.calls).toEqual([{ executable: 'explorer.exe', args: [] }]);
    expect(runner.calls.find((call) => call.executable === TASKKILL)?.args).toEqual([
      '/PID',
      '33848',
      '/F',
    ]);
    const tasklistCall = runner.calls.find((call) => call.executable === TASKLIST);
    expect(tasklistCall?.args).toEqual(['/FI', 'IMAGENAME eq explorer.exe', '/FO', 'CSV', '/NH']);
  });

  it('starts Explorer even when the kill step fails, reporting both outcomes', async () => {
    let tasklistCalls = 0;
    const { controller, launcher } = makeController((command) => {
      if (command.executable === TASKLIST) {
        tasklistCalls += 1;
        return ok(
          tasklistCalls === 1
            ? tasklistOf([EXPLORER, 33848])
            : tasklistOf([EXPLORER, 33848], [EXPLORER, 9000]),
        );
      }
      if (command.executable === TASKKILL) {
        return { exitCode: 5, stdout: '', stderr: 'Access is denied.' };
      }
      return { exitCode: 1, stdout: '', stderr: '' };
    });

    const result = await controller.restartExplorer();

    expect(result.kill.attempted).toBe(true);
    expect(result.kill.succeeded).toBe(false);
    expect(result.start).toEqual({
      attempted: true,
      succeeded: true,
      detail: 'Explorer was started.',
    });
    expect(result.shellRestarted).toBe(true);
    expect(launcher.calls).toHaveLength(1);
  });

  it('starts Explorer when no shell process was found before the restart', async () => {
    let tasklistCalls = 0;
    const { controller } = makeController((command) => {
      if (command.executable === TASKLIST) {
        tasklistCalls += 1;
        return ok(
          tasklistCalls === 1 ? tasklistOf([RAINMETER, 8448]) : tasklistOf([EXPLORER, 9000]),
        );
      }
      return ok();
    });

    const result = await controller.restartExplorer();

    expect(result.kill).toEqual({
      attempted: false,
      succeeded: false,
      detail: 'No explorer.exe process was found before the restart.',
    });
    expect(result.start.succeeded).toBe(true);
    expect(result.shellRestarted).toBe(true);
  });

  it('still starts Explorer when the process list cannot be read', async () => {
    const { controller, launcher } = makeController(
      (command) => {
        if (command.executable === TASKLIST) throw new Error('tasklist failed');
        return ok();
      },
      { shellWaitTimeoutMs: 0, now: () => 0 },
    );

    const result = await controller.restartExplorer();

    expect(result.kill.attempted).toBe(false);
    expect(result.start.succeeded).toBe(true);
    expect(result.shellRestarted).toBe(false);
    expect(launcher.calls).toHaveLength(1);
  });

  it('reports a shell that did not return within the wait timeout', async () => {
    let tasklistCalls = 0;
    const { controller } = makeController(
      (command) => {
        if (command.executable === TASKLIST) {
          tasklistCalls += 1;
          return ok(tasklistCalls === 1 ? tasklistOf([EXPLORER, 33848]) : '');
        }
        return ok();
      },
      { shellWaitTimeoutMs: 0, now: () => 0 },
    );

    const result = await controller.restartExplorer();

    expect(result.kill.succeeded).toBe(true);
    expect(result.start.succeeded).toBe(true);
    expect(result.shellRestarted).toBe(false);
  });

  it('reports a failed Explorer start without hiding the kill result', async () => {
    let tasklistCalls = 0;
    const { controller, launcher } = makeController(
      (command) => {
        if (command.executable === TASKLIST) {
          tasklistCalls += 1;
          return ok(
            tasklistCalls === 1 ? tasklistOf([EXPLORER, 33848]) : tasklistOf([EXPLORER, 9000]),
          );
        }
        return ok();
      },
      { shellWaitTimeoutMs: 0, now: () => 0 },
    );
    launcher.failWith = new Error('Explorer could not launch.');

    const result = await controller.restartExplorer();

    expect(result.kill.succeeded).toBe(true);
    expect(result.start.attempted).toBe(true);
    expect(result.start.succeeded).toBe(false);
    expect(result.start.detail).toContain('Explorer could not launch.');
  });
});
