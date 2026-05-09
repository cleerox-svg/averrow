// AgentNetworkView — interactive SVG mind-map of the agent mesh.
//
// Renders the trigger chain as a layered DAG with Flight Control as
// the supervisor at top. Edges where the upstream agent ran in the
// last 10 minutes pulse to indicate "work in flight." Click any
// node to spotlight its connected subgraph (others fade) and select
// the agent in the parent grid (existing detail panel opens below).
//
// Layout strategy: hand-positioned by pipeline stage (cols 0..6).
// Force-directed sim is overkill for ~10 nodes with a known DAG.
// Sync agents + ops cluster intentionally omitted from this view —
// they have no inter-agent edges and would clutter the picture.
//
// All visuals are pure SVG with CSS-var colors, so the view flips
// with [data-theme] for free.

import { useMemo } from 'react';
import type { Agent } from '@/hooks/useAgents';
import { AGENT_METADATA, type AgentId } from '@/lib/agent-metadata';

const VIEWBOX_W = 800;
const VIEWBOX_H = 460;
const NODE_R    = 26;
const FLY_WINDOW_MS = 10 * 60 * 1000; // 10-min "in flight" window

interface NodePos { x: number; y: number; }

// Hand-tuned positions — keeps the DAG legible at this scale.
// Columns flow left → right (event time); supervisor sits above.
const LAYOUT: Record<string, NodePos> = {
  flight_control:  { x: 400, y:  60 },
  sentinel:        { x:  90, y: 230 },
  cartographer:    { x: 220, y: 230 },
  nexus:           { x: 350, y: 230 },
  attributor:      { x: 350, y: 380 },
  observer:        { x: 480, y: 290 },
  analyst:         { x: 480, y: 170 },
  pathfinder:      { x: 610, y: 170 },
  narrator:        { x: 610, y: 290 },
  seed_strategist: { x: 610, y: 400 },
  auto_seeder:     { x: 740, y: 400 },
};

// Edges (trigger chain). Same source-of-truth as TRIGGER_CHAIN in
// the parent file — duplicated here in node-pair form for the
// renderer. Keep in sync if the chain changes.
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

// Flight Control's supervision edges — rendered with a different
// stroke style (dashed, muted) so they don't compete with the
// trigger-chain edges.
const SUPERVISION_TARGETS: string[] = [
  'sentinel', 'cartographer', 'nexus', 'analyst', 'observer',
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

  // Compute which edges should pulse — upstream agent ran recently.
  const pulsingEdges = useMemo(() => {
    const now = Date.now();
    const set = new Set<string>();
    for (const [from, to] of EDGES) {
      const a = byName.get(from);
      if (!a?.last_run_at) continue;
      if (now - new Date(a.last_run_at).getTime() < FLY_WINDOW_MS) {
        set.add(`${from}→${to}`);
      }
    }
    return set;
  }, [byName]);

  // Highlight rule: when nothing is selected, show all at full
  // opacity. When selected, full opacity for the selected node + its
  // direct neighbours (1 hop), 0.20 for the rest.
  function nodeOpacity(name: string): number {
    if (!selectedAgent) return 1;
    if (name === selectedAgent) return 1;
    const isNeighbour = EDGES.some(([f, t]) =>
      (f === selectedAgent && t === name) ||
      (t === selectedAgent && f === name)
    );
    if (isNeighbour) return 1;
    if (name === 'flight_control' && SUPERVISION_TARGETS.includes(selectedAgent)) return 0.6;
    return 0.20;
  }
  function edgeOpacity(from: string, to: string): number {
    if (!selectedAgent) return 0.55;
    if (from === selectedAgent || to === selectedAgent) return 1;
    return 0.10;
  }
  function supervisionOpacity(target: string): number {
    if (!selectedAgent) return 0.18;
    if (target === selectedAgent) return 0.7;
    return 0.06;
  }

  return (
    <div className="w-full">
      <svg
        viewBox={`0 0 ${VIEWBOX_W} ${VIEWBOX_H}`}
        preserveAspectRatio="xMidYMid meet"
        className="w-full h-auto"
        style={{ maxHeight: 520 }}
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
          const pulsing = pulsingEdges.has(`${from}→${to}`);
          const opacity = edgeOpacity(from, to);
          // Compute path: simple straight line with arrow at b end,
          // shortened so the arrowhead lands on the node edge.
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const len = Math.hypot(dx, dy);
          const ux = dx / len;
          const uy = dy / len;
          const x1 = a.x + ux * NODE_R;
          const y1 = a.y + uy * NODE_R;
          const x2 = b.x - ux * (NODE_R + 4);
          const y2 = b.y - uy * (NODE_R + 4);
          return (
            <g key={`edge-${from}-${to}`} opacity={opacity}>
              <line
                x1={x1} y1={y1} x2={x2} y2={y2}
                stroke={pulsing ? 'var(--amber)' : 'var(--text-tertiary)'}
                strokeWidth={pulsing ? 2 : 1.4}
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
            </g>
          );
        })}

        {/* Nodes */}
        {Object.entries(LAYOUT).map(([name, pos]) => {
          const meta  = AGENT_METADATA[name as AgentId];
          const agent = byName.get(name);
          const op    = nodeOpacity(name);
          const isSel = selectedAgent === name;
          const isSupervisor = name === 'flight_control';
          const failing = agent?.circuit_state === 'tripped' || agent?.last_run_status === 'failed';
          const fillBase = isSupervisor ? 'var(--amber)' : (meta?.color ?? 'var(--blue)');
          return (
            <g
              key={name}
              opacity={op}
              transform={`translate(${pos.x},${pos.y})`}
              style={{ cursor: 'pointer' }}
              onClick={() => onSelect(name)}
            >
              {/* Selection halo */}
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
                fill={fillBase}
                fillOpacity={isSupervisor ? 0.20 : 0.16}
                stroke={fillBase}
                strokeWidth={isSupervisor ? 2 : 1.4}
              />
              {/* Centered initial letter — fast & legible at this size */}
              <text
                textAnchor="middle"
                dominantBaseline="central"
                fontFamily="var(--font-mono)"
                fontSize={isSupervisor ? 14 : 12}
                fontWeight={700}
                fill={fillBase}
              >
                {(meta?.displayName ?? name).slice(0, 2).toUpperCase()}
              </text>
              {/* Agent name below the circle */}
              <text
                y={NODE_R + 14}
                textAnchor="middle"
                fontFamily="var(--font-mono)"
                fontSize={9}
                fontWeight={isSel ? 700 : 500}
                fill="var(--text-secondary)"
                style={{ letterSpacing: '0.06em' }}
              >
                {meta?.displayName ?? name}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="flex items-center gap-4 mt-2 font-mono text-[9px] tracking-wide uppercase" style={{ color: 'var(--text-tertiary)' }}>
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
          <span className="inline-block w-6 h-px" style={{ background: 'var(--text-muted)', borderTop: '1px dashed var(--text-muted)' }} />
          Supervision
        </span>
      </div>
    </div>
  );
}
