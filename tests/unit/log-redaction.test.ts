import { describe, expect, it } from 'vitest';
import { redactLogValue } from '../../src/main/log-redaction';

describe('log redaction', () => {
  it('removes full Windows paths, including paths with spaces and UNC paths', () => {
    expect(
      redactLogValue('C:\\Users\\alice\\My Documents\\WindhawkProfileManager\\snapshots\\a.reg'),
    ).toBe('[path]');
    expect(redactLogValue('\\\\server\\share\\secret')).toBe('[path]');
    expect(redactLogValue('//server/share/secret')).toBe('[path]');
    expect(redactLogValue('C:/Users/alice/secret')).toBe('[path]');
    expect(redactLogValue("C:\\Users\\alice\\Bob's file.txt")).toBe('[path]');
  });

  it('redacts settings payloads and values recursively', () => {
    const result = redactLogValue({
      modId: 'taskbar',
      settings: { Theme: { type: 'string', value: 'secret' } },
      nested: [{ value: 'secret', count: 2 }],
    });

    expect(result).toEqual({
      modId: 'taskbar',
      settings: '[redacted]',
      nested: [{ value: '[redacted]', count: 2 }],
    });
  });

  it('preserves redacted Error name, message, stack, and cause', () => {
    const error = new Error('failed C:\\Users\\alice\\My Documents\\x.reg', {
      cause: new Error('inner \\\\server\\share\\y'),
    });
    error.name = 'ApplyError';

    const result = redactLogValue(error) as Record<string, unknown>;
    expect(result['name']).toBe('ApplyError');
    expect(result['message']).toBe('failed [path]');
    expect(result['stack']).toContain('failed [path]');
    expect(result['cause']).toMatchObject({ message: 'inner [path]' });
  });

  it('keeps counts, ids, and result codes', () => {
    expect(redactLogValue({ operations: 4, modId: 'taskbar', status: 'succeeded' })).toEqual({
      operations: 4,
      modId: 'taskbar',
      status: 'succeeded',
    });
  });
});
