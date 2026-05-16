// Attribution Backlog admin queue — PR-B from the 2026-05-16 audit.
//
// Surfaces infrastructure_clusters with no actor_id, sorted by
// threat_count. Audit finding #6: 2,334 of 2,483 clusters (94%)
// have no actor_id. Attributor tried 1,330 of them via Haiku and
// got "unknown" for 1,325 (0.4% resolution). These are large piles
// of evidence sitting unattributed — a human triage queue.
//
// Read-only in this PR: the operator can see the list and drill
// into the cluster page. Manual-attribution actions ship in a
// follow-up.

import { useAttributionBacklog } from '@/hooks/useAttributionBacklog';
import type { BacklogCluster } from '@/hooks/useAttributionBacklog';
import { useNavigate } from 'react-router-dom';

const GLASS_CARD: React.CSSProperties = {
  background: 'rgba(15,23,42,0.50)',
  backdropFilter: 'blur(12px)',
  WebkitBackdropFilter: 'blur(12px)',
  border: '1px solid var(--border-base)',
  borderRadius: '0.75rem',
  boxShadow: '0 4px 24px rgba(0,0,0,0.4), inset 0 1px 0 var(--border-base)',
};

function StatCard({ title, value, subtext }: {
  title: string;
  value: number | string;
  subtext?: string;
}) {
  return (
    <div className="p-4" style={GLASS_CARD}>
      <div
        className="font-mono text-[9px] uppercase tracking-widest mb-2"
        style={{ color: 'var(--text-secondary)' }}
      >
        {title}
      </div>
      <div
        className="font-mono text-[28px] font-bold leading-none"
        style={{ color: 'var(--text-primary)' }}
      >
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
      {subtext && (
        <div
          className="font-mono text-[10px] mt-1"
          style={{ color: 'var(--text-tertiary)' }}
        >
          {subtext}
        </div>
      )}
    </div>
  );
}

function relTime(iso: string | null): string {
  if (!iso) return '—';
  const t = iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z';
  const diffMs = Date.now() - new Date(t).getTime();
  const days = Math.floor(diffMs / 86_400_000);
  if (days < 1) return 'today';
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function ClusterRow({
  cluster,
  onSelect,
}: {
  cluster: BacklogCluster;
  onSelect: () => void;
}) {
  return (
    <tr
      onClick={onSelect}
      className="border-b cursor-pointer transition-colors"
      style={{ borderColor: 'var(--border-base)' }}
    >
      <td className="px-3 py-2 font-mono text-[11px]" style={{ color: 'var(--text-primary)' }}>
        {cluster.cluster_name || cluster.id.slice(0, 12)}
      </td>
      <td
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
      </td>
      <td
        className="px-3 py-2 font-mono text-[10px]"
        style={{ color: 'var(--text-secondary)' }}
      >
        {cluster.asns ? cluster.asns.split(',').slice(0, 2).join(', ') : '—'}
      </td>
      <td
        className="px-3 py-2 font-mono text-[10px]"
        style={{ color: 'var(--text-secondary)' }}
      >
        {cluster.countries ? cluster.countries.split(',').slice(0, 3).join(', ') : '—'}
      </td>
      <td
        className="px-3 py-2 text-center font-mono text-[10px]"
        style={{
          color: cluster.attribution_attempted_at
            ? 'var(--sev-high)'
            : 'var(--text-muted)',
        }}
      >
        {cluster.attribution_attempted_at ? 'AI: unknown' : 'never tried'}
      </td>
      <td
        className="px-3 py-2 font-mono text-[10px]"
        style={{ color: 'var(--text-tertiary)' }}
      >
        {relTime(cluster.first_detected)}
      </td>
      <td
        className="px-3 py-2 font-mono text-[10px]"
        style={{ color: 'var(--text-tertiary)' }}
      >
        {relTime(cluster.last_seen)}
      </td>
    </tr>
  );
}

export function AttributionBacklog() {
  const navigate = useNavigate();
  const { data, isLoading } = useAttributionBacklog(50);

  const items = data?.items ?? [];
  const totals = data?.totals;

  return (
    <div className="animate-fade-in space-y-6">
      <div>
        <h1
          className="text-xl font-bold font-display"
          style={{ color: 'var(--text-primary)' }}
        >
          Attribution Backlog
        </h1>
        <p
          className="text-sm font-mono mt-1"
          style={{ color: 'var(--text-tertiary)' }}
        >
          Infrastructure clusters with no attributed actor — sorted by threat volume.
        </p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          title="Total Clusters"
          value={totals?.total_clusters ?? 0}
        />
        <StatCard
          title="Unattributed"
          value={totals?.unattributed ?? 0}
          subtext={
            totals && totals.total_clusters > 0
              ? `${Math.round((totals.unattributed / totals.total_clusters) * 100)}% of all`
              : undefined
          }
        />
        <StatCard
          title="AI Tried, Unknown"
          value={totals?.attempted_unknown ?? 0}
          subtext="Sent to Haiku → no match"
        />
        <StatCard
          title="Never Attempted"
          value={totals?.never_attempted ?? 0}
          subtext="Skipped by Attributor"
        />
      </div>

      <div style={GLASS_CARD} className="overflow-hidden">
        <div className="px-4 py-3 border-b" style={{ borderColor: 'var(--border-base)' }}>
          <div
            className="font-mono text-[10px] uppercase tracking-widest"
            style={{ color: 'var(--text-secondary)' }}
          >
            Top {items.length} clusters by threat count
          </div>
        </div>

        {isLoading && items.length === 0 ? (
          <div className="p-6 font-mono text-[11px]" style={{ color: 'var(--text-muted)' }}>
            Loading…
          </div>
        ) : items.length === 0 ? (
          <div className="p-6 font-mono text-[11px]" style={{ color: 'var(--text-muted)' }}>
            No unattributed clusters — Attributor is keeping up.
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr
                className="border-b"
                style={{ borderColor: 'var(--border-base)' }}
              >
                <th
                  className="px-3 py-2 text-left font-mono text-[9px] uppercase tracking-widest"
                  style={{ color: 'var(--text-tertiary)' }}
                >
                  Cluster
                </th>
                <th
                  className="px-3 py-2 text-right font-mono text-[9px] uppercase tracking-widest"
                  style={{ color: 'var(--text-tertiary)' }}
                >
                  Threats
                </th>
                <th
                  className="px-3 py-2 text-left font-mono text-[9px] uppercase tracking-widest"
                  style={{ color: 'var(--text-tertiary)' }}
                >
                  ASNs
                </th>
                <th
                  className="px-3 py-2 text-left font-mono text-[9px] uppercase tracking-widest"
                  style={{ color: 'var(--text-tertiary)' }}
                >
                  Countries
                </th>
                <th
                  className="px-3 py-2 text-center font-mono text-[9px] uppercase tracking-widest"
                  style={{ color: 'var(--text-tertiary)' }}
                >
                  Attribution
                </th>
                <th
                  className="px-3 py-2 text-left font-mono text-[9px] uppercase tracking-widest"
                  style={{ color: 'var(--text-tertiary)' }}
                >
                  First seen
                </th>
                <th
                  className="px-3 py-2 text-left font-mono text-[9px] uppercase tracking-widest"
                  style={{ color: 'var(--text-tertiary)' }}
                >
                  Last seen
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((c) => (
                <ClusterRow
                  key={c.id}
                  cluster={c}
                  onSelect={() => navigate(`/operations/${encodeURIComponent(c.id)}`)}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
