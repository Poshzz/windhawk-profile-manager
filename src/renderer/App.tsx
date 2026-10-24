import { useEffect, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AppConfig,
  AppLocale,
  AppVersions,
  RecoveryInfo,
  ResolvedTheme,
  ThemeSource,
} from '@shared/ipc';
import type { AppState } from '@shared/domain';
import { Sidebar } from './components/Sidebar';
import { Titlebar } from './components/Titlebar';
import { Toast } from './components/ui/Toast';
import { detectLocale } from './i18n';
import { Gallery } from './screens/Gallery';
import { ApplyDialog } from './screens/apply/ApplyDialog';
import { FirstRun } from './screens/FirstRun';
import { Home } from './screens/Home';
import { Profiles } from './screens/Profiles';
import { RecoveryDialog } from './screens/RecoveryDialog';
import { Settings } from './screens/Settings';
import { Snapshots } from './screens/Snapshots';
import { ThemePacks } from './screens/ThemePacks';
import { Placeholder } from './screens/Placeholder';
import { useUiStore } from './state/ui-store';
import { applyTheme, systemPrefersDark } from './theme';

function useSystemTheme(config: AppConfig | null): ResolvedTheme {
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(() => {
    if (config !== null) return config.systemTheme;
    return systemPrefersDark() ? 'dark' : 'light';
  });

  useEffect(() => {
    if (config !== null) setSystemTheme(config.systemTheme);
  }, [config]);

  useEffect(() => window.api.onSystemThemeChange(setSystemTheme), []);

  return systemTheme;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface AppProps {
  /** Startup config already fetched by the bootstrap path. */
  readonly initialConfig?: AppConfig;
}

export function App({ initialConfig }: AppProps): ReactElement {
  const { t, i18n } = useTranslation();
  const screen = useUiStore((state) => state.screen);
  const locale = useUiStore((state) => state.locale);
  const theme = useUiStore((state) => state.theme);
  const setScreen = useUiStore((state) => state.setScreen);
  const setLocale = useUiStore((state) => state.setLocale);
  const setTheme = useUiStore((state) => state.setTheme);

  const [config, setConfig] = useState<AppConfig | null>(initialConfig ?? null);
  const [versions, setVersions] = useState<AppVersions | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [applyProfileId, setApplyProfileId] = useState<string | null>(null);
  const [appState, setAppState] = useState<AppState | null>(null);
  const [recovery, setRecovery] = useState<RecoveryInfo | null>(null);
  const systemTheme = useSystemTheme(config);
  const showGallery = import.meta.env.DEV;

  const systemLocale: AppLocale = config?.systemLocale ?? detectLocale();
  const effectiveLocale: AppLocale = locale ?? systemLocale;
  const visibleScreen = screen === 'gallery' && !showGallery ? 'home' : screen;

  useEffect(() => {
    let cancelled = false;

    if (initialConfig === undefined) {
      void window.api
        .getConfig()
        .then((value) => {
          if (!cancelled) setConfig(value);
        })
        .catch((error: unknown) => {
          if (!cancelled) setLoadError(errorMessage(error));
        });
    }

    void window.api
      .getVersions()
      .then((value) => {
        if (!cancelled) setVersions(value);
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(errorMessage(error));
      });

    return () => {
      cancelled = true;
    };
  }, [initialConfig]);

  useEffect(() => {
    let cancelled = false;
    void window.api
      .getState()
      .then((value) => {
        if (!cancelled) setAppState(value);
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(errorMessage(error));
      });
    void window.api
      .getRecovery()
      .then((value) => {
        if (!cancelled) setRecovery(value);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (appState === null) return;
    setLocale(appState.language === 'system' ? null : appState.language);
    setTheme(appState.appearance);
  }, [appState, setLocale, setTheme]);

  useEffect(() => {
    if (!showGallery && screen === 'gallery') {
      setScreen('home');
    }
  }, [screen, setScreen, showGallery]);

  useEffect(() => {
    document.documentElement.lang = effectiveLocale;
    void i18n.changeLanguage(effectiveLocale);
  }, [i18n, effectiveLocale]);

  useEffect(() => {
    document.title = t('app.name');
  }, [t, effectiveLocale]);

  useEffect(() => {
    applyTheme(theme, systemTheme === 'dark');
    void window.api.setThemeSource(theme).catch(() => undefined);
  }, [theme, systemTheme]);

  const handleThemeChange = (next: ThemeSource): void => {
    setTheme(next);
    void window.api
      .updateSettings({ appearance: next })
      .then(setAppState)
      .catch((error: unknown) => setLoadError(errorMessage(error)));
  };

  const handleLocaleChange = (next: AppLocale | null): void => {
    setLocale(next);
    void window.api
      .updateSettings({ language: next ?? 'system' })
      .then(setAppState)
      .catch((error: unknown) => setLoadError(errorMessage(error)));
  };

  const handlePreferencesChange = (next: AppState): void => {
    setAppState(next);
    setLocale(next.language === 'system' ? null : next.language);
    setTheme(next.appearance);
  };

  const handleFirstRunComplete = (
    next: AppState,
    destination: 'home' | 'profiles' | 'packs',
  ): void => {
    setAppState(next);
    setScreen(destination);
  };

  const handleRecoveryResolved = (): void => {
    setRecovery(null);
    void window.api
      .getState()
      .then(setAppState)
      .catch(() => undefined);
  };

  let content: ReactElement;
  if (appState !== null && !appState.firstRunCompleted) {
    content = <FirstRun onComplete={handleFirstRunComplete} />;
  } else if (visibleScreen === 'home') {
    content = <Home versions={versions} onNavigate={setScreen} onApply={setApplyProfileId} />;
  } else if (visibleScreen === 'profiles') {
    content = <Profiles onApply={setApplyProfileId} />;
  } else if (visibleScreen === 'snapshots') {
    content = <Snapshots onNavigate={setScreen} />;
  } else if (visibleScreen === 'packs') {
    content = <ThemePacks onApply={setApplyProfileId} />;
  } else if (visibleScreen === 'settings') {
    content = <Settings onPreferencesChange={handlePreferencesChange} onNavigate={setScreen} />;
  } else if (visibleScreen === 'gallery') {
    content = <Gallery />;
  } else {
    content = <Placeholder id={visibleScreen} />;
  }

  return (
    <div className="app-shell flex h-screen flex-col overflow-hidden">
      <Titlebar mode={config?.titlebarMode ?? 'overlay'} />
      <div className="flex min-h-0 flex-1">
        <Sidebar
          active={visibleScreen}
          onChange={setScreen}
          locale={effectiveLocale}
          onLocaleChange={handleLocaleChange}
          theme={theme}
          onThemeChange={handleThemeChange}
          backgroundMaterial={config?.backgroundMaterial ?? 'opaque'}
          titlebarMode={config?.titlebarMode ?? 'overlay'}
          showGallery={showGallery}
          {...(showGallery ? { onGallery: () => setScreen('gallery') } : {})}
        />
        <main className="min-w-0 flex-1 overflow-auto px-6 py-6">{content}</main>
      </div>

      <ApplyDialog
        profileId={applyProfileId}
        onClose={() => setApplyProfileId(null)}
        onNavigate={setScreen}
      />

      {recovery === null ? null : (
        <RecoveryDialog
          info={recovery}
          onResolved={handleRecoveryResolved}
          onClose={() => setRecovery(null)}
        />
      )}

      {loadError === null ? null : (
        <div className="pointer-events-none fixed right-5 top-[calc(var(--titlebar-height)+12px)] z-40 w-[min(420px,calc(100vw-40px))]">
          <div className="pointer-events-auto">
            <Toast
              tone="danger"
              title={t('shell.loadError')}
              description={loadError}
              onDismiss={() => setLoadError(null)}
            />
          </div>
        </div>
      )}
    </div>
  );
}
