import {
  History,
  House,
  Layers3,
  Palette,
  Settings2,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';
import { useId, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import type { AppLocale, BackgroundMaterial, ThemeSource, TitlebarMode } from '@shared/ipc';
import type { NavId, ScreenId } from '../state/ui-store';
import { Badge } from './ui/Badge';
import { Button } from './ui/Button';

const NAV_ITEMS: ReadonlyArray<{ id: NavId; labelKey: string; icon: LucideIcon }> = [
  { id: 'home', labelKey: 'nav.home', icon: House },
  { id: 'profiles', labelKey: 'nav.profiles', icon: Layers3 },
  { id: 'snapshots', labelKey: 'nav.snapshots', icon: History },
  { id: 'packs', labelKey: 'nav.packs', icon: Palette },
  { id: 'settings', labelKey: 'nav.settings', icon: Settings2 },
];

const THEMES: ReadonlyArray<{ value: ThemeSource; labelKey: string }> = [
  { value: 'system', labelKey: 'shell.themeSystem' },
  { value: 'light', labelKey: 'shell.themeLight' },
  { value: 'dark', labelKey: 'shell.themeDark' },
];

export interface SidebarProps {
  readonly active: ScreenId;
  readonly onChange: (id: NavId) => void;
  readonly locale: AppLocale;
  readonly onLocaleChange: (locale: AppLocale) => void;
  readonly theme: ThemeSource;
  readonly onThemeChange: (theme: ThemeSource) => void;
  readonly backgroundMaterial: BackgroundMaterial;
  readonly titlebarMode: TitlebarMode;
  readonly showGallery?: boolean;
  readonly onGallery?: () => void;
}

export function Sidebar({
  active,
  onChange,
  locale,
  onLocaleChange,
  theme,
  onThemeChange,
  backgroundMaterial,
  titlebarMode,
  showGallery = false,
  onGallery,
}: SidebarProps): ReactElement {
  const { t } = useTranslation();
  const themeId = useId();

  return (
    <aside className="sidebar flex w-52 shrink-0 flex-col px-3 py-5">
      <p className="px-3 pb-3 text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--faint)]">
        {t('nav.section')}
      </p>
      <nav aria-label={t('a11y.primaryNavigation')} className="flex flex-col gap-1">
        {NAV_ITEMS.map((item) => {
          const isActive = item.id === active;
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              className={`nav-item app-no-drag ${isActive ? 'nav-item-active' : ''}`}
              aria-current={isActive ? 'page' : undefined}
              onClick={() => onChange(item.id)}
            >
              <Icon size={15} strokeWidth={1.8} aria-hidden="true" />
              <span>{t(item.labelKey)}</span>
            </button>
          );
        })}
      </nav>

      {showGallery && onGallery !== undefined ? (
        <Button variant="ghost" size="sm" className="mt-3" onClick={onGallery}>
          <Sparkles size={14} aria-hidden="true" />
          {t('nav.gallery')}
        </Button>
      ) : null}

      <div className="mt-auto flex flex-col gap-3">
        <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--faint)]">
              {t('shell.status')}
            </p>
            <Badge tone="success">{t('shell.ready')}</Badge>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-[var(--muted)]">
            {t('shell.statusBody')}
          </p>
          <div className="mt-3 flex flex-wrap gap-1.5">
            <Badge tone="info">
              {titlebarMode === 'overlay' ? t('shell.titlebarOverlay') : t('shell.titlebarCustom')}
            </Badge>
            <Badge tone="neutral">
              {backgroundMaterial === 'opaque'
                ? t('shell.backgroundOpaque')
                : t('shell.backgroundMica')}
            </Badge>
          </div>
        </div>

        <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-3">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--faint)]">
            {t('shell.language')}
          </p>
          <div
            className="mt-2 grid grid-cols-2 gap-1"
            role="group"
            aria-label={t('a11y.languageButton')}
          >
            {(['en', 'th'] as const).map((candidate) => (
              <Button
                key={candidate}
                size="sm"
                variant={locale === candidate ? 'secondary' : 'ghost'}
                aria-pressed={locale === candidate}
                onClick={() => onLocaleChange(candidate)}
              >
                {candidate.toUpperCase()}
              </Button>
            ))}
          </div>
          <label
            htmlFor={themeId}
            className="mt-3 block text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--faint)]"
          >
            {t('shell.theme')}
          </label>
          <select
            id={themeId}
            className="theme-select mt-1.5"
            aria-label={t('a11y.themeSelect')}
            value={theme}
            onChange={(event) => onThemeChange(event.target.value as ThemeSource)}
          >
            {THEMES.map((candidate) => (
              <option key={candidate.value} value={candidate.value}>
                {t(candidate.labelKey)}
              </option>
            ))}
          </select>
        </div>
      </div>
    </aside>
  );
}
