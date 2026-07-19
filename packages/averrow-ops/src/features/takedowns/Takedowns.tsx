import React, { useState, useMemo, useCallback } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAdminTakedowns, useAdminTakedownsAll, useUpdateTakedown } from '@/hooks/useTakedowns';
import type { Takedown, TakedownScope } from '@/hooks/useTakedowns';
import { useToast } from '@/components/ui/Toast';
import { relativeTime } from '@/lib/time';
import { Shield, ShieldAlert } from 'lucide-react';
import { EmptyState } from '@/components/ui/EmptyState';
import {
  Card,
  StatCard,
  StatGrid,
  FilterBar,
  PageHeader,
  Badge,
  Button,
  PriorityBar,
  Tabs,
} from '@/design-system/components';
import type { BadgeStatus, Severity } from '@/design-system/components';
import { ReportPanel } from '@/components/ui/ReportPanel';

// ─── Status mapping (DB → display) ────────────────────────────

const STATUS_DISPLAY: Record<string, string> = {
  draft: 'DRAFT',
  requested: 'PENDING',
  submitted: 'SUBMITTED',
  pending_response: 'AWAITING',
  taken_down: 'RESOLVED',
  failed: 'FAILED',
  expired: 'EXPIRED',
  withdrawn: 'DISMISSED',
};

const STATUS_TO_BADGE: Record<string, BadgeStatus> = {
  draft: 'draft',
  requested: 'pending',
  submitted: 'running',
  pending_response: 'warning',
  taken_down: 'success',
  failed: 'failed',
  expired: 'inactive',
  withdrawn: 'inactive',
};

// Identity mapping — takedown_requests.severity is already the canonical
// CRITICAL/HIGH/MEDIUM/LOW ladder (DEFAULT 'MEDIUM', see migration 0039),
// so this just upper-cases into the Badge severity vocabulary. (D1 fix:
// this previously shifted a tier — HIGH rendered as 'critical' and MEDIUM
// as 'high', making the medium badge unreachable. Local to this file only,
// nothing else consumes this map.)
const SEVERITY_TO_BADGE: Record<string, Severity> = {
  CRITICAL: 'critical',
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
};

// ─── Filter pill definitions ───────────────────────────────────

const STATUS_PILLS = [
  { key: 'all', label: 'ALL' },
  { key: 'draft', label: 'DRAFT' },
  { key: 'requested', label: 'PENDING' },
  { key: 'submitted', label: 'SUBMITTED' },
  { key: 'taken_down', label: 'RESOLVED' },
  { key: 'withdrawn', label: 'DISMISSED' },
] as const;

const TYPE_PILLS = [
  { key: 'all', label: 'ALL' },
  { key: 'social_profile', label: 'SOCIAL' },
  { key: 'url', label: 'URL' },
  { key: 'domain', label: 'DOMAIN' },
] as const;

const SORT_OPTIONS = [
  { key: 'priority', label: 'Priority Score' },
  { key: 'newest', label: 'Newest' },
  { key: 'brand', label: 'Brand' },
] as const;

// ─── Scope toggle (S2.3 T2) ─────────────────────────────────────
// Authorized  = org_id NOT NULL — opted-in customer takedowns, the SOC
//               execution queue. This is intentionally NARROWER than the
//               old unscoped view: orgless drafts move to Prospect.
// Prospect    = org_id IS NULL  — orgless Sparrow drafts, grouped by brand
//               as a sales-facing "everything we'd action for you" summary.

// Only the two UI-reachable scopes get a tab. `all` is a real backend
// capability but isn't wired to this toggle — resolveScope() below maps
// any URL value outside {authorized, prospect} back to `authorized` so
// `?scope=all` (or a typo) can never leave the toggle in a tabless state.
const SCOPE_TABS: { id: TakedownScope; label: string }[] = [
  { id: 'authorized', label: 'Authorized' },
  { id: 'prospect', label: 'Prospect' },
];

function resolveScope(v: string | null): TakedownScope {
  return v === 'prospect' ? 'prospect' : 'authorized';
}

// ─── Type + platform + workflow identity ──────────────────────

interface TypeConf  { icon: string; color: string; label: string }
interface PlatConf  { icon: string; label: string }
interface StatusConf {
  color: string;
  label: string;
  cta:   string; // primary action label
  next:  string; // db status the CTA transitions to
}

