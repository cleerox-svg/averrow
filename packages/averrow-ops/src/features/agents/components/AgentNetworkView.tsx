// AgentNetworkView v4 — staged data-flow canvas with a run tape.
//
//   Flow (network/FlowCanvas)  where data goes, and what is running now
//   Tape (network/RunTape)     what ran in the last hour, for how long
//
// The two share one hover id: a bar on the tape lights its node, a node on
// the canvas lights its lane. Layout comes from each agent's stage, edges
// from the one declared list in network/model.ts, motion from
// GET /api/agents/timeline (last hour). With no timeline (loading or an
// error) the canvas still draws its structure, just without motion.
//
// Retired agents sit behind a collapsed chip, manual / API-only agents in an
// "On demand" rail; both stay clickable and open the same detail panel.
// Motion stops under the OS reduced-motion setting or the Pause control.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Maximize2, Minimize2, RotateCcw, Wind, ZoomIn, ZoomOut } from 'lucide-react';
import { useReducedMotion } from '@averrow/shared/ui';
import type { Agent } from '@/hooks/useAgents';
import { useFeeds } from '@/hooks/useFeeds';
import {
  TIMELINE_WINDOW_MS, readStoredWindow, storeWindow, useAgentTimeline, useTimelineClock,
  type AgentTimeline, type TimelineWindow,
} from '@/hooks/useAgentTimeline';
import { FlowCanvas, agentLabel } from '../network/FlowCanvas';
import { RunTape } from '../network/RunTape';
import { indexTimeline } from '../network/activity';
import { MIN_LAYOUT_WIDTH, placeAgents } from '../network/model';
import { useElementWidth, useMountedElement } from '../network/useCanvasLoop';
import { LiveChip } from '../network/LiveChip';
import { ReplayControls } from '../network/ReplayControls';
import {
  DEFAULT_REPLAY_SPEEDS, SLIDER_STEPS, advancePlayhead, canHandleReplayKey, clampPlayhead, pagePlayhead, stepPlayhead,
  type ReplaySpeed,
} from '../network/replay';
import { useIdentity } from '../network/useIdentity';

const ZOOM_MIN = 0.6;
const ZOOM_MAX = 1.6;
const ZOOM_STEP = 0.2;

// Focus styling for the canvas wrappers, scroll regions and small controls.
export const FOCUS_CSS = `
.agn-btn:focus-visible,.agn-chip:focus-visible{outline:2px solid var(--focus-ring);outline-offset:2px}
.agn-scroll:focus-visible{outline:2px solid var(--focus-ring);outline-offset:-2px}
.agn-slider:focus-visible{outline:2px solid var(--focus-ring);outline-offset:-2px}
.agn-ring-within:has(:focus-visible){outline:2px solid var(--focus-ring);outline-offset:-2px}
.agn-btn[aria-disabled="true"]{opacity:.4;cursor:default}
/* Touch: every control keeps a 44px hit area on phones and coarse pointers, while the visual stays compact. */
@media (max-width:639px),(pointer:coarse){.agn-btn,.agn-chip{min-width:44px;min-height:44px}}
`;

interface AgentNetworkViewProps {
  agents:        Agent[];
  selectedAgent: string | null;
  onSelect:      (name: string) => void;
}

function CtrlButton({
  disabled, onClick, children, buttonRef, ...rest
}: Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'disabled'> & {
  disabled?: boolean;
  buttonRef?: React.Ref<HTMLButtonElement>;
}) {
  // aria-disabled (not disabled) so a button that disables itself while
  // focused keeps focus.
  return (
    <button
      ref={buttonRef}
      type="button"
      aria-disabled={disabled ? true : undefined}
      onClick={(e) => { if (!disabled) onClick?.(e); }}
      className="agn-btn w-8 h-8 rounded grid place-items-center transition-colors"
      style={{
        background: 'var(--bg-card-deep)',
        border:     '1px solid var(--border-base)',
        color:      'var(--text-secondary)',
      }}
      {...rest}
    >
      {children}
    </button>
  );
}

