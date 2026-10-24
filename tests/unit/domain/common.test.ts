import { describe, expect, it } from 'vitest';
import {
  AbsolutePathSchema,
  EntityIdSchema,
  IsoDateTimeSchema,
  ModIdSchema,
  RegistryViewSchema,
  RunIdSchema,
  SchemaVersionSchema,
  ServiceStateSchema,
  Sha256Schema,
  SnapshotIdSchema,
  WindhawkStorageModeSchema,
  hasControlCharacters,
} from '@shared/domain';

describe('common schemas', () => {
  it.each([
    ['entity ID', EntityIdSchema, 'mac-blur-glass', 'Mac_Blur'],
    ['mod ID', ModIdSchema, 'windows-11-taskbar-styler', 'Windows_11_Taskbar'],
    ['snapshot ID', SnapshotIdSchema, '2026-10-22T20-02-14-123Z', '../escape'],
    ['run ID', RunIdSchema, 'run-2026-10-22T20-02-14-123Z', 'apply-2026-10-22'],
    ['ISO timestamp', IsoDateTimeSchema, '2026-10-22T20:02:14.123Z', '2026-10-22'],
    ['SHA-256', Sha256Schema, `sha256:${'a'.repeat(64)}`, `sha256:${'A'.repeat(64)}`],
    ['absolute path', AbsolutePathSchema, 'C:\\Windhawk\\snapshot.reg', 'relative\\snapshot.reg'],
    ['schema version', SchemaVersionSchema, 1, 2],
    ['registry view', RegistryViewSchema, '64-bit', '32-bit'],
    ['service state', ServiceStateSchema, 'running', 'starting'],
    ['Windhawk mode', WindhawkStorageModeSchema, 'registry', 'ini'],
  ])('%s validates and rejects', (_label, schema, valid, invalid) => {
    expect(schema.safeParse(valid).success).toBe(true);
    expect(schema.safeParse(invalid).success).toBe(false);
  });

  it('detects control characters in names', () => {
    expect(hasControlCharacters('normal name')).toBe(false);
    expect(hasControlCharacters('bad\u0000name')).toBe(true);
    expect(hasControlCharacters('bad\nname')).toBe(true);
  });
});
