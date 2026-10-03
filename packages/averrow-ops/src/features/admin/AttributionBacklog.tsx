// Attribution Backlog admin queue — PR-B from the 2026-05-16 audit.
//
// Surfaces infrastructure_clusters with no actor_id, sorted by
// threat_count. Audit finding #6: 2,334 of 2,483 clusters (94%)
// have no actor_id. Attributor tried 1,330 of them via Haiku and
// got "unknown" for 1,325 (0.4% resolution). These are large piles
// of evidence sitting unattributed — a human triage queue.
//
// The follow-up landed: rows now carry Attribute (inline actor picker,
// fans threat_attributions out as source='manual') and Dismiss (marks
// the cluster unattributable and drops it from the queue), plus
// server-side search + pagination past the old top-50 cap.

import { Fragment, useRef, useState } from 'react';
import {
  useAttributionBacklog, useAttributeCluster, useDismissCluster, useActorSearch,
  BACKLOG_PAGE_SIZE,
} from '@/hooks/useAttributionBacklog';
import type { BacklogCluster, ActorOption } from '@/hooks/useAttributionBacklog';
import { useNavigate } from 'react-router-dom';
import { Card, FilterBar, PageHeader, StatTile, PageState, Table, Th, Td } from '@/design-system/components';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { timeAgo } from '@/lib/time';

// timeAgo from lib/time (normalizes D1's bare UTC timestamps itself).
const relTime = (iso: string | null): string => timeAgo(iso) ?? '—';

function ClusterRow({
  cluster,
  onSelect,
  pickerOpen,
  onTogglePicker,
  onDismiss,
  busy,
}: {
  cluster: BacklogCluster;
  onSelect: () => void;
  pickerOpen: boolean;
  onTogglePicker: () => void;
  onDismiss: () => void;
  busy: boolean;
}) {
  return (
    // The row keeps native semantics (the Attribute/Dismiss buttons stay
    // reachable). Keyboard/AT navigation is the name button in the first cell;
    // the row click is a mouse convenience only.
    <tr onClick={onSelect} className="data-row cursor-pointer">
      <Td className="px-3 py-2 font-mono text-[11px]" style={{ color: 'var(--text-primary)' }}>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onSelect(); }}
          aria-label={`Open cluster ${cluster.cluster_name || cluster.id.slice(0, 12)}`}
          className="text-left font-mono text-[11px] rounded hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--amber-text)]"
        >
          {cluster.cluster_name || cluster.id.slice(0, 12)}
        </button>
      </Td>
      <Td
        className="px-3 py-2 text-right font-mono text-[12px] font-semibold"
        style={{
          color:
            cluster.threat_count >= 1000 ? 'var(--sev-critical)' :
            cluster.threat_count >= 100  ? 'var(--sev-high)'     :
            cluster.threat_count >= 25   ? 'var(--sev-medium)'   :
                                            'var(--text-secondary)',
        }}
      >
        {cluster.threat_count.toLocaleString()}
      </Td>
      <Td
        className="px-3 py-2 font-mono text-[10px]"
        style={{ color: 'var(--text-secondary)' }}
      >
        {cluster.asns ? cluster.asns.split(',').slice(0, 2).join(', ') : '—'}
      </Td>
      <Td
        className="px-3 py-2 font-mono text-[10px]"
        style={{ color: 'var(--text-secondary)' }}
      >
        {cluster.countries ? cluster.countries.split(',').slice(0, 3).join(', ') : '—'}
      </Td>
      <Td
        className="px-3 py-2 text-center font-mono text-[10px]"
        style={{
          color: cluster.attribution_attempted_at
            ? 'var(--sev-high)'
            : 'var(--text-muted)',
        }}
      >
        {cluster.attribution_attempted_at ? 'AI: unknown' : 'never tried'}
      </Td>
      <Td
        className="px-3 py-2 font-mono text-[10px]"
        style={{ color: 'var(--text-tertiary)' }}
      >
        {relTime(cluster.first_detected)}
      </Td>
      <Td
        className="px-3 py-2 font-mono text-[10px]"
        style={{ color: 'var(--text-tertiary)' }}
      >
        {relTime(cluster.last_seen)}
      </Td>
      <Td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-1.5 justify-end">
          <button
            type="button"
            onClick={onTogglePicker}
            aria-expanded={pickerOpen}
            aria-controls={`attribute-picker-${cluster.id}`}
            disabled={busy}
            className="font-mono text-[10px] uppercase tracking-wider px-2.5 py-1 rounded-md transition-colors disabled:opacity-40"
            style={{ color: 'var(--amber)', background: 'rgba(0,0,0,0.30)', border: '1px solid rgba(229,168,50,0.35)' }}
          >
            {pickerOpen ? 'Close' : 'Attribute'}
          </button>
          <button
            type="button"
            onClick={onDismiss}
            disabled={busy}
            className="font-mono text-[10px] uppercase tracking-wider px-2.5 py-1 rounded-md transition-colors disabled:opacity-40"
            style={{ color: 'var(--text-secondary)', background: 'rgba(0,0,0,0.30)', border: '1px solid var(--border-base)' }}
          >
            Dismiss
          </button>
        </div>
      </Td>
    </tr>
  );
}

