import { beforeEach, describe, expect, it } from 'vitest';
import {
  effectiveTheme,
  resetUiStoreForTests,
  useUiStore,
} from '../../../src/renderer/state/ui-store';

describe('UI store', () => {
  beforeEach(() => {
    resetUiStoreForTests();
  });

  it('starts on home with system locale and theme', () => {
    expect(useUiStore.getState()).toMatchObject({
      screen: 'home',
      locale: null,
      theme: 'system',
    });
  });

  it('changes screens, locale, and theme through actions', () => {
    useUiStore.getState().setScreen('snapshots');
    useUiStore.getState().setLocale('th');
    useUiStore.getState().setTheme('dark');

    expect(useUiStore.getState()).toMatchObject({
      screen: 'snapshots',
      locale: 'th',
      theme: 'dark',
    });
  });

  it('resolves system themes and keeps explicit themes', () => {
    expect(effectiveTheme('system', true)).toBe('dark');
    expect(effectiveTheme('system', false)).toBe('light');
    expect(effectiveTheme('light', true)).toBe('light');
    expect(effectiveTheme('dark', false)).toBe('dark');
  });
});
