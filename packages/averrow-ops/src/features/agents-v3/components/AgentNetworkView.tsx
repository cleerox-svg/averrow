// AgentNetworkView v2 — full-mesh interactive map with running pulse + comm bursts.
//
// Iteration 2 over the trigger-chain-only first cut. Now shows ALL
// 40 agents arranged in hand-positioned neighborhoods by category:
//   - Top centre: Flight Control (supervisor)
//   - Left half: Intelligence trigger chain + surveillance scanners
//   - Top right: Platform ops (navigator, enricher, cube_healer,
//     geoip_refresh, curator, watchdog)
//   - Right side: Sparrow (response)
//   - Bottom right: 13 sync agents in a 4×4 grid
//
// Each circle now uses the agent's bespoke <AgentIcon /> SVG (was a
// 2-letter initial). Names below the circle stay always-visible —
// at this density they're the most useful affordance.
//
// Live signal:
//   - Pulsing amber edge: upstream agent ran in last 10 min
//   - Comm burst (particle traveling along edge): upstream AND
//     downstream both ran within the last 60s — implies recent
//     event hand-off
//   - Running pulse (animated halo around node): agent's last_run_at
//     is within 60s
//   - Failure ring (red): circuit_state='tripped' OR last_run_status='failed'
//   - Selection halo: animated amber halo around selected node
//
// All visuals are pure SVG with CSS-var colors → flips with theme.

import { useMemo } from 'react';
import type { Agent } from '@/hooks/useAgents';
import { AGENT_METADATA, type AgentId } from '@/lib/agent-metadata';
import { AgentIcon } from '@/components/brand/AgentIcon';

const VIEWBOX_W = 1280;
const VIEWBOX_H = 780;
const NODE_R    = 22;
const ICON_SIZE = 24;
const FLY_WINDOW_MS     = 10 * 60 * 1000; // 10-min "in flight" window
const RUNNING_WINDOW_MS = 60 * 1000;       // 60s = "running right now"
const BURST_WINDOW_MS   = 60 * 1000;       // 60s correlation window for bursts

interface NodePos { x: number; y: number; }

// ─── Layout — hand-positioned neighborhoods by category ───────────
//
// Tweaks here move nodes; rebuild predictably. Keep groups visually
// separated (≥120px gap between cluster boundaries) so the viewer
// can identify "where do the sync agents live" at a glance.
const LAYOUT: Record<string, NodePos> = {
  // SUPERVISOR
  flight_control:           { x: 620, y:  60 },

  // INTELLIGENCE — trigger chain visible left → right
  sentinel:                 { x: 100, y: 200 },
  cartographer:             { x: 240, y: 200 },
  nexus:                    { x: 380, y: 200 },
  attributor:               { x: 380, y: 290 },
  analyst:                  { x: 520, y: 150 },
  observer:                 { x: 520, y: 240 },
  strategist:               { x: 520, y: 330 },
  news_watcher:             { x: 380, y: 380 },
  pathfinder:               { x: 660, y: 150 },
  narrator:                 { x: 660, y: 240 },
  notification_narrator:    { x: 660, y: 330 },
  seed_strategist:          { x: 660, y: 410 },
  auto_seeder:              { x: 780, y: 410 },

  // SURVEILLANCE — bottom left
  social_discovery:         { x: 100, y: 470 },
  lookalike_scanner:        { x: 240, y: 470 },
  app_store_monitor:        { x: 380, y: 470 },
  social_monitor:           { x: 100, y: 570 },
  dark_web_monitor:         { x: 240, y: 570 },

  // RESPONSE
  sparrow:                  { x: 780, y: 240 },

  // PLATFORM OPS — top right
  navigator:                { x: 920, y: 150 },
  enricher:                 { x: 1080, y: 150 },
  cube_healer:              { x: 920, y: 250 },
  geoip_refresh:            { x: 1080, y: 250 },
  watchdog:                 { x: 920, y: 350 },
  curator:                  { x: 1080, y: 350 },

  // SYNC AI — bottom right 4×4-ish grid
  public_trust_check:       { x:  900, y: 480 },
  url_scan:                 { x:  990, y: 480 },
  scan_report:              { x: 1080, y: 480 },
  brand_analysis:           { x: 1170, y: 480 },
  brand_report:             { x:  900, y: 560 },
  brand_deep_scan:          { x:  990, y: 560 },
  brand_enricher:           { x: 1080, y: 560 },
  honeypot_generator:       { x: 1170, y: 560 },
  admin_classify:           { x:  900, y: 640 },
  qualified_report:         { x:  990, y: 640 },
  evidence_assembler:       { x: 1080, y: 640 },
  social_ai_assessor:       { x: 1170, y: 640 },
  geo_campaign_assessment:  { x:  990, y: 720 },
};

