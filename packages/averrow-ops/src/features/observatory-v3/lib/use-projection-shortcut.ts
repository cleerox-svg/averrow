import { useEffect, useRef } from 'react';
import { isProjectionKey } from './shortcuts';

/**
 * `G` flips Flat | Globe from anywhere on the page. Unlike the 1-9 layer keys (an `onKeyDown` on the console wrapper, so
 * only reachable with focus inside it), this listens on the window: a wall screen has nothing focused, and `G` is the
 * way to change the view from a keyboard without first clicking into the page. Scoping lives in `isProjectionKey`
 * (modified keys, held repeats and anything typed into a field / slider / listbox / dialog are ignored).
 */
export function useProjectionShortcut(onToggle: () => void, enabled: boolean): void {
  const ref = useRef(onToggle);
  useEffect(() => { ref.current = onToggle; }, [onToggle]);
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (!isProjectionKey({ key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, defaultPrevented: e.defaultPrevented, target: e.target, repeat: e.repeat })) return;
      ref.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}
