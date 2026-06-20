// Console — the analyst home: a two-stream supervision cockpit
// (TENANT_ANALYST_UX_RESEARCH_2026-06 §5.1).
//
//   ① "Needs you"      — items requiring a human: takedown drafts awaiting
//                        approval + new signals to triage. Actionable inline
//                        (reuses TakedownActions + AlertActions).
//   ② "Recently handled" — what's been resolved (auto-triage or by an
//                        analyst), with disposition shown.
//
// Composed entirely from existing endpoints (alerts + takedowns lists) — no
// new backend. KPIs are derived from the same queries.

import { Link } from 'react-router-dom';
import { Inbox, Bot, ArrowRight, ShieldAlert, Send, CheckCircle2, type LucideIcon } from 'lucide-react';
import { useTenantAlerts, useCanTriage, extractConfidence, type Alert, type AlertSeverity } from '@/lib/alerts';
import { useTenantTakedowns, takedownActionsFor, type TakedownListRow } from '@/lib/takedowns';
import { AlertActions, AssigneeControl } from '@/features/alerts/AlertActions';
import { VerdictChip } from '@/features/alerts/AiAssessment';
import { TakedownActions } from '@/features/takedowns/TakedownActions';
import { AgePill } from '@/components/AgePill';

const PREVIEW = 5;

export function Console() {
  const canTriage = useCanTriage();
  const newSignals = useTenantAlerts({ status: 'new', limit: PREVIEW });
  const resolved   = useTenantAlerts({ status: 'resolved', limit: 6 });
  const drafts     = useTenantTakedowns({ status: 'draft' });

  const signalCount  = newSignals.data?.total ?? 0;
  const draftRows    = drafts.data?.takedowns ?? [];
  const draftCount   = drafts.data?.totals.by_status?.draft ?? draftRows.length;
  const inFlight     = drafts.data?.totals.active ?? 0;
  const handledCount = resolved.data?.total ?? 0;
  const needsTotal   = signalCount + draftCount;

  return (
    <div className="max-w-5xl space-y-6">
      <header>
        <h1 className="text-[28px] font-bold text-white tracking-tight">Console</h1>
        <p className="mt-1 text-sm text-white/55 max-w-2xl">
          Your supervision cockpit — what needs a human, and what the platform handled on its own. Averrow runs autonomously by default; this is where you step in.
        </p>
      </header>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="Needs you" value={needsTotal} icon={Inbox} tone={needsTotal > 0 ? 'warn' : 'ok'} />
        <Kpi label="Drafts to approve" value={draftCount} icon={Send} tone={draftCount > 0 ? 'warn' : 'neutral'} />
        <Kpi label="Takedowns in flight" value={inFlight} icon={ShieldAlert} tone="neutral" />
        <Kpi label="Handled" value={handledCount} icon={CheckCircle2} tone="ok" />
      </div>

      {/* ① Needs you */}
      <section className="space-y-3">
        <StreamHeader icon={Inbox} title="Needs you" subtitle="Approvals and new signals awaiting a human" count={needsTotal} />

        {(newSignals.isLoading || drafts.isLoading) && <Loading />}

        {!drafts.isLoading && draftRows.length > 0 && (
          <div className="space-y-2">
            <SubLabel>Takedown drafts <Muted>· {draftCount}</Muted></SubLabel>
            {draftRows.slice(0, PREVIEW).map((t) => (
              <DraftRow key={t.id} takedown={t} canTriage={canTriage} />
            ))}
            {draftCount > PREVIEW && <ViewAll to="/takedowns" label={`View all ${draftCount} takedowns`} />}
          </div>
        )}

        {!newSignals.isLoading && (newSignals.data?.alerts.length ?? 0) > 0 && (
          <div className="space-y-2">
            <SubLabel>New signals <Muted>· {signalCount}</Muted></SubLabel>
            {(newSignals.data?.alerts ?? []).map((a) => (
              <SignalRow key={a.id} alert={a} canTriage={canTriage} />
            ))}
            {signalCount > PREVIEW && <ViewAll to="/alerts" label={`View all ${signalCount} signals`} />}
          </div>
        )}

        {!newSignals.isLoading && !drafts.isLoading && needsTotal === 0 && (
          <EmptyCard icon={CheckCircle2} title="You're all caught up" sub="No drafts to approve and no new signals. The automation has the rest." />
        )}
      </section>

      {/* ② Recently handled */}
      <section className="space-y-3">
        <StreamHeader icon={Bot} title="Recently handled" subtitle="Resolved by auto-triage or an analyst" count={handledCount} />
        {resolved.isLoading && <Loading />}
        {!resolved.isLoading && (resolved.data?.alerts.length ?? 0) === 0 && (
          <EmptyCard icon={Bot} title="Nothing handled yet" sub="Resolved signals will show here with how they were dispositioned." />
        )}
        {!resolved.isLoading && (resolved.data?.alerts.length ?? 0) > 0 && (
          <div className="rounded-xl border border-white/[0.06] bg-bg-card divide-y divide-white/[0.05]">
            {(resolved.data?.alerts ?? []).map((a) => <HandledRow key={a.id} alert={a} />)}
          </div>
        )}
        {handledCount > 6 && <ViewAll to="/alerts" label="View all signals" />}
      </section>
    </div>
  );
}

// ─── Needs-you rows ──────────────────────────────────────────

