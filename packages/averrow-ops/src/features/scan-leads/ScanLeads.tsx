// Admin view for the public-scan funnel — `scan_leads` table.
//
// Distinct from sales_leads (Pathfinder). This page shows leads
// coming in from the homepage scan widget, with full sales-funnel
// actions: generate qualified report, send outreach email, convert
// to tenant.
//
// Mobile + desktop responsive — table on desktop, stacked cards
// on mobile so the action buttons remain reachable.
//
// Composition: `ScanLeadsView` is the inner content (stats +
// filters + table/cards). `ScanLeads` wraps it with the standalone
// PageHeader. Both are exported so the Leads page can drop the
// view in as a tab without the duplicate header.

import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  useScanLeads,
  useScanLead,
  useUpdateScanLead,
  useGenerateQualifiedReport,
  useRenewQualifiedReport,
  useReportAndOutreach,
  useSendOutreach,
  useConvertToTenant,
  type ScanLead,
  type ScanLeadIntel,
  type CorrelatedSalesLead,
} from "@/hooks/useScanLeads";
import { Card, Badge, Button, PageHeader, StatGrid, StatCard } from "@/design-system/components";
import { Table, Th, Td } from "@/components/ui/Table";
import { TableLoader } from "@/components/ui/PageLoader";
import { EmptyState } from "@/components/ui/EmptyState";
import { useToast } from "@/components/ui/Toast";
import { relativeTime } from "@/lib/time";
import { Inbox, ArrowLeft, ExternalLink, ShieldCheck, Globe, Server, Copy } from "lucide-react";

const STATUS_FILTERS = ["all", "new", "contacted", "qualified", "converted", "closed_lost"] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

const STATUS_BADGE: Record<ScanLead["status"], "info" | "high" | "medium" | "low" | "critical"> = {
  new: "info",
  contacted: "low",
  qualified: "medium",
  converted: "high",
  closed_lost: "critical",
};

// ─── Inner content (reusable as a tab in Leads page) ─────────────

export function ScanLeadsView() {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [searchParams, setSearchParams] = useSearchParams();
  // `?lead=<id>` opens the drill-down — the "New lead" notification
  // deep-links straight here.
  const selectedLeadId = searchParams.get("lead");
  const { data, isLoading } = useScanLeads(
    statusFilter === "all" ? undefined : { status: statusFilter },
  );
  const stats = data?.stats;
  const leads = data?.leads ?? [];

  function openLead(id: string) {
    const next = new URLSearchParams(searchParams);
    next.set("lead", id);
    setSearchParams(next, { replace: false });
  }

  function closeLead() {
    const next = new URLSearchParams(searchParams);
    next.delete("lead");
    setSearchParams(next, { replace: false });
  }

  if (selectedLeadId) {
    return <ScanLeadDetail leadId={selectedLeadId} onBack={closeLead} />;
  }

  return (
    <div className="space-y-6">
      {stats ? (
        <StatGrid>
          <StatCard label="Total" value={stats.total ?? 0} />
          <StatCard label="New" value={stats.new_leads ?? 0} />
          <StatCard label="Contacted" value={stats.contacted ?? 0} />
          <StatCard label="Qualified" value={stats.qualified ?? 0} />
          <StatCard label="Converted" value={stats.converted ?? 0} />
        </StatGrid>
      ) : null}

      {/* Status filter pills */}
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Filter scan leads by status">
        {STATUS_FILTERS.map((s) => (
          <button
            key={s}
            role="tab"
            aria-selected={statusFilter === s}
            onClick={() => setStatusFilter(s)}
            className={[
              "px-3 py-1 text-xs font-mono uppercase tracking-wider rounded-sm border transition-colors",
              statusFilter === s
                ? "bg-[var(--amber,#E5A832)]/15 border-[var(--amber,#E5A832)] text-[var(--amber,#E5A832)]"
                : "border-white/10 text-[var(--text-secondary,var(--text-secondary))] hover:border-white/20",
            ].join(" ")}
          >
            {s.replace("_", " ")}
          </button>
        ))}
      </div>

      {isLoading ? (
        <TableLoader />
      ) : leads.length === 0 ? (
        <EmptyState
          icon={<Inbox className="w-10 h-10" />}
          title="No leads yet"
          description="Public scan submissions will land here once the homepage form receives traffic."
        />
      ) : (
        <Card>
          {/* Desktop table */}
          <div className="hidden md:block">
            <Table>
              <thead>
                <tr>
                  <Th>Status</Th>
                  <Th>Email</Th>
                  <Th>Domain</Th>
                  <Th>Company</Th>
                  <Th>Funnel state</Th>
                  <Th>Submitted</Th>
                  <Th>Actions</Th>
                </tr>
              </thead>
              <tbody>
                {leads.map((lead) => <ScanLeadRow key={lead.id} lead={lead} onOpen={openLead} />)}
              </tbody>
            </Table>
          </div>

          {/* Mobile stacked cards */}
          <div className="md:hidden space-y-3">
            {leads.map((lead) => <ScanLeadCard key={lead.id} lead={lead} onOpen={openLead} />)}
          </div>
        </Card>
      )}
    </div>
  );
}

