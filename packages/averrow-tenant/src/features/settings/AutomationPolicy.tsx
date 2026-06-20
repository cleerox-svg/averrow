// Automation Policy — first-class surface for the org's autonomy posture.
//
// The takedown-authorization scope already IS the automation policy
// (modules covered, high-risk approval gate, escalation, monthly cap, SLA
// follow-up); it just lived buried in the signing flow. This page promotes
// it to a clear "how much runs autonomously vs waits for a human" view,
// mapped to the auto-handle / require-approval model
// (TENANT_ANALYST_UX_RESEARCH_2026-06 §5.5). Editing still happens in the
// signing flow (it carries the agreement copy), linked from here.

import { Link } from 'react-router-dom';
import { ShieldCheck, UserCheck, Hand, ArrowRight, Bot, type LucideIcon } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import {
  useTakedownAuthorization,
  canSignAuthorization,
  ESCALATION_LABELS,
  type TakedownAuthorization,
} from '@/lib/takedownAuthorization';

type Posture = 'manual' | 'supervised' | 'autonomous';

const POSTURE_ORDER: Posture[] = ['manual', 'supervised', 'autonomous'];

const POSTURE_META: Record<Posture, { label: string; icon: LucideIcon; blurb: string; accent: string }> = {
  manual: {
    label: 'Manual',
    icon: Hand,
    blurb: 'Averrow drafts takedowns and triages signals, but submits nothing to a provider without a human.',
    accent: 'text-white/80',
  },
  supervised: {
    label: 'Supervised',
    icon: UserCheck,
    blurb: 'Routine takedowns auto-submit within scope; high-risk ones wait in your queue for approval.',
    accent: 'text-amber',
  },
  autonomous: {
    label: 'Autonomous',
    icon: ShieldCheck,
    blurb: 'Takedowns auto-submit within your signed scope. You supervise via the queue and can withdraw any request.',
    accent: 'text-green/90',
  },
};

function derivePosture(auth: TakedownAuthorization | null): Posture {
  if (!auth || auth.status !== 'active') return 'manual';
  return auth.scope.high_risk_requires_per_takedown_approval ? 'supervised' : 'autonomous';
}

export function AutomationPolicy() {
  const { user } = useAuth();
  const { data, isLoading, error } = useTakedownAuthorization();
  const auth = data?.authorization ?? null;
  const posture = derivePosture(auth);
  const canEdit = canSignAuthorization(user?.role, user?.organization?.role);

  return (
    <div className="max-w-3xl space-y-6">
      <header>
        <div className="text-[11px] uppercase tracking-[0.18em] font-mono text-white/40">Account</div>
        <h1 className="text-[24px] font-bold text-white tracking-tight">Automation Policy</h1>
        <p className="mt-1 text-sm text-white/55 max-w-2xl">
          How much of the remediation pipeline runs autonomously versus waiting for a human. Averrow is autonomous by default; this is the dial you turn the other way when your org wants a person in the loop.
        </p>
      </header>

      {isLoading && <div className="text-white/40 text-sm font-mono py-12 text-center">Loading…</div>}
      {error && (
        <section className="rounded-xl border border-sev-critical/[0.30] bg-sev-critical/[0.06] p-5">
          <h2 className="text-sm font-semibold text-white/90">Couldn't load policy</h2>
          <p className="text-[12px] text-white/55 mt-1">{error instanceof Error ? error.message : 'Unknown error'}</p>
        </section>
      )}

      {!isLoading && !error && (
        <>
          <PostureDial posture={posture} />
          <TakedownPolicy auth={auth} />
          <SignalAutomation />
          <AdjustFooter canEdit={canEdit} hasAuth={!!auth && auth.status === 'active'} />
        </>
      )}
    </div>
  );
}

