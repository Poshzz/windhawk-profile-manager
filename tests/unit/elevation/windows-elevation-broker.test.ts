import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SCHEMA_VERSION,
  parseApplyResult,
  parsePlan,
  type ApplyResult,
  type ApplyStatus,
  type ExecutionPlan,
} from '@shared/domain';
import {
  ApplyError,
  ElevationCanceledError,
  EnvironmentError,
  ValidationError,
} from '@shared/errors';
import { buildPlan } from '@core/planner/apply-planner';
import { WindowsElevationBroker } from '@infra/elevation/windows-elevation-broker';
import type {
  ElevationLaunchRequest,
  ElevationLaunchResult,
  ElevationLauncher,
} from '@infra/elevation/shell-execute-launcher';
import type { RunDirectoryAcl } from '@infra/elevation/run-directory';
import {
  dword,
  makeEnvironment,
  makeProfile,
  makeSnapshot,
  modKeys,
  planOptions,
  stringValue,
} from '../planner/support';

const MOD = 'sample-mod';
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

class FakeLauncher implements ElevationLauncher {
  readonly calls: ElevationLaunchRequest[] = [];
  handler: (request: ElevationLaunchRequest) => Promise<ElevationLaunchResult> = async () => ({
    exitCode: 0,
  });

  async launch(request: ElevationLaunchRequest): Promise<ElevationLaunchResult> {
    this.calls.push(request);
    return this.handler(request);
  }
}

class FakeAcl implements RunDirectoryAcl {
  readonly calls: string[] = [];
  failWith: Error | null = null;

  async apply(path: string): Promise<void> {
    if (this.failWith !== null) throw this.failWith;
    this.calls.push(path);
  }
}

interface Fixture {
  readonly root: string;
  readonly programFiles: string;
  readonly programData: string;
  readonly helperPath: string;
  readonly plan: ReturnType<typeof buildPlan>;
  readonly runDirectory: string;
  readonly launcher: FakeLauncher;
  readonly acl: FakeAcl;
  readonly broker: WindowsElevationBroker;
}

function hash(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'wpm-broker-'));
  directories.push(root);
  const programFiles = join(root, 'Program Files');
  const programData = join(root, 'ProgramData');
  const helperDirectory = join(programFiles, 'WindhawkProfileManager');
  const helperPath = join(helperDirectory, 'WindhawkProfileManager.exe');
  await mkdir(helperDirectory, { recursive: true });
  await writeFile(helperPath, 'fake helper', 'utf8');

  const runId = 'run-1';
  const runDirectory = join(programData, 'WindhawkProfileManager', 'runs', runId);
  const planPath = join(runDirectory, 'plan.json');
  const resultPath = join(runDirectory, 'result.json');
  const snapshotId = 'snapshot-1';
  const appData = join(root, 'LocalAppData', 'WindhawkProfileManager');
  const snapshot = makeSnapshot([
    ...modKeys(MOD, {
      enabled: true,
      version: '1',
      settings: { Theme: stringValue('old') },
    }),
  ]);
  const plan = buildPlan(
    makeProfile({
      requiredMods: [
        {
          modId: MOD,
          state: 'enabled',
          mode: 'replace',
          settings: { Theme: stringValue('new'), Count: dword(3) },
        },
      ],
    }),
    snapshot,
    makeEnvironment(),
    planOptions({
      runId,
      snapshotId,
      paths: {
        plan: planPath,
        snapshotRegistry: join(appData, 'snapshots', `${snapshotId}.reg`),
        journal: join(appData, 'journal.json'),
        result: resultPath,
      },
    }),
  );

  const launcher = new FakeLauncher();
  const acl = new FakeAcl();
  const broker = new WindowsElevationBroker({
    programFiles,
    programData,
    localAppData: join(root, 'LocalAppData'),
    launcher,
    acl,
    isUserWritable: async () => false,
  });

  return {
    root,
    programFiles,
    programData,
    helperPath,
    plan,
    runDirectory,
    launcher,
    acl,
    broker,
  };
}

