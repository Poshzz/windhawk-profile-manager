import type { BrowserWindowConstructorOptions } from 'electron';
import { TITLEBAR_HEIGHT } from '@shared/constants';
import type { AppLocale, TitlebarMode } from '@shared/ipc';

export function resolveAppLocale(tag: string | undefined): AppLocale {
  return tag?.toLowerCase().startsWith('th') === true ? 'th' : 'en';
}

export function resolveTitlebarMode(value: string | undefined): TitlebarMode {
  return value === 'custom' ? 'custom' : 'overlay';
}

export function parseWindowsBuild(release: string): number {
  const build = Number(release.split('.')[2]);
  return Number.isSafeInteger(build) && build > 0 ? build : 0;
}

export function supportsMica(
  release: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === 'win32' && parseWindowsBuild(release) >= 22621;
}

export function titlebarOptions(
  mode: TitlebarMode,
  symbolColor = '#e8e8ed',
): Pick<BrowserWindowConstructorOptions, 'titleBarStyle' | 'titleBarOverlay' | 'frame'> {
  if (mode === 'custom') {
    return { frame: false };
  }

  return {
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#00000000',
      symbolColor,
      height: TITLEBAR_HEIGHT,
    },
  };
}
