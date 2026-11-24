import { useCallback, useEffect, useRef } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';

export interface PushedParam {
  /** Current value of the param, or null. */
  value: string | null;
  /** Open `id`: PUSH from none (marking the entry), REPLACE when one is already open. */
  open: (id: string) => void;
  /** User close: POP the entry this page pushed (once), else REPLACE the param away. */
  close: () => void;
  /** Effect-driven drop (stale / unresolvable id): always REPLACE, never pops. */
  drop: () => void;
}

/**
 * A detail drawer driven by `?<param>=<id>`. Opening from none pushes an entry
 * marked `state[marker]`, so the user's Back closes it and an in-page close pops
 * that same entry (no duplicate list entry). The mark lives in history state, so
 * it survives reloads and remounts; a cold deep link has no mark and closes with
 * a replace, never leaving the app. Switching between ids replaces and keeps
 * the mark. Other search params are preserved.
 */
export function usePushedParam(param: string, marker: string): PushedParam {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const value = params.get(param);
  const pushed = (location.state as Record<string, unknown> | null)?.[marker] === true;
  const popping = useRef(false);
  useEffect(() => { popping.current = false; }, [location.key]);

  const write = useCallback((id: string | null, replace: boolean, state: unknown) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (id === null) next.delete(param); else next.set(param, id);
      return next;
    }, { replace, state });
  }, [setParams, param]);

  const open = useCallback((id: string) => {
    if (value === null) write(id, false, { ...stateRecord(location.state), [marker]: true });
    else write(id, true, location.state);
  }, [value, write, marker, location.state]);

  const drop = useCallback(() => write(null, true, withoutMarker(location.state, marker)), [write, location.state, marker]);

  const close = useCallback(() => {
    if (value === null) return;
    if (pushed) {
      if (popping.current) return;
      popping.current = true;
      navigate(-1);
      return;
    }
    drop();
  }, [value, pushed, navigate, drop]);

  return { value, open, close, drop };
}

function stateRecord(state: unknown): Record<string, unknown> {
  return state && typeof state === 'object' ? (state as Record<string, unknown>) : {};
}
function withoutMarker(state: unknown, marker: string): unknown {
  const { [marker]: _gone, ...rest } = stateRecord(state);
  return Object.keys(rest).length > 0 ? rest : undefined;
}
