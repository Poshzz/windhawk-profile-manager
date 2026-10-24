import { z } from 'zod';

export const SCHEMA_VERSION = 1 as const;

export const SchemaVersionSchema = z.literal(SCHEMA_VERSION);

export const EntityIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'Must be a lowercase slug (a-z, 0-9, hyphen).');

/**
 * Windhawk IDs are lowercase slugs. Locally-added mods use Windhawk's documented
 * `local@` prefix, e.g. `local@windows-11-notification-center-styler-fork`.
 * The prefix is still constrained to a single safe registry path component.
 */
export const MOD_ID_PATTERN = /^(?:local@)?[a-z0-9][a-z0-9-]{0,63}$/;

export const ModIdSchema = z
  .string()
  .min(1)
  .max(70)
  .regex(MOD_ID_PATTERN, 'Mod IDs must match ^(?:local@)?[a-z0-9][a-z0-9-]{0,63}$.');

export const SnapshotIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/, 'Must be a filesystem-safe snapshot ID.');

export const RunIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^run-[A-Za-z0-9][A-Za-z0-9._-]{0,123}$/, 'Run IDs must start with "run-".');

export const IsoDateTimeSchema = z.iso.datetime({ offset: true });

export const Sha256Schema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/, 'Expected a lowercase sha256: digest.');

export const RegistryViewSchema = z.literal('64-bit');

export const ServiceStateSchema = z.enum(['running', 'stopped', 'missing', 'unknown']);

export type ServiceState = z.infer<typeof ServiceStateSchema>;

export const WindhawkStorageModeSchema = z.enum(['registry', 'portable', 'unknown']);

function hasAlternateDataStream(normalized: string): boolean {
  if (/^[A-Za-z]:\\/.test(normalized)) return normalized.slice(2).includes(':');
  if (/^\\\\\?\\[A-Za-z]:\\/.test(normalized)) return normalized.slice(6).includes(':');
  if (/^\\\\\?\\UNC\\/i.test(normalized)) return normalized.slice(8).includes(':');
  return normalized.slice(2).includes(':');
}

export function isAbsoluteWindowsPath(value: string): boolean {
  if (value.length === 0 || hasControlCharacters(value)) return false;

  const normalized = value.replace(/\//g, '\\');
  if (normalized.startsWith('\\\\.\\')) return false;

  const isDrive = /^[A-Za-z]:\\/.test(normalized);
  const isUnc = /^\\\\[^\\]+\\[^\\]+/.test(normalized);
  const isExtendedDrive = /^\\\\\?\\[A-Za-z]:\\/.test(normalized);
  const isExtendedUnc = /^\\\\\?\\UNC\\[^\\]+\\[^\\]+/i.test(normalized);

  if (normalized.startsWith('\\\\?\\') && !isExtendedDrive && !isExtendedUnc) return false;
  if (!isDrive && !isUnc && !isExtendedDrive && !isExtendedUnc) return false;
  if (hasAlternateDataStream(normalized)) return false;

  return !normalized.split('\\').some((segment) => segment === '.' || segment === '..');
}

export const AbsolutePathSchema = z
  .string()
  .min(3)
  .max(32767)
  .refine(isAbsoluteWindowsPath, 'Expected an absolute Windows path without "." or "..".');

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function isDangerousKey(key: string): boolean {
  return key === '__proto__' || key === 'constructor' || key === 'prototype';
}

export function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && codePoint <= 0x1f) return true;
  }
  return false;
}
