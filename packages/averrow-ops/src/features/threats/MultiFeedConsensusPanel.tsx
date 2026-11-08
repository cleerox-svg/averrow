import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown } from 'lucide-react';
import { Badge, Card, PageState } from '@/design-system/components';
import { relativeTime } from '@/lib/time';
import { tabUrl } from '@/lib/workspaceRoutes';
import { PanelHeader } from './PanelHeader';
import { THREATS_CARD_VARIANT } from './threatsCard';
import './threats.css';
import { useMultiFeedConsensus } from '@/hooks/useMultiFeedConsensus';

const COLLAPSED_ROWS = 5;

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/**
 * Multi-feed consensus — IPs flagged by 4+ independent feeds. Each row links to
 * the Threats list filtered to that IP (the table's `q` search matches IPs).
 * Staff-only by construction (Console / requireStaff route).
 */
export function MultiFeedConsensusPanel() {
  const [open, setOpen] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const { data, isLoading, isError, refetch } = useMultiFeedConsensus();
  const rows = data ?? [];
  const visible = showAll ? rows : rows.slice(0, COLLAPSED_ROWS);

  return (
    <Card variant={THREATS_CARD_VARIANT}>
      <PanelHeader title="Corroboration" subtitle="IPs flagged by 4+ independent feeds" />
      <h3 className="mt-2">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-controls="multi-feed-consensus-body"
          className="ds-focusable thr-toggle"
        >
          <span>Multi-feed consensus{data ? <span className="thr-num"> ({rows.length})</span> : ''}</span>
          <ChevronDown
            size={14}
            aria-hidden="true"
            className="thr-toggle-chevron"
            style={{ transform: open ? 'rotate(180deg)' : 'none' }}
          />
        </button>
      </h3>

      <div id="multi-feed-consensus-body" className="mt-2" hidden={!open}>
        {open && (<>
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
            <ul id="multi-feed-consensus-list" className="space-y-1.5" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {visible.map((r) => (
                <li key={r.ip_address}>
                  <Link
                    to={tabUrl('threats', { q: r.ip_address })}
                    state={{ focusTable: true }}
                    className="thr-row"
                    data-bordered="true"
                  >
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <span className="text-xs font-mono font-semibold break-all" style={{ color: 'var(--text-primary)' }}>
                        {r.ip_address}
                      </span>
                      <span className="thr-label thr-num thr-label--secondary">
                        {plural(r.threat_count, 'threat')} · {plural(r.brand_count, 'brand')} · {r.last_seen ? `newest threat ${relativeTime(r.last_seen)}` : 'newest threat —'}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center gap-1 flex-wrap">
                      <span
                        className="thr-label thr-num mr-1"
                        style={{ color: 'var(--primary-text)', fontWeight: 600 }}
                      >
                        {plural(r.feed_count, 'feed')}
                      </span>
                      {r.feeds.map((f) => (
                        <Badge key={f} label={f} size="md" font="sans" />
                      ))}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {rows.length > COLLAPSED_ROWS && (
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              aria-expanded={showAll}
              aria-controls="multi-feed-consensus-list"
              className="ds-focusable thr-more"
            >
              {showAll ? 'Show fewer' : `Show all (${rows.length})`}
            </button>
          )}
        </>)}
      </div>
    </Card>
  );
}
