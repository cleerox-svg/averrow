// "Map" view: bipartite jobs -> databases diagram built from `edges`.
// SVG with theme tokens only (no canvas, no agent-specific model). Line width
// is proportional to rows read, red when the job ran during overload
// rejections, dashed when it read nothing. A table below is the accessible
// equivalent of the picture and also selects edges.

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { tabUrl } from '@/lib/workspaceRoutes';
import type { DatabaseEntry, DatabasesPayload, DbEdge, DbWindow } from '@/hooks/useDatabases';
import {
  DASH, KIND_LABEL, STORE_ORDER, WINDOW_LABEL, edgeId, formatBytes, formatCount, sourceNodes,
} from './format';

const W = 920;
const SRC_X = 16;
const SRC_W = 250;
const DB_X = 654;
const DB_W = 250;
const ROW = 36;
const GROUP = 24;
const DB_H = 84;
const DB_GAP = 28;
const PAD = 28;

const edgeLabel = (e: DbEdge, stores: DatabaseEntry[]) =>
  `${e.source} to ${stores.find((s) => s.store === e.store)?.name ?? e.store}`;

export function DatabaseMap({
  data, window: win, onWindow,
}: { data: DatabasesPayload; window: DbWindow; onWindow: (w: DbWindow) => void }) {
  const { edges, databases } = data;
  const stores = useMemo(
    () => STORE_ORDER.map((s) => databases.find((d) => d.store === s)).filter((d): d is DatabaseEntry => !!d),
    [databases],
  );
  const nodes = useMemo(() => sourceNodes(edges), [edges]);

  const heaviest = useMemo(
    () => [...edges].sort((a, b) => b.rows_read - a.rows_read)[0] ?? null,
    [edges],
  );
  const [picked, setPicked] = useState<string | null>(null);
  const selectedEdge = edges.find((e) => edgeId(e) === picked) ?? heaviest;
  const selectedId = selectedEdge ? edgeId(selectedEdge) : null;

  // Layout
  const srcY = new Map<string, number>();
  const groups: Array<{ kind: string; y: number }> = [];
  let y = PAD;
  let lastKind = '';
  for (const n of nodes) {
    if (n.kind !== lastKind) { groups.push({ kind: KIND_LABEL[n.kind], y: y + 10 }); y += GROUP; lastKind = n.kind; }
    srcY.set(n.id, y + ROW / 2 - 4);
    y += ROW;
  }
  const srcH = y + PAD;
  const dbH = PAD * 2 + stores.length * DB_H + Math.max(0, stores.length - 1) * DB_GAP;
  const H = Math.max(srcH, dbH, 220);
  const dbTop = new Map<string, number>();
  stores.forEach((s, i) => dbTop.set(s.store, (H - dbH) / 2 + PAD + i * (DB_H + DB_GAP)));

  // Spread the edges that land on one store down its box.
  const slot = new Map<string, number>();
  for (const s of stores) {
    const into = edges.filter((e) => e.store === s.store)
      .sort((a, b) => (srcY.get(`${a.kind}:${a.source}`) ?? 0) - (srcY.get(`${b.kind}:${b.source}`) ?? 0));
    into.forEach((e, i) => {
      const top = dbTop.get(s.store) ?? 0;
      slot.set(edgeId(e), into.length === 1 ? top + DB_H / 2 : top + 14 + (i * (DB_H - 28)) / (into.length - 1));
    });
  }
  const maxRead = Math.max(1, ...edges.map((e) => e.rows_read));

  const selectedStore = selectedEdge ? stores.find((s) => s.store === selectedEdge.store) : undefined;
  const storeReads = selectedEdge ? edges.filter((e) => e.store === selectedEdge.store).reduce((a, e) => a + e.rows_read, 0) : 0;
  const share = selectedEdge && storeReads > 0 ? Math.round((selectedEdge.rows_read / storeReads) * 100) : null;
  const agentTab = selectedEdge?.kind === 'agent' ? 'agents' : selectedEdge?.kind === 'feed' ? 'feeds' : null;

  return (
    <div className="dbp" style={{ gap: 20 }}>
      <div className="dbp-toolbar">
        <p className="dbp-sub">Line width is rows read in the window. Red means this job's statements were rejected (overloaded).</p>
        <label className="dbp-field">
          Window
          <select className="dbp-select" value={win} onChange={(e) => onWindow(e.target.value as DbWindow)} aria-label="Window">
            {(Object.keys(WINDOW_LABEL) as DbWindow[]).map((w) => <option key={w} value={w}>{WINDOW_LABEL[w]}</option>)}
          </select>
        </label>
      </div>

      {edges.length === 0 ? (
        <p className="dbp-empty-inline">No per-job reads recorded for this window yet.</p>
      ) : (
        <div className="dbp-map-card">
          <svg
            className="dbp-map-svg"
            viewBox={`0 0 ${W} ${H}`}
            role="group"
            aria-label={`Connections from ${nodes.length} jobs to ${stores.length} databases. A table with the same data follows.`}
          >
            <text className="group" x={SRC_X} y={14}>Jobs</text>
            <text className="group" x={DB_X} y={14}>Databases</text>

            <g>
              {edges.map((e) => {
                const id = edgeId(e);
                const x1 = SRC_X + SRC_W;
                const y1 = srcY.get(`${e.kind}:${e.source}`) ?? 0;
                const y2 = slot.get(id) ?? 0;
                const mid = (x1 + DB_X) / 2;
                const idle = e.rows_read === 0;
                const sw = idle ? 1.5 : 1.5 + (e.rows_read / maxRead) * 12;
                return (
                  <path
                    key={id}
                    className="dbp-edge"
                    d={`M${x1},${y1} C${mid},${y1} ${mid},${y2} ${DB_X},${y2}`}
                    strokeWidth={sw}
                    data-overload={(e.overloads ?? 0) > 0}
                    data-idle={idle}
                    data-selected={id === selectedId}
                    role="button"
                    tabIndex={0}
                    aria-label={`${edgeLabel(e, databases)}: ${formatCount(e.rows_read)} rows read${(e.overloads ?? 0) > 0 ? `, ${e.overloads} overloads` : ''}`}
                    aria-pressed={id === selectedId}
                    onClick={() => setPicked(id)}
                    onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); setPicked(id); } }}
                  />
                );
              })}
            </g>

            {groups.map((g) => <text key={g.kind} className="group" x={SRC_X} y={g.y}>{g.kind}</text>)}
            {nodes.map((n) => {
              const ny = (srcY.get(n.id) ?? 0) - ROW / 2 + 8;
              return (
                <g key={n.id}>
                  <rect className="dbp-node-box" x={SRC_X} y={ny} width={SRC_W} height={ROW - 8} rx={8} data-selected={selectedEdge ? `${selectedEdge.kind}:${selectedEdge.source}` === n.id : false} />
                  <text x={SRC_X + 12} y={ny + 18}>{n.source}</text>
                  <text className="mono" x={SRC_X + SRC_W - 12} y={ny + 18} textAnchor="end">{n.rows_read === 0 ? DASH : formatCount(n.rows_read)}</text>
                </g>
              );
            })}

            {stores.map((s) => {
              const top = dbTop.get(s.store) ?? 0;
              return (
                <g key={s.store}>
                  <rect className="dbp-node-box" x={DB_X} y={top} width={DB_W} height={DB_H} rx={10} data-status={s.status} data-selected={selectedEdge?.store === s.store} />
                  <text x={DB_X + 14} y={top + 24} style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{s.name}</text>
                  <text className="dim" x={DB_X + 14} y={top + 44}>
                    {s.status === 'overloaded' ? `Overloaded${s.overloads_24h != null ? ` · ${s.overloads_24h} rejections in 24 h` : ''}` : `${formatBytes(s.size_bytes)} · ${s.status === 'unknown' ? 'size unknown' : s.status}`}
                  </text>
                  <text className="dim" x={DB_X + 14} y={top + 64}>{(() => { const n = edges.filter((e) => e.store === s.store).length; return `${n} ${n === 1 ? 'job' : 'jobs'} connected`; })()}</text>
                </g>
              );
            })}
          </svg>
        </div>
      )}

      <div className="dbp-map-panels">
        <section className="dbp-panel" aria-label="Selected line" aria-live="polite">
          <h3>Selected line</h3>
          {selectedEdge ? (
            <>
              <strong style={{ color: 'var(--text-primary)', fontSize: 14 }}>{edgeLabel(selectedEdge, databases)}</strong>
              <span>
                <span className="dbp-mono">{formatCount(selectedEdge.rows_read)}</span> rows read, <span className="dbp-mono">{formatCount(selectedEdge.rows_written)}</span> written
                in {WINDOW_LABEL[win].toLowerCase()} across <span className="dbp-mono">{formatCount(selectedEdge.queries)}</span> queries
                {share != null && selectedStore ? `, ${share}% of this window's reads on ${selectedStore.name}` : ''}.
              </span>
              <span>Rejected statements (metered jobs): {selectedEdge.overloads == null ? 'not measured yet' : selectedEdge.overloads}</span>
              {agentTab && <Link to={tabUrl(agentTab)}>See {selectedEdge.source} in {agentTab === 'agents' ? 'Agents' : 'Feeds'} →</Link>}
            </>
          ) : <span>Nothing to select yet.</span>}
        </section>
        <section className="dbp-panel" aria-label="Legend">
          <h3>Legend</h3>
          <div className="dbp-legend-item"><span className="dbp-legend-line" aria-hidden="true" />Normal load</div>
          <div className="dbp-legend-item"><span className="dbp-legend-line" data-k="overload" aria-hidden="true" />Statements rejected (overloaded)</div>
          <div className="dbp-legend-item"><span className="dbp-legend-line" data-k="idle" aria-hidden="true" />Read nothing in this window</div>
        </section>
        {data.proposed.length > 0 && (
          <section className="dbp-panel" aria-label="After the split (proposed)">
            <h3>After the split (proposed)</h3>
            {data.proposed.map((p) => (
              <span key={p.name}><span className="dbp-mono" style={{ color: 'var(--text-primary)' }}>{p.name}</span>: {p.description}</span>
            ))}
          </section>
        )}
      </div>

      <details>
        <summary className="dbp-link" style={{ cursor: 'pointer' }}>Show connections as a table</summary>
        <div className="dbp-tablewrap" style={{ marginTop: 12 }}>
          <table className="dbp-table">
            <caption>Jobs and the databases they use, {WINDOW_LABEL[win].toLowerCase()}. Select a row to inspect it.</caption>
            <thead>
              <tr>
                <th scope="col">Job</th><th scope="col">Type</th><th scope="col">Database</th>
                <th scope="col" className="num">Rows read</th><th scope="col" className="num">Rows written</th>
                <th scope="col" className="num">Queries</th><th scope="col" className="num">Overloads</th>
              </tr>
            </thead>
            <tbody>
              {[...edges].sort((a, b) => b.rows_read - a.rows_read).map((e) => {
                const id = edgeId(e);
                return (
                  <tr key={id} data-selected={id === selectedId}>
                    <th scope="row" style={{ textAlign: 'left', textTransform: 'none', letterSpacing: 0, fontSize: 13, color: 'var(--text-primary)', fontWeight: 500 }}>
                      <button type="button" className="dbp-link" onClick={() => setPicked(id)} aria-label={`Inspect ${edgeLabel(e, databases)}`}>{e.source}</button>
                    </th>
                    <td>{KIND_LABEL[e.kind]}</td>
                    <td className="dbp-mono">{databases.find((d) => d.store === e.store)?.name ?? e.store}</td>
                    <td className="num">{formatCount(e.rows_read)}</td>
                    <td className="num">{formatCount(e.rows_written)}</td>
                    <td className="num">{formatCount(e.queries)}</td>
                    <td className="num">{e.overloads == null ? DASH : e.overloads}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