// ─── Standalone page wrapper (kept so the legacy /admin/scan-leads
// route still resolves). The Leads page imports `ScanLeadsView`
// directly, without this header.

export function ScanLeads() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Scan Leads"
        subtitle="Public scan funnel — leads from the homepage scan widget. Generate the Brand Risk Plan, send outreach, then convert to a tenant once qualified."
      />
      <ScanLeadsView />
    </div>
  );
}

// ─── Row (desktop table) ──────────────────────────────────────────

function ScanLeadRow({ lead, onOpen }: { lead: ScanLead; onOpen: (id: string) => void }) {
  const actions = useLeadActions(lead);

  return (
    <tr
      className="hover:bg-white/[0.04] cursor-pointer"
      onClick={() => onOpen(lead.id)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter") onOpen(lead.id); }}
      aria-label={`Open lead ${lead.email}`}
    >
      <Td>
        <Badge severity={STATUS_BADGE[lead.status]}>{lead.status.replace("_", " ")}</Badge>
      </Td>
      <Td>
        <div className="font-mono text-xs text-[var(--text-primary,var(--text-primary))]">{lead.email}</div>
        <div className="text-[10px] text-[var(--text-tertiary,var(--text-tertiary))]">
          {lead.name ? `${lead.name} · ` : ""}<span className="font-mono">#{shortId(lead.id)}</span>
        </div>
      </Td>
      <Td>
        <div className="font-mono text-xs">{lead.domain ?? "—"}</div>
        {lead.correlated_brand_id ? (
          <div className="text-[10px] text-[var(--green,#3CB878)]">✓ correlated</div>
        ) : null}
      </Td>
      <Td className="text-xs">{lead.company ?? "—"}</Td>
      <Td>
        <FunnelStateChips lead={lead} />
      </Td>
      <Td className="text-xs text-[var(--text-secondary,var(--text-secondary))]">
        {relativeTime(lead.created_at)}
      </Td>
      <Td>
        <div onClick={(e) => e.stopPropagation()}>
          <ActionMenu lead={lead} actions={actions} />
        </div>
      </Td>
    </tr>
  );
}

// ─── Card (mobile) ────────────────────────────────────────────────

function ScanLeadCard({ lead, onOpen }: { lead: ScanLead; onOpen: (id: string) => void }) {
  const actions = useLeadActions(lead);
  return (
    <div
      className="border border-white/5 p-3 space-y-2 bg-white/[0.02] cursor-pointer hover:bg-white/[0.04]"
      onClick={() => onOpen(lead.id)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter") onOpen(lead.id); }}
      aria-label={`Open lead ${lead.email}`}
    >
      <div className="flex items-center justify-between gap-2">
        <Badge severity={STATUS_BADGE[lead.status]}>{lead.status.replace("_", " ")}</Badge>
        <span className="text-[10px] text-[var(--text-tertiary,var(--text-tertiary))] font-mono">
          {relativeTime(lead.created_at)}
        </span>
      </div>
      <div>
        <div className="font-mono text-xs text-[var(--text-primary,var(--text-primary))]">{lead.email}</div>
        <div className="text-[11px] text-[var(--text-secondary,var(--text-secondary))]">
          {lead.name ?? "—"} · {lead.company ?? "—"}
        </div>
        <div className="font-mono text-[11px] mt-1">
          {lead.domain ?? "—"} <span className="text-[var(--text-tertiary,var(--text-tertiary))]">· #{shortId(lead.id)}</span>
        </div>
      </div>
      <FunnelStateChips lead={lead} />
      <div onClick={(e) => e.stopPropagation()}>
        <ActionMenu lead={lead} actions={actions} />
      </div>
    </div>
  );
}

// ─── Funnel state chips ───────────────────────────────────────────

function FunnelStateChips({ lead }: { lead: ScanLead }) {
  return (
    <div className="flex flex-wrap gap-1">
      <Chip on={lead.correlated_brand_id != null}>brand</Chip>
      <Chip on={lead.outreach_sent_at != null}>outreach</Chip>
      <Chip on={lead.converted_org_id != null}>tenant</Chip>
    </div>
  );
}

function Chip({ on, children }: { on: boolean; children: React.ReactNode }) {
  return (
    <span
      className="text-[9px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded-sm border"
      style={
        on
          ? { background: "rgba(60,184,120,0.10)", color: "var(--green,#3CB878)", borderColor: "rgba(60,184,120,0.3)" }
          : { color: "var(--text-muted)", borderColor: "var(--border-base)" }
      }
    >
      {children}
    </span>
  );
}

// ─── Actions ─────────────────────────────────────────────────────

interface LeadActions {
  generateReport: () => void;
  reportAndOutreach: () => void;
  renewReport: () => void;
  sendOutreach: () => void;
  convertToTenant: () => void;
  markStatus: (status: ScanLead["status"]) => void;
  isWorking: boolean;
}

function useLeadActions(lead: ScanLead): LeadActions {
  const { showToast } = useToast();
  const update = useUpdateScanLead();
  const generate = useGenerateQualifiedReport();
  const reportSend = useReportAndOutreach();
  const renew = useRenewQualifiedReport();
  const outreach = useSendOutreach();
  const convert = useConvertToTenant();

  return {
    isWorking:
      update.isPending ||
      generate.isPending ||
      reportSend.isPending ||
      renew.isPending ||
      outreach.isPending ||
      convert.isPending,
    markStatus: (status) => {
      update.mutate(
        { id: lead.id, status },
        {
          onSuccess: () => showToast(`Marked as ${status.replace("_", " ")}`, "success"),
          onError: () => showToast("Update failed", "error"),
        },
      );
    },
    generateReport: () => {
      generate.mutate(lead.id, {
        onSuccess: (res) => {
          if (!res?.share_url) return;
          // Copy the share URL to the clipboard for convenience
          navigator.clipboard?.writeText(res.share_url).catch(() => undefined);
          showToast(`Report generated · share URL copied (${res.risk_grade} risk)`, "success");
          window.open(res.share_url, "_blank", "noopener,noreferrer");
        },
        onError: (e) => showToast(`Report generation failed: ${(e as Error).message}`, "error"),
      });
    },
    reportAndOutreach: () => {
      reportSend.mutate(lead.id, {
        onSuccess: (res) => {
          if (res?.share_url) {
            navigator.clipboard?.writeText(res.share_url).catch(() => undefined);
          }
          showToast(`Report generated & emailed to ${res?.sent_to ?? "the prospect"}`, "success");
        },
        onError: (e) => showToast(`Generate & send failed: ${(e as Error).message}`, "error"),
      });
    },
    renewReport: () => {
      renew.mutate(lead.id, {
        onSuccess: (res) => {
          if (res?.share_url) {
            navigator.clipboard?.writeText(res.share_url).catch(() => undefined);
          }
          const until = res?.expires_at ? new Date(res.expires_at).toLocaleDateString() : "30 days out";
          showToast(`Report renewed · link valid until ${until} (share URL copied)`, "success");
        },
        onError: (e) => showToast(`Renew failed: ${(e as Error).message}`, "error"),
      });
    },
    sendOutreach: () => {
      outreach.mutate(lead.id, {
        onSuccess: (res) => showToast(`Outreach sent to ${res?.sent_to}`, "success"),
        onError: (e) => showToast(`Outreach failed: ${(e as Error).message}`, "error"),
      });
    },
    convertToTenant: () => {
      if (!confirm(`Convert lead to tenant for ${lead.domain ?? "this domain"}? This creates an organization with you as owner.`)) return;
      convert.mutate(
        { id: lead.id, body: undefined },
        {
          onSuccess: (res) => {
            const created = res?.brand_was_created ? "new brand" : "existing brand";
            showToast(`Tenant created (org id ${res?.org_id}, ${created})`, "success");
          },
          onError: (e) => showToast(`Convert failed: ${(e as Error).message}`, "error"),
        },
      );
    },
  };
}

function ActionMenu({ lead, actions }: { lead: ScanLead; actions: LeadActions }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      <Button
        size="sm"
        variant="secondary"
        onClick={actions.generateReport}
        disabled={actions.isWorking || !lead.domain}
      >
        Report
      </Button>
      <Button
        size="sm"
        variant="secondary"
        onClick={actions.reportAndOutreach}
        disabled={actions.isWorking || !lead.domain}
      >
        Generate &amp; Send
      </Button>
      <Button
        size="sm"
        variant="secondary"
        onClick={actions.sendOutreach}
        disabled={actions.isWorking}
      >
        Outreach
      </Button>
      <Button
        size="sm"
        variant="primary"
        onClick={actions.convertToTenant}
        disabled={actions.isWorking || lead.converted_org_id != null || !lead.domain}
      >
        {lead.converted_org_id ? "Converted" : "Convert"}
      </Button>
      {lead.status !== "qualified" && lead.status !== "converted" ? (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => actions.markStatus("qualified")}
          disabled={actions.isWorking}
        >
          Qualify
        </Button>
      ) : null}
    </div>
  );
}

