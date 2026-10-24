import {
  AlertTriangle,
  CheckCircle2,
  Clipboard,
  FolderOpen,
  RefreshCw,
  Server,
  ShieldCheck,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { AppState, Appearance, Environment, Language, SettingsPatch } from '@shared/domain';
import type { Diagnostics } from '@shared/ipc';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { ErrorState } from '../components/ui/ErrorState';
import { Notice } from './profiles/Notice';
import { formatDateTime } from '../i18n/format';

interface Loadable<T> {
  readonly data: T | null;
  readonly loading: boolean;
  readonly error: string | null;
}

interface SelectOption<T extends string> {
  readonly value: T;
  readonly labelKey: string;
}

const LANGUAGE_OPTIONS: ReadonlyArray<SelectOption<Language>> = [
  { value: 'system', labelKey: 'settings.language.system' },
  { value: 'th', labelKey: 'settings.language.thai' },
  { value: 'en', labelKey: 'settings.language.english' },
];

const APPEARANCE_OPTIONS: ReadonlyArray<SelectOption<Appearance>> = [
  { value: 'system', labelKey: 'settings.appearance.system' },
  { value: 'light', labelKey: 'settings.appearance.light' },
  { value: 'dark', labelKey: 'settings.appearance.dark' },
];

const EXPLORER_OPTIONS: ReadonlyArray<SelectOption<AppState['explorerRestart']>> = [
  { value: 'ask', labelKey: 'settings.explorer.ask' },
  { value: 'always', labelKey: 'settings.explorer.always' },
  { value: 'never', labelKey: 'settings.explorer.never' },
];

const RETENTION_MIN = 5;
const RETENTION_MAX = 50;

function loadingState<T>(): Loadable<T> {
  return { data: null, loading: true, error: null };
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

function storageModeKey(mode: string): string {
  if (mode === 'registry') return 'settings.diagnostics.storage.registry';
  if (mode === 'portable') return 'settings.diagnostics.storage.portable';
  return 'settings.diagnostics.storage.unknown';
}

function serviceStateKey(state: string): string {
  if (state === 'running') return 'settings.diagnostics.serviceState.running';
  if (state === 'stopped') return 'settings.diagnostics.serviceState.stopped';
  if (state === 'missing') return 'settings.diagnostics.serviceState.missing';
  return 'settings.diagnostics.serviceState.unknown';
}

function runStatusKey(status: NonNullable<Diagnostics['lastRun']>['status']): string {
  return `settings.diagnostics.runStatus.${status}`;
}

function environmentModeKey(mode: Environment['compatibility']['mode']): string {
  return `settings.environment.mode.${mode}`;
}

function EnvironmentStatus({
  environment,
  onRetry,
}: {
  readonly environment: Loadable<Environment>;
  readonly onRetry: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const data = environment.data;

  if (environment.loading && data === null) {
    return <div className="h-20 animate-pulse rounded-2xl bg-[var(--border)]" aria-busy="true" />;
  }

  if (data === null) {
    return (
      <Notice
        tone="danger"
        title={t('settings.environmentErrorTitle')}
        body={environment.error ?? t('common.unknownError')}
        action={
          <Button size="sm" onClick={onRetry}>
            {t('common.retry')}
          </Button>
        }
      />
    );
  }

  const mode = data.compatibility.mode;
  if (mode === 'writable') {
    return (
      <Card className="flex items-start gap-3 p-4">
        <CheckCircle2
          size={18}
          className="mt-0.5 shrink-0 text-[var(--success)]"
          aria-hidden="true"
        />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold text-[var(--text)]">
              {t('settings.environment.readyTitle')}
            </p>
            <Badge tone="success">{t(environmentModeKey(mode))}</Badge>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-[var(--muted)]">
            {t('settings.environment.readyBody')}
          </p>
        </div>
      </Card>
    );
  }

  return (
    <Notice
      tone={mode === 'unsupported' ? 'danger' : 'warning'}
      title={
        mode === 'unsupported'
          ? t('settings.environment.unsupportedTitle')
          : t('settings.environment.readOnlyTitle')
      }
      body={
        data.compatibility.issues.length === 0
          ? t('settings.environment.issuesFallback')
          : data.compatibility.issues.map((issue) => issue.message).join(' ')
      }
      action={
        <Button size="sm" onClick={onRetry}>
          {t('common.retry')}
        </Button>
      }
    />
  );
}

export interface SettingsProps {
  /** Applies language and appearance immediately in the parent shell. */
  readonly onPreferencesChange: (state: AppState) => void;
  readonly onNavigate: (screen: 'profiles' | 'snapshots') => void;
}

interface PreferenceRowProps {
  readonly label: string;
  readonly description: string;
  readonly children: ReactNode;
}

function PreferenceRow({ label, description, children }: PreferenceRowProps): ReactElement {
  return (
    <div className="space-y-2 border-b border-[var(--border)] py-4 first:pt-0 last:border-b-0 last:pb-0">
      <div>
        <p className="text-sm font-semibold text-[var(--text)]">{label}</p>
        <p className="mt-1 text-xs leading-relaxed text-[var(--muted)]">{description}</p>
      </div>
      {children}
    </div>
  );
}

interface DiagnosticsRowProps {
  readonly label: string;
  readonly children: ReactNode;
}

function DiagnosticsRow({ label, children }: DiagnosticsRowProps): ReactElement {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2">
      <dt className="text-xs text-[var(--muted)]">{label}</dt>
      <dd className="min-w-0 text-right text-xs font-medium text-[var(--text)]">{children}</dd>
    </div>
  );
}

function DiagnosticsPanel({
  diagnostics,
  onRetry,
}: {
  readonly diagnostics: Loadable<Diagnostics>;
  readonly onRetry: () => void;
}): ReactElement {
  const { t, i18n } = useTranslation();
  const locale = i18n.language === 'th' ? 'th' : 'en';
  const data = diagnostics.data;

  return (
    <Card className="p-5" aria-labelledby="settings-diagnostics-heading">
      <div className="flex items-start gap-3">
        <Server size={18} className="mt-0.5 shrink-0 text-[var(--accent)]" aria-hidden="true" />
        <div className="min-w-0">
          <h2
            id="settings-diagnostics-heading"
            className="text-base font-semibold text-[var(--text)]"
          >
            {t('settings.diagnostics.title')}
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-[var(--muted)]">
            {t('settings.diagnostics.body')}
          </p>
        </div>
      </div>

      {diagnostics.loading && data === null ? (
        <div className="mt-4 space-y-2" aria-busy="true">
          {Array.from({ length: 6 }, (_, index) => (
            <div key={index} className="h-4 animate-pulse rounded bg-[var(--border)]" />
          ))}
        </div>
      ) : data === null ? (
        <div className="mt-4">
          <ErrorState
            title={t('settings.diagnosticsErrorTitle')}
            description={diagnostics.error ?? t('common.unknownError')}
            action={
              <Button size="sm" onClick={onRetry}>
                {t('common.retry')}
              </Button>
            }
          />
        </div>
      ) : (
        <>
          {diagnostics.error === null ? null : (
            <p className="mt-3 text-xs leading-relaxed text-[var(--warning)]" role="status">
              {t('settings.diagnostics.stale')}
            </p>
          )}
          <dl className="mt-4 divide-y divide-[var(--border)]">
            <DiagnosticsRow label={t('settings.diagnostics.appVersion')}>
              {data.appVersion}
            </DiagnosticsRow>
            <DiagnosticsRow label={t('settings.diagnostics.windows')}>
              <span className="inline-flex flex-wrap items-center justify-end gap-2">
                <span>{t('settings.diagnostics.windowsValue', { build: data.windowsBuild })}</span>
                <Badge tone={data.windowsSupported ? 'success' : 'danger'}>
                  {data.windowsSupported
                    ? t('settings.diagnostics.supported')
                    : t('settings.diagnostics.unsupported')}
                </Badge>
              </span>
            </DiagnosticsRow>
            <DiagnosticsRow label={t('settings.diagnostics.windhawkVersion')}>
              {data.windhawkVersion ?? t('common.notAvailable')}
            </DiagnosticsRow>
            <DiagnosticsRow label={t('settings.diagnostics.storageMode')}>
              {t(storageModeKey(data.storageMode))}
            </DiagnosticsRow>
            <DiagnosticsRow label={t('settings.diagnostics.registryRoot')}>
              {data.registryRoot ?? t('common.notAvailable')}
            </DiagnosticsRow>
            <DiagnosticsRow label={t('settings.diagnostics.service')}>
              {t(serviceStateKey(data.serviceState))}
            </DiagnosticsRow>
            <DiagnosticsRow label={t('settings.diagnostics.modCount')}>
              {t('settings.diagnostics.modCountValue', { count: data.modCount })}
            </DiagnosticsRow>
            <DiagnosticsRow label={t('settings.diagnostics.lastRun')}>
              {data.lastRun === null
                ? t('settings.diagnostics.noLastRun')
                : t('settings.diagnostics.lastRunValue', {
                    status: t(runStatusKey(data.lastRun.status)),
                    at:
                      data.lastRun.completedAt === null
                        ? t('common.notAvailable')
                        : formatDateTime(data.lastRun.completedAt, locale),
                  })}
            </DiagnosticsRow>
          </dl>
        </>
      )}
    </Card>
  );
}

export function Settings({ onPreferencesChange, onNavigate }: SettingsProps): ReactElement {
  const { t } = useTranslation();
  const [appState, setAppState] = useState<Loadable<AppState>>(() => loadingState());
  const [environment, setEnvironment] = useState<Loadable<Environment>>(() => loadingState());
  const [diagnostics, setDiagnostics] = useState<Loadable<Diagnostics>>(() => loadingState());
  const [saving, setSaving] = useState<keyof SettingsPatch | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [retentionDraft, setRetentionDraft] = useState('');
  const [retentionError, setRetentionError] = useState<string | null>(null);
  const [retentionSaved, setRetentionSaved] = useState(false);
  const [opening, setOpening] = useState<'logs' | 'data' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const mounted = useRef(true);
  const retentionInitialized = useRef(false);

  useEffect(() => {
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (appState.data !== null && !retentionInitialized.current) {
      retentionInitialized.current = true;
      setRetentionDraft(String(appState.data.snapshotRetention));
    }
  }, [appState.data]);

  const refreshState = useCallback(async (): Promise<void> => {
    setAppState((current) => ({ ...current, loading: true, error: null }));
    try {
      const value = await window.api.getState();
      if (!mounted.current) return;
      setAppState({ data: value, loading: false, error: null });
    } catch (error) {
      if (!mounted.current) return;
      setAppState((current) => ({
        data: current.data,
        loading: false,
        error: errorMessage(error),
      }));
    }
  }, []);

  const refreshEnvironment = useCallback(async (): Promise<void> => {
    setEnvironment((current) => ({ ...current, loading: true, error: null }));
    try {
      const value = await window.api.getEnvironment();
      if (!mounted.current) return;
      setEnvironment({ data: value, loading: false, error: null });
    } catch (error) {
      if (!mounted.current) return;
      setEnvironment((current) => ({
        data: current.data,
        loading: false,
        error: errorMessage(error),
      }));
    }
  }, []);

  const refreshDiagnostics = useCallback(async (): Promise<void> => {
    setDiagnostics((current) => ({ ...current, loading: true, error: null }));
    try {
      const value = await window.api.getDiagnostics();
      if (!mounted.current) return;
      setDiagnostics({ data: value, loading: false, error: null });
    } catch (error) {
      if (!mounted.current) return;
      setDiagnostics((current) => ({
        data: current.data,
        loading: false,
        error: errorMessage(error),
      }));
    }
  }, []);

  const refreshAll = useCallback(async (): Promise<void> => {
    setAppState((current) => ({ ...current, loading: true, error: null }));
    setEnvironment((current) => ({ ...current, loading: true, error: null }));
    setDiagnostics((current) => ({ ...current, loading: true, error: null }));

    const results = await Promise.allSettled([
      window.api.getState(),
      window.api.getEnvironment(),
      window.api.getDiagnostics(),
    ]);
    if (!mounted.current) return;

    const [stateResult, environmentResult, diagnosticsResult] = results;
    setAppState((current) => settledValue(stateResult, current.data));
    setEnvironment((current) => settledValue(environmentResult, current.data));
    setDiagnostics((current) => settledValue(diagnosticsResult, current.data));
  }, []);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  const applyPatch = useCallback(
    async (patch: SettingsPatch): Promise<AppState | null> => {
      const key = Object.keys(patch)[0] as keyof SettingsPatch | undefined;
      if (key === undefined) return null;
      setSaving(key);
      setSaveError(null);
      try {
        const next = await window.api.updateSettings(patch);
        if (!mounted.current) return null;
        setAppState({ data: next, loading: false, error: null });
        onPreferencesChange(next);
        return next;
      } catch (error) {
        if (mounted.current) setSaveError(errorMessage(error));
        return null;
      } finally {
        if (mounted.current) setSaving(null);
      }
    },
    [onPreferencesChange],
  );

  const handleRetentionSave = async (): Promise<void> => {
    const trimmed = retentionDraft.trim();
    const parsed = Number(trimmed);
    if (
      !/^\d+$/.test(trimmed) ||
      !Number.isInteger(parsed) ||
      parsed < RETENTION_MIN ||
      parsed > RETENTION_MAX
    ) {
      setRetentionError(t('settings.retention.invalid'));
      setRetentionSaved(false);
      return;
    }
    setRetentionError(null);
    setRetentionSaved(false);
    if (appState.data !== null && parsed === appState.data.snapshotRetention) {
      return;
    }
    const next = await applyPatch({ snapshotRetention: parsed });
    if (next !== null) {
      setRetentionDraft(String(next.snapshotRetention));
      setRetentionSaved(true);
    }
  };

  const handleOpenFolder = async (target: 'logs' | 'data'): Promise<void> => {
    if (opening !== null) return;
    setOpening(target);
    setActionError(null);
    try {
      if (target === 'logs') {
        await window.api.openLogsFolder();
      } else {
        await window.api.openDataFolder();
      }
    } catch (error) {
      if (mounted.current) setActionError(errorMessage(error));
    } finally {
      if (mounted.current) setOpening(null);
    }
  };

  const handleCopyDiagnostics = async (): Promise<void> => {
    if (diagnostics.data === null) return;
    setCopyState('idle');
    const clipboard = navigator.clipboard;
    if (clipboard === undefined) {
      setCopyState('failed');
      return;
    }
    try {
      await clipboard.writeText(JSON.stringify(diagnostics.data, null, 2));
      if (mounted.current) setCopyState('copied');
    } catch {
      if (mounted.current) setCopyState('failed');
    }
  };

  const preferences = appState.data;
  const busy = saving !== null;

  return (
    <section className="mx-auto flex w-full max-w-5xl flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--accent)]">
            {t('settings.eyebrow')}
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-[var(--text)]">
            {t('settings.title')}
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-[var(--muted)]">
            {t('settings.body')}
          </p>
        </div>
        <Button variant="secondary" disabled={saving !== null} onClick={() => void refreshAll()}>
          <RefreshCw
            size={15}
            className={saving !== null ? 'mr-2 animate-spin' : 'mr-2'}
            aria-hidden="true"
          />
          {t('settings.refresh')}
        </Button>
      </div>

      {saveError === null ? null : (
        <Notice
          tone="danger"
          title={t('settings.saveErrorTitle')}
          body={saveError}
          action={
            <Button size="sm" onClick={() => setSaveError(null)}>
              {t('common.dismiss')}
            </Button>
          }
        />
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Card className="p-5" aria-labelledby="settings-preferences-heading">
          <div className="flex items-start gap-3">
            <ShieldCheck
              size={18}
              className="mt-0.5 shrink-0 text-[var(--accent)]"
              aria-hidden="true"
            />
            <div className="min-w-0">
              <h2
                id="settings-preferences-heading"
                className="text-base font-semibold text-[var(--text)]"
              >
                {t('settings.preferences.title')}
              </h2>
              <p className="mt-1 text-xs leading-relaxed text-[var(--muted)]">
                {t('settings.preferences.body')}
              </p>
            </div>
          </div>

          {appState.loading && preferences === null ? (
            <div className="mt-4 space-y-3" aria-busy="true">
              <div className="h-16 animate-pulse rounded-xl bg-[var(--border)]" />
              <div className="h-16 animate-pulse rounded-xl bg-[var(--border)]" />
              <div className="h-16 animate-pulse rounded-xl bg-[var(--border)]" />
              <div className="h-20 animate-pulse rounded-xl bg-[var(--border)]" />
            </div>
          ) : preferences === null ? (
            <div className="mt-4">
              <ErrorState
                title={t('settings.stateErrorTitle')}
                description={appState.error ?? t('common.unknownError')}
                action={
                  <Button size="sm" onClick={() => void refreshState()}>
                    {t('common.retry')}
                  </Button>
                }
              />
            </div>
          ) : (
            <>
              {appState.error === null ? null : (
                <p className="mt-3 text-xs leading-relaxed text-[var(--warning)]" role="status">
                  {t('settings.stateStale')}
                </p>
              )}
              <div className="mt-4">
                <PreferenceRow
                  label={t('settings.language.title')}
                  description={t('settings.language.body')}
                >
                  <label htmlFor="settings-language" className="sr-only">
                    {t('settings.language.title')}
                  </label>
                  <select
                    id="settings-language"
                    className="theme-select w-full"
                    value={preferences.language}
                    disabled={busy}
                    onChange={(event) => {
                      const value = event.target.value as Language;
                      if (value !== preferences.language) {
                        void applyPatch({ language: value });
                      }
                    }}
                  >
                    {LANGUAGE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {t(option.labelKey)}
                      </option>
                    ))}
                  </select>
                </PreferenceRow>

                <PreferenceRow
                  label={t('settings.appearance.title')}
                  description={t('settings.appearance.body')}
                >
                  <label htmlFor="settings-appearance" className="sr-only">
                    {t('settings.appearance.title')}
                  </label>
                  <select
                    id="settings-appearance"
                    className="theme-select w-full"
                    value={preferences.appearance}
                    disabled={busy}
                    onChange={(event) => {
                      const value = event.target.value as Appearance;
                      if (value !== preferences.appearance) {
                        void applyPatch({ appearance: value });
                      }
                    }}
                  >
                    {APPEARANCE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {t(option.labelKey)}
                      </option>
                    ))}
                  </select>
                </PreferenceRow>

                <PreferenceRow
                  label={t('settings.explorer.title')}
                  description={t('settings.explorer.body')}
                >
                  <label htmlFor="settings-explorer" className="sr-only">
                    {t('settings.explorer.title')}
                  </label>
                  <select
                    id="settings-explorer"
                    className="theme-select w-full"
                    value={preferences.explorerRestart}
                    disabled={busy}
                    onChange={(event) => {
                      const value = event.target.value as AppState['explorerRestart'];
                      if (value !== preferences.explorerRestart) {
                        void applyPatch({ explorerRestart: value });
                      }
                    }}
                  >
                    {EXPLORER_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {t(option.labelKey)}
                      </option>
                    ))}
                  </select>
                </PreferenceRow>

                <PreferenceRow
                  label={t('settings.retention.title')}
                  description={t('settings.retention.body')}
                >
                  <div className="flex flex-wrap items-end gap-2">
                    <div>
                      <label
                        htmlFor="settings-retention"
                        className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--faint)]"
                      >
                        {t('settings.retention.inputLabel')}
                      </label>
                      <input
                        id="settings-retention"
                        type="number"
                        min={RETENTION_MIN}
                        max={RETENTION_MAX}
                        step={1}
                        inputMode="numeric"
                        className="theme-select mt-1.5 w-28"
                        value={retentionDraft}
                        disabled={busy}
                        aria-invalid={retentionError !== null}
                        onChange={(event) => {
                          setRetentionDraft(event.target.value);
                          setRetentionError(null);
                          setRetentionSaved(false);
                        }}
                      />
                    </div>
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={busy}
                      onClick={() => void handleRetentionSave()}
                    >
                      {saving === 'snapshotRetention'
                        ? t('settings.retention.saving')
                        : t('settings.retention.save')}
                    </Button>
                    <span className="text-xs text-[var(--faint)]">
                      {t('settings.retention.current', { count: preferences.snapshotRetention })}
                    </span>
                  </div>
                  <p className="text-[11px] leading-relaxed text-[var(--faint)]">
                    {t('settings.retention.range')}
                  </p>
                  {retentionError === null ? null : (
                    <p className="text-xs text-[var(--danger)]" role="alert">
                      {retentionError}
                    </p>
                  )}
                  {retentionSaved ? (
                    <p className="text-xs text-[var(--success)]" role="status">
                      {t('settings.retention.saved')}
                    </p>
                  ) : null}
                  <p className="text-[11px] leading-relaxed text-[var(--muted)]">
                    {t('settings.retention.note')}
                  </p>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="px-0"
                    onClick={() => onNavigate('snapshots')}
                  >
                    {t('settings.retention.viewSnapshots')}
                  </Button>
                </PreferenceRow>
              </div>
            </>
          )}
        </Card>

        <div className="flex min-w-0 flex-col gap-4">
          <EnvironmentStatus environment={environment} onRetry={() => void refreshEnvironment()} />

          <DiagnosticsPanel diagnostics={diagnostics} onRetry={() => void refreshDiagnostics()} />

          <Card className="p-5" aria-labelledby="settings-actions-heading">
            <h2
              id="settings-actions-heading"
              className="text-base font-semibold text-[var(--text)]"
            >
              {t('settings.actions.title')}
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-[var(--muted)]">
              {t('settings.actions.body')}
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={opening !== null}
                onClick={() => void handleOpenFolder('logs')}
              >
                <FolderOpen size={14} className="mr-2" aria-hidden="true" />
                {opening === 'logs'
                  ? t('settings.actions.opening')
                  : t('settings.actions.openLogs')}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={opening !== null}
                onClick={() => void handleOpenFolder('data')}
              >
                <FolderOpen size={14} className="mr-2" aria-hidden="true" />
                {opening === 'data'
                  ? t('settings.actions.opening')
                  : t('settings.actions.openData')}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={diagnostics.data === null}
                onClick={() => void handleCopyDiagnostics()}
              >
                <Clipboard size={14} className="mr-2" aria-hidden="true" />
                {copyState === 'copied'
                  ? t('settings.actions.copied')
                  : t('settings.actions.copyDiagnostics')}
              </Button>
            </div>
            {actionError === null ? null : (
              <p className="mt-3 text-xs text-[var(--danger)]" role="alert">
                {t('settings.actions.openFailed')}: {actionError}
              </p>
            )}
            {copyState === 'failed' ? (
              <p className="mt-3 text-xs text-[var(--danger)]" role="alert">
                {t('settings.actions.copyFailed')}
              </p>
            ) : null}
            {copyState === 'copied' ? (
              <p className="mt-3 text-xs text-[var(--success)]" role="status">
                {t('settings.actions.copied')}
              </p>
            ) : null}
          </Card>
        </div>
      </div>

      <footer className="flex items-center gap-2 px-1 text-[11px] text-[var(--faint)]">
        <AlertTriangle size={12} aria-hidden="true" />
        <span>{t('settings.footer')}</span>
      </footer>
    </section>
  );
}
