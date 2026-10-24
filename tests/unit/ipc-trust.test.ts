import { describe, expect, it } from 'vitest';
import { isAllowedExternalUrl, isTrustedRendererFrame, sameOrigin } from '../../src/main/ipc-trust';

describe('IPC trust', () => {
  it('accepts only the exact packaged file document', () => {
    const file =
      'file:///C:/Program%20Files/WindhawkProfileManager/resources/app.asar/out/renderer/index.html';
    expect(isTrustedRendererFrame(file, file, true, undefined)).toBe(true);
    expect(isTrustedRendererFrame('https://evil.example/', file, true, undefined)).toBe(false);
    expect(isTrustedRendererFrame(`${file}#hash`, file, true, undefined)).toBe(false);
  });

  it('accepts the development origin only in development', () => {
    const dev = 'http://localhost:5173';
    expect(isTrustedRendererFrame(`${dev}/`, `${dev}/`, false, dev)).toBe(true);
    expect(isTrustedRendererFrame('http://localhost:5173@evil.com/', dev, false, dev)).toBe(false);
    expect(isTrustedRendererFrame(`${dev}/`, `${dev}/`, true, dev)).toBe(false);
  });

  it('compares origins rather than prefixes', () => {
    expect(sameOrigin('http://localhost:5173@evil.com/', 'http://localhost:5173')).toBe(false);
    expect(sameOrigin('http://localhost:5173/path', 'http://localhost:5173/other')).toBe(true);
  });

  it('allows only the Windhawk HTTPS origins for external links', () => {
    expect(isAllowedExternalUrl('https://windhawk.net/mods/taskbar')).toBe(true);
    expect(isAllowedExternalUrl('https://www.windhawk.net/mods/taskbar')).toBe(true);
    expect(isAllowedExternalUrl('http://windhawk.net/')).toBe(false);
    expect(isAllowedExternalUrl('https://windhawk.net@evil.example/')).toBe(false);
    expect(isAllowedExternalUrl('https://evil.example/')).toBe(false);
    expect(isAllowedExternalUrl('javascript:alert(1)')).toBe(false);
  });
});
