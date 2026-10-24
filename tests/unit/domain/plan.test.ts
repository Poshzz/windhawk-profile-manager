import { describe, expect, it } from 'vitest';
import {
  canonicalPlanHashInput,
  isAbsoluteWindowsPath,
  isWindowsPrincipal,
  parsePlan,
  parsePlanJson,
  stableStringify,
} from '@shared/domain';
import { ValidationError } from '@shared/errors';
import { formatIssuePath } from '@shared/validation/schema';
import { readFixture, readJsonFixture } from './test-fixtures';

function validationError(run: () => unknown): ValidationError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ValidationError);
    return error as ValidationError;
  }
  throw new Error('Expected a ValidationError.');
}

function applyPlan(): Record<string, unknown> {
  return readJsonFixture('plans/valid-apply.json') as Record<string, unknown>;
}

function firstModChange(plan: Record<string, unknown>): Record<string, unknown> {
  const changes = plan.modChanges as Record<string, unknown>[];
  const first = changes[0];
  if (first === undefined) throw new Error('Fixture has no mod change.');
  return first;
}

describe('execution plans', () => {
  it('parses an apply plan with absolute paths', () => {
    const plan = parsePlanJson(readFixture('plans/valid-apply.json'));
    if (plan.kind !== 'apply') throw new Error('Expected an apply plan.');

    expect(plan.profileId).toBe('mac-blur-glass');
    expect(plan.modChanges).toHaveLength(1);
    expect(plan.modChanges[0]?.settingsHash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('parses a restore plan with a source snapshot path', () => {
    const plan = parsePlanJson(readFixture('plans/valid-restore.json'));
    if (plan.kind !== 'restore') throw new Error('Expected a restore plan.');

    expect(plan.profileId).toBeNull();
    expect(plan.paths.sourceSnapshotRegistry).toMatch(/\.reg$/);
  });

  it('rejects a plan with a missing planHash', () => {
    const error = validationError(() =>
      parsePlanJson(readFixture('plans/invalid-missing-hash.json')),
    );

    expect(error.details.map((detail) => formatIssuePath(detail.path))).toContain('planHash');
  });

  it('rejects a malformed planHash', () => {
    const plan = applyPlan();
    plan.planHash = 'sha256:not-a-hash';

    const error = validationError(() => parsePlan(plan));
    expect(error.details.map((detail) => formatIssuePath(detail.path))).toContain('planHash');
  });

  it('rejects an uppercase planHash', () => {
    const plan = applyPlan();
    plan.planHash = `sha256:${'A'.repeat(64)}`;

    expect(() => parsePlan(plan)).toThrow(ValidationError);
  });

  it.each(['beforeHash', 'profileRevision'])('rejects a plan missing %s', (field) => {
    const plan = applyPlan();
    delete plan[field];

    const error = validationError(() => parsePlan(plan));
    expect(error.details.map((detail) => formatIssuePath(detail.path))).toContain(field);
  });

  it('rejects a plan missing a per-mod settingsHash', () => {
    const plan = applyPlan();
    delete firstModChange(plan).settingsHash;

    const error = validationError(() => parsePlan(plan));
    expect(error.details.map((detail) => formatIssuePath(detail.path))).toContain(
      'modChanges[0].settingsHash',
    );
  });

  it('rejects a restore plan without a source snapshot path', () => {
    const error = validationError(() =>
      parsePlanJson(readFixture('plans/invalid-restore-no-source.json')),
    );

    expect(error.details.map((detail) => formatIssuePath(detail.path))).toContain(
      'paths.sourceSnapshotRegistry',
    );
  });

  it('rejects relative plan paths with a field path', () => {
    const error = validationError(() =>
      parsePlanJson(readFixture('plans/invalid-relative-path.json')),
    );

    expect(error.details.map((detail) => formatIssuePath(detail.path))).toContain('paths.plan');
  });

  it('rejects an apply plan carrying restore-only fields', () => {
    const plan = applyPlan();
    plan.sourceSnapshotId = '2026-10-21T10-00-00-000Z';

    const error = validationError(() => parsePlan(plan));
    expect(error.details.map((detail) => formatIssuePath(detail.path))).toContain(
      'sourceSnapshotId',
    );
  });

  it('rejects a source snapshot path on an apply plan', () => {
    const plan = applyPlan();
    const planPaths = plan.paths as Record<string, unknown>;
    planPaths.sourceSnapshotRegistry =
      'C:\\Users\\Test\\AppData\\Local\\WindhawkProfileManager\\snapshots\\source.reg';

    const error = validationError(() => parsePlan(plan));
    expect(error.details.map((detail) => formatIssuePath(detail.path))).toContain(
      'paths.sourceSnapshotRegistry',
    );
  });

  it('rejects path aliases that differ only by case or slash style', () => {
    const plan = applyPlan();
    const planPaths = plan.paths as Record<string, unknown>;
    planPaths.result = String(planPaths.plan).replace(/\\/g, '/').toUpperCase();

    const error = validationError(() => parsePlan(plan));
    expect(error.message).toContain('distinct');
  });

  it.each([
    'C:\\foo\\..\\bar',
    '\\\\.\\C:\\foo',
    '\\\\?\\GLOBALROOT\\Device\\foo',
    'C:\\foo:bar',
    'relative\\path',
  ])('rejects unsafe absolute path %s', (path) => {
    expect(isAbsoluteWindowsPath(path)).toBe(false);
  });

  it.each(['C:\\foo\\bar', '\\\\server\\share\\foo', '\\\\?\\C:\\foo'])(
    'accepts absolute path %s',
    (path) => {
      expect(isAbsoluteWindowsPath(path)).toBe(true);
    },
  );

  it('rejects merge-mode deletions', () => {
    const plan = applyPlan();
    firstModChange(plan).mode = 'merge';
    firstModChange(plan).deleteValues = ['LegacyTheme'];

    const error = validationError(() => parsePlan(plan));
    expect(error.details.map((detail) => formatIssuePath(detail.path))).toContain(
      'modChanges[0].deleteValues',
    );
  });

  it('rejects unknown plan fields', () => {
    const plan = applyPlan();
    plan.extra = true;

    const error = validationError(() => parsePlan(plan));
    expect(error.details.map((detail) => formatIssuePath(detail.path))).toContain('extra');
  });

  it('canonicalizes object keys independently of insertion order', () => {
    expect(stableStringify({ b: 2, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":2}');
  });

  it('canonicalizes the plan hash input without planHash', () => {
    const plan = applyPlan();
    const reversed = Object.fromEntries(Object.entries(plan).reverse()) as Record<string, unknown>;

    const canonical = canonicalPlanHashInput(plan);
    expect(canonicalPlanHashInput(reversed)).toBe(canonical);
    expect(canonical).not.toContain('planHash');
  });

  it('accepts a SID or DOMAIN\\account as the invoking principal and rejects ACL syntax', () => {
    expect(isWindowsPrincipal('S-1-5-21-1000-1001-1002-1003')).toBe(true);
    expect(isWindowsPrincipal('TEST\\alice')).toBe(true);
    expect(isWindowsPrincipal('alice')).toBe(true);
    expect(isWindowsPrincipal('TEST\\alice:(OI)(CI)F')).toBe(false);
    expect(isWindowsPrincipal('*S-1-5-18')).toBe(false);
    expect(isWindowsPrincipal('TEST\\')).toBe(false);
    expect(isWindowsPrincipal('TEST\\..\\alice')).toBe(false);
  });

  it('parses validated blockers and the invoking user in the plan envelope', () => {
    const plan = applyPlan();
    plan.invokingUser = 'TEST\\alice';
    plan.blockers = [
      {
        code: 'required-missing',
        message: 'Install every bundled mod.',
        modIds: ['missing-mod'],
      },
    ];

    const parsed = parsePlan(plan);
    if (parsed.kind !== 'apply') throw new Error('Expected an apply plan.');
    expect(parsed.invokingUser).toBe('TEST\\alice');
    expect(parsed.blockers).toEqual([
      {
        code: 'required-missing',
        message: 'Install every bundled mod.',
        modIds: ['missing-mod'],
      },
    ]);

    plan.invokingUser = 'TEST\\alice:(OI)(CI)F';
    expect(() => parsePlan(plan)).toThrow(ValidationError);
  });

  it('uses the apply branch for apply plans and rejects a null profile ID', () => {
    const plan = applyPlan();
    plan.profileId = null;

    const error = validationError(() => parsePlan(plan));
    expect(error.details.map((detail) => formatIssuePath(detail.path))).toContain('profileId');
  });
});