function resultFor(plan: ExecutionPlan, status: ApplyStatus): ApplyResult {
  const successLike = status === 'succeeded' || status === 'succeeded-with-warning';
  return parseApplyResult({
    schemaVersion: SCHEMA_VERSION,
    runId: plan.runId,
    kind: plan.kind,
    status,
    message: `Helper result: ${status}`,
    startedAt: '2026-10-22T20:00:00.000Z',
    completedAt: '2026-10-22T20:00:01.000Z',
    changedMods: successLike ? [MOD] : [],
    skippedMods: [],
    warnings: status === 'succeeded-with-warning' ? ['helper warning'] : [],
    reload: {
      requested: successLike,
      confirmed: false,
      message: 'requested',
    },
    verification: successLike
      ? { status: 'verified', checkedAt: '2026-10-22T20:00:01.000Z', message: 'ok' }
      : { status: 'not-run', checkedAt: null, message: 'not run' },
    actions: {
      rainmeter: { status: 'skipped' },
      explorer: { status: 'skipped' },
    },
    rollback:
      status === 'rolled-back'
        ? { status: 'succeeded', message: 'restored' }
        : status === 'rollback-failed'
          ? { status: 'failed', message: 'restore failed' }
          : null,
    error:
      successLike || status === 'dry-run'
        ? null
        : {
            code: status === 'rollback-failed' ? 'ROLLBACK_FAILED' : 'APPLY_FAILED',
            name: 'ApplyError',
            message: status,
          },
  });
}

function planPathFrom(request: ElevationLaunchRequest): string {
  const index = request.arguments.indexOf('--plan');
  const path = request.arguments[index + 1];
  if (path === undefined) throw new Error('The launcher did not receive --plan.');
  return path;
}

async function readPlan(request: ElevationLaunchRequest): Promise<ExecutionPlan> {
  return parsePlan(JSON.parse(await readFile(planPathFrom(request), 'utf8')) as unknown);
}

async function writeResult(request: ElevationLaunchRequest, result: ApplyResult): Promise<void> {
  const plan = await readPlan(request);
  await writeFile(plan.paths.result, JSON.stringify(result, null, 2), 'utf8');
}

