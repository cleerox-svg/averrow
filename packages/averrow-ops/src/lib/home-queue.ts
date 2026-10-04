// Pure model for the Home "Needs you now" queue (Phase 1 PR7a).
//
// Home no longer shows a wall of equal-weight sections. Each queue source
// (alerts, incidents, approvals, …) is turned into zero or more QueueItems,
// then ranked by:
//
//     score = severityWeight × recencyDecay × reachFactor
//
//   severityWeight  critical 8 · high 4 · medium 2 · low 1
//   recencyDecay    0.5 ^ (ageHours / 24), floored at 0.25 so a stale but still
//                   open item never vanishes; no timestamp → 0.5 (neutral);
//                   a future timestamp (clock skew) counts as "now"
//   reachFactor     1 + 0.5 · log10(1 + reach)  (reach = a count, or the number
//                   of brands affected; log-damped so a 4,000-row backlog cannot
//                   outrank a critical event on volume alone)
//
// Ties break on severity, then recency, then id, so the order is stable.
//
// This module has no React and no network: role gating (`enabledSources`) and
// failure accounting are here so they are unit-testable. Hooks live in
// features/home/useHomeQueue.ts and pass `enabled` from `enabledSources`, so a
// gated role never fires the request (the 403 envelope would otherwise read as
// "nothing needs you").

import type { AlertTriageSummary } from '@/hooks/useAlerts';
import type { CriticalBannerData, CriticalEvent } from '@/hooks/useCriticalBanner';
import type { Incident } from '@/features/admin-incidents/useIncidents';
import type { AgentApprovalRow } from '@/hooks/useAgentApprovals';
import type { StatusCount } from '@/hooks/useTakedowns';
import type { Agent } from '@/hooks/useAgents';
import type { DashboardSnapshot } from '@/hooks/useDashboardSnapshot';
import type { AttributionBacklogData } from '@/hooks/useAttributionBacklog';
import { parseUtc } from '@/lib/time';
import { roleHasPermission } from '@/lib/permissions';
import { tabUrl } from '@/lib/workspaceRoutes';

// ── Sources ────────────────────────────────────────────────────────────────

export type QueueSourceId =
  | 'alerts'
  | 'critical_intel'
  | 'incidents'
  | 'approvals'
  | 'takedowns'
  | 'agents'
  | 'feeds'
  | 'attribution'
  | 'brand_candidates';

export const QUEUE_SOURCE_IDS: readonly QueueSourceId[] = [
  'alerts', 'critical_intel', 'incidents', 'approvals', 'takedowns',
  'agents', 'feeds', 'attribution', 'brand_candidates',
];

/** Human label, used in "Couldn't check {label}". */
export const QUEUE_SOURCE_LABEL: Record<QueueSourceId, string> = {
  alerts: 'alerts',
  critical_intel: 'critical intelligence',
  incidents: 'incidents',
  approvals: 'agent approvals',
  takedowns: 'takedowns',
  agents: 'agents',
  feeds: 'feeds',
  attribution: 'the attribution backlog',
  brand_candidates: 'brand candidates',
};

const STAFF_ROLES: ReadonlySet<string> = new Set([
  'super_admin', 'admin', 'analyst', 'sales', 'support', 'billing', 'auditor',
]);

/**
 * Which queue sources a global role may request. Mirrors the worker guards:
 *   requireStaff        → critical_intel, agents
 *   edit_alerts         → alerts (super_admin, admin, analyst, support). The summary
 *                         is platform-wide and Home links into the alert to act on
 *                         it, so roles that cannot act on alerts never fetch it.
 *   requireSuperAdmin   → incidents, approvals
 *   manage_takedowns    → takedowns (super_admin, admin, analyst)
 *   requireAdmin        → feeds (/api/admin/dashboard), attribution, brand_candidates
 * Unknown / client / missing roles get nothing.
 */
