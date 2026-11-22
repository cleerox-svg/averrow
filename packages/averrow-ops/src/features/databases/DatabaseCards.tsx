// Default "Cards" view: fleet summary strip + one card per database +
// dashed proposed cards. Every nullable value renders an explicit dash.

import { Link } from 'react-router-dom';
import { Badge, StatTile, StatGrid } from '@/design-system/components';
import { tabUrl } from '@/lib/workspaceRoutes';
import type { DatabaseEntry, DatabasesPayload, DbProposed, DbStatus } from '@/hooks/useDatabases';
import {
  DASH, STATUS_LABEL, formatBytes, formatCount, formatPct, formatTimeToFull, hourLabel, peakHour, usedPct,
} from './format';

export function StatusPill({ status }: { status: DbStatus }) {
  const badgeStatus = status === 'healthy' ? 'healthy' : status === 'warning' ? 'warning' : status === 'overloaded' ? 'failed' : 'inactive';
  return <Badge status={badgeStatus} label={STATUS_LABEL[status]} font="sans" size="md" />;
}

export function SummaryStrip({ data }: { data: DatabasesPayload }) {
  const s = data.summary;
  const overloadsKnown = s.overloads_24h != null;
  return (
    <section aria-label="Fleet summary">
      <StatGrid cols={4}>
        <StatTile label="Databases" value={String(s.live)} sub={`live · ${s.proposed} proposed`} />
        <StatTile
          label="Total stored"
          value={formatBytes(s.total_bytes)}
          sub={s.largest_share_pct != null ? `${Math.round(s.largest_share_pct)}% of it in one database` : 'Size not measured yet'}
        />
        <StatTile
          label="Rows read · this cycle"
          value={formatCount(s.cycle_rows_read)}
          sub={s.cycle_pct_of_plan != null ? `${formatPct(s.cycle_pct_of_plan, 1)} of the 25 B plan ceiling` : 'Not measured yet'}
        />
        <StatTile
          label="Overload rejections · 24h"
          value={overloadsKnown ? String(s.overloads_24h) : DASH}
          sub={overloadsKnown ? (s.overloads_24h === 0 ? 'None rejected' : 'D1 refused these statements') : 'Not measured yet'}
          accent={overloadsKnown && (s.overloads_24h ?? 0) > 0 ? 'var(--sev-critical)' : undefined}
        />
      </StatGrid>
    </section>
  );
}

function CapacityBar({ db }: { db: DatabaseEntry }) {
  const pct = usedPct(db.size_bytes, db.cap_bytes);
  return (
    <div>
      <div className="dbp-cap-row">
        <span>Capacity</span>
        <span className="dbp-mono">
          {formatBytes(db.size_bytes)} <span className="dbp-muted">/ {formatBytes(db.cap_bytes)}</span>
        </span>
      </div>
      <div
        className="dbp-bar"
        role="progressbar"
        aria-label={`${db.name} capacity used`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct == null ? undefined : Math.round(pct)}
        aria-valuetext={pct == null ? 'Size not measured yet' : `${Math.round(pct)}% of ${formatBytes(db.cap_bytes)}`}
        style={{ margin: '8px 0' }}
      >
        {pct != null && <div className="dbp-bar-fill" data-tone={db.status} style={{ width: `${Math.min(100, Math.max(pct > 0 ? 0.6 : 0, pct))}%` }} />}
        <div className="dbp-bar-mark" aria-hidden="true" />
      </div>
      <div className="dbp-cap-foot">
        <span>{pct == null ? 'Size not measured yet' : `${pct < 1 ? '<1' : Math.round(pct)}% used · alert at 80%`}</span>
        <span>{formatTimeToFull(db)}</span>
      </div>
    </div>
  );
}

