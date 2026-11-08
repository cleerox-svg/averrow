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
  KitButton,
  type Severity,
} from '@/design-system/components';
import { SeverityDot } from '@/components/ui/DataRow';
import { AlertQueueBanner } from './AlertQueueBanner';
import { parseUtc, formatSpan } from '@/lib/time';
import {
  useAlerts, useAlert, useAlertStats, useUpdateAlert, useAssignAlert, useBulkAcknowledge, useBulkTakedown,
  BULK_BATCH, type Alert, type AlertFilters, type BulkAckResult, type BulkTakedownResult,
} from '@/hooks/useAlerts';
import { useSavedViews, type SavedView } from '@/hooks/useSavedViews';
import { useAuth } from '@/lib/auth';
import { roleHasPermission } from '@/lib/permissions';
import { parseInitials } from '@/lib/avatar';
import { Bell, Star, X } from 'lucide-react';
import { useArrivalFlash } from '@averrow/shared/ui';
import { sentenceCase } from '@/lib/sentence-case';
import './alerts.css';

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
  const ageMs = Date.now() - parseUtc(alert.created_at).getTime();
  const pct = ageMs / slaMs;
  const state: SlaState = pct >= 1 ? 'breach' : pct >= 0.75 ? 'warn' : 'ok';
  return { open: true, state, remainingMs: slaMs - ageMs, overdueMs: ageMs - slaMs };
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

const HANDLE_RE = /@[\w.]+/;