export function enabledSources(role: string | null | undefined): Record<QueueSourceId, boolean> {
  const isStaff = !!role && STAFF_ROLES.has(role);
  const isSuper = role === 'super_admin';
  const isAdminUp = isSuper || role === 'admin';
  return {
    alerts: isStaff && roleHasPermission(role, 'edit_alerts'),
    critical_intel: isStaff,
    agents: isStaff,
    incidents: isSuper,
    approvals: isSuper,
    takedowns: isStaff && roleHasPermission(role, 'manage_takedowns'),
    feeds: isAdminUp,
    attribution: isAdminUp,
    brand_candidates: isAdminUp,
  };
}

// ── Items ──────────────────────────────────────────────────────────────────

export type QueueSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface QueueItem {
  id: string;
  source: QueueSourceId;
  severity: QueueSeverity;
  title: string;
  detail: string;
  /** When it happened / was raised (UTC string); null = a live count with no timestamp. */
  ts: string | null;
  /** A count, or the number of brands affected. */
  reach: number;
  action: { label: string; to: string };
}

export const SEVERITY_WEIGHT: Record<QueueSeverity, number> = {
  critical: 8,
  high: 4,
  medium: 2,
  low: 1,
};

export const RECENCY_HALF_LIFE_HOURS = 24;
export const RECENCY_FLOOR = 0.25;
export const RECENCY_UNKNOWN = 0.5;
/** An agent needs at least this many 24h errors to be queued (a tripped circuit always is). */
export const AGENT_ERROR_MIN = 3;

export function recencyDecay(ts: string | null, now: number): number {
  if (!ts) return RECENCY_UNKNOWN;
  const t = parseUtc(ts).getTime();
  if (Number.isNaN(t)) return RECENCY_UNKNOWN;
  const ageHours = Math.max(0, (now - t) / 3_600_000);
  return Math.max(RECENCY_FLOOR, Math.pow(0.5, ageHours / RECENCY_HALF_LIFE_HOURS));
}

export function reachFactor(reach: number): number {
  // A NaN/Infinity reach counts as 0 so it can never poison the sort order.
  const r = Number.isFinite(reach) ? Math.max(0, reach) : 0;
  return 1 + 0.5 * Math.log10(1 + r);
}

export function scoreItem(item: QueueItem, now: number): number {
  const score = SEVERITY_WEIGHT[item.severity] * recencyDecay(item.ts, now) * reachFactor(item.reach);
  return Number.isFinite(score) ? score : 0;
}

export function rankItems(items: QueueItem[], now: number): QueueItem[] {
  return items
    .map((item) => ({ item, score: scoreItem(item, now) }))
    .sort((a, b) =>
      b.score - a.score
      || SEVERITY_WEIGHT[b.item.severity] - SEVERITY_WEIGHT[a.item.severity]
      || tsMs(b.item.ts) - tsMs(a.item.ts)
      || a.item.id.localeCompare(b.item.id))
    .map((x) => x.item);
}

function tsMs(ts: string | null): number {
  if (!ts) return 0;
  const t = parseUtc(ts).getTime();
  return Number.isNaN(t) ? 0 : t;
}

// ── Per-source builders ────────────────────────────────────────────────────
// Each returns QueueItem[] (possibly empty = nothing to do) or `null` when the
// payload is unusable. `null` is treated as a FAILED source, never as clear.

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

function newest(values: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  let bestMs = -Infinity;
  for (const v of values) {
    if (!v) continue;
    const ms = parseUtc(v).getTime();
    if (!Number.isNaN(ms) && ms > bestMs) { best = v; bestMs = ms; }
  }
  return best;
}

function buildAlerts(d: AlertTriageSummary): QueueItem[] | null {
  if (!d || typeof d.new_count !== 'number') return null;
  if (d.new_count <= 0) return [];
  const critical = d.critical_count > 0;
  const top = d.top ?? null;
  return [{
    id: 'alerts:triage',
    source: 'alerts',
    severity: critical ? 'critical' : 'medium',
    title: `${plural(d.new_count, 'alert')} awaiting triage`,
    detail: critical ? `${d.critical_count.toLocaleString()} critical` : 'none critical',
    ts: null,
    reach: d.new_count,
    action: top
      ? { label: 'Open alert', to: tabUrl('alerts', { status: 'new', alert: top.id }) }
      : { label: 'Triage', to: tabUrl('alerts', { status: 'new' }) },
  }];
}

