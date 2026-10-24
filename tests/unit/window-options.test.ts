import { describe, expect, it } from 'vitest';
import {
  parseWindowsBuild,
  resolveAppLocale,
  resolveTitlebarMode,
  supportsMica,
  titlebarOptions,
} from '../../src/main/window-options';

describe('window options', () => {
  it('defaults to the native overlay and accepts an explicit custom mode', () => {
    expect(resolveTitlebarMode(undefined)).toBe('overlay');
    expect(resolveTitlebarMode('overlay')).toBe('overlay');
    expect(resolveTitlebarMode('custom')).toBe('custom');
    expect(resolveTitlebarMode('unexpected')).toBe('overlay');
  });

  it('maps Thai system tags to Thai and everything else to English', () => {
    expect(resolveAppLocale('th-TH')).toBe('th');
    expect(resolveAppLocale('TH')).toBe('th');
    expect(resolveAppLocale('en-US')).toBe('en');
    expect(resolveAppLocale(undefined)).toBe('en');
  });

  it('parses the Windows build from a release string', () => {
    expect(parseWindowsBuild('10.0.22631')).toBe(22631);
    expect(parseWindowsBuild('10.0.22000')).toBe(22000);
    expect(parseWindowsBuild('not-a-version')).toBe(0);
  });

  it('enables Mica only on Windows 11 22H2 or newer', () => {
    expect(supportsMica('10.0.22631', 'win32')).toBe(true);
    expect(supportsMica('10.0.22621', 'win32')).toBe(true);
    expect(supportsMica('10.0.22000', 'win32')).toBe(false);
    expect(supportsMica('10.0.22631', 'darwin')).toBe(false);
  });

  it('builds the overlay titlebar options with matching height and symbols', () => {
    const options = titlebarOptions('overlay', '#171b24');
    expect(options.titleBarStyle).toBe('hidden');
    expect(options.titleBarOverlay).toMatchObject({ height: 48, symbolColor: '#171b24' });
    expect(options.frame).toBeUndefined();
  });

  it('removes the native frame in custom mode', () => {
    const options = titlebarOptions('custom');
    expect(options.frame).toBe(false);
    expect(options.titleBarStyle).toBeUndefined();
    expect(options.titleBarOverlay).toBeUndefined();
  });
});
