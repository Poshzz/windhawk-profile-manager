import { ChevronDown, Download, RotateCcw, Trash2 } from 'lucide-react';
import type { ReactElement, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { SnapshotMetadata } from '@shared/domain';
import type { SnapshotDetail, SnapshotSummary } from '@shared/ipc';
import { Badge, type BadgeTone } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { formatDateTime } from '../../i18n/format';
import { formatSnapshotSize, triggerTranslationKey } from './snapshot-utils';

export interface SnapshotDetailState {
  readonly loading: boolean;
  readonly error: string | null;
  readonly detail: SnapshotDetail | null;
}

export interface SnapshotRowProps {
  readonly summary: SnapshotSummary;
  readonly expanded: boolean;
  readonly detailState: SnapshotDetailState | undefined;
  readonly exporting: boolean;
  readonly onToggle: () => void;
  readonly onRetry: () => void;
  readonly onExport: () => void;
  readonly onDelete: () => void;
  readonly onRestore: () => void;
}

function triggerTone(trigger: SnapshotMetadata['trigger']): BadgeTone {
  switch (trigger) {
    case 'manual':
    case 'imported':
      return 'info';
    case 'pre-restore':
      return 'warning';
    case 'pre-apply':
      return 'neutral';
  }
}

function MetadataEntry({
  label,
  children,
  mono = false,
}: {
  readonly label: string;
  readonly children: ReactNode;
  readonly mono?: boolean;
}): ReactElement {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--faint)]">
        {label}
      </dt>
      <dd
        className={
          mono
            ? 'mt-1 break-all font-mono text-[11px] text-[var(--muted)]'
            : 'mt-1 break-words text-xs text-[var(--text)]'
        }
      >
        {children}
      </dd>
    </div>
  );
}

