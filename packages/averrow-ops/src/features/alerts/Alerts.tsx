import { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { cn } from '@/lib/cn';
import { StatCard, Card, StatGrid, FilterBar, PageHeader, DataRow } from '@/components/ui';
import { SeverityDot } from '@/components/ui/DataRow';
import { Badge } from '@/components/ui/Badge';
import type { Severity } from '@/components/ui/Badge';
import {
  useAlerts, useAlertStats, useUpdateAlert, useBulkAcknowledge, useBulkTakedown,
  type Alert, type AlertFilters,
} from '@/hooks/useAlerts';
import { Bell } from 'lucide-react';
import { EmptyState } from '@/components/ui/EmptyState';

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
  onSelectAlert: (a: Alert) => void;
  onAcknowledgeAll: () => void;
  onCreateTakedowns: () => void;
  isAcknowledging: boolean;
  isCreatingTakedowns: boolean;
}

function BrandGroupCard({
  group, selectedAlertId, onSelectAlert,
  onAcknowledgeAll, onCreateTakedowns,
  isAcknowledging, isCreatingTakedowns,
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
          <div className="font-mono text-[10px] text-white/40">{group.brand_domain ?? ''}</div>
        </div>
        <svg
          className={cn('w-4 h-4 text-white/50 transition-transform', expanded && 'rotate-180')}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {expanded && (
        <>
          {/* Alert rows */}
          <div className="border-t border-white/[0.06]">
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
                  className={cn('flex items-center gap-3', isSelected && 'bg-afterburner-muted')}
                >
                  {/* Severity dot — uses the shared design-system
                      primitive so the dot color + pulse semantics
                      stay consistent across pages. R8 migration. */}
                  <SeverityDot
                    severity={sev}
                    size={8}
                    pulse={alert.severity === 'critical' || alert.severity === 'high'}
                  />

                  {/* Handle + platform */}
                  <div className="flex-1 min-w-0">
                    <div>
                      <span className="font-mono text-[11px] font-semibold" style={{ color: 'var(--text-primary)' }}>{handle}</span>
                      <span className="font-mono text-[10px] ml-1.5" style={{ color: 'var(--text-tertiary)' }}>on</span>
                      <span
                        className="ml-1.5 inline-flex items-center font-mono text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded"
                        style={platformBadgeStyle(platform)}
                      >
                        {platform}
                      </span>
                    </div>
                    {alert.saas_technique_name && alert.saas_technique_phase_label && (
                      <div
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
                      </div>
                    )}
                  </div>

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
                  <span className="font-mono text-[10px] text-white/50 tabular-nums w-14 text-right flex-shrink-0">
                    {timeAgo(alert.created_at)}
                  </span>
                </DataRow>
              );
            })}
          </div>

          {/* Show more + actions */}
          <div className="flex items-center justify-between px-4 py-2.5 border-t border-white/[0.06]">
            <div className="flex items-center gap-2">
              {remaining > 0 && !showAll && (
                <button
                  onClick={() => setShowAll(true)}
                  className="font-mono text-[10px] font-semibold hover:text-[#D49A28] transition-colors" style={{ color: 'var(--amber)' }}
                >
                  + {remaining} more
                </button>
              )}
              {showAll && remaining > 0 && (
                <button
                  onClick={() => setShowAll(false)}
                  className="font-mono text-[10px] font-semibold text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
                >
                  Show less
                </button>
              )}
            </div>
            <div className="flex items-center gap-2">
              {newCount > 0 && (
                <button
                  onClick={onAcknowledgeAll}
                  disabled={isAcknowledging}
                  className="font-mono text-[10px] font-semibold uppercase tracking-wide px-3 py-1.5 rounded-md border border-afterburner-border text-[#E5A832] hover:bg-afterburner-muted transition-all disabled:opacity-50"
                >
                  {isAcknowledging ? 'Acknowledging...' : 'Acknowledge All'}
                </button>
              )}
              <button
                onClick={onCreateTakedowns}
                disabled={isCreatingTakedowns}
                className="font-mono text-[10px] font-semibold uppercase tracking-wide px-3 py-1.5 rounded-md bg-accent hover:bg-accent/80 transition-all disabled:opacity-50" style={{ color: 'var(--text-primary)' }}
              >
                {isCreatingTakedowns ? 'Creating...' : 'Create Takedowns'}
              </button>
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
  onClose: () => void;
  onUpdate: (status: string, notes?: string) => void;
  isUpdating: boolean;
}

