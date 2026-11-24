// Per-store detail: KPIs, capacity + projection, overloads per hour, largest
// tables and the jobs using this database in the selected window.

import { Link } from 'react-router-dom';
import { StatTile, StatGrid } from '@/design-system/components';
import { tabUrl } from '@/lib/workspaceRoutes';
import type { DatabaseEntry, DatabasesSummary, DbWindow } from '@/hooks/useDatabases';
import { StatusPill, windowParam } from './DatabaseCards';
import {
  DASH, KIND_LABEL, OVERLOADS_SCOPE_DEFAULT, WINDOW_LABEL, formatBytes, formatCount, formatPct, formatTimeToFull, hourLabel,
  cycleTrend, cycleTrendChip, cycleTrendLabel, cycleTrendTone,
  overCap, thresholdText, thresholds, usedPct,
} from './format';

const DAY = 86_400_000;

interface Pt { t: number; v: number }

export function projectionPoints(db: DatabaseEntry): { history: Pt[]; projection: Pt[] } {
  const history = db.size_history
    .map((p) => ({ t: Date.parse(p.date), v: p.bytes }))
    .filter((p) => Number.isFinite(p.t))
    .sort((a, b) => a.t - b.t);
  const last = history[history.length - 1];
  const g = db.growth_bytes_per_day;
  if (!last || g == null || g <= 0 || last.v >= db.cap_bytes) return { history, projection: [] };
  const toCap = (db.cap_bytes - last.v) / g;
  const days = Math.min(Math.max(toCap, 14), 730);
  const endV = Math.min(db.cap_bytes, last.v + g * days);
  return { history, projection: [last, { t: last.t + days * DAY, v: endV }] };
}

function CapacityChart({ db, th }: { db: DatabaseEntry; th: { warn: number; critical: number } }) {
  const { history, projection } = projectionPoints(db);
  if (history.length < 2) {
    return <p className="dbp-empty-inline">Not enough size history yet. The chart appears after a few daily samples.</p>;
  }
  const W = 600, H = 240, L = 54, R = 16, T = 14, B = 30;
  const all = [...history, ...projection];
  const t0 = all[0]!.t;
  const t1 = all[all.length - 1]!.t;
  const x = (t: number) => L + ((t - t0) / Math.max(1, t1 - t0)) * (W - L - R);
  const y = (v: number) => T + (1 - v / (db.cap_bytes * 1.04)) * (H - T - B);
  const path = (pts: Pt[]) => pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const fmtDate = (t: number) => new Date(t).toISOString().slice(0, 10);
  const first = history[0]!;
  const lastPt = history[history.length - 1]!;
  const over = overCap(db);
  const reach = projection.length && projection[1]!.v >= db.cap_bytes ? fmtDate(projection[1]!.t) : null;
  const label = `Database size grew from ${formatBytes(first.v)} on ${fmtDate(first.t)} to ${formatBytes(lastPt.v)} on ${fmtDate(lastPt.t)}.${over ? ' The database is at or over the cap.' : reach ? ` At this pace it reaches ${formatBytes(db.cap_bytes)} around ${reach}.` : ''}`;
  return (
    <svg className="dbp-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
      <line className="axis" x1={L} x2={W - R} y1={H - B} y2={H - B} />
      <line className="axis" x1={L} x2={L} y1={T} y2={H - B} />
      <line className="cap" x1={L} x2={W - R} y1={y(db.cap_bytes)} y2={y(db.cap_bytes)} />
      <line className="warn" x1={L} x2={W - R} y1={y(db.cap_bytes * th.warn)} y2={y(db.cap_bytes * th.warn)} />
      <line className="warn" x1={L} x2={W - R} y1={y(db.cap_bytes * th.critical)} y2={y(db.cap_bytes * th.critical)} />
      <text x={L - 6} y={y(db.cap_bytes) + 4} textAnchor="end">{formatBytes(db.cap_bytes)}</text>
      <text x={L - 6} y={y(db.cap_bytes * th.critical) + 4} textAnchor="end">{Math.round(th.critical * 100)}%</text>
      <text x={L - 6} y={y(db.cap_bytes * th.warn) + 4} textAnchor="end">{Math.round(th.warn * 100)}%</text>
      <text x={L - 6} y={H - B + 4} textAnchor="end">0</text>
      <path className="line" d={path(history)} />
      {projection.length > 0 && <path className="proj" d={path(projection)} />}
      <circle cx={x(lastPt.t)} cy={y(lastPt.v)} r={3.5} fill="var(--primary)" />
      <text x={L} y={H - 8}>{fmtDate(t0)}</text>
      <text x={x(lastPt.t)} y={H - 8} textAnchor="middle">{fmtDate(lastPt.t)}</text>
      {reach && <text x={W - R} y={H - 8} textAnchor="end">{reach}</text>}
    </svg>
  );
}

