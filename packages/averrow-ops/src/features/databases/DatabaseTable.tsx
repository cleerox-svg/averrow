// Accessible table of the same data as the cards.

import { Link } from 'react-router-dom';
import { tabUrl } from '@/lib/workspaceRoutes';
import type { DatabasesPayload } from '@/hooks/useDatabases';
import { StatusPill } from './DatabaseCards';
import { DASH, formatBytes, formatCount, formatPct, formatTimeToFull, usedPct } from './format';

export function DatabaseTable({ data }: { data: DatabasesPayload }) {
  return (
    <div className="dbp-tablewrap">
      <table className="dbp-table">
        <caption>All databases. Rows read and written are for the billing cycle; dashes mean not measured yet.</caption>
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
            <th scope="col" className="num">Overloads · 24h</th>
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
              <td className="num">{formatCount(db.reads_cycle)}</td>
              <td className="num">{formatCount(db.writes_cycle)}</td>
              <td className="num">{db.overloads_24h == null ? DASH : db.overloads_24h}</td>
              <td><Link to={tabUrl('databases', { db: db.store })} aria-label={`Open details for ${db.name}`}>Details →</Link></td>
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
