import { z } from 'zod';
import {
  IsoDateTimeSchema,
  ModIdSchema,
  RegistryViewSchema,
  SchemaVersionSchema,
  hasControlCharacters,
} from './common';
import { parseDocument, parseJsonDocument } from '../validation/json';

export const REGISTRY_MODS_ROOT = 'HKLM\\SOFTWARE\\Windhawk\\Engine\\Mods';

const registryRootPrefix = /^HKLM\\SOFTWARE\\Windhawk\\Engine\\Mods\\/i;

export function isRegistryModsRootPath(value: string): boolean {
  return value.toLowerCase() === REGISTRY_MODS_ROOT.toLowerCase();
}

export function isRegistryKeyPath(value: string): boolean {
  if (value.length === 0 || value.length > 4096 || value.includes('\0')) return false;
  if (isRegistryModsRootPath(value)) return true;
  if (!registryRootPrefix.test(value)) return false;

  const remainder = value.slice(REGISTRY_MODS_ROOT.length + 1);
  const segments = remainder.split('\\');
  if (
    segments.length === 0 ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === '.' ||
        segment === '..' ||
        /[\\/]/.test(segment) ||
        hasControlCharacters(segment),
    )
  ) {
    return false;
  }

  return ModIdSchema.safeParse(segments[0]).success;
}

export const RegistryKeyPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    isRegistryKeyPath,
    `Expected a key at or under ${REGISTRY_MODS_ROOT}; keys outside the Windhawk mods subtree are rejected.`,
  );

export function isRegistryWritePath(value: string): boolean {
  if (isRegistryModsRootPath(value)) return false;
  if (!isRegistryKeyPath(value)) return false;

  const segments = value.slice(REGISTRY_MODS_ROOT.length + 1).split('\\');
  return (
    segments.length === 1 || (segments.length === 2 && segments[1]?.toLowerCase() === 'settings')
  );
}

export const RegistryWritePathSchema = RegistryKeyPathSchema.refine(
  isRegistryWritePath,
  'Registry writes are limited to a mod key or its Settings subkey.',
);

export const RegistryValueNameSchema = z
  .string()
  .max(16383)
  .refine(
    (value) => !value.includes('\0') && !value.includes('\r') && !value.includes('\n'),
    'Registry value names cannot contain NUL or newlines.',
  );

function isModRootPath(value: string): boolean {
  if (isRegistryModsRootPath(value)) return false;
  if (!isRegistryKeyPath(value)) return false;
  return !value.slice(REGISTRY_MODS_ROOT.length + 1).includes('\\');
}

function refineWritableValueName(
  operation: { path: string; name: string },
  context: {
    addIssue(issue: { code: 'custom'; path: (string | number)[]; message: string }): void;
  },
): void {
  if (
    isModRootPath(operation.path) &&
    (operation.name.toLowerCase() === 'libraryfilename' ||
      operation.name.toLowerCase() === 'version')
  ) {
    context.addIssue({
      code: 'custom',
      path: ['name'],
      message: 'LibraryFileName and Version are owned by Windhawk and cannot be written.',
    });
  }
}

const DwordValueSchema = z.strictObject({
  type: z.literal('dword'),
  value: z.number().int().min(0).max(0xffffffff),
});

const QwordValueSchema = z.strictObject({
  type: z.literal('qword'),
  value: z
    .string()
    .regex(/^(0|[1-9][0-9]{0,19})$/, 'QWORDs are stored as unsigned decimal strings.')
    .refine((value) => BigInt(value) <= 0xffffffffffffffffn, 'QWORD exceeds 64 bits.'),
});

const StringValueSchema = z.strictObject({
  type: z.literal('string'),
  value: z.string().max(1_048_576),
});

const ExpandStringValueSchema = z.strictObject({
  type: z.literal('expandString'),
  value: z.string().max(1_048_576),
});

const MultiStringValueSchema = z.strictObject({
  type: z.literal('multiString'),
  value: z
    .array(z.string().refine((entry) => !entry.includes('\0'), 'Multi-strings cannot contain NUL.'))
    .max(10_000),
});

