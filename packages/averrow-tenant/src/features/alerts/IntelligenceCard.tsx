// Intelligence Card — the working investigation surface for a single signal
// (TENANT_ANALYST_UX_RESEARCH_2026-06 §5.3). Upgrades the read-only inline
// signal card into a tabbed detail: Overview/Risk · Evidence · Infrastructure
// (DNS/WHOIS/certs, threat-sourced only) · Related & pivot · Activity. Actions
// (triage + assignee) live in a sticky right rail. Deep-linkable at
// /alerts/:alertId via GET /api/orgs/:orgId/alerts/:alertId.

import { useState, type ReactNode } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  ArrowLeft, ShieldAlert, Network, GitBranch, Clock, FileSearch, Sparkles,
  ExternalLink, type LucideIcon,
} from 'lucide-react';
import { useAlert, useCanTriage, extractConfidence, type Alert, type AlertSeverity } from '@/lib/alerts';
import { useThreatDetail } from '@/lib/threats';
import type { ThreatRow } from '@averrow/shared/threats-table';
import { AiAssessmentPanel } from './AiAssessment';
import { AlertActions, AssigneeControl } from './AlertActions';
import { AddToInvestigation } from '@/features/investigations/AddToInvestigation';
import { AgePill } from '@/components/AgePill';

type TabKey = 'overview' | 'evidence' | 'infrastructure' | 'related' | 'activity';

