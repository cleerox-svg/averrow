import { useState, useCallback, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useAuditLog } from '@/hooks/useAuditLog';
import type { AuditEntry } from '@/hooks/useAuditLog';

// Map an audit resource to a destination so the compliance log can pivot to
// what actually changed (GM1). Only returns a link for types with a resolving
// route; unknown types stay plain text.
function resourceHref(type: string | null, id: string | null): string | null {
  if (!type || !id) return null;
  switch (type) {
    case 'brand':
    case 'brand_profile': return `/brands/${id}`;
    case 'incident':      return `/admin/incidents/${id}`;
    case 'campaign':      return `/campaigns/${id}`;
    case 'threat_actor':  return `/threat-actors?focus=${encodeURIComponent(id)}`;
    case 'provider':
    case 'hosting_provider': return `/providers?focus=${encodeURIComponent(id)}`;
    case 'organization':
    case 'org':           return '/admin/customers';
    default:              return null;
  }
}
import { Button, Card, Input } from '@/design-system/components';
import { relativeTime, parseUtc } from '@/lib/time';
import { api } from '@/lib/api';

/* ─── Constants ───────────────────────────────────────────────────── */

const PAGE_SIZE = 50;

const OUTCOME_PILLS = [
  { key: 'all', label: 'ALL' },
  { key: 'success', label: 'SUCCESS' },
  { key: 'failure', label: 'FAILURE' },
  { key: 'denied', label: 'DENIED' },
] as const;

const WINDOW_PILLS = [
  { key: '24h', label: '24H' },
  { key: '7d', label: '7D' },
  { key: '30d', label: '30D' },
  { key: 'all', label: 'ALL' },
] as const;

const ACTION_OPTIONS = [
  'login', 'logout', 'login_no_account', 'refresh_invalid',
  'brand_social_discovery', 'social_scan_triggered',
  'brand_monitor_add', 'brand_profile_create',
  'org_created', 'org_brand_assigned',
] as const;

/* ─── Helpers ─────────────────────────────────────────────────────── */

// relativeTime comes from lib/time (which now normalizes D1's bare UTC
// timestamps itself — no more per-page "+ 'Z'" fixups).

