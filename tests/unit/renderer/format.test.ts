import { describe, expect, it } from 'vitest';
import { formatDateTime } from '../../../src/renderer/i18n/format';

describe('date formatting', () => {
  it('uses the Gregorian calendar for Thai dates', () => {
    const formatted = formatDateTime('2026-01-02T03:04:00.000Z', 'th', 'UTC');
    expect(formatted).toContain('2026');
    expect(formatted).not.toContain('2569');
  });

  it('formats English dates without changing the instant', () => {
    const formatted = formatDateTime('2026-01-02T03:04:00.000Z', 'en', 'UTC');
    expect(formatted).toContain('2026');
    expect(formatted).toMatch(/3:04/);
  });
});
