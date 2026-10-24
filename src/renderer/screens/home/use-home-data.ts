import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppState, Drift, Environment, Profile, SnapshotMetadata } from '@shared/domain';

export interface Loadable<T> {
  readonly data: T | null;
  readonly loading: boolean;
  readonly error: string | null;
}

function loading<T>(data: T | null = null): Loadable<T> {
  return { data, loading: true, error: null };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function settledValue<T>(result: PromiseSettledResult<T>, previous: T | null): Loadable<T> {
  if (result.status === 'fulfilled') {
    return { data: result.value, loading: false, error: null };
  }
  return { data: previous, loading: false, error: errorMessage(result.reason) };
}

export interface HomeData {
  readonly environment: Loadable<Environment>;
  readonly profiles: Loadable<Profile[]>;
  readonly state: Loadable<AppState>;
  readonly snapshots: Loadable<SnapshotMetadata[]>;
  readonly drift: Loadable<Drift>;
  readonly actionError: string | null;
  readonly backupPending: boolean;
  readonly servicePending: boolean;
  refresh(): Promise<void>;
  refreshDrift(profileId: string | null): Promise<void>;
  startService(): Promise<void>;
  captureSnapshot(): Promise<SnapshotMetadata | null>;
  dismissActionError(): void;
}

export function useHomeData(): HomeData {
  const [environment, setEnvironment] = useState<Loadable<Environment>>(() => loading());
  const [profiles, setProfiles] = useState<Loadable<Profile[]>>(() => loading());
  const [state, setState] = useState<Loadable<AppState>>(() => loading());
  const [snapshots, setSnapshots] = useState<Loadable<SnapshotMetadata[]>>(() => loading());
  const [drift, setDrift] = useState<Loadable<Drift>>(() => loading());
  const [actionError, setActionError] = useState<string | null>(null);
  const [backupPending, setBackupPending] = useState(false);
  const [servicePending, setServicePending] = useState(false);
  const mounted = useRef(true);
  const refreshInFlight = useRef(false);
  const lastRefreshAt = useRef(0);

  useEffect(() => {
    return () => {
      mounted.current = false;
    };
  }, []);

  const refreshDrift = useCallback(async (profileId: string | null): Promise<void> => {
    if (profileId === null) {
      setDrift({ data: null, loading: false, error: null });
      return;
    }
    setDrift((current) => ({ ...current, loading: true, error: null }));
    try {
      const value = await window.api.getDrift(profileId);
      if (mounted.current) setDrift({ data: value, loading: false, error: null });
    } catch (error) {
      if (mounted.current) {
        setDrift((current) => ({
          data: current.data,
          loading: false,
          error: errorMessage(error),
        }));
      }
    }
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    lastRefreshAt.current = Date.now();
    setEnvironment((current) => ({ ...current, loading: true, error: null }));
    setProfiles((current) => ({ ...current, loading: true, error: null }));
    setState((current) => ({ ...current, loading: true, error: null }));
    setSnapshots((current) => ({ ...current, loading: true, error: null }));

    try {
      const results = await Promise.allSettled([
        window.api.getEnvironment(),
        window.api.listProfiles(),
        window.api.getState(),
        window.api.listSnapshots(),
      ]);
      if (!mounted.current) return;

      const [environmentResult, profilesResult, stateResult, snapshotsResult] = results;
      setEnvironment((current) => settledValue(environmentResult, current.data));
      setProfiles((current) => settledValue(profilesResult, current.data));
      setState((current) => settledValue(stateResult, current.data));
      setSnapshots((current) => settledValue(snapshotsResult, current.data));

      const activeProfileId =
        stateResult.status === 'fulfilled' ? stateResult.value.activeProfileId : null;
      await refreshDrift(activeProfileId);
    } finally {
      refreshInFlight.current = false;
    }
  }, [refreshDrift]);

  useEffect(() => {
    void refresh();
    const onFocus = (): void => {
      if (Date.now() - lastRefreshAt.current >= 10_000) void refresh();
    };
    const onApplied = (): void => {
      void refresh();
    };
    window.addEventListener('focus', onFocus);
    window.addEventListener('wpm:applied', onApplied);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('wpm:applied', onApplied);
    };
  }, [refresh]);

  const startService = useCallback(async (): Promise<void> => {
    setServicePending(true);
    setActionError(null);
    try {
      const value = await window.api.startService();
      if (mounted.current) setEnvironment({ data: value, loading: false, error: null });
    } catch (error) {
      if (mounted.current) setActionError(errorMessage(error));
    } finally {
      if (mounted.current) setServicePending(false);
    }
  }, []);

  const captureSnapshot = useCallback(async (): Promise<SnapshotMetadata | null> => {
    setBackupPending(true);
    setActionError(null);
    try {
      const profileId = state.data?.activeProfileId ?? null;
      const metadata = await window.api.captureSnapshot(profileId);
      if (mounted.current) {
        setSnapshots((current) => ({
          data: [
            metadata,
            ...(current.data ?? []).filter((snapshot) => snapshot.id !== metadata.id),
          ].slice(0, 50),
          loading: false,
          error: null,
        }));
      }
      return metadata;
    } catch (error) {
      if (mounted.current) setActionError(errorMessage(error));
      return null;
    } finally {
      if (mounted.current) setBackupPending(false);
    }
  }, [state.data?.activeProfileId]);

  return {
    environment,
    profiles,
    state,
    snapshots,
    drift,
    actionError,
    backupPending,
    servicePending,
    refresh,
    refreshDrift,
    startService,
    captureSnapshot,
    dismissActionError: () => setActionError(null),
  };
}
