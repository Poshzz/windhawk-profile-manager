import { AlertTriangle, Check, Play } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import type { ApplyResult, RestorePlan } from '@shared/domain';
import type { ApplyProgressState, SnapshotSummary } from '@shared/ipc';
import { Badge, type BadgeTone } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { Checkbox } from '../../components/ui/Checkbox';
import { Dialog } from '../../components/ui/Dialog';
import { ErrorState } from '../../components/ui/ErrorState';
import { Progress } from '../../components/ui/Progress';
import { formatDateTime } from '../../i18n/format';
import {
  errorMessage,
  formatSnapshotSize,
  isElevationCanceled,
  triggerTranslationKey,
} from './snapshot-utils';

type Phase = 'loading' | 'confirm' | 'running' | 'result' | 'error';

const PROGRESS_STEPS = [
  'snapshotting',
  'journaling',
  'applying',
  'settling',
  'verifying',
  'finishing',
  'rolling-back',
] as const satisfies readonly ApplyProgressState[];

type RestoreStep = (typeof PROGRESS_STEPS)[number];

const STEP_LABEL_KEYS: Record<RestoreStep, string> = {
  snapshotting: 'snapshots.restore.progress.snapshotting',
  journaling: 'snapshots.restore.progress.journaling',
  applying: 'snapshots.restore.progress.applying',
  settling: 'snapshots.restore.progress.settling',
  verifying: 'snapshots.restore.progress.verifying',
  finishing: 'snapshots.restore.progress.finishing',
  'rolling-back': 'snapshots.restore.progress.rollingBack',
};

function progressStep(state: ApplyProgressState): number {
  if (state === 'preflight') return 0;
  if (state === 'privileged-complete') return PROGRESS_STEPS.length - 1;
  const index = PROGRESS_STEPS.indexOf(state as RestoreStep);
  return index === -1 ? 0 : index + 1;
}