function formatTimestamp(ts: string): string {
  return parseUtc(ts).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

function outcomeColor(outcome: string): string {
  if (outcome === 'success') return 'text-green-400';
  if (outcome === 'failure') return 'text-red-400';
  return 'text-amber-400';
}

function outcomeDotColor(outcome: string): string {
  if (outcome === 'success') return 'bg-green-400';
  if (outcome === 'failure') return 'bg-red-400';
  return 'bg-amber-400';
}

function outcomeBadgeClass(outcome: string): string {
  if (outcome === 'success') return 'border-green-500/30 bg-green-900/30 text-green-400';
  if (outcome === 'failure') return 'border-red-500/30 bg-red-900/30 text-red-400';
  return 'border-amber-500/30 bg-amber-900/30 text-amber-400';
}

function pillStyle(active: boolean): React.CSSProperties {
  return {
    background: active ? 'var(--amber-glow)' : 'var(--bg-input)',
    border:     `1px solid ${active ? 'var(--amber-border)' : 'var(--border-base)'}`,
    color:      active ? 'var(--amber)' : 'var(--text-tertiary)',
    transition: 'var(--transition-fast)',
  };
}

function truncateMiddle(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + '...';
}

function formatJson(raw: string | null): string {
  if (!raw) return '—';
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

/* ─── Stat Card ───────────────────────────────────────────────────── */

function StatCard({ title, value, glowClass }: {
  title: string;
  value: number | string;
  glowClass?: string;
}) {
  return (
    <Card hover={false} padding={16}>
      <div className="font-mono text-[9px] uppercase tracking-widest mb-2" style={{ color: 'var(--text-secondary)' }}>{title}</div>
      <div className={`font-mono text-[28px] font-bold leading-none ${glowClass ?? ''}`} style={glowClass ? undefined : { color: 'var(--text-primary)' }}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
    </Card>
  );
}

/* ─── Expanded Row Detail ─────────────────────────────────────────── */

function RowDetail({ entry }: { entry: AuditEntry }) {
  const [copied, setCopied] = useState(false);

  const copyIp = useCallback(() => {
    if (entry.ip_address) {
      navigator.clipboard.writeText(entry.ip_address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }, [entry.ip_address]);

  return (
    <tr>
      <td colSpan={7} className="px-3 py-0">
        <Card hover={false} padding={16} className="mb-3 mt-1 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <span className="font-mono text-[9px] uppercase tracking-widest" style={{ color: 'var(--text-tertiary)' }}>Full Timestamp</span>
              <p className="font-mono text-[12px] mt-0.5" style={{ color: 'var(--text-primary)' }}>{formatTimestamp(entry.timestamp)}</p>
            </div>
            <div>
              <span className="font-mono text-[9px] uppercase tracking-widest" style={{ color: 'var(--text-tertiary)' }}>Event ID</span>
              <p className="font-mono text-[11px] mt-0.5 break-all" style={{ color: 'var(--text-secondary)' }}>{entry.id}</p>
            </div>
          </div>

          {entry.ip_address && (
            <div>
              <span className="font-mono text-[9px] uppercase tracking-widest" style={{ color: 'var(--text-tertiary)' }}>IP Address</span>
              <p className="font-mono text-[12px] mt-0.5" style={{ color: 'var(--text-primary)' }}>
                {entry.ip_address}
                <button
                  onClick={copyIp}
                  className="ml-2 text-[10px] transition-colors"
                  style={{ color: 'var(--text-tertiary)' }}
                >
                  {copied ? 'copied' : 'copy'}
                </button>
              </p>
            </div>
          )}

          {entry.user_agent && (
            <div className="hidden sm:block">
              <span className="font-mono text-[9px] uppercase tracking-widest" style={{ color: 'var(--text-tertiary)' }}>User Agent</span>
              <p className="font-mono text-[11px] mt-0.5 break-all" style={{ color: 'var(--text-secondary)' }}>{entry.user_agent}</p>
            </div>
          )}

          <div>
            <span className="font-mono text-[9px] uppercase tracking-widest" style={{ color: 'var(--text-tertiary)' }}>Details</span>
            <pre className="font-mono text-[11px] mt-1 bg-white/[0.03] rounded-md p-3 overflow-x-auto whitespace-pre-wrap break-all" style={{ color: 'var(--text-primary)' }}>
              {formatJson(entry.details)}
            </pre>
          </div>
        </Card>
      </td>
    </tr>
  );
}

/* ─── Main Page ───────────────────────────────────────────────────── */

export function AdminAudit() {
  // Filter state
  const [outcomeFilter, setOutcomeFilter] = useState('all');
  const [actionFilter, setActionFilter] = useState('all');
  const [resourceTypeFilter, setResourceTypeFilter] = useState('all');
  const [windowFilter, setWindowFilter] = useState('7d');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [searchTimeout, setSearchTimeout] = useState<ReturnType<typeof setTimeout> | null>(null);
  const [page, setPage] = useState(1);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const handleSearch = useCallback((val: string) => {
    setSearch(val);
    if (searchTimeout) clearTimeout(searchTimeout);
    setSearchTimeout(setTimeout(() => {
      setDebouncedSearch(val);
      setPage(1);
    }, 300));
  }, [searchTimeout]);

  // Query
  const { data, isLoading } = useAuditLog({
    outcome: outcomeFilter !== 'all' ? outcomeFilter : undefined,
    action: actionFilter !== 'all' ? actionFilter : undefined,
    resource_type: resourceTypeFilter !== 'all' ? resourceTypeFilter : undefined,
    window: windowFilter,
    search: debouncedSearch || undefined,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });

  const entries = data?.entries ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.ceil(total / PAGE_SIZE);

  // Server-side aggregates over the FULL filtered set. The previous
  // client-side versions counted only the visible 50-row page, so the
  // cards under-reported and changed as the operator paginated — and
  // the resource-type dropdown silently missed values not on the page.
  const todayCount = data?.stats?.today ?? 0;
  const failureDeniedCount = (data?.stats?.failures ?? 0) + (data?.stats?.denied ?? 0);
  const uniqueActions = data?.stats?.unique_actions ?? 0;
  const resourceTypeOptions = data?.resourceTypes ?? [];

  // Pagination
  const pageNumbers = useMemo(() => {
    const pages: (number | 'ellipsis')[] = [];
    if (totalPages <= 5) {
      for (let i = 1; i <= totalPages; i++) pages.push(i);
    } else {
      pages.push(1);
      if (page > 3) pages.push('ellipsis');
      for (let i = Math.max(2, page - 1); i <= Math.min(totalPages - 1, page + 1); i++) pages.push(i);
      if (page < totalPages - 2) pages.push('ellipsis');
      pages.push(totalPages);
    }
    return pages;
  }, [page, totalPages]);

  const showFrom = total > 0 ? (page - 1) * PAGE_SIZE + 1 : 0;
  const showTo = Math.min(page * PAGE_SIZE, total);

  const handleExport = useCallback(async () => {
    // Stream the CSV through an authenticated fetch and Blob-download it.
    // The previous approach put the bearer token in the URL query string
    // (?token=...), which leaks it into browser history, proxy logs, and
    // Referer headers — defeating the memory-only token design.
    const token = api.getToken();
    try {
      const res = await fetch('/api/admin/audit/export', {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      if (!res.ok) throw new Error(`Export failed (HTTP ${res.status})`);
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(objectUrl);
    } catch (err) {
      console.error('[audit] export failed:', err);
      window.alert('Audit export failed — check your session and try again.');
    }
  }, []);

  return (
    <div className="animate-fade-in space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold font-display" style={{ color: 'var(--text-primary)' }}>Audit Log</h1>
          <p className="text-sm font-mono mt-1" style={{ color: 'var(--text-tertiary)' }}>Platform activity trail</p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleExport}
          icon={
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
          }
        >
          <span className="hidden sm:inline">Export CSV</span>
        </Button>
      </div>

      {/* Stat Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard title="Total Events" value={total} />
        <StatCard title="Today" value={todayCount} />
        <StatCard title="Failures / Denied" value={failureDeniedCount} />
        <StatCard title="Unique Actions" value={uniqueActions} />
      </div>

      {/* Filter Bar */}
      <Card hover={false} padding={12}>
        <div className="flex flex-col lg:flex-row lg:items-center gap-3">
          {/* Search */}
          <div className="w-full lg:w-64">
            <Input
              type="text"
              value={search}
              onChange={(e) => handleSearch(e.target.value)}
              placeholder="Search actions, users, IPs..."
              className="font-mono text-[11px]"
            />
          </div>

          {/* Outcome pills */}
          <div className="flex items-center gap-1.5 overflow-x-auto">
            {OUTCOME_PILLS.map((pill) => (
              <button
                key={pill.key}
                onClick={() => { setOutcomeFilter(pill.key); setPage(1); }}
                className="rounded-md px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider whitespace-nowrap"
                style={pillStyle(outcomeFilter === pill.key)}
              >
                {pill.label}
              </button>
            ))}

            <span className="w-px h-5 bg-white/10 mx-1 flex-shrink-0" />

            {/* Action dropdown */}
            <select
              value={actionFilter}
              onChange={(e) => { setActionFilter(e.target.value); setPage(1); }}
              className="rounded-md px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider"
              style={{
                background: 'var(--bg-input)',
                border: '1px solid var(--border-base)',
                color: 'var(--text-primary)',
                outline: 'none',
                transition: 'var(--transition-fast)',
              }}
            >
              <option value="all">All Actions</option>
              {ACTION_OPTIONS.map((a) => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>

            {/* Resource-type filter (GM1). Options come from the server's
                DISTINCT over the full filtered set — not the visible page. */}
            {resourceTypeOptions.length > 0 && (
              <select
                value={resourceTypeFilter}
                onChange={(e) => { setResourceTypeFilter(e.target.value); setPage(1); }}
                className="rounded-md px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider"
                style={{
                  background: 'var(--bg-input)',
                  border: '1px solid var(--border-base)',
                  color: 'var(--text-primary)',
                  outline: 'none',
                  transition: 'var(--transition-fast)',
                }}
              >
                <option value="all">All Resources</option>
                {resourceTypeOptions.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            )}

            <span className="w-px h-5 bg-white/10 mx-1 flex-shrink-0" />

            {/* Window pills */}
            {WINDOW_PILLS.map((pill) => (
              <button
                key={pill.key}
                onClick={() => { setWindowFilter(pill.key); setPage(1); }}
                className="rounded-md px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider whitespace-nowrap"
                style={pillStyle(windowFilter === pill.key)}
              >
                {pill.label}
              </button>
            ))}
          </div>
        </div>
      </Card>

      {/* Loading */}
      {isLoading && (
        <div className="space-y-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <Card key={i} hover={false} padding={16} className="animate-pulse h-12">{null}</Card>
          ))}
        </div>
      )}

      {/* Audit Table */}
      {!isLoading && entries.length > 0 && (
        <Card hover={false} padding={0} className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[600px]">
              <thead>
                <tr className="border-b border-white/[0.06]">
                  <th className="font-mono text-[11px] font-semibold uppercase tracking-wider px-3 py-2.5 text-left" style={{ color: 'var(--text-secondary)' }}>Timestamp</th>
                  <th className="font-mono text-[11px] font-semibold uppercase tracking-wider px-3 py-2.5 text-left" style={{ color: 'var(--text-secondary)' }}>Action</th>
                  <th className="font-mono text-[11px] font-semibold uppercase tracking-wider px-3 py-2.5 text-left" style={{ color: 'var(--text-secondary)' }}>Outcome</th>
                  <th className="font-mono text-[11px] font-semibold uppercase tracking-wider px-3 py-2.5 text-left" style={{ color: 'var(--text-secondary)' }}>User</th>
                  <th className="font-mono text-[11px] font-semibold uppercase tracking-wider px-3 py-2.5 text-left" style={{ color: 'var(--text-secondary)' }}>IP Address</th>
                  <th className="font-mono text-[11px] font-semibold uppercase tracking-wider px-3 py-2.5 text-left" style={{ color: 'var(--text-secondary)' }}>Resource</th>
                  <th className="font-mono text-[11px] font-semibold uppercase tracking-wider px-3 py-2.5 text-center w-10" style={{ color: 'var(--text-secondary)' }}>
                    <span className="sr-only">Expand</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <AuditRow
                    key={entry.id}
                    entry={entry}
                    expanded={expandedId === entry.id}
                    onToggle={() => setExpandedId(expandedId === entry.id ? null : entry.id)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Empty state */}
      {!isLoading && entries.length === 0 && (
        <Card hover={false} padding={48} className="text-center">
          <p className="font-mono text-[11px] text-white/40">No audit entries match the current filters</p>
        </Card>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 pt-1">
          <span className="font-mono text-[11px] text-white/40">
            Showing {showFrom}&ndash;{showTo} of {total.toLocaleString()} entries
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page === 1}
              className="font-mono text-[11px] px-2.5 py-1 rounded border border-white/10 text-white/40 disabled:opacity-30 transition-colors"
            >
              Prev
            </button>
            <span className="hidden sm:contents">
              {pageNumbers.map((p, i) =>
                p === 'ellipsis' ? (
                  <span key={`e${i}`} className="font-mono text-[11px] text-white/30 px-1">&hellip;</span>
                ) : (
                  <button
                    key={p}
                    onClick={() => setPage(p)}
                    className={`font-mono text-[11px] px-2.5 py-1 rounded border transition-colors ${
                      page === p
                        ? 'border-white/30'
                        : 'border-white/10 text-white/40'
                    }`}
                    style={page === p ? { color: 'var(--amber)', borderColor: 'var(--amber)' } : undefined}
                  >
                    {p}
                  </button>
                ),
              )}
            </span>
            <button
              onClick={() => setPage(p => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
              className="font-mono text-[11px] px-2.5 py-1 rounded border border-white/10 text-white/40 disabled:opacity-30 transition-colors"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Table Row ───────────────────────────────────────────────────── */

function AuditRow({ entry, expanded, onToggle }: {
  entry: AuditEntry;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr
        onClick={onToggle}
        className="data-row border-b border-white/[0.03] group"
      >
        {/* Timestamp */}
        <td className="px-3 py-2.5 font-mono text-[12px] whitespace-nowrap" style={{ color: 'var(--text-secondary)' }} title={formatTimestamp(entry.timestamp)}>
          {relativeTime(entry.timestamp)}
        </td>

        {/* Action */}
        <td className="px-3 py-2.5">
          <span className={`inline-block font-mono text-[10px] px-2 py-0.5 rounded border ${outcomeBadgeClass(entry.outcome)}`}>
            {entry.action}
          </span>
        </td>

        {/* Outcome */}
        <td className="px-3 py-2.5">
          <span className="flex items-center gap-1.5">
            <span className={`w-2 h-2 rounded-full ${outcomeDotColor(entry.outcome)} ${entry.outcome === 'success' ? 'animate-pulse' : ''}`} />
            <span className={`font-mono text-[10px] ${outcomeColor(entry.outcome)}`}>
              {entry.outcome}
            </span>
          </span>
        </td>

        {/* User */}
        <td className="px-3 py-2.5 font-mono text-[11px]" style={{ color: 'var(--text-primary)' }}>
          {entry.user_id ? truncateMiddle(entry.user_id, 20) : <span className="text-white/40">System</span>}
        </td>

        {/* IP */}
        <td className="px-3 py-2.5 font-mono text-[11px] whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>
          {entry.ip_address ? truncateMiddle(entry.ip_address, 15) : '—'}
        </td>

        {/* Resource — clickable when it maps to an entity route (GM1). */}
        <td className="px-3 py-2.5 font-mono text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
          {entry.resource_type
            ? (() => {
                const href = resourceHref(entry.resource_type, entry.resource_id);
                const label = `${entry.resource_type}${entry.resource_id ? `: ${truncateMiddle(entry.resource_id, 12)}` : ''}`;
                return href ? (
                  <Link
                    to={href}
                    onClick={(e) => e.stopPropagation()}
                    className="hover:underline"
                    style={{ color: 'var(--blue)' }}
                  >
                    {label} ↗
                  </Link>
                ) : label;
              })()
            : '—'}
        </td>

        {/* Chevron */}
        <td className="px-3 py-2.5 text-center">
          <svg
            className={`w-4 h-4 text-white/40 group-hover:text-white/50 transition-transform ${expanded ? 'rotate-180' : ''}`}
            fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </td>
      </tr>
      {expanded && <RowDetail entry={entry} />}
    </>
  );
}
