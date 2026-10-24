import type { z } from 'zod';
import { ValidationError, type ErrorDetail } from '../errors';

export function formatIssuePath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return '$';

  let formatted = '';
  for (const segment of path) {
    if (typeof segment === 'number') {
      formatted += `[${segment}]`;
    } else if (formatted.length === 0) {
      formatted = String(segment);
    } else {
      formatted += `.${String(segment)}`;
    }
  }
  return formatted;
}

export function formatZodIssues(error: z.ZodError): ErrorDetail[] {
  return error.issues.flatMap((issue) => {
    if (issue.code === 'unrecognized_keys') {
      return issue.keys.map((key) => ({
        path: [...issue.path, key].filter(
          (segment): segment is string | number =>
            typeof segment === 'string' || typeof segment === 'number',
        ),
        message: `Unrecognized field "${key}".`,
      }));
    }

    return [
      {
        path: issue.path.filter(
          (segment): segment is string | number =>
            typeof segment === 'string' || typeof segment === 'number',
        ),
        message: issue.message,
      },
    ];
  });
}

export function parseWithSchema<T>(schema: z.ZodType<T>, input: unknown, label: string): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;

  const details = formatZodIssues(result.error);
  const summary = details
    .map((detail) => `${formatIssuePath(detail.path)}: ${detail.message}`)
    .join('; ');

  throw new ValidationError(`${label}: ${summary}`, details);
}
