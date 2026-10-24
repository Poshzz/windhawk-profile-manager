import { useEffect, useState, type ReactElement, type SyntheticEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { TITLEBAR_HEIGHT } from '@shared/constants';
import type { TitlebarMode } from '@shared/ipc';

function TrafficLights(): ReactElement {
  const { t } = useTranslation();
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    return window.api.windowControls.onMaximizedChange(setIsMaximized);
  }, []);

  const stopDoubleClick = (event: SyntheticEvent): void => {
    event.stopPropagation();
  };

  return (
    <div className="app-no-drag ml-4 flex items-center gap-2" onDoubleClick={stopDoubleClick}>
      <button
        type="button"
        className="traffic-light traffic-light-close"
        aria-label={t('a11y.closeWindow')}
        title={t('a11y.closeWindow')}
        onClick={() => window.api.windowControls.close()}
      >
        <span aria-hidden="true">×</span>
      </button>
      <button
        type="button"
        className="traffic-light traffic-light-minimize"
        aria-label={t('a11y.minimizeWindow')}
        title={t('a11y.minimizeWindow')}
        onClick={() => window.api.windowControls.minimize()}
      >
        <span aria-hidden="true">−</span>
      </button>
      <button
        type="button"
        className="traffic-light traffic-light-maximize"
        aria-label={isMaximized ? t('a11y.restoreWindow') : t('a11y.maximizeWindow')}
        title={isMaximized ? t('a11y.restoreWindow') : t('a11y.maximizeWindow')}
        onClick={() => window.api.windowControls.toggleMaximize()}
      >
        <span aria-hidden="true">{isMaximized ? '−' : '+'}</span>
      </button>
    </div>
  );
}

export function Titlebar({ mode }: { mode: TitlebarMode }): ReactElement {
  const { t } = useTranslation();
  const productName = t('app.name');

  return (
    <header
      className="titlebar app-drag"
      style={{ height: TITLEBAR_HEIGHT }}
      onDoubleClick={() => window.api.windowControls.toggleMaximize()}
    >
      {mode === 'custom' ? <TrafficLights /> : null}
      <div
        className={`flex min-w-0 flex-1 items-center gap-3 ${
          mode === 'custom' ? 'justify-center px-4' : 'px-5'
        }`}
      >
        <span className="brand-dot" aria-hidden="true" />
        <span className="truncate text-xs font-medium tracking-wide text-[var(--muted)]">
          {productName}
        </span>
      </div>
      {mode === 'overlay' ? (
        <div className="titlebar-native-spacer" aria-hidden="true" />
      ) : (
        <div className="w-[52px]" aria-hidden="true" />
      )}
    </header>
  );
}
