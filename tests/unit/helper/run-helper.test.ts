import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SCHEMA_VERSION,
  parseApplyResult,
  parsePlan,
  type ApplyResult,
  type ExecutionPlan,
} from '@shared/domain';
import { HELPER_EXIT_CODES } from '@shared/constants';
import { ApplyError, RollbackError, ValidationError } from '@shared/errors';
import { buildPlan } from '@core/planner/apply-planner';
import {
  dword,
  makeEnvironment,
  makeProfile,
  makeSnapshot,
  modKeys,
  planOptions,
  stringValue,
} from '../planner/support';
import type { HelperPlanArguments } from '../../../src/main/helper/arguments';
import {
  validateHelperPlanPaths,
  type HelperPathAccess,
} from '../../../src/main/helper/helper-paths';
import { runHelperMode } from '../../../src/main/helper/run-helper';
import { makeRestorePlanForTest } from '../executor/executor-support';

const MOD = 'sample-mod';
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function workspace(): Promise<{
  root: string;
  plan: ReturnType<typeof buildPlan>;
  planPath: string;
  snapshotPath: string;
  journalPath: string;
  resultPath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'wpm-helper-'));
  directories.push(root);
  const snapshotId = '2026-10-22T20-02-14-123Z';
  const appData = join(root, 'LocalAppData', 'WindhawkProfileManager');
  const runDirectory = join(root, 'ProgramData', 'WindhawkProfileManager', 'runs', 'run-1');
  const planPath = join(runDirectory, 'plan.json');
  const snapshotPath = join(appData, 'snapshots', `${snapshotId}.reg`);
  const journalPath = join(appData, 'journal.json');
  const resultPath = join(runDirectory, 'result.json');
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
      runId: 'run-1',
      snapshotId,
      paths: {
        plan: planPath,
        snapshotRegistry: snapshotPath,
        journal: journalPath,
        result: resultPath,
      },
    }),
  );
  return { root, plan, planPath, snapshotPath, journalPath, resultPath };
}

function argsFor(planPath: string, dryRun = false): HelperPlanArguments {
  return { serviceStart: false, planPath, expectedHash: `sha256:${'a'.repeat(64)}`, dryRun };
}

function resultFor(plan: ExecutionPlan, status: ApplyResult['status'] = 'succeeded'): ApplyResult {
  return parseApplyResult({
    schemaVersion: SCHEMA_VERSION,
    runId: plan.runId,
    kind: plan.kind,
    status,
    message: `Helper result: ${status}`,
    startedAt: '2026-10-22T20:00:00.000Z',
    completedAt: '2026-10-22T20:00:01.000Z',
    changedMods: [],
    skippedMods: [],
    warnings: [],
    reload: { requested: status === 'succeeded', confirmed: false, message: 'requested' },
    verification:
      status === 'succeeded'
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
      status === 'succeeded' ? null : { code: 'APPLY_FAILED', name: 'ApplyError', message: 'x' },
  });
}

