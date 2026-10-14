/**
 * Replay timeline: a severity histogram of the selected period with a playhead,
 * play / pause, ½× / 1× / 3× and drag-to-scrub. It drives the page's
 * AnimationClock — the same clock the particles, rings and movement trails run
 * on — so scrubbing moves everything to that moment.
 *
 * Performance: the playhead moves every frame, but React never re-renders for
 * it. The page publishes the clock position through a tiny bus and this
 * component writes a CSS transform (and, only when the bucket changes, the
 * readout text) straight to the DOM.
 *
 * The bars live on the REPLAY WINDOW ([now - period, now], the one the particles and
 * movement trails were built for), so the playhead, the bars and the animation agree.
 * On phones the readout is short ("13 Oct 14:00") and the range line is dropped.
 *
 * Fast view (`series="velocity"`): the bars are the fast-weaponized threats per bucket (`/timeline?velocity=`).
 * Nothing replays in that scene (its nodes are period totals), so the transport and the playhead are left
 * out and the histogram is a still chart with a text summary instead of a slider.
 *
 * Accessibility: the histogram is a `slider` — Left/Right move one bucket,
 * Shift or Page keys ten, Home/End jump to the ends, Space plays / pauses. Under
 * reduced motion playback is off (scrubbing still works).
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import type { AnimationClock } from '../lib/animation-clock';
import type { TimelineData } from '@/hooks/useObservatoryLenses';
import {
  buildHistogram, barIndexAt, clockToFrac, formatPlayheadTime, fracToClock, fracToTime, nudgePlayhead,
  pointerFrac, stackedPaths, velocityPaths, windowBuckets, type ReplayWindow, type TimelineSeries,
} from '../lib/lens/timeline';
import { VELOCITY_RGB } from '../lib/lens/velocity';
import { CYCLE_LENGTH } from '../lib/trips';

// ─── Playhead bus ───────────────────────────────────────────

export type PlayheadListener = (t: number) => void;

/** Frame-rate pub/sub for the playhead. Stable identity; never causes a React render. */
export function usePlayheadBus() {
  const listeners = useRef(new Set<PlayheadListener>());
  const publish = useCallback((t: number) => { for (const l of listeners.current) l(t); }, []);
  const subscribe = useCallback((l: PlayheadListener) => {
    listeners.current.add(l);
    return () => { listeners.current.delete(l); };
  }, []);
  return useMemo(() => ({ publish, subscribe }), [publish, subscribe]);
}

// ─── Component ──────────────────────────────────────────────

export const REPLAY_SPEEDS = [0.5, 1, 3] as const;
const SPEED_LABEL: Record<number, string> = { 0.5: '½×', 1: '1×', 3: '3×' };
const HIST_HEIGHT = 30;
const SEV_FILL = {
  critical: 'rgb(200, 60, 60)', high: 'rgb(251, 146, 60)', medium: 'rgb(250, 204, 21)', low: 'rgb(120, 160, 200)', other: 'rgb(120, 130, 145)',
} as const;

export interface ReplayTimelineProps {
  data: TimelineData | undefined;
  isLoading: boolean;
  error: Error | null;
  onRetry: () => void;
  clock: AnimationClock;
  subscribe: (l: PlayheadListener) => () => void;
  playing: boolean;
  speed: number;
  onTogglePlay: () => void;
  onSpeed: (speed: number) => void;
  /** Scrub: the page seeks the clock and repaints. */
  onSeek: (t: number) => void;
  reducedMotion: boolean;
  periodLabel: string;
  /** Set when the histogram is filtered to one country. */
  countryLabel?: string | null;
  /** The window the particles / trails were built for; bars are placed inside it. */
  window?: ReplayWindow | null;
  /** True while the pointer is dragging the playhead (live pings pause meanwhile). */
  onScrubChange?: (scrubbing: boolean) => void;
  isMobile?: boolean;
  /** `severity` (default): the replay histogram. `velocity`: fast-weaponized threats, a still chart. */
  series?: TimelineSeries;
  className?: string;
  style?: React.CSSProperties;
}

