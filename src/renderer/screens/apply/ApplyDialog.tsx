import { AlertTriangle, Clipboard, ExternalLink, Play } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import type { ApplyPlan, ApplyResult, Environment, Profile, ProfileSetting } from '@shared/domain';
import type { ApplyProgressState } from '@shared/ipc';
import { Badge, type BadgeTone } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { Checkbox } from '../../components/ui/Checkbox';
import { Dialog } from '../../components/ui/Dialog';
import { ErrorState } from '../../components/ui/ErrorState';
import { Progress } from '../../components/ui/Progress';
import type { NavId } from '../../state/ui-store';

type ExplorerPreference = 'ask' | 'always' | 'never';
type Phase = 'plan' | 'running' | 'result' | 'error';

const PROGRESS_STEPS: readonly ApplyProgressState[] = [
  'preflight',
  'snapshotting',
  'journaling',
  'applying',
  'settling',
  'verifying',
  'finishing',
];

function progressStep(state: ApplyProgressState): number {
  if (state === 'privileged-complete' || state === 'finishing') return PROGRESS_STEPS.length;
  if (state === 'rolling-back') return PROGRESS_STEPS.indexOf('verifying') + 1;
  if (
    state === 'succeeded' ||
    state === 'succeeded-with-warning' ||
    state === 'rolled-back' ||
    state === 'rollback-failed' ||
    state === 'failed' ||
    state === 'canceled' ||
    state === 'dry-run'
  ) {
    return PROGRESS_STEPS.length;
  }
  const index = PROGRESS_STEPS.indexOf(state);
  return index === -1 ? 1 : index + 1;
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

function formatSetting(setting: ProfileSetting): string {
  return setting.type === 'dword'
    ? `dword:${setting.value}`
    : `string:${JSON.stringify(setting.value)}`;
}

function isCanceledError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /UAC prompt was canceled|ELEVATION_CANCELED|ElevationCanceled/i.test(message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface ApplyDialogProps {
  readonly profileId: string | null;
  readonly onClose: () => void;
  readonly onNavigate: (screen: NavId) => void;
}

export function ApplyDialog({ profileId, onClose, onNavigate }: ApplyDialogProps): ReactElement {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>('plan');
  const [plan, setPlan] = useState<ApplyPlan | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [environment, setEnvironment] = useState<Environment | null>(null);
  const [explorerRestart, setExplorerRestart] = useState<ExplorerPreference>('ask');
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);
  const [progress, setProgress] = useState<ApplyProgressState>('preflight');
  const [result, setResult] = useState<ApplyResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loadingPlan, setLoadingPlan] = useState(false);
  const applyingRef = useRef(false);

  const loadPlan = useCallback(
    async (
      id: string,
      confirmed: boolean,
      explorer: ExplorerPreference | undefined,
    ): Promise<void> => {
      setLoadingPlan(true);
      setError(null);
      setNotice(null);
      setResult(null);
      try {
        const [profiles, environmentValue, planValue] = await Promise.all([
          window.api.listProfiles(),
          window.api.getEnvironment(),
          window.api.planApply(id, {
            ...(explorer === undefined ? {} : { explorerRestart: explorer }),
            confirmDeleteAllSettings: confirmed,
          }),
        ]);
        setProfile(profiles.find((entry) => entry.id === id) ?? null);
        setEnvironment(environmentValue);
        setPlan(planValue);
        setConfirmDeleteAll(planValue.deleteAllSettingsConfirmed);
        setExplorerRestart(planValue.actions.restartExplorer);
        setPhase('plan');
        setProgress('preflight');
      } catch (loadError) {
        setError(errorMessage(loadError));
        setPhase('error');
      } finally {
        setLoadingPlan(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (profileId === null) {
      setPhase('plan');
      setPlan(null);
      setProfile(null);
      setEnvironment(null);
      setResult(null);
      setError(null);
      setNotice(null);
      setConfirmDeleteAll(false);
      setExplorerRestart('ask');
      return;
    }
    setPhase('plan');
    void loadPlan(profileId, false, undefined);
  }, [profileId, loadPlan]);

  const handleClose = (): void => {
    if (phase === 'running') return;
    onClose();
  };

  const handleExplorerChange = (value: ExplorerPreference): void => {
    setExplorerRestart(value);
    if (profileId !== null) void loadPlan(profileId, confirmDeleteAll, value);
  };

  const handleDeleteAllChange = (checked: boolean | 'indeterminate'): void => {
    const value = checked === true;
    setConfirmDeleteAll(value);
    if (profileId !== null) void loadPlan(profileId, value, explorerRestart);
  };

  const handleApply = async (): Promise<void> => {
    if (profileId === null || plan === null || phase === 'running' || applyingRef.current) return;
    if (plan.modChanges.some((change) => change.deleteAllSettings) && !confirmDeleteAll) return;
    applyingRef.current = true;
    setPhase('running');
    setError(null);
    setNotice(null);
    setProgress('preflight');
    const unsubscribe = window.api.onApplyProgress((event) => {
      if (event.planHash === plan.planHash) setProgress(event.state);
    });
    try {
      const applyResult = await window.api.runApply(profileId, {
        expectedRevision: plan.profileRevision,
        expectedPlanHash: plan.planHash,
        runId: plan.runId,
        snapshotId: plan.snapshotId,
        explorerRestart,
        confirmDeleteAllSettings: confirmDeleteAll,
      });
      setResult(applyResult);
      setProgress(applyResult.status);
      setPhase('result');
      if (applyResult.status === 'succeeded' || applyResult.status === 'succeeded-with-warning') {
        window.dispatchEvent(new Event('wpm:applied'));
      }
    } catch (applyError) {
      if (isCanceledError(applyError)) {
        setNotice(t('apply.uacCanceled'));
        setPhase('plan');
      } else {
        setError(errorMessage(applyError));
        setPhase('error');
      }
    } finally {
      unsubscribe();
      applyingRef.current = false;
    }
  };

  const diagnostics = (): string =>
    JSON.stringify(
      {
        plan:
          plan === null
            ? null
            : {
                runId: plan.runId,
                profileId: plan.profileId,
                profileRevision: plan.profileRevision,
                planHash: plan.planHash,
                noOp: plan.noOp,
                modCount: plan.modChanges.length,
                missingCount: plan.missingMods.length,
                unlistedCount: plan.unlistedMods.length,
                warningCodes: plan.warnings.map((warning) => warning.code),
                actions: plan.actions,
              },
        result:
          result === null
            ? null
            : {
                runId: result.runId,
                status: result.status,
                completedAt: result.completedAt,
                warningCount: result.warnings.length,
                errorCode: result.error?.code ?? null,
              },
        error: error === null ? null : { message: 'See the visible error for details.' },
        progress,
        explorerRestart,
      },
      null,
      2,
    );

  const copyDiagnostics = (): void => {
    void navigator.clipboard?.writeText(diagnostics()).catch(() => undefined);
  };

  const versionFor = (modId: string): string | null =>
    environment?.mods.find((mod) => mod.modId.toLowerCase() === modId.toLowerCase())?.version ??
    null;

  const transitionKey = (change: ApplyPlan['modChanges'][number]): string => {
    const current = environment?.mods.find(
      (mod) => mod.modId.toLowerCase() === change.modId.toLowerCase(),
    );
    if (current === undefined) return 'apply.transition.missing';
    const desiredEnabled = change.state === 'enabled';
    if (current.enabled === desiredEnabled) return 'apply.transition.unchanged';
    return current.enabled ? 'apply.transition.onToOff' : 'apply.transition.offToOn';
  };

  const hasDeleteAll = plan?.modChanges.some((change) => change.deleteAllSettings) ?? false;
  const serviceStopped = environment?.service.state === 'stopped';
  const serviceMissing = environment?.service.state === 'missing';
  const canApply =
    phase === 'plan' &&
    !loadingPlan &&
    plan !== null &&
    !plan.noOp &&
    plan.blockers.length === 0 &&
    (!hasDeleteAll || confirmDeleteAll) &&
    environment?.compatibility.canApply === true;

  const footer =
    phase === 'result' ? (
      <>
        {result !== null &&
        (result.status === 'succeeded' ||
          result.status === 'succeeded-with-warning' ||
          result.status === 'rolled-back') ? (
          <Button
            variant="secondary"
            onClick={() => {
              onClose();
              onNavigate('snapshots');
            }}
          >
            {t('apply.viewSnapshot')}
          </Button>
        ) : null}
        <Button variant="primary" onClick={onClose}>
          {t('common.close')}
        </Button>
      </>
    ) : phase === 'running' ? (
      <Button disabled>{t('apply.cannotCancel')}</Button>
    ) : (
      <>
        <Button variant="secondary" onClick={handleClose} disabled={loadingPlan}>
          {t('common.cancel')}
        </Button>
        <Button variant="primary" disabled={!canApply} onClick={() => void handleApply()}>
          <Play size={15} className="mr-2" aria-hidden="true" />
          {t('apply.applyNow')}
        </Button>
      </>
    );

  return (
    <Dialog
      open={profileId !== null}
      onOpenChange={(open: boolean) => {
        if (!open) handleClose();
      }}
      title={
        profile === null ? t('apply.title') : t('apply.titleWithProfile', { profile: profile.name })
      }
      description={t('apply.description')}
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

      {loadingPlan ? (
        <div className="space-y-3" aria-busy="true">
          <div className="h-5 w-2/3 animate-pulse rounded bg-[var(--border)]" />
          <div className="h-16 animate-pulse rounded-xl bg-[var(--border)]" />
          <div className="h-16 animate-pulse rounded-xl bg-[var(--border)]" />
        </div>
      ) : phase === 'error' ? (
        <ErrorState
          title={t('apply.errorTitle')}
          description={error ?? t('common.unknownError')}
          action={
            <Button
              variant="primary"
              onClick={() => {
                if (profileId !== null) void loadPlan(profileId, confirmDeleteAll, explorerRestart);
              }}
            >
              {t('common.retry')}
            </Button>
          }
        />
      ) : phase === 'running' ? (
        <div className="space-y-5">
          <div>
            <h3 className="text-sm font-semibold text-[var(--text)]">
              {t('apply.progressHeading')}
            </h3>
            <p className="mt-1 text-xs leading-relaxed text-[var(--muted)]">
              {t('apply.progressBody')}
            </p>
          </div>
          <Progress
            value={progressStep(progress)}
            max={PROGRESS_STEPS.length}
            label={t('apply.progressLabel')}
            showValue
          />
          <p className="text-xs text-[var(--muted)]" aria-live="polite">
            {t(`apply.progress.${progress}`)}
          </p>
        </div>
      ) : phase === 'result' && result !== null ? (
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <Badge tone={statusTone(result.status)}>{t(`apply.status.${result.status}`)}</Badge>
            <p className="text-sm text-[var(--text)]">{result.message}</p>
          </div>
          {result.error === null ? null : (
            <Card className="p-4">
              <p className="text-xs font-semibold text-[var(--danger)]">
                {result.error.code}: {result.error.name}
              </p>
              <p className="mt-1 text-xs leading-relaxed text-[var(--muted)]">
                {result.error.message}
              </p>
            </Card>
          )}
          {result.rollback === null ? null : (
            <p className="text-xs leading-relaxed text-[var(--muted)]">
              {t('apply.rollbackResult', {
                status: result.rollback.status,
                message: result.rollback.message ?? '',
              })}
            </p>
          )}
          {result.skippedMods.length === 0 ? null : (
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--faint)]">
                {t('apply.skippedTitle')}
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
                {t('apply.warningsTitle')}
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
          <Button variant="ghost" size="sm" onClick={copyDiagnostics}>
            <Clipboard size={14} className="mr-2" aria-hidden="true" />
            {t('apply.copyDiagnostics')}
          </Button>
        </div>
      ) : plan === null ? (
        <ErrorState
          title={t('apply.errorTitle')}
          description={t('apply.noPlan')}
          action={
            <Button onClick={() => void loadPlan(profileId ?? '', false, explorerRestart)}>
              {t('common.retry')}
            </Button>
          }
        />
      ) : (
        <div className="max-h-[55vh] space-y-4 overflow-auto pr-1">
          <div className="rounded-xl border border-[var(--border)] bg-[var(--card-muted)] p-3 text-xs leading-relaxed text-[var(--muted)]">
            <p>{t('apply.snapshotNotice')}</p>
            <p className="mt-1">{t('apply.reloadNotice')}</p>
            {serviceStopped ? <p className="mt-1">{t('apply.serviceStartNotice')}</p> : null}
            {serviceMissing ? <p className="mt-1">{t('apply.serviceMissingNotice')}</p> : null}
          </div>

          {environment === null ? null : (
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--faint)]">
                {t('apply.preflight.title')}
              </h3>
              <dl className="mt-2 grid gap-x-4 gap-y-2 text-xs sm:grid-cols-2">
                <div>
                  <dt className="text-[var(--faint)]">{t('apply.preflight.windows')}</dt>
                  <dd className="text-[var(--text)]">
                    {environment.windows.version} ({environment.windows.build})
                  </dd>
                </div>
                <div>
                  <dt className="text-[var(--faint)]">{t('apply.preflight.windhawk')}</dt>
                  <dd className="text-[var(--text)]">
                    {environment.windhawk.version ?? t('common.notAvailable')}
                  </dd>
                </div>
                <div>
                  <dt className="text-[var(--faint)]">{t('apply.preflight.storage')}</dt>
                  <dd className="text-[var(--text)]">
                    {t(`home.storage.${environment.windhawk.storageMode}`)}
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-[var(--faint)]">{t('apply.preflight.registryRoot')}</dt>
                  <dd className="break-all text-[var(--text)]">
                    {environment.windhawk.registryRoot ?? t('common.notAvailable')}
                  </dd>
                </div>
                <div>
                  <dt className="text-[var(--faint)]">{t('apply.preflight.service')}</dt>
                  <dd className="text-[var(--text)]">
                    {t(`home.service.${environment.service.state}`)}
                  </dd>
                </div>
                <div>
                  <dt className="text-[var(--faint)]">{t('apply.preflight.rainmeter')}</dt>
                  <dd className="text-[var(--text)]">
                    {environment.rainmeter.running
                      ? t('apply.preflight.rainmeterRunning')
                      : environment.rainmeter.installed
                        ? t('apply.preflight.rainmeterStopped')
                        : t('apply.preflight.rainmeterMissing')}
                  </dd>
                </div>
              </dl>
            </section>
          )}

          {plan.blockers.length === 0 ? null : (
            <div
              className="rounded-xl border border-[color-mix(in_srgb,var(--danger)_35%,transparent)] p-3"
              role="alert"
            >
              <p className="text-xs font-semibold text-[var(--danger)]">
                {t('apply.blockedTitle')}
              </p>
              <ul className="mt-2 space-y-1">
                {plan.blockers.map((blocker) => (
                  <li
                    key={`${blocker.code}:${blocker.modIds.join(',')}`}
                    className="text-xs text-[var(--muted)]"
                  >
                    {blocker.code === 'required-missing'
                      ? t('apply.blocker.requiredMissing', {
                          mods: blocker.modIds.join(', '),
                        })
                      : blocker.message}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {plan.noOp ? (
            <p className="text-sm text-[var(--muted)]">{t('apply.noOp')}</p>
          ) : (
            <>
              <section>
                <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--faint)]">
                  {t('apply.managedMods', { count: plan.modChanges.length })}
                </h3>
                {plan.modChanges.length === 0 ? (
                  <p className="mt-2 text-xs text-[var(--muted)]">{t('apply.noManagedChanges')}</p>
                ) : (
                  <ul className="mt-2 space-y-2">
                    {plan.modChanges.map((change) => {
                      const version = versionFor(change.modId);
                      const settingEntries = Object.entries(change.settings);
                      return (
                        <li
                          key={change.modId}
                          className="rounded-xl border border-[var(--border)] p-3"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div>
                              <p className="text-sm font-semibold text-[var(--text)]">
                                {change.modId}
                              </p>
                              <p className="mt-1 text-xs text-[var(--muted)]">
                                {t(transitionKey(change))} Â· {t(`apply.mode.${change.mode}`)}
                                {version === null ? null : ` Â· v${version}`}
                              </p>
                            </div>
                            <Badge tone={change.state === 'enabled' ? 'success' : 'neutral'}>
                              {t(`apply.state.${change.state}`)}
                            </Badge>
                          </div>
                          {settingEntries.length === 0 ? null : (
                            <details className="mt-2">
                              <summary className="cursor-pointer text-xs font-medium text-[var(--accent)]">
                                {t('apply.settingsCount', { count: settingEntries.length })}
                              </summary>
                              <ul className="mt-2 space-y-1">
                                {settingEntries.map(([name, setting]) => (
                                  <li key={name} className="text-xs text-[var(--muted)]">
                                    <span className="font-medium text-[var(--text)]">{name}</span> ={' '}
                                    {formatSetting(setting)}
                                  </li>
                                ))}
                              </ul>
                            </details>
                          )}
                          {change.deleteValues.length === 0 ? null : (
                            <div className="mt-2">
                              <p className="text-xs font-medium text-[var(--warning)]">
                                {t('apply.deleteValues', { count: change.deleteValues.length })}
                              </p>
                              <p className="mt-1 text-xs text-[var(--muted)]">
                                {change.deleteValues.join(', ')}
                              </p>
                            </div>
                          )}
                          {change.deleteAllSettings ? (
                            <p className="mt-2 text-xs font-semibold text-[var(--danger)]">
                              {t('apply.deleteAll')}
                            </p>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>

              {hasDeleteAll ? (
                <div className="rounded-xl border border-[color-mix(in_srgb,var(--danger)_35%,transparent)] p-3">
                  <Checkbox
                    checked={confirmDeleteAll}
                    onCheckedChange={handleDeleteAllChange}
                    label={t('apply.confirmDeleteAll')}
                    description={t('apply.confirmDeleteAllBody')}
                  />
                </div>
              ) : null}

              <section>
                <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--faint)]">
                  {t('apply.missingMods', { count: plan.missingMods.length })}
                </h3>
                {plan.missingMods.length === 0 ? (
                  <p className="mt-2 text-xs text-[var(--muted)]">{t('apply.noMissingMods')}</p>
                ) : (
                  <ul className="mt-2 space-y-2">
                    {plan.missingMods.map((mod) => (
                      <li
                        key={mod.modId}
                        className="flex items-center justify-between gap-2 text-xs"
                      >
                        <span className="text-[var(--muted)]">{mod.message ?? mod.modId}</span>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            void window.api.openExternal(`https://windhawk.net/mods/${mod.modId}`)
                          }
                        >
                          <ExternalLink size={13} className="mr-1" aria-hidden="true" />
                          {t('apply.openModPage')}
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section>
                <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--faint)]">
                  {t('apply.unlistedMods', { count: plan.unlistedMods.length })}
                </h3>
                <p className="mt-2 text-xs text-[var(--muted)]">
                  {plan.unlistedPolicy === 'disable'
                    ? t('apply.unlistedDisable')
                    : t('apply.unlistedLeave')}
                </p>
                {plan.unlistedMods.length === 0 ? null : (
                  <ul className="mt-2 space-y-1">
                    {plan.unlistedMods.map((mod) => (
                      <li key={mod.modId} className="text-xs text-[var(--muted)]">
                        {mod.modId} Â· {t(`apply.state.${mod.state}`)}
                        {mod.willDisable ? ` Â· ${t('apply.willDisable')}` : ''}
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="grid gap-3 sm:grid-cols-2">
                <div>
                  <p className="text-xs font-semibold text-[var(--text)]">{t('apply.rainmeter')}</p>
                  <p className="mt-1 text-xs text-[var(--muted)]">
                    {t(`apply.rainmeterAction.${plan.actions.rainmeter}`)}
                  </p>
                </div>
                <label className="text-xs font-semibold text-[var(--text)]">
                  {t('apply.explorer')}
                  <select
                    className="mt-2 w-full rounded-lg border border-[var(--border)] bg-[var(--card)] px-2 py-2 text-xs font-normal text-[var(--text)]"
                    value={explorerRestart}
                    onChange={(event) =>
                      handleExplorerChange(event.target.value as ExplorerPreference)
                    }
                  >
                    <option value="ask">{t('apply.explorerAsk')}</option>
                    <option value="always">{t('apply.explorerAlways')}</option>
                    <option value="never">{t('apply.explorerNever')}</option>
                  </select>
                  <span className="mt-1 block text-[11px] font-normal text-[var(--faint)]">
                    {t('apply.explorerNote')}
                  </span>
                </label>
              </section>

              {plan.warnings.length === 0 ? null : (
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--faint)]">
                    {t('apply.warningsTitle')}
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

              {plan.noOp ? null : (
                <p className="text-xs text-[var(--faint)]">{t('apply.oneRunOnly')}</p>
              )}
            </>
          )}
        </div>
      )}
    </Dialog>
  );
}
