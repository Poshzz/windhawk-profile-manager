import {
  AlertTriangle,
  Camera,
  Lock,
  Palette,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  WifiOff,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { AppState, Environment } from '@shared/domain';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { ErrorState } from '../components/ui/ErrorState';
import { Notice } from './profiles/Notice';

export type FirstRunDestination = 'home' | 'profiles' | 'packs';

interface Loadable<T> {
  readonly data: T | null;
  readonly loading: boolean;
  readonly error: string | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function settledValue<T>(result: PromiseSettledResult<T>, previous: T | null): Loadable<T> {
  if (result.status === 'fulfilled') {
    return { data: result.value, loading: false, error: null };
  }
  return { data: previous, loading: false, error: errorMessage(result.reason) };
}

function modeKey(mode: Environment['compatibility']['mode']): string {
  return `firstRun.environment.mode.${mode}`;
}

function modeTone(mode: Environment['compatibility']['mode']): 'success' | 'warning' | 'danger' {
  if (mode === 'writable') return 'success';
  if (mode === 'read-only') return 'warning';
  return 'danger';
}

function IntroPoint({
  icon,
  title,
  body,
}: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly body: string;
}): ReactElement {
  return (
    <li className="flex items-start gap-3">
      <span className="mt-0.5 shrink-0 text-[var(--accent)]" aria-hidden="true">
        {icon}
      </span>
      <div className="min-w-0">
        <p className="text-sm font-semibold text-[var(--text)]">{title}</p>
        <p className="mt-1 text-xs leading-relaxed text-[var(--muted)]">{body}</p>
      </div>
    </li>
  );
}

export interface FirstRunProps {
  readonly onComplete: (state: AppState, destination: FirstRunDestination) => void;
}

export function FirstRun({ onComplete }: FirstRunProps): ReactElement {
  const { t } = useTranslation();
  const [environment, setEnvironment] = useState<Loadable<Environment>>({
    data: null,
    loading: true,
    error: null,
  });
  const [appState, setAppState] = useState<Loadable<AppState>>({
    data: null,
    loading: true,
    error: null,
  });
  const [busy, setBusy] = useState<FirstRunDestination | null>(null);
  const [completeError, setCompleteError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    setEnvironment((current) => ({ ...current, loading: true, error: null }));
    setAppState((current) => ({ ...current, loading: true, error: null }));

    const results = await Promise.allSettled([window.api.getEnvironment(), window.api.getState()]);
    if (!mounted.current) return;

    const [environmentResult, stateResult] = results;
    setEnvironment((current) => settledValue(environmentResult, current.data));
    setAppState((current) => settledValue(stateResult, current.data));
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleComplete = async (destination: FirstRunDestination): Promise<void> => {
    if (busy !== null) return;
    setBusy(destination);
    setCompleteError(null);
    try {
      const state = await window.api.completeFirstRun();
      if (!mounted.current) return;
      onComplete(state, destination);
    } catch (error) {
      if (mounted.current) setCompleteError(errorMessage(error));
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const env = environment.data;
  const loading =
    (environment.loading && env === null) || (appState.loading && appState.data === null);
  const bothFailed =
    !environment.loading && env === null && !appState.loading && appState.data === null;

  const footer = (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-[11px] text-[var(--faint)]">{t('firstRun.hint')}</p>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          disabled={busy !== null}
          onClick={() => void handleComplete('profiles')}
        >
          <Camera size={15} className="mr-2" aria-hidden="true" />
          {busy === 'profiles' ? t('firstRun.actions.busy') : t('firstRun.actions.capture')}
        </Button>
        <Button
          variant="secondary"
          disabled={busy !== null}
          onClick={() => void handleComplete('packs')}
        >
          <Palette size={15} className="mr-2" aria-hidden="true" />
          {busy === 'packs' ? t('firstRun.actions.busy') : t('firstRun.actions.pack')}
        </Button>
        <Button
          variant="primary"
          disabled={busy !== null}
          onClick={() => void handleComplete('home')}
        >
          {busy === 'home' ? t('firstRun.actions.busy') : t('firstRun.actions.continue')}
        </Button>
      </div>
    </div>
  );

  return (
    <section
      className="mx-auto flex w-full max-w-4xl flex-col gap-5"
      aria-labelledby="first-run-heading"
    >
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--accent)]">
          {t('firstRun.eyebrow')}
        </p>
        <h1
          id="first-run-heading"
          className="mt-2 text-3xl font-semibold tracking-tight text-[var(--text)]"
        >
          {t('firstRun.title')}
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-[var(--muted)]">
          {t('firstRun.body')}
        </p>
      </div>

      {loading ? (
        <div className="space-y-3" aria-busy="true">
          <p className="text-xs text-[var(--muted)]">{t('firstRun.loading')}</p>
          <div className="h-36 animate-pulse rounded-2xl bg-[var(--border)]" />
          <div className="h-48 animate-pulse rounded-2xl bg-[var(--border)]" />
        </div>
      ) : bothFailed ? (
        <Card className="p-6">
          <ErrorState
            title={t('firstRun.loadErrorTitle')}
            description={environment.error ?? appState.error ?? t('common.unknownError')}
            action={
              <Button variant="primary" onClick={() => void refresh()}>
                {t('common.retry')}
              </Button>
            }
          />
        </Card>
      ) : (
        <>
          {environment.error === null && appState.error === null ? null : (
            <Notice
              tone="warning"
              title={t('firstRun.partialError')}
              body={environment.error ?? appState.error ?? t('common.unknownError')}
              action={
                <Button size="sm" onClick={() => void refresh()}>
                  {t('common.retry')}
                </Button>
              }
            />
          )}

          {env === null || env.compatibility.mode === 'writable' ? null : (
            <Notice
              tone={env.compatibility.mode === 'unsupported' ? 'danger' : 'warning'}
              title={
                env.compatibility.mode === 'unsupported'
                  ? t('firstRun.readOnly.unsupportedTitle')
                  : t('firstRun.readOnly.title')
              }
              body={
                env.compatibility.issues.length === 0
                  ? t('firstRun.readOnly.issuesFallback')
                  : env.compatibility.issues.map((issue) => issue.message).join(' ')
              }
              action={
                <p className="text-xs font-medium text-[var(--text)]">
                  {t('firstRun.readOnly.applyDisabled')}
                </p>
              }
            />
          )}

          <Card className="p-6">
            <h2 className="text-base font-semibold text-[var(--text)]">
              {t('firstRun.introTitle')}
            </h2>
            <ul className="mt-4 space-y-4" aria-label={t('firstRun.introLabel')}>
              <IntroPoint
                icon={<SlidersHorizontal size={17} />}
                title={t('firstRun.points.changes.title')}
                body={t('firstRun.points.changes.body')}
              />
              <IntroPoint
                icon={<ShieldCheck size={17} />}
                title={t('firstRun.points.snapshot.title')}
                body={t('firstRun.points.snapshot.body')}
              />
              <IntroPoint
                icon={<Lock size={17} />}
                title={t('firstRun.points.uac.title')}
                body={t('firstRun.points.uac.body')}
              />
              <IntroPoint
                icon={<Server size={17} />}
                title={t('firstRun.points.service.title')}
                body={t('firstRun.points.service.body')}
              />
              <IntroPoint
                icon={<WifiOff size={17} />}
                title={t('firstRun.points.network.title')}
                body={t('firstRun.points.network.body')}
              />
            </ul>
          </Card>

          {env === null ? null : (
            <Card className="p-5" aria-labelledby="first-run-environment-heading">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2
                  id="first-run-environment-heading"
                  className="text-base font-semibold text-[var(--text)]"
                >
                  {t('firstRun.environment.title')}
                </h2>
                <Badge tone={modeTone(env.compatibility.mode)}>
                  {t(modeKey(env.compatibility.mode))}
                </Badge>
              </div>
              <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-[var(--muted)]">
                <span>
                  {t('firstRun.environment.windows', {
                    version: env.windows.version,
                    build: env.windows.build,
                  })}
                </span>
                <span>
                  {env.windhawk.installed
                    ? t('firstRun.environment.windhawk', {
                        version: env.windhawk.version ?? t('common.notAvailable'),
                      })
                    : t('firstRun.environment.windhawkMissing')}
                </span>
                <span>{t('firstRun.environment.mods', { count: env.mods.length })}</span>
              </div>
            </Card>
          )}

          <Card className="p-5">
            <h2 className="text-sm font-semibold text-[var(--text)]">
              {t('firstRun.choicesTitle')}
            </h2>
            <div className="mt-3 grid gap-2 sm:grid-cols-3">
              <div className="rounded-xl border border-[var(--border)] bg-[var(--card-muted)] p-3">
                <p className="text-xs font-semibold text-[var(--text)]">
                  {t('firstRun.actions.continue')}
                </p>
                <p className="mt-1 text-[11px] leading-relaxed text-[var(--muted)]">
                  {t('firstRun.choice.home')}
                </p>
              </div>
              <div className="rounded-xl border border-[var(--border)] bg-[var(--card-muted)] p-3">
                <p className="text-xs font-semibold text-[var(--text)]">
                  {t('firstRun.actions.capture')}
                </p>
                <p className="mt-1 text-[11px] leading-relaxed text-[var(--muted)]">
                  {t('firstRun.choice.capture')}
                </p>
              </div>
              <div className="rounded-xl border border-[var(--border)] bg-[var(--card-muted)] p-3">
                <p className="text-xs font-semibold text-[var(--text)]">
                  {t('firstRun.actions.pack')}
                </p>
                <p className="mt-1 text-[11px] leading-relaxed text-[var(--muted)]">
                  {t('firstRun.choice.pack')}
                </p>
              </div>
            </div>
            {completeError === null ? null : (
              <p className="mt-3 text-xs text-[var(--danger)]" role="alert">
                {t('firstRun.completeError')}: {completeError}
              </p>
            )}
            <div className="mt-4">{footer}</div>
          </Card>
        </>
      )}

      {loading || bothFailed ? null : (
        <footer className="flex items-start gap-2 px-1 text-[11px] leading-relaxed text-[var(--faint)]">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>{t('firstRun.footer')}</span>
        </footer>
      )}
    </section>
  );
}
