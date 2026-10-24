import { SCHEMA_VERSION, isPlainRecord } from './common';
import { ValidationError } from '../errors';

export const SCHEMA_NAMES = [
  'profile',
  'registrySnapshot',
  'snapshotMetadata',
  'executionPlan',
  'journal',
  'applyResult',
  'appState',
  'environment',
  'drift',
  'themePack',
] as const;

export type SchemaName = (typeof SCHEMA_NAMES)[number];

export type Migration = (value: unknown) => unknown;

const migrationRegistry = new Map<string, Map<number, Migration>>();

export function registerMigration(
  schemaName: SchemaName | string,
  fromVersion: number,
  migration: Migration,
): void {
  if (!Number.isInteger(fromVersion) || fromVersion < 1) {
    throw new RangeError('Migration source version must be a positive integer.');
  }

  let chain = migrationRegistry.get(schemaName);
  if (chain === undefined) {
    chain = new Map();
    migrationRegistry.set(schemaName, chain);
  }

  if (chain.has(fromVersion)) {
    throw new Error(`A migration from ${schemaName} v${fromVersion} is already registered.`);
  }

  chain.set(fromVersion, migration);
}

export function migrate(schemaName: SchemaName | string, input: unknown): unknown {
  if (!isPlainRecord(input)) return input;

  const version = input.schemaVersion;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return input;
  }

  if (version > SCHEMA_VERSION) {
    throw new ValidationError(
      `${schemaName}: schemaVersion ${version} is newer than supported version ${SCHEMA_VERSION}.`,
      [{ path: ['schemaVersion'], message: 'Unsupported schema version.' }],
    );
  }

  let currentVersion = version;
  let value: unknown = input;

  while (currentVersion < SCHEMA_VERSION) {
    const migration = migrationRegistry.get(schemaName)?.get(currentVersion);
    if (migration === undefined) {
      throw new ValidationError(
        `${schemaName}: no migration from schemaVersion ${currentVersion} to ${currentVersion + 1}.`,
        [{ path: ['schemaVersion'], message: 'Missing migration.' }],
      );
    }

    value = migration(value);
    if (!isPlainRecord(value)) {
      throw new ValidationError(`${schemaName}: migration did not return an object.`);
    }

    const nextVersion = value.schemaVersion;
    if (nextVersion !== currentVersion + 1) {
      throw new ValidationError(
        `${schemaName}: migration from ${currentVersion} produced schemaVersion ${String(nextVersion)}.`,
        [{ path: ['schemaVersion'], message: 'Migration did not advance the version.' }],
      );
    }

    currentVersion = nextVersion;
  }

  return value;
}
