import { useEffect, useRef, useState } from 'react';

/** Count live errors while away from Logs. Stored history is never mutated or marked read. */
export function useUnreadLogErrors(viewingLogs: boolean): number {
  const visible = useRef(viewingLogs);
  visible.current = viewingLogs;
  const [count, setCount] = useState(0);
  useEffect(() => {
    const stop = window.lonelyChat?.onOperationalLog((entry) => {
      if (entry.level === 'error' && !visible.current) setCount((old) => Math.min(999, old + 1));
    });
    return () => stop?.();
  }, []);
  useEffect(() => {
    if (viewingLogs) setCount(0);
  }, [viewingLogs]);
  return viewingLogs ? 0 : count;
}
