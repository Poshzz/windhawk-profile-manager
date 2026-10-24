import { createInstance, type i18n as I18n } from 'i18next';
import { initReactI18next } from 'react-i18next';
import type { AppLocale } from '@shared/ipc';
import { FALLBACK_LOCALE, SUPPORTED_LOCALES, resources } from './resources';

export function detectLocale(languages?: readonly string[]): AppLocale {
  const candidates =
    languages ?? (typeof navigator === 'undefined' ? [] : (navigator.languages ?? []));
  return candidates.some((tag) => tag.toLowerCase().split(/[-_]/)[0] === 'th') ? 'th' : 'en';
}

export function createI18n(locale: AppLocale): I18n {
  const instance = createInstance();
  void instance.use(initReactI18next).init({
    resources,
    lng: locale,
    fallbackLng: FALLBACK_LOCALE,
    supportedLngs: [...SUPPORTED_LOCALES],
    interpolation: { escapeValue: false },
    initAsync: false,
    returnNull: false,
  });
  return instance;
}

export const appI18n = createI18n(detectLocale());
