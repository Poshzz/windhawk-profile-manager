import type { AppLocale } from '@shared/ipc';
import en from './locales/en.json';
import th from './locales/th.json';

export const SUPPORTED_LOCALES = ['en', 'th'] as const satisfies readonly AppLocale[];
export const FALLBACK_LOCALE: AppLocale = 'en';

export type TranslationKey = string;

export const resources = {
  en: { translation: en },
  // Static imports make a missing language file a build failure instead of a
  // silent runtime fallback.
  th: { translation: th },
} as const;
