import {
  AlertTriangle,
  Archive,
  Camera,
  ChevronDown,
  ExternalLink,
  Monitor,
  Play,
  RefreshCw,
  RotateCcw,
  Server,
  Boxes,
} from 'lucide-react';
import { useState, type ReactElement, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { AppVersions } from '@shared/ipc';
import type { Drift, Environment, Profile, SnapshotMetadata } from '@shared/domain';
import { formatDateTime } from '../i18n/format';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { ErrorState } from '../components/ui/ErrorState';
import { Toast } from '../components/ui/Toast';
import type { NavId } from '../state/ui-store';
import { useHomeData, type Loadable } from './home/use-home-data';

const DOCS_URL = 'https://windhawk.net';

export interface HomeProps {
  readonly versions: AppVersions | null;
  readonly onNavigate: (screen: NavId) => void;
  readonly onApply: (profileId: string) => void;
}

interface StatusCardProps {
  readonly icon: ReactNode;
  readonly label: string;
  readonly value: string;
  readonly detail: string;
  readonly loading?: boolean;
  readonly error?: string | null;
  readonly onRetry?: () => void;
}

function StatusCard({
  icon,
  label,
  value,
  detail,
  loading = false,
  error = null,
  onRetry,
}: StatusCardProps): ReactElement {
  const { t } = useTranslation();
  return (
    <Card className="min-h-32 p-4">
      <div className="flex items-center gap-2 text-[var(--accent)]">
        <span aria-hidden="true">{icon}</span>
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em]">{label}</p>
      </div>
      {loading ? (
        <div className="mt-3 space-y-2" aria-busy="true">
          <div className="h-4 w-2/3 animate-pulse rounded bg-[var(--border)]" />
          <div className="h-3 w-full animate-pulse rounded bg-[var(--border)]" />
          <div className="h-3 w-4/5 animate-pulse rounded bg-[var(--border)]" />
        </div>
      ) : error !== null ? (
        <div className="mt-3">
          <p className="text-xs leading-relaxed text-[var(--danger)]">{error}</p>
          {onRetry === undefined ? null : (
            <Button size="sm" className="mt-2" onClick={onRetry}>
              {t('common.retry')}
            </Button>
          )}
        </div>
      ) : (
        <>
          <p className="mt-3 text-sm font-semibold text-[var(--text)]">{value}</p>
          <p className="mt-1 text-xs leading-relaxed text-[var(--muted)]">{detail}</p>
        </>
      )}
    </Card>
  );
}

function environmentLoading(environment: Loadable<Environment>): boolean {
  return environment.loading && environment.data === null;
}

function driftTone(status: Drift['status']): 'success' | 'warning' | 'neutral' {
  if (status === 'matches') return 'success';
  if (status === 'different') return 'warning';
  return 'neutral';
}

function driftLabelKey(status: Drift['status']): string {
  if (status === 'matches') return 'home.driftMatches';
  if (status === 'different') return 'home.driftDifferences';
  return 'home.driftUnknown';
}

function snapshotTriggerKey(trigger: SnapshotMetadata['trigger']): string {
  switch (trigger) {
    case 'pre-apply':
      return 'home.snapshotTrigger.preApply';
    case 'pre-restore':
      return 'home.snapshotTrigger.preRestore';
    case 'manual':
      return 'home.snapshotTrigger.manual';
    case 'imported':
      return 'home.snapshotTrigger.imported';
  }
}

