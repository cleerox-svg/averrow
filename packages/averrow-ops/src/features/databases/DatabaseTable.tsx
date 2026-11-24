// Accessible table of the same data as the cards.

import { Link } from 'react-router-dom';
import { tabUrl } from '@/lib/workspaceRoutes';
import type { DatabaseEntry, DatabasesPayload, DbWindow } from '@/hooks/useDatabases';
import { StatusPill, windowParam } from './DatabaseCards';
import {
  DASH, cycleTrend, cycleTrendChip, cycleTrendLabel, formatBytes, formatCount, formatPct, formatTimeToFull, usedPct,
} from './format';

/** Cycle total, with the last 24 h compared against the cycle's average day underneath. */
function CycleCell({ total, hourly, field, what, cycleStart, now }: {
  total: number | null; hourly: DatabaseEntry['hourly']; field: 'rows_read' | 'rows_written'; what: string; cycleStart?: string; now: string;
}) {
  const t = cycleTrend(total, hourly, field, cycleStart, now);
  return (
    <td className="num">
      {formatCount(total)}
      {t && (
        <span className="dbp-trend" data-direction={t.direction}>
          <span aria-hidden="true">{cycleTrendChip(t)} · 24h {formatCount(t.last24h)}</span>
          <span className="sr-only">{cycleTrendLabel(t, what)}</span>
        </span>
      )}
    </td>
  );
}

export function DatabaseTable({ data, window: win = '24h' }: { data: DatabasesPayload; window?: DbWindow }) {
  return (
    <div className="dbp-tablewrap">
      <table className="dbp-table">
        <caption>
          All databases. Rows read and written are totals for the billing cycle{cycleSince(data.summary.cycle?.start)}; the line under each
          compares the last 24 h with the cycle&apos;s earlier average day (red above, green below). Dashes mean not measured yet.
        </caption>
        <thead>
          <tr>
            <th scope="col">Database</th>
            <th scope="col">Role</th>
            <th scope="col">Status</th>
            <th scope="col" className="num">Size</th>
            <th scope="col" className="num">Used</th>
            <th scope="col">Time to full</th>
            <th scope="col" className="num">Reads · cycle</th>
            <th scope="col" className="num">Writes · cycle</th>
            <th scope="col" className="num">Overloads · 24h <span className="dbp-muted">(metered jobs)</span></th>
            <th scope="col"><span className="sr-only">Details</span></th>
          </tr>
        </thead>
        <tbody>
          {data.databases.map((db) => (
            <tr key={db.store}>
              <th scope="row" className="dbp-mono" style={{ textAlign: 'left', textTransform: 'none', letterSpacing: 0, fontSize: 13, color: 'var(--text-primary)', fontWeight: 500 }}>{db.name}</th>
              <td>{db.label}</td>
              <td><StatusPill status={db.status} /></td>
              <td className="num">{formatBytes(db.size_bytes)}</td>
              <td className="num">{formatPct(usedPct(db.size_bytes, db.cap_bytes), 0)}</td>
              <td>{db.size_bytes == null ? DASH : formatTimeToFull(db)}</td>
              <CycleCell total={db.reads_cycle} hourly={db.hourly} field="rows_read" what="rows read" cycleStart={data.summary.cycle?.start} now={data.generated_at} />
              <CycleCell total={db.writes_cycle} hourly={db.hourly} field="rows_written" what="rows written" cycleStart={data.summary.cycle?.start} now={data.generated_at} />
              <td className="num">{db.overloads_24h == null ? DASH : db.overloads_24h}</td>
              <td><Link to={tabUrl('databases', { db: db.store, window: windowParam(win) })} aria-label={`Open details for ${db.name}`}>Details →</Link></td>
            </tr>
          ))}
          {data.proposed.map((p) => (
            <tr key={p.name}>
              <th scope="row" className="dbp-mono" style={{ textAlign: 'left', textTransform: 'none', letterSpacing: 0, fontSize: 13, color: 'var(--text-tertiary)', fontWeight: 500 }}>{p.name}</th>
              <td colSpan={9} className="dbp-muted">Proposed · {p.role}. {p.description}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * " (since Nov 18)", or "" when the payload has no cycle window. Formatted in
 * UTC on purpose: the cycle starts at 00:00 UTC, so a local-time formatter
 * (e.g. `formatDate` in `@/lib/time`) would say "Nov 17" in the Americas.
 */
function cycleSince(start: string | undefined): string {
  if (!start) return '';
  const d = new Date(start);
  if (Number.isNaN(d.getTime())) return '';
  return ` (since ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })})`;
}
