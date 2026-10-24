import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_WINDOW_HEIGHT, DEFAULT_WINDOW_WIDTH } from '@shared/constants';

export interface WindowState {
  readonly width: number;
  readonly height: number;
  readonly x?: number;
  readonly y?: number;
  readonly maximized: boolean;
}

export interface DisplayWorkArea {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly primary: boolean;
}

export function defaultWindowState(): WindowState {
  return {
    width: DEFAULT_WINDOW_WIDTH,
    height: DEFAULT_WINDOW_HEIGHT,
    maximized: false,
  };
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

export function parseWindowState(value: unknown): WindowState | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (
    !isInteger(candidate['width']) ||
    !isInteger(candidate['height']) ||
    candidate['width'] <= 0 ||
    candidate['height'] <= 0
  ) {
    return null;
  }

  const x = candidate['x'];
  const y = candidate['y'];
  return {
    width: candidate['width'],
    height: candidate['height'],
    ...(isInteger(x) ? { x } : {}),
    ...(isInteger(y) ? { y } : {}),
    maximized: candidate['maximized'] === true,
  };
}

function overlapsDisplay(state: WindowState, display: DisplayWorkArea): boolean {
  if (state.x === undefined || state.y === undefined) return false;
  const right = state.x + state.width;
  const bottom = state.y + state.height;
  return (
    state.x < display.x + display.width &&
    right > display.x &&
    state.y < display.y + display.height &&
    bottom > display.y
  );
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

/**
 * Fits saved bounds to the currently connected displays. Off-screen or
 * unplugged-monitor positions are centered on the primary work area.
 */
export function fitWindowBounds(
  state: WindowState,
  displays: readonly DisplayWorkArea[],
  minimumWidth: number,
  minimumHeight: number,
): { width: number; height: number; x?: number; y?: number } {
  if (displays.length === 0) {
    return { width: state.width, height: state.height };
  }

  const primary = displays.find((display) => display.primary) ?? displays[0]!;
  const maxWidth = Math.max(...displays.map((display) => display.width));
  const maxHeight = Math.max(...displays.map((display) => display.height));
  const width = clamp(state.width, minimumWidth, Math.max(minimumWidth, maxWidth));
  const height = clamp(state.height, minimumHeight, Math.max(minimumHeight, maxHeight));

  if (
    state.x !== undefined &&
    state.y !== undefined &&
    displays.some((d) => overlapsDisplay(state, d))
  ) {
    return { width, height, x: state.x, y: state.y };
  }

  return {
    width,
    height,
    x: Math.round(primary.x + (primary.width - width) / 2),
    y: Math.round(primary.y + (primary.height - height) / 2),
  };
}

export function loadWindowState(path: string): WindowState {
  try {
    const text = readFileSync(path, 'utf8');
    return parseWindowState(JSON.parse(text)) ?? defaultWindowState();
  } catch {
    return defaultWindowState();
  }
}

export function saveWindowState(path: string, state: WindowState): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(state)}\n`, 'utf8');
    renameSync(temporary, path);
  } catch {
    // Window geometry is a convenience; failing to persist it must never block quit.
  }
}
