import { z } from 'zod';
import {
  REGISTRY_MODS_ROOT,
  RegistryValueNameSchema,
  RegistryValueSchema,
  RegistryWritePathSchema,
  isRegistryModsRootPath,
  parseRegistrySnapshot,
  stableStringify,
  type RegistrySnapshot,
  type RegistryValue,
} from '@shared/domain';
import { ValidationError } from '@shared/errors';
import { parseDocument } from '@shared/validation/json';

export const RESTORE_ROOT_VALUE_NAMES: ReadonlySet<string> = new Set([
  'disabled',
  'include',
  'exclude',
  'architecture',
  'includecustom',
  'excludecustom',
  'includeexcludecustomonly',
]);

const TARGETING_ROOT_VALUE_NAMES: ReadonlySet<string> = new Set([
  'include',
  'exclude',
  'architecture',
  'includecustom',
  'excludecustom',
  'includeexcludecustomonly',
]);

const WRITABLE_SETTING_TYPES: ReadonlySet<RegistryValue['type']> = new Set([
  'dword',
  'qword',
  'string',
  'expandString',
  'binary',
]);

export function isWritableSettingValue(value: RegistryValue): boolean {
  return WRITABLE_SETTING_TYPES.has(value.type);
}

function isWritableRestoreValueNamed(path: string, name: string, value: RegistryValue): boolean {
  if (isSettingsPath(path)) return isWritableSettingValue(value);
  if (!isModRootPath(path)) return false;
  const normalizedName = name.toLowerCase();
  if (!RESTORE_ROOT_VALUE_NAMES.has(normalizedName)) return false;
  if (normalizedName === 'disabled') return value.type === 'dword';
  return value.type === 'string';
}

export interface RegistryMutationSet {
  readonly kind: 'set';
  readonly path: string;
  readonly name: string;
  readonly value: RegistryValue;
}

export interface RegistryMutationDelete {
  readonly kind: 'deleteValue';
  readonly path: string;
  readonly name: string;
}

export type RegistryMutation = RegistryMutationSet | RegistryMutationDelete;

function isModRootPath(path: string): boolean {
  const suffix = path.slice(REGISTRY_MODS_ROOT.length + 1);
  return suffix.length > 0 && !suffix.includes('\\');
}

function isSettingsPath(path: string): boolean {
  const suffix = path.slice(REGISTRY_MODS_ROOT.length + 1);
  return suffix.split('\\').length === 2 && suffix.toLowerCase().endsWith('\\settings');
}

function isAllowedRestoreValue(path: string, name: string): boolean {
  if (isSettingsPath(path)) return true;
  if (!isModRootPath(path)) return false;
  return RESTORE_ROOT_VALUE_NAMES.has(name.toLowerCase());
}

function refineRestoreSet(
  operation: { path: string; name: string; value: RegistryValue },
  context: {
    addIssue(issue: { code: 'custom'; path: (string | number)[]; message: string }): void;
  },
): void {
  if (isSettingsPath(operation.path)) {
    if (!isWritableSettingValue(operation.value)) {
      context.addIssue({
        code: 'custom',
        path: ['value', 'type'],
        message: `Settings values of type "${operation.value.type}" cannot be restored by the registry gateway.`,
      });
    }
    return;
  }
  if (!isModRootPath(operation.path)) return;

  const normalizedName = operation.name.toLowerCase();
  if (!RESTORE_ROOT_VALUE_NAMES.has(normalizedName)) {
    context.addIssue({
      code: 'custom',
      path: ['name'],
      message: `Restore writes are limited at the mod root; "${operation.name}" is not a restoreable value.`,
    });
    return;
  }

  if (normalizedName === 'disabled' && operation.value.type !== 'dword') {
    context.addIssue({
      code: 'custom',
      path: ['value', 'type'],
      message: 'The Disabled value must be a DWORD.',
    });
    return;
  }

  if (TARGETING_ROOT_VALUE_NAMES.has(normalizedName) && operation.value.type !== 'string') {
    context.addIssue({
      code: 'custom',
      path: ['value', 'type'],
      message: 'Captured targeting values must be strings.',
    });
  }
}

