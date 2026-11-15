// Network view model: stages, the ONE declared edge list, placement of
// every agent the API returns, and the stage-based layout.
//
// Nothing here draws. Positions come from each node's stage (no coordinate
// table), and edges come from EDGES below, which a test pins against the
// dispatch code (see model.test.ts). When the platform's wiring changes,
// change EDGES and the test together.
//
// Edge mechanisms (how the hand-off really happens):
//   INLINE  same tick, the upstream awaits / calls the downstream
//   EVENT   an agent_events row with target_agent (the only one today is
//           nexus -> observer, pivot_detected)
//   TABLE   the upstream writes a table the downstream reads on its next run

import type { FeedOverview } from '@/hooks/useFeeds';

export type Stage = 'sources' | 'ingest' | 'enrich' | 'correlate' | 'narrate' | 'respond';
export type Mechanism = 'INLINE' | 'EVENT' | 'TABLE';
export type EdgeTier = 'spine' | 'detail';
export type Lifecycle = 'active' | 'paused' | 'shadow' | 'retired';
export type FeedGroup = 'ingest' | 'social' | 'enrichment' | 'nrd';

export interface NetworkEdge {
  from: string;
  to: string;
  mechanism: Mechanism;
  tier: EdgeTier;
  /** What carries the hand-off (table or event name). Shown in the tooltip. */
  via?: string;
}

// ── Declared non-agent endpoints ──────────────────────────────────────
/** The shared threats table. Everything ingested lands here. */
export const HUB_THREATS = 'threats';
export const FLIGHT_CONTROL = 'flight_control';
export const GROUP_INGEST = 'feeds:ingest';
export const GROUP_SOCIAL = 'feeds:social';
export const GROUP_ENRICHMENT = 'feeds:enrichment';
export const FEED_NRD = 'feed:nrd_hagezi';
export const INBOX_ABUSE = 'inbox:abuse';

export const DECLARED_ENDPOINTS: readonly string[] = [
  HUB_THREATS, FLIGHT_CONTROL, GROUP_INGEST, GROUP_SOCIAL, GROUP_ENRICHMENT, FEED_NRD, INBOX_ABUSE,
];

export const FEED_GROUP_NODE: Record<Exclude<FeedGroup, 'nrd'>, string> = {
  ingest: GROUP_INGEST,
  social: GROUP_SOCIAL,
  enrichment: GROUP_ENRICHMENT,
};
export const FEED_GROUP_LABEL: Record<Exclude<FeedGroup, 'nrd'>, string> = {
  ingest: 'Ingest feeds',
  social: 'Social feeds',
  enrichment: 'Enrichment feeds',
};

