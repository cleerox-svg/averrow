// Domain Monitoring — per-brand drill-down.
//
// Lists lookalike domain rows + CT certificate rows + typosquats
// (production threat-intel) for one brand. Pre-filtered by org scope
// server-side. Per-row "Request takedown" CTA on the typosquats
// section feeds the existing /api/orgs/:orgId/takedowns pipeline.

import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, ExternalLink, X } from 'lucide-react';
import {
  useBrandDomainFindings,
  useDomainModuleSummary,
  useRequestTakedown,
  type LookalikeRow,
  type CertRow,
  type TyposquatRow,
} from '@/lib/domainModule';

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
        <h1 className="text-[28px] font-bold text-white tracking-tight">{brand?.brand_name ?? brandId}</h1>
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
          <TyposquatsSection rows={data.typosquats} brandId={data.brand_id} brandName={brand?.brand_name ?? data.brand_id} />
          <LookalikesSection rows={data.lookalikes} />
          <CertsSection rows={data.certs} />
        </>
      )}
    </div>
  );
}

// ───── Typosquats section ──────────────────────────────────────────
//
// Production threat-intel rows from the `threats` table where
// threat_type='typosquatting' and target_brand_id matches. Distinct
// from the smaller curated `lookalike_domains` working set rendered
// by LookalikesSection above.

function TyposquatsSection({
  rows,
  brandId,
  brandName,
}: { rows: TyposquatRow[]; brandId: string; brandName: string }) {
  const [confirmRow, setConfirmRow] = useState<TyposquatRow | null>(null);

  if (rows.length === 0) {
    return (
      <section>
        <h2 className="text-[11px] uppercase tracking-[0.18em] font-mono text-white/45 mb-3">
          Typosquatting Domains <span className="text-white/30">(0)</span>
        </h2>
        <div className="rounded-xl border border-white/[0.06] bg-bg-card p-6 text-center text-white/45 text-sm">
          No typosquatting domains attributed to this brand yet.
        </div>
      </section>
    );
  }

  const criticalCount = rows.filter((r) => r.severity === 'critical').length;
  const highCount     = rows.filter((r) => r.severity === 'high').length;

  return (
    <section>
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-[11px] uppercase tracking-[0.18em] font-mono text-white/45">
          Typosquatting Domains <span className="text-white/30">({rows.length})</span>
        </h2>
        {(criticalCount > 0 || highCount > 0) && (
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
          </div>
        )}
      </div>
      <div className="rounded-xl border border-white/[0.06] bg-bg-card overflow-hidden">
        <table className="w-full text-[12px]">
          <thead className="border-b border-white/[0.06] bg-white/[0.02]">
            <tr className="text-left">
              <Th>Domain</Th>
              <Th>Severity</Th>
              <Th>Source</Th>
              <Th>Hosting</Th>
              <Th>First seen</Th>
              <Th>Action</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-white/[0.03] last:border-b-0">
                <Td className="font-mono">
                  <span className="text-white/90">{r.malicious_domain}</span>
                </Td>
                <Td><SeverityPill severity={r.severity} /></Td>
                <Td>
                  <SourceChip source={r.source_feed} />
                </Td>
                <Td className="text-white/55 truncate max-w-[180px]">
                  {r.hosting_provider ?? <span className="text-white/30">unknown</span>}
                  {r.country_code && (
                    <span className="ml-1.5 text-[10px] font-mono text-white/35">{r.country_code}</span>
                  )}
                </Td>
                <Td className="text-white/45 font-mono text-[11px]">
                  {r.first_seen ? new Date(r.first_seen).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'}
                </Td>
                <Td>
                  {r.takedown_status ? (
                    <TakedownStatusPill status={r.takedown_status} takedownId={r.takedown_id} />
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmRow(r)}
                      className="inline-flex items-center gap-1 text-[10px] uppercase tracking-widest font-mono text-amber bg-amber/[0.06] hover:bg-amber/[0.12] border border-amber/[0.20] hover:border-amber/[0.40] rounded px-2 py-1 transition-colors"
                    >
                      Request takedown
                    </button>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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
}: { row: TyposquatRow; brandId: string; brandName: string; onClose: () => void }) {
  const mutation = useRequestTakedown();
  const defaultSummary =
    `Typosquatting domain ${row.malicious_domain} impersonates ${brandName}. ` +
    `Detected ${row.first_seen?.slice(0, 10) ?? 'recently'} via ${row.source_feed}. ` +
    `Severity: ${row.severity}.`;
  const [summary, setSummary] = useState(defaultSummary);

  const submit = () => {
    mutation.mutate(
      {
        brand_id:         brandId,
        threat_id:        row.id,
        malicious_domain: row.malicious_domain,
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
            <div className="mt-1 text-sm text-white/90 font-mono">{row.malicious_domain}</div>
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

  return (
    <section>
      <h2 className="text-[11px] uppercase tracking-[0.18em] font-mono text-white/45 mb-3">
        Lookalike Domains <span className="text-white/30">({rows.length})</span>
      </h2>
      <div className="rounded-xl border border-white/[0.06] bg-bg-card overflow-hidden">
        <table className="w-full text-[12px]">
          <thead className="border-b border-white/[0.06] bg-white/[0.02]">
            <tr className="text-left">
              <Th>Domain</Th>
              <Th>Type</Th>
              <Th>Threat</Th>
              <Th>Status</Th>
              <Th>Signals</Th>
              <Th>Last seen</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-white/[0.03] last:border-b-0">
                <Td className="font-mono">
                  <span className={r.registered ? 'text-white/90' : 'text-white/40'}>{r.domain}</span>
                </Td>
                <Td className="text-white/55 capitalize">{r.permutation_type.replace(/_/g, ' ')}</Td>
                <Td><ThreatPill level={r.threat_level} /></Td>
                <Td><StatusPill status={r.status} /></Td>
                <Td>
                  <div className="flex items-center gap-1.5">
                    {r.registered === 1 && <SignalChip>registered</SignalChip>}
                    {r.has_web === 1 && <SignalChip>web</SignalChip>}
                    {r.has_mx === 1 && <SignalChip>mx</SignalChip>}
                  </div>
                </Td>
                <Td className="text-white/45 font-mono text-[11px]">
                  {r.last_checked ? new Date(r.last_checked).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'}
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
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

  return (
    <section>
      <h2 className="text-[11px] uppercase tracking-[0.18em] font-mono text-white/45 mb-3">
        Certificate Transparency <span className="text-white/30">({rows.length})</span>
      </h2>
      <div className="rounded-xl border border-white/[0.06] bg-bg-card overflow-hidden">
        <table className="w-full text-[12px]">
          <thead className="border-b border-white/[0.06] bg-white/[0.02]">
            <tr className="text-left">
              <Th>Domain</Th>
              <Th>Issuer</Th>
              <Th>Suspicious</Th>
              <Th>Status</Th>
              <Th>Issued</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-white/[0.03] last:border-b-0">
                <Td className="font-mono">{r.domain}</Td>
                <Td className="text-white/55 truncate max-w-[200px]">{r.issuer ?? '—'}</Td>
                <Td>
                  {r.suspicious === 1 ? (
                    <span className="text-amber">●</span>
                  ) : (
                    <span className="text-white/30">●</span>
                  )}
                </Td>
                <Td><CertStatusPill status={r.status} /></Td>
                <Td className="text-white/45 font-mono text-[11px]">
                  {new Date(r.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-3 py-2 text-[10px] uppercase tracking-widest font-mono text-white/45 font-normal">{children}</th>;
}

function Td({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-3 py-2.5 ${className}`}>{children}</td>;
}