const TYPE_CONFIG: Record<string, TypeConf> = {
  URL:    { icon: '🔗', color: 'var(--blue)',       label: 'URL'    },
  SOCIAL: { icon: '👤', color: 'var(--sev-high)',   label: 'Social' },
  DOMAIN: { icon: '🌐', color: 'var(--amber)',      label: 'Domain' },
  EMAIL:  { icon: '📧', color: 'var(--sev-medium)', label: 'Email'  },
};

function resolveTypeConf(targetType: string | null | undefined): TypeConf {
  const t = (targetType ?? '').toLowerCase();
  if (t.includes('social')) return TYPE_CONFIG.SOCIAL;
  if (t.includes('domain')) return TYPE_CONFIG.DOMAIN;
  if (t.includes('email'))  return TYPE_CONFIG.EMAIL;
  return TYPE_CONFIG.URL;
}

const PLATFORM_CONFIG: Record<string, PlatConf> = {
  tiktok:    { icon: '🎵', label: 'TikTok'      },
  instagram: { icon: '📸', label: 'Instagram'   },
  twitter:   { icon: '𝕏',  label: 'X / Twitter' },
  x:         { icon: '𝕏',  label: 'X / Twitter' },
  youtube:   { icon: '▶',  label: 'YouTube'     },
  github:    { icon: '⚙',  label: 'GitHub'      },
  facebook:  { icon: 'f',  label: 'Facebook'    },
  linkedin:  { icon: 'in', label: 'LinkedIn'    },
};

// Workflow config keyed on the DB status values.
// Draft → Pending → Submitted → Resolved
const STATUS_CONFIG: Record<string, StatusConf> = {
  draft:            { color: 'var(--amber)',      label: 'Draft',     cta: 'Submit →',         next: 'requested'  },
  requested:        { color: 'var(--sev-high)',   label: 'Pending',   cta: 'Mark Sent →',      next: 'submitted'  },
  submitted:        { color: 'var(--blue)',       label: 'Submitted', cta: 'Mark Resolved →',  next: 'taken_down' },
  pending_response: { color: 'var(--blue)',       label: 'Awaiting',  cta: 'Mark Resolved →',  next: 'taken_down' },
  taken_down:       { color: 'var(--sev-info)',   label: 'Resolved',  cta: '',                 next: ''           },
  withdrawn:        { color: 'var(--text-muted)', label: 'Dismissed', cta: '',                 next: ''           },
  failed:           { color: 'var(--text-muted)', label: 'Failed',    cta: '',                 next: ''           },
  expired:          { color: 'var(--text-muted)', label: 'Expired',   cta: '',                 next: ''           },
};

// ─── Takedown card ─────────────────────────────────────────────

