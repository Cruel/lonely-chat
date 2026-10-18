import { useEffect, useRef, useState } from 'react';
import type {
  InferenceMode,
  SessionPreferences,
  SessionSnapshot,
  SimulationInputOptions,
} from '../shared/session-contract';
import { DEFAULT_PREFERENCES } from '../shared/session-contract';

const INITIAL_STATUS: SessionSnapshot = {
  revision: 0,
  phase: 'stopped',
  error: null,
  warning: null,
  cycle: 0,
  retryAttempt: 0,
  latestInferenceMs: null,
  smoothedInferenceMs: null,
  playbackWindowMs: DEFAULT_PREFERENCES.cycleIntervalMs,
  droppedObservations: 0,
  pendingMessages: 0,
  mode: 'fake',
  events: [],
};

export function useSession() {
  const [status, setStatus] = useState<SessionSnapshot>(INITIAL_STATUS);
  const latest = useRef(INITIAL_STATUS);
  const [preferences, setPreferences] = useState<SessionPreferences>(DEFAULT_PREFERENCES);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const accept = (next: SessionSnapshot) => {
      if (!active || next.revision < latest.current.revision) return;
      latest.current = next;
      setStatus(next);
    };
    const unsubscribe = window.lonelyChat?.onSessionChange(accept);
    void Promise.all([window.lonelyChat?.getSessionSnapshot(), window.lonelyChat?.getPreferences()])
      .then(([nextStatus, prefs]) => {
        if (!active) return;
        if (nextStatus) accept(nextStatus);
        if (prefs) setPreferences(prefs);
        setReady(true);
      })
      .catch((error: unknown) => {
        if (active)
          setActionError(error instanceof Error ? error.message : 'Unable to connect to session.');
      });
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, []);

  const perform = async (action: () => Promise<SessionSnapshot>) => {
    setBusy(true);
    setActionError(null);
    try {
      const next = await action();
      if (next.revision >= latest.current.revision) {
        latest.current = next;
        setStatus(next);
      }
      return true;
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Unable to update session.');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const updatePreferences = async (next: SessionPreferences) => {
    setBusy(true);
    setActionError(null);
    try {
      const result = await window.lonelyChat!.setPreferences(next);
      setPreferences(result);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Unable to save preferences.');
    } finally {
      setBusy(false);
    }
  };

  return {
    status,
    preferences,
    ready,
    busy,
    actionError,
    start: (context: string, mode: InferenceMode = 'fake', options?: SimulationInputOptions) =>
      perform(() => window.lonelyChat!.startSession(context, mode, options)),
    stop: () => perform(() => window.lonelyChat!.stopSession()),
    retry: () => perform(() => window.lonelyChat!.retrySession()),
    updatePreferences,
  };
}