function PostureDial({ posture }: { posture: Posture }) {
  const meta = POSTURE_META[posture];
  const Icon = meta.icon;
  return (
    <section className="rounded-xl border border-white/[0.08] bg-bg-card p-5">
      <div className="flex items-start gap-3">
        <div className="rounded-lg bg-white/[0.04] border border-white/[0.08] p-2">
          <Icon size={20} className={meta.accent} />
        </div>
        <div className="flex-1">
          <div className="text-[10px] uppercase tracking-widest font-mono text-white/40">Current posture</div>
          <div className={`text-lg font-bold ${meta.accent}`}>{meta.label}</div>
          <p className="text-[12px] text-white/60 mt-1 leading-relaxed">{meta.blurb}</p>
        </div>
      </div>

      {/* The dial: Manual ─ Supervised ─ Autonomous */}
      <div className="mt-4 flex items-stretch gap-1.5">
        {POSTURE_ORDER.map((p) => {
          const active = p === posture;
          return (
            <div
              key={p}
              className={[
                'flex-1 rounded-md border px-2 py-1.5 text-center text-[10px] font-mono uppercase tracking-wider transition-colors',
                active
                  ? 'bg-amber/[0.12] text-amber border-amber/[0.35]'
                  : 'bg-white/[0.02] text-white/35 border-white/[0.06]',
              ].join(' ')}
            >
              {POSTURE_META[p].label}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function TakedownPolicy({ auth }: { auth: TakedownAuthorization | null }) {
  if (!auth || auth.status !== 'active') {
    return (
      <section className="rounded-xl border border-white/[0.06] bg-bg-card p-5">
        <SectionTitle icon={ShieldCheck} title="Takedowns" subtitle="Your policy" />
        <p className="text-[13px] text-white/70">
          No takedown authorization is on file, so Averrow will <strong className="text-white/90">draft</strong> takedown
          requests but never submit them. Approve drafts individually from the Takedowns queue, or sign an authorization
          to let routine submissions run automatically.
        </p>
      </section>
    );
  }

  const s = auth.scope;
  return (
    <section className="rounded-xl border border-white/[0.06] bg-bg-card p-5">
      <SectionTitle icon={ShieldCheck} title="Takedowns" subtitle="Your policy" />
      <div className="space-y-2.5">
        <PolicyRow
          level={s.high_risk_requires_per_takedown_approval ? 'approval' : 'auto'}
          label="High-risk takedowns"
          value={s.high_risk_requires_per_takedown_approval ? 'Require your approval' : 'Auto-submit within scope'}
        />
        <PolicyRow
          level="auto"
          label="Covered modules"
          value={s.modules.length === 0 ? 'None' : s.modules.join(' · ')}
        />
        <PolicyRow
          level="guardrail"
          label="Escalation"
          value={ESCALATION_LABELS[s.escalation] ?? s.escalation}
        />
        <PolicyRow
          level="guardrail"
          label="Monthly cap"
          value={s.max_takedowns_per_month === null ? 'Unlimited' : `${s.max_takedowns_per_month.toLocaleString()} / month`}
        />
        <PolicyRow
          level="guardrail"
          label="Auto follow-up"
          value={s.auto_followup_breached_sla_hours === null ? 'Off' : `After ${s.auto_followup_breached_sla_hours}h SLA breach`}
        />
      </div>
    </section>
  );
}

// Signal-side automation is platform-managed (alert-triage + AI judge), not
// org-configurable — surface it so the posture is honest about everything
// that runs without a human, not just takedowns.
function SignalAutomation() {
  return (
    <section className="rounded-xl border border-white/[0.06] bg-bg-card p-5">
      <SectionTitle icon={Bot} title="Signals" subtitle="Platform-managed" />
      <div className="space-y-2.5">
        <PolicyRow level="auto" label="Benign signals" value="Auto-dismissed (rule-based triage)" />
        <PolicyRow level="auto" label="High-confidence AI verdict" value="Auto-resolved only at ≥ 90% confidence" />
        <PolicyRow level="approval" label="Everything else" value="Surfaced in Signals for your review" />
      </div>
      <p className="text-[11px] text-white/40 mt-3 leading-relaxed">
        Signal auto-triage is tuned by Averrow and applies to every org; it never auto-actions an external provider. You can re-open anything it resolved from the Signals queue.
      </p>
    </section>
  );
}

function AdjustFooter({ canEdit, hasAuth }: { canEdit: boolean; hasAuth: boolean }) {
  return (
    <section className="rounded-xl border border-white/[0.06] bg-bg-card p-5 flex items-start justify-between gap-4 flex-wrap">
      <div>
        <h3 className="text-sm font-semibold text-white/90">Adjust this policy</h3>
        <p className="text-[12px] text-white/55 mt-1 max-w-md">
          {hasAuth
            ? 'Changing scope or the approval gate is done in the takedown-authorization flow, which records a fresh signature.'
            : 'Authorize automated takedowns to move off a fully manual posture.'}
        </p>
      </div>
      {canEdit ? (
        <Link
          to="/settings/takedown-authorization"
          className="inline-flex items-center gap-1.5 px-4 py-2 bg-amber/[0.12] hover:bg-amber/[0.18] text-amber border border-amber/[0.35] rounded-lg font-semibold text-sm transition-colors whitespace-nowrap"
        >
          {hasAuth ? 'Manage authorization' : 'Authorize takedowns'} <ArrowRight size={14} />
        </Link>
      ) : (
        <span className="text-[11px] text-white/45 font-mono self-center">Org admin or owner required</span>
      )}
    </section>
  );
}

// ─── small parts ─────────────────────────────────────────────

const LEVEL_META: Record<'auto' | 'approval' | 'guardrail', { dot: string; tag: string }> = {
  auto:      { dot: 'bg-green/80',  tag: 'Auto' },
  approval:  { dot: 'bg-amber',     tag: 'Approval' },
  guardrail: { dot: 'bg-white/30',  tag: 'Guardrail' },
};

function PolicyRow({ level, label, value }: { level: 'auto' | 'approval' | 'guardrail'; label: string; value: string }) {
  const m = LEVEL_META[level];
  return (
    <div className="flex items-center gap-3">
      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${m.dot}`} title={m.tag} />
      <span className="text-[12px] text-white/55 w-40 flex-shrink-0">{label}</span>
      <span className="text-[12.5px] text-white/85">{value}</span>
    </div>
  );
}

function SectionTitle({ icon: Icon, title, subtitle }: { icon: LucideIcon; title: string; subtitle: string }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <Icon size={14} className="text-white/45" />
      <h3 className="text-sm font-semibold text-white/90">{title}</h3>
      <span className="text-[10px] uppercase tracking-widest font-mono text-white/35">· {subtitle}</span>
    </div>
  );
}
