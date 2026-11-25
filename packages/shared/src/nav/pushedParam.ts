import { useCallback, useMemo, useRef } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import { stateRecord, withoutKeys } from './historyState';
import { usePopOnce } from './popOnce';

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
  const location = useLocation();
  const popOnce = usePopOnce();
  // Live values: a second click in the same tick sees the first one's write.
  const valueRef = useRef<string | null>(params.get(param));
  valueRef.current = params.get(param);
  const stateRef = useRef<unknown>(location.state);
  stateRef.current = location.state;
  const pushed = (location.state as Record<string, unknown> | null)?.[marker] === true;
  const pushedRef = useRef(pushed);
  pushedRef.current = pushed;

  const write = useCallback((id: string | null, replace: boolean, state: unknown) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (id === null) next.delete(param); else next.set(param, id);
      return next;
    }, { replace, state });
  }, [setParams, param]);

  const open = useCallback((id: string) => {
    if (valueRef.current === null) {
      write(id, false, { ...stateRecord(stateRef.current), [marker]: true });
      stateRef.current = { ...stateRecord(stateRef.current), [marker]: true };
      pushedRef.current = true;
    } else {
      write(id, true, stateRef.current);
    }
    valueRef.current = id;
  }, [write, marker]);

  const drop = useCallback(() => {
    write(null, true, withoutKeys(stateRef.current, [marker]));
    valueRef.current = null;
  }, [write, marker]);

  const close = useCallback(() => {
    if (valueRef.current === null) return;
    if (pushedRef.current) { popOnce(); return; }
    drop();
  }, [popOnce, drop]);

  const value = params.get(param);
  return useMemo(() => ({ value, open, close, drop }), [value, open, close, drop]);
}