// Inline actor picker — search threat_actors, click a result to
// attribute the cluster. Rendered as a full-width row directly under
// the cluster it applies to.
function AttributePickerRow({ cluster, onDone }: {
  cluster: BacklogCluster;
  onDone: () => void;
}) {
  const [q, setQ] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const { data: actors = [], isFetching } = useActorSearch(q);
  const attribute = useAttributeCluster();

  const pick = (actor: ActorOption) => {
    const label = cluster.cluster_name || cluster.id.slice(0, 12);
    if (!window.confirm(
      `Attribute cluster "${label}" (${cluster.threat_count.toLocaleString()} threats) to ${actor.name}? ` +
      'The attribution fans out to every threat in the cluster.',
    )) return;
    attribute.mutate({ clusterId: cluster.id, actorId: actor.id }, {
      onSuccess: (d) => {
        setResult(`Attributed to ${d.actor_name} — ${d.threats_fanned_out.toLocaleString()} threats linked.`);
        window.setTimeout(onDone, 1600);
      },
    });
  };

  return (
    <tr id={`attribute-picker-${cluster.id}`}>
      <Td colSpan={8} className="px-4 pb-3 pt-1 text-[12px]">
        <div
          className="rounded-lg p-3 space-y-2"
          style={{ background: 'rgba(0,0,0,0.25)', border: '1px solid var(--border-base)' }}
        >
          <div className="flex items-center gap-2 flex-wrap">
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search threat actors (min 2 chars)…"
              className="max-w-xs"
              autoFocus
            />
            {isFetching && <span className="font-mono text-[10px]" style={{ color: 'var(--text-tertiary)' }}>Searching…</span>}
            {attribute.isPending && <span className="font-mono text-[10px]" style={{ color: 'var(--amber)' }}>Attributing…</span>}
            {attribute.isError && (
              <span className="font-mono text-[10px]" style={{ color: 'var(--sev-critical)' }}>
                {(attribute.error as Error).message}
              </span>
            )}
            {result && <span className="font-mono text-[10px]" style={{ color: 'var(--green)' }}>{result}</span>}
          </div>
          {q.trim().length >= 2 && !result && (
            actors.length === 0 && !isFetching ? (
              <div className="font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>
                No actors match "{q}". Actors are created by the feeds/attributor — check the Explorer → Threat Actors tab.
              </div>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {actors.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => pick(a)}
                    disabled={attribute.isPending}
                    className="font-mono text-[11px] px-2.5 py-1 rounded-md transition-colors disabled:opacity-40"
                    style={{ color: 'var(--text-primary)', background: 'rgba(229,168,50,0.08)', border: '1px solid rgba(229,168,50,0.30)' }}
                  >
                    {a.name}
                    {a.country && <span style={{ color: 'var(--text-tertiary)' }}> · {a.country}</span>}
                  </button>
                ))}
              </div>
            )
          )}
        </div>
      </Td>
    </tr>
  );
}

