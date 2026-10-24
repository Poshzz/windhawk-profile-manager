import { describe, expect, it } from 'vitest';
import {
  FakeServiceController,
  parseScImagePath,
  parseScQuery,
} from '@core/services/service-controller';
import { WindowsServiceController } from '@infra/services/windows-service-controller';
import { EnvironmentError } from '@shared/errors';
import { readFixture } from '../domain/test-fixtures';
import { FakeCommandRunner, type CommandHandler } from '../support/fake-command-runner';

const SC_EXE = 'sc.exe';

function makeController(
  handler: CommandHandler,
  options: {
    readonly startTimeoutMs?: number;
    readonly pollIntervalMs?: number;
    readonly sleep?: (milliseconds: number) => Promise<void>;
    readonly now?: () => number;
  } = {},
): { readonly runner: FakeCommandRunner; readonly controller: WindowsServiceController } {
  const runner = new FakeCommandRunner();
  runner.handler = handler;
  return {
    runner,
    controller: new WindowsServiceController({
      runner,
      scExe: SC_EXE,
      timeoutMs: 100,
      startTimeoutMs: options.startTimeoutMs ?? 100,
      pollIntervalMs: options.pollIntervalMs ?? 1,
      sleep: options.sleep ?? (async () => undefined),
      now: options.now,
    }),
  };
}

function queryResult(fixture: string, exitCode = 0) {
  return { exitCode, stdout: readFixture(`sc/${fixture}`), stderr: '' };
}

describe('sc output parsing', () => {
  it('parses running and stopped states from STATE codes', () => {
    expect(parseScQuery(readFixture('sc/query-running.txt'), 'Windhawk')).toEqual({
      name: 'Windhawk',
      state: 'running',
    });
    expect(parseScQuery(readFixture('sc/query-stopped.txt'), 'Windhawk')).toEqual({
      name: 'Windhawk',
      state: 'stopped',
    });
  });

  it('parses missing and unknown states', () => {
    expect(parseScQuery(readFixture('sc/query-missing.txt'), 'Windhawk')).toEqual({
      name: 'Windhawk',
      state: 'missing',
    });
    expect(
      parseScQuery('SERVICE_NAME: Windhawk\n        STATE : 2  START_PENDING', 'Windhawk'),
    ).toEqual({ name: 'Windhawk', state: 'unknown' });
    expect(parseScQuery('', 'Windhawk')).toEqual({ name: 'Windhawk', state: 'unknown' });
  });

  it('extracts a quoted service image path and ignores arguments', () => {
    expect(parseScImagePath(readFixture('sc/qc-windhawk.txt'))).toBe(
      'C:\\Program Files\\Windhawk\\windhawk.exe',
    );
    expect(
      parseScImagePath('        BINARY_PATH_NAME   : C:\\Tools\\Windhawk\\windhawk.exe -service'),
    ).toBe('C:\\Tools\\Windhawk\\windhawk.exe');
    expect(parseScImagePath('')).toBeNull();
  });
});

