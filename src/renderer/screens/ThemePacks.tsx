import { AlertTriangle, Clipboard, ExternalLink, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import type { Environment, InstalledMod, ThemePack, ThemePackMod } from '@shared/domain';
import { Badge, type BadgeTone } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { ErrorState } from '../components/ui/ErrorState';

type ModStatus = 'ready' | 'missing' | 'version-mismatch' | 'disabled';

interface Loadable<T> {
  readonly data: T | null;
  readonly loading: boolean;
  readonly error: string | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameVersion(installed: string | null, tested: string): boolean {
  return installed !== null && installed.trim() === tested.trim();
}

function statusFor(mod: ThemePackMod, installed: InstalledMod | undefined): ModStatus {
  if (installed === undefined) return 'missing';
  if (!sameVersion(installed.version, mod.testedVersion)) return 'version-mismatch';
  if (!installed.enabled) return 'disabled';
  return 'ready';
}

function statusTone(status: ModStatus): BadgeTone {
  switch (status) {
    case 'ready':
      return 'success';
    case 'missing':
      return 'danger';
    case 'version-mismatch':
      return 'warning';
    case 'disabled':
      return 'neutral';
  }
}

function statusKey(status: ModStatus): string {
  switch (status) {
    case 'ready':
      return 'packs.statusReady';
    case 'missing':
      return 'packs.statusMissing';
    case 'version-mismatch':
      return 'packs.statusMismatch';
    case 'disabled':
      return 'packs.statusDisabled';
  }
}

function Notice({ title, body }: { readonly title: string; readonly body: string }): ReactElement {
  return (
    <div
      className="rounded-2xl border border-[color-mix(in_srgb,var(--warning)_35%,transparent)] bg-[color-mix(in_srgb,var(--warning)_8%,transparent)] p-4"
      role="status"
    >
      <div className="flex items-start gap-3">
        <AlertTriangle
          size={18}
          className="mt-0.5 shrink-0 text-[var(--warning)]"
          aria-hidden="true"
        />
        <div>
          <p className="text-sm font-semibold text-[var(--text)]">{title}</p>
          <p className="mt-1 text-xs leading-relaxed text-[var(--muted)]">{body}</p>
        </div>
      </div>
    </div>
  );
}

export interface ThemePacksProps {
  readonly onApply: (profileId: string) => void;
}

export function ThemePacks({ onApply }: ThemePacksProps): ReactElement {
  const { t } = useTranslation();
  const [packs, setPacks] = useState<Loadable<ThemePack[]>>({
    data: null,
    loading: true,
    error: null,
  });
  const [environment, setEnvironment] = useState<Loadable<Environment>>({
    data: null,
    loading: true,
    error: null,
  });
  const [copied, setCopied] = useState(false);
  const lastRefreshAt = useRef(0);

  const refresh = useCallback(async (): Promise<void> => {
    lastRefreshAt.current = Date.now();
    setPacks((current) => ({ ...current, loading: true, error: null }));
    setEnvironment((current) => ({ ...current, loading: true, error: null }));
    const results = await Promise.allSettled([
      window.api.listThemePacks(),
      window.api.getEnvironment(),
    ]);
    const [packResult, environmentResult] = results;
    setPacks((current) =>
      packResult.status === 'fulfilled'
        ? { data: packResult.value, loading: false, error: null }
        : { data: current.data, loading: false, error: errorMessage(packResult.reason) },
    );
    setEnvironment((current) =>
      environmentResult.status === 'fulfilled'
        ? { data: environmentResult.value, loading: false, error: null }
        : { data: current.data, loading: false, error: errorMessage(environmentResult.reason) },
    );
  }, []);

  useEffect(() => {
    void refresh();
    const onFocus = (): void => {
      if (Date.now() - lastRefreshAt.current >= 10_000) void refresh();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  const pack = packs.data?.[0] ?? null;
  const env = environment.data;
  const installedById = new Map(
    (env?.mods ?? []).map((mod) => [mod.modId.toLowerCase(), mod] as const),
  );
  const requiredMods = pack?.mods.filter((mod) => mod.required) ?? [];
  const rows = requiredMods.map((mod) => ({
    mod,
    installed: installedById.get(mod.modId.toLowerCase()),
    status: statusFor(mod, installedById.get(mod.modId.toLowerCase())),
  }));
  const missing = rows.filter((row) => row.status === 'missing');
  const ready = pack !== null && missing.length === 0;
  const canApply = ready && env?.compatibility.canApply === true;
  const profileId = pack?.profiles[0] ?? null;

  const copyInstallList = (): void => {
    const entries = (missing.length > 0 ? missing : rows).map(
      (row) => `${row.mod.name} (${row.mod.modId}): ${row.mod.pageUrl}`,
    );
    void navigator.clipboard
      ?.writeText(entries.join('\n'))
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  };

  if (packs.loading && packs.data === null) {
    return (
      <section className="mx-auto flex w-full max-w-4xl flex-col gap-4" aria-busy="true">
        <div className="h-10 w-64 animate-pulse rounded bg-[var(--border)]" />
        <div className="h-40 animate-pulse rounded-2xl bg-[var(--border)]" />
        <div className="h-64 animate-pulse rounded-2xl bg-[var(--border)]" />
      </section>
    );
  }

  if (packs.error !== null && pack === null) {
    return (
      <section className="mx-auto w-full max-w-4xl">
        <Card className="p-6">
          <ErrorState
            title={t('packs.errorTitle')}
            description={packs.error}
            action={
              <Button variant="primary" onClick={() => void refresh()}>
                {t('common.retry')}
              </Button>
            }
          />
        </Card>
      </section>
    );
  }

  if (pack === null) {
    return (
      <section className="mx-auto w-full max-w-4xl">
        <Card className="p-6">
          <EmptyState title={t('packs.emptyTitle')} description={t('packs.emptyBody')} />
        </Card>
      </section>
    );
  }

  return (
    <section className="mx-auto flex w-full max-w-4xl flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--accent)]">
            {t('packs.eyebrow')}
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-[var(--text)]">
            {pack.name}
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-[var(--muted)]">
            {pack.description}
          </p>
        </div>
        <Button variant="secondary" onClick={() => void refresh()}>
          <RefreshCw size={15} className="mr-2" aria-hidden="true" />
          {t('packs.refresh')}
        </Button>
      </div>

      <Card className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-[var(--text)]">
              {t('packs.summaryTitle')}
            </h2>
            <p className="mt-1 text-xs text-[var(--muted)]">
              {ready
                ? t('packs.summaryReady', { count: requiredMods.length })
                : t('packs.summaryMissing', { count: missing.length })}
            </p>
          </div>
          <Badge tone={ready ? 'success' : 'warning'}>
            {ready ? t('packs.ready') : t('packs.notReady')}
          </Badge>
        </div>
        {ready ? null : (
          <ul className="mt-3 flex flex-wrap gap-2">
            {missing.map((row) => (
              <li key={row.mod.modId}>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void window.api.openExternal(row.mod.pageUrl)}
                >
                  <ExternalLink size={13} className="mr-1" aria-hidden="true" />
                  {row.mod.name}
                </Button>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            variant="primary"
            disabled={!canApply || profileId === null}
            onClick={() => {
              if (profileId !== null) onApply(profileId);
            }}
          >
            {t('packs.apply')}
          </Button>
          <Button variant="secondary" onClick={copyInstallList}>
            <Clipboard size={14} className="mr-2" aria-hidden="true" />
            {copied ? t('packs.copied') : t('packs.copyInstallList')}
          </Button>
        </div>
        {!ready ? (
          <p className="mt-2 text-xs text-[var(--faint)]">{t('packs.applyBlockedMissing')}</p>
        ) : env?.compatibility.canApply === false ? (
          <p className="mt-2 text-xs text-[var(--faint)]">{t('packs.applyBlockedMode')}</p>
        ) : null}
      </Card>

      {environment.error !== null ? (
        <Notice title={t('packs.environmentError')} body={environment.error} />
      ) : null}
      {env !== null && env.compatibility.mode !== 'writable' ? (
        <Notice
          title={
            env.compatibility.mode === 'read-only'
              ? t('packs.unsupportedTitle')
              : t('packs.unavailableTitle')
          }
          body={env.compatibility.issues.map((issue) => issue.message).join(' ')}
        />
      ) : null}

      <Card className="overflow-hidden">
        <div className="border-b border-[var(--border)] px-5 py-4">
          <h2 className="text-base font-semibold text-[var(--text)]">
            {t('packs.checklistTitle')}
          </h2>
          <p className="mt-1 text-xs text-[var(--muted)]">{t('packs.checklistBody')}</p>
        </div>
        <ul className="divide-y divide-[var(--border)]">
          {rows.map((row) => (
            <li
              key={row.mod.modId}
              className="flex flex-wrap items-start justify-between gap-3 px-5 py-4"
            >
              <div className="min-w-0">
                <p className="text-sm font-semibold text-[var(--text)]">{row.mod.name}</p>
                <p className="mt-1 text-xs text-[var(--muted)]">
                  {row.mod.modId} · {t('packs.installedVersion')}:{' '}
                  {row.installed?.version ?? t('packs.notInstalled')} · {t('packs.testedVersion')}:{' '}
                  {row.mod.testedVersion}
                </p>
                {row.mod.notes.length === 0 ? null : (
                  <p className="mt-1 text-xs leading-relaxed text-[var(--faint)]">
                    {row.mod.notes.join(' ')}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Badge tone={statusTone(row.status)}>{t(statusKey(row.status))}</Badge>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void window.api.openExternal(row.mod.pageUrl)}
                >
                  <ExternalLink size={13} className="mr-1" aria-hidden="true" />
                  {t('packs.openPage')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </Card>

      <Card className="p-5">
        <h2 className="text-base font-semibold text-[var(--text)]">{t('packs.notesTitle')}</h2>
        <ul className="mt-3 space-y-2">
          {[...pack.notes, ...requiredMods.flatMap((mod) => mod.notes)].map((note, index) => (
            <li key={`${index}:${note}`} className="text-xs leading-relaxed text-[var(--muted)]">
              {note}
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-[var(--faint)]">
          {t('packs.compatibilityNote', {
            version: pack.testedAppVersion,
            mods: pack.mods.length,
          })}
        </p>
      </Card>
    </section>
  );
}