// ── Declared edges ────────────────────────────────────────────────────
// Spine edges are always drawn. Detail edges appear only for the hovered or
// selected node. Known-wrong edges from the old view (sentinel->cartographer,
// nexus->analyst, analyst->pathfinder, observer->narrator,
// observer->seed_strategist, seed_strategist->auto_seeder) must not return.
export const EDGES: readonly NetworkEdge[] = [
  // INLINE
  { from: GROUP_INGEST, to: HUB_THREATS, mechanism: 'INLINE', tier: 'spine', via: 'threats' },
  { from: HUB_THREATS, to: 'sentinel', mechanism: 'INLINE', tier: 'spine', via: 'new threats this tick' },
  { from: GROUP_SOCIAL, to: 'watchdog', mechanism: 'INLINE', tier: 'spine', via: 'social_mentions' },
  { from: 'social_discovery', to: 'social_monitor', mechanism: 'INLINE', tier: 'spine', via: 'paired, discovery first' },
  { from: 'sparrow', to: 'evidence_assembler', mechanism: 'INLINE', tier: 'spine', via: 'assembleEvidence' },
  // EVENT (the only one)
  { from: 'nexus', to: 'observer', mechanism: 'EVENT', tier: 'spine', via: 'pivot_detected' },
  // TABLE
  { from: GROUP_ENRICHMENT, to: HUB_THREATS, mechanism: 'TABLE', tier: 'spine', via: 'threats (UPDATE)' },
  { from: 'navigator', to: HUB_THREATS, mechanism: 'TABLE', tier: 'spine', via: 'threats.ip_address (DNS)' },
  { from: HUB_THREATS, to: 'cartographer', mechanism: 'TABLE', tier: 'spine', via: 'threats' },
  { from: HUB_THREATS, to: 'page_capture', mechanism: 'TABLE', tier: 'spine', via: 'page_captures queue' },
  { from: 'cartographer', to: 'nexus', mechanism: 'TABLE', tier: 'spine', via: 'threats' },
  { from: 'nexus', to: 'attributor', mechanism: 'TABLE', tier: 'spine', via: 'infrastructure_clusters' },
  { from: 'cartographer', to: 'strategist', mechanism: 'TABLE', tier: 'spine', via: 'provider scores' },
  { from: 'strategist', to: 'observer', mechanism: 'TABLE', tier: 'spine', via: 'campaigns' },
  { from: 'analyst', to: 'observer', mechanism: 'TABLE', tier: 'spine', via: 'agent_outputs' },
  { from: FEED_NRD, to: 'lookalike_scanner', mechanism: 'TABLE', tier: 'spine', via: 'nrd_domains' },
  { from: 'lookalike_scanner', to: 'sparrow', mechanism: 'TABLE', tier: 'spine', via: 'lookalike_domains' },
  { from: INBOX_ABUSE, to: 'abuse_mailbox_classifier', mechanism: 'TABLE', tier: 'spine', via: 'abuse_inbox_messages' },
  { from: 'abuse_mailbox_classifier', to: 'sparrow', mechanism: 'TABLE', tier: 'spine', via: 'abuse reports' },
  { from: 'auto_seeder', to: 'seed_strategist', mechanism: 'TABLE', tier: 'spine', via: 'seed_addresses' },

  // Detail (hover / select only)
  ...(['analyst', 'narrator', 'observer', 'sparrow', 'nexus'] as const).flatMap((to): NetworkEdge[] => [
    { from: 'dark_web_monitor', to, mechanism: 'TABLE', tier: 'detail', via: 'agent_outputs / alerts' },
    { from: 'app_store_monitor', to, mechanism: 'TABLE', tier: 'detail', via: 'agent_outputs / alerts' },
  ]),
  ...(['analyst', 'narrator', 'observer', 'sparrow'] as const).flatMap((to): NetworkEdge[] => [
    { from: 'social_monitor', to, mechanism: 'TABLE', tier: 'detail', via: 'social findings' },
    { from: 'social_discovery', to, mechanism: 'TABLE', tier: 'detail', via: 'social findings' },
  ]),
  { from: 'ct_monitor', to: 'narrator', mechanism: 'TABLE', tier: 'detail', via: 'ct findings' },
  { from: 'ct_monitor', to: 'observer', mechanism: 'TABLE', tier: 'detail', via: 'ct findings' },
  { from: 'lookalike_scanner', to: 'narrator', mechanism: 'TABLE', tier: 'detail', via: 'lookalike_domains' },
  { from: 'lookalike_scanner', to: 'observer', mechanism: 'TABLE', tier: 'detail', via: 'lookalike_domains' },
  { from: 'lookalike_scanner', to: 'trademark_monitor', mechanism: 'TABLE', tier: 'detail', via: 'lookalike_domains' },
  { from: 'watchdog', to: 'sparrow', mechanism: 'TABLE', tier: 'detail', via: 'social findings' },
  { from: 'watchdog', to: 'analyst', mechanism: 'TABLE', tier: 'detail', via: 'social findings' },
  { from: 'watchdog', to: 'observer', mechanism: 'TABLE', tier: 'detail', via: 'social findings' },
  { from: 'cube_healer', to: 'cartographer', mechanism: 'TABLE', tier: 'detail', via: 'threat cubes' },
  { from: 'cube_healer', to: 'observer', mechanism: 'TABLE', tier: 'detail', via: 'threat cubes' },
  { from: 'news_watcher', to: 'analyst', mechanism: 'TABLE', tier: 'detail', via: 'advisories' },
  { from: 'news_watcher', to: 'cartographer', mechanism: 'TABLE', tier: 'detail', via: 'advisories' },
  { from: 'news_watcher', to: 'observer', mechanism: 'TABLE', tier: 'detail', via: 'advisories' },
  { from: 'narrator', to: 'observer', mechanism: 'TABLE', tier: 'detail', via: 'threat_narratives' },
  // Flight Control supervision (it really dispatches these)
  ...(['curator', 'watchdog', 'analyst', 'geoip_refresh'] as const).map((to): NetworkEdge => (
    { from: FLIGHT_CONTROL, to, mechanism: 'INLINE', tier: 'detail', via: 'Flight Control dispatch' }
  )),
];

