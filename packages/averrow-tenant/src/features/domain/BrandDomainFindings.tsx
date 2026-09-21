// Domain Monitoring — per-brand drill-down.
//
// Lists malicious domains/URLs (production threat-intel, all threat
// types) + lookalike domain rows + CT certificate rows for one brand.
// Pre-filtered by org scope server-side. Per-row "Request takedown" CTA
// on the malicious-domains section feeds the existing
// /api/orgs/:orgId/takedowns pipeline.

import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, ExternalLink, X } from 'lucide-react';
import {
  useBrandDomainFindings,
  useDomainModuleSummary,
  useRequestTakedown,
  type LookalikeRow,
  type CertRow,
  type MaliciousDomainRow,
} from '@/lib/domainModule';
import { THREAT_TYPE_LABELS } from '@/lib/threats';
import { SortableTable, SEVERITY_RANK, Pill, type Column } from '@/components/SortableTable';
import {
  PAGE_SIGNAL_WEIGHTS,
  PAGE_SIGNAL_LABELS,
  SHADOW_SIGNAL_WEIGHTS,
  SHADOW_SIGNAL_LABELS,
  pageSignalLabel,
  parsePageSignalArray,
  defangHost,
} from '@/lib/pageSignals';

export function BrandDomainFindings() {
  const { brandId } = useParams<{ brandId: string }>();
  const { data: summary } = useDomainModuleSummary();
  const { data, isLoading, error } = useBrandDomainFindings(brandId ?? null);

  const brand = summary?.brands.find((b) => b.brand_id === brandId);

  return (
    <div className="max-w-6xl space-y-6">
      <Link to="/modules/domain" className="inline-flex items-center gap-1.5 text-[11px] font-mono text-white/40 hover:text-white/70">
        <ArrowLeft size={12} /> BACK TO DOMAIN MONITORING
      </Link>

      <header>
        <div className="text-[11px] uppercase tracking-[0.18em] font-mono text-white/40">Domain Monitoring · Brand</div>
        <h1 className="text-[28px] font-bold text-[var(--text-primary)] tracking-tight">{brand?.brand_name ?? brandId}</h1>
        <p className="mt-1 text-sm text-white/55 font-mono">{brand?.canonical_domain ?? ''}</p>
      </header>

      {isLoading && <div className="text-white/40 text-sm font-mono py-12 text-center">Loading findings…</div>}
      {error && (
        <div className="rounded-xl border border-sev-critical/[0.30] bg-sev-critical/[0.06] p-6">
          <h3 className="text-sm font-semibold text-white/90">Couldn't load findings</h3>
          <p className="text-[12px] text-white/55 mt-1">{error.message}</p>
        </div>
      )}

      {data && (
        <>
          <MaliciousDomainsSection rows={data.malicious_domains} brandId={data.brand_id} brandName={brand?.brand_name ?? data.brand_id} />
          <LookalikesSection rows={data.lookalikes} />
          <CertsSection rows={data.certs} />
        </>
      )}
    </div>
  );
}

// ───── Malicious domains & URLs section ────────────────────────────
//
// Production threat-intel rows from the `threats` table across all
// threat types (phishing, typosquatting, malware, etc.) where
// target_brand_id matches. Distinct from the smaller curated
// `lookalike_domains` working set rendered by LookalikesSection below.
// The dedicated /tenant/threats page paginates the full volume.

