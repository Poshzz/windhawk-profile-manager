import { AlertTriangle, RefreshCw, RotateCcw, ShieldCheck } from 'lucide-react';
import { useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import type { ApplyResult } from '@shared/domain';
import type { RecoveryInfo, RecoveryResolution } from '@shared/ipc';
import { Badge, type BadgeTone } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Dialog } from '../components/ui/Dialog';
import { formatDateTime } from '../i18n/format';
import { Notice } from './profiles/Notice';

type Phase = 'idle' | 'restoring' | 'result';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function statusTone(status: ApplyResult['status']): BadgeTone {
  switch (status) {
    case 'succeeded':
      return 'success';
    case 'succeeded-with-warning':
    case 'rolled-back':
      return 'warning';
    case 'rollback-failed':
    case 'failed':
      return 'danger';
    case 'canceled':
    case 'dry-run':
      return 'neutral';
  }
}

function isSuccessfulRestore(result: ApplyResult | null): boolean {
  return result?.status === 'succeeded' || result?.status === 'succeeded-with-warning';
}

function detailRow(label: string, value: string): ReactElement {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-[var(--border)] py-2 last:border-b-0">
      <dt className="text-xs text-[var(--muted)]">{label}</dt>
      <dd className="min-w-0 max-w-full break-all text-right text-xs font-medium text-[var(--text)]">
        {value}
      </dd>
    </div>
  );
}

export interface RecoveryDialogProps {
  readonly info: RecoveryInfo;
  readonly onResolved: (resolution: RecoveryResolution) => void;
  readonly onClose: () => void;
}

