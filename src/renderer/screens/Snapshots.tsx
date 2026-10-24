import { History, RefreshCw, Settings2, ShieldCheck, Upload } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import type { SnapshotSummary } from '@shared/ipc';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Dialog } from '../components/ui/Dialog';
import { EmptyState } from '../components/ui/EmptyState';
import { ErrorState } from '../components/ui/ErrorState';
import { Toast, type ToastTone } from '../components/ui/Toast';
import { formatDateTime } from '../i18n/format';
import { Notice } from './profiles/Notice';
import { RestoreDialog } from './snapshots/RestoreDialog';
import { SnapshotRow, type SnapshotDetailState } from './snapshots/SnapshotRow';
import {
  errorMessage,
  removeSnapshot,
  sortSnapshotsNewestFirst,
  triggerTranslationKey,
  upsertSnapshot,
} from './snapshots/snapshot-utils';

interface Loadable<T> {
  readonly data: T | null;
  readonly loading: boolean;
  readonly error: string | null;
}

interface Feedback {
  readonly tone: ToastTone;
  readonly title: string;
  readonly description?: string;
}

function loadingState<T>(): Loadable<T> {
  return { data: null, loading: true, error: null };
}

export interface SnapshotsProps {
  /** Narrow route callback so retention can link to Settings. */
  readonly onNavigate: (screen: 'settings' | 'profiles') => void;
}

