const WINDOWS_PATH = /(?:[A-Za-z]:[\\/]|\\\\|\/\/)[^\r\n"<>|]*/g;
const REDACTED_KEYS = new Set([
  'settings',
  'settingsmap',
  'registryvalues',
  'profilevalues',
  'value',
]);

function redactString(value: string): string {
  return value.replace(WINDOWS_PATH, '[path]');
}

function redactError(value: Error, depth: number): Record<string, unknown> {
  const result: Record<string, unknown> = {
    name: value.name,
    message: redactString(value.message),
  };
  if (value.stack !== undefined) result['stack'] = redactString(value.stack);
  for (const key of ['code', 'errno', 'syscall'] as const) {
    const entry = (value as Error & Record<string, unknown>)[key];
    if (typeof entry === 'string' || typeof entry === 'number') result[key] = entry;
  }
  if ('cause' in value) {
    result['cause'] = redactLogValue((value as Error & { cause?: unknown }).cause, depth + 1);
  }
  if (value instanceof AggregateError && value.errors.length > 0) {
    result['errors'] = value.errors.map((entry) => redactLogValue(entry, depth + 1));
  }
  return result;
}

/**
 * Keeps log records useful without writing settings values or full user paths.
 * Object keys that are known to carry settings are replaced wholesale.
 */
export function redactLogValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[depth-limit]';
  if (typeof value === 'string') return redactString(value);
  if (value instanceof Error) return redactError(value, depth);
  if (Array.isArray(value)) {
    return value.map((entry) => redactLogValue(entry, depth + 1));
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(record)) {
      result[key] = REDACTED_KEYS.has(key.toLowerCase())
        ? '[redacted]'
        : redactLogValue(entry, depth + 1);
    }
    return result;
  }
  return value;
}
