import {
  Camera,
  Copy,
  Download,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import type { AppState, Environment, Profile } from '@shared/domain';
import { Badge, type BadgeTone } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Dialog } from '../components/ui/Dialog';
import { EmptyState } from '../components/ui/EmptyState';
import { ErrorState } from '../components/ui/ErrorState';
import { Toast } from '../components/ui/Toast';
import { formatDateTime } from '../i18n/format';
import { CaptureDialog } from './profiles/CaptureDialog';
import { Notice } from './profiles/Notice';
import { ProfileEditor } from './profiles/ProfileEditor';
import {
  countMissingMods,
  errorMessage,
  removeProfile,
  upsertProfile,
} from './profiles/profile-utils';

interface Loadable<T> {
  readonly data: T | null;
  readonly loading: boolean;
  readonly error: string | null;
}

interface Feedback {
  readonly tone: 'info' | 'success' | 'warning' | 'danger';
  readonly title: string;
  readonly description?: string;
}

function loadingState<T>(): Loadable<T> {
  return { data: null, loading: true, error: null };
}

function settledValue<T>(result: PromiseSettledResult<T>, previous: T | null): Loadable<T> {
  if (result.status === 'fulfilled') {
    return { data: result.value, loading: false, error: null };
  }
  return { data: previous, loading: false, error: errorMessage(result.reason) };
}

function sourceTone(profile: Profile): BadgeTone {
  return profile.source === 'builtin' ? 'info' : 'neutral';
}

export interface ProfilesProps {
  readonly onApply: (profileId: string) => void;
}

interface ProfileCardProps {
  readonly profile: Profile;
  readonly environment: Environment | null;
  readonly isActive: boolean;
  readonly lastAppliedAt: string | null;
  readonly duplicatingId: string | null;
  readonly exportingId: string | null;
  readonly onApply: (profileId: string) => void;
  readonly onEdit: (profile: Profile) => void;
  readonly onDuplicate: (profile: Profile) => void;
  readonly onDelete: (profile: Profile) => void;
  readonly onExport: (profile: Profile) => void;
}

