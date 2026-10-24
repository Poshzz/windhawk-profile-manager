import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  defaultWindowState,
  fitWindowBounds,
  loadWindowState,
  parseWindowState,
  saveWindowState,
  type DisplayWorkArea,
} from '../../src/main/window-state';

const displays: DisplayWorkArea[] = [
  { x: 0, y: 0, width: 1920, height: 1040, primary: true },
  { x: 1920, y: 0, width: 2560, height: 1400, primary: false },
];

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('window state', () => {
  it('parses valid bounds and rejects corrupt values', () => {
    expect(parseWindowState({ width: 1120, height: 740, x: 20, y: 30, maximized: true })).toEqual({
      width: 1120,
      height: 740,
      x: 20,
      y: 30,
      maximized: true,
    });
    expect(parseWindowState({ width: 0, height: 740 })).toBeNull();
    expect(parseWindowState({ width: '1120', height: 740 })).toBeNull();
    expect(parseWindowState(null)).toBeNull();
  });

  it('keeps an on-screen position and clamps to the minimum size', () => {
    expect(
      fitWindowBounds(
        { width: 500, height: 400, x: 2000, y: 100, maximized: false },
        displays,
        900,
        600,
      ),
    ).toEqual({ width: 900, height: 600, x: 2000, y: 100 });
  });

  it('centers saved bounds when the monitor is gone', () => {
    expect(
      fitWindowBounds(
        { width: 1120, height: 740, x: 9000, y: 9000, maximized: false },
        displays,
        900,
        600,
      ),
    ).toEqual({ width: 1120, height: 740, x: 400, y: 150 });
  });

  it('uses the default size when the state file is missing or corrupt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wpm-window-'));
    roots.push(root);
    const path = join(root, 'window-state.json');

    expect(loadWindowState(path)).toEqual(defaultWindowState());
    await writeFile(path, 'not-json', 'utf8');
    expect(loadWindowState(path)).toEqual(defaultWindowState());
  });

  it('round-trips a saved state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wpm-window-'));
    roots.push(root);
    const path = join(root, 'window-state.json');
    const state = { width: 1200, height: 800, x: 10, y: 20, maximized: false };

    saveWindowState(path, state);
    expect(loadWindowState(path)).toEqual(state);
  });
});
