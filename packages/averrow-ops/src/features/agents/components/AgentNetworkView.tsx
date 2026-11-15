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

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Maximize2, Minimize2, Pause, Play, RotateCcw, ZoomIn, ZoomOut } from 'lucide-react';
import { useReducedMotion } from '@averrow/shared/ui';
import type { Agent } from '@/hooks/useAgents';
import { useFeeds } from '@/hooks/useFeeds';
import { useAgentTimeline, useTimelineClock } from '@/hooks/useAgentTimeline';
import { FlowCanvas, agentLabel } from '../network/FlowCanvas';
import { RunTape } from '../network/RunTape';
import { indexTimeline } from '../network/activity';
import { MIN_LAYOUT_WIDTH, placeAgents } from '../network/model';
import { useElementWidth, useMountedElement } from '../network/useCanvasLoop';

const ZOOM_MIN = 0.6;
const ZOOM_MAX = 1.6;
const ZOOM_STEP = 0.2;

// Focus styling for the canvas wrappers, scroll regions and small controls.
const FOCUS_CSS = `
.agn-btn:focus-visible,.agn-chip:focus-visible{outline:2px solid var(--focus-ring);outline-offset:2px}
.agn-scroll:focus-visible{outline:2px solid var(--focus-ring);outline-offset:-2px}
.agn-ring-within:has(:focus-visible){outline:2px solid var(--focus-ring);outline-offset:-2px}
.agn-btn[aria-disabled="true"]{opacity:.4;cursor:default}
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

type SwatchKind = 'running' | 'transit' | 'failed' | 'partial' | 'idle' | 'event';
const LEGEND: Array<{ kind: SwatchKind; label: string }> = [
  { kind: 'running', label: 'Running now' },
  { kind: 'transit', label: 'Data in transit' },
  { kind: 'failed', label: 'Last run failed' },
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
    case 'failed': // hollow red ring
      return <i aria-hidden="true" style={{ ...base, width: 12, height: 12, borderRadius: 999, border: '2px solid var(--sev-critical)' }} />;
    case 'partial': // amber-ish status bar
      return <i aria-hidden="true" style={{ ...base, width: 16, height: 6, borderRadius: 2, background: 'var(--sev-medium)' }} />;
    case 'idle':
      return <i aria-hidden="true" style={{ ...base, width: 16, height: 0, borderTop: '2px solid var(--text-muted)', opacity: 0.45 }} />;
    case 'event':
      return <i aria-hidden="true" style={{ ...base, width: 16, height: 0, borderTop: '2px dashed var(--primary-text)' }} />;
  }
}

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

  const timelineQ = useAgentTimeline();
  const timeline = timelineQ.data;
  const getNow = useTimelineClock(timeline?.generated_at, timelineQ.dataUpdatedAt);
  const index = useMemo(() => indexTimeline(timeline, feeds), [timeline, feeds]);
  const status: 'loading' | 'error' | 'ready' = timeline ? 'ready' : timelineQ.isError ? 'error' : 'loading';

  const placement = useMemo(() => placeAgents(agents), [agents]);
  const byName = useMemo(() => new Map(agents.map((a) => [a.name, a])), [agents]);
  const labelOf = useMemo(() => (id: string) => agentLabel(id, byName), [byName]);

  const [hoverId, setHoverId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [fullscreen, setFullscreen] = useState(false);
  const [showRetired, setShowRetired] = useState(false);

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
    if (e.shiftKey && (active === first || !wrapEl.contains(active))) { e.preventDefault(); last.focus(); }
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
      onKeyDown={(e) => {
        if (fullscreen && e.key === 'Escape') { e.stopPropagation(); setFullscreen(false); return; }
        trapTab(e);
      }}
      className={fullscreen ? 'fixed inset-0 z-50 overflow-auto p-4 space-y-3' : 'space-y-3'}
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
        <div className="flex gap-1.5">
          <CtrlButton
            aria-label={paused || osReduced ? 'Play motion' : 'Pause motion'}
            aria-pressed={reducedMotion}
            title={osReduced ? 'Motion is off (system reduced-motion setting)' : undefined}
            disabled={osReduced}
            onClick={() => setPaused((p) => !p)}
          >
            {reducedMotion ? <Play size={14} /> : <Pause size={14} />}
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
          hasTimeline={!!timeline}
          getNow={getNow}
          hoverId={hoverId}
          onHover={setHoverId}
          selected={selectedAgent}
          onSelect={onSelect}
          zoom={zoom}
          width={layoutWidth}
          reducedMotion={reducedMotion}
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
        tabIndex={0}
        style={{ background: 'var(--bg-card)', border: '1px solid var(--border-base)' }}
      >
        <h3
          id="agn-tape-title"
          className="font-mono text-[10px] tracking-[0.14em] uppercase px-3 pt-3 m-0 font-medium"
          style={{ color: 'var(--text-muted)' }}
        >
          Run tape · last hour (UTC)
        </h3>
        <RunTape
          placement={placement}
          index={index}
          status={status}
          getNow={getNow}
          hoverId={hoverId}
          onHover={setHoverId}
          selected={selectedAgent}
          onSelect={onSelect}
          labelOf={labelOf}
          width={Math.max(width - 2, 0)}
          reducedMotion={reducedMotion}
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
