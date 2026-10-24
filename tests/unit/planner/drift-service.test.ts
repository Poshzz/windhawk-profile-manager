import { describe, expect, it } from 'vitest';
import { DriftService } from '@core/planner/drift-service';
import { dword, makeProfile, makeSnapshot, managedMod, modKeys, stringValue } from './support';

const TASKBAR_MOD = 'windows-11-taskbar-styler';
const CHECKED_AT = new Date('2026-10-22T20:00:00.000Z');

function service(): DriftService {
  return new DriftService({ now: () => CHECKED_AT });
}

function matchingTaskbarKeys(): ReturnType<typeof modKeys> {
  return modKeys(TASKBAR_MOD, {
    settings: { TaskbarHeight: dword(48), Theme: stringValue('macOS') },
  });
}

describe('DriftService', () => {
  it('reports a match when the managed mod matches the profile', () => {
    const profile = makeProfile();
    const drift = service().compare(profile, makeSnapshot(matchingTaskbarKeys()));

    expect(drift.status).toBe('matches');
    expect(drift.entries).toEqual([]);
    expect(drift.checkedAt).toBe(CHECKED_AT.toISOString());
    expect(drift.profileId).toBe(profile.id);
  });

  it('reports an enabled-state difference', () => {
    const current = makeSnapshot(
      modKeys(TASKBAR_MOD, {
        enabled: false,
        settings: { TaskbarHeight: dword(48), Theme: stringValue('macOS') },
      }),
    );
    const drift = service().compare(makeProfile(), current);

    expect(drift.status).toBe('different');
    expect(drift.entries).toHaveLength(1);
    expect(drift.entries[0]).toMatchObject({
      modId: TASKBAR_MOD,
      kind: 'enabled-state',
      current: 'disabled',
      desired: 'enabled',
    });
  });

  it('reports a settings difference for a managed setting', () => {
    const current = makeSnapshot(
      modKeys(TASKBAR_MOD, {
        settings: { TaskbarHeight: dword(40), Theme: stringValue('macOS') },
      }),
    );
    const drift = service().compare(makeProfile(), current);
    const entry = drift.entries.find((candidate) => candidate.kind === 'settings');

    expect(drift.status).toBe('different');
    expect(entry).toMatchObject({
      modId: TASKBAR_MOD,
      current: 'dword:40',
      desired: 'dword:48',
    });
  });

  it('reports extra replace settings and ignores extra merge settings', () => {
    const current = makeSnapshot(
      modKeys(TASKBAR_MOD, {
        settings: {
          TaskbarHeight: dword(48),
          Theme: stringValue('macOS'),
          LegacyTheme: stringValue('old'),
        },
      }),
    );

    const replaceDrift = service().compare(makeProfile(), current);
    const replaceEntry = replaceDrift.entries.find(
      (candidate) => candidate.kind === 'settings' && candidate.desired === null,
    );
    expect(replaceEntry?.current).toBe('string:"old"');

    const mergeDrift = service().compare(
      makeProfile({
        requiredMods: [
          managedMod({
            modId: TASKBAR_MOD,
            mode: 'merge',
            settings: { TaskbarHeight: dword(48), Theme: stringValue('macOS') },
          }),
        ],
      }),
      current,
    );
    expect(mergeDrift.status).toBe('matches');
  });

  it('ignores unlisted mods, targeting values, and volatile values', () => {
    const current = makeSnapshot([
      ...modKeys(TASKBAR_MOD, {
        settings: {
          TaskbarHeight: dword(48),
          Theme: stringValue('macOS'),
          Include: stringValue('volatile'),
          SettingsChangeTime: dword(99),
        },
        extraRootValues: {
          Include: stringValue('%SystemRoot%\\explorer.exe'),
          SettingsChangeTime: dword(1),
        },
      }),
      ...modKeys('misc-mod', { enabled: false }),
    ]);

    const drift = service().compare(makeProfile(), current);

    expect(drift.status).toBe('matches');
    expect(drift.entries).toEqual([]);
  });

  it('reports a missing managed mod as a difference', () => {
    const drift = service().compare(
      makeProfile({ requiredMods: [managedMod({ modId: 'missing-mod' })] }),
      makeSnapshot(modKeys('other-mod')),
    );

    expect(drift.status).toBe('different');
    expect(drift.entries[0]).toMatchObject({ modId: 'missing-mod', kind: 'missing' });
  });

  it('returns unknown when the current registry state is unavailable', () => {
    const drift = service().compare(makeProfile(), null);

    expect(drift.status).toBe('unknown');
    expect(drift.entries).toEqual([]);
    expect(drift.reason).toBeTruthy();
  });

  it('supports the static compare entry point with an injected clock', () => {
    const drift = DriftService.compare(makeProfile(), makeSnapshot(matchingTaskbarKeys()), {
      now: () => CHECKED_AT,
    });

    expect(drift.status).toBe('matches');
    expect(drift.checkedAt).toBe(CHECKED_AT.toISOString());
  });
});