function progressLabelKey(state: ApplyProgressState): string {
  switch (state) {
    case 'preflight':
      return 'snapshots.restore.progress.preflight';
    case 'privileged-complete':
      return 'snapshots.restore.progress.verifying';
    case 'snapshotting':
    case 'journaling':
    case 'applying':
    case 'settling':
    case 'verifying':
    case 'finishing':
    case 'rolling-back':
      return STEP_LABEL_KEYS[state];
    default:
      return 'snapshots.restore.progress.applying';
  }
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

function RestoreResultView({ result }: { readonly result: ApplyResult }): ReactElement {
  const { t } = useTranslation();
  const restored = result.status === 'succeeded' || result.status === 'succeeded-with-warning';

  return (
    <div className="max-h-[55vh] space-y-4 overflow-auto pr-1">
      <div className="flex flex-wrap items-center gap-3">
        <Badge tone={statusTone(result.status)}>
          {t(`snapshots.restore.status.${result.status}`)}
        </Badge>
        <p className="text-sm text-[var(--text)]">{result.message}</p>
      </div>

      {restored ? (
        <p className="rounded-xl border border-[var(--border)] bg-[var(--card-muted)] p-3 text-xs leading-relaxed text-[var(--muted)]">
          {t('snapshots.restore.preRestoreKept')}
        </p>
      ) : null}

      {result.status === 'rolled-back' ? (
        <Card className="p-4" role="status">
          <p className="text-sm font-semibold text-[var(--warning)]">
            {t('snapshots.restore.rolledBackTitle')}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-[var(--muted)]">
            {t('snapshots.restore.rolledBackBody')}
          </p>
        </Card>
      ) : null}

      {result.status === 'rollback-failed' ? (
        <Card
          className="border-[color-mix(in_srgb,var(--danger)_35%,transparent)] p-4"
          role="alert"
        >
          <p className="text-sm font-semibold text-[var(--danger)]">
            {t('snapshots.restore.manualRecoveryTitle')}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-[var(--muted)]">
            {t('snapshots.restore.manualRecoveryBody')}
          </p>
        </Card>
      ) : null}

      {result.status === 'failed' ? (
        <p className="rounded-xl border border-[var(--border)] bg-[var(--card-muted)] p-3 text-xs leading-relaxed text-[var(--muted)]">
          {t('snapshots.restore.failedBody')}
        </p>
      ) : null}

      {result.error === null ? null : (
        <Card className="p-4">
          <p className="text-xs font-semibold text-[var(--danger)]">
            {result.error.code}: {result.error.name}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-[var(--muted)]">{result.error.message}</p>
        </Card>
      )}

      {result.rollback === null ? null : (
        <p className="text-xs leading-relaxed text-[var(--muted)]">
          {t('snapshots.restore.rollbackResult', {
            status: result.rollback.status,
            message: result.rollback.message ?? '',
          })}
        </p>
      )}

      {result.skippedMods.length === 0 ? null : (
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--faint)]">
            {t('snapshots.restore.skippedTitle')}
          </h3>
          <ul className="mt-2 space-y-1">
            {result.skippedMods.map((mod) => (
              <li key={`${mod.modId}:${mod.reason}`} className="text-xs text-[var(--muted)]">
                {mod.modId}: {mod.message ?? mod.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {result.warnings.length === 0 ? null : (
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--faint)]">
            {t('snapshots.restore.warningsTitle')}
          </h3>
          <ul className="mt-2 space-y-1">
            {result.warnings.map((warning) => (
              <li key={warning} className="text-xs text-[var(--warning)]">
                {warning}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export interface RestoreDialogProps {
  readonly snapshot: SnapshotSummary;
  readonly onClose: () => void;
  /** Called after a run settles so the list can pick up the pre-restore snapshot. */
  readonly onFinished: () => void;
}

export function RestoreDialog({ snapshot, onClose, onFinished }: RestoreDialogProps): ReactElement {
  const { t, i18n } = useTranslation();
  const locale = i18n.language === 'th' ? 'th' : 'en';
  const [phase, setPhase] = useState<Phase>('loading');
  const [plan, setPlan] = useState<RestorePlan | null>(null);
  const [confirmTargeting, setConfirmTargeting] = useState(false);
  const [progress, setProgress] = useState<ApplyProgressState>('preflight');
  const [result, setResult] = useState<ApplyResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const runningRef = useRef(false);
  const snapshotId = snapshot.metadata.id;

  const loadPlan = useCallback(async (): Promise<void> => {
    setPhase('loading');
    setError(null);
    setNotice(null);
    setResult(null);
    setProgress('preflight');
    setConfirmTargeting(false);
    try {
      const value = await window.api.planRestore(snapshotId);
      setPlan(value);
      setPhase('confirm');
    } catch (planError) {
      setError(errorMessage(planError));
      setPhase('error');
    }
  }, [snapshotId]);

  useEffect(() => {
    void loadPlan();
  }, [loadPlan]);

  const handleClose = (): void => {
    if (phase === 'running' || runningRef.current) return;
    onClose();
  };

  const needsTargetingConfirmation =
    plan !== null && plan.targetingValues !== undefined && plan.targetingValues.length > 0;
  const canRun = plan !== null && (!needsTargetingConfirmation || confirmTargeting);

  const handleRun = async (): Promise<void> => {
    if (plan === null || runningRef.current) return;
    runningRef.current = true;
    setPhase('running');
    setError(null);
    setNotice(null);
    setResult(null);
    setProgress('preflight');
    const unsubscribe = window.api.onApplyProgress((event) => {
      if (event.planHash === plan.planHash) setProgress(event.state);
    });

    try {
      const runResult = await window.api.runRestore({
        sourceSnapshotId: plan.sourceSnapshotId,
        expectedPlanHash: plan.planHash,
        runId: plan.runId,
        snapshotId: plan.snapshotId,
        ...(needsTargetingConfirmation ? { confirmTargeting: true } : {}),
      });
      setResult(runResult);
      setProgress(runResult.status);
      setPhase('result');
      if (runResult.status === 'succeeded' || runResult.status === 'succeeded-with-warning') {
        window.dispatchEvent(new Event('wpm:applied'));
      }
      onFinished();
    } catch (runError) {
      if (isElevationCanceled(runError)) {
        setNotice(t('snapshots.restore.uacCanceled'));
        setPhase('confirm');
      } else {
        setError(errorMessage(runError));
        setPhase('error');
        onFinished();
      }
    } finally {
      unsubscribe();
      runningRef.current = false;
    }
  };

  const footer =
    phase === 'result' || phase === 'error' ? (
      <Button variant="primary" onClick={onClose}>
        {t('common.close')}
      </Button>
    ) : phase === 'running' ? (
      <Button disabled>{t('snapshots.restore.cannotClose')}</Button>
    ) : (
      <>
        <Button variant="secondary" onClick={handleClose}>
          {t('common.cancel')}
        </Button>
        <Button
          variant="primary"
          disabled={phase !== 'confirm' || !canRun}
          onClick={() => void handleRun()}
        >
          <Play size={15} className="mr-2" aria-hidden="true" />
          {t('snapshots.restore.restoreNow')}
        </Button>
      </>
    );

  const capturedAt = formatDateTime(snapshot.metadata.createdAt, locale);

  return (
    <Dialog
      open
      onOpenChange={(open: boolean) => {
        if (!open) handleClose();
      }}
      title={t('snapshots.restore.title')}
      description={t('snapshots.restore.description')}
      footer={footer}
    >
      {notice === null ? null : (
        <p
          className="mb-4 rounded-xl border border-[var(--border)] bg-[var(--card-muted)] p-3 text-xs text-[var(--muted)]"
          role="status"
        >
          {notice}
        </p>
      )}

      {phase === 'loading' ? (
        <div className="space-y-3" aria-busy="true">
          <p className="text-xs text-[var(--muted)]">{t('snapshots.restore.loadingPlan')}</p>
          <div className="h-5 w-2/3 animate-pulse rounded bg-[var(--border)]" />
          <div className="h-20 animate-pulse rounded-xl bg-[var(--border)]" />
          <div className="h-20 animate-pulse rounded-xl bg-[var(--border)]" />
        </div>
      ) : phase === 'error' ? (
        <ErrorState
          title={t('snapshots.restore.errorTitle')}
          description={error ?? t('common.unknownError')}
          action={
            <Button variant="primary" onClick={() => void loadPlan()}>
              {t('common.retry')}
            </Button>
          }
        />
      ) : phase === 'running' ? (
        <div className="space-y-5">
          <div>
            <h3 className="text-sm font-semibold text-[var(--text)]">
              {t('snapshots.restore.progressHeading')}
            </h3>
            <p className="mt-1 text-xs leading-relaxed text-[var(--muted)]">
              {t('snapshots.restore.progressBody')}
            </p>
          </div>
          <Progress
            value={progressStep(progress)}
            max={PROGRESS_STEPS.length}
            label={t('snapshots.restore.progressLabel')}
            showValue
          />
          <ol aria-label={t('snapshots.restore.stepsLabel')} className="flex flex-wrap gap-2">
            {PROGRESS_STEPS.map((step, index) => {
              const current = progressStep(progress) === index + 1;
              const done = progressStep(progress) > index + 1;
              return (
                <li
                  key={step}
                  aria-current={current ? 'step' : undefined}
                  className={
                    current
                      ? 'flex items-center gap-1 rounded-full border border-[var(--accent)] px-2 py-1 text-[11px] font-medium text-[var(--accent)]'
                      : done
                        ? 'flex items-center gap-1 rounded-full border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--muted)]'
                        : 'flex items-center gap-1 rounded-full border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--faint)]'
                  }
                >
                  {done ? <Check size={11} aria-hidden="true" /> : null}
                  {t(STEP_LABEL_KEYS[step])}
                </li>
              );
            })}
          </ol>
          <p className="text-xs text-[var(--muted)]" aria-live="polite">
            {t(progressLabelKey(progress))}
          </p>
        </div>
      ) : phase === 'result' && result !== null ? (
        <RestoreResultView result={result} />
      ) : (
        <div className="max-h-[55vh] space-y-4 overflow-auto pr-1">
          <div className="rounded-xl border border-[var(--border)] bg-[var(--card-muted)] p-3">
            <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
              <div>
                <dt className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--faint)]">
                  {t('snapshots.detail.captured')}
                </dt>
                <dd className="mt-1 text-xs text-[var(--text)]">{capturedAt}</dd>
              </div>
              <div>
                <dt className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--faint)]">
                  {t('snapshots.detail.trigger')}
                </dt>
                <dd className="mt-1 text-xs text-[var(--text)]">
                  {t(triggerTranslationKey(snapshot.metadata.trigger))}
                </dd>
              </div>
              <div>
                <dt className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--faint)]">
                  {t('snapshots.detail.profile')}
                </dt>
                <dd className="mt-1 text-xs text-[var(--text)]">
                  {snapshot.metadata.profileId === null
                    ? t('snapshots.noProfile')
                    : t('snapshots.profile', { id: snapshot.metadata.profileId })}
                </dd>
              </div>
              <div>
                <dt className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--faint)]">
                  {t('snapshots.detail.mods')}
                </dt>
                <dd className="mt-1 text-xs text-[var(--text)]">
                  {t('snapshots.modCount', { count: snapshot.metadata.modCount })}
                </dd>
              </div>
              <div>
                <dt className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--faint)]">
                  {t('snapshots.detail.size')}
                </dt>
                <dd className="mt-1 text-xs text-[var(--text)]">
                  {formatSnapshotSize(snapshot.sizeBytes, locale, t)}
                </dd>
              </div>
              <div className="min-w-0">
                <dt className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--faint)]">
                  {t('snapshots.detail.id')}
                </dt>
                <dd className="mt-1 break-all font-mono text-[11px] text-[var(--muted)]">
                  {snapshot.metadata.id}
                </dd>
              </div>
            </dl>
          </div>

          <div className="flex items-start gap-2">
            <AlertTriangle
              size={17}
              className="mt-0.5 shrink-0 text-[var(--warning)]"
              aria-hidden="true"
            />
            <p className="text-sm leading-relaxed text-[var(--text)]">
              {t('snapshots.restore.fullState')}
            </p>
          </div>

          <ul className="space-y-2 text-xs leading-relaxed text-[var(--muted)]">
            <li>{t('snapshots.restore.noDlls')}</li>
            <li>{t('snapshots.restore.preRestore')}</li>
            <li>{t('snapshots.restore.service')}</li>
            <li>{t('snapshots.restore.newerMods')}</li>
            <li>{t('snapshots.restore.missingKeys')}</li>
          </ul>

          {plan === null ? null : (
            <div className="rounded-xl border border-[var(--border)] bg-[var(--card-muted)] p-3">
              <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--faint)]">
                {t('snapshots.restore.planSummaryTitle')}
              </h3>
              <dl className="mt-2 grid gap-x-4 gap-y-2 text-xs sm:grid-cols-2">
                <div>
                  <dt className="text-[var(--faint)]">{t('snapshots.restore.writes')}</dt>
                  <dd className="text-[var(--text)]">
                    {t('snapshots.restore.writesValue', {
                      set: plan.summary.setValues,
                      deleted: plan.summary.deleteValues,
                      mods: plan.summary.touchedMods,
                    })}
                  </dd>
                </div>
                <div>
                  <dt className="text-[var(--faint)]">{t('apply.rainmeter')}</dt>
                  <dd className="text-[var(--text)]">
                    {t(`apply.rainmeterAction.${plan.actions.rainmeter}`)}
                  </dd>
                </div>
              </dl>
            </div>
          )}

          {plan !== null && needsTargetingConfirmation ? (
            <div className="rounded-xl border border-[color-mix(in_srgb,var(--warning)_35%,transparent)] p-3">
              <p className="text-xs font-semibold text-[var(--warning)]">
                {t('snapshots.restore.targetingTitle')}
              </p>
              <p className="mt-1 text-xs leading-relaxed text-[var(--muted)]">
                {t('snapshots.restore.targetingBody')}
              </p>
              <ul className="mt-2 space-y-1 text-xs text-[var(--muted)]">
                {plan.targetingValues.map((value) => (
                  <li key={`${value.modId}:${value.name}`} className="break-all font-mono">
                    {value.modId} · {value.name} ={' '}
                    {value.value.length > 200 ? `${value.value.slice(0, 197)}...` : value.value}
                  </li>
                ))}
              </ul>
              <div className="mt-3">
                <Checkbox
                  checked={confirmTargeting}
                  onCheckedChange={(checked) => setConfirmTargeting(checked === true)}
                  label={t('snapshots.restore.targetingConfirm')}
                  description={t('snapshots.restore.targetingConfirmBody')}
                />
              </div>
            </div>
          ) : null}

          {plan === null || plan.warnings.length === 0 ? null : (
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--faint)]">
                {t('snapshots.restore.warningsTitle')}
              </h3>
              <ul className="mt-2 space-y-1">
                {plan.warnings.map((warning) => (
                  <li
                    key={`${warning.code}:${warning.modId ?? ''}:${warning.message}`}
                    className="flex gap-2 text-xs text-[var(--muted)]"
                  >
                    <AlertTriangle
                      size={13}
                      className="mt-0.5 shrink-0 text-[var(--warning)]"
                      aria-hidden="true"
                    />
                    {warning.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}
