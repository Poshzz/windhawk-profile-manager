import { z } from 'zod';
import {
  AbsolutePathSchema,
  EntityIdSchema,
  IsoDateTimeSchema,
  ModIdSchema,
  SchemaVersionSchema,
  ServiceStateSchema,
  WindhawkStorageModeSchema,
} from './common';
import { parseDocument } from '../validation/json';

export const CompatibilityModeSchema = z.enum(['writable', 'read-only', 'unsupported']);

export const CompatibilityIssueSchema = z.strictObject({
  code: z.enum([
    'windows-version',
    'windhawk-missing',
    'portable',
    'non-hklm-root',
    'user-scoped',
    'helper-missing',
    'unsupported-architecture',
    'other',
  ]),
  message: z.string().min(1).max(1000),
});

export const CompatibilitySchema = z.strictObject({
  mode: CompatibilityModeSchema,
  canApply: z.boolean(),
  issues: z.array(CompatibilityIssueSchema).max(100).default([]),
});

const libraryFileNameSchema = z
  .string()
  .min(1)
  .max(260)
  .regex(/^[^\\/:*?"<>|]+$/, 'Expected a bare DLL file name.');

export const InstallInfoSchema = z.strictObject({
  installed: z.boolean(),
  installDir: AbsolutePathSchema.nullable(),
  iniPath: AbsolutePathSchema.nullable(),
  version: z.string().min(1).max(64).nullable(),
  engineVersion: z.string().min(1).max(64).nullable(),
  storageMode: WindhawkStorageModeSchema,
  portable: z.boolean(),
  registryRoot: z.string().min(1).max(512).nullable(),
});

export const ServiceInfoSchema = z.strictObject({
  name: z.string().min(1).max(256),
  state: ServiceStateSchema,
});

export const InstalledModSchema = z.strictObject({
  modId: ModIdSchema,
  libraryFileName: libraryFileNameSchema,
  version: z.string().min(1).max(64).nullable(),
  enabled: z.boolean(),
  settingsCount: z.number().int().min(0).max(1_000_000),
  perUserConfig: z.boolean(),
});

export const RainmeterInfoSchema = z.strictObject({
  installed: z.boolean(),
  running: z.boolean(),
  path: AbsolutePathSchema.nullable(),
});

export const PerUserConfigSchema = z.strictObject({
  present: z.boolean(),
  active: z.boolean(),
  sid: z.string().min(1).max(184).nullable(),
});

export const WindowsInfoSchema = z.strictObject({
  version: z.string().min(1).max(64),
  build: z.string().regex(/^\d{1,10}$/, 'Expected a numeric Windows build.'),
  supported: z.boolean(),
});

export const EnvironmentSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  probedAt: IsoDateTimeSchema,
  windows: WindowsInfoSchema,
  windhawk: InstallInfoSchema,
  service: ServiceInfoSchema,
  mods: z.array(InstalledModSchema).max(100_000).default([]),
  rainmeter: RainmeterInfoSchema,
  perUserConfig: PerUserConfigSchema,
  compatibility: CompatibilitySchema,
});

export const DriftEntrySchema = z.strictObject({
  modId: ModIdSchema,
  kind: z.enum(['enabled-state', 'settings', 'missing', 'version']),
  message: z.string().min(1).max(1000),
  current: z.string().max(1000).nullable().default(null),
  desired: z.string().max(1000).nullable().default(null),
});

export const DriftSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  profileId: EntityIdSchema,
  status: z.enum(['matches', 'different', 'unknown']),
  checkedAt: IsoDateTimeSchema,
  entries: z.array(DriftEntrySchema).max(100_000).default([]),
  reason: z.string().min(1).max(1000).nullable().default(null),
});

export type Compatibility = z.infer<typeof CompatibilitySchema>;
export type CompatibilityIssue = z.infer<typeof CompatibilityIssueSchema>;
export type InstallInfo = z.infer<typeof InstallInfoSchema>;
export type ServiceInfo = z.infer<typeof ServiceInfoSchema>;
export type InstalledMod = z.infer<typeof InstalledModSchema>;
export type RainmeterInfo = z.infer<typeof RainmeterInfoSchema>;
export type PerUserConfig = z.infer<typeof PerUserConfigSchema>;
export type WindowsInfo = z.infer<typeof WindowsInfoSchema>;
export type Environment = z.infer<typeof EnvironmentSchema>;
export type Drift = z.infer<typeof DriftSchema>;
export type DriftEntry = z.infer<typeof DriftEntrySchema>;

export function parseEnvironment(input: unknown): Environment {
  return parseDocument(EnvironmentSchema, input, 'Environment', 'environment');
}

export function parseDrift(input: unknown): Drift {
  return parseDocument(DriftSchema, input, 'Drift', 'drift');
}
