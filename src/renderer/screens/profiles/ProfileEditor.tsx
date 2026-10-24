import { AlertTriangle, ArrowLeft, Lock, RefreshCw, Save } from 'lucide-react';
import { useEffect, useId, useState, type FormEvent, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import type { Environment, InstalledMod, Profile } from '@shared/domain';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { Checkbox } from '../../components/ui/Checkbox';
import { Notice } from './Notice';
import {
  countMissingMods,
  countSettings,
  draftFromProfile,
  draftToInput,
  errorMessage,
  formatSettingValue,
  isStaleProfileError,
  summarizableSettings,
  type DraftProfileMod,
  type ProfileDraft,
} from './profile-utils';

const SELECT_CLASS =
  'mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--card)] px-2 py-2 text-xs font-normal text-[var(--text)]';

interface EditorModRow {
  readonly modId: string;
  readonly installed: InstalledMod | null;
  readonly managed: DraftProfileMod | null;
  readonly unknown: boolean;
}

export interface ProfileEditorProps {
  readonly profile: Profile;
  readonly environment: Environment | null;
  readonly environmentError: string | null;
  readonly onBack: () => void;
  readonly onSaved: (profile: Profile) => void;
  readonly onReloaded: (profile: Profile) => void;
}

export function ProfileEditor({
  profile,
  environment,
  environmentError,
  onBack,
  onSaved,
  onReloaded,
}: ProfileEditorProps): ReactElement {
  const { t } = useTranslation();
  const nameId = useId();
  const descriptionId = useId();
  const [draft, setDraft] = useState<ProfileDraft>(() => draftFromProfile(profile));
  const [saving, setSaving] = useState(false);
  const [stale, setStale] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [reloadError, setReloadError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(draftFromProfile(profile));
    setSaving(false);
    setStale(false);
    setReloading(false);
    setSaveError(null);
    setReloadError(null);
  }, [profile]);

  const installedById = new Map(
    (environment?.mods ?? []).map((mod) => [mod.modId.toLowerCase(), mod] as const),
  );
  const managedById = new Map(draft.mods.map((mod) => [mod.modId.toLowerCase(), mod] as const));
  const rows: EditorModRow[] = [];
  if (environment !== null) {
    for (const installed of environment.mods) {
      rows.push({
        modId: installed.modId,
        installed,
        managed: managedById.get(installed.modId.toLowerCase()) ?? null,
        unknown: false,
      });
    }
    for (const mod of draft.mods) {
      if (!installedById.has(mod.modId.toLowerCase())) {
        rows.push({ modId: mod.modId, installed: null, managed: mod, unknown: false });
      }
    }
  } else {
    for (const mod of draft.mods) {
      rows.push({ modId: mod.modId, installed: null, managed: mod, unknown: true });
    }
  }

  const missingCount = countMissingMods(draft.mods, environment);
  const settingCount = countSettings(draft.mods);
  const modsWithSettings = draft.mods.filter(
    (mod) => summarizableSettings(mod.settings).length > 0,
  ).length;
  const nameMissing = draft.name.trim().length === 0;
  const saveDisabled = saving || stale || nameMissing;

  const handleManagedChange = (
    modId: string,
    update: (mod: DraftProfileMod) => DraftProfileMod,
  ): void => {
    setDraft((current) => ({
      ...current,
      mods: current.mods.map((mod) =>
        mod.modId.toLowerCase() === modId.toLowerCase() ? update(mod) : mod,
      ),
    }));
  };

  const handleToggle = (row: EditorModRow, checked: boolean): void => {
    setDraft((current) => {
      const exists = current.mods.some(
        (mod) => mod.modId.toLowerCase() === row.modId.toLowerCase(),
      );
      if (checked && !exists) {
        return {
          ...current,
          mods: [
            ...current.mods,
            {
              modId: row.installed?.modId ?? row.modId,
              state: 'enabled',
              mode: 'merge',
              settings: {},
            },
          ],
        };
      }
      if (!checked && exists) {
        return {
          ...current,
          mods: current.mods.filter((mod) => mod.modId.toLowerCase() !== row.modId.toLowerCase()),
        };
      }
      return current;
    });
  };

  const handleSave = async (): Promise<void> => {
    if (saveDisabled) return;
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await window.api.updateProfile(
        profile.id,
        profile.revision,
        draftToInput(draft),
      );
      onSaved(updated);
    } catch (error) {
      if (isStaleProfileError(error)) {
        setStale(true);
      } else {
        setSaveError(errorMessage(error));
      }
    } finally {
      setSaving(false);
    }
  };

  const handleReload = async (): Promise<void> => {
    setReloading(true);
    setReloadError(null);
    try {
      const fresh = await window.api.getProfile(profile.id);
      onReloaded(fresh);
    } catch (error) {
      setReloadError(errorMessage(error));
    } finally {
      setReloading(false);
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void handleSave();
  };

  const descriptionFor = (row: EditorModRow): string => {
    if (row.unknown) return t('profiles.editor.unknownModDescription');
    if (row.installed !== null) {
      return t('profiles.editor.installedDescription', {
        state: t(`profiles.editor.state.${row.installed.enabled ? 'enabled' : 'disabled'}`),
        version: row.installed.version ?? t('common.notAvailable'),
      });
    }
    return t('profiles.editor.missingModDescription');
  };

  return (
    <section className="mx-auto flex w-full max-w-4xl flex-col gap-5">
      <form onSubmit={handleSubmit} className="flex flex-col gap-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <Button
              variant="ghost"
              size="sm"
              className="-ml-2 mb-3"
              onClick={onBack}
              disabled={saving}
            >
              <ArrowLeft size={14} className="mr-2" aria-hidden="true" />
              {t('profiles.editor.back')}
            </Button>
            <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--accent)]">
              {t('profiles.editor.eyebrow')}
            </p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight text-[var(--text)]">
              {t('profiles.editor.title', { name: profile.name })}
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-[var(--muted)]">
              {t('profiles.editor.description')}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={onBack} disabled={saving}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" variant="primary" disabled={saveDisabled}>
              <Save size={15} className="mr-2" aria-hidden="true" />
              {saving ? t('profiles.editor.saving') : t('profiles.editor.save')}
            </Button>
          </div>
        </div>

        {stale ? (
          <div
            className="rounded-2xl border border-[color-mix(in_srgb,var(--warning)_35%,transparent)] bg-[color-mix(in_srgb,var(--warning)_8%,transparent)] p-4"
            role="alert"
          >
            <div className="flex items-start gap-3">
              <AlertTriangle
                size={18}
                className="mt-0.5 shrink-0 text-[var(--warning)]"
                aria-hidden="true"
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-[var(--text)]">
                  {t('profiles.editor.staleTitle')}
                </p>
                <p className="mt-1 text-xs leading-relaxed text-[var(--muted)]">
                  {t('profiles.editor.staleBody')}
                </p>
                {reloadError === null ? null : (
                  <p className="mt-2 text-xs text-[var(--danger)]">
                    {t('profiles.editor.reloadError')}: {reloadError}
                  </p>
                )}
                <Button
                  variant="primary"
                  size="sm"
                  className="mt-3"
                  onClick={() => void handleReload()}
                  disabled={reloading}
                >
                  <RefreshCw
                    size={14}
                    className={reloading ? 'mr-2 animate-spin' : 'mr-2'}
                    aria-hidden="true"
                  />
                  {reloading ? t('profiles.editor.reloading') : t('profiles.editor.reload')}
                </Button>
              </div>
            </div>
          </div>
        ) : null}

        {saveError === null ? null : (
          <p className="text-xs text-[var(--danger)]" role="alert">
            {t('profiles.editor.saveError')}: {saveError}
          </p>
        )}

        {draft.mods.length === 0 ? (
          <Notice
            tone="warning"
            title={t('profiles.editor.zeroManagedTitle')}
            body={t('profiles.editor.zeroManagedBody')}
          />
        ) : null}

        {environment?.compatibility.canApply === false ? (
          <Notice
            tone="warning"
            title={t('profiles.applyUnavailable')}
            body={environment.compatibility.issues.map((issue) => issue.message).join(' ')}
          />
        ) : null}

        {environmentError === null ? null : (
          <Notice
            tone="warning"
            title={t('profiles.environmentErrorTitle')}
            body={t('profiles.environmentErrorBody', { message: environmentError })}
          />
        )}

        {missingCount === null || missingCount === 0 ? null : (
          <Notice
            tone="warning"
            title={t('profiles.editor.missingTitle')}
            body={t('profiles.editor.missingBody', { count: missingCount })}
          />
        )}

        <Card className="p-5">
          <h2 className="text-base font-semibold text-[var(--text)]">
            {t('profiles.editor.detailsTitle')}
          </h2>
          <div className="mt-4 grid gap-4">
            <div>
              <label htmlFor={nameId} className="text-xs font-semibold text-[var(--muted)]">
                {t('profiles.editor.name')}
              </label>
              <input
                id={nameId}
                value={draft.name}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, name: event.target.value }))
                }
                maxLength={100}
                aria-invalid={nameMissing}
                className="mt-2 w-full rounded-xl border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
              />
              {nameMissing ? (
                <p className="mt-1 text-xs text-[var(--danger)]" role="alert">
                  {t('profiles.editor.nameRequired')}
                </p>
              ) : null}
            </div>
            <div>
              <label htmlFor={descriptionId} className="text-xs font-semibold text-[var(--muted)]">
                {t('profiles.editor.descriptionLabel')}
              </label>
              <textarea
                id={descriptionId}
                value={draft.description}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, description: event.target.value }))
                }
                placeholder={t('profiles.editor.descriptionPlaceholder')}
                maxLength={1000}
                rows={3}
                className="mt-2 w-full resize-y rounded-xl border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
              />
            </div>
          </div>
        </Card>

        <Card className="p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-[var(--text)]">
                {t('profiles.editor.modsTitle')}
              </h2>
              <p className="mt-1 text-xs leading-relaxed text-[var(--muted)]">
                {t('profiles.editor.modsBody')}
              </p>
            </div>
            <Badge tone={draft.mods.length === 0 ? 'warning' : 'neutral'}>
              {t('profiles.managedMods', { count: draft.mods.length })}
            </Badge>
          </div>
          <p className="mt-3 rounded-xl border border-[var(--border)] bg-[var(--card-muted)] p-3 text-xs leading-relaxed text-[var(--muted)]">
            {t('profiles.editor.modeHint')}
          </p>
          <p className="mt-2 text-[11px] leading-relaxed text-[var(--faint)]">
            {t('profiles.editor.newModMergeHint')}
          </p>

          {rows.length === 0 ? (
            <p className="mt-4 text-xs text-[var(--muted)]">
              {t('profiles.editor.noInstalledMods')}
            </p>
          ) : (
            <ul className="mt-4 space-y-3">
              {rows.map((row) => {
                const managed = row.managed;
                const settings = managed === null ? [] : summarizableSettings(managed.settings);
                return (
                  <li
                    key={row.modId}
                    className="rounded-xl border border-[var(--border)] bg-[var(--card-muted)] p-3"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <Checkbox
                          checked={managed !== null}
                          onCheckedChange={(checked) => handleToggle(row, checked === true)}
                          label={row.modId}
                          description={descriptionFor(row)}
                        />
                      </div>
                      <div className="flex flex-wrap items-center gap-1">
                        {row.installed === null && !row.unknown ? (
                          <Badge tone="danger">{t('profiles.editor.missingBadge')}</Badge>
                        ) : null}
                        {row.unknown ? (
                          <Badge tone="neutral">{t('profiles.editor.unknownBadge')}</Badge>
                        ) : null}
                      </div>
                    </div>

                    {managed === null ? null : (
                      <div className="mt-3 grid gap-3 border-t border-[var(--border)] pt-3 sm:grid-cols-2">
                        <label className="block text-xs font-semibold text-[var(--muted)]">
                          <span>{t('profiles.editor.desiredState')}</span>
                          <select
                            aria-label={t('profiles.editor.stateFor', { mod: managed.modId })}
                            className={SELECT_CLASS}
                            value={managed.state}
                            onChange={(event) =>
                              handleManagedChange(managed.modId, (mod) => ({
                                ...mod,
                                state: event.target.value === 'disabled' ? 'disabled' : 'enabled',
                              }))
                            }
                          >
                            <option value="enabled">{t('profiles.editor.state.enabled')}</option>
                            <option value="disabled">{t('profiles.editor.state.disabled')}</option>
                          </select>
                        </label>

                        <label className="block text-xs font-semibold text-[var(--muted)]">
                          <span>{t('profiles.editor.settingsMode')}</span>
                          <select
                            aria-label={t('profiles.editor.modeFor', { mod: managed.modId })}
                            className={SELECT_CLASS}
                            value={managed.mode}
                            onChange={(event) =>
                              handleManagedChange(managed.modId, (mod) => ({
                                ...mod,
                                mode: event.target.value === 'merge' ? 'merge' : 'replace',
                              }))
                            }
                          >
                            <option value="merge">{t('profiles.editor.mode.merge')}</option>
                            <option value="replace">{t('profiles.editor.mode.replace')}</option>
                          </select>
                        </label>
                      </div>
                    )}

                    {managed === null ? null : (
                      <div className="mt-2">
                        {settings.length === 0 ? (
                          <p className="text-xs text-[var(--muted)]">
                            {t('profiles.editor.noSettings')}
                          </p>
                        ) : (
                          <details>
                            <summary className="cursor-pointer text-xs font-medium text-[var(--accent)]">
                              {t('profiles.editor.settingsCount', {
                                count: settings.length,
                              })}
                            </summary>
                            <ul className="mt-2 space-y-1">
                              {settings.map(([name, setting]) => (
                                <li key={name} className="text-xs text-[var(--muted)]">
                                  {t('profiles.editor.settingLine', {
                                    mod: managed.modId,
                                    name,
                                    type: t(`profiles.editor.settingType.${setting.type}`),
                                    value: formatSettingValue(setting),
                                  })}
                                </li>
                              ))}
                            </ul>
                          </details>
                        )}
                        {managed.mode === 'replace' && settings.length === 0 ? (
                          <p
                            className="mt-2 flex items-start gap-2 text-xs font-medium text-[var(--danger)]"
                            role="alert"
                          >
                            <AlertTriangle
                              size={14}
                              className="mt-0.5 shrink-0"
                              aria-hidden="true"
                            />
                            {t('profiles.editor.deleteAllWarning')}
                          </p>
                        ) : null}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card className="p-5">
          <h2 className="text-base font-semibold text-[var(--text)]">
            {t('profiles.editor.settingsTitle')}
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-[var(--muted)]">
            {t('profiles.editor.settingsReadOnly')}
          </p>
          <p className="mt-3 text-sm font-medium text-[var(--text)]">
            {t('profiles.editor.settingsSummary', {
              count: settingCount,
              mods: modsWithSettings,
            })}
          </p>
          <details className="mt-2">
            <summary className="cursor-pointer text-xs font-medium text-[var(--accent)]">
              {t('profiles.editor.settingsExpand')}
            </summary>
            {settingCount === 0 ? (
              <p className="mt-2 text-xs text-[var(--muted)]">{t('profiles.editor.noSettings')}</p>
            ) : (
              <ul className="mt-2 space-y-1">
                {draft.mods.flatMap((mod) =>
                  summarizableSettings(mod.settings).map(([name, setting]) => (
                    <li key={`${mod.modId}:${name}`} className="text-xs text-[var(--muted)]">
                      {t('profiles.editor.settingLine', {
                        mod: mod.modId,
                        name,
                        type: t(`profiles.editor.settingType.${setting.type}`),
                        value: formatSettingValue(setting),
                      })}
                    </li>
                  )),
                )}
              </ul>
            )}
          </details>
        </Card>

        <Card className="p-5">
          <h2 className="text-base font-semibold text-[var(--text)]">
            {t('profiles.editor.actionsTitle')}
          </h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-3">
            <label className="block text-xs font-semibold text-[var(--muted)]">
              <span>{t('profiles.editor.rainmeterLabel')}</span>
              <select
                aria-label={t('profiles.editor.rainmeterLabel')}
                className={SELECT_CLASS}
                value={draft.rainmeter}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    rainmeter:
                      event.target.value === 'start'
                        ? 'start'
                        : event.target.value === 'stop'
                          ? 'stop'
                          : 'unchanged',
                  }))
                }
              >
                <option value="unchanged">{t('profiles.editor.rainmeter.unchanged')}</option>
                <option value="start">{t('profiles.editor.rainmeter.start')}</option>
                <option value="stop">{t('profiles.editor.rainmeter.stop')}</option>
              </select>
            </label>

            <label className="block text-xs font-semibold text-[var(--muted)]">
              <span>{t('profiles.editor.unlistedLabel')}</span>
              <select
                aria-label={t('profiles.editor.unlistedLabel')}
                className={SELECT_CLASS}
                value={draft.unlistedMods}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    unlistedMods: event.target.value === 'disable' ? 'disable' : 'leave',
                  }))
                }
              >
                <option value="leave">{t('profiles.editor.unlisted.leave')}</option>
                <option value="disable">{t('profiles.editor.unlisted.disable')}</option>
              </select>
            </label>

            <label className="block text-xs font-semibold text-[var(--muted)]">
              <span>{t('profiles.editor.explorerLabel')}</span>
              <select
                aria-label={t('profiles.editor.explorerLabel')}
                className={SELECT_CLASS}
                value={draft.restartExplorer}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    restartExplorer:
                      event.target.value === 'always'
                        ? 'always'
                        : event.target.value === 'never'
                          ? 'never'
                          : 'ask',
                  }))
                }
              >
                <option value="ask">{t('profiles.editor.explorer.ask')}</option>
                <option value="always">{t('profiles.editor.explorer.always')}</option>
                <option value="never">{t('profiles.editor.explorer.never')}</option>
              </select>
            </label>
          </div>
        </Card>

        <Card className="p-5">
          <div className="flex items-center gap-2">
            <Lock size={16} className="text-[var(--accent)]" aria-hidden="true" />
            <h2 className="text-base font-semibold text-[var(--text)]">
              {t('profiles.editor.targetingTitle')}
            </h2>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-[var(--muted)]">
            {t('profiles.editor.targetingBody')}
          </p>
        </Card>
      </form>
    </section>
  );
}
