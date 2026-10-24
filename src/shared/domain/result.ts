import { z } from 'zod';
import { ERROR_CODES, type ErrorCode } from '../errors';
import { IsoDateTimeSchema, ModIdSchema, RunIdSchema, SchemaVersionSchema } from './common';
import { PlanSkippedModSchema } from './plan';
import { parseDocument } from '../validation/json';

const errorCodes = Object.values(ERROR_CODES) as [ErrorCode, ...ErrorCode[]];

export const SerializedErrorSchema = z.strictObject({
  code: z.enum(errorCodes),
  name: z.string().min(1).max(100),
  message: z.string().max(4000),
  details: z
    .array(
      z.strictObject({
        path: z.array(z.union([z.string(), z.number()])).max(100),
        message: z.string().max(2000),
      }),
    )
    .default([]),
});

export const ApplyStatusSchema = z.enum([
  'succeeded',
  'succeeded-with-warning',
  'rolled-back',
  'rollback-failed',
  'failed',
  'canceled',
  'dry-run',
]);

export const ActionOutcomeSchema = z.strictObject({
  status: z.enum(['succeeded', 'failed', 'skipped']),
  message: z.string().max(1000).optional(),
});

export const VerificationSchema = z.strictObject({
  status: z.enum(['verified', 'not-verified', 'not-run']),
  checkedAt: IsoDateTimeSchema.nullable(),
  message: z.string().max(1000),
});

export const RollbackResultSchema = z.strictObject({
  status: z.enum(['succeeded', 'failed']),
  message: z.string().max(2000).optional(),
});

export const ApplyResultSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  runId: RunIdSchema,
  kind: z.enum(['apply', 'restore']),
  status: ApplyStatusSchema,
  message: z.string().min(1).max(2000),
  startedAt: IsoDateTimeSchema,
  completedAt: IsoDateTimeSchema.nullable(),
  changedMods: z.array(ModIdSchema).max(1000).default([]),
  skippedMods: z.array(PlanSkippedModSchema).max(1000).default([]),
  warnings: z.array(z.string().max(1000)).max(1000).default([]),
  reload: z.strictObject({
    requested: z.boolean(),
    confirmed: z.literal(false),
    message: z.string().max(1000),
  }),
  verification: VerificationSchema,
  actions: z.strictObject({
    rainmeter: ActionOutcomeSchema,
    explorer: ActionOutcomeSchema,
  }),
  rollback: RollbackResultSchema.nullable(),
  error: SerializedErrorSchema.nullable(),
});

export type ApplyResult = z.infer<typeof ApplyResultSchema>;
export type ApplyStatus = z.infer<typeof ApplyStatusSchema>;
export type ActionOutcome = z.infer<typeof ActionOutcomeSchema>;
export type RollbackResult = z.infer<typeof RollbackResultSchema>;

export const TERMINAL_APPLY_STATUSES = [
  'succeeded',
  'succeeded-with-warning',
  'rolled-back',
  'rollback-failed',
  'failed',
  'canceled',
  'dry-run',
] as const satisfies readonly ApplyStatus[];

export function isTerminalApplyStatus(status: ApplyStatus): boolean {
  return (TERMINAL_APPLY_STATUSES as readonly string[]).includes(status);
}

export function parseApplyResult(input: unknown): ApplyResult {
  return parseDocument(ApplyResultSchema, input, 'Apply result', 'applyResult');
}