function OverloadsChart({ db }: { db: DatabaseEntry }) {
  const hrs = db.hourly;
  const measured = hrs.filter((h) => h.overloads != null);
  if (hrs.length === 0 || measured.length === 0) {
    return <p className="dbp-empty-inline">Overloads not measured yet for this database. Per-database metering has no data so far.</p>;
  }
  const max = Math.max(1, ...measured.map((h) => h.overloads ?? 0));
  const total = measured.reduce((a, h) => a + (h.overloads ?? 0), 0);
  return (
    <>
      <div className="dbp-hbars" role="img" aria-label={`${total} overload rejections over the last ${hrs.length} hours. Peak ${max} in one hour.`}>
        {hrs.map((h) => {
          const v = h.overloads;
          return (
            <span
              key={h.hour}
              title={`${hourLabel(h.hour)} UTC: ${v == null ? 'not measured' : `${v} overloads`}`}
              data-tone={v == null || v === 0 ? 'none' : v >= 5 ? 'many' : 'some'}
              style={{ height: `${v == null ? 2 : Math.max(2, (v / max) * 100)}%`, opacity: v == null ? 0.4 : 1 }}
            />
          );
        })}
      </div>
      <div className="dbp-bars-foot">
        <span>{hourLabel(hrs[0]!.hour)}</span>
        <span>{total === 0 ? 'No rejections' : `${total} in ${hrs.length} h`}</span>
        <span>{hourLabel(hrs[hrs.length - 1]!.hour)}</span>
      </div>
    </>
  );
}

