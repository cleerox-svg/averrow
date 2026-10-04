import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown } from 'lucide-react';
import { Badge, Card, PageState } from '@/design-system/components';
import { SectionLabel } from '@/components/ui/SectionLabel';
import { relativeTime } from '@/lib/time';
import { tabUrl } from '@/lib/workspaceRoutes';
import { useMultiFeedConsensus } from '@/hooks/useMultiFeedConsensus';

/**
 * Multi-feed consensus — IPs flagged by 4+ independent feeds. Each row links to
 * the Threats list filtered to that IP (the table's `q` search matches IPs).
 * Staff-only by construction (Console / requireStaff route).
 */
export function MultiFeedConsensusPanel() {
  const [open, setOpen] = useState(true);
  const { data, isLoading, isError, refetch } = useMultiFeedConsensus();
  const rows = data ?? [];

  return (
    <Card>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls="multi-feed-consensus-body"
        className="w-full flex items-center justify-between gap-2 text-left"
        style={{ background: 'none', border: 0, cursor: 'pointer', padding: 0 }}
      >
        <SectionLabel>Multi-feed consensus{data ? ` (${rows.length})` : ''}</SectionLabel>
        <ChevronDown
          size={14}
          style={{
            color: 'var(--text-tertiary)',
            transform: open ? 'rotate(180deg)' : 'none',
            transition: 'transform 0.15s',
          }}
        />
      </button>

      {open && (
        <div id="multi-feed-consensus-body" className="mt-2">
          {isError && !data ? (
            <PageState
              kind="error"
              layout="inline"
              assertive
              title="Couldn't load multi-feed consensus"
              onRetry={() => { void refetch(); }}
            />
          ) : isLoading ? (
            <PageState kind="loading" layout="inline" title="Loading multi-feed consensus" />
          ) : rows.length === 0 ? (
            <PageState
              kind="empty"
              layout="inline"
              title="No IPs flagged by 4+ feeds"
              description="Independent feeds currently agree on no single IP."
            />
          ) : (
            <ul className="space-y-1.5" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {rows.map((r) => (
                <li key={r.ip_address}>
                  <Link
                    to={tabUrl('threats', { q: r.ip_address })}
                    className="block hover:bg-white/[0.03] transition-colors"
                    style={{
                      padding: '8px 10px', borderRadius: 5, textDecoration: 'none',
                      border: '1px solid var(--border-base)', background: 'var(--bg-input)',
                    }}
                  >
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <span className="text-xs font-mono font-semibold break-all" style={{ color: 'var(--text-primary)' }}>
                        {r.ip_address}
                      </span>
                      <span className="text-[10px] font-mono" style={{ color: 'var(--text-tertiary)' }}>
                        {r.threat_count} threats · {r.brand_count} brands · {r.last_seen ? relativeTime(r.last_seen) : '—'}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center gap-1 flex-wrap">
                      <span
                        className="text-[10px] font-mono font-bold mr-1"
                        style={{ color: 'var(--amber)' }}
                      >
                        {r.feed_count} feeds
                      </span>
                      {r.feeds.map((f) => (
                        <Badge key={f} label={f} size="xs" />
                      ))}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}
