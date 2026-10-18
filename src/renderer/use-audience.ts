import { useEffect, useRef, useState } from 'react';
import type { AudienceSnapshot } from '../shared/audience-contract';
import type { InferenceMode } from '../shared/session-contract';

const INITIAL: AudienceSnapshot = {
  revision: 0,
  phase: 'uninitialized',
  members: [],
  targetCount: 3,
  error: null,
};

export function useAudience() {
  const [status, setStatus] = useState<AudienceSnapshot>(INITIAL);
  const latest = useRef(INITIAL);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    const accept = (snapshot: AudienceSnapshot) => {
      if (!active || snapshot.revision < latest.current.revision) return;
      latest.current = snapshot;
      setStatus(snapshot);
    };
    const unsubscribe = window.lonelyChat?.onAudienceChange(accept);
    void window.lonelyChat
      ?.getAudience()
      .then(accept)
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : 'Unable to load audience.');
      });
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, []);

  const regenerate = async (mode: InferenceMode, seed?: number) => {
    setBusy(true);
    setError(null);
    try {
      const next = await window.lonelyChat!.regenerateAudience(mode, seed);
      if (next.revision >= latest.current.revision) {
        latest.current = next;
        setStatus(next);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to generate audience.');
    } finally {
      setBusy(false);
    }
  };
  return { status, busy, error, regenerate };
}
