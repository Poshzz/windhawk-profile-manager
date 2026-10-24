import { z } from 'zod';
import {
  AbsolutePathSchema,
  EntityIdSchema,
  ModIdSchema,
  RunIdSchema,
  SchemaVersionSchema,
  Sha256Schema,
  SnapshotIdSchema,
  hasControlCharacters,
  isDangerousKey,
  isPlainRecord,
} from './common';
import {
  ProfileActionsSchema,
  ProfileSettingNameSchema,
  ProfileSettingsMapSchema,
} from './profile';
import { SnapshotRetentionSchema } from './state';
import { parseDocument, parseJsonDocument } from '../validation/json';

const PRINCIPAL_FORBIDDEN_CHARACTERS = /[:*?"<>|;(),\r\n]/;

/**
 * A Windows principal accepted by the snapshot ACL: either a SID, a bare
 * account name, or DOMAIN\account. Shell/ACL metacharacters are rejected so the
 * value can never change the shape of an icacls argument.
 */
export function isWindowsPrincipal(value: string): boolean {
  if (value.length === 0 || value.length > 260) return false;
  if (value.trim() !== value || value.startsWith('*')) return false;
  if (hasControlCharacters(value)) return false;
  if (/^S-1-(?:\d+-)+\d+$/.test(value)) return true;
  if (PRINCIPAL_FORBIDDEN_CHARACTERS.test(value)) return false;

  const parts = value.split('\\');
  if (parts.length > 2) return false;
  return parts.every((part) => part.length > 0 && part !== '.' && part !== '..');
}

export const WindowsPrincipalSchema = z
  .string()
  .min(1)
  .max(260)
  .refine(isWindowsPrincipal, 'Expected a Windows SID or DOMAIN\\account name.');

const regPathSchema = AbsolutePathSchema.refine(
  (value) => value.toLowerCase().endsWith('.reg'),
  'Expected an absolute path to a .reg file.',
);

const jsonPathSchema = AbsolutePathSchema.refine(
  (value) => value.toLowerCase().endsWith('.json'),
  'Expected an absolute path to a .json file.',
);

const planPathsShape = {
  plan: jsonPathSchema,
  snapshotRegistry: regPathSchema,
  journal: jsonPathSchema,
  result: jsonPathSchema,
};

function refineDistinctPaths(
  paths: Record<string, string | undefined>,
  context: {
    addIssue(issue: { code: 'custom'; path: (string | number)[]; message: string }): void;
  },
): void {
  const values = Object.values(paths).filter((value): value is string => value !== undefined);
  const normalized = values.map((value) => value.replace(/\//g, '\\').toLowerCase());
  if (new Set(normalized).size !== values.length) {
    context.addIssue({
      code: 'custom',
      path: [],
      message: 'Plan paths must be distinct.',
    });
  }
}

export const PlanPathsSchema = z.strictObject(planPathsShape).superRefine(refineDistinctPaths);

export const RestorePathsSchema = z
  .strictObject({
    ...planPathsShape,
    sourceSnapshotRegistry: regPathSchema,
  })
  .superRefine(refineDistinctPaths);

export const PlanSkippedModSchema = z.strictObject({
  modId: ModIdSchema,
  reason: z.enum([
    'missing',
    'unlisted-policy',
    'missing-key',
    'newer-than-snapshot',
    'version-mismatch',
    'other',
  ]),
  message: z.string().min(1).max(500).optional(),
});

export const UnlistedModSchema = z.strictObject({
  modId: ModIdSchema,
  state: z.enum(['enabled', 'disabled']),
  policy: z.enum(['leave', 'disable']),
  willDisable: z.boolean(),
});

export const PlanWarningSchema = z.strictObject({
  code: z.string().min(1).max(64),
  message: z.string().min(1).max(1000),
  modId: ModIdSchema.optional(),
});

export const PlanBlockerSchema = z.strictObject({
  code: z.enum(['required-missing']),
  message: z.string().min(1).max(1000),
  modIds: z.array(ModIdSchema).min(1).max(1000),
});

export const RestoreTargetingValueSchema = z.strictObject({
  modId: ModIdSchema,
  name: z.string().min(1).max(255),
  value: z.string().max(1_048_576),
});

export const RestorePlanSummarySchema = z.strictObject({
  setValues: z.number().int().min(0).max(100_000),
  deleteValues: z.number().int().min(0).max(100_000),
  touchedMods: z.number().int().min(0).max(1000),
  skippedMods: z.array(PlanSkippedModSchema).max(1000).default([]),
});

export const PlanModChangeSchema = z
  .strictObject({
    modId: ModIdSchema,
    state: z.enum(['enabled', 'disabled']),
    mode: z.enum(['replace', 'merge']),
    settings: ProfileSettingsMapSchema,
    deleteValues: z.array(ProfileSettingNameSchema).max(100_000).default([]),
    settingsChanged: z.boolean(),
    deleteAllSettings: z.boolean().default(false),
    settingsHash: Sha256Schema,
  })
  .superRefine((change, context) => {
    if (change.mode === 'merge' && change.deleteValues.length > 0) {
      context.addIssue({
        code: 'custom',
        path: ['deleteValues'],
        message: 'Merge mode cannot delete settings.',
      });
    }

    if (change.deleteAllSettings && change.mode !== 'replace') {
      context.addIssue({
        code: 'custom',
        path: ['deleteAllSettings'],
        message: 'Only replace mode can delete all settings.',
      });
    }

    const deleteValues = new Set<string>();
    for (const [index, name] of change.deleteValues.entries()) {
      const normalized = name.toLowerCase();
      if (deleteValues.has(normalized)) {
        context.addIssue({
          code: 'custom',
          path: ['deleteValues', index],
          message: `Duplicate delete value "${name}".`,
        });
      }
      deleteValues.add(normalized);
    }
  });

const planBaseShape = {
  schemaVersion: SchemaVersionSchema,
  runId: RunIdSchema,
  snapshotId: SnapshotIdSchema,
  profileId: EntityIdSchema.nullable(),
  profileRevision: z.number().int().min(0).max(2_147_483_647),
  beforeHash: Sha256Schema,
  actions: ProfileActionsSchema,
  /**
   * The non-elevated account that invoked the run. The helper uses it for
   * snapshot ACLs instead of its own elevated identity. Optional only so plans
   * written before this field existed still parse; every planner includes it.
   */
  invokingUser: WindowsPrincipalSchema.optional(),
  /** The persisted automatic-snapshot retention limit, applied by the helper. */
  snapshotRetention: SnapshotRetentionSchema.optional(),
  planHash: Sha256Schema,
};

export const ApplyPlanSchema = z
  .strictObject({
    ...planBaseShape,
    kind: z.literal('apply'),
    profileId: EntityIdSchema,
    profileRevision: z.number().int().min(1).max(2_147_483_647),
    paths: PlanPathsSchema,
    modChanges: z.array(PlanModChangeSchema).max(1000).default([]),
    missingMods: z.array(PlanSkippedModSchema).max(1000).default([]),
    unlistedMods: z.array(UnlistedModSchema).max(1000).default([]),
    unlistedPolicy: z.enum(['leave', 'disable']),
    noOp: z.boolean(),
    deleteAllSettingsConfirmed: z.boolean().default(false),
    blockers: z.array(PlanBlockerSchema).max(100).default([]),
    warnings: z.array(PlanWarningSchema).max(1000).default([]),
  })
  .superRefine((plan, context) => {
    const modIds = new Set<string>();
    for (const [index, change] of plan.modChanges.entries()) {
      if (modIds.has(change.modId)) {
        context.addIssue({
          code: 'custom',
          path: ['modChanges', index, 'modId'],
          message: `Duplicate mod change "${change.modId}".`,
        });
      }
      modIds.add(change.modId);
    }

    for (const [index, mod] of plan.unlistedMods.entries()) {
      if (mod.policy !== plan.unlistedPolicy) {
        context.addIssue({
          code: 'custom',
          path: ['unlistedMods', index, 'policy'],
          message: 'Every unlisted mod must use the plan-level unlisted policy.',
        });
      }
    }
  });

export const RestorePlanSchema = z.strictObject({
  ...planBaseShape,
  kind: z.literal('restore'),
  profileId: z.null(),
  profileRevision: z.number().int().min(0).max(2_147_483_647),
  sourceSnapshotId: SnapshotIdSchema,
  /** The source .reg checksum the user previewed; the helper verifies it. */
  sourceSnapshotSha256: Sha256Schema.optional(),
  targetingValues: z.array(RestoreTargetingValueSchema).max(10_000).default([]),
  targetingConfirmed: z.boolean().default(false),
  summary: RestorePlanSummarySchema.default({
    setValues: 0,
    deleteValues: 0,
    touchedMods: 0,
    skippedMods: [],
  }),
  paths: RestorePathsSchema,
  warnings: z.array(PlanWarningSchema).max(1000).default([]),
});

export const ExecutionPlanSchema = z.discriminatedUnion('kind', [
  ApplyPlanSchema,
  RestorePlanSchema,
]);

export type PlanPaths = z.infer<typeof PlanPathsSchema>;
export type RestorePaths = z.infer<typeof RestorePathsSchema>;
export type PlanModChange = z.infer<typeof PlanModChangeSchema>;
export type PlanSkippedMod = z.infer<typeof PlanSkippedModSchema>;
export type UnlistedMod = z.infer<typeof UnlistedModSchema>;
export type PlanWarning = z.infer<typeof PlanWarningSchema>;
export type PlanBlocker = z.infer<typeof PlanBlockerSchema>;
export type RestoreTargetingValue = z.infer<typeof RestoreTargetingValueSchema>;
export type RestorePlanSummary = z.infer<typeof RestorePlanSummarySchema>;
export type ApplyPlan = z.infer<typeof ApplyPlanSchema>;
export type RestorePlan = z.infer<typeof RestorePlanSchema>;
export type ExecutionPlan = z.infer<typeof ExecutionPlanSchema>;

export function stableStringify(value: unknown): string {
  if (value === null) return 'null';

  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Cannot canonicalize a non-finite number.');
    }
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }

  if (isPlainRecord(value)) {
    const entries = Object.keys(value)
      .sort()
      .map((key) => {
        if (isDangerousKey(key)) {
          throw new TypeError(`Cannot canonicalize dangerous key "${key}".`);
        }
        const child = value[key];
        if (child === undefined) {
          throw new TypeError(`Cannot canonicalize undefined at key "${key}".`);
        }
        return `${JSON.stringify(key)}:${stableStringify(child)}`;
      });
    return `{${entries.join(',')}}`;
  }

  throw new TypeError(`Cannot canonicalize value of type ${typeof value}.`);
}

export function canonicalPlanHashInput<T extends { planHash?: string }>(plan: T): string {
  const copy: Record<string, unknown> = { ...plan };
  delete copy.planHash;
  return stableStringify(copy);
}

export function parsePlan(input: unknown): ExecutionPlan {
  return parseDocument(ExecutionPlanSchema, input, 'Execution plan', 'executionPlan');
}

export function parsePlanJson(text: string): ExecutionPlan {
  return parseJsonDocument(ExecutionPlanSchema, text, 'Execution plan', 'executionPlan');
}
