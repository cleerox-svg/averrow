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

import { useEffect, useMemo, useRef, useState } from 'react';
import { Maximize2, Minimize2, RotateCcw, ZoomIn, ZoomOut } from 'lucide-react';
import type { Agent } from '@/hooks/useAgents';
import { useFeeds } from '@/hooks/useFeeds';
import { useAgentTimeline, useTimelineClock } from '@/hooks/useAgentTimeline';
import { FlowCanvas, agentLabel } from '../network/FlowCanvas';
import { RunTape } from '../network/RunTape';
import { indexTimeline } from '../network/activity';
import { MIN_LAYOUT_WIDTH, placeAgents } from '../network/model';
import { useElementWidth, useReducedMotionPref } from '../network/useCanvasLoop';

const ZOOM_MIN = 0.6;
const ZOOM_MAX = 1.6;
const ZOOM_STEP = 0.2;

interface AgentNetworkViewProps {
  agents:        Agent[];
  selectedAgent: string | null;
  onSelect:      (name: string) => void;
}

function CtrlButton({
  onClick, disabled, children, ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="w-8 h-8 rounded grid place-items-center transition-colors disabled:opacity-40"
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

function Chip({ children, onClick, muted }: { children: React.ReactNode; onClick: () => void; muted?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="font-mono text-[10px] px-2 py-1 rounded transition-colors"
      style={{
        background: 'var(--bg-card-deep)',
        border: '1px solid var(--border-base)',
        color: muted ? 'var(--text-tertiary)' : 'var(--text-secondary)',
      }}
    >
      {children}
    </button>
  );
}

const LEGEND: Array<{ swatch: string; label: string; dashed?: boolean }> = [
  { swatch: 'var(--primary)', label: 'Running now' },
  { swatch: 'var(--primary-text)', label: 'Data in transit' },
  { swatch: 'var(--sev-critical)', label: 'Last run failed' },
  { swatch: 'var(--border-base)', label: 'Idle link' },
  { swatch: 'var(--primary-text)', label: 'Dashed: event hand-off (pivot_detected)', dashed: true },
];

export function AgentNetworkView({ agents, selectedAgent, onSelect }: AgentNetworkViewProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const width = useElementWidth(wrapRef);
  const reducedMotion = useReducedMotionPref();

  const { data: feedsData = [] } = useFeeds();
  const feeds = useMemo(() => feedsData.filter((f) => Boolean(f.enabled)), [feedsData]);

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

  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFullscreen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreen]);

  const layoutWidth = Math.max(width, MIN_LAYOUT_WIDTH);
  const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 10) / 10));

  const truncated = timeline && (timeline.truncated.runs || timeline.truncated.pulls || timeline.truncated.events);

  return (
    <div
      ref={wrapRef}
      data-testid="agent-network"
      data-hover={hoverId ?? ''}
      className={fullscreen ? 'fixed inset-0 z-50 overflow-auto p-4 space-y-3' : 'space-y-3'}
      style={fullscreen ? { background: 'var(--bg-page)' } : undefined}
    >
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex flex-wrap gap-x-5 gap-y-1" aria-label="Legend">
          {LEGEND.map((l) => (
            <span key={l.label} className="inline-flex items-center gap-2 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
              <i
                aria-hidden="true"
                style={{
                  display: 'inline-block', width: l.dashed ? 16 : 10, height: l.dashed ? 0 : 10,
                  borderRadius: l.dashed ? 0 : 999,
                  background: l.dashed ? 'transparent' : l.swatch,
                  borderTop: l.dashed ? `2px dashed ${l.swatch}` : undefined,
                }}
              />
              {l.label}
            </span>
          ))}
        </div>
        <div className="flex gap-1.5">
          <CtrlButton aria-label="Zoom out" onClick={() => setZoom((z) => clampZoom(z - ZOOM_STEP))} disabled={zoom <= ZOOM_MIN}><ZoomOut size={14} /></CtrlButton>
          <CtrlButton aria-label="Zoom in" onClick={() => setZoom((z) => clampZoom(z + ZOOM_STEP))} disabled={zoom >= ZOOM_MAX}><ZoomIn size={14} /></CtrlButton>
          <CtrlButton aria-label="Reset zoom" onClick={() => setZoom(1)} disabled={zoom === 1}><RotateCcw size={14} /></CtrlButton>
          <CtrlButton
            aria-label={fullscreen ? 'Exit full screen' : 'Full screen'}
            onClick={() => setFullscreen((f) => !f)}
          >
            {fullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </CtrlButton>
        </div>
      </div>

      {status === 'error' && (
        <div role="status" className="font-mono text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
          Live timeline unavailable. Showing the map without motion.
        </div>
      )}

      <div
        className="rounded-lg overflow-auto"
        style={{ background: 'var(--bg-card)', border: '1px solid var(--border-base)' }}
      >
        <FlowCanvas
          agents={agents}
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
        <div className="flex flex-wrap items-center gap-2" data-testid="network-rails">
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
              <Chip muted onClick={() => setShowRetired((v) => !v)}>
                Retired ({placement.retired.length}) {showRetired ? '−' : '+'}
              </Chip>
              {showRetired && placement.retired.map((id) => (
                <Chip key={id} muted onClick={() => onSelect(id)}>{labelOf(id)}</Chip>
              ))}
            </>
          )}
        </div>
      )}

      <div
        className="rounded-lg overflow-x-auto"
        style={{ background: 'var(--bg-card)', border: '1px solid var(--border-base)' }}
      >
        <div className="font-mono text-[10px] tracking-[0.14em] uppercase px-3 pt-3" style={{ color: 'var(--text-muted)' }}>
          Run tape · last hour (UTC)
        </div>
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
      </div>
    </div>
  );
}