function TakedownCard({
  takedown,
  onReview,
  onStatusChange,
  onDismiss,
}: {
  takedown: Takedown;
  onReview:       (t: Takedown) => void;
  onStatusChange: (id: string, status: string) => void;
  onDismiss:      (id: string) => void;
}) {
  const typeConf   = resolveTypeConf(takedown.target_type);
  const platConf   = takedown.target_platform
    ? PLATFORM_CONFIG[takedown.target_platform.toLowerCase()]
    : undefined;
  const statusConf = STATUS_CONFIG[takedown.status] ?? STATUS_CONFIG.draft;
  const priority   = takedown.priority_score ?? 0;
  const isHigh     = priority >= 70;
  const isTerminal = takedown.status === 'taken_down' || takedown.status === 'withdrawn';

  return (
    <Card
      variant={isHigh && !isTerminal ? 'active' : 'base'}
      accent={isHigh ? 'var(--red)' : typeConf.color}
      style={{ padding: 0, overflow: 'hidden' }}
    >
      {/* Card header: type badge + platform + status */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 14px',
        borderBottom: '1px solid var(--border-base)',
        background: `${typeConf.color}08`,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          {/* Type badge */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 5,
            padding: '3px 8px', borderRadius: 6,
            background: `${typeConf.color}15`,
            border: `1px solid ${typeConf.color}35`,
            flexShrink: 0,
          }}>
            <span style={{ fontSize: 12 }}>{typeConf.icon}</span>
            <span style={{
              fontSize: 9, fontFamily: 'var(--font-mono)',
              fontWeight: 800, letterSpacing: '0.12em',
              color: typeConf.color, textTransform: 'uppercase',
            }}>
              {typeConf.label}
            </span>
          </div>

          {/* Platform */}
          {platConf && (
            <span style={{
              fontSize: 10, color: 'var(--text-muted)',
              fontFamily: 'var(--font-mono)',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}>
              {platConf.icon} {platConf.label}
            </span>
          )}
        </div>

        {/* Status */}
        <div style={{
          fontSize: 9, fontFamily: 'var(--font-mono)', fontWeight: 800,
          letterSpacing: '0.14em', textTransform: 'uppercase',
          color: statusConf.color,
          padding: '2px 8px', borderRadius: 4,
          background: `${statusConf.color}12`,
          border: `1px solid ${statusConf.color}30`,
          flexShrink: 0,
        }}>
          {statusConf.label}
        </div>
      </div>

      {/* Card body: brand + target + description + priority */}
      <div style={{ padding: '12px 14px' }}>
        {/* Brand name — pivots to the brand (GM4) */}
        {takedown.brand_name && (
          <div style={{
            fontSize: 10, fontFamily: 'var(--font-mono)',
            color: 'var(--text-muted)', marginBottom: 4,
            letterSpacing: '0.10em', textTransform: 'uppercase',
          }}>
            <Link
              to={`/brands/${takedown.brand_id}`}
              onClick={(e) => e.stopPropagation()}
              style={{ color: 'var(--text-muted)' }}
              className="hover:text-[var(--amber)] transition-colors"
            >
              {takedown.brand_name} ↗
            </Link>
          </div>
        )}

        {/* Target */}
        <div style={{
          fontSize: 13, fontWeight: 700, color: 'var(--text-primary)',
          fontFamily: 'var(--font-mono)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          marginBottom: 6,
        }}>
          {takedown.target_value}
        </div>

        {/* Evidence summary */}
        {takedown.evidence_summary && (
          <p style={{
            fontSize: 11, color: 'var(--text-secondary)',
            lineHeight: 1.55, margin: '0 0 10px',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          } as React.CSSProperties}>
            {takedown.evidence_summary}
          </p>
        )}

        {/* Priority bar + meta — uses the shared PriorityBar primitive
            (Bundle C session 1). Preserves the original "high above 70,
            amber otherwise" two-color rule via explicit `color`
            override so this row's threshold stays consistent across
            takedowns; auto-derived 4-color (green/amber/orange/red)
            isn't quite right for takedowns where low-priority items
            still warrant attention. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ flex: 1, minWidth: 0, fontFamily: 'var(--font-mono)' }}>
            <div style={{
              fontSize: 8, color: 'var(--text-muted)',
              letterSpacing: '0.12em', marginBottom: 4,
            }}>
              PRIORITY {priority}/100
            </div>
            <PriorityBar
              value={priority}
              max={100}
              size="sm"
              color={isHigh ? 'red' : 'amber'}
            />
          </div>
          <div style={{
            fontSize: 9, fontFamily: 'var(--font-mono)',
            color: 'var(--text-muted)', flexShrink: 0, textAlign: 'right',
            lineHeight: 1.4,
          }}>
            <div>{takedown.provider_method ?? 'email'}</div>
            {takedown.evidence_count != null && (
              <div>{takedown.evidence_count} evidence</div>
            )}
            <div>{relativeTime(takedown.created_at)}</div>
          </div>
        </div>
      </div>

      {/* Action row */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '10px 14px',
        borderTop: '1px solid var(--border-base)',
        background: 'rgba(0,0,0,0.20)',
      }}>
        {/* Primary CTA — advances workflow */}
        {statusConf.cta && (
          <Button
            variant="primary"
            size="sm"
            onClick={() => onStatusChange(takedown.id, statusConf.next)}
          >
            {statusConf.cta}
          </Button>
        )}

        {/* View detail */}
        <Button
          variant="secondary"
          size="sm"
          onClick={() => onReview(takedown)}
        >
          View Detail
        </Button>

        {/* Spacer */}
        <div style={{ flex: 1 }} />

        {/* Dismiss — only for non-resolved, non-dismissed */}
        {!isTerminal && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onDismiss(takedown.id)}
          >
            Dismiss
          </Button>
        )}
      </div>
    </Card>
  );
}

// ─── Prospect mode: brand-grouped summary card ─────────────────
// Prospect scope returns orgless Sparrow drafts. Rather than a per-item
// card grid (that's the Authorized workflow), group by brand and show a
// compact "everything we'd action for you" rollup + a deep link out to
// the brand's Risk tab. No inline scans/detail — link out only.

interface ProspectGroup {
  brand_id: string;
  brand_name: string;
  brand_domain?: string;
  drafts: Takedown[];
}

