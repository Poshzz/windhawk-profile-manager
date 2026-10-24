import { create } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';
import type { AppLocale, ThemeSource } from '@shared/ipc';

export type NavId = 'home' | 'profiles' | 'snapshots' | 'packs' | 'settings';
export type ScreenId = NavId | 'gallery';

export interface UiState {
  readonly screen: ScreenId;
  /** null means follow the Windows display language. */
  readonly locale: AppLocale | null;
  readonly theme: ThemeSource;
  setScreen(screen: ScreenId): void;
  setLocale(locale: AppLocale | null): void;
  setTheme(theme: ThemeSource): void;
}

const initialState = {
  screen: 'home' as ScreenId,
  locale: null,
  theme: 'system' as ThemeSource,
};

export function effectiveTheme(preference: ThemeSource, prefersDark: boolean): 'light' | 'dark' {
  if (preference === 'system') return prefersDark ? 'dark' : 'light';
  return preference;
}

const memoryStorage: StateStorage = {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
};

const storage = createJSONStorage(() =>
  typeof localStorage === 'undefined' ? memoryStorage : localStorage,
);

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      ...initialState,
      setScreen: (screen) => set({ screen }),
      setLocale: (locale) => set({ locale }),
      setTheme: (theme) => set({ theme }),
    }),
    {
      name: 'wpm.ui.v1',
      version: 1,
      storage,
      partialize: (state) => ({
        screen: state.screen,
        locale: state.locale,
        theme: state.theme,
      }),
    },
  ),
);

export function resetUiStoreForTests(): void {
  // Merge instead of replace so the action functions survive a reset.
  useUiStore.setState(initialState);
}
