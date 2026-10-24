import type { z } from 'zod';
import { isDangerousKey, isPlainRecord } from '../domain/common';
import { migrate, type SchemaName } from '../domain/migrations';
import { ValidationError } from '../errors';
import { formatIssuePath, parseWithSchema } from './schema';

type JsonPath = (string | number)[];

function forbiddenKeyError(key: string, path: JsonPath): ValidationError {
  const displayPath = formatIssuePath(path);
  return new ValidationError(`Forbidden object key "${key}" at ${displayPath}`, [
    { path: [...path, key], message: `The key "${key}" is not allowed.` },
  ]);
}

export function sanitizeJsonValue(
  value: unknown,
  path: JsonPath = [],
  seen = new WeakSet(),
): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new ValidationError('JSON numbers must be finite.', [
        { path, message: 'Expected a finite number.' },
      ]);
    }
    return value;
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) {
      throw new ValidationError('JSON values must not be cyclic.', [
        { path, message: 'Cyclic array.' },
      ]);
    }
    seen.add(value);
    const result = value.map((item, index) => sanitizeJsonValue(item, [...path, index], seen));
    seen.delete(value);
    return result;
  }

  if (!isPlainRecord(value)) {
    throw new ValidationError('Expected a JSON-compatible plain object.', [
      { path, message: `Unsupported value of type ${typeof value}.` },
    ]);
  }

  if (seen.has(value)) {
    throw new ValidationError('JSON values must not be cyclic.', [
      { path, message: 'Cyclic object.' },
    ]);
  }
  seen.add(value);

  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(value)) {
    if (isDangerousKey(key)) throw forbiddenKeyError(key, path);
    result[key] = sanitizeJsonValue(value[key], [...path, key], seen);
  }

  seen.delete(value);
  return result;
}

export function parseJson(text: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ValidationError(
      `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      [{ path: [], message: 'The document is not valid JSON.' }],
      { cause: error },
    );
  }

  return sanitizeJsonValue(parsed);
}

export function parseDocument<T>(
  schema: z.ZodType<T>,
  input: unknown,
  label: string,
  schemaName?: SchemaName,
): T {
  const sanitized = sanitizeJsonValue(input);
  const migrated = schemaName === undefined ? sanitized : migrate(schemaName, sanitized);
  return parseWithSchema(schema, migrated, label);
}

export function parseJsonDocument<T>(
  schema: z.ZodType<T>,
  text: string,
  label: string,
  schemaName?: SchemaName,
): T {
  return parseDocument(schema, parseJson(text), label, schemaName);
}