export const SPINE_EDGES: readonly NetworkEdge[] = EDGES.filter((e) => e.tier === 'spine');

// ── Stage membership (agents) ─────────────────────────────────────────
/** Left-to-right, top-to-bottom order inside each stage. `sources` is the
 *  monitors lane; feed dots sit in their own lane to its left. */
export const STAGE_AGENTS: Record<Stage, readonly string[]> = {
  sources: [
    'app_store_monitor', 'dark_web_monitor', 'social_discovery', 'social_monitor',
    'lookalike_scanner', 'ct_monitor', 'trademark_monitor', 'executive_monitor',
  ],
  ingest: ['sentinel', 'watchdog', 'abuse_mailbox_classifier', 'auto_seeder'],
  enrich: ['enricher', 'cartographer', 'navigator', 'page_capture', 'cube_healer', 'geoip_refresh', 'curator'],
  correlate: ['nexus', 'attributor', 'analyst', 'news_watcher', 'strategist'],
  narrate: ['observer', 'narrator', 'notification_narrator', 'seed_strategist'],
  respond: ['sparrow', 'evidence_assembler'],
};

/** Small nodes drawn tucked next to their parent. */
export const SATELLITES: readonly string[] = ['evidence_assembler'];

/** Manual / API-only agents: a small "On demand" rail, not on the canvas. */
export const ON_DEMAND_IDS: readonly string[] = [
  'pathfinder', 'phantom_enumerator', 'brand_enricher', 'campaign_hunter',
];

export const STAGE_LABEL: Record<Stage, string> = {
  sources: 'SOURCES', ingest: 'INGEST', enrich: 'ENRICH',
  correlate: 'CORRELATE', narrate: 'NARRATE', respond: 'RESPOND',
};

/** Cron minute / cadence shown inside each node (from the schedule in
 *  wrangler.toml). Four characters or fewer. Event-driven agents read 'evt'. */
export const CRON_LABEL: Record<string, string> = {
  navigator: '/5m', page_capture: '/10m', enricher: ':08', cartographer: ':09',
  analyst: ':07', strategist: ':10', sparrow: ':11', cube_healer: ':12',
  app_store_monitor: ':13', dark_web_monitor: ':14', social_discovery: ':15', social_monitor: ':15',
  ct_monitor: ':18', lookalike_scanner: ':22', trademark_monitor: ':23', executive_monitor: ':26',
  observer: ':41', nexus: '4h', attributor: '4h', news_watcher: '6h',
  narrator: '06h', notification_narrator: '13h', seed_strategist: '06h',
  auto_seeder: 'Sun', geoip_refresh: 'Sun', sentinel: 'evt', watchdog: 'evt', curator: 'evt',
  abuse_mailbox_classifier: '1h', evidence_assembler: 'inl',
};