function StatusSection({
  environment,
  profiles,
  snapshots,
  onRetry,
}: {
  readonly environment: Loadable<Environment>;
  readonly profiles: Loadable<Profile[]>;
  readonly snapshots: Loadable<SnapshotMetadata[]>;
  readonly onRetry: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const env = environment.data;
  const profileCount = profiles.data?.length ?? 0;
  const snapshotCount = snapshots.data?.length ?? 0;
  const mods = env?.mods ?? [];
  const enabledMods = mods.filter((mod) => mod.enabled).length;
  const storage = env?.windhawk.storageMode ?? 'unknown';

  return (
    <section
      className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"
      aria-label={t('home.statusSection')}
    >
      <StatusCard
        icon={<Server size={16} />}
        label={t('home.status.windhawk')}
        loading={environmentLoading(environment)}
        error={environment.error}
        onRetry={onRetry}
        value={
          env?.windhawk.installed === false
            ? t('home.windhawkMissing')
            : t('home.windhawkValue', {
                version: env?.windhawk.version ?? t('common.notAvailable'),
              })
        }
        detail={
          env?.windhawk.installed === false
            ? t('home.windhawkMissingDetail')
            : t('home.windhawkDetail', {
                storage: t(`home.storage.${storage}`),
                root: env?.windhawk.registryRoot ?? t('common.notAvailable'),
                service: t(`home.service.${env?.service.state ?? 'unknown'}`),
              })
        }
      />
      <StatusCard
        icon={<Boxes size={16} />}
        label={t('home.status.mods')}
        loading={environmentLoading(environment)}
        error={environment.error}
        onRetry={onRetry}
        value={t('home.modsValue', { enabled: enabledMods, total: mods.length })}
        detail={
          profiles.error !== null
            ? profiles.error
            : t('home.modsDetail', { profiles: profileCount, snapshots: snapshotCount })
        }
      />
      <StatusCard
        icon={<Archive size={16} />}
        label={t('home.status.rainmeter')}
        loading={environmentLoading(environment)}
        error={environment.error}
        onRetry={onRetry}
        value={
          env?.rainmeter.running === true
            ? t('home.rainmeterRunning')
            : env?.rainmeter.installed === true
              ? t('home.rainmeterStopped')
              : t('home.rainmeterMissing')
        }
        detail={t('home.rainmeterDetail')}
      />
      <StatusCard
        icon={<Monitor size={16} />}
        label={t('home.status.windows')}
        loading={environmentLoading(environment)}
        error={environment.error}
        onRetry={onRetry}
        value={env?.windows.version ?? t('common.notAvailable')}
        detail={
          env === null
            ? t('common.loading')
            : t('home.windowsDetail', {
                build: env.windows.build,
                supported: env.windows.supported ? t('home.supported') : t('home.unsupported'),
              })
        }
      />
    </section>
  );
}

function Banner({
  tone,
  title,
  body,
  action,
}: {
  readonly tone: 'warning' | 'danger' | 'info';
  readonly title: string;
  readonly body: string;
  readonly action?: ReactNode;
}): ReactElement {
  const classes =
    tone === 'danger'
      ? 'border-[color-mix(in_srgb,var(--danger)_35%,transparent)] bg-[color-mix(in_srgb,var(--danger)_8%,transparent)]'
      : tone === 'warning'
        ? 'border-[color-mix(in_srgb,var(--warning)_35%,transparent)] bg-[color-mix(in_srgb,var(--warning)_8%,transparent)]'
        : 'border-[var(--border)] bg-[var(--card-muted)]';
  return (
    <div className={`rounded-2xl border p-4 ${classes}`} role="status">
      <div className="flex items-start gap-3">
        <AlertTriangle
          size={18}
          className="mt-0.5 shrink-0 text-[var(--warning)]"
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-[var(--text)]">{title}</p>
          <p className="mt-1 text-xs leading-relaxed text-[var(--muted)]">{body}</p>
          {action === undefined ? null : <div className="mt-3">{action}</div>}
        </div>
      </div>
    </div>
  );
}

function ActiveProfileHero({
  profiles,
  state,
  drift,
  loading,
  error,
  onNavigate,
  onRefreshDrift,
}: {
  readonly profiles: Loadable<Profile[]>;
  readonly state: Loadable<{ activeProfileId: string | null; lastAppliedAt: string | null }>;
  readonly drift: Loadable<Drift>;
  readonly loading: boolean;
  readonly error: string | null;
  readonly onNavigate: (screen: NavId) => void;
  readonly onRefreshDrift: () => void;
}): ReactElement {
  const { t, i18n } = useTranslation();
  const locale = i18n.language === 'th' ? 'th' : 'en';
  const activeId = state.data?.activeProfileId ?? null;
  const active =
    activeId === null ? null : (profiles.data?.find((profile) => profile.id === activeId) ?? null);
  const [expanded, setExpanded] = useState(false);
  const status = drift.data?.status ?? 'unknown';
  const entries = drift.data?.entries ?? [];

  return (
    <Card tone="strong" className="overflow-hidden p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--accent)]">
            {t('home.activeProfile')}
          </p>
          {loading ? (
            <div className="mt-3 space-y-2" aria-busy="true">
              <div className="h-8 w-56 animate-pulse rounded bg-[var(--border)]" />
              <div className="h-4 w-80 max-w-full animate-pulse rounded bg-[var(--border)]" />
            </div>
          ) : active === null ? (
            <>
              <h2 className="mt-3 text-2xl font-semibold tracking-tight text-[var(--text)]">
                {t('home.noActiveProfile')}
              </h2>
              <p className="mt-2 max-w-xl text-sm leading-relaxed text-[var(--muted)]">
                {t('home.noActiveProfileBody')}
              </p>
              <Button variant="primary" className="mt-4" onClick={() => onNavigate('profiles')}>
                {t('home.chooseProfile')}
              </Button>
            </>
          ) : (
            <>
              <h2 className="mt-3 text-2xl font-semibold tracking-tight text-[var(--text)]">
                {active.name}
              </h2>
              <p className="mt-2 max-w-2xl text-sm leading-relaxed text-[var(--muted)]">
                {active.description}
              </p>
              <p className="mt-3 text-xs text-[var(--faint)]">
                {t('home.lastApplied', {
                  at:
                    state.data?.lastAppliedAt === null || state.data?.lastAppliedAt === undefined
                      ? t('home.neverApplied')
                      : formatDateTime(state.data.lastAppliedAt, locale),
                })}
              </p>
            </>
          )}
        </div>
        {active === null ? null : (
          <div className="flex flex-col items-end gap-2">
            <Badge tone={driftTone(status)}>
              {t(driftLabelKey(status), { count: entries.length })}
            </Badge>
            <Button size="sm" variant="ghost" onClick={onRefreshDrift}>
              {t('home.refreshDrift')}
            </Button>
          </div>
        )}
      </div>

      {error === null ? null : (
        <p className="mt-4 text-xs text-[var(--danger)]" role="alert">
          {t('home.environmentError')}: {error}
        </p>
      )}

      {drift.error === null ? null : (
        <p className="mt-4 text-xs text-[var(--danger)]" role="alert">
          {t('home.driftError', { message: drift.error })}
        </p>
      )}

      {active === null || status !== 'different' ? null : (
        <div className="mt-4 border-t border-[var(--border)] pt-4">
          <button
            type="button"
            className="inline-flex items-center gap-2 text-xs font-semibold text-[var(--accent)]"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            <ChevronDown
              size={14}
              className={expanded ? 'rotate-180 transition-transform' : 'transition-transform'}
              aria-hidden="true"
            />
            {expanded ? t('home.hideDrift') : t('home.showDrift')}
          </button>
          {expanded ? (
            <ul className="mt-3 space-y-2">
              {entries.map((entry, index) => (
                <li
                  key={`${entry.modId}:${entry.kind}:${index}`}
                  className="rounded-xl border border-[var(--border)] bg-[var(--card-muted)] px-3 py-2"
                >
                  <p className="text-xs font-semibold text-[var(--text)]">{entry.modId}</p>
                  <p className="mt-1 text-xs leading-relaxed text-[var(--muted)]">
                    {entry.message}
                  </p>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      )}
    </Card>
  );
}

function QuickActions({
  environment,
  activeProfileId,
  backupPending,
  error,
  onNavigate,
  onApply,
  onBackup,
}: {
  readonly environment: Loadable<Environment>;
  readonly activeProfileId: string | null;
  readonly backupPending: boolean;
  readonly error: string | null;
  readonly onNavigate: (screen: NavId) => void;
  readonly onApply: (profileId: string) => void;
  readonly onBackup: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const env = environment.data;
  const canApply = env?.compatibility.canApply === true && env.windhawk.installed;
  const canBackup = env?.windhawk.installed === true && env.windhawk.storageMode === 'registry';
  const hasActive = activeProfileId !== null;

  return (
    <Card className="p-5">
      <h2 className="text-base font-semibold text-[var(--text)]">{t('home.quickActions')}</h2>
      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        <Button
          variant="primary"
          disabled={!hasActive || !canApply}
          onClick={() => {
            if (activeProfileId !== null) onApply(activeProfileId);
          }}
        >
          <Play size={15} className="mr-2" aria-hidden="true" />
          {t('home.applyActive')}
        </Button>
        <Button variant="secondary" disabled={!canApply} onClick={() => onApply('default-windows')}>
          <RotateCcw size={15} className="mr-2" aria-hidden="true" />
          {t('home.reset')}
        </Button>
        <Button
          variant="secondary"
          disabled={env?.windhawk.installed !== true}
          onClick={() => onNavigate('profiles')}
        >
          <Camera size={15} className="mr-2" aria-hidden="true" />
          {t('home.capture')}
        </Button>
        <Button variant="secondary" disabled={!canBackup || backupPending} onClick={onBackup}>
          <Archive size={15} className="mr-2" aria-hidden="true" />
          {backupPending ? t('home.backupPending') : t('home.backup')}
        </Button>
      </div>
      {!canApply && env !== undefined ? (
        <p className="mt-3 text-xs text-[var(--faint)]">{t('home.applyBlocked')}</p>
      ) : null}
      {error === null ? null : (
        <p className="mt-3 text-xs text-[var(--danger)]" role="alert">
          {t('home.environmentError')}: {error}
        </p>
      )}
    </Card>
  );
}

function RecentSnapshots({
  snapshots,
  onNavigate,
}: {
  readonly snapshots: Loadable<SnapshotMetadata[]>;
  readonly onNavigate: (screen: NavId) => void;
}): ReactElement {
  const { t, i18n } = useTranslation();
  const locale = i18n.language === 'th' ? 'th' : 'en';
  const recent = (snapshots.data ?? []).slice(0, 3);

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-[var(--text)]">{t('home.recentSnapshots')}</h2>
        <Button size="sm" variant="ghost" onClick={() => onNavigate('snapshots')}>
          {t('home.viewAll')}
        </Button>
      </div>
      {snapshots.loading && snapshots.data === null ? (
        <div className="mt-4 space-y-2" aria-busy="true">
          <div className="h-10 animate-pulse rounded-xl bg-[var(--border)]" />
          <div className="h-10 animate-pulse rounded-xl bg-[var(--border)]" />
        </div>
      ) : snapshots.error !== null ? (
        <p className="mt-4 text-xs text-[var(--danger)]" role="alert">
          {t('home.snapshotError', { message: snapshots.error })}
        </p>
      ) : recent.length === 0 ? (
        <EmptyState
          className="mt-3"
          title={t('home.noSnapshots')}
          description={t('home.noSnapshotsBody')}
        />
      ) : (
        <ul className="mt-4 divide-y divide-[var(--border)]">
          {recent.map((snapshot) => (
            <li
              key={snapshot.id}
              className="flex items-center justify-between gap-3 py-3 first:pt-0"
            >
              <div className="min-w-0">
                <p className="text-xs font-semibold text-[var(--text)]">
                  {t('home.snapshotSummary', { count: snapshot.modCount })}
                </p>
                <p className="mt-1 text-[11px] text-[var(--faint)]">
                  {t(snapshotTriggerKey(snapshot.trigger))} ·{' '}
                  {formatDateTime(snapshot.createdAt, locale)}
                </p>
              </div>
              <Badge tone={snapshot.trigger === 'manual' ? 'info' : 'neutral'}>
                {t(snapshotTriggerKey(snapshot.trigger))}
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function Home({ versions, onNavigate, onApply }: HomeProps): ReactElement {
  const { t, i18n } = useTranslation();
  const locale = i18n.language === 'th' ? 'th' : 'en';
  const data = useHomeData();
  const [backupNotice, setBackupNotice] = useState<string | null>(null);
  const env = data.environment.data;
  const compatibility = env?.compatibility;
  const activeProfileId = data.state.data?.activeProfileId ?? null;
  const readOnly = compatibility?.mode === 'read-only';
  const unsupported = compatibility?.mode === 'unsupported';
  const serviceState = env?.service.state ?? null;

  const handleBackup = (): void => {
    setBackupNotice(null);
    void data.captureSnapshot().then((metadata) => {
      if (metadata !== null) {
        setBackupNotice(t('home.backupDone', { at: formatDateTime(metadata.createdAt, locale) }));
      }
    });
  };

  return (
    <section className="mx-auto flex w-full max-w-5xl flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--accent)]">
            {t('home.eyebrow')}
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-[var(--text)]">
            {t('app.name')}
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-[var(--muted)]">
            {t('home.body')}
          </p>
        </div>
        <Button
          variant="secondary"
          onClick={() => void data.refresh()}
          aria-label={t('home.refresh')}
        >
          <RefreshCw size={15} className="mr-2" aria-hidden="true" />
          {t('home.refresh')}
        </Button>
      </div>

      {data.actionError === null ? null : (
        <Toast
          tone="danger"
          title={t('home.actionError')}
          description={data.actionError}
          onDismiss={data.dismissActionError}
        />
      )}
      {backupNotice === null ? null : (
        <p className="text-xs text-[var(--success)]" aria-live="polite">
          {backupNotice}
        </p>
      )}

      {data.environment.error !== null && env === null ? (
        <Card className="p-6">
          <ErrorState
            title={t('home.environmentError')}
            description={data.environment.error}
            action={
              <Button variant="primary" onClick={() => void data.refresh()}>
                {t('common.retry')}
              </Button>
            }
          />
        </Card>
      ) : (
        <>
          {unsupported ? (
            <Banner
              tone="danger"
              title={t('home.unsupportedTitle')}
              body={compatibility?.issues.map((issue) => issue.message).join(' ') ?? ''}
              action={
                <Button size="sm" onClick={() => void window.api.openExternal(DOCS_URL)}>
                  <ExternalLink size={14} className="mr-2" aria-hidden="true" />
                  {t('home.docsLink')}
                </Button>
              }
            />
          ) : readOnly ? (
            <Banner
              tone="warning"
              title={t('home.readOnlyTitle')}
              body={compatibility?.issues.map((issue) => issue.message).join(' ') ?? ''}
              action={
                <Button size="sm" onClick={() => void window.api.openExternal(DOCS_URL)}>
                  <ExternalLink size={14} className="mr-2" aria-hidden="true" />
                  {t('home.docsLink')}
                </Button>
              }
            />
          ) : null}

          {serviceState === 'stopped' ? (
            <Banner
              tone="info"
              title={t('home.serviceStoppedTitle')}
              body={t('home.serviceStoppedBody')}
              action={
                <Button
                  size="sm"
                  variant="primary"
                  disabled={data.servicePending}
                  onClick={() => void data.startService()}
                >
                  {data.servicePending ? t('home.startingService') : t('home.startService')}
                </Button>
              }
            />
          ) : serviceState === 'missing' ? (
            <Banner
              tone="danger"
              title={t('home.serviceMissingTitle')}
              body={t('home.serviceMissingBody')}
            />
          ) : null}

          <ActiveProfileHero
            profiles={data.profiles}
            state={data.state}
            drift={data.drift}
            loading={
              (data.profiles.loading && data.profiles.data === null) ||
              (data.state.loading && data.state.data === null)
            }
            error={data.profiles.error ?? data.state.error}
            onNavigate={onNavigate}
            onRefreshDrift={() => void data.refreshDrift(activeProfileId)}
          />

          <StatusSection
            environment={data.environment}
            profiles={data.profiles}
            snapshots={data.snapshots}
            onRetry={() => void data.refresh()}
          />

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
            <QuickActions
              environment={data.environment}
              activeProfileId={activeProfileId}
              backupPending={data.backupPending}
              error={data.environment.error}
              onNavigate={onNavigate}
              onApply={onApply}
              onBackup={handleBackup}
            />
            <RecentSnapshots snapshots={data.snapshots} onNavigate={onNavigate} />
          </div>
        </>
      )}

      <footer className="flex flex-wrap items-center justify-between gap-2 px-1 text-[11px] text-[var(--faint)]">
        <span>{t('shell.version', { version: versions?.app ?? t('common.notAvailable') })}</span>
        <span>{t('home.footer')}</span>
      </footer>
    </section>
  );
}