// ─── Edges (trigger chain) ─────────────────────────────────────────
const EDGES: Array<[string, string]> = [
  ['sentinel',        'cartographer'],
  ['cartographer',    'nexus'],
  ['nexus',           'analyst'],
  ['nexus',           'observer'],
  ['nexus',           'attributor'],
  ['analyst',         'pathfinder'],
  ['observer',        'narrator'],
  ['observer',        'seed_strategist'],
  ['seed_strategist', 'auto_seeder'],
];

// ─── Supervision edges (Flight Control → workers) ─────────────────
//
// FC supervises the entire mesh, but rendering 40 dashed lines from
// one point would be visual noise. Show the headline supervised
// agents (pipeline backbone) and let the tooltip explain.
const SUPERVISION_TARGETS: string[] = [
  'sentinel', 'cartographer', 'nexus', 'analyst', 'observer',
  'sparrow', 'pathfinder',
];

// ─── Headers labelling each cluster region ────────────────────────
const CLUSTER_HEADERS: Array<{ x: number; y: number; label: string }> = [
  { x: 100, y: 130, label: 'Intelligence' },
  { x: 100, y: 440, label: 'Surveillance' },
  { x: 920, y:  90, label: 'Platform Ops' },
  { x: 900, y: 450, label: 'Synchronous AI' },
];

interface AgentNetworkViewProps {
  agents:        Agent[];
  selectedAgent: string | null;
  onSelect:      (name: string) => void;
}

