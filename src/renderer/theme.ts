import type { ThemeSource } from '@shared/ipc';
import { effectiveTheme } from './state/ui-store';

export function applyTheme(preference: ThemeSource, prefersDark: boolean): 'light' | 'dark' {
  const resolved = effectiveTheme(preference, prefersDark);
  document.documentElement.dataset['theme'] = resolved;
  document.documentElement.style.colorScheme = resolved;
  return resolved;
}

export function systemPrefersDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}