function Chip({
  children, onClick, muted, ...rest
}: { children: React.ReactNode; onClick: () => void; muted?: boolean } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="agn-chip font-mono text-[10px] px-2 py-1 rounded transition-colors"
      style={{
        background: 'var(--bg-card-deep)',
        border: '1px solid var(--border-base)',
        color: muted ? 'var(--text-tertiary)' : 'var(--text-secondary)',
      }}
      {...rest}
    >
      {children}
    </button>
  );
}

type SwatchKind = 'colour' | 'running' | 'transit' | 'failed' | 'partial' | 'idle' | 'event';
const LEGEND: Array<{ kind: SwatchKind; label: string }> = [
  { kind: 'colour', label: 'Colour = agent' },
  { kind: 'running', label: 'Running now' },
  { kind: 'transit', label: 'Data in transit' },
  { kind: 'failed', label: 'Failed: red ring with ×' },
  { kind: 'partial', label: 'Partial run (tape)' },
  { kind: 'idle', label: 'Idle link' },
  { kind: 'event', label: 'Dashed: event hand-off (pivot_detected)' },
];

function Swatch({ kind }: { kind: SwatchKind }) {
  const base: React.CSSProperties = { display: 'inline-block', flex: 'none' };
  switch (kind) {
    case 'running': // filled disc with an outer progress ring
      return <i aria-hidden="true" style={{ ...base, width: 12, height: 12, borderRadius: 999, background: 'var(--primary)', boxShadow: '0 0 0 2px var(--bg-card), 0 0 0 3.5px var(--primary-text)' }} />;
    case 'transit': // small bright dot with a soft halo
      return <i aria-hidden="true" style={{ ...base, width: 5, height: 5, borderRadius: 999, background: 'var(--primary-text)', boxShadow: '0 0 0 3px color-mix(in srgb, var(--primary-text) 30%, transparent)', margin: '0 3px' }} />;
    case 'colour': // identity colours: a small spread, not a rainbow
      return <i aria-hidden="true" style={{ ...base, width: 12, height: 12, borderRadius: 999, background: 'conic-gradient(#38BDF8, #A78BFA, #FB923C, #4ADE80, #38BDF8)' }} />;
    case 'failed': // red ring with a x: shape plus colour
      return (
        <i
          aria-hidden="true"
          style={{
            ...base, width: 14, height: 14, borderRadius: 999, border: '2px solid var(--sev-critical)',
            display: 'inline-grid', placeItems: 'center', fontStyle: 'normal', fontSize: 10, lineHeight: 1,
            color: 'var(--sev-critical)', fontWeight: 700,
          }}
        >
          ×
        </i>
      );
    case 'partial': // amber-ish status bar
      return <i aria-hidden="true" style={{ ...base, width: 16, height: 6, borderRadius: 2, background: 'var(--sev-medium)' }} />;
    case 'idle':
      return <i aria-hidden="true" style={{ ...base, width: 16, height: 0, borderTop: '2px solid var(--text-muted)', opacity: 0.45 }} />;
    case 'event':
      return <i aria-hidden="true" style={{ ...base, width: 16, height: 0, borderTop: '2px dashed var(--primary-text)' }} />;
  }
}