const EVENT_KIND_LABEL: Record<CriticalEvent['kind'], string> = {
  provider_surge: 'Provider surge',
  burst: 'Burst detected',
  mass_impersonation_ip: 'Mass impersonation',
  new_campaign: 'New campaign',
  open_critical_alerts: 'Open critical alerts',
};

function buildCriticalIntel(d: CriticalBannerData | null): QueueItem[] | null {
  if (!d || !Array.isArray(d.events)) return null;
  return d.events.map((e, i) => ({
    id: `critical_intel:${e.kind}:${i}`,
    source: 'critical_intel' as const,
    severity: e.severity === 'critical' || e.severity === 'high' ? e.severity : 'medium',
    title: e.title,
    detail: e.subtitle || EVENT_KIND_LABEL[e.kind] || 'Critical event',
    ts: e.ts ?? null,
    reach: 1,
    action: { label: 'Investigate', to: e.link },
  }));
}

function mapIncidentSeverity(s: Incident['severity']): QueueSeverity {
  return s === 'critical' || s === 'high' || s === 'medium' ? s : 'low';
}

function buildIncidents(list: Incident[]): QueueItem[] | null {
  if (!Array.isArray(list)) return null;
  if (list.length === 0) return [];
  let sev: QueueSeverity = 'low';
  for (const i of list) {
    const m = mapIncidentSeverity(i.severity);
    if (SEVERITY_WEIGHT[m] > SEVERITY_WEIGHT[sev]) sev = m;
  }
  const critical = list.filter((i) => i.severity === 'critical').length;
  return [{
    id: 'incidents:open',
    source: 'incidents',
    severity: sev,
    title: `${plural(list.length, 'open incident')}`,
    detail: critical > 0 ? `${critical.toLocaleString()} critical` : 'Platform and ops',
    ts: newest(list.map((i) => i.detected_at ?? i.created_at)),
    reach: list.length,
    action: { label: 'Open', to: tabUrl('incidents') },
  }];
}

function buildApprovals(d: { pending: AgentApprovalRow[] }): QueueItem[] | null {
  if (!d || !Array.isArray(d.pending)) return null;
  if (d.pending.length === 0) return [];
  return [{
    id: 'approvals:pending',
    source: 'approvals',
    severity: 'medium',
    title: `${plural(d.pending.length, 'agent')} awaiting deployment review`,
    detail: 'Blocked until a super admin approves',
    ts: newest(d.pending.map((p) => p.requested_at)),
    reach: d.pending.length,
    action: { label: 'Review', to: '/agents/approvals' },
  }];
}

const TAKEDOWN_QUEUE_STATUSES: ReadonlySet<string> = new Set(['draft', 'requested']);

function buildTakedowns(d: { statusCounts: StatusCount[] }): QueueItem[] | null {
  if (!d || !Array.isArray(d.statusCounts)) return null;
  let draft = 0;
  let requested = 0;
  for (const s of d.statusCounts) {
    if (!TAKEDOWN_QUEUE_STATUSES.has(s.status)) continue;
    if (s.status === 'draft') draft += Number(s.count) || 0;
    else requested += Number(s.count) || 0;
  }
  const total = draft + requested;
  if (total === 0) return [];
  const parts: string[] = [];
  if (draft > 0) parts.push(`${draft.toLocaleString()} draft`);
  if (requested > 0) parts.push(`${requested.toLocaleString()} requested`);
  return [{
    id: 'takedowns:queue',
    source: 'takedowns',
    severity: 'medium',
    title: `${plural(total, 'takedown')} to action`,
    detail: parts.join(' · '),
    ts: null,
    reach: total,
    action: { label: 'Review', to: tabUrl('takedowns') },
  }];
}