function refineRestoreDelete(
  operation: { path: string; name: string },
  context: {
    addIssue(issue: { code: 'custom'; path: (string | number)[]; message: string }): void;
  },
): void {
  if (
    isModRootPath(operation.path) &&
    !RESTORE_ROOT_VALUE_NAMES.has(operation.name.toLowerCase())
  ) {
    context.addIssue({
      code: 'custom',
      path: ['name'],
      message: `Restore deletes are limited at the mod root; "${operation.name}" is not a restoreable value.`,
    });
  }
}

const RestoreSetSchema = z
  .strictObject({
    kind: z.literal('set'),
    path: RegistryWritePathSchema,
    name: RegistryValueNameSchema,
    value: RegistryValueSchema,
  })
  .superRefine(refineRestoreSet);

const RestoreDeleteSchema = z
  .strictObject({
    kind: z.literal('deleteValue'),
    path: RegistryWritePathSchema,
    name: RegistryValueNameSchema,
  })
  .superRefine(refineRestoreDelete);

const RestoreOperationsSchema = z
  .array(z.discriminatedUnion('kind', [RestoreSetSchema, RestoreDeleteSchema]))
  .max(100_000);

export function parseRestoreRegistryOps(input: unknown): RegistryMutation[] {
  return parseDocument(RestoreOperationsSchema, input, 'Restore registry operations');
}

export interface ReconcileOptions {
  /**
   * Restore must not overwrite or delete a current value that the gateway
   * cannot write back if the restore later fails.
   */
  readonly requireRestorableCurrent?: boolean;
}

export function planReconcileOperations(
  snapshot: RegistrySnapshot,
  current: RegistrySnapshot,
  options: ReconcileOptions = {},
): RegistryMutation[] {
  const desired = parseRegistrySnapshot(snapshot);
  const currentSnapshot = parseRegistrySnapshot(current);
  const currentByPath = new Map(
    currentSnapshot.keys.map((key) => [key.path.toLowerCase(), key] as const),
  );
  const operations: RegistryMutation[] = [];

  for (const key of desired.keys) {
    if (isRegistryModsRootPath(key.path)) continue;
    if (!isModRootPath(key.path) && !isSettingsPath(key.path)) continue;

    const currentKey = currentByPath.get(key.path.toLowerCase());
    const desiredNames = new Set(key.values.map((entry) => entry.name.toLowerCase()));
    for (const entry of key.values) {
      if (!isAllowedRestoreValue(key.path, entry.name)) continue;
      const currentEntry = currentKey?.values.find(
        (value) => value.name.toLowerCase() === entry.name.toLowerCase(),
      );

      if (!isWritableRestoreValueNamed(key.path, entry.name, entry.value)) {
        if (
          currentEntry !== undefined &&
          stableStringify(currentEntry.value) === stableStringify(entry.value)
        ) {
          continue;
        }
        throw new ValidationError(
          `Setting "${entry.name}" has type "${entry.value.type}", which the registry gateway cannot restore.`,
        );
      }

      if (
        options.requireRestorableCurrent === true &&
        currentEntry !== undefined &&
        !isWritableRestoreValueNamed(key.path, currentEntry.name, currentEntry.value)
      ) {
        throw new ValidationError(
          `Current value "${entry.name}" has type "${currentEntry.value.type}", which cannot be restored if the operation fails.`,
        );
      }

      operations.push({
        kind: 'set',
        path: key.path,
        name: entry.name,
        value: entry.value,
      });
    }

    for (const entry of currentKey?.values ?? []) {
      if (desiredNames.has(entry.name.toLowerCase())) continue;
      if (!isAllowedRestoreValue(key.path, entry.name)) continue;
      if (
        options.requireRestorableCurrent === true &&
        !isWritableRestoreValueNamed(key.path, entry.name, entry.value)
      ) {
        throw new ValidationError(
          `Current value "${entry.name}" has type "${entry.value.type}", which cannot be restored if the operation fails.`,
        );
      }
      operations.push({
        kind: 'deleteValue',
        path: key.path,
        name: entry.name,
      });
    }
  }

  const parsed = parseRestoreRegistryOps(operations);
  if (parsed.length !== operations.length) {
    throw new ValidationError('Restore planning lost registry operations.');
  }
  return parsed;
}
