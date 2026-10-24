import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '../components/ui/EmptyState';
import { Card } from '../components/ui/Card';
import type { NavId } from '../state/ui-store';

type PlaceholderId = Exclude<NavId, 'home'>;

const SCREEN_KEYS = {
  profiles: {
    ticket: 'screens.profiles.ticket',
    title: 'screens.profiles.title',
    body: 'screens.profiles.body',
    empty: 'screens.profiles.empty',
  },
  snapshots: {
    ticket: 'screens.snapshots.ticket',
    title: 'screens.snapshots.title',
    body: 'screens.snapshots.body',
    empty: 'screens.snapshots.empty',
  },
  packs: {
    ticket: 'screens.packs.ticket',
    title: 'screens.packs.title',
    body: 'screens.packs.body',
    empty: 'screens.packs.empty',
  },
  settings: {
    ticket: 'screens.settings.ticket',
    title: 'screens.settings.title',
    body: 'screens.settings.body',
    empty: 'screens.settings.empty',
  },
} as const;

export function Placeholder({ id }: { id: PlaceholderId }): ReactElement {
  const { t } = useTranslation();
  const keys = SCREEN_KEYS[id];
  return (
    <section className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <Card className="p-8">
        <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--accent)]">
          {t(keys.ticket)}
        </p>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight text-[var(--text)]">
          {t(keys.title)}
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-[var(--muted)]">{t(keys.body)}</p>
      </Card>
      <EmptyState title={t(keys.title)} description={t(keys.empty)} />
    </section>
  );
}
