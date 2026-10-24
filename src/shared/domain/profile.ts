import { z } from 'zod';
import {
  EntityIdSchema,
  IsoDateTimeSchema,
  ModIdSchema,
  SchemaVersionSchema,
  hasControlCharacters,
  isDangerousKey,
} from './common';
import { parseDocument, parseJsonDocument } from '../validation/json';

export const PROFILE_SOURCES = ['builtin', 'user', 'imported'] as const;
export const PROFILE_MOD_STATES = ['enabled', 'disabled'] as const;
export const PROFILE_SETTINGS_MODES = ['replace', 'merge'] as const;
export const UNLISTED_MOD_POLICIES = ['leave', 'disable'] as const;
export const RAINMETER_ACTIONS = ['start', 'stop', 'unchanged'] as const;
export const EXPLORER_RESTART_PREFERENCES = ['ask', 'always', 'never'] as const;

export const PROFILE_SETTING_TYPE_MESSAGE =
  'Profile settings support only REG_SZ (string) and REG_DWORD (dword).';

export const FORBIDDEN_PROFILE_VALUE_NAMES = new Set(
  [
    'Include',
    'Exclude',
    'Architecture',
    'IncludeCustom',
    'ExcludeCustom',
    'IncludeExcludeCustomOnly',
    'PatternsMatchCriticalSystemProcesses',
    'LoggingEnabled',
    'DebugLoggingEnabled',
    'LibraryFileName',
    'Version',
    'SettingsChangeTime',
    'Disabled',
    '__proto__',
    'constructor',
    'prototype',
  ].map((name) => name.toLowerCase()),
);

export const ProfileSettingNameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (name) => !hasControlCharacters(name) && !name.includes('\\'),
    'Setting names cannot contain control characters or backslashes.',
  )
  .refine((name) => !isDangerousKey(name), 'Setting names cannot be dangerous object keys.')
  .refine(
    (name) => !FORBIDDEN_PROFILE_VALUE_NAMES.has(name.toLowerCase()),
    'Targeting, machine-specific, and reload-marker values are not allowed in profiles.',
  );

export const ProfileSettingSchema = z
  .discriminatedUnion('type', [
    z.strictObject({
      type: z.literal('string'),
      value: z.string().max(1_048_576),
    }),
    z.strictObject({
      type: z.literal('dword'),
      value: z.number().int().min(0).max(0xffffffff),
    }),
  ])
  .describe(PROFILE_SETTING_TYPE_MESSAGE);

export const ProfileSettingsMapSchema = z
  .record(z.string(), ProfileSettingSchema)
  .superRefine((settings, context) => {
    const seen = new Set<string>();
    for (const name of Object.keys(settings)) {
      const normalized = name.toLowerCase();
      if (seen.has(normalized)) {
        context.addIssue({
          code: 'custom',
          path: [name],
          message: `Duplicate setting name "${name}" (registry names are case-insensitive).`,
        });
      }
      seen.add(normalized);

      const parsed = ProfileSettingNameSchema.safeParse(name);
      if (parsed.success) continue;

      const issue = parsed.error.issues[0];
      context.addIssue({
        code: 'custom',
        path: [name],
        message: issue?.message ?? 'Invalid setting name.',
      });
    }
  });

export const ProfileActionsSchema = z
  .strictObject({
    rainmeter: z.enum(RAINMETER_ACTIONS).default('unchanged'),
    restartExplorer: z.enum(EXPLORER_RESTART_PREFERENCES).default('ask'),
  })
  .default({ rainmeter: 'unchanged', restartExplorer: 'ask' });

export const ProfileModSchema = z.strictObject({
  modId: ModIdSchema,
  state: z.enum(PROFILE_MOD_STATES),
  mode: z.enum(PROFILE_SETTINGS_MODES).default('replace'),
  settings: ProfileSettingsMapSchema.default({}),
});

export const ProfileSchema = z
  .strictObject({
    schemaVersion: SchemaVersionSchema,
    id: EntityIdSchema,
    name: z.string().min(1).max(100),
    description: z.string().max(1000).default(''),
    source: z.enum(PROFILE_SOURCES),
    basedOn: EntityIdSchema.nullable().default(null),
    revision: z.number().int().min(1).max(2_147_483_647),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
    requiredMods: z.array(ProfileModSchema).max(1000).default([]),
    unlistedMods: z.enum(UNLISTED_MOD_POLICIES).default('leave'),
    actions: ProfileActionsSchema,
  })
  .superRefine((profile, context) => {
    const modIds = new Set<string>();
    for (const [index, mod] of profile.requiredMods.entries()) {
      if (modIds.has(mod.modId)) {
        context.addIssue({
          code: 'custom',
          path: ['requiredMods', index, 'modId'],
          message: `Duplicate managed mod "${mod.modId}".`,
        });
      }
      modIds.add(mod.modId);
    }
  });

export type Profile = z.infer<typeof ProfileSchema>;
export type ProfileMod = z.infer<typeof ProfileModSchema>;
export type ProfileSetting = z.infer<typeof ProfileSettingSchema>;
export type ProfileSettingsMap = z.infer<typeof ProfileSettingsMapSchema>;
export type ProfileActions = z.infer<typeof ProfileActionsSchema>;

export function parseProfile(input: unknown): Profile {
  return parseDocument(ProfileSchema, input, 'Profile', 'profile');
}

export function parseProfileJson(text: string): Profile {
  return parseJsonDocument(ProfileSchema, text, 'Profile', 'profile');
}
