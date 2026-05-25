// Shared advanced Threats table — the component.
//
// Controlled: state lives in useThreatsTable (in each app, so React Query
// can key on it), all rendering lives here so ops + tenant look identical.
// Built-in column renderers keyed by ThreatColumnKey; each app passes the
// subset it wants. Rows expand to an evidence/TTP detail panel that
// synthesizes the "so what" from the columns we already store.

import { useState, type ReactNode } from 'react';
import type { ThreatRow, ThreatColumnKey, ThreatsTableProps } from './types';
import './threats-table.css';

const TYPE_LABELS: Record<string, string> = {
  phishing: 'Phishing', typosquatting: 'Typosquatting', impersonation: 'Impersonation',
  malware_distribution: 'Malware', credential_harvesting: 'Credential harvesting',
  c2: 'C2', scanning: 'Scanning',
};

const SEVERITY_OPTS = [
  { value: '', label: 'All severities' }, { value: 'critical', label: 'Critical' },
  { value: 'high', label: 'High' }, { value: 'medium', label: 'Medium' }, { value: 'low', label: 'Low' },
];
const TYPE_OPTS = [
  { value: '', label: 'All types' },
  ...Object.entries(TYPE_LABELS).map(([value, label]) => ({ value, label })),
];
const STATUS_OPTS = [
  { value: '', label: 'All statuses' }, { value: 'active', label: 'Active' },
  { value: 'down', label: 'Down' }, { value: 'remediated', label: 'Remediated' },
];

