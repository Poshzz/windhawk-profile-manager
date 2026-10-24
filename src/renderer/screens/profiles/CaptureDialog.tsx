import { useState, type FormEvent, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import type { Environment, Profile } from '@shared/domain';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Checkbox } from '../../components/ui/Checkbox';
import { Dialog } from '../../components/ui/Dialog';
import { ErrorState } from '../../components/ui/ErrorState';
import { errorMessage, formatCaptureDate } from './profile-utils';

export interface CaptureDialogProps {
  readonly open: boolean;
  readonly environment: Environment | null;
  readonly environmentError: string | null;
  readonly onClose: () => void;
  readonly onCaptured: (profile: Profile) => void;
  readonly onOpenProfile: (profile: Profile) => void;
}

export function CaptureDialog({
  open,
  environment,
  environmentError,
  onClose,
  onCaptured,
  onOpenProfile,
}: CaptureDialogProps): ReactElement {
  const { t } = useTranslation();
  const [name, setName] = useState(() =>
    t('profiles.capture.defaultName', { date: formatCaptureDate(new Date()) }),
  );
  const [includeDisabled, setIncludeDisabled] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Profile | null>(null);

  const installed = environment?.mods ?? [];
  const enabledCount = installed.filter((mod) => mod.enabled).length;
  const captured = includeDisabled ? installed : installed.filter((mod) => mod.enabled);
  const settingsCount = captured.reduce((total, mod) => total + mod.settingsCount, 0);
  const nameMissing = name.trim().length === 0;

  const handleCapture = async (): Promise<void> => {
    if (pending) return;
    if (nameMissing) {
      setError(t('profiles.capture.nameRequired'));
      return;
    }
    setPending(true);
    setError(null);
    try {
      const profile = await window.api.captureProfile({
        name: name.trim(),
        includeDisabled,
      });
      setCreated(profile);
      onCaptured(profile);
    } catch (captureError) {
      setError(errorMessage(captureError));
    } finally {
      setPending(false);
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void handleCapture();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next: boolean) => {
        if (!next && !pending) onClose();
      }}
      title={t('profiles.capture.title')}
      description={t('profiles.capture.description')}
      footer={
        created === null ? (
          <>
            <Button variant="secondary" onClick={onClose} disabled={pending}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" onClick={() => void handleCapture()} disabled={pending}>
              {pending ? t('profiles.capture.pending') : t('profiles.capture.submit')}
            </Button>
          </>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose}>
              {t('common.close')}
            </Button>
            <Button variant="primary" onClick={() => onOpenProfile(created)}>
              {t('profiles.capture.openProfile')}
            </Button>
          </>
        )
      }
    >
      {created === null ? (
        <form onSubmit={handleSubmit} className="space-y-4">
          <label className="block text-xs font-semibold text-[var(--muted)]">
            <span>{t('profiles.capture.name')}</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t('profiles.capture.namePlaceholder')}
              maxLength={100}
              required
              aria-invalid={nameMissing}
              className="mt-2 w-full rounded-xl border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
            />
          </label>
          {nameMissing ? (
            <p className="text-xs text-[var(--danger)]" role="alert">
              {t('profiles.capture.nameRequired')}
            </p>
          ) : null}

          <div className="rounded-xl border border-[var(--border)] bg-[var(--card-muted)] p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs font-semibold text-[var(--text)]">
                {t('profiles.capture.summaryTitle')}
              </p>
              <Badge tone={captured.length === 0 ? 'warning' : 'info'}>
                {t('profiles.capture.summaryIncluded', { count: captured.length })}
              </Badge>
            </div>
            <ul className="mt-2 space-y-1 text-xs text-[var(--muted)]">
              <li>{t('profiles.capture.summaryInstalled', { count: installed.length })}</li>
              <li>{t('profiles.capture.summaryEnabled', { count: enabledCount })}</li>
              <li>{t('profiles.capture.summarySettings', { count: settingsCount })}</li>
            </ul>
            <p className="mt-2 text-[11px] leading-relaxed text-[var(--faint)]">
              {t('profiles.capture.note')}
            </p>
          </div>

          <Checkbox
            checked={includeDisabled}
            onCheckedChange={(checked) => setIncludeDisabled(checked === true)}
            label={t('profiles.capture.includeDisabled')}
            description={t('profiles.capture.includeDisabledBody')}
          />

          {environment === null ? (
            <p className="text-xs text-[var(--warning)]" role="status">
              {t('profiles.capture.environmentUnavailable')}
              {environmentError === null ? null : ` ${environmentError}`}
            </p>
          ) : null}

          {error === null ? null : (
            <ErrorState
              title={t('profiles.capture.errorTitle')}
              description={error}
              className="py-4"
            />
          )}
        </form>
      ) : (
        <div className="space-y-3" role="status">
          <div className="rounded-xl border border-[color-mix(in_srgb,var(--success)_35%,transparent)] bg-[color-mix(in_srgb,var(--success)_8%,transparent)] p-4">
            <p className="text-sm font-semibold text-[var(--text)]">
              {t('profiles.capture.successTitle')}
            </p>
            <p className="mt-1 text-xs leading-relaxed text-[var(--muted)]">
              {t('profiles.capture.successBody', { name: created.name })}
            </p>
          </div>
          <p className="text-xs leading-relaxed text-[var(--faint)]">
            {t('profiles.capture.summaryIncluded', { count: captured.length })}
          </p>
        </div>
      )}
    </Dialog>
  );
}
