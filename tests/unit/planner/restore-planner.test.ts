import { describe, expect, it } from 'vitest';
import {
  canonicalPlanHashInput,
  parseSnapshotMetadata,
  type SnapshotMetadata,
} from '@shared/domain';
import {
  RESTORE_WARNING_CODES,
  buildRestorePlan,
  type BuildRestorePlanOptions,
} from '@core/planner/restore-planner';
import { hashCanonical } from '@core/planner/registry-state';
import { dword, makeSnapshot, modKeys, stringValue } from './support';

const SOURCE_ID = '2026-10-21T10-00-00-000Z';
const SOURCE_SHA = `sha256:${'a'.repeat(64)}`;

function metadata(overrides: Partial<SnapshotMetadata> = {}): SnapshotMetadata {
  return parseSnapshotMetadata({
    schemaVersion: 1,
    id: SOURCE_ID,
    createdAt: '2026-10-21T10:00:00.000Z',
    trigger: 'imported',
    profileId: null,
    appVersion: '0.1.0',
    windowsBuild: '22631',
    registryView: '64-bit',
    windhawkVersion: '1.7.3',
    windhawkStorageMode: 'registry',
    windhawkRegistryRoot: 'HKLM\\SOFTWARE\\Windhawk',
    windhawkServiceName: 'Windhawk',
    windhawkServiceState: 'running',
    rainmeterRunning: true,
    registryFile: `${SOURCE_ID}.reg`,
    registrySha256: SOURCE_SHA,
    modCount: 1,
    scope: 'engine-mods-configuration',
    ...overrides,
  });
}

function sourceRegistry() {
  return makeSnapshot([
    ...modKeys('alpha', {
      enabled: false,
      version: '1.0.0',
      settings: { Theme: stringValue('captured') },
      extraRootValues: { Include: stringValue('alpha.exe') },
    }),
  ]);
}

function options(overrides: Partial<BuildRestorePlanOptions> = {}): BuildRestorePlanOptions {
  const runId = 'run-restore-test-2026-10-22T20-10-00-000Z';
  const snapshotId = '2026-10-22T20-10-00-000Z';
  const appData = 'C:\\Users\\Test\\AppData\\Local\\WindhawkProfileManager';
  return {
    runId,
    snapshotId,
    paths: {
      plan: `C:\\ProgramData\\WindhawkProfileManager\\runs\\${runId}\\plan.json`,
      snapshotRegistry: `${appData}\\snapshots\\${snapshotId}.reg`,
      journal: `${appData}\\journal.json`,
      result: `C:\\ProgramData\\WindhawkProfileManager\\runs\\${runId}\\result.json`,
      sourceSnapshotRegistry: `${appData}\\snapshots\\${SOURCE_ID}.reg`,
    },
    invokingUser: 'TEST\\Test',
    snapshotRetentionLimit: 20,
    ...overrides,
  };
}

describe('buildRestorePlan', () => {
  it('binds the source checksum and targeting values into the hashed plan', () => {
    const registry = sourceRegistry();
    const plan = buildRestorePlan({ metadata: metadata(), registry }, registry, options());

    expect(plan.sourceSnapshotSha256).toBe(SOURCE_SHA);
    expect(plan.targetingValues).toEqual([{ modId: 'alpha', name: 'Include', value: 'alpha.exe' }]);
    expect(plan.targetingConfirmed).toBe(false);
    expect(plan.invokingUser).toBe('TEST\\Test');
    expect(plan.snapshotRetention).toBe(20);
    expect(
      plan.warnings.some((warning) => warning.code === RESTORE_WARNING_CODES.targetingValues),
    ).toBe(true);
    expect(plan.warnings[0]?.message).toContain('imported snapshot');
    expect(hashCanonical(canonicalPlanHashInput(plan))).toBe(plan.planHash);
  });

  it('changes the plan hash when targeting is confirmed or the source checksum changes', () => {
    const registry = sourceRegistry();
    const base = buildRestorePlan({ metadata: metadata(), registry }, registry, options());
    const confirmed = buildRestorePlan(
      { metadata: metadata(), registry },
      registry,
      options({
        confirmTargeting: true,
      }),
    );
    const changedSource = buildRestorePlan(
      {
        metadata: metadata({ registrySha256: `sha256:${'b'.repeat(64)}` }),
        registry,
      },
      registry,
      options(),
    );

    expect(confirmed.targetingConfirmed).toBe(true);
    expect(confirmed.planHash).not.toBe(base.planHash);
    expect(changedSource.sourceSnapshotSha256).toBe(`sha256:${'b'.repeat(64)}`);
    expect(changedSource.planHash).not.toBe(base.planHash);
  });

  it('adds no targeting warning when the snapshot has no targeting values', () => {
    const registry = makeSnapshot([
      ...modKeys('alpha', {
        enabled: true,
        settings: { Theme: stringValue('captured') },
        extraRootValues: { SettingsChangeTime: dword(12) },
      }),
    ]);
    const plan = buildRestorePlan(
      { metadata: metadata(), registry },
      registry,
      options({
        invokingUser: undefined,
        snapshotRetentionLimit: undefined,
      }),
    );

    expect(plan.targetingValues).toEqual([]);
    expect(plan.warnings).toEqual([]);
    expect(plan.invokingUser).toBeUndefined();
    expect(plan.snapshotRetention).toBeUndefined();
  });
});