export function AgentNetworkView({ agents, selectedAgent, onSelect }: AgentNetworkViewProps) {
  const byName = useMemo(() => {
    const m = new Map<string, Agent>();
    for (const a of agents) m.set(a.name, a);
    return m;
  }, [agents]);

  const now = Date.now();

  function ranWithin(name: string, ms: number): boolean {
    const a = byName.get(name);
    if (!a?.last_run_at) return false;
    return now - new Date(a.last_run_at).getTime() < ms;
  }

  // Edges where the upstream agent ran in the last 10 minutes
  const pulsingEdges = useMemo(() => {
    const set = new Set<string>();
    for (const [from, to] of EDGES) {
      if (ranWithin(from, FLY_WINDOW_MS)) set.add(`${from}→${to}`);
    }
    return set;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [byName, now]);

  // Comm bursts — upstream AND downstream both ran in the last 60s
  const burstingEdges = useMemo(() => {
    const set = new Set<string>();
    for (const [from, to] of EDGES) {
      if (ranWithin(from, BURST_WINDOW_MS) && ranWithin(to, BURST_WINDOW_MS)) {
        set.add(`${from}→${to}`);
      }
    }
    return set;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [byName, now]);

  // Highlight: 1-hop subgraph for the selected node
  function nodeOpacity(name: string): number {
    if (!selectedAgent) return 1;
    if (name === selectedAgent) return 1;
    const isNeighbour = EDGES.some(([f, t]) =>
      (f === selectedAgent && t === name) ||
      (t === selectedAgent && f === name)
    );
    if (isNeighbour) return 1;
    if (name === 'flight_control' && SUPERVISION_TARGETS.includes(selectedAgent)) return 0.6;
    return 0.18;
  }
  function edgeOpacity(from: string, to: string): number {
    if (!selectedAgent) return 0.55;
    if (from === selectedAgent || to === selectedAgent) return 1;
    return 0.08;
  }
  function supervisionOpacity(target: string): number {
    if (!selectedAgent) return 0.16;
    if (target === selectedAgent) return 0.7;
    return 0.05;
  }

  return (
    <div className="w-full">
      <svg
        viewBox={`0 0 ${VIEWBOX_W} ${VIEWBOX_H}`}
        preserveAspectRatio="xMidYMid meet"
        className="w-full h-auto"
        style={{ maxHeight: 760 }}
      >
        <defs>
          <marker
            id="arrow"
            viewBox="0 0 10 10"
            refX="9" refY="5"
            markerWidth="6" markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--text-tertiary)" />
          </marker>
          <marker
            id="arrow-amber"
            viewBox="0 0 10 10"
            refX="9" refY="5"
            markerWidth="6" markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--amber)" />
          </marker>
        </defs>

        {/* Cluster region labels */}
        {CLUSTER_HEADERS.map(h => (
          <text
            key={h.label}
            x={h.x}
            y={h.y}
            fontFamily="var(--font-mono)"
            fontSize={9}
            fontWeight={700}
            fill="var(--text-tertiary)"
            style={{ letterSpacing: '0.20em' }}
          >
            {h.label.toUpperCase()}
          </text>
        ))}

        {/* Supervision edges (Flight Control → workers) — dashed, muted */}
        {SUPERVISION_TARGETS.map(target => {
          const fc  = LAYOUT.flight_control;
          const pos = LAYOUT[target];
          if (!pos) return null;
          return (
            <line
              key={`sup-${target}`}
              x1={fc.x} y1={fc.y + NODE_R}
              x2={pos.x} y2={pos.y - NODE_R}
              stroke="var(--text-muted)"
              strokeWidth={1}
              strokeDasharray="3 4"
              opacity={supervisionOpacity(target)}
            />
          );
        })}

        {/* Trigger-chain edges */}
        {EDGES.map(([from, to]) => {
          const a = LAYOUT[from];
          const b = LAYOUT[to];
          if (!a || !b) return null;
          const pulsing  = pulsingEdges.has(`${from}→${to}`);
          const bursting = burstingEdges.has(`${from}→${to}`);
          const opacity = edgeOpacity(from, to);
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const len = Math.hypot(dx, dy);
          const ux = dx / len;
          const uy = dy / len;
          const x1 = a.x + ux * NODE_R;
          const y1 = a.y + uy * NODE_R;
          const x2 = b.x - ux * (NODE_R + 4);
          const y2 = b.y - uy * (NODE_R + 4);
          const pathId = `path-${from}-${to}`;
          return (
            <g key={`edge-${from}-${to}`} opacity={opacity}>
              {/* Defined path used by both line + animateMotion */}
              <path
                id={pathId}
                d={`M ${x1} ${y1} L ${x2} ${y2}`}
                stroke={pulsing ? 'var(--amber)' : 'var(--text-tertiary)'}
                strokeWidth={pulsing ? 2 : 1.4}
                fill="none"
                markerEnd={pulsing ? 'url(#arrow-amber)' : 'url(#arrow)'}
              />
              {pulsing && (
                <line
                  x1={x1} y1={y1} x2={x2} y2={y2}
                  stroke="var(--amber)"
                  strokeWidth={6}
                  strokeLinecap="round"
                  opacity={0.25}
                >
                  <animate
                    attributeName="opacity"
                    values="0.05; 0.45; 0.05"
                    dur="2s"
                    repeatCount="indefinite"
                  />
                </line>
              )}
              {bursting && (
                <circle r={4} fill="var(--amber)">
                  <animateMotion
                    dur="1.4s"
                    repeatCount="indefinite"
                    path={`M ${x1} ${y1} L ${x2} ${y2}`}
                  />
                  <animate
                    attributeName="opacity"
                    values="0.0; 1.0; 1.0; 0.0"
                    keyTimes="0; 0.15; 0.85; 1"
                    dur="1.4s"
                    repeatCount="indefinite"
                  />
                </circle>
              )}
            </g>
          );
        })}

        {/* Nodes */}
        {Object.entries(LAYOUT).map(([name, pos]) => {
          const meta    = AGENT_METADATA[name as AgentId];
          const agent   = byName.get(name);
          const op      = nodeOpacity(name);
          const isSel   = selectedAgent === name;
          const isSupervisor = name === 'flight_control';
          const failing = agent?.circuit_state === 'tripped' || agent?.last_run_status === 'failed';
          const running = ranWithin(name, RUNNING_WINDOW_MS);
          const tint    = isSupervisor ? 'var(--amber)' : (meta?.color ?? 'var(--blue)');
          return (
            <g
              key={name}
              opacity={op}
              transform={`translate(${pos.x},${pos.y})`}
              style={{ cursor: 'pointer' }}
              onClick={() => onSelect(name)}
            >
              {/* Selection halo (animated amber) */}
              {isSel && (
                <circle
                  r={NODE_R + 8}
                  fill="none"
                  stroke="var(--amber)"
                  strokeWidth={2}
                  opacity={0.7}
                >
                  <animate
                    attributeName="r"
                    values={`${NODE_R + 6}; ${NODE_R + 12}; ${NODE_R + 6}`}
                    dur="2s"
                    repeatCount="indefinite"
                  />
                </circle>
              )}
              {/* Running pulse (animated colored halo) */}
              {running && !isSel && (
                <circle
                  r={NODE_R + 4}
                  fill="none"
                  stroke={tint}
                  strokeWidth={2}
                  opacity={0.6}
                >
                  <animate
                    attributeName="r"
                    values={`${NODE_R + 2}; ${NODE_R + 10}; ${NODE_R + 2}`}
                    dur="1.6s"
                    repeatCount="indefinite"
                  />
                  <animate
                    attributeName="opacity"
                    values="0.7; 0.0; 0.7"
                    dur="1.6s"
                    repeatCount="indefinite"
                  />
                </circle>
              )}
              {/* Failure ring */}
              {failing && !isSel && (
                <circle
                  r={NODE_R + 4}
                  fill="none"
                  stroke="var(--sev-critical)"
                  strokeWidth={1.5}
                  opacity={0.8}
                />
              )}
              <circle
                r={NODE_R}
                fill={tint}
                fillOpacity={isSupervisor ? 0.20 : 0.16}
                stroke={tint}
                strokeWidth={isSupervisor ? 2 : 1.4}
              />
              {/* AgentIcon — embedded via foreignObject so the
                  bespoke per-agent SVG art renders inside the node */}
              <foreignObject
                x={-ICON_SIZE / 2}
                y={-ICON_SIZE / 2}
                width={ICON_SIZE}
                height={ICON_SIZE}
                style={{ color: tint }}
              >
                <div style={{
                  width: ICON_SIZE,
                  height: ICON_SIZE,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: tint,
                }}>
                  <AgentIcon agent={name} size={ICON_SIZE} />
                </div>
              </foreignObject>
              {/* Agent name below the node */}
              <text
                y={NODE_R + 14}
                textAnchor="middle"
                fontFamily="var(--font-mono)"
                fontSize={9}
                fontWeight={isSel ? 700 : 500}
                fill={isSel ? 'var(--text-primary)' : 'var(--text-secondary)'}
                style={{ letterSpacing: '0.06em' }}
              >
                {meta?.displayName ?? name}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="flex items-center gap-4 mt-2 font-mono text-[9px] tracking-wide uppercase flex-wrap" style={{ color: 'var(--text-tertiary)' }}>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-3 h-3 rounded-full" style={{ background: 'var(--amber)' }} />
          Supervisor
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-6 h-px" style={{ background: 'var(--text-tertiary)' }} />
          Trigger edge
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-6 h-0.5 rounded" style={{ background: 'var(--amber)' }} />
          In flight (last 10m)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-2 h-2 rounded-full" style={{ background: 'var(--amber)' }} />
          Comm burst (both ran ≤ 60s)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-3 h-3 rounded-full border-2" style={{ borderColor: 'var(--amber)' }} />
          Running now (≤ 60s)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-6 h-px" style={{ background: 'var(--text-muted)', borderTop: '1px dashed var(--text-muted)' }} />
          Supervision
        </span>
      </div>
    </div>
  );
}