function DraftRow({ takedown: t, canTriage }: { takedown: TakedownListRow; canTriage: boolean }) {
  const actions = canTriage ? takedownActionsFor(t.status) : [];
  return (
    <div className="rounded-xl border border-white/[0.07] bg-bg-card">
      <Link to={`/takedowns/${t.id}`} className="block p-3.5 hover:bg-white/[0.02] rounded-t-xl">
        <div className="flex items-center gap-2 flex-wrap mb-1">
          <SeverityPill level={t.severity} />
          <AgePill createdAt={t.created_at} severity={t.severity} />
          {t.module_key && <Chip>{t.module_key.replace(/_/g, ' ')}</Chip>}
          <span className="text-[10px] uppercase tracking-widest font-mono text-white/35">{t.target_type}</span>
        </div>
        <div className="text-[13px] font-mono text-white/90 truncate">{t.target_value}</div>
        <div className="text-[11px] text-white/45 mt-0.5">{t.brand_name ?? t.brand_id}{t.provider_name ? ` · ${t.provider_name}` : ''}</div>
      </Link>
      {actions.length > 0 && (
        <TakedownActions takedownId={t.id} actions={actions} className="px-3.5 py-2 border-t border-white/[0.06]" />
      )}
    </div>
  );
}

function SignalRow({ alert: a, canTriage }: { alert: Alert; canTriage: boolean }) {
  const conf = extractConfidence(a.details);
  return (
    <div className="rounded-xl border border-white/[0.07] bg-bg-card p-3.5">
      <div className="flex items-center gap-2 flex-wrap mb-1">
        <SeverityPill level={a.severity} />
        <AgePill createdAt={a.created_at} severity={a.severity} />
        {conf !== null && <Chip>{conf}% conf</Chip>}
        <VerdictChip raw={a.ai_assessment} />
        <span className="text-[10px] uppercase tracking-widest font-mono text-white/35">{a.alert_type.replace(/_/g, ' ')}</span>
        <span className="ml-auto text-[10px] font-mono text-white/35">{a.brand_name}</span>
      </div>
      <div className="text-[13.5px] font-semibold text-white/90 leading-snug">{a.title}</div>
      <div className="mt-2"><AssigneeControl alert={a} canTriage={canTriage} /></div>
      {canTriage && <AlertActions alert={a} />}
    </div>
  );
}

function HandledRow({ alert: a }: { alert: Alert }) {
  return (
    <div className="flex items-start gap-3 px-4 py-3">
      <CheckCircle2 size={14} className="text-green/70 mt-0.5 flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-[12.5px] text-white/80 truncate">{a.title}</div>
        <div className="text-[11px] text-white/40 mt-0.5 font-mono">
          {a.status.replace(/_/g, ' ')}{a.resolution_notes ? ` · ${a.resolution_notes}` : ''} · {a.brand_name}
        </div>
      </div>
    </div>
  );
}

// ─── small parts ─────────────────────────────────────────────

function Kpi({ label, value, icon: Icon, tone }: { label: string; value: number; icon: LucideIcon; tone: 'warn' | 'ok' | 'neutral' }) {
  const accent = tone === 'warn' ? 'text-amber' : tone === 'ok' ? 'text-green/85' : 'text-white/85';
  return (
    <div className="rounded-xl border border-white/[0.06] bg-bg-card p-4">
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest font-mono text-white/40 mb-1">
        <Icon size={11} /><span className="truncate">{label}</span>
      </div>
      <div className={`text-3xl font-bold tabular-nums ${accent}`}>{value}</div>
    </div>
  );
}

function StreamHeader({ icon: Icon, title, subtitle, count }: { icon: LucideIcon; title: string; subtitle: string; count: number }) {
  return (
    <div className="flex items-center gap-2.5">
      <Icon size={16} className="text-white/55" />
      <h2 className="text-[15px] font-bold text-white/90">{title}</h2>
      <span className="text-[11px] font-mono text-white/35">{count}</span>
      <span className="text-[11px] text-white/40 hidden sm:inline">· {subtitle}</span>
    </div>
  );
}

function SubLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-[10px] uppercase tracking-[0.18em] font-mono text-white/40 pt-1">{children}</div>;
}
function Muted({ children }: { children: React.ReactNode }) {
  return <span className="text-white/25">{children}</span>;
}

function ViewAll({ to, label }: { to: string; label: string }) {
  return (
    <Link to={to} className="inline-flex items-center gap-1 text-[11px] font-mono text-amber/80 hover:text-amber pt-0.5">
      {label} <ArrowRight size={11} />
    </Link>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center text-[10px] uppercase tracking-widest font-mono text-blue/85 bg-blue/[0.06] border border-blue/[0.15] rounded px-1.5 py-0.5">
      {children}
    </span>
  );
}

function SeverityPill({ level }: { level: string | AlertSeverity }) {
  const sev = (level ?? '').toLowerCase();
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

function EmptyCard({ icon: Icon, title, sub }: { icon: LucideIcon; title: string; sub: string }) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-bg-card p-8 text-center">
      <Icon size={26} className="mx-auto text-white/30 mb-2" />
      <p className="text-sm text-white/70">{title}</p>
      <p className="text-[11px] text-white/40 mt-1">{sub}</p>
    </div>
  );
}

function Loading() {
  return <div className="text-white/40 text-sm font-mono py-8 text-center">Loading…</div>;
}