const STAGE_OF: Record<string, Stage> = (() => {
  const m: Record<string, Stage> = {};
  for (const stage of Object.keys(STAGE_AGENTS) as Stage[]) {
    for (const id of STAGE_AGENTS[stage]) m[id] = stage;
  }
  return m;
})();

export function stageOf(agentId: string): Stage | null {
  return STAGE_OF[agentId] ?? null;
}

// ── Placement ─────────────────────────────────────────────────────────
export interface AgentLike {
  name: string;
  lifecycle?: Lifecycle;
}

export interface Placement {
  /** Canvas agents per stage (Flight Control excluded: it is the badge). */
  stages: Record<Stage, string[]>;
  retired: string[];
  onDemand: string[];
  /** Anything the stage map does not know (run writers like daily_briefing,
   *  future agents). Tape only. */
  ops: string[];
  /** Flight Control present in the payload. */
  hasFlightControl: boolean;
}

export function placeAgents(agents: readonly AgentLike[]): Placement {
  const seen = new Set<string>();
  const present = new Map<string, AgentLike>();
  for (const a of agents) {
    if (seen.has(a.name)) continue; // the API once returned Navigator twice
    seen.add(a.name);
    present.set(a.name, a);
  }
  const stages: Record<Stage, string[]> = {
    sources: [], ingest: [], enrich: [], correlate: [], narrate: [], respond: [],
  };
  const retired: string[] = [];
  const onDemand: string[] = [];
  const ops: string[] = [];
  let hasFlightControl = false;

  // Canvas order follows STAGE_AGENTS, not payload order.
  const placed = new Set<string>();
  for (const stage of Object.keys(STAGE_AGENTS) as Stage[]) {
    for (const id of STAGE_AGENTS[stage]) {
      const a = present.get(id);
      if (!a) continue;
      placed.add(id);
      if ((a.lifecycle ?? 'active') === 'retired') retired.push(id);
      else stages[stage].push(id);
    }
  }
  for (const a of present.values()) {
    if (placed.has(a.name)) continue;
    if (a.name === FLIGHT_CONTROL) { hasFlightControl = true; continue; }
    if ((a.lifecycle ?? 'active') === 'retired') retired.push(a.name);
    else if (ON_DEMAND_IDS.includes(a.name)) onDemand.push(a.name);
    else ops.push(a.name);
  }
  return { stages, retired, onDemand, ops, hasFlightControl };
}

/** Every agent id that ends up in exactly one bucket. Used by the coverage test. */
export function placedIds(p: Placement): string[] {
  return [
    ...Object.values(p.stages).flat(),
    ...p.retired, ...p.onDemand, ...p.ops,
    ...(p.hasFlightControl ? [FLIGHT_CONTROL] : []),
  ];
}

// ── Feeds ─────────────────────────────────────────────────────────────
export function feedGroupOf(feed: Pick<FeedOverview, 'feed_name' | 'feed_type'>): FeedGroup {
  if (feed.feed_name === 'nrd_hagezi') return 'nrd';
  if (feed.feed_type === 'social') return 'social';
  if (feed.feed_type === 'enrichment') return 'enrichment';
  return 'ingest'; // missing feed_type reads as ingest
}

/** Map any hover id to the id the canvas and tape both understand. */
export function canonicalHoverId(id: string | null, feedGroupByName: ReadonlyMap<string, FeedGroup>): string | null {
  if (!id || !id.startsWith('feed:')) return id;
  if (id === FEED_NRD) return id;
  const g = feedGroupByName.get(id.slice(5));
  if (!g || g === 'nrd') return id;
  return FEED_GROUP_NODE[g];
}

// ── Layout ────────────────────────────────────────────────────────────
export type NodeKind = 'agent' | 'hub' | 'group' | 'source';

export interface LayoutNode {
  id: string;
  kind: NodeKind;
  x: number;
  y: number;
  r: number;
  label: string;
}

export interface FeedDot {
  name: string;
  group: Exclude<FeedGroup, 'nrd'>;
  x: number;
  y: number;
}