function groupByBrand(takedowns: Takedown[]): ProspectGroup[] {
  const map = new Map<string, ProspectGroup>();
  for (const t of takedowns) {
    const existing = map.get(t.brand_id);
    if (existing) {
      existing.drafts.push(t);
    } else {
      map.set(t.brand_id, {
        brand_id: t.brand_id,
        brand_name: t.brand_name ?? t.brand_id,
        brand_domain: t.brand_domain,
        drafts: [t],
      });
    }
  }
  // Highest peak priority first — the brands most worth a sales follow-up float up.
  return Array.from(map.values()).sort((a, b) => {
    const peak = (g: ProspectGroup) => Math.max(0, ...g.drafts.map((d) => d.priority_score ?? 0));
    return peak(b) - peak(a);
  });
}

const SEVERITY_ORDER = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const;

function ProspectBrandCard({ group }: { group: ProspectGroup }) {
  const count = group.drafts.length;
  const peakPriority = Math.max(0, ...group.drafts.map((d) => d.priority_score ?? 0));
  const evidenceTotal = group.drafts.reduce((sum, d) => sum + (d.evidence_count ?? 0), 0);
  const isHigh = peakPriority >= 70;

  const severityCounts = group.drafts.reduce<Record<string, number>>((acc, d) => {
    const sev = (d.severity ?? 'LOW').toUpperCase();
    acc[sev] = (acc[sev] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <Card
      variant={isHigh ? 'active' : 'base'}
      accent={isHigh ? 'var(--red)' : 'var(--amber)'}
      style={{ padding: '16px' }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 10 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{
            fontSize: 14, fontWeight: 700, color: 'var(--text-primary)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {group.brand_name}
          </div>
          {group.brand_domain && (
            <div style={{
              fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', marginTop: 2,
            }}>
              {group.brand_domain}
            </div>
          )}
        </div>
        <Badge status="draft" label={`${count} DRAFT${count === 1 ? '' : 'S'}`} />
      </div>

      {/* Severity mix */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
        {SEVERITY_ORDER.filter((s) => severityCounts[s]).map((s) => (
          <Badge key={s} severity={SEVERITY_TO_BADGE[s] ?? 'low'} label={`${severityCounts[s]} ${s}`} />
        ))}
      </div>

      {/* Priority + evidence rollup */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <div style={{ flex: 1, minWidth: 0, fontFamily: 'var(--font-mono)' }}>
          <div style={{ fontSize: 8, color: 'var(--text-muted)', letterSpacing: '0.12em', marginBottom: 4 }}>
            PEAK PRIORITY {peakPriority}/100
          </div>
          <PriorityBar value={peakPriority} max={100} size="sm" color={isHigh ? 'red' : 'amber'} />
        </div>
        <div style={{
          fontSize: 9, fontFamily: 'var(--font-mono)', color: 'var(--text-muted)',
          flexShrink: 0, textAlign: 'right', lineHeight: 1.4,
        }}>
          <div>{evidenceTotal} evidence</div>
        </div>
      </div>

      {/* D2: a real cross-page nav, so this is a Link (supports middle-click
          / ctrl-click / open-in-new-tab / hover-preview) styled inline to
          match Button variant="primary" size="sm" fullWidth — Button.tsx
          itself is app-wide shared-primitive debt (no polymorphic `as`
          support yet, tracked separately) so this stays a local mirror
          rather than a change to the shared component. */}
      <Link
        to={`/brands/${group.brand_id}?tab=risk`}
        style={{
          display:        'flex',
          alignItems:     'center',
          justifyContent: 'center',
          gap:            6,
          width:          '100%',
          fontFamily:     'var(--font-mono)',
          fontWeight:     800,
          letterSpacing:  '0.06em',
          textTransform:  'uppercase',
          textDecoration: 'none',
          cursor:         'pointer',
          outline:        'none',
          transition:     'var(--transition-fast)',
          userSelect:     'none',
          background: 'linear-gradient(135deg, var(--amber), var(--amber-dim))',
          border:     '1px solid rgba(229, 168, 50, 0.60)',
          color:      '#000',
          boxShadow: [
            '0 4px 16px var(--amber-glow)',
            '0 2px 4px rgba(0, 0, 0, 0.40)',
            'inset 0 1px 0 rgba(255, 255, 255, 0.30)',
            'inset 0 -1px 0 rgba(0, 0, 0, 0.20)',
          ].join(', '),
          fontSize:     10,
          padding:      '6px 14px',
          borderRadius: 8,
        }}
      >
        View full risk surface →
      </Link>
    </Card>
  );
}

// ─── Build markdown report from takedown ───────────────────────

function buildTakedownReport(takedown: Takedown): string {
  const parts: string[] = [];

  parts.push('## Target');
  parts.push(`**Type:** ${takedown.target_type.replace(/_/g, ' ')}`);
  if (takedown.target_platform) {
    parts.push(`**Platform:** ${takedown.target_platform}`);
  }
  parts.push(`**Handle / URL:** ${takedown.target_value}`);
  if (takedown.target_url) {
    parts.push(`**Full URL:** ${takedown.target_url}`);
  }
  if (takedown.brand_name) {
    parts.push(`**Brand:** ${takedown.brand_name}`);
  }
  parts.push(`**Source:** ${takedown.source_type ? 'Sparrow AI' : 'Manual'}`);
  parts.push('');

  parts.push('## Evidence');
  if (takedown.evidence_summary) {
    parts.push(takedown.evidence_summary);
    parts.push('');
  }
  if (takedown.evidence_detail) {
    parts.push('### Details');
    parts.push(takedown.evidence_detail);
    parts.push('');
  }

  if (takedown.provider_name || takedown.provider_abuse_contact) {
    parts.push('## Provider');
    if (takedown.provider_name) {
      parts.push(`**Provider:** ${takedown.provider_name}`);
    }
    if (takedown.provider_method) {
      parts.push(`**Method:** ${takedown.provider_method}`);
    }
    if (takedown.provider_abuse_contact) {
      parts.push(`**Abuse Contact:** ${takedown.provider_abuse_contact}`);
    }
    parts.push('');
  }

  if (takedown.notes) {
    parts.push('## Notes');
    parts.push(takedown.notes);
  }

  return parts.join('\n');
}

// ─── Status action buttons for the report panel ───────────────

function TakedownActions({ takedown, onUpdate, isUpdating }: {
  takedown: Takedown;
  onUpdate: (id: string, updates: { status?: string }) => void;
  isUpdating: boolean;
}) {
  const s = takedown.status;

  if (s === 'draft') return (
    <>
      <Button variant="primary" size="sm" disabled={isUpdating} onClick={() => onUpdate(takedown.id, { status: 'submitted' })}>
        Mark Submitted
      </Button>
      <Button variant="ghost" size="sm" disabled={isUpdating} onClick={() => onUpdate(takedown.id, { status: 'withdrawn' })}>
        Dismiss
      </Button>
    </>
  );
  if (s === 'requested') return (
    <>
      <Button variant="primary" size="sm" disabled={isUpdating} onClick={() => onUpdate(takedown.id, { status: 'submitted' })}>
        Mark Submitted
      </Button>
      <Button variant="ghost" size="sm" disabled={isUpdating} onClick={() => onUpdate(takedown.id, { status: 'draft' })}>
        Back to Draft
      </Button>
    </>
  );
  if (s === 'submitted' || s === 'pending_response') return (
    <>
      <Button variant="success" size="sm" disabled={isUpdating} onClick={() => onUpdate(takedown.id, { status: 'taken_down' })}>
        Mark Resolved
      </Button>
      <Button variant="ghost" size="sm" disabled={isUpdating} onClick={() => onUpdate(takedown.id, { status: 'failed' })}>
        Failed
      </Button>
    </>
  );
  return null;
}


// ─── Main page ─────────────────────────────────────────────────

export function Takedowns() {
  const [searchParams, setSearchParams] = useSearchParams();

  // Scope + brand deep-link params read live off the URL (single source of
  // truth — no mirrored local state to drift out of sync). `scope` defaults
  // to `authorized` (matches the backend's default) so a bare /admin/takedowns
  // visit and the Console ?tab=takedowns pane both start on the SOC execution
  // queue; resolveScope() also maps any non-UI value (e.g. `?scope=all`) back
  // to `authorized` so the toggle can never render in a tabless state.
  const scope = resolveScope(searchParams.get('scope'));
  const brandId = searchParams.get('brand') || undefined;
  const isProspect = scope === 'prospect';

  const [statusFilter, setStatusFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');
  const [sortBy, setSortBy] = useState('priority');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [selectedTakedown, setSelectedTakedown] = useState<Takedown | null>(null);
  const [updatingId, setUpdatingId] = useState<string | null>(null);

  // Debounce search
  const [searchTimeout, setSearchTimeout] = useState<ReturnType<typeof setTimeout> | null>(null);
  const handleSearch = useCallback((val: string) => {
    setSearch(val);
    if (searchTimeout) clearTimeout(searchTimeout);
    setSearchTimeout(setTimeout(() => setDebouncedSearch(val), 300));
  }, [searchTimeout]);

  const handleScopeChange = useCallback((next: string) => {
    const nextScope = resolveScope(next);
    setSearchParams((prev) => {
      const params = new URLSearchParams(prev);
      params.set('scope', nextScope);
      return params;
    }, { replace: true });
  }, [setSearchParams]);

  const clearBrandFilter = useCallback(() => {
    setSearchParams((prev) => {
      const params = new URLSearchParams(prev);
      params.delete('brand');
      return params;
    }, { replace: true });
  }, [setSearchParams]);

  // Authorized mode keeps the full filter/sort/search workflow, paginated
  // server-side at 100/page — the existing SOC queue behavior, unchanged.
  //
  // Prospect mode is a brand-grouped "everything we'd action for you" sales
  // rollup, not a per-item filtered list — a single capped page would drop
  // brands past the cutoff and undercount straddling brands' draft/evidence
  // totals, which is exactly wrong for that artifact. So it drains the full
  // scoped set (bounded by a safety cap — see useAdminTakedownsAll) via a
  // separate hook instead of accepting the authorized-mode filter params.
  //
  // Both hooks are called unconditionally every render (rules of hooks) and
  // gated with `enabled` so only the active scope's branch actually fetches.
  const authorizedQuery = useAdminTakedowns({
    scope: 'authorized',
    brand_id: brandId,
    status: statusFilter !== 'all' ? statusFilter : undefined,
    target_type: typeFilter !== 'all' ? typeFilter : undefined,
    sort: sortBy,
    search: debouncedSearch || undefined,
    limit: 100,
  }, { enabled: !isProspect });

  const prospectQuery = useAdminTakedownsAll({
    scope: 'prospect',
    brand_id: brandId,
    enabled: isProspect,
  });

  const updateTakedown = useUpdateTakedown();
  const { showToast } = useToast();

  const isLoading = isProspect ? prospectQuery.isLoading : authorizedQuery.isLoading;
  const takedowns = isProspect ? (prospectQuery.data?.takedowns ?? []) : (authorizedQuery.data?.takedowns ?? []);
  const statusCounts = isProspect ? (prospectQuery.data?.statusCounts ?? []) : (authorizedQuery.data?.statusCounts ?? []);
  // Safety-cap indicator (F1) — only meaningful in Prospect mode, where the
  // fetch drains pages until either exhausted or this cap trips.
  const prospectTruncated = isProspect && (prospectQuery.data?.truncated ?? false);

  // Compute stats from statusCounts — scoped server-side to the active
  // scope + brand filter (T1 contract), so no client-side re-filtering needed.
  const stats = useMemo(() => {
    const map: Record<string, number> = {};
    statusCounts.forEach((sc) => { map[sc.status] = sc.count; });
    const total = Object.values(map).reduce((a, b) => a + b, 0);
    return {
      total,
      draft: map.draft ?? 0,
      submitted: (map.submitted ?? 0) + (map.pending_response ?? 0),
      resolved: map.taken_down ?? 0,
    };
  }, [statusCounts]);

  // Count per status pill for filter bar badges (Authorized mode only)
  const pillCounts = useMemo(() => {
    const map: Record<string, number> = {};
    statusCounts.forEach((sc) => { map[sc.status] = sc.count; });
    return {
      all: Object.values(map).reduce((a, b) => a + b, 0),
      draft: map.draft ?? 0,
      requested: map.requested ?? 0,
      submitted: (map.submitted ?? 0) + (map.pending_response ?? 0),
      taken_down: map.taken_down ?? 0,
      withdrawn: (map.withdrawn ?? 0) + (map.failed ?? 0) + (map.expired ?? 0),
    };
  }, [statusCounts]);

  // Prospect mode: group the orgless drafts by brand + roll up summary stats.
  // `takedowns` here is the FULLY DRAINED set (useAdminTakedownsAll pages
  // through the whole scoped result, capped only by the safety limit), so
  // brand grouping + evidence/severity rollups are accurate against the real
  // population, not just the first page. The one exception is the headline
  // draft count: that stays pinned to `stats.total` (F2) — the server-side
  // COUNT over the full scoped set — so it can never disagree with the
  // array-derived numbers even in the rare case the safety cap is hit.
  const prospectGroups = useMemo(() => (isProspect ? groupByBrand(takedowns) : []), [isProspect, takedowns]);
  const prospectStats = useMemo(() => {
    const highSeverity = takedowns.filter((t) => {
      const sev = (t.severity ?? '').toUpperCase();
      return sev === 'HIGH' || sev === 'CRITICAL';
    }).length;
    const evidenceTotal = takedowns.reduce((sum, t) => sum + (t.evidence_count ?? 0), 0);
    return {
      brands: prospectGroups.length,
      highSeverity,
      evidenceTotal,
    };
  }, [takedowns, prospectGroups]);

  const brandFilterLabel = brandId
    ? (takedowns[0]?.brand_name ?? 'this brand')
    : null;

  const handleUpdate = useCallback((id: string, updates: { status?: string; notes?: string }) => {
    setUpdatingId(id);
    updateTakedown.mutate({ id, ...updates }, {
      onSuccess: () => {
        showToast(updates.status ? 'Status updated' : 'Notes saved', 'success');
        setUpdatingId(null);
        // Close panel on status change
        if (updates.status) setSelectedTakedown(null);
      },
      onError: () => {
        showToast('Update failed', 'error');
        setUpdatingId(null);
      },
    });
  }, [updateTakedown, showToast]);

  // ─── Render ────────────────────────────────────────────────

  return (
    <div className="animate-fade-in space-y-6">
      {/* Page header */}
      <PageHeader
        title="Takedowns"
        subtitle={isProspect
          ? `${stats.total} orgless drafts across ${prospectStats.brands} brands`
          : `${stats.total} total requests`}
        meta={<span className="font-mono text-[10px] text-white/50 uppercase tracking-wider">Sparrow Queue</span>}
      />

      {/* ─── SCOPE TOGGLE ────────────────────────────── */}
      <Tabs
        variant="bar"
        tabs={SCOPE_TABS}
        activeTab={scope}
        onChange={handleScopeChange}
        className="max-w-xs"
      />

      {/* ─── ACTIVE BRAND FILTER ─────────────────────── */}
      {brandFilterLabel && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)',
        }}>
          <span>Filtered to brand: <strong style={{ color: 'var(--text-primary)' }}>{brandFilterLabel}</strong></span>
          <Button variant="ghost" size="sm" onClick={clearBrandFilter}>Clear</Button>
        </div>
      )}

      {/* ─── SAFETY-CAP INDICATOR (F1) ───────────────── */}
      {prospectTruncated && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--sev-high)',
          padding: '8px 12px', borderRadius: 8,
          background: 'var(--sev-high-bg)', border: '1px solid rgba(251,146,60,0.30)',
        }}>
          Showing top {takedowns.length.toLocaleString()} of {stats.total.toLocaleString()} prospect drafts — safety cap reached. Narrow with a brand filter for the full picture.
        </div>
      )}

      {isProspect ? (
        <>
          {/* ─── PROSPECT STAT CARDS ─────────────────── */}
          <StatGrid cols={4}>
            <StatCard label="Brands"          value={prospectStats.brands}        accentColor="var(--amber)" />
            <StatCard label="Total Drafts"    value={stats.total}                 accentColor="var(--blue)" />
            <StatCard label="High/Critical"   value={prospectStats.highSeverity}  accentColor="var(--red)" />
            <StatCard label="Evidence Points" value={prospectStats.evidenceTotal} accentColor="var(--green)" />
          </StatGrid>

          {/* ─── LOADING STATE ───────────────────────── */}
          {isLoading && (
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))',
              gap: 12,
            }}>
              {Array.from({ length: 6 }).map((_, i) => (
                <Card key={i} style={{ padding: '16px', height: 200 }} className="animate-pulse"><div /></Card>
              ))}
            </div>
          )}

          {/* ─── BRAND-GROUPED CARDS ─────────────────── */}
          {!isLoading && prospectGroups.length > 0 && (
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))',
              gap: 12,
            }}>
              {prospectGroups.map((group) => (
                <ProspectBrandCard key={group.brand_id} group={group} />
              ))}
            </div>
          )}

          {/* ─── EMPTY STATE ──────────────────────────── */}
          {!isLoading && prospectGroups.length === 0 && (
            <EmptyState
              icon={<ShieldAlert />}
              title="No orgless drafts"
              subtitle="Prospect drafts appear here once Sparrow generates takedown recommendations for a brand that hasn't opted into an org yet."
              variant="clean"
            />
          )}
        </>
      ) : (
        <>
          {/* ─── STAT CARDS ──────────────────────────── */}
          <StatGrid cols={4}>
            <StatCard label="Total Takedowns" value={stats.total}     accentColor="var(--amber)" />
            <StatCard label="Pending Review"  value={stats.draft}     accentColor="var(--sev-high)" />
            <StatCard label="Submitted"       value={stats.submitted} accentColor="var(--blue)" />
            <StatCard label="Resolved"        value={stats.resolved}  accentColor="var(--green)" />
          </StatGrid>

          {/* ─── FILTER BAR ───────────────────────────── */}
          <FilterBar
            filters={STATUS_PILLS.map(p => ({
              value: p.key,
              label: p.label,
              count: pillCounts[p.key as keyof typeof pillCounts],
            }))}
            active={statusFilter}
            onChange={setStatusFilter}
            search={{ value: search, onChange: handleSearch, placeholder: 'Search by brand, handle, or URL...' }}
            actions={
              <select
                className="rounded-md px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider"
                style={{
                  background: 'var(--bg-input)',
                  border: '1px solid var(--border-base)',
                  color: 'var(--text-primary)',
                  outline: 'none',
                }}
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value)}
              >
                {SORT_OPTIONS.map((o) => (
                  <option key={o.key} value={o.key} style={{ background: 'var(--bg-page)', color: 'var(--text-primary)' }}>{o.label}</option>
                ))}
              </select>
            }
          >
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {TYPE_PILLS.map((pill) => (
                <Button
                  key={pill.key}
                  variant={typeFilter === pill.key ? 'primary' : 'ghost'}
                  size="sm"
                  onClick={() => setTypeFilter(pill.key)}
                >
                  {pill.label}
                </Button>
              ))}
            </div>
          </FilterBar>

          {/* ─── LOADING STATE ───────────────────────── */}
          {isLoading && (
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(420px, 1fr))',
              gap: 12,
            }}>
              {Array.from({ length: 6 }).map((_, i) => (
                <Card key={i} style={{ padding: '16px', height: 220 }} className="animate-pulse"><div /></Card>
              ))}
            </div>
          )}

          {/* ─── CARD GRID ────────────────────────────── */}
          {!isLoading && takedowns.length > 0 && (
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(420px, 1fr))',
              gap: 12,
            }}>
              {takedowns.map((td) => (
                <TakedownCard
                  key={td.id}
                  takedown={td}
                  onReview={setSelectedTakedown}
                  onStatusChange={(id, status) => handleUpdate(id, { status })}
                  onDismiss={(id) => handleUpdate(id, { status: 'withdrawn' })}
                />
              ))}
            </div>
          )}

          {/* ─── EMPTY STATE ──────────────────────────── */}
          {!isLoading && takedowns.length === 0 && (
            <EmptyState
              icon={<Shield />}
              title="No takedown requests"
              subtitle="Create a takedown request from any identified threat to begin the removal process"
              variant="clean"
            />
          )}
        </>
      )}

      {/* ─── DETAIL PANEL ─────────────────────────────── */}
      <ReportPanel
        isOpen={!!selectedTakedown}
        onClose={() => setSelectedTakedown(null)}
        title={selectedTakedown?.target_value ?? 'Takedown Request'}
        subtitle={
          selectedTakedown
            ? `${selectedTakedown.target_type.replace(/_/g, ' ')} · ${selectedTakedown.brand_name ?? 'Unknown brand'}`
            : undefined
        }
        badge={
          selectedTakedown ? (
            <>
              <Badge
                severity={SEVERITY_TO_BADGE[selectedTakedown.severity?.toUpperCase()] ?? 'low'}
                label={selectedTakedown.severity}
              />
              <Badge
                status={STATUS_TO_BADGE[selectedTakedown.status] ?? 'draft'}
                label={STATUS_DISPLAY[selectedTakedown.status] ?? selectedTakedown.status}
              />
            </>
          ) : null
        }
        content={selectedTakedown ? buildTakedownReport(selectedTakedown) : ''}
        meta={
          selectedTakedown ? (
            <>
              <span>Priority {selectedTakedown.priority_score}/100</span>
              <span>•</span>
              <span>Method: {selectedTakedown.provider_method ?? 'unknown'}</span>
              <span>•</span>
              <span>{relativeTime(selectedTakedown.created_at)}</span>
            </>
          ) : null
        }
        actions={
          selectedTakedown ? (
            <TakedownActions
              takedown={selectedTakedown}
              onUpdate={handleUpdate}
              isUpdating={updatingId === selectedTakedown.id}
            />
          ) : null
        }
      />
    </div>
  );
}