export function IntelligenceCard() {
  const { alertId } = useParams<{ alertId: string }>();
  const canTriage = useCanTriage();
  const { data: alert, isLoading, error } = useAlert(alertId);

  // Enrichment backing only exists for threat-sourced signals.
  const threatId = alert?.source_type === 'threat' ? alert.source_id : null;
  const { data: threat } = useThreatDetail(threatId);

  const [tab, setTab] = useState<TabKey>('overview');

  if (isLoading) {
    return <div className="text-white/40 text-sm font-mono py-16 text-center">Loading signal…</div>;
  }
  if (error || !alert) {
    return (
      <div className="max-w-2xl">
        <BackLink />
        <section className="mt-4 rounded-xl border border-sev-critical/[0.30] bg-sev-critical/[0.06] p-6">
          <p className="text-sm text-white/70">
            {error instanceof Error ? error.message : 'Signal not found.'}
          </p>
        </section>
      </div>
    );
  }

  const hasInfra = !!threat;
  const tabs: Array<{ key: TabKey; label: string; icon: LucideIcon; show: boolean }> = [
    { key: 'overview',       label: 'Overview',       icon: ShieldAlert, show: true },
    { key: 'evidence',       label: 'Evidence',       icon: FileSearch,  show: true },
    { key: 'infrastructure', label: 'Infrastructure', icon: Network,     show: hasInfra },
    { key: 'related',        label: 'Related',        icon: GitBranch,   show: true },
    { key: 'activity',       label: 'Activity',       icon: Clock,       show: true },
  ];
  const activeTab = tabs.find((t) => t.key === tab && t.show) ? tab : 'overview';

  return (
    <div className="max-w-5xl space-y-5">
      <BackLink />

      {/* Header */}
      <header>
        <div className="flex items-center gap-2 flex-wrap">
          <SeverityPill level={alert.severity} />
          <ConfidencePill value={extractConfidence(alert.details)} />
          <StatusPill status={alert.status} />
          {alert.status !== 'resolved' && alert.status !== 'false_positive' && (
            <AgePill createdAt={alert.created_at} severity={alert.severity} />
          )}
          <span className="text-[10px] font-mono text-white/40 uppercase tracking-wider">
            {alert.alert_type.replace(/_/g, ' ')}
          </span>
        </div>
        <h1 className="text-[22px] font-bold text-white tracking-tight mt-2 leading-snug">{alert.title}</h1>
        <div className="mt-1 text-[12px] text-white/45 font-mono flex items-center gap-2 flex-wrap">
          <span className="text-white/65">{alert.brand_name}</span>
          {alert.brand_domain && <span>· {alert.brand_domain}</span>}
          <span>· opened {new Date(alert.created_at).toLocaleString()}</span>
        </div>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-5 items-start">
        {/* Main column */}
        <div className="min-w-0 space-y-4">
          {/* Tab bar */}
          <div className="flex items-center gap-1 flex-wrap border-b border-white/[0.07] pb-2">
            {tabs.filter((t) => t.show).map((t) => {
              const on = activeTab === t.key;
              const Icon = t.icon;
              return (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setTab(t.key)}
                  className={[
                    'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] transition-colors',
                    on ? 'bg-amber/[0.10] text-amber' : 'text-white/55 hover:text-white/90 hover:bg-white/[0.04]',
                  ].join(' ')}
                >
                  <Icon size={13} />{t.label}
                </button>
              );
            })}
          </div>

          {activeTab === 'overview'       && <OverviewTab alert={alert} />}
          {activeTab === 'evidence'       && <EvidenceTab alert={alert} threat={threat ?? null} />}
          {activeTab === 'infrastructure' && threat && <InfrastructureTab threat={threat} />}
          {activeTab === 'related'        && <RelatedTab alert={alert} threat={threat ?? null} />}
          {activeTab === 'activity'       && <ActivityTab alert={alert} />}
        </div>

        {/* Right rail — actions */}
        <aside className="space-y-4 lg:sticky lg:top-4">
          <section className="rounded-xl border border-white/[0.07] bg-bg-card p-4">
            <div className="text-[9px] uppercase tracking-[0.18em] font-mono text-white/40 mb-2.5">Disposition</div>
            <div className="flex items-center justify-between gap-2">
              <StatusPill status={alert.status} />
              <AssigneeControl alert={alert} canTriage={canTriage} />
            </div>
            {canTriage ? (
              <AlertActions alert={alert} />
            ) : (
              <p className="mt-3 pt-2.5 border-t border-white/[0.06] text-[11px] text-white/45 font-mono">
                Analyst role required to act.
              </p>
            )}
          </section>

          {canTriage && (
            <section className="rounded-xl border border-white/[0.07] bg-bg-card p-4">
              <div className="text-[9px] uppercase tracking-[0.18em] font-mono text-white/40 mb-2.5">Investigation</div>
              <AddToInvestigation itemType="alert" itemId={alert.id} defaultTitle={alert.title} />
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}

// ─── Tabs ────────────────────────────────────────────────────

function OverviewTab({ alert }: { alert: Alert }) {
  const recs = parseRecommendations(alert.ai_recommendations);
  return (
    <div className="space-y-4">
      {alert.summary && (
        <section className="rounded-xl border border-white/[0.06] bg-bg-card p-4">
          <p className="text-[13px] text-white/75 leading-relaxed">{alert.summary}</p>
          <AiAssessmentPanel raw={alert.ai_assessment} />
        </section>
      )}

      {recs.length > 0 && (
        <section className="rounded-xl border border-amber/[0.16] bg-amber/[0.04] p-4">
          <div className="text-[9px] uppercase tracking-[0.18em] font-mono text-amber/70 mb-2 flex items-center gap-1.5">
            <Sparkles size={11} /> Recommended actions
          </div>
          <ul className="space-y-1.5">
            {recs.map((r, i) => (
              <li key={i} className="flex gap-2 text-[12px] text-white/75 leading-relaxed">
                <span className="text-amber/60 flex-shrink-0 mt-[2px]">▸</span><span>{r}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {alert.resolution_notes && (alert.status === 'resolved' || alert.status === 'false_positive') && (
        <section className="rounded-xl border border-white/[0.06] bg-bg-card p-4">
          <div className="text-[9px] uppercase tracking-[0.18em] font-mono text-white/40 mb-1.5">Disposition note</div>
          <p className="text-[12px] text-white/70 italic">{alert.resolution_notes}</p>
        </section>
      )}
    </div>
  );
}

function EvidenceTab({ alert, threat }: { alert: Alert; threat: ThreatRow | null }) {
  const rows = parseEvidenceRows(alert.details);
  return (
    <div className="space-y-4">
      <Panel title="Signal evidence" sub="The detection details captured when this signal was raised.">
        {rows.length > 0
          ? <DefList rows={rows} />
          : <Empty>No structured evidence attached to this signal.</Empty>}
      </Panel>

      {threat && (
        <Panel title="Reputation" sub="Multi-vendor verdicts on the underlying threat at decision time.">
          <ReputationGrid threat={threat} />
        </Panel>
      )}
    </div>
  );
}

function InfrastructureTab({ threat }: { threat: ThreatRow }) {
  const dns: Array<[string, ReactNode]> = [
    ['Domain', threat.malicious_domain],
    ['URL', threat.malicious_url],
    ['IP address', threat.ip_address],
    ['ASN', threat.asn],
    ['Hosting provider', threat.hosting_provider],
    ['Country', threat.country_code],
  ];
  const whois: Array<[string, ReactNode]> = [
    ['Registrar', threat.registrar],
    ['Registered', fmtDate(threat.registration_date)],
    ['First seen', fmtDate(threat.first_seen)],
    ['Last seen', fmtDate(threat.last_seen)],
    ['Source feed', threat.source_feed],
  ];
  return (
    <div className="space-y-4">
      <Panel title="DNS & hosting" sub="Where the malicious infrastructure resolves and is hosted.">
        <DefList rows={dns.filter(([, v]) => present(v))} />
      </Panel>
      <Panel title="WHOIS & lineage" sub="Registration and first/last-observed timeline.">
        <DefList rows={whois.filter(([, v]) => present(v))} />
      </Panel>
    </div>
  );
}

function RelatedTab({ alert, threat }: { alert: Alert; threat: ThreatRow | null }) {
  const rows: Array<[string, ReactNode]> = [
    ['Brand', alert.brand_name],
    ['Campaign', threat?.campaign_id],
    ['Cluster', threat?.cluster_id],
    ['Actor', threat?.actor_name ?? threat?.actor_id],
    ['Technique', threat?.saas_technique_name ?? threat?.saas_technique_id],
  ].filter(([, v]) => present(v)) as Array<[string, ReactNode]>;

  return (
    <div className="space-y-4">
      <Panel title="Correlation" sub="How this signal links into the broader threat picture.">
        {rows.length > 0 ? <DefList rows={rows} /> : <Empty>No correlations recorded yet.</Empty>}
      </Panel>
      <Panel title="Pivot" sub="Jump to the wider evidence around this brand.">
        <div className="flex flex-col gap-2">
          <PivotLink to={`/threats?brand=${alert.brand_id}`}>
            All threats for {alert.brand_name}
          </PivotLink>
          <PivotLink to="/alerts">Back to the signals queue</PivotLink>
        </div>
      </Panel>
    </div>
  );
}

function ActivityTab({ alert }: { alert: Alert }) {
  type Ev = { at: string | null; label: string; note?: string | null };
  const events: Ev[] = [];
  events.push({ at: alert.created_at, label: 'Signal raised' });
  if (alert.acknowledged_at) events.push({ at: alert.acknowledged_at, label: 'Acknowledged' });
  if (alert.assigned_to_name) events.push({ at: null, label: `Assigned to ${alert.assigned_to_name}` });
  if (alert.resolved_at) {
    events.push({
      at: alert.resolved_at,
      label: alert.status === 'false_positive' ? 'Marked false positive' : 'Resolved',
      note: alert.resolution_notes,
    });
  }

  return (
    <Panel title="Activity" sub="Chronology of automation + analyst actions on this signal.">
      <ol className="space-y-3">
        {events.map((e, i) => (
          <li key={i} className="flex gap-3">
            <div className="mt-1 w-1.5 h-1.5 rounded-full bg-amber/70 flex-shrink-0" />
            <div className="min-w-0">
              <div className="text-[12px] text-white/80">{e.label}</div>
              {e.at && <div className="text-[10px] font-mono text-white/40">{new Date(e.at).toLocaleString()}</div>}
              {e.note && <div className="text-[11px] text-white/55 italic mt-0.5">{e.note}</div>}
            </div>
          </li>
        ))}
      </ol>
    </Panel>
  );
}

// ─── Reputation ──────────────────────────────────────────────

function ReputationGrid({ threat: t }: { threat: ThreatRow }) {
  const items: Array<{ label: string; value: string; bad: boolean } | null> = [
    t.vt_checked ? { label: 'VirusTotal', value: `${t.vt_malicious ?? 0} malicious`, bad: (t.vt_malicious ?? 0) > 0 } : null,
    t.gsb_checked ? { label: 'Safe Browsing', value: t.gsb_flagged ? (t.gsb_threat_type ?? 'flagged') : 'clean', bad: !!t.gsb_flagged } : null,
    t.surbl_checked ? { label: 'SURBL', value: t.surbl_listed ? 'listed' : 'clean', bad: !!t.surbl_listed } : null,
    t.greynoise_checked ? { label: 'GreyNoise', value: t.greynoise_classification ?? 'unknown', bad: t.greynoise_classification === 'malicious' } : null,
    t.seclookup_checked && t.seclookup_risk_score != null ? { label: 'SecLookup risk', value: `${t.seclookup_risk_score}`, bad: (t.seclookup_risk_score ?? 0) >= 30 } : null,
    t.abuseipdb_checked && t.abuseipdb_score != null ? { label: 'AbuseIPDB', value: `${t.abuseipdb_score}% · ${t.abuseipdb_reports ?? 0} reports`, bad: (t.abuseipdb_score ?? 0) >= 25 } : null,
  ];
  const shown = items.filter((x): x is { label: string; value: string; bad: boolean } => !!x);
  if (shown.length === 0) return <Empty>No reputation vendors were consulted.</Empty>;
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
      {shown.map((it) => (
        <div key={it.label} className={`rounded-lg border px-2.5 py-2 ${it.bad ? 'border-sev-critical/[0.25] bg-sev-critical/[0.06]' : 'border-white/[0.08] bg-white/[0.02]'}`}>
          <div className="text-[9px] uppercase tracking-wider font-mono text-white/40">{it.label}</div>
          <div className={`text-[12px] font-medium mt-0.5 ${it.bad ? 'text-sev-critical' : 'text-white/75'}`}>{it.value}</div>
        </div>
      ))}
    </div>
  );
}

// ─── Small parts ─────────────────────────────────────────────

function BackLink() {
  return (
    <Link to="/alerts" className="inline-flex items-center gap-1.5 text-[12px] font-mono text-white/50 hover:text-white/85 transition-colors">
      <ArrowLeft size={14} /> Signals
    </Link>
  );
}

function Panel({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-white/[0.06] bg-bg-card p-4">
      <h3 className="text-sm font-semibold text-white/90">{title}</h3>
      {sub && <p className="text-[12px] text-white/45 mt-0.5 mb-3">{sub}</p>}
      {!sub && <div className="mb-3" />}
      {children}
    </section>
  );
}

function DefList({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2.5">
      {rows.map(([k, v]) => (
        <div key={k} className="flex flex-col gap-0.5 min-w-0">
          <dt className="text-[9px] uppercase tracking-wider font-mono text-white/40">{k}</dt>
          <dd className="text-[12.5px] text-white/80 break-words font-mono">{present(v) ? v : '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="text-[12px] text-white/35">{children}</p>;
}

function PivotLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="inline-flex items-center gap-1.5 text-[12px] text-blue hover:text-blue/80 transition-colors">
      <ExternalLink size={12} /> {children}
    </Link>
  );
}

function SeverityPill({ level }: { level: AlertSeverity | string }) {
  const sev = (level ?? '').toLowerCase();
  const tone =
    sev === 'critical' ? 'text-sev-critical bg-sev-critical/[0.10] border-sev-critical/[0.20]' :
    sev === 'high'     ? 'text-amber        bg-amber/[0.10]        border-amber/[0.20]'        :
    sev === 'medium'   ? 'text-amber/70     bg-amber/[0.06]        border-amber/[0.10]'        :
                         'text-white/55     bg-white/[0.04]        border-white/[0.08]';
  return <span className={`inline-flex items-center text-[10px] uppercase tracking-widest font-mono border rounded px-1.5 py-0.5 ${tone}`}>{sev}</span>;
}

const STATUS_TONE: Record<string, string> = {
  new:            'text-blue       bg-blue/[0.08]        border-blue/[0.18]',
  acknowledged:   'text-amber      bg-amber/[0.08]       border-amber/[0.18]',
  investigating:  'text-amber      bg-amber/[0.08]       border-amber/[0.18]',
  resolved:       'text-green/85   bg-green/[0.06]       border-green/[0.15]',
  false_positive: 'text-white/50   bg-white/[0.04]       border-white/[0.08]',
};

function StatusPill({ status }: { status: string }) {
  const tone = STATUS_TONE[status] ?? 'text-white/55 bg-white/[0.04] border-white/[0.08]';
  return <span className={`inline-flex items-center text-[10px] uppercase tracking-widest font-mono border rounded px-1.5 py-0.5 ${tone}`}>{status.replace(/_/g, ' ')}</span>;
}

function ConfidencePill({ value }: { value: number | null }) {
  if (value == null) return null;
  return (
    <span className="inline-flex items-center text-[10px] uppercase tracking-widest font-mono border rounded px-1.5 py-0.5 text-white/60 bg-white/[0.04] border-white/[0.08]">
      {value}% conf
    </span>
  );
}

// ─── Helpers ─────────────────────────────────────────────────

function present(v: ReactNode): boolean {
  return v !== null && v !== undefined && v !== '';
}

function fmtDate(v: string | null | undefined): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleDateString();
}

// ai_recommendations is sometimes a JSON-encoded array, sometimes plain text.
function parseRecommendations(raw: string | null): string[] {
  if (!raw) return [];
  const t = raw.trim();
  if (t.startsWith('[')) {
    try {
      const arr = JSON.parse(t);
      if (Array.isArray(arr)) return arr.map((x) => String(x).trim()).filter(Boolean);
    } catch { /* fall through */ }
  }
  return [t];
}

// Flatten the alert's details JSON into label/value rows, with friendly
// labels for the known impersonation shapes and a generic fallback.
const DETAIL_LABELS: Record<string, string> = {
  platform: 'Platform', handle: 'Handle', url: 'URL', score: 'Impersonation score',
  impersonation_score: 'Impersonation score', check_type: 'Check type',
  store: 'Store', app_id: 'App ID', bundle_id: 'Bundle ID', app_name: 'App name',
  developer_name: 'Developer', developer_id: 'Developer ID', app_url: 'App URL',
};

function parseEvidenceRows(raw: string | null): Array<[string, ReactNode]> {
  if (!raw) return [];
  let obj: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    obj = parsed as Record<string, unknown>;
  } catch {
    return [];
  }
  const rows: Array<[string, ReactNode]> = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined || v === '') continue;
    if (typeof v === 'object') continue; // skip nested signals arrays etc.
    const label = DETAIL_LABELS[k] ?? k.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
    let display: string = String(v);
    if ((k === 'score' || k === 'impersonation_score') && typeof v === 'number') {
      display = v <= 1 ? `${Math.round(v * 100)}%` : `${v}`;
    }
    rows.push([label, display]);
  }
  return rows;
}
