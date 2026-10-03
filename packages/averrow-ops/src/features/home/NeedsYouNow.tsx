// "Needs you now": the ranked queue on Home. Presentational; the data comes
// from useHomeQueue (role-gated) and the ordering from lib/home-queue.

import { useNavigate } from 'react-router-dom';
import { Badge, Button, Card, PageState } from '@/design-system/components';
import {
  QUEUE_SOURCE_LABEL,
  type HomeQueue,
  type QueueItem,
  type QueueSeverity,
  type QueueSourceId,
} from '@/lib/home-queue';
import { relativeTime } from '@/lib/time';

/** How many ranked rows Home shows; the rest are summarised as "N of M open". */
export const QUEUE_VISIBLE = 5;

const SEV_COLOR: Record<QueueSeverity, string> = {
  critical: 'var(--sev-critical)',
  high: 'var(--sev-high)',
  medium: 'var(--sev-medium)',
  low: 'var(--sev-low)',
};

const SOURCE_CHIP: Record<QueueSourceId, string> = {
  alerts: 'Alerts',
  critical_intel: 'Intel',
  incidents: 'Incidents',
  approvals: 'Approvals',
  takedowns: 'Takedowns',
  agents: 'Agents',
  feeds: 'Feeds',
  attribution: 'Attribution',
  brand_candidates: 'Brands',
};

function QueueRow({ item, rank }: { item: QueueItem; rank: number }) {
  const navigate = useNavigate();
  return (
    <li
      className="queue-row"
      style={{ borderTop: rank === 1 ? 'none' : '1px solid var(--border-base)' }}
      data-queue-source={item.source}
    >
      <span
        aria-hidden
        className="flex h-7 w-7 items-center justify-center rounded-full font-mono text-[11px] font-bold"
        style={{
          color: SEV_COLOR[item.severity],
          border: `1px solid ${SEV_COLOR[item.severity]}`,
        }}
      >
        {rank}
      </span>
      <div className="min-w-0">
        <div className="text-sm font-semibold leading-snug" style={{ color: 'var(--text-primary)' }}>
          {item.title}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <Badge severity={item.severity} size="xs" />
          <span className="font-mono text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>
            {SOURCE_CHIP[item.source]}
          </span>
          {item.ts && (
            <span className="font-mono text-[10px]" style={{ color: 'var(--text-secondary)' }}>
              {relativeTime(item.ts)}
            </span>
          )}
        </div>
        <div className="mt-1 text-xs leading-snug" style={{ color: 'var(--text-secondary)' }}>{item.detail}</div>
      </div>
      <div className="queue-act">
        <Button
          variant={rank === 1 ? 'primary' : 'secondary'}
          size="sm"
          onClick={() => navigate(item.action.to)}
          aria-label={`${item.action.label}: ${item.title}`}
        >
          {item.action.label}
        </Button>
      </div>
    </li>
  );
}

function FailedRow({ id, onRetry }: { id: QueueSourceId; onRetry: (id: QueueSourceId) => void }) {
  const label = QUEUE_SOURCE_LABEL[id];
  return (
    <li
      className="flex items-center justify-between gap-3 py-3"
      style={{ borderTop: '1px solid var(--border-base)' }}
      data-queue-failed={id}
    >
      <div className="min-w-0" role="alert">
        <div className="text-sm font-semibold" style={{ color: 'var(--sev-critical-text)' }}>
          Couldn't check {label}
        </div>
        <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>
          This is not an all-clear. Anything waiting in {label} is not shown above.
        </div>
      </div>
      <Button variant="secondary" size="sm" onClick={() => onRetry(id)} aria-label={`Retry ${label}`}>
        Retry
      </Button>
    </li>
  );
}

export function NeedsYouNow({ queue, onRetry }: { queue: HomeQueue; onRetry: (id: QueueSourceId) => void }) {
  const { items, failed, loading, enabled, clear } = queue;
  const visible = items.slice(0, QUEUE_VISIBLE);

  return (
    <Card padding="lg" role="region" aria-labelledby="home-queue-title">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2
          id="home-queue-title"
          className="font-mono text-[10px] font-bold uppercase tracking-[0.18em]"
          style={{ color: 'var(--text-secondary)', margin: 0 }}
        >
          Needs you now
        </h2>
        {items.length > 0 && (
          <span className="font-mono text-[10px]" style={{ color: 'var(--text-secondary)' }}>
            {visible.length} of {items.length} open
          </span>
        )}
      </div>

      {enabled === 0 && (
        <PageState kind="locked" layout="inline" compact title="No queue for your role" />
      )}

      {visible.length > 0 && (
        <ol className="m-0 list-none p-0" aria-label="Ranked items needing attention">
          {visible.map((item, i) => <QueueRow key={item.id} item={item} rank={i + 1} />)}
        </ol>
      )}

      {failed.length > 0 && (
        <ul className="m-0 list-none p-0" aria-label="Sources that could not be checked">
          {failed.map((id) => <FailedRow key={id} id={id} onRetry={onRetry} />)}
        </ul>
      )}

      {enabled > 0 && loading.length > 0 && visible.length === 0 && failed.length === 0 && (
        <PageState kind="loading" layout="inline" compact title="Checking what needs you…" />
      )}

      {clear && (
        <PageState kind="clear" layout="inline" compact title="Nothing needs you right now" description="Every source was checked and none has anything open." />
      )}
    </Card>
  );
}