function HourlyReadBars({ db }: { db: DatabaseEntry }) {
  if (db.hourly.length === 0) {
    return <p className="dbp-empty-inline">Hourly reads not measured yet.</p>;
  }
  const max = Math.max(1, ...db.hourly.map((h) => h.rows_read));
  const peak = peakHour(db.hourly);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span className="dbp-muted" style={{ fontSize: 12 }}>Rows read per hour, last {db.hourly.length} h</span>
      <div className="dbp-bars" role="img" aria-label={peak ? `Hourly rows read. Peak ${formatCount(peak.rows_read)} at ${hourLabel(peak.hour)} UTC.` : 'Hourly rows read, none recorded.'}>
        {db.hourly.map((h) => (
          <span key={h.hour} data-bad={(h.overloads ?? 0) > 0} style={{ height: `${Math.max(3, (h.rows_read / max) * 100)}%` }} />
        ))}
      </div>
      <div className="dbp-bars-foot">
        <span>{hourLabel(db.hourly[0]!.hour)}</span>
        <span>{peak ? `peak ${hourLabel(peak.hour)} · ${formatCount(peak.rows_read)}` : ''}</span>
        <span>{hourLabel(db.hourly[db.hourly.length - 1]!.hour)}</span>
      </div>
    </div>
  );
}

export function DatabaseCard({ db }: { db: DatabaseEntry }) {
  const top = db.top_jobs[0];
  const footNote = db.note ?? (top ? `Top user: ${top.source} · ${formatCount(top.rows_read)} rows read` : null);
  const overloadsBad = (db.overloads_24h ?? 0) > 0;
  return (
    <article className="dbp-card" data-status={db.status} aria-label={`${db.name} database`}>
      <div className="dbp-card-head">
        <div>
          <div className="dbp-card-title">
            <h3 className="dbp-name">{db.name}</h3>
            <span className="dbp-role-badge">{db.label}</span>
          </div>
          <p className="dbp-desc">{db.role}</p>
        </div>
        <StatusPill status={db.status} />
      </div>

      <CapacityBar db={db} />

      <div className="dbp-metrics">
        <div className="dbp-metric"><span className="dbp-label">Reads · 6h</span><span className="dbp-metric-v">{formatCount(db.reads_6h)}</span></div>
        <div className="dbp-metric"><span className="dbp-label">Writes · 6h</span><span className="dbp-metric-v">{formatCount(db.writes_6h)}</span></div>
        <div className="dbp-metric">
          <span className="dbp-label">Overloads · 24h</span>
          <span className="dbp-metric-v" data-bad={overloadsBad}>{db.overloads_24h == null ? DASH : db.overloads_24h}</span>
          {db.overloads_24h == null && <span className="dbp-muted" style={{ fontSize: 11 }}>not measured yet</span>}
        </div>
      </div>

      <HourlyReadBars db={db} />

      {db.top_tables.length > 0 && (
        <div>
          <span className="dbp-muted" style={{ fontSize: 12 }}>Largest tables (≈ rows)</span>
          <dl className="dbp-tables" style={{ marginTop: 8 }}>
            {db.top_tables.slice(0, 4).map((t) => (
              <div key={t.name} style={{ display: 'contents' }}>
                <dt>{t.name}</dt>
                <dd>{formatCount(t.rows_estimate)}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      <div className="dbp-card-foot">
        <span>{footNote ?? ''}</span>
        <Link to={tabUrl('databases', { db: db.store })} aria-label={`Open details for ${db.name}`}>Open details →</Link>
      </div>
    </article>
  );
}

export function ProposedCard({ p }: { p: DbProposed }) {
  return (
    <article className="dbp-card" data-proposed="true" aria-label={`${p.name} (proposed)`}>
      <div className="dbp-card-head">
        <div>
          <div className="dbp-card-title">
            <h3 className="dbp-name">{p.name}</h3>
            <span className="dbp-role-badge" data-proposed="true">PROPOSED</span>
          </div>
          <p className="dbp-desc">{p.role}</p>
        </div>
      </div>
      <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{p.description}</p>
      <p className="dbp-muted" style={{ fontSize: 12 }}>Not created yet. No data is stored here.</p>
    </article>
  );
}

export function CardsView({ data }: { data: DatabasesPayload }) {
  return (
    <section className="dbp-grid" aria-label="Databases">
      {data.databases.map((db) => <DatabaseCard key={db.store} db={db} />)}
      {data.proposed.map((p) => <ProposedCard key={p.name} p={p} />)}
    </section>
  );
}