// ─── Drill-down: single lead + live customer intel ────────────────

// Every lead carries a UUID `id`; surface a short, copyable reference so
// otherwise-identical leads (same email + domain) are distinguishable and
// the deep-linked drill-down is unambiguous.
function shortId(id: string): string {
  return id.replace(/-/g, "").slice(0, 8).toUpperCase();
}

function gradeColor(g: string | null | undefined): string {
  if (!g) return "var(--text-tertiary,#8A8F9C)";
  const u = g.toUpperCase();
  if (u === "A" || u === "B" || u === "LOW") return "var(--green,#3CB878)";
  if (u === "C" || u === "MODERATE" || u === "MEDIUM") return "var(--amber,#E5A832)";
  return "var(--red,#C83C3C)";
}

const SEV_BADGE: Record<string, "info" | "high" | "medium" | "low" | "critical"> = {
  critical: "critical",
  high: "high",
  medium: "medium",
  low: "low",
  unknown: "info",
};

export function ScanLeadDetail({ leadId, onBack }: { leadId: string; onBack: () => void }) {
  const { data, isLoading, isError } = useScanLead(leadId);

  const backBtn = (
    <Button size="sm" variant="ghost" onClick={onBack}>
      <ArrowLeft className="w-4 h-4 mr-1" /> Back to leads
    </Button>
  );

  if (isLoading) {
    return (
      <div className="space-y-4">
        {backBtn}
        <TableLoader />
      </div>
    );
  }

  if (isError || !data?.lead) {
    return (
      <div className="space-y-4">
        {backBtn}
        <EmptyState
          icon={<Inbox className="w-10 h-10" />}
          title="Lead not found"
          description="This lead may have been removed, or the link is stale."
        />
      </div>
    );
  }

  return (
    <ScanLeadDetailBody
      lead={data.lead}
      intel={data.intel}
      correlatedSalesLead={data.correlated_sales_lead}
      backBtn={backBtn}
    />
  );
}