describe('WindowsServiceController', () => {
  it('reports the service state from sc query', async () => {
    const { controller, runner } = makeController(() => queryResult('query-running.txt'));

    await expect(controller.status()).resolves.toEqual({ name: 'Windhawk', state: 'running' });
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.args).toEqual(['query', 'Windhawk']);
  });

  it('reports a missing service from sc query exit code 1060', async () => {
    const { controller } = makeController(() => queryResult('query-missing.txt', 1060));

    await expect(controller.status()).resolves.toEqual({ name: 'Windhawk', state: 'missing' });
  });

  it('reports unknown when sc query cannot be executed', async () => {
    const { controller } = makeController(() => {
      throw new Error('sc failed');
    });

    await expect(controller.status()).resolves.toEqual({ name: 'Windhawk', state: 'unknown' });
  });

  it('does not start a service that is already running', async () => {
    const { controller, runner } = makeController(() => queryResult('query-running.txt'));

    const result = await controller.ensureRunning();

    expect(result).toEqual({ service: { name: 'Windhawk', state: 'running' }, started: false });
    expect(runner.calls.map((call) => call.args[0])).toEqual(['query']);
  });

  it('starts a stopped service and waits for the running state', async () => {
    let queries = 0;
    const { controller, runner } = makeController((command) => {
      if (command.args[0] === 'start') return { exitCode: 0, stdout: '', stderr: '' };
      queries += 1;
      return queryResult(queries === 1 ? 'query-stopped.txt' : 'query-running.txt');
    });

    const result = await controller.ensureRunning();

    expect(result).toEqual({ service: { name: 'Windhawk', state: 'running' }, started: true });
    expect(runner.calls.map((call) => call.args[0])).toEqual(['query', 'start', 'query']);
  });

  it('rejects when the service is missing', async () => {
    const { controller, runner } = makeController(() => queryResult('query-missing.txt', 1060));

    await expect(controller.ensureRunning()).rejects.toThrow(EnvironmentError);
    expect(runner.calls.map((call) => call.args[0])).toEqual(['query']);
  });

  it('accepts sc start code 1056 when the service is already running', async () => {
    let queries = 0;
    const { controller } = makeController((command) => {
      if (command.args[0] === 'start') return { exitCode: 1056, stdout: '', stderr: '' };
      queries += 1;
      return queryResult(queries === 1 ? 'query-stopped.txt' : 'query-running.txt');
    });

    await expect(controller.ensureRunning()).resolves.toEqual({
      service: { name: 'Windhawk', state: 'running' },
      started: true,
    });
  });

  it('rejects when sc start fails', async () => {
    const { controller } = makeController((command) => {
      if (command.args[0] === 'start') {
        return { exitCode: 5, stdout: '', stderr: 'Access is denied.' };
      }
      return queryResult('query-stopped.txt');
    });

    await expect(controller.ensureRunning()).rejects.toThrow(/could not be started/i);
  });

  it('times out when the service never reaches the running state', async () => {
    let time = 0;
    const { controller } = makeController(
      (command) => {
        if (command.args[0] === 'start') return { exitCode: 0, stdout: '', stderr: '' };
        return queryResult('query-stopped.txt');
      },
      {
        startTimeoutMs: 10,
        pollIntervalMs: 5,
        now: () => time,
        sleep: async (milliseconds) => {
          time += milliseconds;
        },
      },
    );

    await expect(controller.ensureRunning()).rejects.toThrow(/timed out/i);
  });

  it('never stops or restarts the Windhawk service', async () => {
    let queries = 0;
    const { controller, runner } = makeController((command) => {
      if (command.args[0] === 'start') return { exitCode: 0, stdout: '', stderr: '' };
      queries += 1;
      return queryResult(queries === 1 ? 'query-stopped.txt' : 'query-running.txt');
    });

    await controller.ensureRunning();

    for (const call of runner.calls) {
      expect(call.args[0]).not.toBe('stop');
      expect(call.args[0]).not.toBe('restart');
    }
  });

  it('reads the service image path from sc qc', async () => {
    const { controller, runner } = makeController(() => queryResult('qc-windhawk.txt'));

    await expect(controller.imagePath()).resolves.toBe('C:\\Program Files\\Windhawk\\windhawk.exe');
    expect(runner.calls[0]?.args).toEqual(['qc', 'Windhawk']);
  });

  it('returns null when sc qc fails', async () => {
    const { controller } = makeController(() => ({ exitCode: 1060, stdout: '', stderr: '' }));

    await expect(controller.imagePath()).resolves.toBeNull();
  });
});

describe('FakeServiceController', () => {
  it('starts a stopped fake service and resolves', async () => {
    const fake = new FakeServiceController({ state: 'stopped' });

    const result = await fake.ensureRunning();

    expect(result).toEqual({ service: { name: 'Windhawk', state: 'running' }, started: true });
    expect(fake.startCalls).toBe(1);
  });

  it('is a no-op when the fake service is already running', async () => {
    const fake = new FakeServiceController({ state: 'running' });

    const result = await fake.ensureRunning();

    expect(result).toEqual({ service: { name: 'Windhawk', state: 'running' }, started: false });
    expect(fake.startCalls).toBe(0);
  });

  it('supports a delayed transition', async () => {
    let slept = 0;
    const fake = new FakeServiceController({
      state: 'stopped',
      stateAfterStart: 'unknown',
      transitionDelayMs: 25,
      sleep: async (milliseconds) => {
        slept = milliseconds;
      },
    });
    fake.setStateAfterStart('running');

    const result = await fake.ensureRunning();

    expect(slept).toBe(25);
    expect(result.started).toBe(true);
    expect(result.service.state).toBe('running');
  });
});
