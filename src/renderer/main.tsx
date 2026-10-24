import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import type { AppConfig } from '@shared/ipc';
import { App } from './App';
import { appI18n, detectLocale } from './i18n';
import { useUiStore } from './state/ui-store';
import { applyTheme, systemPrefersDark } from './theme';
import './styles.css';

async function bootstrap(): Promise<void> {
  let config: AppConfig | undefined;
  try {
    config = await window.api.getConfig();
  } catch {
    config = undefined;
  }

  const storedLocale = useUiStore.getState().locale;
  const locale = storedLocale ?? config?.systemLocale ?? detectLocale();
  await appI18n.changeLanguage(locale);
  document.documentElement.lang = locale;
  applyTheme(
    useUiStore.getState().theme,
    config === undefined ? systemPrefersDark() : config.systemTheme === 'dark',
  );

  const root = document.getElementById('root');
  if (root === null) {
    throw new Error('Renderer root element was not found');
  }

  createRoot(root).render(
    <StrictMode>
      <I18nextProvider i18n={appI18n}>
        <App {...(config === undefined ? {} : { initialConfig: config })} />
      </I18nextProvider>
    </StrictMode>,
  );
}

void bootstrap();