export function RecoveryDialog({ info, onResolved, onClose }: RecoveryDialogProps): ReactElement {
  const { t, i18n } = useTranslation();
  const locale = i18n.language === 'th' ? 'th' : 'en';
  const [phase, setPhase] = useState<Phase>('idle');
  const [resolution, setResolution] = useState<RecoveryResolution | null>(null);
  const [error, setError] = useState<string | null>(null);

  const finish = (): void => {
    if (resolution !== null) onResolved(resolution);
    onClose();
  };

  const handleRestore = async (): Promise<void> => {
    if (phase === 'restoring' || info.inProgress === true) return;
    setPhase('restoring');
    setError(null);
    try {
      const result = await window.api.resolveRecovery('restore');
      if (result.action === 'restored' && result.result !== null) {
        setResolution(result);
        if (isSuccessfulRestore(result.result)) {
          window.dispatchEvent(new Event('wpm:applied'));
        }
        setPhase('result');
        return;
      }
      onResolved(result);
      onClose();
    } catch (restoreError) {
      setError(errorMessage(restoreError));
      setPhase('idle');
    }
  };

  const handleFinish = async (): Promise<void> => {
    if (phase === 'restoring' || info.inProgress === true || info.canFinish !== true) return;
    setPhase('restoring');
    setError(null);
    try {
      const result = await window.api.resolveRecovery('finish');
      if (result.action === 'finished' && result.result !== null) {
        setResolution(result);
        window.dispatchEvent(new Event('wpm:applied'));
        setPhase('result');
        return;
      }
      onResolved(result);
      onClose();
    } catch (finishError) {
      setError(errorMessage(finishError));
      setPhase('idle');
    }
  };

  const handleDismiss = async (): Promise<void> => {
    if (phase !== 'idle' || info.inProgress === true) return;
    setError(null);
    try {
      const result = await window.api.resolveRecovery('dismiss');
      onResolved(result);
      onClose();
    } catch (dismissError) {
      setError(errorMessage(dismissError));
    }
  };

  const result = resolution?.result ?? null;

  const footer =
    phase === 'restoring' ? (
      <Button disabled>
        <RefreshCw size={15} className="mr-2 animate-spin" aria-hidden="true" />
        {t('recovery.cannotClose')}
      </Button>
    ) : phase === 'result' ? (
      <Button variant="primary" onClick={finish}>
        {t('recovery.result.close')}
      </Button>
    ) : info.problem === 'corrupt' ? (
      <Button
        variant="primary"
        disabled={info.inProgress === true}
        onClick={() => void handleDismiss()}
      >
        {t('recovery.actions.archive')}
      </Button>
    ) : (
      <>
        <Button
          variant="secondary"
          disabled={info.inProgress === true}
          onClick={() => void handleDismiss()}
        >
          {t('recovery.actions.dismiss')}
        </Button>
        {info.canFinish === true ? (
          <Button
            variant="primary"
            disabled={info.inProgress === true}
            onClick={() => void handleFinish()}
          >
            <ShieldCheck size={15} className="mr-2" aria-hidden="true" />
            {t('recovery.actions.finish')}
          </Button>
        ) : (
          <Button
            variant="primary"
            disabled={info.inProgress === true}
            onClick={() => void handleRestore()}
          >
            <RotateCcw size={15} className="mr-2" aria-hidden="true" />
            {t('recovery.actions.restore')}
          </Button>
        )}
      </>
    );

  return (
    <Dialog
      open
      onOpenChange={(open: boolean) => {
        if (open) return;
        if (phase === 'restoring') return;
        if (phase === 'result' && resolution !== null) {
          onResolved(resolution);
        }
        onClose();
      }}
      title={t('recovery.title')}
      description={t('recovery.description', { runId: info.runId })}
      footer={footer}
    >
      <div className="max-h-[55vh] space-y-4 overflow-auto pr-1">
        {phase === 'restoring' ? (
          <Card className="flex items-center gap-3 p-4" role="status" aria-live="polite">
            <RefreshCw
              size={18}
              className="shrink-0 animate-spin text-[var(--accent)]"
              aria-hidden="true"
            />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-[var(--text)]">{t('recovery.restoring')}</p>
              <p className="mt-1 text-xs leading-relaxed text-[var(--muted)]">
                {t('recovery.restoringNote')}
              </p>
            </div>
          </Card>
        ) : phase === 'result' && result !== null ? (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <Badge tone={statusTone(result.status)}>
                {t(`recovery.result.status.${result.status}`)}
              </Badge>
              <p className="min-w-0 text-sm text-[var(--text)]">{result.message}</p>
            </div>
            <p className="rounded-xl border border-[var(--border)] bg-[var(--card-muted)] p-3 text-xs leading-relaxed text-[var(--muted)]">
              {t('recovery.result.kept')}
            </p>
            {result.status === 'rollback-failed' ? (
              <Card
                className="border-[color-mix(in_srgb,var(--danger)_35%,transparent)] p-4"
                role="alert"
              >
                <div className="flex items-start gap-3">
                  <AlertTriangle
                    size={18}
                    className="mt-0.5 shrink-0 text-[var(--danger)]"
                    aria-hidden="true"
                  />
                  <p className="text-xs leading-relaxed text-[var(--muted)]">
                    {t('recovery.result.manualRecovery')}
                  </p>
                </div>
              </Card>
            ) : null}
          </>
        ) : (
          <>
            {info.inProgress === true ? (
              <Notice
                tone="info"
                title={t('recovery.inProgressTitle')}
                body={t('recovery.inProgressBody')}
              />
            ) : null}
            {info.problem === 'corrupt' ? (
              <Notice
                tone="danger"
                title={t('recovery.corruptTitle')}
                body={t('recovery.corruptBody')}
              />
            ) : info.canFinish === true ? (
              <Notice
                tone="info"
                title={t('recovery.finishTitle')}
                body={t('recovery.finishBody')}
              />
            ) : (
              <Notice
                tone="warning"
                title={t('recovery.warningTitle')}
                body={t('recovery.warning')}
              />
            )}
            <dl className="rounded-xl border border-[var(--border)] bg-[var(--card-muted)] px-4 py-1">
              {detailRow(t('recovery.runId'), info.runId)}
              {detailRow(t('recovery.snapshotId'), info.snapshotId)}
              {detailRow(
                t('recovery.runType'),
                t(info.kind === 'apply' ? 'recovery.kind.apply' : 'recovery.kind.restore'),
              )}
              {detailRow(t('recovery.state'), info.state)}
              {info.rainmeterAction === undefined || info.rainmeterAction === null
                ? null
                : detailRow(
                    t('recovery.rainmeter'),
                    t(`apply.rainmeterAction.${info.rainmeterAction}`),
                  )}
              {detailRow(t('recovery.startedAt'), formatDateTime(info.startedAt, locale))}
            </dl>
            <div className="space-y-2 text-xs leading-relaxed text-[var(--muted)]">
              <p className="flex items-start gap-2">
                <ShieldCheck
                  size={14}
                  className="mt-0.5 shrink-0 text-[var(--accent)]"
                  aria-hidden="true"
                />
                <span>
                  {t(info.canFinish === true ? 'recovery.finishNote' : 'recovery.restoreNote')}
                </span>
              </p>
              <p>{t('recovery.dismissNote')}</p>
            </div>
          </>
        )}

        {error === null ? null : (
          <p
            className="rounded-xl border border-[var(--border)] bg-[var(--card-muted)] p-3 text-xs text-[var(--danger)]"
            role="alert"
          >
            {t('recovery.errorTitle')}: {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