export function DatabaseDetail({ db, window: win = '24h', summary, generatedAt }: { db: DatabaseEntry; window?: DbWindow; summary?: DatabasesSummary; generatedAt?: string }) {
  const th = thresholds(summary);
  const readTrend = generatedAt ? cycleTrend(db.reads_cycle, db.hourly, 'rows_read', summary?.cycle?.start, generatedAt) : null;
  const writeTrend = generatedAt ? cycleTrend(db.writes_cycle, db.hourly, 'rows_written', summary?.cycle?.start, generatedAt) : null;
  const over = overCap(db);
  const pct = usedPct(db.size_bytes, db.cap_bytes);
  const growth = db.growth_bytes_per_day;
  const to80 = db.size_bytes != null && growth != null && growth > 0 && db.size_bytes < db.cap_bytes * th.critical
    ? Math.round((db.cap_bytes * th.critical - db.size_bytes) / growth)
    : null;
  const maxJob = Math.max(1, ...db.top_jobs.map((j) => j.rows_read));
  const hasBytes = db.top_tables.some((t) => t.bytes != null);

  return (
    <div className="dbp">
      <Link className="dbp-back" to={tabUrl('databases', { window: windowParam(win) })}>← All databases</Link>

      <section className="dbp-detail-head" aria-label="Database summary">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div className="dbp-detail-title">
            <h2>{db.name}</h2>
            <StatusPill status={db.status} />
          </div>
          <p className="dbp-sub">
            {db.role} · binding <span className="dbp-mono">{db.binding}</span>
            {db.tables != null && <> · {db.tables} tables</>}
            {db.size_source && <> · size from {db.size_source === 'cf_api' ? 'Cloudflare API' : 'database pragma'}</>}
          </p>
          {db.status_reasons.length > 0 && (
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: 'var(--text-secondary)' }}>
              {db.status_reasons.map((r) => <li key={r}>{r}</li>)}
            </ul>
          )}
          {db.note && <p className="dbp-muted" style={{ fontSize: 13 }}>{db.note}</p>}
        </div>
        <Link to={tabUrl('databases', { view: 'map', window: windowParam(win) })}>View connections</Link>
      </section>

      <section aria-label="Key figures" className="dbp-kpis-wrap">
        <StatGrid cols={4}>
          <StatTile label="Size" value={formatBytes(db.size_bytes)} sub={pct == null ? 'Not measured yet' : `${formatPct(pct, 0)} of ${formatBytes(db.cap_bytes)} limit`} />
          <StatTile label="Time to full" value={over ? 'At cap' : db.days_to_cap != null && growth != null && growth > 0 ? formatTimeToFull(db).replace(' to full', '').replace(' months', ' mo').replace(' days', ' d').replace(' years', ' yr') : DASH} sub={over ? 'At or over the cap' : to80 != null ? `critical (${Math.round(th.critical * 100)}%) in ≈ ${to80} days` : formatTimeToFull(db)} />
          <StatTile
            label="Reads · cycle"
            value={formatCount(db.reads_cycle)}
            sub={readTrend ? `24h ≈ ${formatCount(readTrend.last24h)} · earlier avg ${formatCount(readTrend.dailyAvg)}/day` : `24h ${formatCount(db.reads_24h)}`}
            delta={readTrend ? { value: cycleTrendChip(readTrend), tone: cycleTrendTone(readTrend, 'rows_read'), label: cycleTrendLabel(readTrend, 'rows read') } : undefined}
          />
          <StatTile
            label="Writes · cycle"
            value={formatCount(db.writes_cycle)}
            sub={writeTrend ? `24h ≈ ${formatCount(writeTrend.last24h)} · earlier avg ${formatCount(writeTrend.dailyAvg)}/day` : `24h ${formatCount(db.writes_24h)}`}
            delta={writeTrend ? { value: cycleTrendChip(writeTrend), tone: cycleTrendTone(writeTrend, 'rows_written'), label: cycleTrendLabel(writeTrend, 'rows written') } : undefined}
          />
          <StatTile
            label="Overloads · 24h"
            value={db.overloads_24h == null ? DASH : String(db.overloads_24h)}
            sub={db.overloads_24h == null ? 'Not measured yet' : OVERLOADS_SCOPE_DEFAULT}
            accent={(db.overloads_24h ?? 0) > 0 ? 'var(--sev-critical)' : undefined}
          />
        </StatGrid>
      </section>

      <section className="dbp-two">
        <article className="dbp-art">
          <h3>Capacity and projection</h3>
          <CapacityChart db={db} th={th} />
          <p className="dbp-muted" style={{ fontSize: 12 }}>
            Straight-line from the size history; dashed line is the projection to the limit. {thresholdText(th)}.
            {growth != null ? ` Growth ${formatBytes(growth)} per day.` : ''}
          </p>
        </article>
        <article className="dbp-art">
          <h3>Overload rejections per hour · last 24 h <span className="dbp-muted" style={{ fontWeight: 400 }}>(metered jobs)</span></h3>
          <OverloadsChart db={db} />
        </article>
      </section>

      <section className="dbp-two">
        <article className="dbp-art">
          <h3>Largest tables</h3>
          {db.top_tables.length === 0 ? (
            <p className="dbp-empty-inline">Table sizes not measured yet.</p>
          ) : (
            <div className="dbp-tablewrap">
              <table className="dbp-table">
                <thead>
                  <tr>
                    <th scope="col">Table</th>
                    <th scope="col" className="num">≈ rows</th>
                    {hasBytes && <th scope="col" className="num">Size</th>}
                  </tr>
                </thead>
                <tbody>
                  {db.top_tables.map((t) => (
                    <tr key={t.name}>
                      <td className="dbp-mono">{t.name}</td>
                      <td className="num">
                        {formatCount(t.rows_estimate)}
                        {t.estimate_divergent && <span className="dbp-muted" title="The row estimate disagrees with another source"> *</span>}
                      </td>
                      {hasBytes && <td className="num">{formatBytes(t.bytes)}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {db.top_tables.some((t) => t.estimate_divergent) && (
            <p className="dbp-muted" style={{ fontSize: 12 }}>* Row estimate disagrees with another source; treat as approximate.</p>
          )}
        </article>

        <article className="dbp-art">
          <h3>Top jobs · {WINDOW_LABEL[win].toLowerCase()}</h3>
          {db.top_jobs.length === 0 ? (
            <p className="dbp-empty-inline">No per-job reads recorded for this database in this window.</p>
          ) : (
            <div className="dbp-jobs">
              {db.top_jobs.map((j) => (
                <div className="dbp-job" key={`${j.kind}:${j.source}`}>
                  <span title={KIND_LABEL[j.kind]}>{j.source}</span>
                  <div className="dbp-job-track" aria-hidden="true">
                    <div className="dbp-job-fill" data-bad={(j.overloads ?? 0) > 0} style={{ width: `${(j.rows_read / maxJob) * 100}%` }} />
                  </div>
                  <span className="dbp-mono" style={{ fontSize: 12 }}>
                    {formatCount(j.rows_read)} read{(j.overloads ?? 0) > 0 ? ` · ${j.overloads} overloads` : ''}
                  </span>
                </div>
              ))}
            </div>
          )}
        </article>
      </section>
    </div>
  );
}
