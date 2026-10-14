import { useCallback, useEffect, useRef } from 'react';
import type { LayerId } from './lenses';
import { layerForKey } from './shortcuts';

/**
 * Number-key (1-9) layer shortcuts. Attach the returned handler to the element that
 * wraps the map and its chrome (React onKeyDown). Scoping lives in `layerForKey`:
 * modified keys and anything typed into a field, slider, listbox, dialog or tab are ignored.
 */
export function useLayerShortcuts(onToggle: (id: LayerId) => void, enabled: boolean): (e: React.KeyboardEvent) => void {
  const ref = useRef(onToggle);
  useEffect(() => { ref.current = onToggle; }, [onToggle]);
  return useCallback((e: React.KeyboardEvent) => {
    if (!enabled) return;
    const id = layerForKey({ key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, defaultPrevented: e.defaultPrevented, target: e.target });
    if (id) ref.current(id);
  }, [enabled]);
}
