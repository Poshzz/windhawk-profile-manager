import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ValidationError } from '@shared/errors';
import { parsePlan } from '@shared/domain';
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
import { makeRestorePlanForTest } from '../executor/executor-support';
import { parseHelperArguments } from '../../../src/main/helper/arguments';
import { parseStrictJson } from '../../../src/main/helper/strict-json';
import { readHelperPlanFile } from '../../../src/main/helper/plan-file';

const MOD = 'sample-mod';

function planFixture(): ReturnType<typeof buildPlan> {
  const snapshot = makeSnapshot([
    ...modKeys(MOD, {
      enabled: true,
      version: '1',
      settings: { Theme: stringValue('old') },
    }),
  ]);
  return buildPlan(
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
    planOptions(),
  );
}

function hashText(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

describe('parseHelperArguments', () => {
  const plan = 'C:\\ProgramData\\WindhawkProfileManager\\runs\\run-1\\plan.json';

  it('returns null for a normal GUI launch', () => {
    expect(parseHelperArguments(['--some-chromium-flag'])).toBeNull();
  });

  it('parses the helper plan, hash, and dry-run flag', () => {
    expect(
      parseHelperArguments(['--helper', '--plan', plan, '--hash', 'A'.repeat(64), '--dry-run']),
    ).toEqual({
      serviceStart: false,
      planPath: plan,
      expectedHash: `sha256:${'a'.repeat(64)}`,
      dryRun: true,
    });
  });

  it('rejects missing, duplicate, and unknown arguments', () => {
    expect(() => parseHelperArguments(['--helper'])).toThrow(ValidationError);
    expect(() => parseHelperArguments(['--helper', '--plan', plan])).toThrow(ValidationError);
    expect(() =>
      parseHelperArguments(['--helper', '--plan', plan, '--hash', 'a'.repeat(64), '--hash']),
    ).toThrow(ValidationError);
    expect(() =>
      parseHelperArguments(['--helper', '--plan', plan, '--hash', 'a'.repeat(64), '--wat']),
    ).toThrow(ValidationError);
  });

  it('parses the service-only helper mode without a plan', () => {
    expect(parseHelperArguments(['--helper', '--service-start'])).toEqual({
      serviceStart: true,
    });
    expect(() =>
      parseHelperArguments([
        '--helper',
        '--service-start',
        '--plan',
        plan,
        '--hash',
        'a'.repeat(64),
      ]),
    ).toThrow(ValidationError);
  });

  it('rejects relative paths and invalid hashes', () => {
    expect(() =>
      parseHelperArguments(['--helper', '--plan', 'plan.json', '--hash', 'a'.repeat(64)]),
    ).toThrow(ValidationError);
    expect(() =>
      parseHelperArguments(['--helper', '--plan', plan, '--hash', 'not-a-hash']),
    ).toThrow(ValidationError);
  });
});

describe('parseStrictJson', () => {
  it('rejects duplicate keys at any depth', () => {
    expect(() => parseStrictJson('{"a":1,"a":2}')).toThrow(/Duplicate object key/);
    expect(() => parseStrictJson('{"a":{"b":1,"b":2}}')).toThrow(/Duplicate object key/);
    expect(() => parseStrictJson('{"\\u0061":1,"a":2}')).toThrow(/Duplicate object key/);
  });

  it('accepts valid JSON and rejects trailing content or control characters', () => {
    expect(parseStrictJson('{"a":[1,true,null,"x"],"b":-1.5e2}')).toEqual({
      a: [1, true, null, 'x'],
      b: -150,
    });
    expect(() => parseStrictJson('{"a":1} x')).toThrow(ValidationError);
    expect(() => parseStrictJson('{"a":"\n"}')).toThrow(ValidationError);
  });

  it('rejects dangerous keys through the shared sanitizer', () => {
    expect(() => parseStrictJson('{"__proto__":{"polluted":true}}')).toThrow(ValidationError);
  });
});

describe('readHelperPlanFile', () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  async function writePlan(text: string): Promise<{ path: string; hash: string }> {
    const directory = await mkdtemp(join(tmpdir(), 'wpm-helper-plan-'));
    directories.push(directory);
    const path = join(directory, 'plan.json');
    await writeFile(path, text, 'utf8');
    return { path, hash: hashText(text) };
  }

  it('reads a valid plan and verifies the file and internal hashes', async () => {
    const plan = planFixture();
    const text = `${JSON.stringify(plan, null, 2)}\n`;
    const { path, hash } = await writePlan(text);

    const result = await readHelperPlanFile(path, hash);
    expect(result.plan).toEqual(plan);
    expect(result.fileHash).toBe(hash);
  });

  it('rejects a tampered plan before parsing it', async () => {
    const plan = planFixture();
    const { path } = await writePlan(JSON.stringify(plan));
    await expect(readHelperPlanFile(path, `sha256:${'0'.repeat(64)}`)).rejects.toThrow(
      /hash does not match/,
    );
  });

  it('rejects oversized plans', async () => {
    const { path, hash } = await writePlan('{"a":1}');
    await expect(readHelperPlanFile(path, hash, { maxBytes: 4 })).rejects.toThrow(/size limit/);
  });

  it('rejects duplicate JSON keys even when the file hash matches', async () => {
    const plan = planFixture();
    const text = JSON.stringify(plan).replace('{', `{"kind":"restore",`);
    const { path, hash } = await writePlan(text);
    await expect(readHelperPlanFile(path, hash)).rejects.toThrow(/Duplicate object key/);
  });

  it('rejects an out-of-allowlist settings value or unknown field', async () => {
    const plan = planFixture();
    const poisoned = structuredClone(plan) as unknown as {
      modChanges: Array<{ settings: Record<string, unknown> }>;
    };
    poisoned.modChanges[0]!.settings['Include'] = { type: 'string', value: 'x.exe' };
    const text = JSON.stringify(poisoned);
    const { path, hash } = await writePlan(text);
    await expect(readHelperPlanFile(path, hash)).rejects.toThrow(ValidationError);

    const unknown = JSON.parse(JSON.stringify(plan)) as Record<string, unknown>;
    unknown['unexpected'] = true;
    const second = await writePlan(JSON.stringify(unknown));
    await expect(readHelperPlanFile(second.path, second.hash)).rejects.toThrow(ValidationError);
  });

  it('rejects a plan whose internal planHash no longer matches', async () => {
    const plan = planFixture();
    const tampered = { ...JSON.parse(JSON.stringify(plan)), planHash: `sha256:${'1'.repeat(64)}` };
    const text = JSON.stringify(tampered);
    const { path, hash } = await writePlan(text);
    await expect(readHelperPlanFile(path, hash)).rejects.toThrow(/contents do not match/);
  });

  it('parses the serialized plan as the same schema', () => {
    expect(parsePlan(JSON.parse(JSON.stringify(planFixture())))).toMatchObject({ kind: 'apply' });
  });

  it('accepts a restore plan through the same helper file boundary', async () => {
    const sourceSnapshot = makeSnapshot([
      ...modKeys(MOD, {
        enabled: true,
        version: '1',
        settings: { Theme: stringValue('old') },
      }),
    ]);
    const plan = makeRestorePlanForTest({
      source: { metadata: { id: 'source-1' }, registry: sourceSnapshot },
      current: sourceSnapshot,
    });
    const text = `${JSON.stringify(plan, null, 2)}\n`;
    const { path, hash } = await writePlan(text);

    const result = await readHelperPlanFile(path, hash);
    expect(result.plan.kind).toBe('restore');
  });
});