function MaliciousDomainsSection({
  rows,
  brandId,
  brandName,
}: { rows: MaliciousDomainRow[]; brandId: string; brandName: string }) {
  const [confirmRow, setConfirmRow] = useState<MaliciousDomainRow | null>(null);

  if (rows.length === 0) {
    return (
      <section>
        <h2 className="text-[11px] uppercase tracking-[0.18em] font-mono text-white/45 mb-3">
          Malicious Domains &amp; URLs <span className="text-white/30">(0)</span>
        </h2>
        <div className="rounded-xl border border-white/[0.06] bg-bg-card p-6 text-center text-white/45 text-sm">
          No malicious domains or URLs attributed to this brand yet.
        </div>
      </section>
    );
  }

  const criticalCount = rows.filter((r) => r.severity === 'critical').length;
  const highCount     = rows.filter((r) => r.severity === 'high').length;

  const columns: Column<MaliciousDomainRow>[] = [
    { key: 'target', header: 'Domain / URL', sortAccessor: (r) => r.malicious_domain ?? r.malicious_url ?? '',
      cellClassName: 'font-mono max-w-[280px] truncate',
      render: (r) => <span className="text-white/90" title={r.malicious_url ?? r.malicious_domain ?? ''}>{r.malicious_domain ?? r.malicious_url ?? '—'}</span> },
    { key: 'type', header: 'Type', sortAccessor: (r) => r.threat_type,
      render: (r) => <span className="inline-flex items-center text-[10px] uppercase tracking-widest font-mono text-white/70 bg-white/[0.04] border border-white/[0.08] rounded px-1.5 py-0.5">{THREAT_TYPE_LABELS[r.threat_type] ?? r.threat_type.replace(/_/g, ' ')}</span> },
    { key: 'severity', header: 'Severity', sortAccessor: (r) => SEVERITY_RANK[(r.severity ?? '').toLowerCase()] ?? 0,
      render: (r) => <SeverityPill severity={r.severity} /> },
    { key: 'source', header: 'Source', sortAccessor: (r) => r.source_feed, render: (r) => <SourceChip source={r.source_feed} /> },
    { key: 'hosting', header: 'Hosting', sortAccessor: (r) => r.hosting_provider ?? '', cellClassName: 'max-w-[180px] truncate',
      render: (r) => (
        <span className="text-white/55">
          {r.hosting_provider ?? <span className="text-white/30">unknown</span>}
          {r.country_code && <span className="ml-1.5 text-[10px] font-mono text-white/35">{r.country_code}</span>}
        </span>
      ) },
    { key: 'first_seen', header: 'First seen', align: 'right', sortAccessor: (r) => r.first_seen ?? '',
      render: (r) => <span className="text-white/45 font-mono text-[11px]">{r.first_seen ? new Date(r.first_seen).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'}</span> },
    { key: 'action', header: 'Action', align: 'right',
      render: (r) => r.takedown_status
        ? <TakedownStatusPill status={r.takedown_status} takedownId={r.takedown_id} />
        : <button type="button" onClick={() => setConfirmRow(r)} className="inline-flex items-center gap-1 text-[10px] uppercase tracking-widest font-mono text-amber bg-amber/[0.06] hover:bg-amber/[0.12] border border-amber/[0.20] hover:border-amber/[0.40] rounded px-2 py-1 transition-colors">Request takedown</button> },
  ];

  return (
    <section>
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-[11px] uppercase tracking-[0.18em] font-mono text-white/45">
          Malicious Domains &amp; URLs <span className="text-white/30">({rows.length})</span>
        </h2>
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest font-mono">
          {criticalCount > 0 && (
            <span className="text-sev-critical">
              {criticalCount} critical
            </span>
          )}
          {highCount > 0 && (
            <span className="text-amber">
              {highCount} high
            </span>
          )}
          <Link to={`/threats?brand=${brandId}`} className="text-amber hover:underline">
            View all →
          </Link>
        </div>
      </div>
      <SortableTable
        columns={columns}
        rows={rows}
        getRowKey={(r) => r.id}
        initialSort={{ key: 'severity', dir: 'desc' }}
      />
      {confirmRow && (
        <RequestTakedownDialog
          row={confirmRow}
          brandId={brandId}
          brandName={brandName}
          onClose={() => setConfirmRow(null)}
        />
      )}
    </section>
  );
}

function RequestTakedownDialog({
  row, brandId, brandName, onClose,
}: { row: MaliciousDomainRow; brandId: string; brandName: string; onClose: () => void }) {
  const mutation = useRequestTakedown();
  const target = row.malicious_domain ?? row.malicious_url ?? '';
  const typeLabel = THREAT_TYPE_LABELS[row.threat_type] ?? row.threat_type.replace(/_/g, ' ');
  const defaultSummary =
    `Malicious ${typeLabel.toLowerCase()} target ${target} impersonates ${brandName}. ` +
    `Detected ${row.first_seen?.slice(0, 10) ?? 'recently'} via ${row.source_feed}. ` +
    `Severity: ${row.severity}.`;
  const [summary, setSummary] = useState(defaultSummary);

  const submit = () => {
    mutation.mutate(
      {
        brand_id:         brandId,
        threat_id:        row.id,
        malicious_domain: target,
        evidence_summary: summary.trim() || defaultSummary,
      },
      { onSuccess: onClose },
    );
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-xl border border-white/[0.08] bg-bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b border-white/[0.06] px-5 py-4">
          <div>
            <div className="text-[11px] uppercase tracking-[0.18em] font-mono text-white/45">Confirm takedown request</div>
            <div className="mt-1 text-sm text-white/90 font-mono">{target}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-white/40 hover:text-white/70 transition-colors"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          <div className="grid grid-cols-2 gap-3 text-[11px] font-mono">
            <Field label="Target brand" value={brandName} />
            <Field label="Severity" value={row.severity} valueClass={
              row.severity === 'critical' ? 'text-sev-critical' :
              row.severity === 'high'     ? 'text-amber'        :
                                            'text-white/70'
            } />
            <Field label="Source" value={row.source_feed} />
            <Field label="Hosting" value={row.hosting_provider ?? 'unknown'} />
          </div>

          <div>
            <label htmlFor="td-summary" className="block text-[10px] uppercase tracking-widest font-mono text-white/45 mb-1.5">
              Evidence summary
            </label>
            <textarea
              id="td-summary"
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              rows={4}
              className="w-full rounded-lg bg-white/[0.03] border border-white/[0.08] focus:border-amber/[0.40] focus:outline-none px-3 py-2 text-[12px] text-white/90 font-mono placeholder:text-white/30"
              placeholder="Optional — auto-generated from threat intel if left blank"
            />
            <p className="mt-1.5 text-[10px] font-mono text-white/40">
              Submitted to the hosting provider's abuse contact under your signed authorization.
              Track progress under Takedowns.
            </p>
          </div>

          {mutation.error && (
            <div className="rounded-lg border border-sev-critical/[0.30] bg-sev-critical/[0.06] px-3 py-2 text-[11px] text-white/80 font-mono">
              {(mutation.error as Error).message}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-white/[0.06] px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={mutation.isPending}
            className="text-[11px] uppercase tracking-widest font-mono text-white/55 hover:text-white/85 px-3 py-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={mutation.isPending}
            className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-widest font-mono text-amber bg-amber/[0.08] hover:bg-amber/[0.16] border border-amber/[0.30] hover:border-amber/[0.50] rounded px-3 py-1.5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {mutation.isPending ? 'Submitting…' : 'Confirm request'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, value, valueClass = 'text-white/80' }: { label: string; value: string; valueClass?: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-widest text-white/40">{label}</div>
      <div className={`mt-0.5 ${valueClass}`}>{value}</div>
    </div>
  );
}

function SourceChip({ source }: { source: string }) {
  // Short, recognizable label per source so the row stays compact.
  // PR-BA: `abuse_mailbox` gets a distinct amber tone — these threats
  // came from a human-reviewed phishing report (Averrow's public alias
  // or a tenant abuse mailbox) and the provenance is worth surfacing
  // alongside the algorithmic feed sources.
  if (source === 'abuse_mailbox') {
    return (
      <span
        className="inline-flex items-center text-[9px] uppercase tracking-widest font-mono text-amber bg-amber/[0.08] border border-amber/[0.20] rounded px-1.5 py-0.5"
        title="Reported via abuse mailbox — community-submitted phishing capture"
      >
        community report
      </span>
    );
  }
  const label = source === 'typosquat_scanner' ? 'scanner'
              : source === 'ct_logs'           ? 'CT logs'
              : source === 'numbered_variant_scan' ? 'numbered'
              : source === 'nrd_hagezi'        ? 'NRD'
              : source.replace(/_/g, ' ');
  return (
    <span className="inline-flex items-center text-[9px] uppercase tracking-widest font-mono text-white/55 bg-white/[0.04] border border-white/[0.08] rounded px-1.5 py-0.5">
      {label}
    </span>
  );
}

function SeverityPill({ severity }: { severity: string }) {
  const sev = (severity ?? '').toLowerCase();
  const tone =
    sev === 'critical' ? 'text-sev-critical bg-sev-critical/[0.10] border-sev-critical/[0.20]' :
    sev === 'high'     ? 'text-amber        bg-amber/[0.10]        border-amber/[0.20]'        :
    sev === 'medium'   ? 'text-amber/70     bg-amber/[0.06]        border-amber/[0.10]'        :
                         'text-white/55     bg-white/[0.04]        border-white/[0.08]';
  return (
    <span className={`inline-flex items-center text-[10px] uppercase tracking-widest font-mono border rounded px-1.5 py-0.5 ${tone}`}>
      {sev}
    </span>
  );
}

function TakedownStatusPill({ status, takedownId }: { status: string; takedownId: string | null }) {
  const tone =
    status === 'resolved'  ? 'text-green/80 bg-green/[0.10] border-green/[0.20]' :
    status === 'submitted' ||
    status === 'in_flight' ? 'text-amber/70 bg-amber/[0.06] border-amber/[0.10]' :
    status === 'failed'    ? 'text-sev-critical bg-sev-critical/[0.08] border-sev-critical/[0.16]' :
                             'text-white/55 bg-white/[0.04] border-white/[0.08]';
  const label = status.replace(/_/g, ' ');
  const inner = (
    <span className={`inline-flex items-center gap-1 text-[10px] uppercase tracking-widest font-mono border rounded px-1.5 py-0.5 ${tone}`}>
      {label}
      {takedownId && <ExternalLink size={9} className="opacity-60" />}
    </span>
  );
  if (!takedownId) return inner;
  return (
    <Link to={`/takedowns/${takedownId}`} className="hover:opacity-80 transition-opacity">
      {inner}
    </Link>
  );
}

function LookalikesSection({ rows }: { rows: LookalikeRow[] }) {
  const [detailRow, setDetailRow] = useState<LookalikeRow | null>(null);

  if (rows.length === 0) {
    return (
      <section>
        <h2 className="text-[11px] uppercase tracking-[0.18em] font-mono text-white/45 mb-3">
          Lookalike Domains <span className="text-white/30">(0)</span>
        </h2>
        <div className="rounded-xl border border-white/[0.06] bg-bg-card p-6 text-center text-white/45 text-sm">
          No lookalike domains tracked for this brand yet.
        </div>
      </section>
    );
  }

  const columns: Column<LookalikeRow>[] = [
    { key: 'domain', header: 'Domain', sortAccessor: (r) => r.domain, cellClassName: 'font-mono',
      render: (r) => <span className={r.registered ? 'text-white/90' : 'text-white/40'}>{r.domain}</span> },
    { key: 'type', header: 'Type', sortAccessor: (r) => r.permutation_type, cellClassName: 'text-white/55 capitalize',
      render: (r) => r.permutation_type.replace(/_/g, ' ') },
    { key: 'threat', header: 'Threat', sortAccessor: (r) => SEVERITY_RANK[(r.threat_level ?? '').toLowerCase()] ?? 0,
      render: (r) => <ThreatPill level={r.threat_level} /> },
    { key: 'status', header: 'Status', sortAccessor: (r) => r.status, render: (r) => <StatusPill status={r.status} /> },
    // DNS/WHOIS facts (registered/web/mx) stay first — the page-content
    // verdict (PageVerdictChip) is a separate evidence class appended
    // after them, not merged into the same chip vocabulary.
    { key: 'signals', header: 'Signals', render: (r) => (
      <div className="flex flex-wrap items-center gap-1.5">
        {r.registered === 1 && <SignalChip>registered</SignalChip>}
        {r.has_web === 1 && <SignalChip>web</SignalChip>}
        {r.has_mx === 1 && <SignalChip>mx</SignalChip>}
        <PageVerdictChip row={r} onOpenDetail={() => setDetailRow(r)} />
      </div>
    ) },
    { key: 'last_checked', header: 'Last seen', align: 'right', sortAccessor: (r) => r.last_checked ?? '',
      render: (r) => <span className="text-white/45 font-mono text-[11px]">{r.last_checked ? new Date(r.last_checked).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'}</span> },
  ];

  return (
    <section>
      <h2 className="text-[11px] uppercase tracking-[0.18em] font-mono text-white/45 mb-3">
        Lookalike Domains <span className="text-white/30">({rows.length})</span>
      </h2>
      <SortableTable columns={columns} rows={rows} getRowKey={(r) => r.id} initialSort={{ key: 'threat', dir: 'desc' }} />
      {detailRow && (
        <PageAnalysisDialog row={detailRow} onClose={() => setDetailRow(null)} />
      )}
    </section>
  );
}

// ── Page-content verdict (Lane 3 Phase 3 step 15) ───────────────────
//
// `page_fetched_at === null` is the authoritative "never scanned"
// marker (every other page_* field is null on an unscanned row too,
// but this is the one to gate on). A non-null page_fetched_at with
// empty signal arrays is "checked, nothing found" — a result, not an
// absence — rendered distinctly (ok/green) from "not scanned"
// (neutral/gray).
function PageVerdictChip({ row, onOpenDetail }: { row: LookalikeRow; onOpenDetail: () => void }) {
  if (!row.page_fetched_at) {
    return <Pill tone="neutral">page: not scanned</Pill>;
  }

  const live = parsePageSignalArray(row.page_signals);
  const shadow = parsePageSignalArray(row.page_ai_signals);

  if (live.length === 0 && shadow.length === 0) {
    return <Pill tone="ok">page: clean</Pill>;
  }

  // A live/scored signal is real evidence — crit tone. Shadow-only
  // firings are Lane 3 measurement data, never scoring, so they get a
  // distinct, lower-key warn tone and an explicit "shadow only" label
  // rather than borrowing the scored chip's vocabulary.
  const tone = live.length > 0 ? 'crit' : 'warn';
  const label = live.length > 0 ? `page: ${row.page_phishing_score ?? 0}` : 'page: shadow only';

  return (
    <button
      type="button"
      onClick={onOpenDetail}
      className="inline-flex appearance-none bg-transparent border-0 p-0 m-0 cursor-pointer"
      aria-label={`View page-analysis detail for ${row.domain}`}
    >
      <Pill tone={tone}>{label}</Pill>
    </button>
  );
}

function PageAnalysisDialog({ row, onClose }: { row: LookalikeRow; onClose: () => void }) {
  const live = parsePageSignalArray(row.page_signals);
  const shadow = parsePageSignalArray(row.page_ai_signals);

  // Defensive: a key belonging to the SHADOW weight table must never
  // render inside the scoring group, even if it somehow arrived via
  // page_signals.
  const liveSorted = Array.from(new Set(live))
    .filter((k) => !(k in SHADOW_SIGNAL_WEIGHTS))
    .sort((a, b) => (PAGE_SIGNAL_WEIGHTS[b] ?? 0) - (PAGE_SIGNAL_WEIGHTS[a] ?? 0));
  const shadowSorted = Array.from(new Set(shadow))
    .sort((a, b) => (SHADOW_SIGNAL_WEIGHTS[b] ?? 0) - (SHADOW_SIGNAL_WEIGHTS[a] ?? 0));

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg max-h-[85vh] overflow-y-auto rounded-xl border border-white/[0.08] bg-bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b border-white/[0.06] px-5 py-4">
          <div>
            <div className="text-[11px] uppercase tracking-[0.18em] font-mono text-white/45">Page analysis</div>
            <div className="mt-1 text-sm text-white/90 font-mono">{row.domain}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-white/40 hover:text-white/70 transition-colors"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          <div className="grid grid-cols-2 gap-3 text-[11px] font-mono">
            <Field label="Score" value={row.page_phishing_score !== null ? `${row.page_phishing_score} / 100` : '—'} />
            <Field label="Checked" value={row.page_fetched_at ? new Date(row.page_fetched_at).toLocaleString() : 'Never'} />
            {row.page_anti_bot_wall && <Field label="Anti-bot wall" value={row.page_anti_bot_wall.replace(/_/g, ' ')} />}
            {row.page_generator && <Field label="Generator" value={row.page_generator} />}
          </div>

          {row.page_exfil_sink && (
            <div className="rounded-lg border border-sev-critical/[0.25] bg-sev-critical/[0.06] px-3 py-2">
              <div className="text-[10px] uppercase tracking-widest font-mono text-sev-critical mb-1">
                Covert exfil sink
              </div>
              <div className="font-mono text-[12px] text-white/85">
                {defangHost(row.page_exfil_sink)}
                {row.page_exfil_sink_id ? ` · ${row.page_exfil_sink_id}` : ''}
              </div>
            </div>
          )}

          <div>
            <div className="text-[10px] uppercase tracking-widest font-mono text-white/45 mb-1.5">
              Scored signals
            </div>
            {liveSorted.length === 0 ? (
              <p className="text-[12px] text-white/40 italic">No scored signals fired on the last analysis.</p>
            ) : (
              <ul className="space-y-1" data-testid="tenant-scoring-signals">
                {liveSorted.map((key) => {
                  const weight = PAGE_SIGNAL_WEIGHTS[key];
                  return (
                    <li key={key} className="flex items-center justify-between text-[12px]">
                      <span className="text-white/75">{pageSignalLabel(key, PAGE_SIGNAL_LABELS)}</span>
                      <span className="font-mono text-amber">{weight !== undefined ? `+${weight}` : '—'}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {shadowSorted.length > 0 && (
            <div className="pt-3 border-t border-white/[0.06]">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-[10px] uppercase tracking-widest font-mono text-white/40">
                  Shadow signals — not scoring
                </span>
                {row.page_score_delta !== null && (
                  <span className="font-mono text-[10px] text-white/40">would-be +{row.page_score_delta}</span>
                )}
              </div>
              <p className="text-[10px] text-white/35 mb-1.5">
                Computed and persisted for measurement only. None of these contribute to the
                score above, to threat level, or to alert triage.
              </p>
              <ul className="space-y-1" data-testid="tenant-shadow-signals">
                {shadowSorted.map((key) => (
                  <li key={key} className="flex items-center justify-between text-[12px]">
                    <span className="text-white/50">{pageSignalLabel(key, SHADOW_SIGNAL_LABELS)}</span>
                    <span className="font-mono text-[9px] uppercase tracking-widest text-white/35 border border-white/10 rounded px-1.5 py-0.5">
                      shadow
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end border-t border-white/[0.06] px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="text-[11px] uppercase tracking-widest font-mono text-white/55 hover:text-white/85 px-3 py-1.5 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function CertsSection({ rows }: { rows: CertRow[] }) {
  if (rows.length === 0) {
    return (
      <section>
        <h2 className="text-[11px] uppercase tracking-[0.18em] font-mono text-white/45 mb-3">
          Certificate Transparency <span className="text-white/30">(0)</span>
        </h2>
        <div className="rounded-xl border border-white/[0.06] bg-bg-card p-6 text-center text-white/45 text-sm">
          No CT log entries flagged for this brand yet.
        </div>
      </section>
    );
  }

  const columns: Column<CertRow>[] = [
    { key: 'domain', header: 'Domain', sortAccessor: (r) => r.domain, cellClassName: 'font-mono', render: (r) => r.domain },
    { key: 'issuer', header: 'Issuer', sortAccessor: (r) => r.issuer ?? '', cellClassName: 'text-white/55 truncate max-w-[200px]', render: (r) => r.issuer ?? '—' },
    { key: 'suspicious', header: 'Suspicious', align: 'center', sortAccessor: (r) => r.suspicious,
      render: (r) => r.suspicious === 1 ? <span className="text-amber">●</span> : <span className="text-white/30">●</span> },
    { key: 'status', header: 'Status', sortAccessor: (r) => r.status, render: (r) => <CertStatusPill status={r.status} /> },
    { key: 'issued', header: 'Issued', align: 'right', sortAccessor: (r) => r.created_at,
      render: (r) => <span className="text-white/45 font-mono text-[11px]">{new Date(r.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span> },
  ];

  return (
    <section>
      <h2 className="text-[11px] uppercase tracking-[0.18em] font-mono text-white/45 mb-3">
        Certificate Transparency <span className="text-white/30">({rows.length})</span>
      </h2>
      <SortableTable columns={columns} rows={rows} getRowKey={(r) => r.id} initialSort={{ key: 'suspicious', dir: 'desc' }} />
    </section>
  );
}

function ThreatPill({ level }: { level: string }) {
  const sev = (level ?? '').toLowerCase();
  const tone =
    sev === 'critical' ? 'text-sev-critical bg-sev-critical/[0.10] border-sev-critical/[0.20]' :
    sev === 'high'     ? 'text-amber        bg-amber/[0.10]        border-amber/[0.20]'        :
    sev === 'medium'   ? 'text-amber/70     bg-amber/[0.06]        border-amber/[0.10]'        :
                         'text-white/55     bg-white/[0.04]        border-white/[0.08]';
  return (
    <span className={`inline-flex items-center text-[10px] uppercase tracking-widest font-mono border rounded px-1.5 py-0.5 ${tone}`}>
      {level}
    </span>
  );
}

function StatusPill({ status }: { status: string }) {
  const tone =
    status === 'confirmed_threat' ? 'text-sev-critical bg-sev-critical/[0.10] border-sev-critical/[0.20]' :
    status === 'taken_down'       ? 'text-green/80     bg-green/[0.10]        border-green/[0.20]'        :
    status === 'benign'           ? 'text-white/40     bg-white/[0.04]        border-white/[0.08]'        :
                                    'text-white/60     bg-white/[0.06]        border-white/[0.10]';
  return (
    <span className={`inline-flex items-center text-[10px] uppercase tracking-widest font-mono border rounded px-1.5 py-0.5 ${tone}`}>
      {status.replace(/_/g, ' ')}
    </span>
  );
}

function CertStatusPill({ status }: { status: string }) {
  const tone =
    status === 'malicious' ? 'text-sev-critical bg-sev-critical/[0.10] border-sev-critical/[0.20]' :
    status === 'reviewed'  ? 'text-amber/70     bg-amber/[0.06]        border-amber/[0.10]'        :
    status === 'benign'    ? 'text-white/40     bg-white/[0.04]        border-white/[0.08]'        :
                             'text-white/60     bg-white/[0.06]        border-white/[0.10]';
  return (
    <span className={`inline-flex items-center text-[10px] uppercase tracking-widest font-mono border rounded px-1.5 py-0.5 ${tone}`}>
      {status}
    </span>
  );
}

function SignalChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center text-[9px] uppercase tracking-widest font-mono text-white/55 bg-white/[0.04] border border-white/[0.08] rounded px-1.5 py-0.5">
      {children}
    </span>
  );
}