const BREAKER_NOTE = 'Breaker and event states show their current value.';
const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function AgentNetworkView({ agents, selectedAgent, onSelect: onSelectAgent }: AgentNetworkViewProps) {
  // The wrapper element is state, not a bare ref: full screen re-mounts it
  // inside a portal and the width observer must follow.
  const [, setWrapEl, wrapEl] = useMountedElement<HTMLDivElement>();
  const exitRef = useRef<HTMLButtonElement | null>(null);
  const width = useElementWidth(wrapEl);
  const osReduced = useReducedMotion();
  const [paused, setPaused] = useState(false);
  // Pause and the OS preference share one static path for both canvases.
  const reducedMotion = osReduced || paused;

  const feedsQ = useFeeds();
  const feeds = useMemo(() => (feedsQ.data ?? []).filter((f) => Boolean(f.enabled)), [feedsQ.data]);

  const [timelineWindow, setTimelineWindow] = useState<TimelineWindow>(readStoredWindow);
  const timelineQ = useAgentTimeline(timelineWindow);
  const timeline = timelineQ.data;
  // The axis follows the data on screen (it keeps showing the previous window
  // until the new payload lands), not the toggle.
  const dataWindow: TimelineWindow = timeline?.window ?? timelineWindow;
  const windowMs = TIMELINE_WINDOW_MS[dataWindow];
  const getNow = useTimelineClock(timeline?.generated_at, timelineQ.dataUpdatedAt);
  const liveIndex = useMemo(() => indexTimeline(timeline, feeds), [timeline, feeds]);
  const status: 'loading' | 'error' | 'ready' = timeline ? 'ready' : timelineQ.isError ? 'error' : 'loading';

  const placement = useMemo(() => placeAgents(agents), [agents]);
  const byName = useMemo(() => new Map(agents.map((a) => [a.name, a])), [agents]);
  const labelOf = useMemo(() => (id: string) => agentLabel(id, byName), [byName]);
  const identity = useIdentity(byName);

  const [hoverId, setHoverId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [fullscreen, setFullscreen] = useState(false);
  const [showRetired, setShowRetired] = useState(false);

  // ── Replay of the last hour, from the payload loaded when it was entered.
  // Refetches keep landing behind it but never move the playhead; Back to
  // live picks the newest payload up. The tape axis is frozen at entry
  // (`anchorMs`) so the playhead stays under the pointer when a scrub begins.
  const [replay, setReplay] = useState<{ snapshot: AgentTimeline; speed: ReplaySpeed; playing: boolean; anchorMs: number } | null>(null);
  const chooseWindow = (w: TimelineWindow) => {
    if (w === timelineWindow) return;
    storeWindow(w);
    setReplay(null);
    setTimelineWindow(w);
  };
  const playheadRef = useRef(0);
  const [playheadShown, setPlayheadShown] = useState(0);
  const range = useMemo(() => {
    if (!replay) return null;
    const end = Date.parse(replay.snapshot.window_end);
    // A page left open for over an hour can put the axis start after the data end.
    return { start: Math.min(Math.max(Date.parse(replay.snapshot.window_start), replay.anchorMs - TIMELINE_WINDOW_MS[replay.snapshot.window]), end), end };
  }, [replay]);
  const setPlayhead = useCallback((ms: number) => {
    playheadRef.current = ms;
    setPlayheadShown(ms);
  }, []);
  const replayIndex = useMemo(() => (replay
    // The live trust cap is about freshness; a replay shows the past as recorded.
    ? { ...indexTimeline(replay.snapshot, feeds), capMs: Infinity }
    : null), [replay, feeds]);
  const index = replayIndex ?? liveIndex;
  const liveGetNow = getNow;
  // Stable identity: the frame loops read the ref; `viewVersion` redraws static frames.
  const replayGetNow = useCallback(() => playheadRef.current, []);
  const viewNow = replay ? replayGetNow : liveGetNow;

  // Over an hour without a successful load: nothing left to replay.
  const dataTooOld = !!timeline && !replay && liveGetNow() - Date.parse(timeline.window_end) > windowMs;
  const atEnd = !!range && playheadShown >= range.end;
  const playing = !!replay?.playing && !reducedMotion && !atEnd;
  const tapeReplay = useMemo(
    () => (replay && range ? { anchorMs: replay.anchorMs, startMs: range.start, endMs: range.end, playing } : null),
    [replay, range, playing],
  );

  // Focus follows the control that replaced the focused one.
  const startRef = useRef<HTMLButtonElement | null>(null);
  const playRef = useRef<HTMLButtonElement | null>(null);
  const sliderRef = useRef<HTMLDivElement | null>(null);
  const pendingFocus = useRef<'transport' | 'slider' | 'start' | null>(null);
  useEffect(() => {
    const target = pendingFocus.current;
    if (!target) return;
    pendingFocus.current = null;
    (target === 'transport' ? playRef : target === 'slider' ? sliderRef : startRef).current?.focus();
  }, [replay]);

  const enterReplay = (at?: number, focus: 'transport' | 'slider' = 'transport') => {
    if (!timeline) return;
    const anchor = liveGetNow();
    const end = Date.parse(timeline.window_end);
    if (anchor - end > windowMs) return; // all of the data is older than the tape
    const start = Math.min(Math.max(Date.parse(timeline.window_start), anchor - windowMs), end);
    pendingFocus.current = focus;
    setReplay({ snapshot: timeline, speed: DEFAULT_REPLAY_SPEEDS[timeline.window], playing: at === undefined && !reducedMotion, anchorMs: anchor });
    setPlayhead(clampPlayhead(at ?? start, start, end));
  };
  const scrub = (ms: number) => {
    if (!replay) { enterReplay(ms, 'slider'); return; }
    setPlayhead(clampPlayhead(ms, range!.start, range!.end));
  };
  const backToLive = () => {
    pendingFocus.current = 'start';
    setReplay(null);
  };
  const togglePlay = () => {
    if (!replay || !range || reducedMotion) return;
    if (playing) { setReplay({ ...replay, playing: false }); return; }
    if (atEnd) setPlayhead(range.start);
    setReplay({ ...replay, playing: true });
  };
  // ←/→ on the slider or transport: 1 min (Shift: 10 s). From live, the first
  // step enters replay relative to the newest data.
  const moveBy = (direction: -1 | 1, fine: boolean) => {
    if (replay && range) {
      setPlayhead(stepPlayhead(playheadRef.current, direction, fine, range.start, range.end, replay.snapshot.window));
    } else if (timeline) {
      const base = Math.min(liveGetNow(), Date.parse(timeline.window_end));
      const st = SLIDER_STEPS[timeline.window];
      enterReplay(base + direction * (fine ? st.fine : st.coarse), 'slider');
    }
  };
  const sliderKey = (e: React.KeyboardEvent<HTMLElement>) => {
    if (!canHandleReplayKey(e)) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      moveBy(e.key === 'ArrowLeft' ? -1 : 1, e.shiftKey);
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      if (replay && range) setPlayhead(e.key === 'Home' ? range.start : range.end);
      else enterReplay(e.key === 'Home' ? 0 : Infinity, 'slider');
    } else if ((e.key === 'PageUp' || e.key === 'PageDown') && dataWindow === '24h') {
      e.preventDefault();
      const dir = e.key === 'PageUp' ? 1 : -1;
      if (replay && range) setPlayhead(pagePlayhead(playheadRef.current, dir, range.start, range.end, replay.snapshot.window));
      else if (timeline) enterReplay(Math.min(liveGetNow(), Date.parse(timeline.window_end)) + dir * (SLIDER_STEPS['24h'].page as number), 'slider');
    } else if (e.key === ' ' && replay) {
      e.preventDefault();
      togglePlay();
    }
  };

  // The replay clock: wall time scaled by the speed. Particles keep their
  // own wall-clock phase, so speed never changes how fast dots fly.
  useEffect(() => {
    if (!replay?.playing || reducedMotion || !range) return;
    let raf = 0;
    let last = performance.now();
    let shownAt = last;
    const tick = (nowPerf: number) => {
      const step = advancePlayhead(playheadRef.current, nowPerf - last, replay.speed, range.start, range.end);
      last = nowPerf;
      playheadRef.current = step.playhead;
      if (step.atEnd) { setPlayhead(step.playhead); setReplay((r) => (r ? { ...r, playing: false } : r)); return; }
      // React only needs the playhead for its label, at most 4 times a second.
      if (nowPerf - shownAt >= 250) { shownAt = nowPerf; setPlayheadShown(step.playhead); }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      // However play stopped (Pause, animation off, unmount), sync the shown
      // playhead so the chip, slider and atEnd match what the canvas drew.
      setPlayheadShown(playheadRef.current);
    };
  }, [replay?.playing, replay?.speed, reducedMotion, range, setPlayhead]);

  // Fullscreen behaves as a modal dialog: body scroll locked, focus moved to
  // the exit button on open and back to the toggle on close (same button).
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return; }
    exitRef.current?.focus();
  }, [fullscreen]);
  useEffect(() => {
    if (!fullscreen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [fullscreen]);

  // The detail panel lives outside the overlay, so choosing an agent in full
  // screen leaves full screen first and then selects.
  const onSelect = (name: string) => {
    if (fullscreen) setFullscreen(false);
    onSelectAgent(name);
  };

  // Tab cycles inside the dialog while it is open.
  const trapTab = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!fullscreen || e.key !== 'Tab' || !wrapEl) return;
    const items = Array.from(wrapEl.querySelectorAll<HTMLElement>(FOCUSABLE))
      .filter((el) => el.getAttribute('aria-hidden') !== 'true');
    if (!items.length) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === wrapEl || !wrapEl.contains(active))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (active === last || !wrapEl.contains(active))) { e.preventDefault(); first.focus(); }
  };

  const layoutWidth = Math.max(width, MIN_LAYOUT_WIDTH);
  const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 10) / 10));
  const pct = `${Math.round(zoom * 100)}%`;

  const truncated = timeline && (timeline.truncated.runs || timeline.truncated.pulls || timeline.truncated.events);

  const content = (
    <div
      ref={setWrapEl}
      data-testid="agent-network"
      data-hover={hoverId ?? ''}
      role={fullscreen ? 'dialog' : undefined}
      aria-modal={fullscreen ? true : undefined}
      aria-label={fullscreen ? 'Agent network, full screen' : undefined}
      // The dialog itself is focusable, so a click on a non-focusable part of
      // the overlay keeps focus (and Escape / the trap) inside it.
      tabIndex={fullscreen ? -1 : undefined}
      onKeyDown={(e) => {
        if (fullscreen && e.key === 'Escape') { e.stopPropagation(); setFullscreen(false); return; }
        trapTab(e);
      }}
      className={fullscreen ? 'fixed inset-0 z-50 overflow-auto p-4 space-y-3 outline-none' : 'space-y-3'}
      style={fullscreen ? { background: 'var(--bg-page)' } : undefined}
    >
      <style>{FOCUS_CSS}</style>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <ul className="flex flex-wrap gap-x-5 gap-y-1 list-none p-0 m-0" aria-label="Legend">
          {LEGEND.map((l) => (
            <li key={l.label} className="inline-flex items-center gap-2 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
              <Swatch kind={l.kind} />
              {l.label}
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
          <LiveChip
            replay={replay ? { playhead: playheadShown, newData: !!timeline && timeline.generated_at !== replay.snapshot.generated_at } : null}
            hasPayload={!!timeline}
            fetchFailed={timelineQ.isError}
            osReduced={osReduced}
            paused={paused}
            receivedAt={timelineQ.dataUpdatedAt}
            generatedAt={timeline?.generated_at}
            getNow={liveGetNow}
          />
          <ReplayControls
            active={!!replay}
            canStart={!!timeline && !dataTooOld}
            startHint={dataTooOld ? 'The data is more than an hour old. Waiting for newer data.' : undefined}
            playing={playing}
            speed={replay?.speed ?? DEFAULT_REPLAY_SPEEDS[dataWindow]}
            window={dataWindow}
            atEnd={atEnd}
            playDisabled={reducedMotion}
            onStart={() => enterReplay()}
            onPlayPause={togglePlay}
            onSpeed={(speed) => setReplay((r) => (r ? { ...r, speed } : r))}
            onBack={backToLive}
            onStep={moveBy}
            startRef={startRef}
            playRef={playRef}
          />
          <span aria-hidden="true" className="hidden sm:block w-px h-6" style={{ background: 'var(--border-base)' }} />
          <div className="flex items-center gap-1.5" role="group" aria-label="View">
            <CtrlButton
              aria-label={reducedMotion ? 'Turn animation on' : 'Turn animation off'}
              title={osReduced ? 'Animation is off (system reduced-motion setting)' : 'Animation'}
              disabled={osReduced}
              onClick={() => setPaused((p) => !p)}
            >
              <Wind size={14} style={{ opacity: reducedMotion ? 0.45 : 1 }} />
            </CtrlButton>
            <CtrlButton aria-label={`Zoom out (${pct})`} onClick={() => setZoom((z) => clampZoom(z - ZOOM_STEP))} disabled={zoom <= ZOOM_MIN}><ZoomOut size={14} /></CtrlButton>
            <CtrlButton aria-label={`Zoom in (${pct})`} onClick={() => setZoom((z) => clampZoom(z + ZOOM_STEP))} disabled={zoom >= ZOOM_MAX}><ZoomIn size={14} /></CtrlButton>
            <CtrlButton aria-label={`Reset zoom (${pct})`} onClick={() => setZoom(1)} disabled={zoom === 1}><RotateCcw size={14} /></CtrlButton>
            <CtrlButton
              buttonRef={exitRef}
              aria-label={fullscreen ? 'Exit full screen' : 'Full screen'}
              onClick={() => setFullscreen((f) => !f)}
            >
              {fullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </CtrlButton>
          </div>
        </div>
      </div>

      {(status === 'error' || feedsQ.isError) && (
        <div className="flex items-center gap-3 font-mono text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
          {status === 'error' && (
            <>
              <span role="status">Live timeline unavailable. Showing the map without motion.</span>
              <Chip onClick={() => { void timelineQ.refetch(); }}>Retry</Chip>
            </>
          )}
          {feedsQ.isError && (
            <>
              <span>Feed list unavailable. The feed lane is empty.</span>
              <Chip onClick={() => { void feedsQ.refetch(); }}>Retry feeds</Chip>
            </>
          )}
        </div>
      )}

      <div
        className="agn-scroll rounded-lg overflow-auto"
        role="region"
        aria-label="Agent data-flow map (scrollable)"
        tabIndex={0}
        style={{ background: 'var(--bg-card)', border: '1px solid var(--border-base)' }}
      >
        <FlowCanvas
          byName={byName}
          feeds={feeds}
          index={index}
          hasTimeline={!!timeline || !!replay}
          getNow={viewNow}
          hoverId={hoverId}
          onHover={setHoverId}
          selected={selectedAgent}
          onSelect={onSelect}
          zoom={zoom}
          width={layoutWidth}
          reducedMotion={reducedMotion}
          replay={!!replay}
          playing={playing}
          viewVersion={playheadShown}
          identity={identity}
          placement={placement}
        />
      </div>

      {(placement.onDemand.length > 0 || placement.retired.length > 0) && (
        <div
          className="flex flex-wrap items-center gap-2 px-3"
          role="group"
          aria-label="On-demand and retired agents"
          data-testid="network-rails"
        >
          {placement.onDemand.length > 0 && (
            <>
              <span className="font-mono text-[10px] tracking-[0.14em] uppercase" style={{ color: 'var(--text-muted)' }}>On demand</span>
              {placement.onDemand.map((id) => (
                <Chip key={id} onClick={() => onSelect(id)}>{labelOf(id)}</Chip>
              ))}
            </>
          )}
          {placement.retired.length > 0 && (
            <>
              <Chip muted aria-expanded={showRetired} onClick={() => setShowRetired((v) => !v)}>
                Retired ({placement.retired.length}) {showRetired ? '−' : '+'}
              </Chip>
              {showRetired && placement.retired.map((id) => (
                <Chip key={id} muted onClick={() => onSelect(id)}>{labelOf(id)}</Chip>
              ))}
            </>
          )}
        </div>
      )}

      <section
        className="agn-scroll rounded-lg overflow-x-auto"
        role="region"
        aria-labelledby="agn-tape-title"
        aria-describedby={replay ? 'agn-tape-hint agn-tape-note' : 'agn-tape-hint'}
        tabIndex={0}
        style={{ background: 'var(--bg-card)', border: '1px solid var(--border-base)' }}
      >
        <h3
          id="agn-tape-title"
          className="font-mono text-[10px] tracking-[0.14em] uppercase px-3 pt-3 m-0 font-medium"
          style={{ color: 'var(--text-muted)' }}
        >
          Run tape · {dataWindow === '24h' ? 'last 24 hours' : 'last hour'} (UTC)
        </h3>
        <div className="flex items-center gap-2 px-3 pt-2" role="group" aria-label="Timeline window">
          {(['1h', '24h'] as const).map((w) => {
            const on = timelineWindow === w;
            return (
              <button
                key={w}
                type="button"
                className="agn-btn h-7 px-2.5 rounded font-mono text-[11px]"
                style={{
                  color: on ? 'var(--text-primary)' : 'var(--text-secondary)',
                  background: on ? 'var(--primary-tint)' : 'var(--bg-card-deep)',
                  border: `1px solid ${on ? 'var(--primary-border)' : 'var(--border-base)'}`,
                  fontWeight: on ? 600 : 400,
                }}
                aria-pressed={on}
                aria-label={w === '1h' ? 'Last hour' : 'Last 24 hours'}
                onClick={() => chooseWindow(w)}
              >
                {w}
              </button>
            );
          })}
        </div>
        <p id="agn-tape-hint" className="font-mono text-[10px] px-3 m-0 mt-1" style={{ color: 'var(--text-tertiary)' }}>
          {replay
            ? (dataWindow === '24h'
              ? 'Drag the time scale, or press ← → to move 10 minutes (Shift: 1 minute, PageUp or PageDown: 1 hour). Space plays or pauses.'
              : 'Drag the time scale, or press ← → to move 1 minute (Shift: 10 seconds). Space plays or pauses.')
            : `Click or drag the time scale above the bars to replay the last ${dataWindow === '24h' ? '24 hours' : 'hour'}.`}
        </p>
        <span id="agn-tape-note" className="sr-only">{BREAKER_NOTE}</span>
        <RunTape
          placement={placement}
          index={index}
          status={replay ? 'ready' : status}
          getNow={viewNow}
          hoverId={hoverId}
          onHover={setHoverId}
          selected={selectedAgent}
          onSelect={onSelect}
          labelOf={labelOf}
          width={Math.max(width - 2, 0)}
          reducedMotion={reducedMotion}
          replay={tapeReplay}
          viewVersion={playheadShown}
          onScrub={timeline ? scrub : undefined}
          onSliderKey={sliderKey}
          sliderRef={sliderRef}
          windowMs={windowMs}
          identity={identity}
        />
        {truncated && (
          <div className="font-mono text-[10px] px-3 pb-2" style={{ color: 'var(--text-tertiary)' }}>
            The timeline hit its row limit; the oldest runs are not shown.
          </div>
        )}
      </section>
    </div>
  );

  // Portal to <body>: a Card ancestor (backdrop-filter, overflow hidden)
  // would otherwise be the containing block of the fixed overlay.
  return fullscreen ? createPortal(content, document.body) : content;
}