function nameList(agents: Agent[]): string {
  const names = agents.slice(0, 3).map((a) => a.display_name || a.name || a.agent_id);
  const more = agents.length - names.length;
  return more > 0 ? `${names.join(', ')} +${more} more` : names.join(', ');
}

function buildAgents(list: Agent[]): QueueItem[] | null {
  if (!Array.isArray(list)) return null;
  const tripped = list.filter((a) => a.circuit_state === 'tripped');
  const erroring = list.filter(
    (a) => a.circuit_state !== 'tripped' && (a.error_count_24h ?? 0) >= AGENT_ERROR_MIN,
  );
  const items: QueueItem[] = [];
  if (tripped.length > 0) {
    items.push({
      id: 'agents:tripped',
      source: 'agents',
      severity: 'high',
      title: `${plural(tripped.length, 'agent')} with a tripped circuit`,
      detail: nameList(tripped),
      ts: newest(tripped.map((a) => a.paused_at ?? a.last_run_at)),
      reach: tripped.length,
      action: { label: 'Inspect', to: tabUrl('agents') },
    });
  }
  if (erroring.length > 0) {
    const errors = erroring.reduce((s, a) => s + (a.error_count_24h ?? 0), 0);
    items.push({
      id: 'agents:errors',
      source: 'agents',
      severity: 'medium',
      title: `${plural(erroring.length, 'agent')} erroring`,
      detail: `${errors.toLocaleString()} errors in 24h · ${nameList(erroring)}`,
      ts: newest(erroring.map((a) => a.last_run_at)),
      reach: errors,
      action: { label: 'Inspect', to: tabUrl('agents') },
    });
  }
  return items;
}

function buildFeeds(d: DashboardSnapshot | null): QueueItem[] | null {
  // A null slice means the server could not compute it: unknown, not healthy.
  if (!d || !d.feeds) return null;
  const count = d.feeds.at_risk_count ?? d.feeds.at_risk?.length ?? 0;
  if (count <= 0) return [];
  const atRisk = d.feeds.at_risk ?? [];
  const critical = atRisk.some((f) => f.severity === 'critical');
  const names = atRisk.slice(0, 3).map((f) => f.display_name || f.feed_name).join(', ');
  return [{
    id: 'feeds:at_risk',
    source: 'feeds',
    severity: critical ? 'critical' : 'high',
    title: `${plural(count, 'feed')} at risk`,
    detail: names || 'Approaching auto-pause',
    ts: null,
    reach: count,
    action: { label: 'Check feeds', to: tabUrl('feeds') },
  }];
}

function buildAttribution(d: AttributionBacklogData | null): QueueItem[] | null {
  if (!d || !d.totals) return null;
  const n = d.totals.unattributed ?? 0;
  if (n <= 0) return [];
  return [{
    id: 'attribution:backlog',
    source: 'attribution',
    severity: 'low',
    title: `${plural(n, 'cluster')} awaiting attribution`,
    detail: `${(d.totals.never_attempted ?? 0).toLocaleString()} never attempted`,
    ts: null,
    reach: n,
    action: { label: 'Attribute', to: tabUrl('attribution') },
  }];
}

function buildBrandCandidates(d: { total: number; candidates: unknown[] }): QueueItem[] | null {
  if (!d || !Array.isArray(d.candidates)) return null;
  const n = d.total > 0 ? d.total : d.candidates.length;
  if (n <= 0) return [];
  return [{
    id: 'brand_candidates:pending',
    source: 'brand_candidates',
    severity: 'low',
    title: `${plural(n, 'brand candidate')} pending review`,
    detail: 'Proposed from certificate transparency logs',
    ts: null,
    reach: n,
    action: { label: 'Review', to: tabUrl('brands') },
  }];
}

// ── Assembly ───────────────────────────────────────────────────────────────