export function AttributionBacklog() {
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const searchTimer = useRef<number | undefined>(undefined);
  const { data, isLoading, isError, isPlaceholderData, refetch } = useAttributionBacklog({ page, q: debounced });
  const dismiss = useDismissCluster();

  const items = data?.items ?? [];
  const totals = data?.totals;
  // A failed fetch is an error, never "Attributor is keeping up" or 0 tiles.
  // keepPreviousData rows belong to the previous page/search, so they don't
  // count as data on failure.
  const failed = isError && (!data || isPlaceholderData);
  // null = still loading / failed (StatTile shows "—" or "Couldn't load").
  const tile = (n: number | undefined): number | null =>
    totals ? (n ?? 0) : (isLoading || isError ? null : 0);
  const totalPages = Math.max(1, Math.ceil((totals?.unattributed ?? 0) / BACKLOG_PAGE_SIZE));

  const submitSearch = (v: string) => {
    setSearch(v);
    window.clearTimeout(searchTimer.current);
    searchTimer.current = window.setTimeout(() => {
      setDebounced(v.trim());
      setPage(1);
      setPickerFor(null);
    }, 300);
  };

  const doDismiss = (c: BacklogCluster) => {
    const label = c.cluster_name || c.id.slice(0, 12);
    if (!window.confirm(
      `Dismiss cluster "${label}" as unattributable? It leaves this queue (the cluster itself is untouched).`,
    )) return;
    dismiss.mutate(c.id);
  };

  return (
    <div className="animate-fade-in space-y-6">
      <PageHeader
        title="Attribution Backlog"
        subtitle="Infrastructure clusters with no attributed actor — sorted by threat volume."
        className="mb-0"
      />

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <StatTile
          label="Total Clusters"
          value={tile(totals?.total_clusters)}
          error={failed}
        />
        <StatTile
          label="Unattributed"
          value={tile(totals?.unattributed)}
          error={failed}
          sub={
            totals && totals.total_clusters > 0
              ? `${Math.round((totals.unattributed / totals.total_clusters) * 100)}% of all`
              : undefined
          }
        />
        <StatTile
          label="AI Tried, Unknown"
          value={tile(totals?.attempted_unknown)}
          error={failed}
          sub="Sent to Haiku → no match"
        />
        <StatTile
          label="Never Attempted"
          value={tile(totals?.never_attempted)}
          error={failed}
          sub="Skipped by Attributor"
        />
        <StatTile
          label="Dismissed"
          value={tile(totals?.dismissed)}
          error={failed}
          sub="Human: unattributable"
        />
      </div>

      <FilterBar
        search={{ value: search, onChange: submitSearch, placeholder: 'Search name, ASN, or country…' }}
      />

      <Card padding={0} className="overflow-hidden">
        <div className="px-4 py-3 border-b" style={{ borderColor: 'var(--border-base)' }}>
          <div
            className="font-mono text-[10px] uppercase tracking-widest"
            style={{ color: 'var(--text-secondary)' }}
          >
            Page {page} of {totalPages} · sorted by threat count
          </div>
        </div>

        {isError && !failed && (
          <PageState kind="error" layout="inline" className="px-4" title="Couldn't refresh the backlog" description="Showing the last loaded page." onRetry={() => { void refetch(); }} />
        )}

        {failed ? (
          <PageState kind="error" layout="table" title="Couldn't load the attribution backlog" onRetry={() => { void refetch(); }} />
        ) : isLoading && items.length === 0 ? (
          <PageState kind="loading" layout="table" />
        ) : items.length === 0 ? (
          <PageState kind="clear" layout="table" title="No unattributed clusters" description="Attributor is keeping up." />
        ) : (
          <Table label="Unattributed clusters">
            <thead>
              <tr>
                <Th>Cluster</Th>
                <Th className="text-right">Threats</Th>
                <Th>ASNs</Th>
                <Th>Countries</Th>
                <Th className="text-center">Attribution</Th>
                <Th>First seen</Th>
                <Th>Last seen</Th>
                <Th className="text-right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {items.map((c) => (
                <Fragment key={c.id}>
                  <ClusterRow
                    cluster={c}
                    // Pivot to this cluster's operation card on the Campaigns
                    // page (?focus= pre-expands + scrolls to it).
                    onSelect={() => navigate(`/explore?tab=campaigns&focus=${encodeURIComponent(c.id)}`)}
                    pickerOpen={pickerFor === c.id}
                    onTogglePicker={() => setPickerFor(prev => prev === c.id ? null : c.id)}
                    onDismiss={() => doDismiss(c)}
                    busy={dismiss.isPending}
                  />
                  {pickerFor === c.id && (
                    <AttributePickerRow cluster={c} onDone={() => setPickerFor(null)} />
                  )}
                </Fragment>
              ))}
            </tbody>
          </Table>
        )}

        {/* Pagination — unattributed count drives the page total */}
        {(totals?.unattributed ?? 0) > BACKLOG_PAGE_SIZE && (
          <div className="flex items-center justify-between px-4 py-3 border-t" style={{ borderColor: 'var(--border-base)' }}>
            <span className="font-mono text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
              {(totals?.unattributed ?? 0).toLocaleString()} unattributed clusters
            </span>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" disabled={page <= 1} onClick={() => { setPage(p => p - 1); setPickerFor(null); }}>
                ← Prev
              </Button>
              <Button variant="ghost" size="sm" disabled={page >= totalPages} onClick={() => { setPage(p => p + 1); setPickerFor(null); }}>
                Next →
              </Button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