function extractHandle(title: string): string {
  const m = title.match(HANDLE_RE);
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

// alerts.severity is now lowercase post-migration 0120, so the
// upper-to-lower-case translation map is gone. Direct cast.
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

// Chip tones live in alerts.css (data-tone); severity tokens only.
const AI_VERDICT_STYLE: Record<AiVerdict, { label: string; tone: 'critical' | 'medium' | 'ok' }> = {
  active_threat: { label: 'AI: Threat',      tone: 'critical' },
  needs_human:   { label: 'AI: Review',      tone: 'medium' },
  likely_safe:   { label: 'AI: Likely safe', tone: 'ok' },
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
    <div role="group" aria-label={label} className="al-pillgroup">
      <span className="al-label" aria-hidden="true">{label}</span>
      {options.map(o => (
        <button
          key={o.value}
          type="button"
          aria-pressed={selected === o.value}
          onClick={() => onChange(o.value)}
          className="al-pill"
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
  /** Critical alerts that just arrived (motion kit P3-4; empty without data-accent). */
  arrived?: ReadonlySet<string>;
}

function BrandGroupCard({
  group, selectedAlertId, currentUserId, onSelectAlert, canEdit, canTakedown,
  onAcknowledgeAll, onCreateTakedowns,
  bulk, bulkBusy, arrived,
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
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        className="al-group-head"
      >
        <img
          src={`https://www.google.com/s2/favicons?domain=${group.brand_domain ?? 'example.com'}&sz=32`}
          alt=""
          className="w-5 h-5 rounded-sm"
        />
        <div className="flex-1 text-left min-w-0">
          <div className="flex items-center gap-2">
            <span className="al-group-name">
              {group.brand_name ?? 'Unknown brand'}
            </span>
            <span className="al-chip al-num">{group.alerts.length} alerts</span>
          </div>
          <div className="al-mono">{group.brand_domain ?? ''}</div>
        </div>
        <svg
          aria-hidden="true"
          className="al-chevron"
          data-open={expanded}
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
              const hasHandle = HANDLE_RE.test(alert.title);
              const platform = extractPlatform(alert.title);
              const isSelected = selectedAlertId === alert.id;

              const sev = severityToBadge(alert.severity);
              return (
                <DataRow
                  key={alert.id}
                  severity={sev}
                  unread={alert.status === 'new'}
                  onClick={() => onSelectAlert(alert)}
                  className={cn('al-row flex items-center gap-3', isSelected && 'al-row--selected', arrived?.has(alert.id) && 'motion-arrive')}
                >
                  {/* Severity dot — uses the shared design-system
                      primitive so the dot colour
                      stays consistent (no looping ping: no ambient motion) across pages. R8 migration. */}
                  <SeverityDot severity={sev} size={8} />

                  {/* Handle + platform. The real <button> is the row's keyboard
                      control (standard: row click is a mouse convenience only). */}
                  <button
                    type="button"
                    id={`alert-row-${alert.id}`}
                    aria-expanded={isSelected}
                    aria-controls={`alert-detail-${alert.id}`}
                    onClick={e => { e.stopPropagation(); onSelectAlert(alert); }}
                    className="al-row-title ds-focusable text-left rounded-sm"
                  >
                    <span className="block">
                      <span className={hasHandle ? 'al-mono al-mono--strong' : 'al-title-prose'}>{handle}</span>
                      {' '}
                      <span className="al-label ml-1.5">· {platform}</span>
                    </span>
                    {alert.saas_technique_name && alert.saas_technique_phase_label && (
                      <span className="al-label mt-0.5 block">
                        {alert.saas_technique_name} · {alert.saas_technique_phase_label}
                      </span>
                    )}
                  </button>

                  {/* Badges + time. Fixed slots first (severity, status) so they
                      align across rows; optional chips follow and only shift
                      themselves. Wraps under the title on narrow containers. */}
                  <div className="al-row-meta">
                    <span className="al-slot al-slot--sev">
                      <Badge severity={sev} size="md" font="sans">{sentenceCase(alert.severity)}</Badge>
                    </span>

                    {/* Status — shared Badge primitive. (New stays on the
                        Badge "pending" tone: the kit has no primary status
                        tone, and a kit-wide change is out of scope here.) */}
                    <span className="al-slot al-slot--status">
                      <Badge
                        status={
                          alert.status === 'new'           ? 'pending'  :
                          alert.status === 'acknowledged'  ? 'warning'  :
                          alert.status === 'resolved'      ? 'success'  :
                                                             'inactive'
                        }
                        label={sentenceCase(alert.status === 'false_positive' ? 'dismissed' : alert.status)}
                        size="md"
                        font="sans"
                      />
                    </span>

                    {/* Score */}
                    {score !== null && (
                      <span className={cn('al-score', score >= 75 && 'al-score--hi')}>
                        {score}%
                      </span>
                    )}

                    {/* AI verdict badge — visible when Tier 3 judge has
                        stamped a verdict on this alert. */}
                    {(() => {
                      const v = parseAiAssessment(alert.ai_assessment);
                      if (!v) return null;
                      const s = AI_VERDICT_STYLE[v.verdict];
                      return (
                        <span
                          className="al-chip"
                          data-tone={s.tone}
                          title={`AI confidence ${v.confidence}%`}
                        >
                          {s.label}
                        </span>
                      );
                    })()}

                    {/* Owner — who has claimed this signal (W9). */}
                    {alert.staff_assigned_to && (
                      <span
                        className="al-chip"
                        data-tone="primary"
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
                          className="al-chip"
                          data-tone={breach ? 'critical' : 'medium'}
                          title={`${alert.severity} SLA ${SLA_MINUTES[severityToBadge(alert.severity)]}m`}
                        >
                          {breach ? `Overdue ${formatSpan(sla.overdueMs)}` : `Due ${formatSpan(sla.remainingMs)}`}
                        </span>
                      );
                    })()}

                    {/* Time */}
                    <span className="al-time">
                      {timeAgo(alert.created_at)}
                    </span>
                  </div>
                </DataRow>
              );
            })}
          </div>

          {/* Show more + actions */}
          <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 border-t border-[var(--border-base)]">
            <div className="flex items-center gap-2">
              {remaining > 0 && !showAll && (
                <button
                  type="button"
                  onClick={() => setShowAll(true)}
                  className="al-link al-link--accent"
                >
                  + {remaining} more
                </button>
              )}
              {showAll && remaining > 0 && (
                <button
                  type="button"
                  onClick={() => setShowAll(false)}
                  className="al-link"
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
                  className="al-readonly-note"
                >
                  Read-only
                </span>
              )}
              {canEdit && newCount > 0 && (
                <KitButton
                  variant="secondary"
                  size="sm"
                  onClick={onAcknowledgeAll}
                  disabled={bulkBusy}
                >
                  {bulk?.kind === 'ack' ? bulk.text : 'Acknowledge all'}
                </KitButton>
              )}
              {canEdit && canTakedown && (
              <KitButton
                size="sm"
                onClick={onCreateTakedowns}
                disabled={bulkBusy}
              >
                {bulk?.kind === 'takedown' ? bulk.text : 'Create takedowns'}
              </KitButton>
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
      className="outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--primary-focus)]"
      data-testid="alert-detail"
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Badge severity={severityToBadge(alert.severity)} size="md" font="sans">{sentenceCase(alert.severity)}</Badge>
          <span
            className="al-chip"
            data-tone={
              alert.status === 'new' ? 'high' :
              alert.status === 'acknowledged' ? 'medium' :
              alert.status === 'resolved' ? 'ok' :
              undefined
            }
          >
            {sentenceCase(alert.status === 'false_positive' ? 'dismissed' : alert.status)}
          </span>
          <Badge status="running" label={humanizeType(alert.alert_type)} size="md" font="sans" />
          {isAutoTriaged(alert.resolution_notes) && (
            <Badge status="inactive" label="Auto-triaged" size="md" font="sans" />
          )}
        </div>
        <KitButton variant="ghost" size="icon" aria-label="Close alert detail" onClick={onClose}>
          <X size={14} aria-hidden />
        </KitButton>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        {/* LEFT — Alert Details */}
        <div className="space-y-3">
          <h3 className="al-section">Alert details</h3>

          <Link
            to={`/brands/${alert.brand_id}`}
            className="al-brand-link flex items-center gap-2 group"
            title="Open brand"
          >
            <img
              src={`https://www.google.com/s2/favicons?domain=${alert.brand_domain ?? 'example.com'}&sz=32`}
              alt=""
              className="w-4 h-4 rounded-sm"
            />
            <span className="al-group-name">{alert.brand_name ?? 'Unknown'}</span>
            <span className="al-mono">{alert.brand_domain ?? ''}</span>
          </Link>

          {/* Outbound pivots — the detail used to be a dead-end (no links
              out). Brand detail + this brand's threat slice for context, and
              the exact source threat when this alert came from one. */}
          <div className="flex flex-col gap-1">
            {alert.source_type === 'threat' && alert.source_id && (
              <Link
                to={`/console?tab=threats&q=${encodeURIComponent(alert.source_id)}`}
                className="al-link"
              >
                View source threat →
              </Link>
            )}
            <Link
              to={`/console?tab=threats&brand_id=${encodeURIComponent(alert.brand_id)}`}
              className="al-link"
            >
              View brand's threats →
            </Link>
          </div>

          <div>
            <div className="al-label mb-0.5">Platform</div>
            <span className="al-chip">{platform}</span>
          </div>

          <div>
            <div className="al-label mb-0.5">Handle detected</div>
            <span className="al-mono al-mono--strong">{handle}</span>
          </div>

          {score !== null && (
            <div>
              <div className="al-label mb-1">Impersonation score</div>
              <div className="flex items-baseline gap-2">
                <span className={cn('al-score-big', score >= 75 && 'al-score-big--hi')}>
                  {score}%
                </span>
              </div>
            </div>
          )}

          <div>
            <div className="al-label mb-0.5">Detected</div>
            <span className="al-value al-num">{timeAgo(alert.created_at)}</span>
          </div>

          <div>
            <div className="al-label mb-0.5">Source</div>
            <span className="al-value">
              {alert.source_type ? humanizeType(alert.source_type) : 'Social Monitor Agent'}
            </span>
          </div>
        </div>

        {/* CENTER — Evidence & Assessment */}
        <div className="space-y-3 md:border-l md:border-[var(--border-base)] md:pl-5">
          <h3 className="al-section">Evidence & assessment</h3>

          <div>
            <div className="al-label mb-1">Summary</div>
            <p className="al-body">{alert.summary}</p>
          </div>

          {score !== null && (
            <div>
              <div className="al-label mb-1">Score</div>
              <div className="al-bar">
                <span data-level={score >= 75 ? 'hi' : score >= 50 ? 'mid' : 'lo'} style={{ width: `${score}%` }} />
              </div>
            </div>
          )}

          <div className="pt-2">
            <div className="al-label mb-1">AI assessment</div>
            {alert.ai_assessment ? (
              <div className="space-y-2">
                <p className="al-body">{alert.ai_assessment}</p>
                {alert.ai_recommendations && (
                  <div>
                    <div className="al-label mb-1">Recommendations</div>
                    <p className="al-body al-body--muted">{alert.ai_recommendations}</p>
                  </div>
                )}
              </div>
            ) : (
              <div className="al-body">No AI assessment yet</div>
            )}
          </div>
        </div>

        {/* RIGHT — Actions */}
        <div className="space-y-3 md:border-l md:border-[var(--border-base)] md:pl-5">
          <h3 className="al-section">Actions</h3>

          {!canEdit && (
            <p id={`alert-readonly-${alert.id}`} className="al-body">
              {READ_ONLY_COPY}
            </p>
          )}

          {/* Owner / assignment (W9). Staff owner only — the customer's own
              assignee is a separate, read-only field. */}
          <div className="pb-2 mb-1 border-b border-[var(--border-base)] space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="al-label">Averrow owner</div>
                <div className="al-value truncate" style={{ color: alert.staff_assigned_to ? 'var(--text-primary)' : 'var(--text-tertiary)' }}>
                  {alert.staff_assigned_to
                    ? (alert.staff_assigned_to === currentUserId ? 'You' : (alert.staff_assigned_to_name || alert.staff_assigned_to_email || 'Assigned'))
                    : 'Unassigned'}
                </div>
              </div>
              {!canEdit ? null : alert.staff_assigned_to === currentUserId ? (
                <KitButton variant="secondary" size="sm" className="shrink-0" onClick={() => onAssign(null)} disabled={isAssigning}>
                  Unassign
                </KitButton>
              ) : (
                <KitButton
                  variant="secondary"
                  size="sm"
                  className="shrink-0"
                  onClick={() => currentUserId && onAssign(currentUserId)}
                  disabled={isAssigning || !currentUserId}
                >
                  {alert.staff_assigned_to ? 'Take over' : 'Assign to me'}
                </KitButton>
              )}
            </div>
            {alert.assigned_to && (
              <div className="min-w-0">
                <div className="al-label">Customer assignee</div>
                <div className="al-value truncate">
                  {alert.assigned_to_name || alert.assigned_to_email || 'Assigned'}
                </div>
              </div>
            )}
          </div>

          <div className="flex flex-col gap-2">
            {canEdit && alert.status === 'new' && (
              <>
                <KitButton className="w-full" onClick={() => onUpdate('acknowledged')} disabled={isUpdating}>
                  Acknowledge
                </KitButton>
                <KitButton variant="secondary" className="w-full" onClick={() => onUpdate('false_positive')} disabled={isUpdating}>
                  Dismiss
                </KitButton>
              </>
            )}
            {canEdit && alert.status === 'acknowledged' && (
              <>
                <KitButton className="w-full" onClick={() => onUpdate('resolved')} disabled={isUpdating}>
                  Mark resolved
                </KitButton>
                <KitButton variant="secondary" className="w-full" onClick={() => onUpdate('new')} disabled={isUpdating}>
                  Re-open
                </KitButton>
              </>
            )}
            {canEdit && alert.status === 'resolved' && (
              <KitButton variant="secondary" className="w-full" onClick={() => onUpdate('new')} disabled={isUpdating}>
                Re-open
              </KitButton>
            )}
            {canEdit && alert.status === 'false_positive' && (
              <KitButton variant="secondary" className="w-full" onClick={() => onUpdate('new')} disabled={isUpdating}>
                Re-open
              </KitButton>
            )}
          </div>

          {/* Notes */}
          <div className="pt-2">
            <div className="al-label mb-1">Internal notes — not visible to customers</div>
            {!canEdit && !(alert.staff_notes ?? '') ? (
              <p className="al-body">No notes</p>
            ) : (
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="Add notes..."
              aria-label="Internal notes — not visible to customers"
              readOnly={!canEdit}
              aria-describedby={canEdit ? undefined : `alert-readonly-${alert.id}`}
              rows={3}
              className="al-textarea"
            />
            )}
            {canEdit && notes !== (alert.staff_notes ?? '') && (
              <KitButton
                size="sm"
                className="mt-1.5"
                onClick={() => onUpdate(alert.status, notes.trim() ? notes : null)}
                disabled={isUpdating}
              >
                Save notes
              </KitButton>
            )}
          </div>

          {/* Resolution / dismissal reason — now shown for dismissed
              (false_positive) alerts too, not just resolved. This is where
              the auto-triage reason ("auto: matches brand official handle")
              becomes visible, so an operator can see WHY an alert was
              auto-dismissed instead of it silently vanishing. */}
          {(alert.status === 'resolved' || alert.status === 'false_positive') && alert.resolution_notes && (
            <div className="pt-2">
              <div className="al-label mb-1">
                {alert.status === 'false_positive' ? 'Dismissal reason' : 'Resolution notes'}
                {isAutoTriaged(alert.resolution_notes) && (
                  <span className="ml-1.5">· auto-triaged</span>
                )}
              </div>
              <p className="al-body">{alert.resolution_notes}</p>
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

  // Queue banner inputs: platform-wide server counts when present, else a
  // fallback computed over the loaded (<=200) alerts.
  const queueBanner = useMemo(() => {
    const unreviewed = stats?.new_count ?? 0;
    if (typeof stats?.sla_breached === 'number') {
      return {
        unreviewed,
        breached: stats.sla_breached,
        breachedCritical: stats.sla_breached_critical ?? 0,
        atRisk: stats.sla_at_risk ?? 0,
        oldestBreachMs: (stats.sla_oldest_breach_minutes ?? 0) * 60_000,
        sampled: false,
      };
    }
    let breached = 0, breachedCritical = 0, atRisk = 0, oldestBreachMs = 0;
    for (const a of rawAlerts) {
      const sla = slaFor(a);
      if (sla.state === 'breach') {
        breached++;
        if (severityToBadge(a.severity) === 'critical') breachedCritical++;
        oldestBreachMs = Math.max(oldestBreachMs, sla.overdueMs);
      } else if (sla.state === 'warn') atRisk++;
    }
    return { unreviewed, breached, breachedCritical, atRisk, oldestBreachMs, sampled: true, sampledCount: rawAlerts.length };
  }, [stats, rawAlerts]);

  const groups = useMemo(() => groupByBrand(alerts), [alerts]);
  // Motion kit (P3-4): flag critical rows that arrive on a refetch (never on
  // the first load, a filter change or a placeholder swap) for the one-shot
  // scan-line slide-in. The reset key re-baselines on each of those.
  const criticalById = useMemo(
    () => new Map(alerts.filter(a => severityToBadge(a.severity) === 'critical').map(a => [a.id, a] as const)),
    [alerts],
  );
  const criticalIds = useMemo(() => [...criticalById.keys()], [criticalById]);
  // Only alerts CREATED since the last update count: an old alert that newly
  // qualifies for the SLA filter or slides in under the list cap is not new.
  const arrivedCritical = useArrivalFlash(
    criticalIds,
    JSON.stringify([filters, search, aiVerdictFilter, slaFilter, mineOnly, alertsPlaceholder, alertsData === undefined]),
    {
      timeOf: (id) => {
        const created = criticalById.get(id)?.created_at;
        const ms = created ? parseUtc(created).getTime() : NaN;
        return Number.isFinite(ms) ? ms : null;
      },
    },
  );

  // Error beats loading beats empty. A failed refetch that still has this
  // filter's data on screen keeps it and shows an inline error instead; a
  // keepPreviousData placeholder is the PREVIOUS filter's rows, so it does
  // not count as data here.
  // null = still loading / failed (StatTile shows "—" or "Couldn't load");
  // never a misleading 0 for a stat that has not arrived.
  const statValue = (n: number | undefined): number | null =>
    stats ? (n ?? 0) : (statsLoading || statsError ? null : 0);

  const autoDismissed = stats?.auto_dismissed ?? 0;
  const autoTriagePct = stats?.total ? Math.round((autoDismissed / stats.total) * 100) : 0;

  const newToday = stats?.daily_new_7d?.length ? stats.daily_new_7d[stats.daily_new_7d.length - 1] : undefined;

  const listFailed = alertsError && (!alertsData || alertsPlaceholder);
  // Banner counts are platform-wide but the list only holds the loaded page:
  // say so when an SLA filter hides part of what the banner counted.
  const slaListNote = (() => {
    if (slaFilter === 'all' || queueBanner.sampled) return null;
    if (search || aiVerdictFilter !== 'all' || mineOnly || filters.severity || filters.status || filters.alert_type) return null;
    const total = slaFilter === 'breached' ? queueBanner.breached : queueBanner.breached + queueBanner.atRisk;
    if (alerts.length >= total) return null;
    const word = slaFilter === 'breached' ? 'breached' : 'approaching';
    return `Showing ${alerts.length.toLocaleString()} of ${total.toLocaleString()} ${word} alerts — the oldest may not be loaded. Narrow by severity or brand to see more.`;
  })();

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
    <div className="alerts-v4 space-y-5">
      <div ref={listHeadingRef} tabIndex={-1} className="outline-none">
        <PageHeader title="Alerts" subtitle="Brand alerts across all monitored brands — SOC triage view" />
      </div>
      <div role="status" aria-live="polite" className="sr-only">{announcement}</div>

      <StatGrid cols={4}>
        {stats && stats.open_critical === undefined ? (
          // Pre-deploy worker: no open-critical figure yet. `stats.critical` is
          // all-time, so it must not stand in for "Critical open".
          <StatTile
            label="Total alerts"
            value={statValue(stats.total)}
            accent="var(--red)"
          />
        ) : (
          <StatTile
            label="Critical open"
            value={statValue(stats?.open_critical)}
            error={statsError && !stats}
            accent="var(--red)"
          />
        )}
        <StatTile
          label="Open queue"
          value={statValue(stats ? (stats.open_total ?? (stats.new_count ?? 0) + (stats.acknowledged ?? 0)) : undefined)}
          error={statsError && !stats}
          accent="var(--sev-high)"
          trend={stats?.daily_new_7d}
          sub={newToday !== undefined ? `${newToday.toLocaleString()} new today · 7-day intake` : undefined}
        />
        <StatTile
          label="Auto-triaged"
          value={stats ? `${autoTriagePct}%` : statValue(undefined)}
          error={statsError && !stats}
          accent="var(--green)"
          sub={stats ? `${autoDismissed.toLocaleString()} of ${(stats.total ?? 0).toLocaleString()} closed automatically` : undefined}
        />
        <StatTile
          label="Resolved"
          value={statValue(stats?.resolved)}
          error={statsError && !stats}
          accent="var(--blue)"
        />
      </StatGrid>

      {stats && (
        <AlertQueueBanner
          {...queueBanner}
          onShowBreached={() => setSlaFilter('breached')}
          onShowApproaching={() => setSlaFilter('atrisk')}
          onShowCritical={() => { setFilter('severity', 'critical'); setSlaFilter('breached'); }}
          onAnnounce={setAnnouncement}
        />
      )}

      {!canEdit && (
        <div id={READ_ONLY_NOTE_ID} className="al-readonly-note" role="note">{READ_ONLY_COPY}</div>
      )}

      {/* Saved views (W6) — presets + user-pinned filter sets */}
      <div role="group" aria-label="Saved views" className="al-pillgroup">
        <span className="al-label inline-flex items-center gap-1">
          <Star size={12} aria-hidden="true" /> Views
        </span>
        {allViews.map(v => {
          const active = sameView(currentView, v.filters);
          const isPreset = v.id.startsWith('preset:');
          return (
            <span key={v.id} className="al-pill-wrap" data-removable={!isPreset} data-active={active}>
              <button
                type="button"
                aria-pressed={active}
                onClick={() => applyView(v.filters)}
                className="al-pill"
              >
                {v.name}
              </button>
              {!isPreset && (
                <button
                  type="button"
                  onClick={() => removeView(v.id)}
                  className="al-pill-x"
                  title="Delete view"
                  aria-label={`Delete view ${v.name}`}
                >
                  <X size={12} aria-hidden="true" />
                </button>
              )}
            </span>
          );
        })}
        <button
          type="button"
          onClick={onSaveView}
          disabled={viewIsEmpty(currentView)}
          className="al-pill al-pill--dashed"
          title={viewIsEmpty(currentView) ? 'Apply some filters first' : 'Save current filters as a view'}
        >
          + Save current
        </button>
      </div>

      <FilterBar
        size="md"
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
              { value: 'app_store_impersonation', label: 'App store' },
              { value: 'phishing_detected', label: 'Phishing' },
              { value: 'lookalike_domain_active', label: 'Lookalike' },
              { value: 'bimi_removed', label: 'BIMI removed' },
              { value: 'dmarc_downgraded', label: 'DMARC downgraded' },
              { value: 'vmc_expiring', label: 'VMC expiring' },
              { value: 'typosquat_bimi', label: 'BIMI spoofing' },
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
            label="AI verdict"
            options={[
              { value: 'all',           label: 'All' },
              { value: 'active_threat', label: 'AI: Threat' },
              { value: 'needs_human',   label: 'AI: Review' },
              { value: 'likely_safe',   label: 'AI: Likely safe' },
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
            type="button"
            onClick={() => setMineOnly(m => !m)}
            disabled={!currentUserId}
            aria-pressed={mineOnly}
            className="al-pill"
            title="Show only signals assigned to me"
          >
            Mine
          </button>
        </div>
      </FilterBar>

      {alertsError && !listFailed && (
        <PageState kind="error" layout="inline" title="Couldn't refresh alerts" description="Showing the last loaded list." onRetry={() => { void refetchAlerts(); }} />
      )}

      {slaListNote && (
        <p className="al-readonly-note" style={{ margin: 0 }}>{slaListNote}</p>
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
                arrived={arrivedCritical}
              />

              {/* Detail panel - rendered below the group */}
              {selectedAlert && group.alerts.some(a => a.id === selectedAlert.id) && detail}
            </div>
          ))}
        </div>
      )}

      {/* Total count */}
      {!alertsLoading && alertsData && (
        <div className="al-footer-count">
          Showing {alerts.length} of {alertsData.total} alerts
        </div>
      )}
    </div>
  );
}
