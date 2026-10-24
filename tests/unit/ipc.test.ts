import { describe, expect, it } from 'vitest';
import { IPC, createPingResult } from '@shared/ipc';
import type { IpcEventContract, IpcRequest } from '@shared/ipc';

describe('shared IPC contract', () => {
  it('uses stable channel names', () => {
    expect(IPC.ping).toBe('app:ping');
    expect(IPC.versions).toBe('app:get-versions');
    expect(IPC.config).toBe('app:get-config');
    expect(IPC.windowMaximizedChanged).toBe('window:maximized-changed');
  });

  it('exposes typed domain channels', () => {
    expect(IPC.profilesList).toBe('profiles:list');
    expect(IPC.profilesGet).toBe('profiles:get');
    expect(IPC.snapshotsCapture).toBe('snapshots:capture');
    expect(IPC.planApply).toBe('plan:apply');
    expect(IPC.runApply).toBe('run:apply');
    expect(IPC.stateGet).toBe('state:get');
    expect(IPC.themePacksGet).toBe('theme-packs:get');
  });

  it('types request payloads and window events', () => {
    const request = { id: 'mac-blur-glass' } satisfies IpcRequest<typeof IPC.profilesGet>;
    const maximized: IpcEventContract[typeof IPC.windowMaximizedChanged] = true;

    expect(request.id).toBe('mac-blur-glass');
    expect(maximized).toBe(true);
  });

  it('creates a typed pong response', () => {
    const now = new Date('2026-10-22T12:34:56.000Z');
    expect(createPingResult(now)).toEqual({
      ok: true,
      message: 'pong',
      at: '2026-10-22T12:34:56.000Z',
    });
  });
});
