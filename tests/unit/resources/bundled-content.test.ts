import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadBundledContent } from '@infra/resources/bundled-content';
import { ValidationError } from '@shared/errors';

const resources = resolve(process.cwd(), 'resources');

describe('bundled content', () => {
  it('loads both built-in profiles and the Mac Blur Glass pack', async () => {
    const content = await loadBundledContent(resources);

    expect(content.profiles.map((profile) => profile.id)).toEqual([
      'default-windows',
      'mac-blur-glass',
    ]);
    expect(content.profiles.every((profile) => profile.source === 'builtin')).toBe(true);
    expect(content.themePacks.map((pack) => pack.id)).toEqual(['mac-blur-glass']);
    expect(content.themePacks[0]?.profiles).toEqual(['mac-blur-glass', 'default-windows']);
  });

  it('rejects a missing resources directory', async () => {
    await expect(loadBundledContent(resolve(resources, 'missing'))).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});
