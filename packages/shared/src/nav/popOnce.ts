import { useCallback, useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

/**
 * `() => boolean` that pops one history entry (`navigate(-1)`) at most once per
 * location: a double click, or two close paths in one tick, can never pop twice.
 * Returns whether it popped. Shared by every "close = pop the entry I pushed"
 * site (usePushedParam, Observatory) so they cannot drift.
 */
export function usePopOnce(): () => boolean {
  const navigate = useNavigate();
  const { key } = useLocation();
  const used = useRef(false);
  useEffect(() => { used.current = false; }, [key]);
  const navRef = useRef(navigate);
  navRef.current = navigate;
  return useCallback(() => {
    if (used.current) return false;
    used.current = true;
    navRef.current(-1);
    return true;
  }, []);
}