describe('WindowsElevationBroker', () => {
  it('starts the service through a service-only elevated helper launch', async () => {
    const fx = await fixture();

    await fx.broker.startService();

    expect(fx.launcher.calls).toHaveLength(1);
    expect(fx.launcher.calls[0]?.helperPath).toBe(fx.helperPath);
    expect(fx.launcher.calls[0]?.arguments).toEqual(['--helper', '--service-start']);
  });

  it('maps a canceled service-start UAC prompt to ElevationCanceledError', async () => {
    const fx = await fixture();
    fx.launcher.handler = async () => ({ exitCode: 1223 });

    await expect(fx.broker.startService()).rejects.toBeInstanceOf(ElevationCanceledError);
  });

  it('writes the plan, hashes the exact bytes, launches, reads the result, and cleans up', async () => {
    const fx = await fixture();
    let seenPlanText = '';
    fx.launcher.handler = async (request) => {
      seenPlanText = await readFile(planPathFrom(request), 'utf8');
      const plan = await readPlan(request);
      await writeResult(request, resultFor(plan, 'succeeded'));
      return { exitCode: 0 };
    };

    const result = await fx.broker.run(fx.plan);

    expect(result.status).toBe('succeeded');
    expect(fx.broker.helperPath).toBe(fx.helperPath);
    expect(fx.acl.calls).toEqual([fx.runDirectory]);
    expect(seenPlanText.endsWith('\n')).toBe(true);
    expect(fx.launcher.calls).toHaveLength(1);
    const request = fx.launcher.calls[0]!;
    expect(request.helperPath).toBe(fx.helperPath);
    expect(request.workingDirectory).toBe(dirname(fx.helperPath));
    expect(request.arguments.slice(0, 4)).toEqual([
      '--helper',
      '--plan',
      join(fx.runDirectory, 'plan.json'),
      '--hash',
    ]);
    expect(request.arguments[4]).toBe(hash(seenPlanText));
    expect(request.arguments).not.toContain('--dry-run');
    await expect(access(fx.runDirectory)).rejects.toThrow();
  });

  it('passes --dry-run and cleans up a dry-run result', async () => {
    const fx = await fixture();
    fx.launcher.handler = async (request) => {
      const plan = await readPlan(request);
      await writeResult(request, resultFor(plan, 'dry-run'));
      return { exitCode: 0 };
    };

    const result = await fx.broker.run(fx.plan, { dryRun: true });

    expect(result.status).toBe('dry-run');
    expect(fx.launcher.calls[0]?.arguments).toContain('--dry-run');
    await expect(access(fx.runDirectory)).rejects.toThrow();
  });

  it('accepts a privileged warning result on exit 0 and cleans up', async () => {
    const fx = await fixture();
    fx.launcher.handler = async (request) => {
      const plan = await readPlan(request);
      await writeResult(request, resultFor(plan, 'succeeded-with-warning'));
      return { exitCode: 0 };
    };

    const result = await fx.broker.run(fx.plan);

    expect(result.status).toBe('succeeded-with-warning');
    await expect(access(fx.runDirectory)).rejects.toThrow();
  });

  it('returns an apply-failure result and keeps the run directory for diagnostics', async () => {
    const fx = await fixture();
    fx.launcher.handler = async (request) => {
      const plan = await readPlan(request);
      await writeResult(request, resultFor(plan, 'rolled-back'));
      return { exitCode: 3 };
    };

    const result = await fx.broker.run(fx.plan);

    expect(result.status).toBe('rolled-back');
    await expect(access(join(fx.runDirectory, 'plan.json'))).resolves.toBeUndefined();
    await expect(access(join(fx.runDirectory, 'result.json'))).resolves.toBeUndefined();
  });

  it('returns a rollback-failed result for exit 4', async () => {
    const fx = await fixture();
    fx.launcher.handler = async (request) => {
      const plan = await readPlan(request);
      await writeResult(request, resultFor(plan, 'rollback-failed'));
      return { exitCode: 4 };
    };

    const result = await fx.broker.run(fx.plan);

    expect(result.status).toBe('rollback-failed');
  });

  it('maps UAC cancellation to ElevationCanceledError without snapshot or journal files', async () => {
    const fx = await fixture();
    fx.launcher.handler = async () => ({ exitCode: 1223 });

    await expect(fx.broker.run(fx.plan)).rejects.toBeInstanceOf(ElevationCanceledError);
    await expect(access(fx.plan.paths.snapshotRegistry)).rejects.toThrow();
    await expect(access(fx.plan.paths.journal)).rejects.toThrow();
    await expect(access(fx.runDirectory)).rejects.toThrow();
  });

  it('rejects a missing or user-writable fixed helper before creating a run directory', async () => {
    const fx = await fixture();
    await rm(fx.helperPath);
    await expect(fx.broker.run(fx.plan)).rejects.toThrow(/missing/i);
    await expect(access(fx.runDirectory)).rejects.toThrow();

    await writeFile(fx.helperPath, 'fake helper', 'utf8');
    const writableBroker = new WindowsElevationBroker({
      programFiles: fx.programFiles,
      programData: fx.programData,
      localAppData: join(fx.root, 'LocalAppData'),
      launcher: fx.launcher,
      acl: fx.acl,
      isUserWritable: async (path) => path === fx.helperPath,
    });
    await expect(writableBroker.run(fx.plan)).rejects.toThrow(/writable/i);
    await expect(access(fx.runDirectory)).rejects.toThrow();
  });

  it('rejects mismatched plan paths and never launches', async () => {
    const fx = await fixture();
    const mismatched = parsePlan({
      ...fx.plan,
      paths: { ...fx.plan.paths, result: join(fx.root, 'elsewhere', 'result.json') },
    });

    await expect(fx.broker.run(mismatched)).rejects.toThrow(ValidationError);
    expect(fx.launcher.calls).toEqual([]);
  });

  it('rejects non-canonical data paths before creating a run directory', async () => {
    const fx = await fixture();
    const decoy = parsePlan({
      ...fx.plan,
      paths: {
        ...fx.plan.paths,
        journal: 'C:\\Windows\\System32\\WindhawkProfileManager\\journal.json',
      },
    });

    await expect(fx.broker.run(decoy)).rejects.toThrow(/canonical WindhawkProfileManager/i);
    expect(fx.launcher.calls).toEqual([]);
    await expect(access(fx.runDirectory)).rejects.toThrow();
  });

  it('keeps the run directory when the helper writes no result', async () => {
    const fx = await fixture();
    fx.launcher.handler = async () => ({ exitCode: 2 });

    await expect(fx.broker.run(fx.plan)).rejects.toThrow(ValidationError);
    await expect(access(join(fx.runDirectory, 'plan.json'))).resolves.toBeUndefined();
  });

  it('rejects a result from a different run', async () => {
    const fx = await fixture();
    fx.launcher.handler = async (request) => {
      const plan = await readPlan(request);
      await writeResult(
        request,
        parseApplyResult({ ...resultFor(plan, 'succeeded'), runId: 'run-2' }),
      );
      return { exitCode: 0 };
    };

    await expect(fx.broker.run(fx.plan)).rejects.toThrow(ApplyError);
  });

  it('cleans up when the run-directory ACL fails', async () => {
    const fx = await fixture();
    fx.acl.failWith = new EnvironmentError('ACL denied');

    await expect(fx.broker.run(fx.plan)).rejects.toThrow(/ACL denied/);
    expect(fx.launcher.calls).toEqual([]);
    await expect(access(fx.runDirectory)).rejects.toThrow();
  });
});