describe('validateHelperPlanPaths', () => {
  it('accepts a layout with the plan, result, and snapshot in the expected places', async () => {
    const { plan, planPath } = await workspace();
    const labels: string[] = [];
    const access: HelperPathAccess = {
      ensureWritableDirectory: async (_path, label) => {
        labels.push(label);
      },
      assertReadableFile: async (_path, label) => {
        labels.push(label);
      },
      assertMissingFile: async (_path, label) => {
        labels.push(label);
      },
    };

    await validateHelperPlanPaths(plan, planPath, access);
    expect(labels).toContain('snapshot file');
    expect(labels).toContain('result file');
  });

  it('rejects a different plan path, a misplaced result, and a snapshot name mismatch', async () => {
    const { plan, planPath } = await workspace();
    const access: HelperPathAccess = {
      ensureWritableDirectory: async () => undefined,
      assertReadableFile: async () => undefined,
      assertMissingFile: async () => undefined,
    };

    await expect(
      validateHelperPlanPaths(plan, join(planPath, 'other.json'), access),
    ).rejects.toThrow(/plan path/);

    const misplaced = parsePlan({
      ...plan,
      paths: { ...plan.paths, result: join(planPath, 'not-result.json') },
    });
    await expect(validateHelperPlanPaths(misplaced, planPath, access)).rejects.toThrow(
      /result path/,
    );

    const wrongSnapshot = parsePlan({
      ...plan,
      paths: { ...plan.paths, snapshotRegistry: join(planPath, 'wrong.reg') },
    });
    await expect(validateHelperPlanPaths(wrongSnapshot, planPath, access)).rejects.toThrow(
      /snapshot path/,
    );
  });

  it('rejects a non-canonical journal or snapshot directory', async () => {
    const { plan, planPath } = await workspace();
    const access: HelperPathAccess = {
      ensureWritableDirectory: async () => undefined,
      assertReadableFile: async () => undefined,
      assertMissingFile: async () => undefined,
    };

    const wrongJournal = parsePlan({
      ...plan,
      paths: { ...plan.paths, journal: join(planPath, 'journal.json') },
    });
    await expect(validateHelperPlanPaths(wrongJournal, planPath, access)).rejects.toThrow(
      /journal path.*canonical/i,
    );

    const wrongSnapshot = parsePlan({
      ...plan,
      paths: { ...plan.paths, snapshotRegistry: join(planPath, `${plan.snapshotId}.reg`) },
    });
    await expect(validateHelperPlanPaths(wrongSnapshot, planPath, access)).rejects.toThrow(
      /WindhawkProfileManager\\snapshots/i,
    );

    const decoyJournal = parsePlan({
      ...plan,
      paths: {
        ...plan.paths,
        journal: 'C:\\Windows\\System32\\WindhawkProfileManager\\journal.json',
      },
    });
    await expect(validateHelperPlanPaths(decoyJournal, planPath, access)).rejects.toThrow(
      /canonical.*journal/i,
    );
  });

  it('binds a restore source path to its snapshot ID and snapshots directory', async () => {
    const registry = makeSnapshot([
      ...modKeys(MOD, { enabled: true, version: '1', settings: { Theme: stringValue('old') } }),
    ]);
    const plan = makeRestorePlanForTest({
      source: { metadata: { id: 'source-1' }, registry },
      current: registry,
    });
    const access: HelperPathAccess = {
      ensureWritableDirectory: async () => undefined,
      assertReadableFile: async () => undefined,
      assertMissingFile: async () => undefined,
    };

    await expect(validateHelperPlanPaths(plan, plan.paths.plan, access)).resolves.toBeUndefined();

    const wrongName = parsePlan({
      ...plan,
      paths: {
        ...plan.paths,
        sourceSnapshotRegistry: plan.paths.sourceSnapshotRegistry.replace(
          'source-1.reg',
          'other.reg',
        ),
      },
    });
    await expect(validateHelperPlanPaths(wrongName, plan.paths.plan, access)).rejects.toThrow(
      /source snapshot path/,
    );

    const wrongDirectory = parsePlan({
      ...plan,
      paths: {
        ...plan.paths,
        sourceSnapshotRegistry: plan.paths.sourceSnapshotRegistry.replace(
          '\\snapshots\\',
          '\\other\\',
        ),
      },
    });
    await expect(validateHelperPlanPaths(wrongDirectory, plan.paths.plan, access)).rejects.toThrow(
      /WindhawkProfileManager\\snapshots/,
    );
  });

  it('aborts before execution when a supplied directory is not writable', async () => {
    const { plan, planPath } = await workspace();
    const access: HelperPathAccess = {
      ensureWritableDirectory: async () => {
        throw new ValidationError('denied');
      },
      assertReadableFile: async () => undefined,
      assertMissingFile: async () => undefined,
    };
    await expect(validateHelperPlanPaths(plan, planPath, access)).rejects.toThrow(/denied/);
  });
});

