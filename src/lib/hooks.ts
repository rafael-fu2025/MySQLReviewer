import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

/**
 * Tracks a CSS media query.
 *
 * Uses `useSyncExternalStore` so the value is read from the browser at the
 * moment it is needed rather than mirrored into state, which avoids an
 * extra render on every query change.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const media = window.matchMedia(query);
      media.addEventListener('change', onChange);
      return () => media.removeEventListener('change', onChange);
    },
    [query],
  );
  const getSnapshot = useCallback(() => window.matchMedia(query).matches, [query]);
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

/** A timestamp that refreshes on an interval. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