export function Snapshots({ onNavigate }: SnapshotsProps): ReactElement {
  const { t, i18n } = useTranslation();
  const locale = i18n.language === 'th' ? 'th' : 'en';
  const [summaries, setSummaries] = useState<Loadable<SnapshotSummary[]>>(() => loadingState());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, SnapshotDetailState>>({});
  const [notice, setNotice] = useState<Feedback | null>(null);
  const [importing, setImporting] = useState(false);
  const [exportingId, setExportingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SnapshotSummary | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<SnapshotSummary | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    setSummaries((current) => ({ ...current, loading: true, error: null }));
    try {
      const items = await window.api.listSnapshotSummaries();
      if (!mounted.current) return;
      const sorted = sortSnapshotsNewestFirst(items);
      setSummaries({ data: sorted, loading: false, error: null });
      setSelectedId((current) =>
        current !== null && sorted.some((entry) => entry.metadata.id === current) ? current : null,
      );
    } catch (error) {
      if (!mounted.current) return;
      setSummaries((current) => ({
        data: current.data,
        loading: false,
        error: errorMessage(error),
      }));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onFocus = (): void => {
      void refresh();
    };
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh]);

  const loadDetail = useCallback(async (id: string): Promise<void> => {
    setDetails((current) => ({
      ...current,
      [id]: {
        loading: true,
        error: null,
        detail: current[id]?.detail ?? null,
      },
    }));
    try {
      const detail = await window.api.getSnapshot(id);
      if (!mounted.current) return;
      setDetails((current) => ({
        ...current,
        [id]: { loading: false, error: null, detail },
      }));
    } catch (error) {
      if (!mounted.current) return;
      setDetails((current) => ({
        ...current,
        [id]: { loading: false, error: errorMessage(error), detail: null },
      }));
    }
  }, []);

  const handleToggle = (id: string): void => {
    const opening = selectedId !== id;
    setSelectedId(opening ? id : null);
    if (opening && details[id] === undefined) {
      void loadDetail(id);
    }
  };

  const handleImport = async (): Promise<void> => {
    if (importing) return;
    setImporting(true);
    setNotice(null);
    try {
      const imported = await window.api.importSnapshot();
      if (imported === null) return;
      setSummaries((current) => ({
        data: upsertSnapshot(current.data ?? [], imported),
        loading: false,
        error: null,
      }));
      setNotice({
        tone: 'success',
        title: t('snapshots.importSuccessTitle'),
        description: t('snapshots.importSuccessBody', {
          id: imported.metadata.id,
          count: imported.metadata.modCount,
        }),
      });
    } catch (error) {
      setNotice({
        tone: 'danger',
        title: t('snapshots.importErrorTitle'),
        description: errorMessage(error),
      });
    } finally {
      setImporting(false);
    }
  };

  const handleExport = async (summary: SnapshotSummary): Promise<void> => {
    if (exportingId !== null) return;
    setExportingId(summary.metadata.id);
    setNotice(null);
    try {
      const path = await window.api.exportSnapshot(summary.metadata.id);
      if (path === null) return;
      setNotice({
        tone: 'success',
        title: t('snapshots.exportSuccessTitle'),
        description: t('snapshots.exportSuccessBody', { path }),
      });
    } catch (error) {
      setNotice({
        tone: 'danger',
        title: t('snapshots.exportErrorTitle'),
        description: errorMessage(error),
      });
    } finally {
      setExportingId(null);
    }
  };

  const handleDeleteRequest = (summary: SnapshotSummary): void => {
    setDeleteError(null);
    setDeleteTarget(summary);
  };

  const handleDeleteConfirm = async (): Promise<void> => {
    const target = deleteTarget;
    if (target === null || deletePending) return;
    setDeletePending(true);
    setDeleteError(null);
    try {
      await window.api.deleteSnapshot(target.metadata.id);
      setSummaries((current) => ({
        data: current.data === null ? null : removeSnapshot(current.data, target.metadata.id),
        loading: false,
        error: null,
      }));
      setDetails((current) => {
        const next = { ...current };
        delete next[target.metadata.id];
        return next;
      });
      setSelectedId((current) => (current === target.metadata.id ? null : current));
      setDeleteTarget(null);
      setNotice({
        tone: 'success',
        title: t('snapshots.deleteSuccessTitle'),
        description: t('snapshots.deleteSuccessBody', {
          date: formatDateTime(target.metadata.createdAt, locale),
        }),
      });
    } catch (error) {
      setDeleteError(errorMessage(error));
    } finally {
      setDeletePending(false);
    }
  };

  const list = summaries.data ?? [];
  const listLoading = summaries.data === null && summaries.loading;
  const listFailed = summaries.data === null && !summaries.loading && summaries.error !== null;
  const hasStaleError = summaries.data !== null && summaries.error !== null;
  const refreshSpinning = summaries.loading;

  return (
    <section className="mx-auto flex w-full max-w-5xl flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--accent)]">
            {t('snapshots.eyebrow')}
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-[var(--text)]">
            {t('snapshots.title')}
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-[var(--muted)]">
            {t('snapshots.body')}
          </p>
        </div>
        <Button variant="secondary" onClick={() => void refresh()}>
          <RefreshCw
            size={15}
            className={refreshSpinning ? 'mr-2 animate-spin' : 'mr-2'}
            aria-hidden="true"
          />
          {t('snapshots.refresh')}
        </Button>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button variant="primary" disabled={importing} onClick={() => void handleImport()}>
          <Upload size={15} className="mr-2" aria-hidden="true" />
          {importing ? t('snapshots.actions.importing') : t('snapshots.actions.import')}
        </Button>
      </div>

      <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
        <div className="flex min-w-0 items-start gap-3">
          <ShieldCheck
            size={18}
            className="mt-0.5 shrink-0 text-[var(--accent)]"
            aria-hidden="true"
          />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-[var(--text)]">
              {t('snapshots.retention.title')}
            </p>
            <p className="mt-1 max-w-3xl text-xs leading-relaxed text-[var(--muted)]">
              {t('snapshots.retention.body')}
            </p>
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={() => onNavigate('settings')}>
          <Settings2 size={14} className="mr-2" aria-hidden="true" />
          {t('snapshots.retention.link')}
        </Button>
      </Card>

      {notice === null ? null : (
        <Toast
          tone={notice.tone}
          title={notice.title}
          description={notice.description}
          onDismiss={() => setNotice(null)}
        />
      )}

      {hasStaleError ? (
        <Notice
          tone="danger"
          title={t('snapshots.errorTitle')}
          body={summaries.error ?? ''}
          action={
            <Button size="sm" onClick={() => void refresh()}>
              {t('common.retry')}
            </Button>
          }
        />
      ) : null}

      {listLoading ? (
        <div className="space-y-3" aria-busy="true">
          <p className="text-xs text-[var(--muted)]">{t('snapshots.loading')}</p>
          <div className="h-20 animate-pulse rounded-2xl bg-[var(--border)]" />
          <div className="h-20 animate-pulse rounded-2xl bg-[var(--border)]" />
        </div>
      ) : listFailed ? (
        <Card className="p-6">
          <ErrorState
            title={t('snapshots.errorTitle')}
            description={summaries.error ?? t('common.unknownError')}
            action={
              <Button variant="primary" onClick={() => void refresh()}>
                {t('common.retry')}
              </Button>
            }
          />
        </Card>
      ) : list.length === 0 ? (
        <EmptyState
          icon={<History size={22} />}
          title={t('snapshots.empty.title')}
          description={t('snapshots.empty.body')}
          action={
            <Button variant="primary" onClick={() => onNavigate('profiles')}>
              {t('snapshots.empty.action')}
            </Button>
          }
        />
      ) : (
        <section aria-labelledby="snapshots-timeline-heading">
          <div className="flex items-center justify-between gap-3">
            <h2
              id="snapshots-timeline-heading"
              className="text-base font-semibold text-[var(--text)]"
            >
              {t('snapshots.timeline')}
            </h2>
            <span className="text-xs text-[var(--faint)]">
              {t('snapshots.count', { count: list.length })}
            </span>
          </div>
          <ul aria-label={t('snapshots.timelineLabel')} className="mt-3 space-y-3">
            {list.map((summary) => (
              <li key={summary.metadata.id}>
                <SnapshotRow
                  summary={summary}
                  expanded={selectedId === summary.metadata.id}
                  detailState={details[summary.metadata.id]}
                  exporting={exportingId === summary.metadata.id}
                  onToggle={() => handleToggle(summary.metadata.id)}
                  onRetry={() => void loadDetail(summary.metadata.id)}
                  onExport={() => void handleExport(summary)}
                  onDelete={() => handleDeleteRequest(summary)}
                  onRestore={() => setRestoreTarget(summary)}
                />
              </li>
            ))}
          </ul>
        </section>
      )}

      {deleteTarget === null ? null : (
        <Dialog
          open
          onOpenChange={(next: boolean) => {
            if (!next && !deletePending) {
              setDeleteTarget(null);
              setDeleteError(null);
            }
          }}
          title={t('snapshots.delete.title')}
          description={t('snapshots.delete.body')}
          footer={
            <>
              <Button
                variant="secondary"
                disabled={deletePending}
                onClick={() => {
                  setDeleteTarget(null);
                  setDeleteError(null);
                }}
              >
                {t('common.cancel')}
              </Button>
              <Button
                variant="danger"
                disabled={deletePending}
                onClick={() => void handleDeleteConfirm()}
              >
                {deletePending ? t('snapshots.delete.pending') : t('snapshots.delete.confirm')}
              </Button>
            </>
          }
        >
          <p className="rounded-xl border border-[var(--border)] bg-[var(--card-muted)] p-3 text-xs text-[var(--muted)]">
            {formatDateTime(deleteTarget.metadata.createdAt, locale)}
            {' · '}
            {t(triggerTranslationKey(deleteTarget.metadata.trigger))}
            {' · '}
            {t('snapshots.modCount', { count: deleteTarget.metadata.modCount })}
          </p>
          {deleteError === null ? null : (
            <p
              className="mt-3 rounded-xl border border-[var(--border)] bg-[var(--card-muted)] p-3 text-xs text-[var(--danger)]"
              role="alert"
            >
              {t('snapshots.delete.errorTitle')}: {deleteError}
            </p>
          )}
        </Dialog>
      )}

      {restoreTarget === null ? null : (
        <RestoreDialog
          snapshot={restoreTarget}
          onClose={() => setRestoreTarget(null)}
          onFinished={() => {
            void refresh();
          }}
        />
      )}
    </section>
  );
}
