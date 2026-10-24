import { describe, expect, it } from 'vitest';
import { requiresThemePackReadiness } from '../../../src/main/home-service';

describe('theme-pack readiness policy', () => {
  const packs = [{ profiles: ['mac-blur-glass', 'default-windows'] }];

  it('requires every mod for a bundled theme-pack profile', () => {
    expect(requiresThemePackReadiness({ id: 'mac-blur-glass', source: 'builtin' }, packs)).toBe(
      true,
    );
  });

  it('leaves Default Windows resets, user profiles, and imported profiles alone', () => {
    expect(requiresThemePackReadiness({ id: 'default-windows', source: 'builtin' }, packs)).toBe(
      false,
    );
    expect(requiresThemePackReadiness({ id: 'mac-blur-glass', source: 'user' }, packs)).toBe(false);
    expect(requiresThemePackReadiness({ id: 'mac-blur-glass', source: 'imported' }, packs)).toBe(
      false,
    );
    expect(requiresThemePackReadiness({ id: 'other-profile', source: 'builtin' }, packs)).toBe(
      false,
    );
  });
});