const BinaryValueSchema = z.strictObject({
  type: z.literal('binary'),
  value: z
    .string()
    .max(1_048_576)
    .regex(/^(?:[0-9a-fA-F]{2})*$/, 'Binary values are stored as an even-length hex string.'),
});

const NoneValueSchema = z.strictObject({
  type: z.literal('none'),
  value: z.null(),
});

export const RegistryValueSchema = z.discriminatedUnion('type', [
  DwordValueSchema,
  QwordValueSchema,
  StringValueSchema,
  ExpandStringValueSchema,
  MultiStringValueSchema,
  BinaryValueSchema,
  NoneValueSchema,
]);

export const RegistryValueEntrySchema = z.strictObject({
  name: RegistryValueNameSchema,
  value: RegistryValueSchema,
});

export const RegistryKeySchema = z
  .strictObject({
    path: RegistryKeyPathSchema,
    values: z.array(RegistryValueEntrySchema).max(100_000),
  })
  .superRefine((key, context) => {
    if (isRegistryModsRootPath(key.path) && key.values.length > 0) {
      context.addIssue({
        code: 'custom',
        path: ['values'],
        message: 'The Windhawk mods root cannot contain values.',
      });
    }

    const names = new Set<string>();
    for (const [index, entry] of key.values.entries()) {
      const normalized = entry.name.toLowerCase();
      if (names.has(normalized)) {
        context.addIssue({
          code: 'custom',
          path: ['values', index, 'name'],
          message: `Duplicate value name "${entry.name}".`,
        });
      }
      names.add(normalized);
    }
  });

export const RegistrySnapshotSchema = z
  .strictObject({
    schemaVersion: SchemaVersionSchema,
    capturedAt: IsoDateTimeSchema,
    registryView: RegistryViewSchema,
    keys: z.array(RegistryKeySchema).max(10_000),
  })
  .superRefine((snapshot, context) => {
    const paths = new Set<string>();
    for (const [index, key] of snapshot.keys.entries()) {
      const normalized = key.path.toLowerCase();
      if (paths.has(normalized)) {
        context.addIssue({
          code: 'custom',
          path: ['keys', index, 'path'],
          message: `Duplicate registry key "${key.path}".`,
        });
      }
      paths.add(normalized);
    }
  });

const SetRegistryOpSchema = z
  .strictObject({
    kind: z.literal('set'),
    path: RegistryWritePathSchema,
    name: RegistryValueNameSchema,
    value: RegistryValueSchema,
  })
  .superRefine(refineWritableValueName);

const DeleteRegistryValueOpSchema = z
  .strictObject({
    kind: z.literal('deleteValue'),
    path: RegistryWritePathSchema,
    name: RegistryValueNameSchema,
  })
  .superRefine(refineWritableValueName);

export const RegistryOpSchema = z.discriminatedUnion('kind', [
  SetRegistryOpSchema,
  DeleteRegistryValueOpSchema,
]);

export const RegistryOpsSchema = z.array(RegistryOpSchema).max(100_000);

export type RegistryValue = z.infer<typeof RegistryValueSchema>;
export type RegistryValueEntry = z.infer<typeof RegistryValueEntrySchema>;
export type RegistryKey = z.infer<typeof RegistryKeySchema>;
export type RegistrySnapshot = z.infer<typeof RegistrySnapshotSchema>;
export type RegistryOp = z.infer<typeof RegistryOpSchema>;
export type RegistryValueType = RegistryValue['type'];

export function getModIdFromRegistryPath(path: string): string | null {
  if (!isRegistryKeyPath(path) || isRegistryModsRootPath(path)) return null;
  return path.slice(REGISTRY_MODS_ROOT.length + 1).split('\\')[0] ?? null;
}

export function parseRegistrySnapshot(input: unknown): RegistrySnapshot {
  return parseDocument(RegistrySnapshotSchema, input, 'Registry snapshot', 'registrySnapshot');
}

export function parseRegistrySnapshotJson(text: string): RegistrySnapshot {
  return parseJsonDocument(RegistrySnapshotSchema, text, 'Registry snapshot', 'registrySnapshot');
}

export function parseRegistryOps(input: unknown): RegistryOp[] {
  return parseDocument(RegistryOpsSchema, input, 'Registry operations');
}
