import { useState, useMemo, useEffect, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { cn } from '@/lib/cn';
import {
  StatTile,
  PageState,
  pageStateKind,
  Card,
  StatGrid,
  FilterBar,
  PageHeader,
  DataRow,
  Badge,
  Button,
  type Severity,
} from '@/design-system/components';
import { SeverityDot } from '@/components/ui/DataRow';
import {
  useAlerts, useAlert, useAlertStats, useUpdateAlert, useAssignAlert, useBulkAcknowledge, useBulkTakedown,
  BULK_BATCH, type Alert, type AlertFilters, type BulkAckResult, type BulkTakedownResult,
} from '@/hooks/useAlerts';
import { useSavedViews, type SavedView } from '@/hooks/useSavedViews';
import { useAuth } from '@/lib/auth';
import { roleHasPermission } from '@/lib/permissions';
import { parseInitials } from '@/lib/avatar';
import { Bell, Star, X } from 'lucide-react';

const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Cap on sequential bulk batches per click (20 x 90 alerts). */
const MAX_BULK_BATCHES = 20;
const READ_ONLY_NOTE_ID = 'alerts-readonly-note';

// ── Helpers ─────────────────────────────────────────────────────

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

// ── SLA / aging ─────────────────────────────────────────────────
//
// The single most-cited SOC queue capability absent from this surface
// (audit Batch 2, W8): an open alert that sits past its triage window
// gets no visual warning. Standard severity-based SLA windows
// (Crit 15m · High 1h · Med 4h · Low 24h), measured from created_at
// while the alert is still open (new/acknowledged). Resolved/dismissed
// alerts have no SLA.
const SLA_MINUTES: Record<Severity, number> = {
  critical: 15,
  high: 60,
  medium: 240,
  low: 1440,
  info: 1440,
};

type SlaState = 'ok' | 'warn' | 'breach';
interface SlaInfo { open: boolean; state: SlaState; remainingMs: number; overdueMs: number }

function slaFor(alert: Alert): SlaInfo {
  const open = alert.status === 'new' || alert.status === 'acknowledged';
  if (!open) return { open: false, state: 'ok', remainingMs: 0, overdueMs: 0 };
  const slaMs = SLA_MINUTES[severityToBadge(alert.severity)] * 60_000;
  const ageMs = Date.now() - new Date(alert.created_at).getTime();
  const pct = ageMs / slaMs;
  const state: SlaState = pct >= 1 ? 'breach' : pct >= 0.75 ? 'warn' : 'ok';
  return { open: true, state, remainingMs: slaMs - ageMs, overdueMs: ageMs - slaMs };
}

function fmtDuration(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

// Humanize an alert_type slug ("app_store_impersonation" → "App Store
// Impersonation"). The detail header used to hardcode "Social Impersonation"
// for every alert, mislabeling app-store / phishing / BIMI alerts.
function humanizeType(t: string | null): string {
  if (!t) return 'Alert';
  return t.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// Auto-triage stamps its reason into resolution_notes prefixed "auto:"
// (rule-based) — distinguish operator decisions from automated ones.
function isAutoTriaged(notes: string | null): boolean {
  return !!notes && /^auto[:\- ]/i.test(notes.trim());
}

function extractScore(summary: string): number | null {
  const m = summary.match(/(\d+)%/);
  return m ? parseInt(m[1], 10) : null;
}

function extractHandle(title: string): string {
  const m = title.match(/@[\w.]+/);
  return m ? m[0] : title;
}

function extractPlatform(title: string): string {
  const lower = title.toLowerCase();
  if (lower.includes('tiktok')) return 'TikTok';
  if (lower.includes('youtube')) return 'YouTube';
  if (lower.includes('github')) return 'GitHub';
  if (lower.includes('linkedin')) return 'LinkedIn';
  if (lower.includes('twitter') || lower.includes(' x ')) return 'X';
  if (lower.includes('instagram')) return 'Instagram';
  if (lower.includes('facebook')) return 'Facebook';
  return 'Social';
}

// Platform brand colors. Inline styles (not Tailwind arbitrary-value
// classes) so they survive Tailwind config changes. These are the
// social platforms' official accents — kept as hex for brand
// recognition. Anything not in the map falls back to a neutral
// design-system blue.
function platformBadgeStyle(platform: string): React.CSSProperties {
  const accent = (
    platform === 'TikTok'    ? '#00d4ff' :
    platform === 'YouTube'   ? '#ef4444' :
    platform === 'GitHub'    ? '#a78bfa' :
    platform === 'LinkedIn'  ? '#0a8ab5' :
    platform === 'Instagram' ? '#ec4899' :
    platform === 'Facebook'  ? '#3b82f6' :
    platform === 'X'         ? 'rgba(255,255,255,0.80)' :
                               'var(--blue)'  // Social fallback
  );
  return {
    background: `${accent}26`, // ~15% opacity
    color: accent,
    border: `1px solid ${accent}4d`, // ~30% opacity
  };
}

// alerts.severity is now lowercase post-migration 0120, so the
// uppercase→lowercase translation map is gone. Direct cast.
function severityToBadge(s: string): Severity {
  if (s === 'critical' || s === 'high' || s === 'medium' || s === 'low') return s;
  return 'low'; // defensive fallback for legacy rows
}

// ── AI verdict parsing ─────────────────────────────────────────
//
// alerts.ai_assessment is stamped by the Tier 3 judge as
//   "[AI {verdict} @{confidence}%] {reasoning}"
// The list view surfaces a colored badge from the parsed verdict so
// operators can sort/scan the residual queue faster. Returns null
// when the field is missing or doesn't match the stamped shape
// (e.g. legacy AI assessments from other agents).
type AiVerdict = 'active_threat' | 'likely_safe' | 'needs_human';

interface ParsedAiAssessment {
  verdict: AiVerdict;
  confidence: number;
}

function parseAiAssessment(raw: string | null): ParsedAiAssessment | null {
  if (!raw) return null;
  const m = raw.match(/^\[AI (active_threat|likely_safe|needs_human) @(\d+)%\]/);
  if (!m) return null;
  return { verdict: m[1] as AiVerdict, confidence: parseInt(m[2], 10) };
}

const AI_VERDICT_STYLE: Record<AiVerdict, { label: string; color: string; bg: string }> = {
  active_threat: { label: 'AI: Threat',      color: '#f87171', bg: 'rgba(239,68,68,0.12)' },
  needs_human:   { label: 'AI: Review',      color: '#fbbf24', bg: 'rgba(251,191,36,0.12)' },
  likely_safe:   { label: 'AI: Likely Safe', color: '#4ade80', bg: 'rgba(74,222,128,0.12)' },
};

// ── Saved views ─────────────────────────────────────────────────
//
// A view captures the full operator-facing filter state so an analyst can
// pin a combination and return to it (audit Batch 2, W6). Built-in presets
// cover the common triage entry points; user views persist to localStorage.
interface AlertViewState {
  severity?: string;
  status?: string;
  alert_type?: string;
  search?: string;
  ai?: 'all' | AiVerdict | 'unjudged';
  sla?: 'all' | 'atrisk' | 'breached';
}

const PRESET_VIEWS: SavedView<AlertViewState>[] = [
  { id: 'preset:breaching',    name: 'Breaching SLA', filters: { sla: 'breached' } },
  { id: 'preset:new-critical', name: 'New · Critical', filters: { status: 'new', severity: 'critical' } },
  { id: 'preset:ai-threat',    name: 'AI: Threat',     filters: { ai: 'active_threat' } },
];

function normView(v: AlertViewState): AlertViewState {
  const clean = (s?: string) => (s && s !== 'all' && s !== '' ? s : undefined);
  return {
    severity: clean(v.severity),
    status: clean(v.status),
    alert_type: clean(v.alert_type),
    search: clean(v.search),
    ai: v.ai && v.ai !== 'all' ? v.ai : undefined,
    sla: v.sla && v.sla !== 'all' ? v.sla : undefined,
  };
}

function sameView(a: AlertViewState, b: AlertViewState): boolean {
  const x = normView(a), y = normView(b);
  return x.severity === y.severity && x.status === y.status && x.alert_type === y.alert_type
    && x.search === y.search && x.ai === y.ai && x.sla === y.sla;
}

function viewIsEmpty(v: AlertViewState): boolean {
  const n = normView(v);
  return !n.severity && !n.status && !n.alert_type && !n.search && !n.ai && !n.sla;
}

const READ_ONLY_COPY = "Read-only: your role can view alerts but can't acknowledge, resolve, assign or take them down.";

// URL-backed filters. Unknown values are ignored so a stale or hand-edited link
// degrades to "no filter" instead of an empty list.
const URL_STATUSES: ReadonlySet<string> = new Set(['new', 'acknowledged', 'investigating', 'resolved', 'false_positive']);
const URL_SEVERITIES: ReadonlySet<string> = new Set(['critical', 'high', 'medium', 'low', 'info']);

function paramIn(params: URLSearchParams, key: string, allowed?: ReadonlySet<string>): string | undefined {
  const v = params.get(key);
  if (!v || v === 'all') return undefined;
  if (allowed && !allowed.has(v)) return undefined;
  return v;
}

// ── Filter Pills ────────────────────────────────────────────────

interface PillGroupProps {
  label: string;
  options: { value: string; label: string }[];
  selected: string;
  onChange: (v: string) => void;
}

function PillGroup({ label, options, selected, onChange }: PillGroupProps) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="font-mono text-[9px] uppercase tracking-widest text-white/55 mr-1">{label}</span>
      {options.map(o => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'font-mono text-[10px] font-semibold uppercase tracking-wide px-2.5 py-1 rounded-md border transition-all',
            selected === o.value
              ? 'bg-afterburner-muted text-[#E5A832] border-afterburner-border'
              : 'bg-white/[0.03] text-[var(--text-muted)] border-white/[0.06] hover:border-white/15 hover:text-[var(--text-tertiary)]',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ── Brand Group ─────────────────────────────────────────────────

interface BrandGroup {
  brand_id: string;
  brand_name: string | null;
  brand_domain: string | null;
  alerts: Alert[];
}

function groupByBrand(alerts: Alert[]): BrandGroup[] {
  const map = new Map<string, BrandGroup>();
  for (const a of alerts) {
    const key = a.brand_id || 'unknown';
    if (!map.has(key)) {
      map.set(key, { brand_id: key, brand_name: a.brand_name, brand_domain: a.brand_domain, alerts: [] });
    }
    map.get(key)!.alerts.push(a);
  }
  return Array.from(map.values()).sort((a, b) => b.alerts.length - a.alerts.length);
}

interface BrandGroupCardProps {
  group: BrandGroup;
  selectedAlertId: string | null;
  currentUserId: string | null;
  onSelectAlert: (a: Alert) => void;
  canEdit: boolean;
  canTakedown: boolean;
  onAcknowledgeAll: () => void;
  onCreateTakedowns: () => void;
  /** Progress of a running bulk action on THIS group ('Acknowledging 90 of 200…'). */
  bulk: { kind: 'ack' | 'takedown'; text: string } | null;
  /** Any bulk action running anywhere: all bulk buttons disable. */
  bulkBusy: boolean;
}

function BrandGroupCard({
  group, selectedAlertId, currentUserId, onSelectAlert, canEdit, canTakedown,
  onAcknowledgeAll, onCreateTakedowns,
  bulk, bulkBusy,
}: BrandGroupCardProps) {
  const [expanded, setExpanded] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const visibleAlerts = showAll ? group.alerts : group.alerts.slice(0, 5);
  const remaining = group.alerts.length - 5;
  const newCount = group.alerts.filter(a => a.status === 'new').length;

  return (
    <Card style={{ padding: 0, overflow: 'hidden' }}>
      {/* Group header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-white/[0.03] transition-colors"
      >
        <img
          src={`https://www.google.com/s2/favicons?domain=${group.brand_domain ?? 'example.com'}&sz=32`}
          alt=""
          className="w-5 h-5 rounded-sm"
        />
        <div className="flex-1 text-left min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-display text-sm font-bold uppercase tracking-wide" style={{ color: 'var(--text-primary)' }}>
              {group.brand_name ?? 'Unknown Brand'}
            </span>
            <Badge variant="critical">{group.alerts.length} alerts</Badge>
          </div>
          <div className="font-mono text-[10px] text-[var(--text-secondary)]">{group.brand_domain ?? ''}</div>
        </div>
        <svg
          className={cn('w-4 h-4 text-[var(--text-secondary)] transition-transform', expanded && 'rotate-180')}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {expanded && (
        <>
          {/* Alert rows */}
          <div className="border-t border-[var(--border-base)]">
            {visibleAlerts.map(alert => {
              const score = extractScore(alert.summary);
              const handle = extractHandle(alert.title);
              const platform = extractPlatform(alert.title);
              const isSelected = selectedAlertId === alert.id;

              const sev = severityToBadge(alert.severity);
              return (
                <DataRow
                  key={alert.id}
                  severity={sev}
                  unread={alert.status === 'new'}
                  onClick={() => onSelectAlert(alert)}
                  className={cn('flex items-center gap-3', isSelected && 'bg-[var(--amber-glow)]')}
                >
                  {/* Severity dot — uses the shared design-system
                      primitive so the dot color + pulse semantics
                      stay consistent across pages. R8 migration. */}
                  <SeverityDot
                    severity={sev}
                    size={8}
                    pulse={alert.severity === 'critical' || alert.severity === 'high'}
                  />

                  {/* Handle + platform. The real <button> is the row's keyboard
                      control (standard: row click is a mouse convenience only). */}
                  <button
                    type="button"
                    id={`alert-row-${alert.id}`}
                    aria-expanded={isSelected}
                    aria-controls={`alert-detail-${alert.id}`}
                    onClick={e => { e.stopPropagation(); onSelectAlert(alert); }}
                    className="ds-focusable flex-1 min-w-0 text-left rounded-sm"
                  >
                    <span className="block">
                      <span className="font-mono text-[11px] font-semibold" style={{ color: 'var(--text-primary)' }}>{handle}</span>
                      <span className="font-mono text-[10px] ml-1.5" style={{ color: 'var(--text-tertiary)' }}>on</span>
                      <span
                        className="ml-1.5 inline-flex items-center font-mono text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded"
                        style={platformBadgeStyle(platform)}
                      >
                        {platform}
                      </span>
                    </span>
                    {alert.saas_technique_name && alert.saas_technique_phase_label && (
                      <span
                        className="block"
                        style={{
                          fontSize:   9,
                          color:      'var(--text-muted)',
                          fontFamily: 'var(--font-mono)',
                          marginTop:  2,
                          letterSpacing: '0.06em',
                          textTransform: 'uppercase',
                        }}
                      >
                        {alert.saas_technique_name} · {alert.saas_technique_phase_label}
                      </span>
                    )}
                  </button>

                  {/* Score */}
                  {score !== null && (
                    <span className={cn(
                      'font-mono text-[12px] font-bold tabular-nums',
                      score >= 75 ? 'text-[#fb923c]' : 'text-[var(--text-tertiary)]',
                    )}>
                      {score}%
                    </span>
                  )}

                  {/* Severity badge */}
                  <Badge severity={sev}>{alert.severity}</Badge>

                  {/* AI verdict badge — visible when Tier 3 judge has
                      stamped a verdict on this alert. Lets operators
                      scan the residual queue at a glance instead of
                      opening every row. */}
                  {(() => {
                    const v = parseAiAssessment(alert.ai_assessment);
                    if (!v) return null;
                    const s = AI_VERDICT_STYLE[v.verdict];
                    return (
                      <span
                        className="font-mono text-[9px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded"
                        style={{ background: s.bg, color: s.color }}
                        title={`AI confidence ${v.confidence}%`}
                      >
                        {s.label}
                      </span>
                    );
                  })()}

                  {/* Status — shared Badge primitive. R8 migration:
                      replaces an inline pill that had its own color
                      mapping. */}
                  <Badge
                    status={
                      alert.status === 'new'           ? 'pending'  :
                      alert.status === 'acknowledged'  ? 'warning'  :
                      alert.status === 'resolved'      ? 'success'  :
                                                         'inactive'
                    }
                    label={alert.status === 'false_positive' ? 'dismissed' : alert.status}
                    size="sm"
                  />

                  {/* Owner — who has claimed this signal (W9). */}
                  {alert.staff_assigned_to && (
                    <span
                      className="font-mono text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded flex-shrink-0"
                      style={{ background: 'rgba(124,138,255,0.14)', color: '#9aa6ff' }}
                      title={alert.staff_assigned_to === currentUserId
                        ? 'Assigned to you'
                        : `Assigned to ${alert.staff_assigned_to_name ?? alert.staff_assigned_to_email ?? 'analyst'}`}
                    >
                      {alert.staff_assigned_to === currentUserId
                        ? 'You'
                        : parseInitials(alert.staff_assigned_to_name, alert.staff_assigned_to_email)}
                    </span>
                  )}

                  {/* SLA / aging — only flagged once an open alert is
                      approaching (warn) or past (breach) its window. */}
                  {(() => {
                    const sla = slaFor(alert);
                    if (!sla.open || sla.state === 'ok') return null;
                    const breach = sla.state === 'breach';
                    return (
                      <span
                        className="font-mono text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded flex-shrink-0"
                        style={{
                          background: breach ? 'rgba(239,68,68,0.12)' : 'rgba(251,191,36,0.12)',
                          color: breach ? '#f87171' : '#fbbf24',
                        }}
                        title={`${alert.severity} SLA ${SLA_MINUTES[severityToBadge(alert.severity)]}m`}
                      >
                        {breach ? `Overdue ${fmtDuration(sla.overdueMs)}` : `Due ${fmtDuration(sla.remainingMs)}`}
                      </span>
                    );
                  })()}

                  {/* Time */}
                  <span className="font-mono text-[10px] text-[var(--text-secondary)] tabular-nums w-14 text-right flex-shrink-0">
                    {timeAgo(alert.created_at)}
                  </span>
                </DataRow>
              );
            })}
          </div>

          {/* Show more + actions */}
          <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 border-t border-[var(--border-base)]">
            <div className="flex items-center gap-2">
              {remaining > 0 && !showAll && (
                <button
                  onClick={() => setShowAll(true)}
                  className="font-mono text-[10px] font-semibold hover:opacity-80 transition-colors" style={{ color: 'var(--amber)' }}
                >
                  + {remaining} more
                </button>
              )}
              {showAll && remaining > 0 && (
                <button
                  onClick={() => setShowAll(false)}
                  className="font-mono text-[10px] font-semibold text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
                >
                  Show less
                </button>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {!canEdit && (
                <span
                  role="note"
                  aria-label={READ_ONLY_COPY}
                  className="font-mono text-[10px] uppercase tracking-wide text-[var(--text-secondary)]"
                >
                  Read-only
                </span>
              )}
              {canEdit && newCount > 0 && (
                <button
                  onClick={onAcknowledgeAll}
                  disabled={bulkBusy}
                  className="font-mono text-[10px] font-semibold uppercase tracking-wide px-3 py-1.5 rounded-md border border-[var(--amber-border)] text-[var(--amber)] hover:bg-[var(--amber-glow)] transition-all disabled:opacity-50"
                >
                  {bulk?.kind === 'ack' ? bulk.text : 'Acknowledge All'}
                </button>
              )}
              {canEdit && canTakedown && (
              <button
                onClick={onCreateTakedowns}
                disabled={bulkBusy}
                className="font-mono text-[10px] font-semibold uppercase tracking-wide px-3 py-1.5 rounded-md bg-accent hover:bg-accent/80 transition-all disabled:opacity-50" style={{ color: 'var(--text-primary)' }}
              >
                {bulk?.kind === 'takedown' ? bulk.text : 'Create Takedowns'}
              </button>
              )}
            </div>
          </div>
        </>
      )}
    </Card>
  );
}

// ── Alert Detail Panel ──────────────────────────────────────────

interface AlertDetailProps {
  alert: Alert;
  currentUserId: string | null;
  onClose: () => void;
  onUpdate: (status: string, notes?: string | null) => void;
  onAssign: (assignedTo: string | null) => void;
  isUpdating: boolean;
  isAssigning: boolean;
  canEdit: boolean;
  cardRef?: React.Ref<HTMLDivElement>;
}

function AlertDetail({ alert, currentUserId, onClose, onUpdate, onAssign, isUpdating, isAssigning, canEdit, cardRef }: AlertDetailProps) {
  const [notes, setNotes] = useState(alert.staff_notes ?? '');
  const score = extractScore(alert.summary);
  const handle = extractHandle(alert.title);
  const platform = extractPlatform(alert.title);

  return (
    <Card
      ref={cardRef}
      id={`alert-detail-${alert.id}`}
      role="region"
      aria-label={`Alert: ${alert.title}`}
      aria-describedby={canEdit ? undefined : `alert-readonly-${alert.id}`}
      tabIndex={-1}
      variant="active"
      style={{ padding: '20px', marginTop: 4 }}
      className="outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--amber)]"
      data-testid="alert-detail"
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Badge severity={severityToBadge(alert.severity)}>{alert.severity}</Badge>
          <span
            className="font-mono text-[9px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded"
            style={{
              background:
                alert.status === 'new' ? 'var(--sev-high-bg)' :
                alert.status === 'acknowledged' ? 'var(--amber-glow)' :
                alert.status === 'resolved' ? 'var(--sev-info-bg)' :
                alert.status === 'false_positive' ? 'var(--border-base)' :
                'transparent',
              color:
                alert.status === 'new' ? 'var(--sev-high)' :
                alert.status === 'acknowledged' ? 'var(--amber)' :
                alert.status === 'resolved' ? 'var(--sev-info)' :
                alert.status === 'false_positive' ? 'var(--text-tertiary)' :
                'var(--text-secondary)',
            }}
          >
            {alert.status === 'false_positive' ? 'dismissed' : alert.status}
          </span>
          <Badge status="running" label={humanizeType(alert.alert_type)} size="xs" />
          {isAutoTriaged(alert.resolution_notes) && (
            <Badge status="inactive" label="Auto-triaged" size="xs" />
          )}
        </div>
        <Button variant="ghost" size="sm" aria-label="Close alert detail" onClick={onClose} icon={<X size={14} aria-hidden />} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        {/* LEFT — Alert Details */}
        <div className="space-y-3">
          <div className="font-mono text-[9px] uppercase tracking-widest text-[var(--text-muted)] mb-2">Alert Details</div>

          <Link
            to={`/brands/${alert.brand_id}`}
            className="flex items-center gap-2 group"
            title="Open brand"
          >
            <img
              src={`https://www.google.com/s2/favicons?domain=${alert.brand_domain ?? 'example.com'}&sz=32`}
              alt=""
              className="w-4 h-4 rounded-sm"
            />
            <span className="font-display text-sm font-bold group-hover:text-[var(--amber)] transition-colors" style={{ color: 'var(--text-primary)' }}>{alert.brand_name ?? 'Unknown'}</span>
            <span className="font-mono text-[10px] text-[var(--text-secondary)]">{alert.brand_domain ?? ''}</span>
          </Link>

          {/* Outbound pivots — the detail used to be a dead-end (no links
              out). Brand detail + this brand's threat slice for context, and
              the exact source threat when this alert came from one. */}
          <div className="flex flex-col gap-1">
            {alert.source_type === 'threat' && alert.source_id && (
              <Link
                to={`/console?tab=threats&q=${encodeURIComponent(alert.source_id)}`}
                className="inline-flex items-center gap-1 font-mono text-[10px] text-[var(--text-tertiary)] hover:text-[var(--amber)] transition-colors"
              >
                View source threat →
              </Link>
            )}
            <Link
              to={`/console?tab=threats&brand_id=${encodeURIComponent(alert.brand_id)}`}
              className="inline-flex items-center gap-1 font-mono text-[10px] text-[var(--text-tertiary)] hover:text-[var(--amber)] transition-colors"
            >
              View brand's threats →
            </Link>
          </div>

          <div>
            <div className="font-mono text-[9px] text-[var(--text-secondary)] uppercase tracking-wide mb-0.5">Platform</div>
            <span
              className="inline-flex items-center font-mono text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded"
              style={platformBadgeStyle(platform)}
            >
              {platform}
            </span>
          </div>

          <div>
            <div className="font-mono text-[9px] text-[var(--text-secondary)] uppercase tracking-wide mb-0.5">Handle Detected</div>
            <span className="font-mono text-[13px] font-bold" style={{ color: 'var(--text-primary)' }}>{handle}</span>
          </div>

          {score !== null && (
            <div>
              <div className="font-mono text-[9px] text-[var(--text-secondary)] uppercase tracking-wide mb-1">Impersonation Score</div>
              <div className="flex items-baseline gap-2">
                <span
                  className="font-display text-[28px] font-extrabold tabular-nums leading-none"
                  style={score >= 75
                    ? { color: '#fb923c', textShadow: '0 0 20px rgba(251,146,60,0.7)' }
                    : { color: 'var(--text-secondary)' }}
                >
                  {score}%
                </span>
              </div>
            </div>
          )}

          <div>
            <div className="font-mono text-[9px] text-[var(--text-secondary)] uppercase tracking-wide mb-0.5">Detected</div>
            <span className="font-mono text-[11px] text-[var(--text-secondary)]">{timeAgo(alert.created_at)}</span>
          </div>

          <div>
            <div className="font-mono text-[9px] text-[var(--text-secondary)] uppercase tracking-wide mb-0.5">Source</div>
            <span className="font-mono text-[11px] text-[var(--text-tertiary)]">
              {alert.source_type ? humanizeType(alert.source_type) : 'Social Monitor Agent'}
            </span>
          </div>
        </div>

        {/* CENTER — Evidence & Assessment */}
        <div className="space-y-3 md:border-l md:border-[var(--border-base)] md:pl-5">
          <div className="font-mono text-[9px] uppercase tracking-widest text-[var(--text-muted)] mb-2">Evidence & Assessment</div>

          <div>
            <div className="font-mono text-[9px] text-[var(--text-secondary)] uppercase tracking-wide mb-1">Summary</div>
            <p className="text-[12px] text-[var(--text-secondary)] leading-relaxed">{alert.summary}</p>
          </div>

          {score !== null && (
            <div>
              <div className="font-mono text-[9px] text-[var(--text-secondary)] uppercase tracking-wide mb-1">Score</div>
              <div className="w-full h-2 rounded-full bg-white/[0.06] overflow-hidden">
                <div
                  className="h-full rounded-full transition-all"
                  style={{
                    width: `${score}%`,
                    backgroundColor: score >= 75 ? '#fb923c' : score >= 50 ? '#fbbf24' : '#78A0C8',
                  }}
                />
              </div>
            </div>
          )}

          <div className="pt-2">
            <div className="font-mono text-[9px] text-[var(--text-secondary)] uppercase tracking-wide mb-1">AI Assessment</div>
            {alert.ai_assessment ? (
              <div className="space-y-2">
                <p className="text-[12px] text-[var(--text-secondary)] leading-relaxed">{alert.ai_assessment}</p>
                {alert.ai_recommendations && (
                  <div>
                    <div className="font-mono text-[9px] text-[var(--text-secondary)] uppercase tracking-wide mb-1">Recommendations</div>
                    <p className="text-[12px] text-[var(--text-tertiary)] leading-relaxed">{alert.ai_recommendations}</p>
                  </div>
                )}
              </div>
            ) : (
              <div className="text-[11px] text-[var(--text-secondary)] italic">No AI assessment yet</div>
            )}
          </div>
        </div>

        {/* RIGHT — Actions */}
        <div className="space-y-3 md:border-l md:border-[var(--border-base)] md:pl-5">
          <div className="font-mono text-[9px] uppercase tracking-widest text-[var(--text-muted)] mb-2">Actions</div>

          {!canEdit && (
            <p id={`alert-readonly-${alert.id}`} className="text-[11px] leading-relaxed text-[var(--text-secondary)]">
              {READ_ONLY_COPY}
            </p>
          )}

          {/* Owner / assignment (W9). Staff owner only — the customer's own
              assignee is a separate, read-only field. */}
          <div className="pb-2 mb-1 border-b border-[var(--border-base)] space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="font-mono text-[9px] text-[var(--text-secondary)] uppercase tracking-wide">Averrow owner</div>
                <div className="font-mono text-[11px] truncate" style={{ color: alert.staff_assigned_to ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                  {alert.staff_assigned_to
                    ? (alert.staff_assigned_to === currentUserId ? 'You' : (alert.staff_assigned_to_name || alert.staff_assigned_to_email || 'Assigned'))
                    : 'Unassigned'}
                </div>
              </div>
              {!canEdit ? null : alert.staff_assigned_to === currentUserId ? (
                <button
                  onClick={() => onAssign(null)}
                  disabled={isAssigning}
                  className="font-mono text-[10px] font-semibold uppercase tracking-wide px-2.5 py-1 rounded-md border border-white/10 text-[var(--text-tertiary)] hover:bg-white/[0.04] transition-all disabled:opacity-50 flex-shrink-0"
                >
                  Unassign
                </button>
              ) : (
                <button
                  onClick={() => currentUserId && onAssign(currentUserId)}
                  disabled={isAssigning || !currentUserId}
                  className="font-mono text-[10px] font-semibold uppercase tracking-wide px-2.5 py-1 rounded-md border border-[var(--amber-border)] text-[var(--amber)] hover:bg-[var(--amber-glow)] transition-all disabled:opacity-50 flex-shrink-0"
                >
                  {alert.staff_assigned_to ? 'Take over' : 'Assign to me'}
                </button>
              )}
            </div>
            {alert.assigned_to && (
              <div className="min-w-0">
                <div className="font-mono text-[9px] text-[var(--text-secondary)] uppercase tracking-wide">Customer assignee</div>
                <div className="font-mono text-[11px] truncate" style={{ color: 'var(--text-primary)' }}>
                  {alert.assigned_to_name || alert.assigned_to_email || 'Assigned'}
                </div>
              </div>
            )}
          </div>

          <div className="flex flex-col gap-2">
            {canEdit && alert.status === 'new' && (
              <>
                <button
                  onClick={() => onUpdate('acknowledged')}
                  disabled={isUpdating}
                  className="w-full font-mono text-[10px] font-semibold uppercase tracking-wide px-3 py-2 rounded-md border border-[var(--amber-border)] text-[var(--amber)] hover:bg-[var(--amber-glow)] transition-all disabled:opacity-50"
                >
                  Acknowledge
                </button>
                <button
                  onClick={() => onUpdate('false_positive')}
                  disabled={isUpdating}
                  className="w-full font-mono text-[10px] font-semibold uppercase tracking-wide px-3 py-2 rounded-md border border-white/10 text-[var(--text-tertiary)] hover:bg-white/[0.04] transition-all disabled:opacity-50"
                >
                  Dismiss
                </button>
              </>
            )}
            {canEdit && alert.status === 'acknowledged' && (
              <>
                <button
                  onClick={() => onUpdate('resolved')}
                  disabled={isUpdating}
                  className="w-full font-mono text-[10px] font-semibold uppercase tracking-wide px-3 py-2 rounded-md bg-[#28A050] text-white hover:bg-[#28A050]/80 transition-all disabled:opacity-50"
                >
                  Mark Resolved
                </button>
                <button
                  onClick={() => onUpdate('new')}
                  disabled={isUpdating}
                  className="w-full font-mono text-[10px] font-semibold uppercase tracking-wide px-3 py-2 rounded-md border border-white/10 text-[var(--text-tertiary)] hover:bg-white/[0.04] transition-all disabled:opacity-50"
                >
                  Re-open
                </button>
              </>
            )}
            {canEdit && alert.status === 'resolved' && (
              <button
                onClick={() => onUpdate('new')}
                disabled={isUpdating}
                className="w-full font-mono text-[10px] font-semibold uppercase tracking-wide px-3 py-2 rounded-md border border-white/10 text-[var(--text-tertiary)] hover:bg-white/[0.04] transition-all disabled:opacity-50"
              >
                Re-open
              </button>
            )}
            {canEdit && alert.status === 'false_positive' && (
              <button
                onClick={() => onUpdate('new')}
                disabled={isUpdating}
                className="w-full font-mono text-[10px] font-semibold uppercase tracking-wide px-3 py-2 rounded-md border border-white/10 text-[var(--text-tertiary)] hover:bg-white/[0.04] transition-all disabled:opacity-50"
              >
                Re-open
              </button>
            )}
          </div>

          {/* Notes */}
          <div className="pt-2">
            <div className="font-mono text-[9px] text-[var(--text-secondary)] uppercase tracking-wide mb-1">Internal notes — not visible to customers</div>
            {!canEdit && !(alert.staff_notes ?? '') ? (
              <p className="font-mono text-[11px] text-[var(--text-secondary)]">No notes</p>
            ) : (
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="Add notes..."
              aria-label="Internal notes — not visible to customers"
              readOnly={!canEdit}
              aria-describedby={canEdit ? undefined : `alert-readonly-${alert.id}`}
              rows={3}
              className="w-full rounded-md bg-white/[0.04] border border-white/[0.08] px-3 py-2 text-[11px] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--amber-border)] resize-none font-mono" style={{ color: 'var(--text-primary)' }}
            />
            )}
            {canEdit && notes !== (alert.staff_notes ?? '') && (
              <button
                onClick={() => onUpdate(alert.status, notes.trim() ? notes : null)}
                disabled={isUpdating}
                className="mt-1.5 font-mono text-[10px] font-semibold uppercase tracking-wide px-3 py-1.5 rounded-md bg-[var(--amber-glow)] text-[var(--amber)] border border-[var(--amber-border)] hover:bg-[var(--amber-glow)] transition-all disabled:opacity-50"
              >
                Save Notes
              </button>
            )}
          </div>

          {/* Resolution / dismissal reason — now shown for dismissed
              (false_positive) alerts too, not just resolved. This is where
              the auto-triage reason ("auto: matches brand official handle")
              becomes visible, so an operator can see WHY an alert was
              auto-dismissed instead of it silently vanishing. */}
          {(alert.status === 'resolved' || alert.status === 'false_positive') && alert.resolution_notes && (
            <div className="pt-2">
              <div className="font-mono text-[9px] text-[var(--text-secondary)] uppercase tracking-wide mb-1">
                {alert.status === 'false_positive' ? 'Dismissal reason' : 'Resolution notes'}
                {isAutoTriaged(alert.resolution_notes) && (
                  <span className="ml-1.5 text-[var(--text-muted)] normal-case">· auto-triaged</span>
                )}
              </div>
              <p className="text-[11px] text-[var(--text-secondary)] leading-relaxed">{alert.resolution_notes}</p>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}


// ── Main Page ───────────────────────────────────────────────────

export function Alerts() {
  // Filters + the open alert live in the URL (`status`, `severity`, `alert_type`,
  // `alert`) so bell / Home / banner links land on the right slice and a view can
  // be shared. Other params (the Console's `tab`) are preserved on every write.
  const [params, setParams] = useSearchParams();
  const statusParam = paramIn(params, 'status', URL_STATUSES);
  const severityParam = paramIn(params, 'severity', URL_SEVERITIES);
  const typeParam = paramIn(params, 'alert_type');
  const alertParam = params.get('alert') || null;
  const filters: AlertFilters = useMemo(
    () => ({ limit: 200, status: statusParam, severity: severityParam, alert_type: typeParam }),
    [statusParam, severityParam, typeParam],
  );
  const writeParams = (patch: Record<string, string | undefined>) => {
    setParams(prev => {
      const next = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined || v === '' || v === 'all') next.delete(k);
        else next.set(k, v);
      }
      return next;
    }, { replace: true });
  };
  // Local optimistic overlay for assign (the list refetch then supersedes it).
  const [assignOverlay, setAssignOverlay] = useState<Pick<Alert, 'id' | 'staff_assigned_to' | 'staff_assigned_to_name' | 'staff_assigned_to_email'> | null>(null);
  const [search, setSearch] = useState('');
  // AI verdict filter is client-side: ai_assessment isn't an indexed
  // column on alerts, and the API doesn't accept a verdict param yet.
  // Operating on the (limited) returned set is the right scope for
  // now — operator usually filters by status+severity first which
  // already narrows hard.
  const [aiVerdictFilter, setAiVerdictFilter] = useState<'all' | AiVerdict | 'unjudged'>('all');
  const [slaFilter, setSlaFilter] = useState<'all' | 'atrisk' | 'breached'>('all');
  const [mineOnly, setMineOnly] = useState(false);
  const { user } = useAuth();
  const currentUserId = user?.id ?? null;
  // Staff see every platform alert; only edit_alerts holders may act on them
  // (the worker 403s everyone else — this keeps the UI from offering it).
  const canEdit = roleHasPermission(user?.role, 'edit_alerts');
  // Takedowns are a separate permission: support can triage but not file them.
  const canTakedown = roleHasPermission(user?.role, 'manage_takedowns');

  const { data: statsData, isLoading: statsLoading, isError: statsError } = useAlertStats();
  const {
    data: alertsData, isLoading: alertsLoading, isError: alertsError,
    isPlaceholderData: alertsPlaceholder, refetch: refetchAlerts,
  } = useAlerts({
    ...filters,
    search: search || undefined,
  });

  const updateAlert = useUpdateAlert();
  const assignAlert = useAssignAlert();
  const bulkAck = useBulkAcknowledge();
  const bulkTakedown = useBulkTakedown();
  // Bulk actions run in batches of <= BULK_BATCH (the worker 400s above that and
  // a brand_id call only processes one batch, reporting `remaining`).
  const [bulkRun, setBulkRun] = useState<{ brandId: string; kind: 'ack' | 'takedown'; text: string } | null>(null);
  const runBulk = async (
    group: BrandGroup,
    kind: 'ack' | 'takedown',
    ackIds: string[],
  ) => {
    const verb = kind === 'ack' ? 'Acknowledging' : 'Creating';
    const fail = kind === 'ack' ? "Couldn't acknowledge the alerts" : "Couldn't create takedowns";
    const show = (done: number, total: number) =>
      setBulkRun({ brandId: group.brand_id, kind, text: `${verb} ${done} of ${total}…` });
    setActionError(null);
    setBulkRun({ brandId: group.brand_id, kind, text: `${verb}…` });
    try {
      let done = 0;
      let total = kind === 'ack' ? ackIds.length : 0;
      let left = 0;
      for (let i = 0; i < MAX_BULK_BATCHES; i++) {
        let res;
        if (kind === 'ack') {
          const chunk = ackIds.slice(done, done + BULK_BATCH);
          if (chunk.length === 0) break;
          res = await bulkAck.mutateAsync({ alert_ids: chunk });
        } else {
          res = await bulkTakedown.mutateAsync({ brand_id: group.brand_id });
        }
        if (res.success === false) throw new Error(res.error ?? 'the request was rejected');
        const data = res.data as BulkAckResult | BulkTakedownResult | undefined;
        const processed = data?.alert_ids?.length ?? (kind === 'ack' ? Math.min(BULK_BATCH, ackIds.length - done) : 0);
        done += processed;
        left = kind === 'ack' ? ackIds.length - done : (data?.remaining ?? 0);
        if (kind === 'takedown') total = done + left;
        show(done, total);
        if (left <= 0) return;
        if (processed === 0) throw new Error(`no progress (${left} still pending)`);
      }
      if (left > 0) throw new Error(`stopped after ${MAX_BULK_BATCHES} batches; ${left} still pending — run it again`);
    } catch (e) {
      setActionError(`${fail}: ${e instanceof Error ? e.message : 'request failed'}`);
    } finally {
      setBulkRun(null);
    }
  };
  // A JSON { success:false } resolves rather than throws, so both paths land
  // here and surface as a visible inline error instead of failing silently.
  const [actionError, setActionError] = useState<string | null>(null);
  const mutationCallbacks = (label: string, onOk?: () => void, onFail?: () => void) => ({
    onSuccess: (res: { success?: boolean; error?: string } | undefined) => {
      if (res && res.success === false) {
        setActionError(`${label}: ${res.error ?? 'the request was rejected'}`);
        onFail?.();
      } else {
        setActionError(null);
        onOk?.();
      }
    },
    onError: (e: Error) => {
      setActionError(`${label}: ${e.message}`);
      onFail?.();
    },
  });

  const rawAlerts = Array.isArray(alertsData?.alerts) ? alertsData.alerts : [];

  // The open alert: from the loaded list when present, otherwise fetched by id
  // (it may be filtered out, beyond the page limit, or already handled).
  const listed = alertParam ? rawAlerts.find(a => a.id === alertParam) ?? null : null;
  const fetchedAlert = useAlert(alertParam, { enabled: !listed && !alertsLoading });
  const baseSelected = listed ?? fetchedAlert.data ?? null;
  const selectedAlert: Alert | null = baseSelected && assignOverlay?.id === baseSelected.id
    ? { ...baseSelected, ...assignOverlay }
    : baseSelected;
  const selfSelected = useRef<string | null>(null);
  const detailRef = useRef<HTMLDivElement | null>(null);
  const detailCardRef = useRef<HTMLDivElement | null>(null);
  const listHeadingRef = useRef<HTMLDivElement | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const selectAlert = (a: Alert | null) => {
    selfSelected.current = a?.id ?? null;
    writeParams({ alert: a?.id });
  };
  // Closing returns focus to the row control that opened it, or the list
  // heading when that row isn't on screen (fetched-by-id / filtered out).
  const closeDetail = (id: string | null) => {
    selectAlert(null);
    setAnnouncement('');
    const row = id ? document.getElementById(`alert-row-${id}`) : null;
    (row ?? listHeadingRef.current)?.focus();
  };

  // Deep-link arrival (initial load, bell / Home links, back/forward) — NOT
  // list clicks, which set selfSelected first. Those get scroll + focus +
  // an announcement once the detail has rendered; clicks leave focus on the row.
  const pendingFocus = useRef<string | null>(alertParam);
  useEffect(() => {
    if (alertParam && alertParam !== selfSelected.current) pendingFocus.current = alertParam;
  }, [alertParam]);
  const selectedId = selectedAlert?.id ?? null;
  useEffect(() => {
    const card = detailCardRef.current;
    if (!selectedId || pendingFocus.current !== selectedId || !card) return;
    pendingFocus.current = null;
    card.scrollIntoView?.({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    card.focus({ preventScroll: true });
    setAnnouncement('Alert opened');
  }, [selectedId]);
  const alerts = rawAlerts.filter(a => {
    // AI verdict filter
    if (aiVerdictFilter !== 'all') {
      const v = parseAiAssessment(a.ai_assessment);
      if (aiVerdictFilter === 'unjudged') { if (v !== null) return false; }
      else if (v?.verdict !== aiVerdictFilter) return false;
    }
    // SLA filter
    if (slaFilter !== 'all') {
      const s = slaFor(a).state;
      if (slaFilter === 'breached' && s !== 'breach') return false;
      if (slaFilter === 'atrisk' && s === 'ok') return false; // warn or breach
    }
    // Mine — alerts this analyst owns
    if (mineOnly && currentUserId && a.staff_assigned_to !== currentUserId) return false;
    return true;
  });
  const stats = statsData && typeof statsData.total === 'number' ? statsData : undefined;

  // SLA breach/at-risk counts over the fetched queue (open alerts only).
  const slaBreached = rawAlerts.filter(a => slaFor(a).state === 'breach').length;
  const slaAtRisk = rawAlerts.filter(a => slaFor(a).state === 'warn').length;

  const groups = useMemo(() => groupByBrand(alerts), [alerts]);

  // Error beats loading beats empty. A failed refetch that still has this
  // filter's data on screen keeps it and shows an inline error instead; a
  // keepPreviousData placeholder is the PREVIOUS filter's rows, so it does
  // not count as data here.
  // null = still loading / failed (StatTile shows "—" or "Couldn't load");
  // never a misleading 0 for a stat that has not arrived.
  const statValue = (n: number | undefined): number | null =>
    stats ? (n ?? 0) : (statsLoading || statsError ? null : 0);

  const listFailed = alertsError && (!alertsData || alertsPlaceholder);
  const listKind = pageStateKind({
    isLoading: alertsLoading,
    isError: listFailed,
    isEmpty: groups.length === 0,
  });
  const filtersActive =
    !!search || aiVerdictFilter !== 'all' || slaFilter !== 'all' || mineOnly ||
    !!filters.severity || !!filters.status || !!filters.alert_type;

  const setFilter = (key: 'status' | 'severity' | 'alert_type', value: string) => {
    selfSelected.current = null;
    writeParams({ [key]: value === 'all' ? undefined : value, alert: undefined });
  };

  // Saved views (W6) — capture/restore the full operator filter state.
  const { views, saveView, removeView } = useSavedViews<AlertViewState>('alerts.saved_views');
  const currentView: AlertViewState = {
    severity: filters.severity,
    status: filters.status,
    alert_type: filters.alert_type,
    search: search || undefined,
    ai: aiVerdictFilter,
    sla: slaFilter,
  };
  const applyView = (fv: AlertViewState) => {
    selfSelected.current = null;
    writeParams({ severity: fv.severity, status: fv.status, alert_type: fv.alert_type, alert: undefined });
    setSearch(fv.search ?? '');
    setAiVerdictFilter(fv.ai ?? 'all');
    setSlaFilter(fv.sla ?? 'all');
  };
  const onSaveView = () => {
    const name = window.prompt('Name this view (e.g. "New app-store impers")');
    if (name?.trim()) saveView(name.trim(), normView(currentView));
  };
  const allViews = [...PRESET_VIEWS, ...views];

  const detail = selectedAlert && (
    <div ref={detailRef}>
      <AlertDetail
        key={selectedAlert.id}
        cardRef={detailCardRef}
        alert={selectedAlert}
        currentUserId={currentUserId}
        canEdit={canEdit}
        onClose={() => closeDetail(selectedAlert.id)}
        onUpdate={(status, notes) => {
          if (!canEdit) return;
          updateAlert.mutate(
            { id: selectedAlert.id, status, notes },
            mutationCallbacks("Couldn't update the alert", () => closeDetail(selectedAlert.id)),
          );
        }}
        onAssign={(assignedTo) => {
          if (!canEdit) return;
          // Keep the panel open and update in place so the operator
          // sees the owner change immediately.
          assignAlert.mutate(
            { id: selectedAlert.id, staff_assigned_to: assignedTo },
            {
              ...mutationCallbacks("Couldn't change the owner"),
              // Refetched data (or the pre-assign state after a failure) wins.
              onSettled: () => setAssignOverlay(null),
            },
          );
          setAssignOverlay({
            id: selectedAlert.id,
            staff_assigned_to: assignedTo,
            staff_assigned_to_name: assignedTo === currentUserId ? (user?.name ?? null) : selectedAlert.staff_assigned_to_name,
            staff_assigned_to_email: assignedTo === currentUserId ? (user?.email ?? null) : selectedAlert.staff_assigned_to_email,
          });
        }}
        isUpdating={updateAlert.isPending}
        isAssigning={assignAlert.isPending}
      />
    </div>
  );
  const detailInList = !!selectedAlert && alerts.some(a => a.id === selectedAlert.id);
  const detailFetchFailed = !!alertParam && !listed && fetchedAlert.isError;
  const detailLoading = !!alertParam && !listed && fetchedAlert.isLoading;
  useEffect(() => {
    if (detailFetchFailed && pendingFocus.current === alertParam) {
      pendingFocus.current = null;
      setAnnouncement("Couldn't open that alert");
    }
  }, [detailFetchFailed, alertParam]);

  return (
    <div className="space-y-5">
      <div ref={listHeadingRef} tabIndex={-1} className="outline-none">
        <PageHeader title="Alerts" subtitle="Brand alerts across all monitored brands — SOC triage view" />
      </div>
      <div role="status" aria-live="polite" className="sr-only">{announcement}</div>

      <StatGrid cols={4}>
        <StatTile
          label="Total Alerts"
          value={statValue(stats?.total)}
          error={statsError && !stats}
          accent="var(--red)"
        />
        <StatTile
          label="New / Unacknowledged"
          value={statValue(stats?.new_count)}
          error={statsError && !stats}
          accent="var(--sev-high)"
        />
        <StatTile
          label="Acknowledged"
          value={statValue(stats?.acknowledged)}
          error={statsError && !stats}
          accent="var(--amber)"
        />
        <StatTile
          label="Resolved"
          value={statValue(stats?.resolved)}
          error={statsError && !stats}
          accent="var(--green)"
        />
      </StatGrid>

      {/* Auto-triage transparency (W5/W7) — how much noise rule + AI triage
          has cleared, so the auto-dismissals aren't a black box. */}
      {stats && stats.dismissed > 0 && (
        <div className="font-mono text-[10px] text-[var(--text-muted)] -mt-2">
          Auto-triage cleared {stats.auto_dismissed} of {stats.dismissed} dismissed signals
          {stats.dismissed > 0 ? ` (${Math.round((stats.auto_dismissed / stats.dismissed) * 100)}%)` : ''} — rule + AI judge
        </div>
      )}

      {stats && stats.new_count > 0 && (
        <Card variant="critical" style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
          <SeverityDot severity="critical" size={10} pulse />
          <span className="font-mono text-[11px] font-semibold" style={{ color: 'var(--text-primary)' }}>
            {stats.new_count} unacknowledged {stats.high > 0 ? 'HIGH' : ''} severity alert{stats.new_count !== 1 ? 's' : ''} require review
          </span>
        </Card>
      )}

      {/* SLA breach banner — open alerts past their severity window. */}
      {slaBreached > 0 && (
        <Card variant="critical" style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
          <SeverityDot severity="critical" size={10} pulse />
          <span className="font-mono text-[11px] font-semibold" style={{ color: 'var(--text-primary)' }}>
            {slaBreached} open alert{slaBreached !== 1 ? 's' : ''} past SLA
            {slaAtRisk > 0 ? ` · ${slaAtRisk} approaching` : ''}
          </span>
          <button
            onClick={() => setSlaFilter('breached')}
            className="ml-auto font-mono text-[10px] font-semibold uppercase tracking-wide px-2.5 py-1 rounded-md border border-afterburner-border text-[#E5A832] hover:bg-afterburner-muted transition-all"
          >
            Show breached
          </button>
        </Card>
      )}

      {!canEdit && (
        <div id={READ_ONLY_NOTE_ID} className="font-mono text-[11px] text-[var(--text-secondary)]" role="note">{READ_ONLY_COPY}</div>
      )}

      {/* Saved views (W6) — presets + user-pinned filter sets */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="flex items-center gap-1 font-mono text-[9px] uppercase tracking-widest text-white/55 mr-0.5">
          <Star size={11} /> Views
        </span>
        {allViews.map(v => {
          const active = sameView(currentView, v.filters);
          const isPreset = v.id.startsWith('preset:');
          return (
            <span
              key={v.id}
              className={cn(
                'group inline-flex items-center gap-1 font-mono text-[10px] font-semibold px-2.5 py-1 rounded-md border transition-all cursor-pointer',
                active
                  ? 'bg-afterburner-muted text-[#E5A832] border-afterburner-border'
                  : 'bg-white/[0.03] text-[var(--text-tertiary)] border-white/[0.06] hover:border-white/15 hover:text-[var(--text-secondary)]',
              )}
              onClick={() => applyView(v.filters)}
            >
              {v.name}
              {!isPreset && (
                <button
                  onClick={(e) => { e.stopPropagation(); removeView(v.id); }}
                  className="opacity-40 hover:opacity-100 transition-opacity"
                  title="Delete view"
                >
                  <X size={10} />
                </button>
              )}
            </span>
          );
        })}
        <button
          onClick={onSaveView}
          disabled={viewIsEmpty(currentView)}
          className="font-mono text-[10px] font-semibold px-2.5 py-1 rounded-md border border-dashed border-white/15 text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:border-white/25 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
          title={viewIsEmpty(currentView) ? 'Apply some filters first' : 'Save current filters as a view'}
        >
          + Save current
        </button>
      </div>

      <FilterBar
        search={{ value: search, onChange: setSearch, placeholder: 'Search alerts...' }}
        filters={[
          // Migration 0120 normalized alerts.severity to lowercase. The
          // filter values must match the DB shape — passing 'CRITICAL'
          // here returned zero rows because `WHERE severity='CRITICAL'`
          // never matched stored values like 'critical'. Lowercased
          // 2026-05-05 alongside the auto-triage rollout.
          { value: 'all',      label: 'All',      count: stats?.total },
          { value: 'critical', label: 'Critical', count: stats?.critical },
          { value: 'high',     label: 'High',     count: stats?.high },
          { value: 'medium',   label: 'Medium',   count: stats?.medium },
          // Low tier was missing from the original filter — audit H7
          // (2026-05-06) flagged the inconsistent severity scale vs.
          // /v2/threats which has all 5 tiers.
          { value: 'low',      label: 'Low',      count: stats?.low },
        ]}
        active={filters.severity ?? 'all'}
        onChange={v => setFilter('severity', v)}
      >
        <div className="flex flex-wrap items-center gap-4">
          <PillGroup
            label="Status"
            options={[
              { value: 'all', label: 'All' },
              { value: 'new', label: 'New' },
              { value: 'acknowledged', label: 'Ack' },
              { value: 'resolved', label: 'Resolved' },
              { value: 'false_positive', label: 'Dismissed' },
            ]}
            selected={filters.status ?? 'all'}
            onChange={v => setFilter('status', v)}
          />
          <PillGroup
            label="Type"
            options={[
              { value: 'all', label: 'All' },
              { value: 'social_impersonation', label: 'Social' },
              // App Store impersonation alerts are the largest single
              // family in the operator queue (1,938 of 2,631 in the
              // 2026-05-05 snapshot) — the original pill list omitted
              // them so the queue was filterable as 'All' or 'Social'
              // but never 'App Store' specifically. Added here so
              // operators can isolate the app-store family for bulk
              // triage actions.
              { value: 'app_store_impersonation', label: 'App Store' },
              { value: 'phishing_detected', label: 'Phishing' },
              { value: 'lookalike_domain_active', label: 'Lookalike' },
              { value: 'bimi_removed', label: 'BIMI Removed' },
              { value: 'dmarc_downgraded', label: 'DMARC Downgraded' },
              { value: 'vmc_expiring', label: 'VMC Expiring' },
              { value: 'typosquat_bimi', label: 'BIMI Spoofing' },
            ]}
            selected={filters.alert_type ?? 'all'}
            onChange={v => setFilter('alert_type', v)}
          />
          {/* AI Verdict — Tier 3 Haiku judge stamps a verdict +
              confidence on each alert it judges. Operators filter by
              this to scan AI-flagged threats first, ambiguous cases
              second, and skip alerts the AI judged as likely safe
              (those auto-dismiss at confidence >=90 anyway). The
              `unjudged` option surfaces alerts that haven't gone
              through the judge yet — useful right after running
              `/api/admin/alerts/run-ai-judge`. Filter is applied
              client-side over the page's returned set. */}
          <PillGroup
            label="AI Verdict"
            options={[
              { value: 'all',           label: 'All' },
              { value: 'active_threat', label: 'AI: Threat' },
              { value: 'needs_human',   label: 'AI: Review' },
              { value: 'likely_safe',   label: 'AI: Likely Safe' },
              { value: 'unjudged',      label: 'Unjudged' },
            ]}
            selected={aiVerdictFilter}
            onChange={v => setAiVerdictFilter(v as 'all' | AiVerdict | 'unjudged')}
          />
          {/* SLA — open alerts approaching (at-risk) or past (breached)
              their severity triage window. Client-side over the fetched
              set, same scope as the AI verdict filter. */}
          <PillGroup
            label="SLA"
            options={[
              { value: 'all',      label: 'All' },
              { value: 'atrisk',   label: 'At risk' },
              { value: 'breached', label: 'Breached' },
            ]}
            selected={slaFilter}
            onChange={v => setSlaFilter(v as 'all' | 'atrisk' | 'breached')}
          />
          {/* Mine — signals this analyst has claimed (W9). */}
          <button
            onClick={() => setMineOnly(m => !m)}
            disabled={!currentUserId}
            className={cn(
              'font-mono text-[10px] font-semibold uppercase tracking-wide px-2.5 py-1 rounded-md border transition-all disabled:opacity-30',
              mineOnly
                ? 'bg-afterburner-muted text-[#E5A832] border-afterburner-border'
                : 'bg-white/[0.03] text-[var(--text-muted)] border-white/[0.06] hover:border-white/15 hover:text-[var(--text-tertiary)]',
            )}
            title="Show only signals assigned to me"
          >
            Mine
          </button>
        </div>
      </FilterBar>

      {alertsError && !listFailed && (
        <PageState kind="error" layout="inline" title="Couldn't refresh alerts" description="Showing the last loaded list." onRetry={() => { void refetchAlerts(); }} />
      )}

      {listKind === 'loading' && <PageState kind="loading" layout="table" />}

      {listKind === 'error' && (
        <PageState kind="error" layout="card" title="Couldn't load alerts" onRetry={() => { void refetchAlerts(); }} />
      )}

      {/* A deep-linked alert that isn't in the (filtered) list below */}
      {selectedAlert && !detailInList && detail}
      {actionError && (
        <PageState
          kind="error"
          layout="inline"
          assertive
          title="Action failed"
          description={actionError}
          secondaryAction={{ label: 'Dismiss', onClick: () => setActionError(null) }}
        />
      )}

      {detailLoading && <PageState kind="loading" layout="inline" title="Opening alert…" />}
      {detailFetchFailed && (
        <PageState
          kind="error"
          layout="inline"
          assertive
          title="Couldn't open that alert"
          description="It may have been removed, or you may not have access to it."
          onRetry={() => { void fetchedAlert.refetch(); }}
          secondaryAction={{ label: 'Clear', onClick: () => closeDetail(null) }}
        />
      )}

      {/* Grouped alert list */}
      {(listKind === null || listKind === 'empty') && (
        <div className="space-y-3">
          {listKind === 'empty' && (filtersActive ? (
            <PageState
              kind="empty"
              layout="card"
              icon={<Bell />}
              title="No alerts match your filters"
              description="Try clearing a filter or changing the search."
            />
          ) : (
            <PageState
              kind="clear"
              layout="card"
              icon={<Bell />}
              title="No open alerts"
              description="The alert queue is clear. You're up to date."
            />
          ))}

          {groups.map(group => (
            <div key={group.brand_id}>
              <BrandGroupCard
                group={group}
                selectedAlertId={selectedAlert?.id ?? null}
                currentUserId={currentUserId}
                onSelectAlert={a => (selectedAlert?.id === a.id ? closeDetail(a.id) : selectAlert(a))}
                canEdit={canEdit}
                canTakedown={canTakedown}
                onAcknowledgeAll={() => {
                  // Acknowledge only the alerts visible in this group
                  // (post-filter), so the active AI verdict + status filters
                  // are respected; chunked to the worker's per-call cap.
                  const ids = group.alerts
                    .filter(a => a.status === 'new')
                    .map(a => a.id);
                  if (ids.length > 0) void runBulk(group, 'ack', ids);
                }}
                onCreateTakedowns={() => { void runBulk(group, 'takedown', []); }}
                bulk={bulkRun?.brandId === group.brand_id ? bulkRun : null}
                bulkBusy={bulkRun !== null}
              />

              {/* Detail panel - rendered below the group */}
              {selectedAlert && group.alerts.some(a => a.id === selectedAlert.id) && detail}
            </div>
          ))}
        </div>
      )}

      {/* Total count */}
      {!alertsLoading && alertsData && (
        <div className="text-center font-mono text-[10px] text-white/40 pb-4">
          Showing {alerts.length} of {alertsData.total} alerts
        </div>
      )}
    </div>
  );
}