function sevTone(sev: string | null): string {
  const s = (sev ?? '').toLowerCase();
  return s === 'critical' ? 'crit' : s === 'high' ? 'high' : s === 'medium' ? 'medium' : 'neutral';
}
function Pill({ tone, children }: { tone: string; children: ReactNode }) {
  return <span className="tt-pill" data-tone={tone}>{children}</span>;
}
function fmtDate(d?: string | null): string {
  if (!d) return '—';
  const dt = new Date(d);
  return Number.isNaN(dt.getTime()) ? '—' : dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
function target(row: ThreatRow): string {
  return row.malicious_domain ?? row.malicious_url ?? row.ip_address ?? '—';
}

// ─── Built-in column renderers ─────────────────────────────────────
interface ColDef { header: string; align?: 'left' | 'right' | 'center'; render: (r: ThreatRow) => ReactNode }
const COLUMNS: Record<ThreatColumnKey, ColDef> = {
  brand:    { header: 'Brand', render: (r) => <span className="tt-strong">{r.brand_name ?? r.target_brand_id ?? '—'}</span> },
  type:     { header: 'Type', render: (r) => <Pill tone="neutral">{TYPE_LABELS[r.threat_type] ?? r.threat_type.replace(/_/g, ' ')}</Pill> },
  target:   { header: 'Domain / URL', render: (r) => <span className="tt-mono tt-strong tt-truncate" title={r.malicious_url ?? r.malicious_domain ?? ''} style={{ display: 'inline-block' }}>{target(r)}</span> },
  ip:       { header: 'IP', render: (r) => <span className="tt-mono">{r.ip_address ?? '—'}</span> },
  severity: { header: 'Severity', render: (r) => <Pill tone={sevTone(r.severity)}>{(r.severity ?? '—').toLowerCase()}</Pill> },
  status:   { header: 'Status', render: (r) => <Pill tone={(r.status ?? '') === 'active' ? 'crit' : (r.status ?? '') === 'remediated' ? 'ok' : 'neutral'}>{r.status ?? '—'}</Pill> },
  source:   { header: 'Source', render: (r) => <span className="tt-mono">{(r.source_feed ?? '—').replace(/_/g, ' ')}</span> },
  country:  { header: 'Country', align: 'center', render: (r) => <span className="tt-mono">{r.country_code ?? '—'}</span> },
  asn:      { header: 'ASN', render: (r) => <span className="tt-mono">{r.asn ?? '—'}</span> },
  hosting:  { header: 'Hosting', render: (r) => <span className="tt-truncate" style={{ display: 'inline-block' }}>{r.hosting_provider ?? <span className="tt-dim">unknown</span>}</span> },
  actor:    { header: 'Actor', render: (r) => r.actor_name ? <span className="tt-strong">{r.actor_name}</span> : <span className="tt-dim">Unattributed</span> },
  technique:{ header: 'Technique', render: (r) => r.saas_technique_name || r.saas_technique_id ? <Pill tone="info">{r.saas_technique_name ?? r.saas_technique_id}</Pill> : <span className="tt-dim">—</span> },
  evidence: { header: 'Evidence', render: (r) => <EvidenceSummary row={r} /> },
  confidence:{ header: 'Conf', align: 'right', render: (r) => <span className="tt-mono">{r.confidence_score != null ? `${r.confidence_score}%` : '—'}</span> },
  first_seen:{ header: 'First seen', align: 'right', render: (r) => <span className="tt-mono tt-dim">{fmtDate(r.first_seen)}</span> },
  last_seen: { header: 'Last seen', align: 'right', render: (r) => <span className="tt-mono tt-dim">{fmtDate(r.last_seen ?? r.created_at)}</span> },
};

function EvidenceSummary({ row: r }: { row: ThreatRow }) {
  const chips: ReactNode[] = [];
  if (r.vt_checked && (r.vt_malicious ?? 0) > 0) chips.push(<Pill key="vt" tone="crit">VT {r.vt_malicious}</Pill>);
  if (r.gsb_flagged) chips.push(<Pill key="gsb" tone="crit">GSB</Pill>);
  if (r.surbl_listed) chips.push(<Pill key="surbl" tone="high">SURBL</Pill>);
  if (r.greynoise_classification === 'malicious') chips.push(<Pill key="gn" tone="crit">GreyNoise</Pill>);
  if ((r.abuseipdb_score ?? 0) > 0) chips.push(<Pill key="ab" tone="high">Abuse {r.abuseipdb_score}</Pill>);
  if (chips.length === 0) return <span className="tt-dim">—</span>;
  return <span className="tt-verdict">{chips}</span>;
}

function synthesize(r: ThreatRow): string {
  const typeLabel = TYPE_LABELS[r.threat_type] ?? r.threat_type.replace(/_/g, ' ');
  const ident = r.malicious_domain ?? r.ip_address ?? r.malicious_url ?? 'indicator';
  const infra = r.hosting_provider
    ? ` hosted on ${r.hosting_provider}${r.asn ? ` (${r.asn})` : ''}`
    : r.asn ? ` on ${r.asn}` : '';
  const corrob: string[] = [];
  if (r.vt_checked && (r.vt_malicious ?? 0) > 0) corrob.push(`VirusTotal ${r.vt_malicious} detections`);
  if (r.gsb_flagged) corrob.push('Google Safe Browsing');
  if (r.surbl_listed) corrob.push('SURBL');
  if (r.greynoise_classification === 'malicious') corrob.push('GreyNoise');
  if ((r.abuseipdb_score ?? 0) > 0) corrob.push(`AbuseIPDB ${r.abuseipdb_score}%`);
  let s = `${typeLabel} indicator ${ident}${infra}.`;
  s += corrob.length ? ` Corroborated by ${corrob.join(', ')}.` : ' No external reputation corroboration on file yet.';
  if (r.cluster_id) s += ' Part of a tracked infrastructure cluster.';
  else if (r.campaign_id) s += ' Linked to a tracked campaign.';
  if (r.actor_name) s += ` Attributed to ${r.actor_name}.`;
  if (r.confidence_score != null) s += ` Confidence ${r.confidence_score}%.`;
  return s;
}

function KV({ k, v }: { k: string; v: ReactNode }) {
  if (v == null || v === '' || v === '—') return null;
  return <div className="tt-kv"><span className="k">{k}</span><span className="v">{v}</span></div>;
}

function DetailPanel({ row: r, colSpan, extra }: { row: ThreatRow; colSpan: number; extra?: ReactNode }) {
  const yes = (n?: number | null) => (n ? 'yes' : 'no');
  return (
    <tr className="tt-detail-row">
      <td className="tt-detail-td" colSpan={colSpan}>
        <div className="tt-detail">
          <div className="tt-assess">{synthesize(r)}</div>
          <div className="tt-detail-grid" style={{ marginTop: 14 }}>
            <div>
              <div className="tt-sect-label">Reputation</div>
              {r.vt_checked != null && <KV k="VirusTotal" v={`${r.vt_malicious ?? 0} malicious · rep ${r.vt_reputation ?? 0}`} />}
              {r.gsb_checked != null && <KV k="Safe Browsing" v={r.gsb_flagged ? (r.gsb_threat_type ?? 'flagged') : 'clean'} />}
              {r.surbl_checked != null && <KV k="SURBL" v={r.surbl_listed ? 'listed' : 'clean'} />}
              {r.greynoise_checked != null && <KV k="GreyNoise" v={r.greynoise_classification ?? 'seen'} />}
              {r.seclookup_checked != null && <KV k="SecLookup" v={`risk ${r.seclookup_risk_score ?? 0}`} />}
              {r.abuseipdb_checked != null && <KV k="AbuseIPDB" v={`${r.abuseipdb_score ?? 0}% · ${r.abuseipdb_reports ?? 0} reports`} />}
              {!r.vt_checked && !r.gsb_checked && !r.surbl_checked && !r.greynoise_checked && !r.abuseipdb_checked && (
                <div className="tt-dim" style={{ fontSize: 11 }}>No reputation enrichment on file.</div>
              )}
            </div>
            <div>
              <div className="tt-sect-label">Infrastructure</div>
              <KV k="Domain" v={r.malicious_domain} />
              <KV k="URL" v={r.malicious_url} />
              <KV k="IP" v={r.ip_address} />
              <KV k="ASN" v={r.asn} />
              <KV k="Hosting" v={r.hosting_provider} />
              <KV k="Country" v={r.country_code} />
              <KV k="Registrar" v={r.registrar} />
              <KV k="Registered" v={r.registration_date} />
            </div>
            <div>
              <div className="tt-sect-label">Correlation &amp; TTP</div>
              <KV k="Technique" v={r.saas_technique_name ?? r.saas_technique_id} />
              <KV k="Actor" v={r.actor_name} />
              <KV k="Campaign" v={r.campaign_id} />
              <KV k="Cluster" v={r.cluster_id} />
              <KV k="Source feed" v={r.source_feed} />
              <KV k="Confidence" v={r.confidence_score != null ? `${r.confidence_score}%` : null} />
              <KV k="First seen" v={fmtDate(r.first_seen)} />
              <KV k="Last seen" v={fmtDate(r.last_seen)} />
              {r.malicious_url && <KV k="Open" v={<a className="tt-link" href={r.malicious_url} target="_blank" rel="noopener noreferrer">↗ link</a>} />}
            </div>
          </div>
          {extra}
        </div>
      </td>
    </tr>
  );
}

export function ThreatsTable(props: ThreatsTableProps) {
  const {
    columns, rows, total, loading, error, state, pageSize,
    onFilter, onSearch, onToggleSort, onPage,
    controls = ['search', 'severity', 'type', 'status'], brands = [], countries = [],
    sortKeys = {}, renderExtraDetail, emptyText = 'No threats match these filters.',
  } = props;
  const [open, setOpen] = useState<string | null>(null);

  const from = total === 0 ? 0 : state.page * pageSize + 1;
  const to = Math.min((state.page + 1) * pageSize, total);

  return (
    <div className="tt-wrap">
      <div className="tt-filters">
        {controls.includes('brand') && (
          <select className="tt-select" value={state.brandId} onChange={(e) => onFilter({ brandId: e.target.value })}>
            <option value="">All brands</option>
            {brands.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
          </select>
        )}
        {controls.includes('severity') && (
          <select className="tt-select" value={state.severity} onChange={(e) => onFilter({ severity: e.target.value })}>
            {SEVERITY_OPTS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        )}
        {controls.includes('type') && (
          <select className="tt-select" value={state.type} onChange={(e) => onFilter({ type: e.target.value })}>
            {TYPE_OPTS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        )}
        {controls.includes('status') && (
          <select className="tt-select" value={state.status} onChange={(e) => onFilter({ status: e.target.value })}>
            {STATUS_OPTS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        )}
        {controls.includes('country') && (
          <select className="tt-select" value={state.country} onChange={(e) => onFilter({ country: e.target.value })}>
            <option value="">All countries</option>
            {countries.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        )}
        {controls.includes('search') && (
          <div className="tt-spacer tt-search-wrap" style={{ flex: '1 1 160px', maxWidth: 260 }}>
            <span className="tt-search-icon">⌕</span>
            <input className="tt-search" style={{ width: '100%' }} placeholder="Search domain / URL / IP…"
              value={state.q} onChange={(e) => onSearch(e.target.value)} />
          </div>
        )}
      </div>

      <div className="tt-tablewrap">
        <div className="tt-scroll">
          <table className="tt-table">
            <thead>
              <tr>
                <th className="tt-th" style={{ width: 28 }} aria-label="expand" />
                {columns.map((key) => {
                  const def = COLUMNS[key];
                  const sk = sortKeys[key];
                  const active = sk != null && state.sort === sk;
                  return (
                    <th key={key} className="tt-th" data-sortable={sk != null} data-active={active} data-align={def.align ?? 'left'}
                      onClick={sk ? () => onToggleSort(sk) : undefined}>
                      <span className="tt-th-inner">{def.header}{sk != null && <span>{active ? (state.dir === 'asc' ? '▲' : '▼') : '↕'}</span>}</span>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const isOpen = open === r.id;
                return (
                  <>
                    <tr key={r.id} className="tt-row" data-open={isOpen} onClick={() => setOpen(isOpen ? null : r.id)}>
                      <td className="tt-td" data-align="center"><span className="tt-expand-icon">›</span></td>
                      {columns.map((key) => (
                        <td key={key} className="tt-td" data-align={COLUMNS[key].align ?? 'left'}>{COLUMNS[key].render(r)}</td>
                      ))}
                    </tr>
                    {isOpen && <DetailPanel row={r} colSpan={columns.length + 1} extra={renderExtraDetail?.(r)} />}
                  </>
                );
              })}
            </tbody>
          </table>
        </div>
        {loading && <div className="tt-state">Loading threats…</div>}
        {!loading && error && <div className="tt-state" style={{ color: 'var(--sev-critical)' }}>{error}</div>}
        {!loading && !error && rows.length === 0 && <div className="tt-state">{emptyText}</div>}
      </div>

      {total > 0 && (
        <div className="tt-pager">
          <span className="tt-pager-info">{from.toLocaleString()}–{to.toLocaleString()} of {total.toLocaleString()}</span>
          <div className="tt-pager-btns">
            <button className="tt-btn" disabled={state.page === 0 || loading} onClick={() => onPage(state.page - 1)}>Prev</button>
            <button className="tt-btn" data-variant="primary" disabled={to >= total || loading} onClick={() => onPage(state.page + 1)}>Next</button>
          </div>
        </div>
      )}
    </div>
  );
}