export function ReplayTimeline({
  data, isLoading, error, onRetry, clock, subscribe, playing, speed, onTogglePlay, onSpeed, onSeek,
  reducedMotion, periodLabel, countryLabel, window: replayWindow, onScrubChange, isMobile = false, series = 'severity', className, style,
}: ReplayTimelineProps) {
  const velocity = series === 'velocity';
  const hist = useMemo(() => buildHistogram(data, replayWindow, series), [data, replayWindow, series]);
  const trackRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const readoutRef = useRef<HTMLSpanElement>(null);
  const sliderRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const widthRef = useRef(0);
  const lastBucket = useRef(-1);
  const draggingRef = useRef(false);

  useLayoutEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const measure = () => { widthRef.current = el.clientWidth; setWidth(el.clientWidth); };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const paths = useMemo(() => (hist && width > 0 && !velocity ? stackedPaths(hist, width, HIST_HEIGHT) : null), [hist, width, velocity]);
  const vPaths = useMemo(() => (hist && width > 0 && velocity ? velocityPaths(hist, width, HIST_HEIGHT) : null), [hist, width, velocity]);

  /** Move the playhead marker + readout to clock position t. DOM only. */
  const apply = useCallback((t: number) => {
    const frac = clockToFrac(t, CYCLE_LENGTH);
    const head = headRef.current;
    if (head) head.style.transform = `translate3d(${frac * widthRef.current}px,0,0)`;
    const idx = hist ? barIndexAt(frac, hist) : 0;
    if (idx !== lastBucket.current) {
      lastBucket.current = idx;
      if (hist) {
        const text = formatPlayheadTime(fracToTime(frac, hist), hist.bucketMs, isMobile);
        if (readoutRef.current) readoutRef.current.textContent = text;
        sliderRef.current?.setAttribute('aria-valuetext', text);
      }
      sliderRef.current?.setAttribute('aria-valuenow', String(Math.round(frac * 100)));
    }
  }, [hist, isMobile]);

  // Follow the clock; also snap to the current position whenever the layout / data changes.
  useEffect(() => {
    if (velocity) return; // a still chart: no playhead to move
    lastBucket.current = -1;
    apply(clock.currentTime);
    return subscribe(apply);
  }, [subscribe, apply, clock, width, velocity]);

  // A drag cut short by unmounting must not leave the page believing it is still scrubbing.
  const scrubCbRef = useRef(onScrubChange);
  scrubCbRef.current = onScrubChange;
  useEffect(() => () => { if (draggingRef.current) scrubCbRef.current?.(false); }, []);

  const seekFromPointer = useCallback((clientX: number) => {
    const el = trackRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const t = fracToClock(pointerFrac(clientX, rect.left, rect.width), CYCLE_LENGTH);
    onSeek(t);
    apply(t);
  }, [onSeek, apply]);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    draggingRef.current = true;
    onScrubChange?.(true);
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* jsdom / synthetic */ }
    seekFromPointer(e.clientX);
    sliderRef.current?.focus({ preventScroll: true });
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (draggingRef.current) seekFromPointer(e.clientX);
  };
  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (draggingRef.current) onScrubChange?.(false);
    draggingRef.current = false;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const n = hist ? windowBuckets(hist) : 1;
    let t: number | null = null;
    const coarse = e.shiftKey ? 10 : 1;
    switch (e.key) {
      case 'ArrowLeft': case 'ArrowDown': t = nudgePlayhead(clock.currentTime, -1, n, coarse); break;
      case 'ArrowRight': case 'ArrowUp': t = nudgePlayhead(clock.currentTime, 1, n, coarse); break;
      case 'PageDown': t = nudgePlayhead(clock.currentTime, -1, n, 10); break;
      case 'PageUp': t = nudgePlayhead(clock.currentTime, 1, n, 10); break;
      case 'Home': t = 0; break;
      case 'End': t = fracToClock(1, CYCLE_LENGTH); break;
      case ' ': case 'Spacebar':
        e.preventDefault();
        if (!reducedMotion) onTogglePlay();
        return;
      default: return;
    }
    e.preventDefault();
    onSeek(t);
    apply(t);
  };

  const subtitle = hist ? `${periodLabel}${countryLabel ? ` · ${countryLabel}` : ''}` : periodLabel;
  const empty = hist !== null && hist.total === 0;
  const stillSummary = velocity && hist ? `Fast weaponization, ${subtitle}: ${hist.total.toLocaleString()} threats` : `Fast weaponization, ${subtitle}`;

  return (
    <div
      role="group"
      aria-label={velocity ? 'Fast weaponization timeline' : 'Replay timeline'}
      className={className}
      style={{
        background: 'var(--bg-card-deep)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        border: '1px solid var(--border-base)',
        borderRadius: 12,
        padding: isMobile ? '6px 8px' : '6px 10px',
        display: 'flex',
        alignItems: 'center',
        gap: isMobile ? 6 : 10,
        ...style,
      }}
    >
      {!velocity && <button
        type="button"
        onClick={onTogglePlay}
        aria-label={reducedMotion ? 'Playback is off (reduced motion)' : playing ? 'Pause replay' : 'Play replay'}
        aria-pressed={reducedMotion ? false : playing}
        aria-disabled={reducedMotion || undefined}
        title={reducedMotion ? 'Playback is off: reduced motion. Scrub the timeline to explore.' : undefined}
        className="ds-focusable inline-flex items-center justify-center shrink-0 rounded-lg"
        style={{
          width: isMobile ? 44 : 32, height: isMobile ? 44 : 32,
          background: 'var(--bg-card)', border: '1px solid var(--border-base)',
          color: reducedMotion ? 'var(--text-muted)' : 'var(--amber-text)',
          cursor: reducedMotion ? 'not-allowed' : 'pointer', opacity: reducedMotion ? 0.55 : 1,
        }}
        onClickCapture={e => { if (reducedMotion) { e.preventDefault(); e.stopPropagation(); } }}
      >
        {playing && !reducedMotion ? <Pause size={14} /> : <Play size={14} />}
      </button>}

      {!isMobile && !velocity && (
        <div role="group" aria-label="Replay speed" className="flex shrink-0 rounded-lg overflow-hidden" style={{ border: '1px solid var(--border-base)' }}>
          {REPLAY_SPEEDS.map(s => (
            <button
              key={s}
              type="button"
              aria-pressed={speed === s}
              onClick={() => onSpeed(s)}
              className="ds-focusable font-mono text-[10px] px-2 min-h-[30px]"
              style={{
                background: speed === s ? 'color-mix(in srgb, var(--amber) 15%, transparent)' : 'transparent',
                color: speed === s ? 'var(--amber-text)' : 'var(--text-tertiary)',
                border: 'none', cursor: 'pointer',
              }}
            >
              {SPEED_LABEL[s]}
            </button>
          ))}
        </div>
      )}

      <div className="flex-1 min-w-0 flex flex-col gap-0.5">
        {/* The slider / image role makes its children presentational for assistive tech, so anything that has to be
            reachable (the Retry button, the status text) is a SIBLING laid over it, never inside it. */}
        <div className="relative" style={{ height: HIST_HEIGHT + 2 }}>
          <div
            ref={sliderRef}
            {...(velocity
              ? { role: 'img', 'aria-label': stillSummary }
              : {
                role: 'slider', tabIndex: 0, 'aria-label': `Replay position, ${subtitle}`,
                'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': 0, 'aria-orientation': 'horizontal' as const,
                onKeyDown, onPointerDown, onPointerMove, onPointerUp: endDrag, onPointerCancel: endDrag,
              })}
            className="ds-focusable absolute inset-0 rounded-md"
            style={{ cursor: velocity ? 'default' : 'ew-resize', touchAction: velocity ? undefined : 'none', background: 'color-mix(in srgb, var(--text-primary) 4%, transparent)' }}
          >
            <div ref={trackRef} className="absolute inset-0 overflow-hidden rounded-md">
              {paths && !empty && (
                <svg width={width} height={HIST_HEIGHT} aria-hidden style={{ position: 'absolute', left: 0, bottom: 0 }}>
                  <path d={paths.other} fill={SEV_FILL.other} opacity={0.5} />
                  <path d={paths.low} fill={SEV_FILL.low} opacity={0.7} />
                  <path d={paths.medium} fill={SEV_FILL.medium} opacity={0.75} />
                  <path d={paths.high} fill={SEV_FILL.high} opacity={0.85} />
                  <path d={paths.critical} fill={SEV_FILL.critical} />
                </svg>
              )}
              {vPaths && !empty && (
                <svg width={width} height={HIST_HEIGHT} aria-hidden style={{ position: 'absolute', left: 0, bottom: 0 }}>
                  <path d={vPaths.fast} fill={VELOCITY_RGB} opacity={0.5} />
                  <path d={vPaths.veryFast} fill={VELOCITY_RGB} />
                </svg>
              )}
            </div>
            {/* Playhead: a transform-only marker, positioned by `apply`. */}
            {!velocity && <div
              ref={headRef}
              aria-hidden
              className="absolute top-0 bottom-0 left-0 pointer-events-none"
              style={{ width: 2, marginLeft: -1, background: 'var(--amber)', boxShadow: '0 0 6px var(--amber)', willChange: 'transform' }}
            />}
          </div>
          {(isLoading || error || empty || !hist) && (
            <div className="absolute inset-0 flex items-center justify-center font-mono text-[10px] pointer-events-none" style={{ color: 'var(--text-muted)' }}>
              {error ? (
                <span role="alert" className="pointer-events-auto">
                  Timeline unavailable{' '}
                  <button type="button" onClick={e => { e.stopPropagation(); onRetry(); }} className="ds-focusable" style={{ background: 'none', border: 'none', color: 'var(--amber-text)', cursor: 'pointer', font: 'inherit', textDecoration: 'underline' }}>Retry</button>
                </span>
              ) : isLoading ? <span role="status">Loading timeline…</span>
                : empty ? <span role="status">{velocity ? 'Coverage still filling: no fast-weaponized threats counted yet' : 'No activity in this period'}</span>
                  : null}
            </div>
          )}
        </div>
        <div className="flex items-center justify-between gap-2 font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>
          {/* The readout follows the playhead's bucket (written imperatively, never via React state). */}
          {velocity
            ? <span style={{ color: 'var(--text-secondary)', minWidth: 0 }}>
              {hist && !empty ? <><span style={{ color: VELOCITY_RGB }}>■</span> very fast (≤ 24h) <span style={{ opacity: 0.6, color: VELOCITY_RGB }}>■</span> fast (≤ 72h)</> : null}
            </span>
            : <span ref={readoutRef} aria-hidden style={{ color: 'var(--amber-text)', minWidth: 0 }} />}
          {!isMobile && (
            <span className="truncate">
              {hist ? `${formatPlayheadTime(hist.startMs, hist.bucketMs)} – ${formatPlayheadTime(hist.endMs, hist.bucketMs)}` : subtitle}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