export type SourceResult<T> =
  | { status: 'loading' }
  | { status: 'error' }
  /**
   * `stale`: a refetch failed but the last good data is still on screen. The
   * items are kept AND the source is reported as failed, so the queue never
   * looks all-clear on stale data.
   */
  | { status: 'ok'; data: T; stale?: boolean };

/** A key that is absent means the source is disabled for this role. */
export interface QueueSources {
  alerts?: SourceResult<AlertTriageSummary>;
  critical_intel?: SourceResult<CriticalBannerData | null>;
  incidents?: SourceResult<Incident[]>;
  approvals?: SourceResult<{ pending: AgentApprovalRow[] }>;
  takedowns?: SourceResult<{ statusCounts: StatusCount[] }>;
  agents?: SourceResult<Agent[]>;
  feeds?: SourceResult<DashboardSnapshot | null>;
  attribution?: SourceResult<AttributionBacklogData | null>;
  brand_candidates?: SourceResult<{ total: number; candidates: unknown[] }>;
}

export interface HomeQueue {
  /** Every open item, ranked best-first. */
  items: QueueItem[];
  /** Enabled sources that errored, returned an unusable payload, or are showing stale data after a failed refetch. */
  failed: QueueSourceId[];
  /** Enabled sources still loading their first result. */
  loading: QueueSourceId[];
  /** How many sources were enabled for this role. */
  enabled: number;
  /**
   * True only when every enabled source succeeded and returned nothing.
   * A failed or still-loading source can never produce a clear queue.
   */
  clear: boolean;
}

function itemsFor(id: QueueSourceId, sources: QueueSources): QueueItem[] | null {
  switch (id) {
    case 'alerts': { const r = sources.alerts; return r?.status === 'ok' ? buildAlerts(r.data) : null; }
    case 'critical_intel': { const r = sources.critical_intel; return r?.status === 'ok' ? buildCriticalIntel(r.data) : null; }
    case 'incidents': { const r = sources.incidents; return r?.status === 'ok' ? buildIncidents(r.data) : null; }
    case 'approvals': { const r = sources.approvals; return r?.status === 'ok' ? buildApprovals(r.data) : null; }
    case 'takedowns': { const r = sources.takedowns; return r?.status === 'ok' ? buildTakedowns(r.data) : null; }
    case 'agents': { const r = sources.agents; return r?.status === 'ok' ? buildAgents(r.data) : null; }
    case 'feeds': { const r = sources.feeds; return r?.status === 'ok' ? buildFeeds(r.data) : null; }
    case 'attribution': { const r = sources.attribution; return r?.status === 'ok' ? buildAttribution(r.data) : null; }
    case 'brand_candidates': { const r = sources.brand_candidates; return r?.status === 'ok' ? buildBrandCandidates(r.data) : null; }
  }
}

export function buildQueue(sources: QueueSources, now: number = Date.now()): HomeQueue {
  const failed: QueueSourceId[] = [];
  const loading: QueueSourceId[] = [];
  let enabled = 0;
  let items: QueueItem[] = [];

  for (const id of QUEUE_SOURCE_IDS) {
    const result = sources[id];
    if (!result) continue; // disabled for this role
    enabled += 1;
    if (result.status === 'loading') { loading.push(id); continue; }
    if (result.status === 'error') { failed.push(id); continue; }
    const built = itemsFor(id, sources);
    if (built === null) { failed.push(id); continue; }
    if (result.stale) failed.push(id);
    items = items.concat(built);
  }

  // Both rows describe the same platform-wide critical alerts (same number), so
  // whenever the alerts source is enabled the banner's "open critical alerts"
  // event is dropped: the alerts row is the one that links to the alert to act on.
  if (sources.alerts) {
    items = items.filter(
      (i) => !(i.source === 'critical_intel' && i.id.startsWith('critical_intel:open_critical_alerts')),
    );
  }

  const ranked = rankItems(items, now);
  return {
    items: ranked,
    failed,
    loading,
    enabled,
    clear: enabled > 0 && ranked.length === 0 && failed.length === 0 && loading.length === 0,
  };
}