function ProfileCard({
  profile,
  environment,
  isActive,
  lastAppliedAt,
  duplicatingId,
  exportingId,
  onApply,
  onEdit,
  onDuplicate,
  onDelete,
  onExport,
}: ProfileCardProps): ReactElement {
  const { t, i18n } = useTranslation();
  const locale = i18n.language === 'th' ? 'th' : 'en';
  const readOnly = profile.source === 'builtin';
  const zeroManaged = profile.requiredMods.length === 0;
  const missing = countMissingMods(profile.requiredMods, environment);
  const builtInThemePackIncomplete =
    profile.source === 'builtin' &&
    profile.id !== 'default-windows' &&
    missing !== null &&
    missing > 0;
  const applyDisabled =
    zeroManaged || builtInThemePackIncomplete || environment?.compatibility.canApply === false;
  const headingId = `profiles-card-${profile.id}`;

  return (
    <Card className="h-full p-5">
      <article aria-labelledby={headingId} className="flex h-full flex-col justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3
              id={headingId}
              className="text-base font-semibold tracking-tight text-[var(--text)]"
            >
              {profile.name}
            </h3>
            <Badge tone={sourceTone(profile)}>{t(`profiles.source.${profile.source}`)}</Badge>
            {isActive ? <Badge tone="success">{t('profiles.active')}</Badge> : null}
            {zeroManaged ? <Badge tone="warning">{t('profiles.zeroManaged')}</Badge> : null}
          </div>

          {profile.description.length === 0 ? null : (
            <p className="mt-2 text-xs leading-relaxed text-[var(--muted)]">
              {profile.description}
            </p>
          )}
          {profile.basedOn === null ? null : (
            <p className="mt-1 text-[11px] text-[var(--faint)]">
              {t('profiles.basedOn', { name: profile.basedOn })}
            </p>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-xs text-[var(--muted)]">
              {t('profiles.managedMods', { count: profile.requiredMods.length })}
            </span>
            {missing === null ? (
              <Badge tone="neutral">{t('profiles.missingUnknown')}</Badge>
            ) : missing > 0 ? (
              <Badge tone="warning">{t('profiles.missingMods', { count: missing })}</Badge>
            ) : (
              <Badge tone="success">{t('profiles.allModsInstalled')}</Badge>
            )}
          </div>

          {isActive ? (
            <p className="mt-2 text-xs text-[var(--faint)]">
              {t('profiles.lastApplied', {
                at:
                  lastAppliedAt === null
                    ? t('profiles.never')
                    : formatDateTime(lastAppliedAt, locale),
              })}
            </p>
          ) : null}

          {missing === null || missing === 0 ? null : (
            <p className="mt-2 text-xs leading-relaxed text-[var(--warning)]">
              {t('profiles.missingHint')}
            </p>
          )}
          {applyDisabled ? (
            <p className="mt-2 text-xs leading-relaxed text-[var(--faint)]">
              {zeroManaged ? t('profiles.applyUnavailableZero') : t('profiles.applyUnavailable')}
            </p>
          ) : null}
          {readOnly ? (
            <p className="mt-2 text-[11px] leading-relaxed text-[var(--faint)]">
              {t('profiles.builtInReadOnly')}
            </p>
          ) : null}
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            size="sm"
            disabled={applyDisabled}
            onClick={() => onApply(profile.id)}
          >
            <Play size={14} className="mr-2" aria-hidden="true" />
            {t('profiles.actions.apply')}
          </Button>
          {readOnly ? null : (
            <Button variant="secondary" size="sm" onClick={() => onEdit(profile)}>
              <Pencil size={14} className="mr-2" aria-hidden="true" />
              {t('profiles.actions.edit')}
            </Button>
          )}
          <Button
            variant="secondary"
            size="sm"
            disabled={duplicatingId === profile.id}
            onClick={() => onDuplicate(profile)}
          >
            <Copy size={14} className="mr-2" aria-hidden="true" />
            {duplicatingId === profile.id
              ? t('profiles.actions.duplicating')
              : t('profiles.actions.duplicate')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={exportingId === profile.id}
            onClick={() => onExport(profile)}
          >
            <Download size={14} className="mr-2" aria-hidden="true" />
            {exportingId === profile.id
              ? t('profiles.actions.exporting')
              : t('profiles.actions.export')}
          </Button>
          {readOnly ? null : (
            <Button variant="danger" size="sm" onClick={() => onDelete(profile)}>
              <Trash2 size={14} className="mr-2" aria-hidden="true" />
              {t('profiles.actions.delete')}
            </Button>
          )}
        </div>
      </article>
    </Card>
  );
}

export function Profiles({ onApply }: ProfilesProps): ReactElement {
  const { t } = useTranslation();
  const [profiles, setProfiles] = useState<Loadable<Profile[]>>(() => loadingState());
  const [environment, setEnvironment] = useState<Loadable<Environment>>(() => loadingState());
  const [appState, setAppState] = useState<Loadable<AppState>>(() => loadingState());
  const [notice, setNotice] = useState<Feedback | null>(null);
  const [createPending, setCreatePending] = useState(false);
  const [importPending, setImportPending] = useState(false);
  const [duplicatingId, setDuplicatingId] = useState<string | null>(null);
  const [exportingId, setExportingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Profile | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [editorProfile, setEditorProfile] = useState<Profile | null>(null);
  const mounted = useRef(true);
  const lastRefreshAt = useRef(0);

  useEffect(() => {
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    lastRefreshAt.current = Date.now();
    setProfiles((current) => ({ ...current, loading: true, error: null }));
    setEnvironment((current) => ({ ...current, loading: true, error: null }));
    setAppState((current) => ({ ...current, loading: true, error: null }));

    const results = await Promise.allSettled([
      window.api.listProfiles(),
      window.api.getEnvironment(),
      window.api.getState(),
    ]);
    if (!mounted.current) return;

    const [profilesResult, environmentResult, stateResult] = results;
    setProfiles((current) => settledValue(profilesResult, current.data));
    setEnvironment((current) => settledValue(environmentResult, current.data));
    setAppState((current) => settledValue(stateResult, current.data));
  }, []);

  useEffect(() => {
    void refresh();
    const onFocus = (): void => {
      if (Date.now() - lastRefreshAt.current >= 10_000) void refresh();
    };
    const onApplied = (): void => {
      void refresh();
    };
    window.addEventListener('focus', onFocus);
    window.addEventListener('wpm:applied', onApplied);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('wpm:applied', onApplied);
    };
  }, [refresh]);

  const addProfile = (profile: Profile): void => {
    setProfiles((current) => ({
      data: upsertProfile(current.data ?? [], profile),
      loading: false,
      error: current.error,
    }));
  };

  const handleCreateBlank = async (): Promise<void> => {
    if (createPending) return;
    setCreatePending(true);
    setNotice(null);
    try {
      const created = await window.api.createProfile({ name: t('profiles.newProfileName') });
      addProfile(created);
      setEditorProfile(created);
    } catch (error) {
      setNotice({
        tone: 'danger',
        title: t('profiles.createErrorTitle'),
        description: errorMessage(error),
      });
    } finally {
      setCreatePending(false);
    }
  };

  const handleImport = async (): Promise<void> => {
    if (importPending) return;
    setImportPending(true);
    setNotice(null);
    try {
      const imported = await window.api.importProfile();
      if (imported === null) return;
      addProfile(imported);
      setNotice({
        tone: 'success',
        title: t('profiles.importSuccessTitle'),
        description: t('profiles.importSuccessBody', { name: imported.name }),
      });
    } catch (error) {
      setNotice({
        tone: 'danger',
        title: t('profiles.importErrorTitle'),
        description: errorMessage(error),
      });
    } finally {
      setImportPending(false);
    }
  };

  const handleDuplicate = async (profile: Profile): Promise<void> => {
    if (duplicatingId !== null) return;
    setDuplicatingId(profile.id);
    setNotice(null);
    try {
      const copy = await window.api.duplicateProfile(profile.id);
      addProfile(copy);
      setNotice({
        tone: 'success',
        title: t('profiles.duplicateSuccessTitle'),
        description: t('profiles.duplicateSuccessBody', { name: copy.name }),
      });
    } catch (error) {
      setNotice({
        tone: 'danger',
        title: t('profiles.duplicateErrorTitle'),
        description: errorMessage(error),
      });
    } finally {
      setDuplicatingId(null);
    }
  };

  const handleExport = async (profile: Profile): Promise<void> => {
    if (exportingId !== null) return;
    setExportingId(profile.id);
    setNotice(null);
    try {
      const path = await window.api.exportProfile(profile.id);
      if (path === null) return;
      setNotice({
        tone: 'success',
        title: t('profiles.exportSuccessTitle'),
        description: t('profiles.exportSuccessBody', { path }),
      });
    } catch (error) {
      setNotice({
        tone: 'danger',
        title: t('profiles.exportErrorTitle'),
        description: errorMessage(error),
      });
    } finally {
      setExportingId(null);
    }
  };

  const handleDeleteRequest = (profile: Profile): void => {
    if (profile.source === 'builtin') return;
    setDeleteError(null);
    setDeleteTarget(profile);
  };

  const handleDeleteConfirm = async (): Promise<void> => {
    const target = deleteTarget;
    if (target === null || deletePending) return;
    setDeletePending(true);
    setDeleteError(null);
    try {
      await window.api.deleteProfile(target.id, target.revision);
      setProfiles((current) => ({
        data: current.data === null ? null : removeProfile(current.data, target.id),
        loading: false,
        error: current.error,
      }));
      setDeleteTarget(null);
      setNotice({
        tone: 'success',
        title: t('profiles.deleteSuccessTitle'),
        description: t('profiles.deleteSuccessBody', { name: target.name }),
      });
    } catch (error) {
      setDeleteError(errorMessage(error));
    } finally {
      setDeletePending(false);
    }
  };

  const handleEdit = (profile: Profile): void => {
    if (profile.source === 'builtin') return;
    setCaptureOpen(false);
    setDeleteTarget(null);
    setEditorProfile(profile);
  };

  const handleEditorSaved = (updated: Profile): void => {
    addProfile(updated);
    setEditorProfile(null);
    setNotice({
      tone: 'success',
      title: t('profiles.editor.saved'),
      description: t('profiles.editor.savedBody', { name: updated.name }),
    });
  };

  const handleEditorReloaded = (fresh: Profile): void => {
    addProfile(fresh);
    setEditorProfile(fresh);
  };

  if (editorProfile !== null) {
    return (
      <ProfileEditor
        profile={editorProfile}
        environment={environment.data}
        environmentError={environment.error}
        onBack={() => setEditorProfile(null)}
        onSaved={handleEditorSaved}
        onReloaded={handleEditorReloaded}
      />
    );
  }

  const profileList = profiles.data ?? [];
  const builtins = profileList.filter((profile) => profile.source === 'builtin');
  const users = profileList.filter((profile) => profile.source !== 'builtin');
  const activeProfileId = appState.data?.activeProfileId ?? null;
  const lastAppliedAt = appState.data?.lastAppliedAt ?? null;
  const environmentData = environment.data;
  const profileListLoading = profiles.loading && profiles.data === null;
  const profileListFailed = !profiles.loading && profiles.data === null;

  return (
    <section className="mx-auto flex w-full max-w-5xl flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--accent)]">
            {t('profiles.eyebrow')}
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-[var(--text)]">
            {t('profiles.title')}
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-[var(--muted)]">
            {t('profiles.body')}
          </p>
        </div>
        <Button variant="secondary" onClick={() => void refresh()}>
          <RefreshCw
            size={15}
            className={profiles.loading ? 'mr-2 animate-spin' : 'mr-2'}
            aria-hidden="true"
          />
          {t('profiles.refresh')}
        </Button>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button variant="primary" disabled={createPending} onClick={() => void handleCreateBlank()}>
          <Plus size={15} className="mr-2" aria-hidden="true" />
          {createPending ? t('profiles.actions.creating') : t('profiles.actions.createBlank')}
        </Button>
        <Button variant="secondary" onClick={() => setCaptureOpen(true)}>
          <Camera size={15} className="mr-2" aria-hidden="true" />
          {t('profiles.actions.capture')}
        </Button>
        <Button variant="secondary" disabled={importPending} onClick={() => void handleImport()}>
          <Upload size={15} className="mr-2" aria-hidden="true" />
          {importPending ? t('profiles.actions.importing') : t('profiles.actions.import')}
        </Button>
      </div>

      {notice === null ? null : (
        <Toast
          tone={notice.tone}
          title={notice.title}
          description={notice.description}
          onDismiss={() => setNotice(null)}
        />
      )}

      {profiles.error !== null && profiles.data !== null ? (
        <Notice
          tone="danger"
          title={t('profiles.profilesErrorTitle')}
          body={profiles.error}
          action={
            <Button size="sm" onClick={() => void refresh()}>
              {t('common.retry')}
            </Button>
          }
        />
      ) : null}
      {environment.error !== null ? (
        <Notice
          tone="warning"
          title={t('profiles.environmentErrorTitle')}
          body={t('profiles.environmentErrorBody', { message: environment.error })}
          action={
            <Button size="sm" onClick={() => void refresh()}>
              {t('common.retry')}
            </Button>
          }
        />
      ) : null}
      {appState.error !== null ? (
        <Notice
          tone="warning"
          title={t('profiles.stateErrorTitle')}
          body={appState.error}
          action={
            <Button size="sm" onClick={() => void refresh()}>
              {t('common.retry')}
            </Button>
          }
        />
      ) : null}

      {profileListLoading ? (
        <div className="space-y-3" aria-busy="true">
          <p className="text-xs text-[var(--muted)]">{t('profiles.loading')}</p>
          <div className="h-36 animate-pulse rounded-2xl bg-[var(--border)]" />
          <div className="h-36 animate-pulse rounded-2xl bg-[var(--border)]" />
        </div>
      ) : profileListFailed ? (
        <Card className="p-6">
          <ErrorState
            title={t('profiles.profilesErrorTitle')}
            description={profiles.error ?? t('common.unknownError')}
            action={
              <Button variant="primary" onClick={() => void refresh()}>
                {t('common.retry')}
              </Button>
            }
          />
        </Card>
      ) : (
        <>
          {builtins.length === 0 ? null : (
            <section aria-labelledby="profiles-builtin-heading">
              <div className="flex items-center justify-between gap-3">
                <h2
                  id="profiles-builtin-heading"
                  className="text-base font-semibold text-[var(--text)]"
                >
                  {t('profiles.section.builtin')}
                </h2>
                <span className="text-xs text-[var(--faint)]">{builtins.length}</span>
              </div>
              <ul className="mt-3 grid gap-3 lg:grid-cols-2">
                {builtins.map((profile) => (
                  <li key={profile.id}>
                    <ProfileCard
                      profile={profile}
                      environment={environmentData}
                      isActive={activeProfileId === profile.id}
                      lastAppliedAt={lastAppliedAt}
                      duplicatingId={duplicatingId}
                      exportingId={exportingId}
                      onApply={onApply}
                      onEdit={handleEdit}
                      onDuplicate={(entry) => void handleDuplicate(entry)}
                      onDelete={handleDeleteRequest}
                      onExport={(entry) => void handleExport(entry)}
                    />
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section aria-labelledby="profiles-user-heading">
            <div className="flex items-center justify-between gap-3">
              <h2 id="profiles-user-heading" className="text-base font-semibold text-[var(--text)]">
                {t('profiles.section.user')}
              </h2>
              <span className="text-xs text-[var(--faint)]">{users.length}</span>
            </div>
            {users.length === 0 ? (
              <EmptyState
                className="mt-3"
                icon={<Camera size={22} />}
                title={
                  profileList.length === 0 ? t('profiles.emptyTitle') : t('profiles.emptyUserTitle')
                }
                description={
                  profileList.length === 0 ? t('profiles.emptyBody') : t('profiles.emptyUserBody')
                }
                action={
                  <Button variant="primary" onClick={() => setCaptureOpen(true)}>
                    <Camera size={15} className="mr-2" aria-hidden="true" />
                    {t('profiles.actions.capture')}
                  </Button>
                }
              />
            ) : (
              <ul className="mt-3 grid gap-3 lg:grid-cols-2">
                {users.map((profile) => (
                  <li key={profile.id}>
                    <ProfileCard
                      profile={profile}
                      environment={environmentData}
                      isActive={activeProfileId === profile.id}
                      lastAppliedAt={lastAppliedAt}
                      duplicatingId={duplicatingId}
                      exportingId={exportingId}
                      onApply={onApply}
                      onEdit={handleEdit}
                      onDuplicate={(entry) => void handleDuplicate(entry)}
                      onDelete={handleDeleteRequest}
                      onExport={(entry) => void handleExport(entry)}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      {captureOpen ? (
        <CaptureDialog
          open
          environment={environmentData}
          environmentError={environment.error}
          onClose={() => setCaptureOpen(false)}
          onCaptured={addProfile}
          onOpenProfile={(profile) => {
            setCaptureOpen(false);
            setEditorProfile(profile);
          }}
        />
      ) : null}

      {deleteTarget === null ? null : (
        <Dialog
          open
          onOpenChange={(next: boolean) => {
            if (!next && !deletePending) {
              setDeleteTarget(null);
              setDeleteError(null);
            }
          }}
          title={t('profiles.delete.title', { name: deleteTarget.name })}
          description={t('profiles.delete.body')}
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
                {deletePending ? t('profiles.delete.pending') : t('profiles.delete.confirm')}
              </Button>
            </>
          }
        >
          {deleteError === null ? null : (
            <p
              className="rounded-xl border border-[var(--border)] bg-[var(--card-muted)] p-3 text-xs text-[var(--danger)]"
              role="alert"
            >
              {t('profiles.deleteErrorTitle')}: {deleteError}
            </p>
          )}
        </Dialog>
      )}
    </section>
  );
}
