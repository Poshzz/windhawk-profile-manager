import type { SnapshotTrigger } from '@shared/domain';
import type { AppLocale, SnapshotSummary } from '@shared/ipc';

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isElevationCanceled(error: unknown): boolean {
  return /UAC prompt was canceled|ELEVATION_CANCELED|ElevationCanceled/i.test(errorMessage(error));
}

function compareNewestFirst(left: SnapshotSummary, right: SnapshotSummary): number {
  const difference = Date.parse(right.metadata.createdAt) - Date.parse(left.metadata.createdAt);
  return difference === 0 ? right.metadata.id.localeCompare(left.metadata.id) : difference;
}

/** The store sorts, but the screen owns the visible guarantee. */
export function sortSnapshotsNewestFirst(summaries: readonly SnapshotSummary[]): SnapshotSummary[] {
  return [...summaries].sort(compareNewestFirst);
}

export function upsertSnapshot(
  summaries: readonly SnapshotSummary[],
  summary: SnapshotSummary,
): SnapshotSummary[] {
  const withoutDuplicate = summaries.filter((entry) => entry.metadata.id !== summary.metadata.id);
  return sortSnapshotsNewestFirst([...withoutDuplicate, summary]);
}

export function removeSnapshot(
  summaries: readonly SnapshotSummary[],
  id: string,
): SnapshotSummary[] {
  return summaries.filter((entry) => entry.metadata.id !== id);
}

export function triggerTranslationKey(trigger: SnapshotTrigger): string {
  switch (trigger) {
    case 'pre-apply':
      return 'snapshots.trigger.preApply';
    case 'pre-restore':
      return 'snapshots.trigger.preRestore';
    case 'manual':
      return 'snapshots.trigger.manual';
    case 'imported':
      return 'snapshots.trigger.imported';
  }
}

/**
 * Sizes are shown with locale-aware digits and translated unit suffixes so the
 * renderer never hardcodes English text. Snapshots are capped well below 1 GB.
 */
export function formatSnapshotSize(
  sizeBytes: number,
  locale: AppLocale,
  translate: (key: string) => string,
): string {
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) {
    return translate('snapshots.size.unknown');
  }

  const whole = new Intl.NumberFormat(locale === 'th' ? 'th-TH' : 'en-US', {
    maximumFractionDigits: 0,
  });
  const fractional = new Intl.NumberFormat(locale === 'th' ? 'th-TH' : 'en-US', {
    maximumFractionDigits: 1,
    minimumFractionDigits: 0,
  });

  if (sizeBytes < 1024) {
    return `${whole.format(sizeBytes)} ${translate('snapshots.size.bytes')}`;
  }

  const kilobytes = sizeBytes / 1024;
  if (kilobytes < 1024) {
    return `${fractional.format(kilobytes)} ${translate('snapshots.size.kb')}`;
  }

  return `${fractional.format(kilobytes / 1024)} ${translate('snapshots.size.mb')}`;
}
