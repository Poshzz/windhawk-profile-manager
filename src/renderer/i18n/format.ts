import type { AppLocale } from '@shared/ipc';

export function formatDateTime(
  value: Date | string | number,
  locale: AppLocale,
  timeZone?: string,
): string {
  const date = value instanceof Date ? value : new Date(value);
  return new Intl.DateTimeFormat(locale === 'th' ? 'th-TH' : 'en-US', {
    calendar: 'gregory',
    dateStyle: 'medium',
    timeStyle: 'short',
    ...(timeZone === undefined ? {} : { timeZone }),
  }).format(date);
}
