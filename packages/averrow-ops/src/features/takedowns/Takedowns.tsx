import React, { useState, useMemo, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useAdminTakedowns, useUpdateTakedown } from '@/hooks/useTakedowns';
import type { Takedown } from '@/hooks/useTakedowns';
import { useToast } from '@/components/ui/Toast';
import { relativeTime } from '@/lib/time';
import { Shield } from 'lucide-react';
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

const SEVERITY_TO_BADGE: Record<string, Severity> = {
  HIGH: 'critical',
  MEDIUM: 'high',
  LOW: 'low',
  CRITICAL: 'critical',
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

  const { data, isLoading } = useAdminTakedowns({
    status: statusFilter !== 'all' ? statusFilter : undefined,
    target_type: typeFilter !== 'all' ? typeFilter : undefined,
    sort: sortBy,
    search: debouncedSearch || undefined,
    limit: 100,
  });

  const updateTakedown = useUpdateTakedown();
  const { showToast } = useToast();

  const takedowns = data?.takedowns ?? [];
  const statusCounts = data?.statusCounts ?? [];

  // Compute stats from statusCounts (these are global, not filtered)
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

  // Count per status pill for filter bar badges
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
        subtitle={`${stats.total} total requests`}
        meta={<span className="font-mono text-[10px] text-white/50 uppercase tracking-wider">Sparrow Queue</span>}
      />

      {/* ─── STAT CARDS ──────────────────────────────── */}
      <StatGrid cols={4}>
        <StatCard label="Total Takedowns" value={stats.total}     accentColor="var(--amber)" />
        <StatCard label="Pending Review"  value={stats.draft}     accentColor="var(--sev-high)" />
        <StatCard label="Submitted"       value={stats.submitted} accentColor="var(--blue)" />
        <StatCard label="Resolved"        value={stats.resolved}  accentColor="var(--green)" />
      </StatGrid>

      {/* ─── FILTER BAR ──────────────────────────────── */}
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

      {/* ─── LOADING STATE ───────────────────────────── */}
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

      {/* ─── CARD GRID ───────────────────────────────── */}
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

      {/* ─── EMPTY STATE ─────────────────────────────── */}
      {!isLoading && takedowns.length === 0 && (
        <EmptyState
          icon={<Shield />}
          title="No takedown requests"
          subtitle="Create a takedown request from any identified threat to begin the removal process"
          variant="clean"
        />
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

