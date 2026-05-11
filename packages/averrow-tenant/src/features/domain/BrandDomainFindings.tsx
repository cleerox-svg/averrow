// Domain Monitoring — per-brand drill-down.
//
// Lists lookalike domain rows + CT certificate rows for one brand.
// Pre-filtered by org scope server-side. Pagination + filters land
// in subsequent sprints; this is the read surface that proves the
// data flows end-to-end.

import { Link, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { useBrandDomainFindings, type LookalikeRow, type CertRow } from '@/lib/domainModule';
import { useDomainModuleSummary } from '@/lib/domainModule';

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
          <LookalikesSection rows={data.lookalikes} />
          <CertsSection rows={data.certs} />
        </>
      )}
    </div>
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
