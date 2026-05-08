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

import { useMemo, useState } from "react";
import {
  useScanLeads,
  useUpdateScanLead,
  useGenerateQualifiedReport,
  useSendOutreach,
  useConvertToTenant,
  type ScanLead,
} from "@/hooks/useScanLeads";
import { Card, Badge, Button, PageHeader, StatGrid, StatCard } from "@/design-system/components";
import { Table, Th, Td } from "@/components/ui/Table";
import { TableLoader } from "@/components/ui/PageLoader";
import { EmptyState } from "@/components/ui/EmptyState";
import { useToast } from "@/components/ui/Toast";
import { relativeTime } from "@/lib/time";
import { Inbox } from "lucide-react";

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
  const { data, isLoading } = useScanLeads(
    statusFilter === "all" ? undefined : { status: statusFilter },
  );
  const stats = data?.stats;
  const leads = data?.leads ?? [];

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
                : "border-white/10 text-[var(--text-secondary,rgba(255,255,255,0.60))] hover:border-white/20",
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
                {leads.map((lead) => <ScanLeadRow key={lead.id} lead={lead} />)}
              </tbody>
            </Table>
          </div>

          {/* Mobile stacked cards */}
          <div className="md:hidden space-y-3">
            {leads.map((lead) => <ScanLeadCard key={lead.id} lead={lead} />)}
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

function ScanLeadRow({ lead }: { lead: ScanLead }) {
  const actions = useLeadActions(lead);

  return (
    <tr className="hover:bg-white/[0.02]">
      <Td>
        <Badge severity={STATUS_BADGE[lead.status]}>{lead.status.replace("_", " ")}</Badge>
      </Td>
      <Td>
        <div className="font-mono text-xs text-[var(--text-primary,rgba(255,255,255,0.92))]">{lead.email}</div>
        {lead.name ? (
          <div className="text-[10px] text-[var(--text-tertiary,rgba(255,255,255,0.40))]">{lead.name}</div>
        ) : null}
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
      <Td className="text-xs text-[var(--text-secondary,rgba(255,255,255,0.60))]">
        {relativeTime(lead.created_at)}
      </Td>
      <Td>
        <ActionMenu lead={lead} actions={actions} />
      </Td>
    </tr>
  );
}

// ─── Card (mobile) ────────────────────────────────────────────────

function ScanLeadCard({ lead }: { lead: ScanLead }) {
  const actions = useLeadActions(lead);
  return (
    <div className="border border-white/5 p-3 space-y-2 bg-white/[0.02]">
      <div className="flex items-center justify-between gap-2">
        <Badge severity={STATUS_BADGE[lead.status]}>{lead.status.replace("_", " ")}</Badge>
        <span className="text-[10px] text-[var(--text-tertiary,rgba(255,255,255,0.40))] font-mono">
          {relativeTime(lead.created_at)}
        </span>
      </div>
      <div>
        <div className="font-mono text-xs text-[var(--text-primary,rgba(255,255,255,0.92))]">{lead.email}</div>
        <div className="text-[11px] text-[var(--text-secondary,rgba(255,255,255,0.60))]">
          {lead.name ?? "—"} · {lead.company ?? "—"}
        </div>
        <div className="font-mono text-[11px] mt-1">{lead.domain ?? "—"}</div>
      </div>
      <FunnelStateChips lead={lead} />
      <ActionMenu lead={lead} actions={actions} />
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
          : { color: "rgba(255,255,255,0.30)", borderColor: "rgba(255,255,255,0.06)" }
      }
    >
      {children}
    </span>
  );
}

// ─── Actions ─────────────────────────────────────────────────────

interface LeadActions {
  generateReport: () => void;
  sendOutreach: () => void;
  convertToTenant: () => void;
  markStatus: (status: ScanLead["status"]) => void;
  isWorking: boolean;
}

function useLeadActions(lead: ScanLead): LeadActions {
  const { showToast } = useToast();
  const update = useUpdateScanLead();
  const generate = useGenerateQualifiedReport();
  const outreach = useSendOutreach();
  const convert = useConvertToTenant();

  return {
    isWorking: update.isPending || generate.isPending || outreach.isPending || convert.isPending,
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
