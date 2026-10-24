import { z } from 'zod';
import {
  EntityIdSchema,
  IsoDateTimeSchema,
  RegistryViewSchema,
  SchemaVersionSchema,
  ServiceStateSchema,
  Sha256Schema,
  SnapshotIdSchema,
  WindhawkStorageModeSchema,
  hasControlCharacters,
} from './common';
import { parseDocument, parseJsonDocument } from '../validation/json';

export const SnapshotTriggerSchema = z.enum(['pre-apply', 'pre-restore', 'manual', 'imported']);

export const SNAPSHOT_SCOPE = 'engine-mods-configuration' as const;

const registryFileNameSchema = z
  .string()
  .min(5)
  .max(260)
  .regex(/^[^\\/:*?"<>|]+\.reg$/, 'Expected a .reg file name without a path.')
  .refine(
    (value) => !hasControlCharacters(value),
    'Snapshot file names cannot contain control characters.',
  );

export const SnapshotMetadataSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  id: SnapshotIdSchema,
  createdAt: IsoDateTimeSchema,
  trigger: SnapshotTriggerSchema,
  profileId: EntityIdSchema.nullable().default(null),
  appVersion: z.string().min(1).max(64),
  windowsBuild: z.string().regex(/^\d{1,10}$/, 'Expected a numeric Windows build.'),
  registryView: RegistryViewSchema,
  windhawkVersion: z.string().min(1).max(64).nullable(),
  windhawkStorageMode: WindhawkStorageModeSchema,
  windhawkRegistryRoot: z.string().min(1).max(512).nullable().default(null),
  windhawkServiceName: z.string().min(1).max(256),
  windhawkServiceState: ServiceStateSchema,
  rainmeterRunning: z.boolean(),
  registryFile: registryFileNameSchema,
  registrySha256: Sha256Schema,
  modCount: z.number().int().min(0).max(100_000),
  scope: z.literal(SNAPSHOT_SCOPE),
  excludedPaths: z.array(z.string().min(1).max(1024)).max(32).default([]),
});

export type SnapshotMetadata = z.infer<typeof SnapshotMetadataSchema>;
export type SnapshotTrigger = z.infer<typeof SnapshotTriggerSchema>;

export function parseSnapshotMetadata(input: unknown): SnapshotMetadata {
  return parseDocument(SnapshotMetadataSchema, input, 'Snapshot metadata', 'snapshotMetadata');
}

export function parseSnapshotMetadataJson(text: string): SnapshotMetadata {
  return parseJsonDocument(SnapshotMetadataSchema, text, 'Snapshot metadata', 'snapshotMetadata');
}
