import { useState, type ReactElement, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { AppLocale } from '@shared/ipc';
import { formatDateTime } from '../i18n/format';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Dialog,
  EmptyState,
  ErrorState,
  Progress,
  Switch,
  Toast,
  Tooltip,
} from '../components/ui';

function Section({ title, children }: { title: string; children: ReactNode }): ReactElement {
  return (
    <Card className="p-5">
      <h2 className="text-sm font-semibold text-[var(--text)]">{title}</h2>
      <div className="mt-4 flex flex-wrap items-center gap-2">{children}</div>
    </Card>
  );
}

export function Gallery(): ReactElement {
  const { t, i18n } = useTranslation();
  const locale: AppLocale = i18n.language === 'th' ? 'th' : 'en';
  const [dialogOpen, setDialogOpen] = useState(false);
  const [switched, setSwitched] = useState(true);
  const [checked, setChecked] = useState(false);
  const date = formatDateTime('2026-01-02T03:04:00.000Z', locale, 'UTC');

  return (
    <section className="mx-auto flex w-full max-w-4xl flex-col gap-4">
      <div className="px-1">
        <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--accent)]">
          {t('gallery.eyebrow')}
        </p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-[var(--text)]">
          {t('gallery.title')}
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-[var(--muted)]">{t('gallery.body')}</p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Section title={t('gallery.buttons')}>
          <Button variant="primary">{t('gallery.primary')}</Button>
          <Button variant="secondary">{t('gallery.secondary')}</Button>
          <Button variant="ghost">{t('gallery.ghost')}</Button>
          <Button variant="danger">{t('gallery.danger')}</Button>
        </Section>

        <Section title={t('gallery.dialog')}>
          <Button variant="secondary" onClick={() => setDialogOpen(true)}>
            {t('gallery.openDialog')}
          </Button>
          <Dialog
            open={dialogOpen}
            onOpenChange={setDialogOpen}
            title={t('gallery.dialogTitle')}
            description={t('gallery.dialogBody')}
            footer={
              <>
                <Button variant="ghost" onClick={() => setDialogOpen(false)}>
                  {t('common.cancel')}
                </Button>
                <Button variant="primary" onClick={() => setDialogOpen(false)}>
                  {t('gallery.confirm')}
                </Button>
              </>
            }
          />
        </Section>

        <Section title={t('gallery.switch')}>
          <Switch
            checked={switched}
            onCheckedChange={setSwitched}
            label={t('gallery.switchLabel')}
            description={t('gallery.switchDescription')}
          />
        </Section>

        <Section title={t('gallery.checkbox')}>
          <Checkbox
            checked={checked}
            onCheckedChange={(value) => setChecked(value === true)}
            label={t('gallery.checkboxLabel')}
          />
        </Section>

        <Section title={t('gallery.badge')}>
          <Badge tone="info">{t('gallery.badgeInfo')}</Badge>
          <Badge tone="success">{t('gallery.badgeSuccess')}</Badge>
          <Badge tone="warning">{t('gallery.badgeWarning')}</Badge>
          <Badge tone="danger">{t('gallery.badgeDanger')}</Badge>
        </Section>

        <Section title={t('gallery.progress')}>
          <Progress value={64} label={t('gallery.progressLabel')} showValue />
        </Section>

        <Section title={t('gallery.toast')}>
          <Toast
            tone="success"
            title={t('gallery.toastTitle')}
            description={t('gallery.toastBody')}
          />
        </Section>

        <Section title={t('gallery.tooltip')}>
          <Tooltip content={t('gallery.tooltipContent')}>
            <Button variant="secondary">{t('gallery.tooltipLabel')}</Button>
          </Tooltip>
        </Section>

        <Section title={t('gallery.dateLabel')}>
          <span className="text-sm text-[var(--muted)]">{t('gallery.dateValue', { date })}</span>
        </Section>

        <Section title={t('gallery.emptyTitle')}>
          <EmptyState
            title={t('gallery.emptyTitle')}
            description={t('gallery.emptyBody')}
            action={<Button variant="secondary">{t('gallery.primary')}</Button>}
          />
        </Section>

        <Section title={t('gallery.errorTitle')}>
          <ErrorState
            title={t('gallery.errorTitle')}
            description={t('gallery.errorBody')}
            action={<Button variant="secondary">{t('gallery.retry')}</Button>}
          />
        </Section>
      </div>
    </section>
  );
}