function ScanLeadDetailBody({
  lead,
  intel,
  correlatedSalesLead,
  backBtn,
}: {
  lead: ScanLead;
  intel: ScanLeadIntel | null;
  correlatedSalesLead: CorrelatedSalesLead | null;
  backBtn: React.ReactNode;
}) {
  const actions = useLeadActions(lead);
  const { showToast } = useToast();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        {backBtn}
        <div onClick={(e) => e.stopPropagation()}>
          <ActionMenu lead={lead} actions={actions} />
        </div>
      </div>

      {/* Identity header */}
      <Card>
        <div className="space-y-3">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <div className="font-mono text-lg text-[var(--text-primary,#fff)]">
                {lead.domain ?? "—"}
              </div>
              <div className="text-sm text-[var(--text-secondary,#7a8ba8)]">
                {lead.company ?? "Unknown company"}
              </div>
              <button
                type="button"
                title={`Copy full lead ID (${lead.id})`}
                onClick={() => {
                  navigator.clipboard?.writeText(lead.id).catch(() => undefined);
                  showToast("Lead ID copied", "success");
                }}
                className="mt-1 inline-flex items-center gap-1 font-mono text-[11px] text-[var(--text-tertiary,#8A8F9C)] hover:text-[var(--amber,#E5A832)]"
              >
                <Copy className="w-3 h-3" /> Lead #{shortId(lead.id)}
              </button>
            </div>
            <Badge severity={STATUS_BADGE[lead.status]}>{lead.status.replace("_", " ")}</Badge>
          </div>
          <FunnelStateChips lead={lead} />
        </div>
      </Card>

      {/* Cross-pipeline link — outbound sales prospect for the same company */}
      {correlatedSalesLead ? (
        <Card>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="text-sm">
              <h3 className="text-xs font-mono uppercase tracking-wider text-[var(--text-tertiary,#8A8F9C)]">
                Also an outbound prospect
              </h3>
              <div className="mt-1 text-[var(--text-secondary,#7a8ba8)]">
                {correlatedSalesLead.company_name ?? "Sales lead"}
                {correlatedSalesLead.prospect_score != null
                  ? ` · score ${correlatedSalesLead.prospect_score}`
                  : ""}
                {correlatedSalesLead.pitch_angle ? ` · ${correlatedSalesLead.pitch_angle}` : ""}
              </div>
              <div className="mt-1.5">
                <Badge severity="info">{correlatedSalesLead.status.replace("_", " ")}</Badge>
              </div>
            </div>
            <Link to={`/leads?lead=${correlatedSalesLead.id}`}>
              <Button size="sm" variant="secondary">
                View sales lead <ExternalLink className="w-3.5 h-3.5 ml-1" />
              </Button>
            </Link>
          </div>
        </Card>
      ) : null}

      {/* Contact */}
      <Card>
        <div className="space-y-3">
          <h3 className="text-xs font-mono uppercase tracking-wider text-[var(--text-tertiary,#8A8F9C)]">
            Contact
          </h3>
          <dl className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
            <Field label="Email" value={lead.email} mono />
            <Field label="Name" value={lead.name} />
            <Field label="Phone" value={lead.phone} />
            <Field label="Source" value={lead.source} />
            <Field label="Submitted" value={relativeTime(lead.created_at)} />
            {lead.converted_org_id != null ? (
              <Field label="Tenant org" value={`#${lead.converted_org_id}`} />
            ) : null}
          </dl>
          {lead.message ? (
            <div className="text-sm text-[var(--text-secondary,#7a8ba8)] border-l-2 border-white/10 pl-3">
              {lead.message}
            </div>
          ) : null}
        </div>
      </Card>

      {/* Customer intel */}
      {intel ? (
        <>
          {/* What we already know — has this domain surfaced before? */}
          <Card>
            <div className="space-y-2">
              <h3 className="text-xs font-mono uppercase tracking-wider text-[var(--text-tertiary,#8A8F9C)]">
                What we already know
              </h3>
              {intel.platform_history.known_brand ? (
                <div className="text-sm space-y-1">
                  <div>
                    Known brand:{" "}
                    <Link
                      to={`/brands/${intel.platform_history.known_brand.id}`}
                      className="text-[var(--amber,#E5A832)] hover:underline inline-flex items-center gap-1"
                    >
                      {intel.platform_history.known_brand.name}
                      <ExternalLink className="w-3 h-3" />
                    </Link>
                    {intel.platform_history.known_brand.sector ? (
                      <span className="text-[var(--text-tertiary,#8A8F9C)]"> · {intel.platform_history.known_brand.sector}</span>
                    ) : null}
                  </div>
                  <div className="text-[var(--text-secondary,#7a8ba8)]">
                    First seen {relativeTime(intel.platform_history.known_brand.first_seen)} ·{" "}
                    {intel.platform_history.known_brand.threat_count_all_time} threats on record
                  </div>
                </div>
              ) : (
                <div className="text-sm text-[var(--text-secondary,#7a8ba8)]">
                  First time we've seen <span className="font-mono">{intel.domain}</span> — not yet a tracked brand.
                </div>
              )}
              {intel.platform_history.prior_assessment ? (
                <div className="text-xs text-[var(--text-tertiary,#8A8F9C)]">
                  Last assessed {relativeTime(intel.platform_history.prior_assessment.assessed_at)} · Grade{" "}
                  <span style={{ color: gradeColor(intel.platform_history.prior_assessment.grade) }}>
                    {intel.platform_history.prior_assessment.grade ?? "—"}
                  </span>
                  {intel.platform_history.prior_assessment.trust_score != null
                    ? ` (${intel.platform_history.prior_assessment.trust_score})`
                    : ""}
                </div>
              ) : null}
            </div>
          </Card>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* Threat posture */}
            <Card>
              <div>
                <h3 className="text-xs font-mono uppercase tracking-wider text-[var(--text-tertiary,#8A8F9C)] flex items-center gap-1.5">
                  <Globe className="w-3.5 h-3.5" /> Active threats
                </h3>
                <div className="mt-2 text-3xl font-bold text-[var(--text-primary,#fff)]">
                  {intel.threats.active_total}
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                  {Object.entries(intel.threats.by_severity).map(([sev, n]) => (
                    <Badge key={sev} severity={SEV_BADGE[sev] ?? "info"}>
                      {sev}: {n}
                    </Badge>
                  ))}
                  {intel.threats.active_total === 0 ? (
                    <span className="text-xs text-[var(--green,#3CB878)]">No active threats</span>
                  ) : null}
                </div>
              </div>
            </Card>

            {/* Email security */}
            <Card>
              <div>
                <h3 className="text-xs font-mono uppercase tracking-wider text-[var(--text-tertiary,#8A8F9C)] flex items-center gap-1.5">
                  <ShieldCheck className="w-3.5 h-3.5" /> Email security
                </h3>
                {intel.email_security ? (
                  <>
                    <div
                      className="mt-2 text-3xl font-bold"
                      style={{ color: gradeColor(intel.email_security.grade) }}
                    >
                      {intel.email_security.grade ?? "—"}
                    </div>
                    <div className="mt-2 text-xs text-[var(--text-secondary,#7a8ba8)] space-y-0.5 font-mono">
                      <div>SPF: {intel.email_security.spf ?? "none"}</div>
                      <div>DMARC: {intel.email_security.dmarc ?? "none"}</div>
                      <div>MX records: {intel.email_security.mx_count}</div>
                    </div>
                  </>
                ) : (
                  <div className="mt-2 text-xs text-[var(--text-tertiary,#8A8F9C)]">
                    Not yet scanned — generate the report to populate.
                  </div>
                )}
              </div>
            </Card>

            {/* Lookalikes + brand link */}
            <Card>
              <div>
                <h3 className="text-xs font-mono uppercase tracking-wider text-[var(--text-tertiary,#8A8F9C)] flex items-center gap-1.5">
                  <Server className="w-3.5 h-3.5" /> Exposure
                </h3>
                <div className="mt-2 text-3xl font-bold text-[var(--text-primary,#fff)]">
                  {intel.lookalikes_count}
                </div>
                <div className="text-xs text-[var(--text-secondary,#7a8ba8)]">lookalike domains</div>
                {intel.correlated_brand ? (
                  <Link
                    to={`/brands/${intel.correlated_brand.id}`}
                    className="mt-3 inline-flex items-center gap-1 text-xs text-[var(--amber,#E5A832)] hover:underline"
                  >
                    {intel.correlated_brand.name} <ExternalLink className="w-3 h-3" />
                  </Link>
                ) : (
                  <div className="mt-3 text-xs text-[var(--text-tertiary,#8A8F9C)]">
                    Not yet a monitored brand
                  </div>
                )}
              </div>
            </Card>
          </div>

          {/* Infrastructure */}
          {intel.top_providers.length > 0 || intel.top_countries.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {intel.top_providers.length > 0 ? (
                <Card>
                  <div>
                    <h3 className="text-xs font-mono uppercase tracking-wider text-[var(--text-tertiary,#8A8F9C)] mb-3">
                      Top hosting providers
                    </h3>
                    <ul className="space-y-1.5 text-sm">
                      {intel.top_providers.map((p) => (
                        <li key={p.name} className="flex justify-between gap-2">
                          <span className="truncate">{p.name}</span>
                          <span className="font-mono text-[var(--text-secondary,#7a8ba8)]">{p.threat_count}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </Card>
              ) : null}
              {intel.top_countries.length > 0 ? (
                <Card>
                  <div>
                    <h3 className="text-xs font-mono uppercase tracking-wider text-[var(--text-tertiary,#8A8F9C)] mb-3">
                      Top source countries
                    </h3>
                    <ul className="space-y-1.5 text-sm">
                      {intel.top_countries.map((c) => (
                        <li key={c.country} className="flex justify-between gap-2">
                          <span className="font-mono">{c.country}</span>
                          <span className="font-mono text-[var(--text-secondary,#7a8ba8)]">{c.threat_count}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </Card>
              ) : null}
            </div>
          ) : null}

          {/* Recent threat samples */}
          {intel.threats.samples.length > 0 ? (
            <Card>
              <div>
                <h3 className="text-xs font-mono uppercase tracking-wider text-[var(--text-tertiary,#8A8F9C)] mb-3">
                  Recent threats targeting {intel.domain}
                </h3>
                <Table>
                  <thead>
                    <tr>
                      <Th>Severity</Th>
                      <Th>Type</Th>
                      <Th>Domain</Th>
                      <Th>Feed</Th>
                      <Th>First seen</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {intel.threats.samples.map((t) => (
                      <tr key={t.id}>
                        <Td>
                          <Badge severity={SEV_BADGE[t.severity ?? "unknown"] ?? "info"}>
                            {t.severity ?? "unknown"}
                          </Badge>
                        </Td>
                        <Td className="text-xs">{t.threat_type}</Td>
                        <Td className="font-mono text-xs">{t.malicious_domain ?? "—"}</Td>
                        <Td className="text-xs">{t.source_feed}</Td>
                        <Td className="text-xs text-[var(--text-secondary,#7a8ba8)]">{relativeTime(t.first_seen)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </div>
            </Card>
          ) : null}

          {/* Existing qualified report */}
          {intel.latest_report ? (
            <Card>
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div>
                  <h3 className="text-xs font-mono uppercase tracking-wider text-[var(--text-tertiary,#8A8F9C)]">
                    Qualified report
                  </h3>
                  <div className="mt-1 text-sm">
                    Risk grade:{" "}
                    <span style={{ color: gradeColor(intel.latest_report.risk_grade) }} className="font-semibold">
                      {intel.latest_report.risk_grade ?? "—"}
                    </span>
                    <span className="text-[var(--text-tertiary,#8A8F9C)]">
                      {" "}· generated {relativeTime(intel.latest_report.created_at)}
                    </span>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      navigator.clipboard
                        ?.writeText(`${window.location.origin}/qualified-report/${intel.latest_report!.share_token}`)
                        .catch(() => undefined);
                    }}
                  >
                    <Copy className="w-3.5 h-3.5 mr-1" /> Copy link
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={actions.renewReport}
                    disabled={actions.isWorking}
                    title="Rebuild with fresh data + reset the 30-day expiry, keeping the same share link"
                  >
                    Renew
                  </Button>
                  <a
                    href={`/qualified-report/${intel.latest_report.share_token}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <Button size="sm" variant="primary">
                      Open report <ExternalLink className="w-3.5 h-3.5 ml-1" />
                    </Button>
                  </a>
                </div>
              </div>
            </Card>
          ) : null}
        </>
      ) : !lead.domain ? (
        <EmptyState
          icon={<Globe className="w-10 h-10" />}
          title="No domain on this lead"
          description="This lead didn't include a domain, so there's no customer intel to show."
        />
      ) : (
        <EmptyState
          icon={<Globe className="w-10 h-10" />}
          title="Intel temporarily unavailable"
          description={`We couldn't load customer intel for ${lead.domain} right now. Try again in a moment.`}
        />
      )}
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: string | null; mono?: boolean }) {
  return (
    <div>
      <dt className="text-[10px] font-mono uppercase tracking-wider text-[var(--text-tertiary,#8A8F9C)]">
        {label}
      </dt>
      <dd className={`text-[var(--text-primary,#fff)] ${mono ? "font-mono text-xs" : "text-sm"} break-all`}>
        {value ?? "—"}
      </dd>
    </div>
  );
}