describe('runHelperMode', () => {
  it('writes a dry-run result and exits 0', async () => {
    const { plan, planPath, resultPath } = await workspace();
    const written: Array<{ path: string; result: ApplyResult }> = [];
    let dryRun = false;

    const code = await runHelperMode(argsFor(planPath, true), {
      readPlan: async () => ({ plan, fileHash: argsFor(planPath).expectedHash }),
      validatePaths: async () => undefined,
      execute: async (_candidate, options) => {
        dryRun = options.dryRun;
        return resultFor(plan, 'dry-run');
      },
      writeResult: async (path, result) => {
        written.push({ path, result });
      },
    });

    expect(code).toBe(HELPER_EXIT_CODES.success);
    expect(dryRun).toBe(true);
    expect(written[0]?.path).toBe(resultPath);
    expect(written[0]?.result.status).toBe('dry-run');
  });

  it('maps executor validation errors to 2 and writes a failed result', async () => {
    const { plan, planPath, resultPath } = await workspace();
    const written: ApplyResult[] = [];

    const code = await runHelperMode(argsFor(planPath), {
      readPlan: async () => ({ plan, fileHash: argsFor(planPath).expectedHash }),
      validatePaths: async () => undefined,
      execute: async () => {
        throw new ValidationError('stale plan');
      },
      writeResult: async (_path, result) => {
        written.push(result);
      },
    });

    expect(code).toBe(HELPER_EXIT_CODES.validationFailure);
    expect(written[0]?.status).toBe('failed');
    expect(written[0]?.error?.code).toBe('VALIDATION');
    expect(resultPath).toBe(plan.paths.result);
  });

  it('maps an apply failure to 3 and a rollback failure to 4', async () => {
    const { plan, planPath } = await workspace();
    const written: ApplyResult[] = [];
    const base = {
      readPlan: async () => ({ plan, fileHash: argsFor(planPath).expectedHash }),
      validatePaths: async () => undefined,
      writeResult: async (_path: string, result: ApplyResult) => {
        written.push(result);
      },
    };

    expect(
      await runHelperMode(argsFor(planPath), {
        ...base,
        execute: async () => {
          throw new ApplyError('failed');
        },
      }),
    ).toBe(HELPER_EXIT_CODES.applyFailure);

    expect(written.at(-1)?.status).toBe('failed');

    expect(
      await runHelperMode(argsFor(planPath), {
        ...base,
        execute: async () => resultFor(plan, 'rollback-failed'),
      }),
    ).toBe(HELPER_EXIT_CODES.rollbackFailure);

    expect(
      await runHelperMode(argsFor(planPath), {
        ...base,
        execute: async () => {
          throw new RollbackError('rollback failed');
        },
      }),
    ).toBe(HELPER_EXIT_CODES.rollbackFailure);
    expect(written.at(-1)?.status).toBe('rollback-failed');
    expect(written.at(-1)?.rollback?.status).toBe('failed');
  });

  it('rejects unreadable plans and path validation failures before executing', async () => {
    const { planPath } = await workspace();
    let executed = false;
    const code = await runHelperMode(argsFor(planPath), {
      readPlan: async () => {
        throw new ValidationError('bad hash');
      },
      execute: async () => {
        executed = true;
        throw new Error('should not run');
      },
    });
    expect(code).toBe(HELPER_EXIT_CODES.validationFailure);
    expect(executed).toBe(false);

    const { plan } = await workspace();
    const written: ApplyResult[] = [];
    const pathRejected = await runHelperMode(argsFor(planPath), {
      readPlan: async () => ({ plan, fileHash: argsFor(planPath).expectedHash }),
      validatePaths: async () => {
        throw new ValidationError('path denied');
      },
      execute: async () => {
        executed = true;
        throw new Error('should not run');
      },
      writeResult: async (_path, result) => {
        written.push(result);
      },
    });
    expect(pathRejected).toBe(HELPER_EXIT_CODES.validationFailure);
    expect(executed).toBe(false);
    expect(written[0]?.status).toBe('failed');
    expect(written[0]?.error?.message).toMatch(/path denied/);
  });

  it('returns apply failure when the result cannot be written', async () => {
    const { plan, planPath } = await workspace();
    const code = await runHelperMode(argsFor(planPath), {
      readPlan: async () => ({ plan, fileHash: argsFor(planPath).expectedHash }),
      validatePaths: async () => undefined,
      execute: async () => resultFor(plan),
      writeResult: async () => {
        throw new Error('disk full');
      },
    });
    expect(code).toBe(HELPER_EXIT_CODES.applyFailure);
  });
});