export function SnapshotRow({
  summary,
  expanded,
  detailState,
  exporting,
  onToggle,
  onRetry,
  onExport,
  onDelete,
  onRestore,
}: SnapshotRowProps): ReactElement {
  const { t, i18n } = useTranslation();
  const locale = i18n.language === 'th' ? 'th' : 'en';
  const { metadata } = summary;
  const capturedAt = formatDateTime(metadata.createdAt, locale);
  const panelId = `snapshot-panel-${metadata.id}`;
  const profileLabel =
    metadata.profileId === null
      ? t('snapshots.noProfile')
      : t('snapshots.profile', { id: metadata.profileId });
  const checksumPending = detailState === undefined || detailState.loading;
  const checksumFailed =
    detailState !== undefined && !detailState.loading && detailState.error !== null;
  const checksumVerified =
    detailState !== undefined &&
    !detailState.loading &&
    detailState.error === null &&
    detailState.detail !== null;

  return (
    <Card className="overflow-hidden">
      <button
        type="button"
        className="flex w-full items-start gap-3 px-4 py-4 text-left transition-colors hover:bg-[var(--card-muted)]"
        aria-expanded={expanded}
        aria-controls={panelId}
        aria-label={
          expanded
            ? t('snapshots.row.collapse', { at: capturedAt })
            : t('snapshots.row.expand', { at: capturedAt })
        }
        onClick={onToggle}
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-[var(--text)]">{capturedAt}</span>
            <Badge tone={triggerTone(metadata.trigger)}>
              {t(triggerTranslationKey(metadata.trigger))}
            </Badge>
            {summary.retained ? (
              <Badge tone="info">{t('snapshots.retained')}</Badge>
            ) : (
              <Badge tone="neutral">{t('snapshots.automatic')}</Badge>
            )}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--muted)]">
            <span>{profileLabel}</span>
            <span aria-hidden="true">·</span>
            <span>{t('snapshots.modCount', { count: metadata.modCount })}</span>
            <span aria-hidden="true">·</span>
            <span>{formatSnapshotSize(summary.sizeBytes, locale, t)}</span>
          </div>
        </div>
        <ChevronDown
          size={16}
          className={
            expanded
              ? 'mt-1 shrink-0 rotate-180 text-[var(--faint)] transition-transform'
              : 'mt-1 shrink-0 text-[var(--faint)] transition-transform'
          }
          aria-hidden="true"
        />
      </button>

      {expanded ? (
        <div
          id={panelId}
          role="region"
          aria-label={t('snapshots.detail.label')}
          className="border-t border-[var(--border)] px-4 py-4"
        >
          <dl className="grid gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
            <MetadataEntry label={t('snapshots.detail.captured')}>{capturedAt}</MetadataEntry>
            <MetadataEntry label={t('snapshots.detail.trigger')}>
              {t(triggerTranslationKey(metadata.trigger))}
            </MetadataEntry>
            <MetadataEntry label={t('snapshots.detail.profile')}>{profileLabel}</MetadataEntry>
            <MetadataEntry label={t('snapshots.detail.mods')}>
              {t('snapshots.modCount', { count: metadata.modCount })}
            </MetadataEntry>
            <MetadataEntry label={t('snapshots.detail.size')}>
              {formatSnapshotSize(summary.sizeBytes, locale, t)}
            </MetadataEntry>
            <MetadataEntry label={t('snapshots.detail.windowsBuild')}>
              {metadata.windowsBuild}
            </MetadataEntry>
            <MetadataEntry label={t('snapshots.detail.windhawkVersion')}>
              {metadata.windhawkVersion ?? t('common.notAvailable')}
            </MetadataEntry>
            <MetadataEntry label={t('snapshots.detail.storageMode')}>
              {t(`snapshots.storage.${metadata.windhawkStorageMode}`)}
            </MetadataEntry>
            <MetadataEntry label={t('snapshots.detail.serviceState')}>
              {t(`snapshots.service.${metadata.windhawkServiceState}`)}
            </MetadataEntry>
            <MetadataEntry label={t('snapshots.detail.rainmeter')}>
              {metadata.rainmeterRunning
                ? t('snapshots.detail.rainmeterRunning')
                : t('snapshots.detail.rainmeterNotRunning')}
            </MetadataEntry>
            <MetadataEntry label={t('snapshots.detail.id')} mono>
              {metadata.id}
            </MetadataEntry>
            <MetadataEntry label={t('snapshots.detail.registryFile')} mono>
              {metadata.registryFile}
            </MetadataEntry>
            <MetadataEntry label={t('snapshots.detail.checksum')} mono>
              {metadata.registrySha256}
            </MetadataEntry>
          </dl>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            {checksumPending ? (
              <Badge tone="neutral">{t('snapshots.detail.checkingChecksum')}</Badge>
            ) : checksumFailed ? (
              <>
                <Badge tone="danger">{t('snapshots.detail.checksumError')}</Badge>
                <span className="text-xs text-[var(--danger)]" role="alert">
                  {detailState.error}
                </span>
                <Button size="sm" variant="ghost" onClick={onRetry}>
                  {t('common.retry')}
                </Button>
              </>
            ) : checksumVerified ? (
              <Badge tone="success">{t('snapshots.detail.checksumVerified')}</Badge>
            ) : null}
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="primary" size="sm" onClick={onRestore}>
              <RotateCcw size={14} className="mr-2" aria-hidden="true" />
              {t('snapshots.actions.restore')}
            </Button>
            <Button variant="secondary" size="sm" disabled={exporting} onClick={onExport}>
              <Download size={14} className="mr-2" aria-hidden="true" />
              {exporting ? t('snapshots.actions.exporting') : t('snapshots.actions.export')}
            </Button>
            <Button variant="danger" size="sm" onClick={onDelete}>
              <Trash2 size={14} className="mr-2" aria-hidden="true" />
              {t('snapshots.actions.delete')}
            </Button>
          </div>
        </div>
      ) : null}
    </Card>
  );
}