function AlertDetail({ alert, onClose, onUpdate, isUpdating }: AlertDetailProps) {
  const [notes, setNotes] = useState(alert.resolution_notes ?? '');
  const score = extractScore(alert.summary);
  const handle = extractHandle(alert.title);
  const platform = extractPlatform(alert.title);

  return (
    <Card variant="active" style={{ padding: '20px', marginTop: 4 }}>
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
        <button onClick={onClose} className="text-white/50 hover:text-[var(--text-primary)] transition-colors p-1">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
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
            <span className="font-mono text-[10px] text-white/40">{alert.brand_domain ?? ''}</span>
          </Link>

          {/* Outbound pivots — the detail used to be a dead-end (no links
              out). Brand detail + this brand's threat slice for context. */}
          <Link
            to={`/threats?brand_id=${encodeURIComponent(alert.brand_id)}`}
            className="inline-flex items-center gap-1 font-mono text-[10px] text-[var(--text-tertiary)] hover:text-[var(--amber)] transition-colors"
          >
            View brand's threats →
          </Link>

          <div>
            <div className="font-mono text-[9px] text-white/40 uppercase tracking-wide mb-0.5">Platform</div>
            <span
              className="inline-flex items-center font-mono text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded"
              style={platformBadgeStyle(platform)}
            >
              {platform}
            </span>
          </div>

          <div>
            <div className="font-mono text-[9px] text-white/40 uppercase tracking-wide mb-0.5">Handle Detected</div>
            <span className="font-mono text-[13px] font-bold" style={{ color: 'var(--text-primary)' }}>{handle}</span>
          </div>

          {score !== null && (
            <div>
              <div className="font-mono text-[9px] text-white/40 uppercase tracking-wide mb-1">Impersonation Score</div>
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
            <div className="font-mono text-[9px] text-white/40 uppercase tracking-wide mb-0.5">Detected</div>
            <span className="font-mono text-[11px] text-[var(--text-secondary)]">{timeAgo(alert.created_at)}</span>
          </div>

          <div>
            <div className="font-mono text-[9px] text-white/40 uppercase tracking-wide mb-0.5">Source</div>
            <span className="font-mono text-[11px] text-[var(--text-tertiary)]">
              {alert.source_type ? humanizeType(alert.source_type) : 'Social Monitor Agent'}
            </span>
          </div>
        </div>

        {/* CENTER — Evidence & Assessment */}
        <div className="space-y-3 border-l border-white/[0.06] pl-5">
          <div className="font-mono text-[9px] uppercase tracking-widest text-[var(--text-muted)] mb-2">Evidence & Assessment</div>

          <div>
            <div className="font-mono text-[9px] text-white/40 uppercase tracking-wide mb-1">Summary</div>
            <p className="text-[12px] text-[var(--text-secondary)] leading-relaxed">{alert.summary}</p>
          </div>

          {score !== null && (
            <div>
              <div className="font-mono text-[9px] text-white/40 uppercase tracking-wide mb-1">Score</div>
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
            <div className="font-mono text-[9px] text-white/40 uppercase tracking-wide mb-1">AI Assessment</div>
            {alert.ai_assessment ? (
              <div className="space-y-2">
                <p className="text-[12px] text-[var(--text-secondary)] leading-relaxed">{alert.ai_assessment}</p>
                {alert.ai_recommendations && (
                  <div>
                    <div className="font-mono text-[9px] text-white/40 uppercase tracking-wide mb-1">Recommendations</div>
                    <p className="text-[12px] text-[var(--text-tertiary)] leading-relaxed">{alert.ai_recommendations}</p>
                  </div>
                )}
              </div>
            ) : (
              <div className="text-[11px] text-white/50 italic">No AI assessment yet</div>
            )}
          </div>
        </div>

        {/* RIGHT — Actions */}
        <div className="space-y-3 border-l border-white/[0.06] pl-5">
          <div className="font-mono text-[9px] uppercase tracking-widest text-[var(--text-muted)] mb-2">Actions</div>

          <div className="flex flex-col gap-2">
            {alert.status === 'new' && (
              <>
                <button
                  onClick={() => onUpdate('acknowledged')}
                  disabled={isUpdating}
                  className="w-full font-mono text-[10px] font-semibold uppercase tracking-wide px-3 py-2 rounded-md border border-afterburner-border text-[#E5A832] hover:bg-afterburner-muted transition-all disabled:opacity-50"
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
            {alert.status === 'acknowledged' && (
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
            {alert.status === 'resolved' && (
              <button
                onClick={() => onUpdate('new')}
                disabled={isUpdating}
                className="w-full font-mono text-[10px] font-semibold uppercase tracking-wide px-3 py-2 rounded-md border border-white/10 text-[var(--text-tertiary)] hover:bg-white/[0.04] transition-all disabled:opacity-50"
              >
                Re-open
              </button>
            )}
            {alert.status === 'false_positive' && (
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
            <div className="font-mono text-[9px] text-white/40 uppercase tracking-wide mb-1">Notes</div>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="Add notes..."
              rows={3}
              className="w-full rounded-md bg-white/[0.04] border border-white/[0.08] px-3 py-2 text-[11px] placeholder:text-white/30 focus:outline-none focus:border-afterburner-border resize-none font-mono" style={{ color: 'var(--text-primary)' }}
            />
            {notes !== (alert.resolution_notes ?? '') && (
              <button
                onClick={() => onUpdate(alert.status, notes)}
                disabled={isUpdating}
                className="mt-1.5 font-mono text-[10px] font-semibold uppercase tracking-wide px-3 py-1.5 rounded-md bg-afterburner-muted text-[#E5A832] border border-afterburner-border hover:bg-afterburner-muted transition-all disabled:opacity-50"
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
              <div className="font-mono text-[9px] text-white/40 uppercase tracking-wide mb-1">
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
  const [filters, setFilters] = useState<AlertFilters>({ limit: 200 });
  const [selectedAlert, setSelectedAlert] = useState<Alert | null>(null);
  const [search, setSearch] = useState('');
  // AI verdict filter is client-side: ai_assessment isn't an indexed
  // column on alerts, and the API doesn't accept a verdict param yet.
  // Operating on the (limited) returned set is the right scope for
  // now — operator usually filters by status+severity first which
  // already narrows hard.
  const [aiVerdictFilter, setAiVerdictFilter] = useState<'all' | AiVerdict | 'unjudged'>('all');
  const [slaFilter, setSlaFilter] = useState<'all' | 'atrisk' | 'breached'>('all');

  const { data: statsData, isLoading: statsLoading } = useAlertStats();
  const { data: alertsData, isLoading: alertsLoading } = useAlerts({
    ...filters,
    search: search || undefined,
  });

  const updateAlert = useUpdateAlert();
  const bulkAck = useBulkAcknowledge();
  const bulkTakedown = useBulkTakedown();

  const rawAlerts = Array.isArray(alertsData?.alerts) ? alertsData.alerts : [];
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
    return true;
  });
  const stats = statsData && typeof statsData.total === 'number' ? statsData : undefined;

  // SLA breach/at-risk counts over the fetched queue (open alerts only).
  const slaBreached = rawAlerts.filter(a => slaFor(a).state === 'breach').length;
  const slaAtRisk = rawAlerts.filter(a => slaFor(a).state === 'warn').length;

  const groups = useMemo(() => groupByBrand(alerts), [alerts]);

  const setFilter = (key: keyof AlertFilters, value: string) => {
    setFilters(prev => ({ ...prev, [key]: value === 'all' ? undefined : value }));
    setSelectedAlert(null);
  };

  return (
    <div className="space-y-5">
      <PageHeader title="Signals" subtitle="Brand signals across all monitored brands — SOC triage view" />

      <StatGrid cols={4}>
        <StatCard
          label="Total Signals"
          value={statsLoading ? '...' : (stats?.total ?? 0)}
          accentColor="var(--red)"
        />
        <StatCard
          label="New / Unacknowledged"
          value={statsLoading ? '...' : (stats?.new_count ?? 0)}
          accentColor="var(--sev-high)"
        />
        <StatCard
          label="Acknowledged"
          value={statsLoading ? '...' : (stats?.acknowledged ?? 0)}
          accentColor="var(--amber)"
        />
        <StatCard
          label="Resolved"
          value={statsLoading ? '...' : (stats?.resolved ?? 0)}
          accentColor="var(--green)"
        />
      </StatGrid>

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
        </div>
      </FilterBar>

      {/* Loading */}
      {alertsLoading && (
        <div className="flex items-center justify-center py-12">
          <div className="w-6 h-6 border-2 border-afterburner-border border-t-afterburner rounded-full animate-spin" />
        </div>
      )}

      {/* Grouped alert list */}
      {!alertsLoading && (
        <div className="space-y-3">
          {groups.length === 0 && (
            <EmptyState
              icon={<Bell />}
              title="No alerts match your filters"
              subtitle="All alerts have been acknowledged. You're up to date."
              variant="success"
            />
          )}

          {groups.map(group => (
            <div key={group.brand_id}>
              <BrandGroupCard
                group={group}
                selectedAlertId={selectedAlert?.id ?? null}
                onSelectAlert={a => setSelectedAlert(prev => prev?.id === a.id ? null : a)}
                onAcknowledgeAll={() => {
                  // Acknowledge only the alerts visible in this group
                  // (post-filter). Sending alert_ids[] respects the
                  // active AI verdict + status filters; sending
                  // brand_id alone would ignore them and ack
                  // every 'new' alert for the brand. Operators
                  // expect filter-aware bulk actions.
                  const ids = group.alerts
                    .filter(a => a.status === 'new')
                    .map(a => a.id);
                  if (ids.length > 0) bulkAck.mutate({ alert_ids: ids });
                }}
                onCreateTakedowns={() => bulkTakedown.mutate({ brand_id: group.brand_id })}
                isAcknowledging={bulkAck.isPending}
                isCreatingTakedowns={bulkTakedown.isPending}
              />

              {/* Detail panel - rendered below the group */}
              {selectedAlert && group.alerts.some(a => a.id === selectedAlert.id) && (
                <AlertDetail
                  alert={selectedAlert}
                  onClose={() => setSelectedAlert(null)}
                  onUpdate={(status, notes) => {
                    updateAlert.mutate(
                      { id: selectedAlert.id, status, notes },
                      { onSuccess: () => setSelectedAlert(null) },
                    );
                  }}
                  isUpdating={updateAlert.isPending}
                />
              )}
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
