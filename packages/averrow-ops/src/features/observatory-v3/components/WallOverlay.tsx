/**
 * The wall screen's overlay (`?wall=1`): see `WallOverlay`.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { StatTile } from '@/design-system/components';
import { MapAttribution } from './MapAttribution';

/** The exit button fades out this long after the pointer last moved, ms. */
export const WALL_EXIT_HIDE_MS = 3_000;

/**
 * Wall screen overlay: the headline numbers (threats, countries and, once the Operations lens has loaded, active
 * operations) in the StatTile look at 32px or larger, the period with a live dot, the attribution in a corner, and the
 * exit button, which fades in while the pointer moves and out again after `WALL_EXIT_HIDE_MS`.
 */
export function WallOverlay({ periodLabel, threats, countries, operations, loadFailed, phone, onExit, zIndex }: {
  periodLabel: string; threats: number | null; countries: number | null; operations: number | null; loadFailed: boolean;
  phone: boolean; onExit: () => void; zIndex: number;
}) {
  const [awake, setAwake] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wake = useCallback(() => {
    setAwake(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setAwake(false), WALL_EXIT_HIDE_MS);
  }, []);
  useEffect(() => {
    const events = ['pointermove', 'pointerdown', 'touchstart', 'keydown'] as const;
    // Capture phase: the map's own handlers may stop propagation, and this must still see every movement.
    for (const e of events) window.addEventListener(e, wake, { passive: true, capture: true });
    return () => {
      for (const e of events) window.removeEventListener(e, wake, { capture: true });
      if (timer.current) clearTimeout(timer.current);
    };
  }, [wake]);
  const tiles: Array<{ label: string; value: number | null }> = [
    { label: 'Threats', value: threats },
    { label: 'Countries', value: countries },
    ...(operations !== null ? [{ label: 'Operations', value: operations }] : []),
  ];
  return (
    <>
      <div
        data-wall-overlay
        className={`absolute left-3 flex flex-col gap-2 pointer-events-none ${phone ? 'bottom-8' : 'bottom-3'}`}
        style={{ right: phone ? 12 : undefined, zIndex }}
      >
        {/* The map behind is dark in both themes: the words sit on a card surface so the tokens keep their contrast. */}
        <div
          className="flex w-fit items-center gap-2 rounded-full px-3 py-1.5 font-mono text-sm uppercase tracking-[0.18em]"
          style={{ color: 'var(--text-secondary)', background: 'var(--bg-card-deep)', border: '1px solid var(--border-base)' }}
        >
          <span aria-hidden className="inline-block rounded-full motion-safe:animate-pulse" style={{ width: 10, height: 10, background: 'var(--green)', boxShadow: '0 0 10px var(--green)' }} />
          <span style={{ color: 'var(--green-text)' }}>Live</span>
          <span aria-hidden>·</span>
          <span style={{ color: 'var(--amber-text)' }}>{periodLabel}</span>
        </div>
        <div className={phone ? 'grid grid-cols-3 gap-2' : 'flex gap-3'} role="group" aria-label={`Headline numbers, ${periodLabel}`}>
          {tiles.map(t => (
            <StatTile
              key={t.label}
              label={t.label}
              value={t.value}
              error={loadFailed}
              tone="amber"
              compact
              className={phone ? undefined : 'min-w-[200px]'}
            />
          ))}
        </div>
      </div>
      <style>{'[data-wall-overlay] .ds-stat-value, [data-wall-overlay] .ds-stat-value--fit { font-size: clamp(32px, 5vw, 64px) !important; }'}</style>
      {/* Bottom right on a wide screen; on a phone the tiles span the width, so it runs along the very bottom edge under them. */}
      <span className={`absolute rounded-md px-2 py-0.5 bottom-1 ${phone ? 'left-3' : 'right-3'}`} style={{ zIndex, background: 'var(--bg-card-deep)' }} data-wall-attribution>
        <MapAttribution />
      </span>
      <button
        type="button"
        onClick={onExit}
        onFocus={wake}
        className="ds-focusable absolute top-3 right-3 rounded-full px-4 font-mono text-xs uppercase tracking-wider transition-opacity duration-300 motion-reduce:transition-none"
        style={{
          zIndex, minHeight: phone ? 44 : 32, background: 'var(--bg-card)', border: '1px solid var(--border-base)',
          color: 'var(--text-secondary)', cursor: 'pointer', opacity: awake ? 1 : 0, pointerEvents: awake ? 'auto' : 'none',
        }}
      >
        Exit wall screen
      </button>
    </>
  );
}
