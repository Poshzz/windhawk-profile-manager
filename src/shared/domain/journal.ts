import { z } from 'zod';
import {
  IsoDateTimeSchema,
  RunIdSchema,
  SchemaVersionSchema,
  Sha256Schema,
  SnapshotIdSchema,
} from './common';
import { ExecutionPlanSchema } from './plan';
import { ApplyResultSchema } from './result';
import { parseDocument, parseJsonDocument } from '../validation/json';

export const JOURNAL_STATES = [
  'preflight',
  'snapshotting',
  'journaling',
  'applying',
  'settling',
  'verifying',
  'privileged-complete',
  'finishing',
  'succeeded',
  'succeeded-with-warning',
  'rolling-back',
  'rolled-back',
  'rollback-failed',
] as const;

export const JournalStateSchema = z.enum(JOURNAL_STATES);

/**
 * A per-run fencing token. It is optional so journals written before the
 * lifetime lease existed still parse; every begin() writes a fresh token.
 */
export const RunTokenSchema = z.string().min(16).max(128);

export const JournalSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  runId: RunIdSchema,
  runToken: RunTokenSchema.optional(),
  state: JournalStateSchema,
  startedAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  snapshotId: SnapshotIdSchema,
  planHash: Sha256Schema,
  beforeHash: Sha256Schema,
  profileRevision: z.number().int().min(0).max(2_147_483_647),
  plan: ExecutionPlanSchema,
  result: ApplyResultSchema.nullable(),
});

export type Journal = z.infer<typeof JournalSchema>;
export type JournalState = z.infer<typeof JournalStateSchema>;

export const TERMINAL_JOURNAL_STATES = [
  'succeeded',
  'succeeded-with-warning',
  'rolled-back',
  'rollback-failed',
] as const satisfies readonly JournalState[];

export function isTerminalJournalState(state: JournalState): boolean {
  return (TERMINAL_JOURNAL_STATES as readonly string[]).includes(state);
}

export function isUnfinishedJournalState(state: JournalState): boolean {
  return !isTerminalJournalState(state);
}

export function parseJournal(input: unknown): Journal {
  return parseDocument(JournalSchema, input, 'Journal', 'journal');
}

export function parseJournalJson(text: string): Journal {
  return parseJsonDocument(JournalSchema, text, 'Journal', 'journal');
}
