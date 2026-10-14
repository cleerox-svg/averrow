/**
 * Flat | Globe: ONE toggle button, living in the map's zoom cluster (bottom-right, or top-right on phones where there
 * is no zoom control). It is a map control, not a lens control: it is there in every lens and view.
 *
 *   - a FIXED label ("Globe view") whose `aria-pressed` says whether the globe is on: a label that flips with the state
 *     ("Switch to flat map") AND a pressed state read as a double negative to a screen reader;
 *   - it reads the REQUESTED projection (the URL's `proj`), so the preference survives views that cannot draw it;
 *   - the density Heat view has no globe variant (deck.gl's HeatmapLayer aggregates in screen space): the button is
 *     disabled and says so IN TEXT next to it (a tooltip does not exist on touch), and the change is announced when
 *     Heat flips a requested globe flat and when the globe comes back;
 *   - 29px like MapLibre's own zoom buttons on a pointer device, 44px on touch.
 */

import { useEffect, useRef, useState } from 'react';
import { Globe2, Map as MapIcon } from 'lucide-react';
import type { Projection } from '../lib/projection';

export const HEAT_FLAT_ONLY = 'Heat view is flat-only';

export interface ProjectionToggleProps {
  /** The REQUESTED projection. */
  projection: Projection;
  /** The scene cannot be drawn as a globe (the density heat view). */
  flatOnly?: boolean;
  onToggle: (next: Projection) => void;
  /** 44px target (phones / touch). */
  touch?: boolean;
}

export function toggleLabel(projection: Projection, flatOnly: boolean): string {
  void projection; // the label does not depend on it: the pressed state carries it
  return flatOnly ? 'Globe view (unavailable: heat view is flat-only)' : 'Globe view';
}

export function ProjectionToggle({ projection, flatOnly = false, onToggle, touch = false }: ProjectionToggleProps) {
  const [announcement, setAnnouncement] = useState('');
  const say = (msg: string) => setAnnouncement(prev => (prev === msg ? `${msg}​` : msg));
  const globe = projection === 'globe';

  // Heat flips a requested globe flat (and back): say so, since nothing the user touched named it.
  const wasForcedFlat = useRef(false);
  useEffect(() => {
    const forced = flatOnly && globe;
    if (forced && !wasForcedFlat.current) setAnnouncement(`${HEAT_FLAT_ONLY}: showing the flat map`);
    else if (!forced && wasForcedFlat.current && globe) setAnnouncement('Globe view restored');
    wasForcedFlat.current = forced;
  }, [flatOnly, globe]);

  const size = touch ? 44 : 29;
  const reasonId = 'projection-toggle-reason';
  return (
    <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'flex-end' }}>
      {flatOnly && (
        <span
          id={reasonId}
          className="font-mono"
          style={{
            position: 'absolute', right: size + 8, top: '50%', transform: 'translateY(-50%)', whiteSpace: 'nowrap',
            fontSize: 11, padding: '3px 8px', borderRadius: 8,
            background: 'var(--bg-card-deep)', border: '1px solid var(--border-base)', color: 'var(--text-secondary)',
          }}
        >
          {HEAT_FLAT_ONLY}
        </span>
      )}
      <button
        type="button"
        data-control="projection"
        aria-label={toggleLabel(projection, flatOnly)}
        aria-pressed={globe}
        aria-disabled={flatOnly || undefined}
        aria-describedby={flatOnly ? reasonId : undefined}
        title={flatOnly ? HEAT_FLAT_ONLY : 'Globe view'}
        onClick={flatOnly ? undefined : () => { const next: Projection = globe ? 'flat' : 'globe'; onToggle(next); say(next === 'globe' ? 'Projection: globe' : 'Projection: flat map'); }}
        className="ds-focusable"
        style={{
          width: size, height: size, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          opacity: flatOnly ? 0.45 : 1, cursor: flatOnly ? 'not-allowed' : 'pointer',
          // pressed = the globe is on: MapLibre's control chrome with the console's amber for the on state
          color: globe && !flatOnly ? 'var(--amber-dim, #B8821F)' : '#333',
        }}
      >
        {globe ? <MapIcon size={touch ? 18 : 16} aria-hidden /> : <Globe2 size={touch ? 18 : 16} aria-hidden />}
      </button>
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</span>
    </div>
  );
}
