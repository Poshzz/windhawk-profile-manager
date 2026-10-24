import { z } from 'zod';
import { EntityIdSchema, IsoDateTimeSchema, RunIdSchema, SchemaVersionSchema } from './common';
import { parseDocument, parseJsonDocument } from '../validation/json';

export const LanguageSchema = z.enum(['system', 'th', 'en']);
export const AppearanceSchema = z.enum(['system', 'light', 'dark']);
export const ExplorerRestartSchema = z.enum(['ask', 'always', 'never']);
export const SnapshotRetentionSchema = z.number().int().min(5).max(50);

export const SettingsSchema = z.strictObject({
  language: LanguageSchema.default('system'),
  appearance: AppearanceSchema.default('system'),
  explorerRestart: ExplorerRestartSchema.default('ask'),
  snapshotRetention: SnapshotRetentionSchema.default(20),
});

export const SettingsPatchSchema = z.strictObject({
  language: LanguageSchema.optional(),
  appearance: AppearanceSchema.optional(),
  explorerRestart: ExplorerRestartSchema.optional(),
  snapshotRetention: SnapshotRetentionSchema.optional(),
});

export const AppStateSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  activeProfileId: EntityIdSchema.nullable().default(null),
  lastAppliedAt: IsoDateTimeSchema.nullable().default(null),
  lastRunId: RunIdSchema.nullable().default(null),
  firstRunCompleted: z.boolean().default(false),
  ...SettingsSchema.shape,
});

export type Settings = z.infer<typeof SettingsSchema>;
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;
export type AppState = z.infer<typeof AppStateSchema>;
export type Language = z.infer<typeof LanguageSchema>;
export type Appearance = z.infer<typeof AppearanceSchema>;

export function parseSettings(input: unknown): Settings {
  return parseDocument(SettingsSchema, input, 'Settings');
}

export function parseSettingsJson(text: string): Settings {
  return parseJsonDocument(SettingsSchema, text, 'Settings');
}

export function parseSettingsPatch(input: unknown): SettingsPatch {
  return parseDocument(SettingsPatchSchema, input, 'Settings patch');
}

export function parseAppState(input: unknown): AppState {
  return parseDocument(AppStateSchema, input, 'App state', 'appState');
}

export function parseAppStateJson(text: string): AppState {
  return parseJsonDocument(AppStateSchema, text, 'App state', 'appState');
}