export interface Layout {
  width: number;
  height: number;
  nodes: Record<string, LayoutNode>;
  dots: FeedDot[];
  columns: Array<{ key: string; label: string; x: number }>;
  /** Flight Control badge rectangle. */
  badge: { x: number; y: number; w: number; h: number };
}

export const MIN_LAYOUT_WIDTH = 1000;
const TOP = 96;
const ROW_H = 58;
const AGENT_R = 15;
const SAT_R = 11;
export const HUB_R = 34;
const DOT_PITCH = 15;
const DOT_COLS = 7;
const FEED_LANE_X = 20;

export interface LayoutInput {
  width: number;
  placement: Placement;
  /** Enabled feeds only. */
  feeds: ReadonlyArray<Pick<FeedOverview, 'feed_name' | 'feed_type'>>;
  /** Label lookup (display name). */
  labelOf: (id: string) => string;
}

export function computeLayout({ width, placement, feeds, labelOf }: LayoutInput): Layout {
  const W = Math.max(width, MIN_LAYOUT_WIDTH);
  const nodes: Record<string, LayoutNode> = {};
  const dots: FeedDot[] = [];

  // Columns: monitors lane, then ingest..respond.
  const colKeys: Stage[] = ['sources', 'ingest', 'enrich', 'correlate', 'narrate', 'respond'];
  const x0 = 214;
  const x1 = W - 74;
  const colX = (i: number) => x0 + ((x1 - x0) * i) / (colKeys.length - 1);

  // The hub rides at the top of the ingest column.
  const ingestIds = [HUB_THREATS, ...placement.stages.ingest];
  const colContent: Record<Stage, string[]> = {
    ...placement.stages,
    sources: [...placement.stages.sources, INBOX_ABUSE],
    ingest: ingestIds,
  };
  const maxRows = Math.max(...colKeys.map((k) => colContent[k].length), 1);
  const bodyH = maxRows * ROW_H;

  colKeys.forEach((key, i) => {
    const ids = colContent[key];
    const x = colX(i);
    // Centre each column vertically in the body so short columns do not hug the top.
    const startY = TOP + (bodyH - ids.length * ROW_H) / 2 + ROW_H / 2 - 6;
    ids.forEach((id, row) => {
      const y = startY + row * ROW_H;
      if (id === HUB_THREATS) {
        nodes[id] = { id, kind: 'hub', x, y, r: HUB_R, label: 'threats' };
      } else if (id === INBOX_ABUSE) {
        nodes[id] = { id, kind: 'source', x, y, r: 6, label: 'abuse inbox' };
      } else {
        const sat = SATELLITES.includes(id);
        nodes[id] = { id, kind: 'agent', x, y, r: sat ? SAT_R : AGENT_R, label: labelOf(id) };
      }
    });
  });

  // Feed lane: grouped dot grids + nrd_hagezi as a labelled source.
  let fy = TOP - 6;
  const order: Array<Exclude<FeedGroup, 'nrd'>> = ['ingest', 'enrichment', 'social'];
  for (const g of order) {
    const names = feeds.filter((f) => feedGroupOf(f) === g).map((f) => f.feed_name).sort();
    if (!names.length) continue;
    const rows = Math.ceil(names.length / DOT_COLS);
    const gh = 18 + rows * DOT_PITCH;
    names.forEach((name, i) => {
      dots.push({
        name, group: g,
        x: FEED_LANE_X + 8 + (i % DOT_COLS) * DOT_PITCH,
        y: fy + 22 + Math.floor(i / DOT_COLS) * DOT_PITCH,
      });
    });
    const gid = FEED_GROUP_NODE[g];
    nodes[gid] = {
      id: gid, kind: 'group',
      x: FEED_LANE_X + 8 + (DOT_COLS - 1) * DOT_PITCH + 12,
      y: fy + 18 + (rows * DOT_PITCH) / 2 - 2,
      r: 3,
      label: `${FEED_GROUP_LABEL[g]} (${names.length})`,
    };
    nodes[gid]!.id = gid;
    fy += gh + 14;
  }
  if (feeds.some((f) => f.feed_name === 'nrd_hagezi')) {
    nodes[FEED_NRD] = { id: FEED_NRD, kind: 'source', x: FEED_LANE_X + 10, y: fy + 12, r: 5, label: 'nrd_hagezi' };
    fy += 30;
  }

  const height = Math.max(TOP + bodyH + 24, fy + 24);

  // Flight Control badge spans the pipeline columns.
  const bx = colX(1) - 54;
  const bw = colX(colKeys.length - 1) + 54 - bx;
  const badge = { x: bx, y: 14, w: bw, h: 28 };
  nodes[FLIGHT_CONTROL] = { id: FLIGHT_CONTROL, kind: 'agent', x: bx + bw / 2, y: badge.y + badge.h, r: 0, label: 'Flight Control' };

  const columns = [
    { key: 'feeds', label: 'FEEDS', x: FEED_LANE_X + 8 },
    ...colKeys.map((k, i) => ({ key: k, label: STAGE_LABEL[k], x: colX(i) })),
  ];
  return { width: W, height, nodes, dots, columns, badge };
}

