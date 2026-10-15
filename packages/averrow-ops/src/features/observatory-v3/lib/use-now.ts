/** `Date.now()` that re-reads itself every `everyMs`, so relative ages ("3m") stay true without a refetch. */

import { useEffect, useState } from 'react';

export function useNow(everyMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}