export type Pt = { x: number; y: number };

/** Bezier control points from node a to node b, as [x0,y0,c1x,c1y,c2x,c2y,x1,y1]. */
export function edgeCurve(a: Pick<LayoutNode, 'x' | 'y' | 'r'>, b: Pick<LayoutNode, 'x' | 'y' | 'r'>): number[] {
  if (Math.abs(a.x - b.x) < 1) {
    const k = 58;
    return [a.x + a.r, a.y, a.x + k, a.y, b.x + k, b.y, b.x + b.r, b.y];
  }
  if (b.x < a.x) {
    // Backwards (navigator -> hub): leave right-down, enter from below-left.
    const my = (a.y + b.y) / 2;
    return [a.x - a.r, a.y, a.x - 50, my, b.x + 50, my, b.x + b.r, b.y];
  }
  if (b.x - a.x > 330) {
    const k = b.x - 90;
    return [a.x + a.r, a.y, k, a.y, k, b.y, b.x - b.r, b.y];
  }
  const mx = (a.x + b.x) / 2;
  return [a.x + a.r, a.y, mx, a.y, mx, b.y, b.x - b.r, b.y];
}

export function bezierAt(c: readonly number[], p: number): Pt {
  const q = 1 - p;
  const f = (i: number) =>
    q * q * q * c[i]! + 3 * q * q * p * c[i + 2]! + 3 * q * p * p * c[i + 4]! + p * p * p * c[i + 6]!;
  return { x: f(0), y: f(1) };
}

/** Node (or feed dot) under a layout-space point. */
export function hitTest(layout: Layout, x: number, y: number): { id: string; dot?: string } | null {
  let best: { id: string; dot?: string; d: number } | null = null;
  for (const n of Object.values(layout.nodes)) {
    if (n.kind === 'group' || n.id === FLIGHT_CONTROL) continue;
    const d = Math.hypot(x - n.x, y - n.y);
    if (d <= n.r + 9 && (!best || d < best.d)) best = { id: n.id, d };
  }
  if (best) return { id: best.id };
  for (const dot of layout.dots) {
    const d = Math.hypot(x - dot.x, y - dot.y);
    if (d <= 8 && (!best || d < best.d)) best = { id: FEED_GROUP_NODE[dot.group], dot: dot.name, d };
  }
  if (best) return { id: best.id, dot: best.dot };
  const b = layout.badge;
  if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return { id: FLIGHT_CONTROL };
  return null;
}

/** Ids connected to `id` through any declared edge, plus `id`. */
export function neighbourhood(id: string): Set<string> {
  const s = new Set<string>([id]);
  for (const e of EDGES) {
    if (e.from === id) s.add(e.to);
    if (e.to === id) s.add(e.from);
  }
  return s;
}
