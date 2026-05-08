// Tenant Billing — read-only summary.
//
// Mirrors the super_admin Customer Pricing tab in averrow-ops, but
// scoped to the caller's own org and presented as a customer-facing
// surface (no edit forms; no override-create UI; no Stripe IDs
// surfaced).
//
// Plan upgrade / downgrade / payment-method updates land in
// sprint 6 via Stripe Checkout + the customer portal.
//
// v3 Phase D Stripe sprint 5.

import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft, AlertTriangle, CheckCircle2, CreditCard, Clock, ExternalLink } from 'lucide-react';
import {
  useBillingSummary,
  useCheckoutSession,
  usePortalSession,
  formatCents,
  BILLING_STATUS_LABELS,
  type BillingSummary,
  type BillingPlan,
} from '@/lib/billing';

export function Billing() {
  const { data, isLoading, error } = useBillingSummary();
  const [searchParams] = useSearchParams();
  const checkoutResult = searchParams.get('checkout'); // 'success' | 'cancelled' | null

  return (
    <div className="max-w-3xl space-y-6">
      <Link to="/settings" className="inline-flex items-center gap-1.5 text-[11px] font-mono text-white/40 hover:text-white/70">
        <ArrowLeft size={12} /> BACK TO SETTINGS
      </Link>

      <header>
        <div className="text-[11px] uppercase tracking-[0.18em] font-mono text-white/40">Settings</div>
        <h1 className="text-[28px] font-bold text-white tracking-tight">Billing</h1>
        <p className="mt-1 text-sm text-white/55 max-w-2xl">
          Your current plan, monthly total, and active modules.
        </p>
      </header>

      {checkoutResult === 'success' && (
        <div className="rounded-xl border border-green/[0.30] bg-green/[0.06] p-4 flex items-start gap-3">
          <CheckCircle2 className="text-green flex-shrink-0 mt-0.5" size={18} />
          <div>
            <p className="text-sm text-green">Subscription started successfully.</p>
            <p className="text-[12px] text-white/55 mt-1">
              Stripe will fire a webhook to activate your modules. Refresh this page in a few seconds if you don't see the change yet.
            </p>
          </div>
        </div>
      )}
      {checkoutResult === 'cancelled' && (
        <div className="rounded-xl border border-amber/[0.20] bg-amber/[0.04] p-4 flex items-start gap-3">
          <AlertTriangle className="text-amber flex-shrink-0 mt-0.5" size={18} />
          <p className="text-sm text-amber/85">Checkout cancelled. No changes were made.</p>
        </div>
      )}

      {isLoading && <div className="text-white/40 text-sm font-mono py-12 text-center">Loading billing…</div>}
      {error && (
        <div className="rounded-xl border border-sev-critical/[0.30] bg-sev-critical/[0.06] p-6">
          <h3 className="text-sm font-semibold text-white/90">Couldn't load billing</h3>
          <p className="text-[12px] text-white/55 mt-1">{error.message}</p>
        </div>
      )}

      {data && (
        <>
          <StatusCard summary={data} />
          <PlanCard summary={data} />
          {data.per_module_subscriptions.length > 0 && <ModulesCard summary={data} />}
          <ManageBillingCard summary={data} />
          {data.active_overrides.length > 0 && <AdjustmentsCard summary={data} />}
        </>
      )}
    </div>
  );
}

// ─── Manage billing (Checkout + portal) ────────────────────────

function ManageBillingCard({ summary }: { summary: BillingSummary }) {
  const checkout = useCheckoutSession();
  const portal   = usePortalSession();

  const startCheckout = async (planId: string) => {
    try {
      const result = await checkout.mutateAsync({ plan_id: planId });
      window.location.href = result.url;
    } catch {
      // surfaced inline below
    }
  };

  const openPortal = async () => {
    try {
      const result = await portal.mutateAsync({});
      window.location.href = result.url;
    } catch {
      // surfaced inline below
    }
  };

  // Customer already has a Stripe subscription → "Manage billing"
  // (portal flow handles plan changes, payment method, invoices,
  // cancellation).
  if (summary.billing_status === 'active' || summary.billing_status === 'trialing' ||
      summary.billing_status === 'past_due' || summary.billing_status === 'cancelled') {
    return (
      <section className="rounded-xl border border-white/[0.10] bg-bg-card p-5">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-sm font-semibold text-white/90">Manage billing</h2>
            <p className="text-[12px] text-white/55 mt-1 max-w-md">
              Update payment method, change plan, view invoices, or cancel — all in Stripe's secure customer portal.
            </p>
          </div>
          <button
            type="button"
            onClick={openPortal}
            disabled={portal.isPending}
            className="inline-flex items-center gap-1.5 px-4 py-2 bg-amber text-[#0a0a0a] rounded-lg font-semibold text-sm hover:bg-amber-dim disabled:opacity-55 disabled:cursor-not-allowed transition-colors"
          >
            {portal.isPending ? 'Opening…' : <>Manage in Stripe <ExternalLink size={14} /></>}
          </button>
        </div>
        {portal.error && (
          <p className="text-[12px] text-sev-critical mt-2">
            {portal.error instanceof Error ? portal.error.message : String(portal.error)}
          </p>
        )}
      </section>
    );
  }

  // Unbilled — offer to start a subscription. We don't have a plan
  // picker yet (sprint 7); for now, the customer signs up via
  // /scan + a sales conversation, and an internal admin sets the
  // plan_id. Show the support email as the next step.
  return (
    <section className="rounded-xl border border-amber/[0.20] bg-amber/[0.04] p-5">
      <h2 className="text-sm font-semibold text-amber/95 mb-1">Start your subscription</h2>
      <p className="text-[12px] text-white/65 mt-1 max-w-md leading-relaxed">
        You're not on a billed plan yet. Once your trial is approved, click the button below to subscribe.
      </p>
      {summary.plan?.id && summary.plan.is_active && (
        <button
          type="button"
          onClick={() => startCheckout(summary.plan!.id)}
          disabled={checkout.isPending}
          className="inline-flex items-center gap-1.5 mt-3 px-4 py-2 bg-amber text-[#0a0a0a] rounded-lg font-semibold text-sm hover:bg-amber-dim disabled:opacity-55 disabled:cursor-not-allowed transition-colors"
        >
          {checkout.isPending ? 'Opening Stripe…' : <>Subscribe — {summary.plan.display_name} <ExternalLink size={14} /></>}
        </button>
      )}
      {!summary.plan && (
        <p className="text-[12px] text-white/55 mt-3">
          Contact <a className="text-amber hover:underline" href="mailto:support@averrow.com">support@averrow.com</a> to choose a plan.
        </p>
      )}
      {checkout.error && (
        <p className="text-[12px] text-sev-critical mt-2">
          {checkout.error instanceof Error ? checkout.error.message : String(checkout.error)}
        </p>
      )}
    </section>
  );
}

function StatusCard({ summary }: { summary: BillingSummary }) {
  const tone = statusTone(summary.billing_status);
  const Icon =
    summary.billing_status === 'active'   ? CheckCircle2 :
    summary.billing_status === 'trialing' ? Clock :
    summary.billing_status === 'past_due' ? AlertTriangle :
                                            CreditCard;
  return (
    <section className="rounded-xl border border-white/[0.10] bg-bg-card p-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="text-[10px] uppercase tracking-widest font-mono text-white/40 mb-1">
            Effective monthly total
          </div>
          <div className="text-[36px] font-bold text-white tabular-nums">
            {formatCents(summary.effective_monthly_total_cents)}
          </div>
          {summary.active_overrides.length > 0 && (
            <p className="text-[11px] text-white/45 mt-1">
              {summary.active_overrides.length} pricing adjustment{summary.active_overrides.length === 1 ? '' : 's'} applied
            </p>
          )}
        </div>
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-widest font-mono text-white/40 mb-1">
            Status
          </div>
          <div className={`inline-flex items-center gap-1.5 text-sm font-semibold ${tone}`}>
            <Icon size={14} />
            {BILLING_STATUS_LABELS[summary.billing_status] ?? summary.billing_status}
          </div>
          {summary.trial_ends_at && summary.billing_status === 'trialing' && (
            <p className="text-[11px] text-white/55 font-mono mt-2">
              trial ends {formatDate(summary.trial_ends_at)}
            </p>
          )}
        </div>
      </div>
      {summary.billing_status === 'past_due' && (
        <div className="mt-4 pt-4 border-t border-sev-critical/[0.30]">
          <p className="text-[12px] text-sev-critical">
            Your last invoice didn't go through. Update your payment method to avoid losing access. Stripe will retry automatically; if all retries fail, modules will suspend.
          </p>
        </div>
      )}
      {summary.billing_status === 'unbilled' && !summary.plan && (
        <div className="mt-4 pt-4 border-t border-white/[0.06]">
          <p className="text-[12px] text-white/55">
            Your organization isn't on a billed plan yet. Contact{' '}
            <a className="text-amber hover:underline" href="mailto:support@averrow.com">support@averrow.com</a> to start your trial.
          </p>
        </div>
      )}
    </section>
  );
}

function PlanCard({ summary }: { summary: BillingSummary }) {
  if (!summary.plan) {
    return (
      <section className="rounded-xl border border-white/[0.06] bg-bg-card p-5">
        <h2 className="text-sm font-semibold text-white/90">Plan</h2>
        <p className="text-[12px] text-white/55 mt-1">
          No plan assigned yet.
        </p>
      </section>
    );
  }
  const tierOverride = summary.active_overrides.find((o) => o.override_type === 'tier_price');
  const baseline     = summary.plan.monthly_price_cents;
  const overridden   = tierOverride?.custom_price_cents ?? baseline;
  const isOverridden = tierOverride !== undefined;

  return (
    <section className="rounded-xl border border-white/[0.06] bg-bg-card p-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="text-[10px] uppercase tracking-widest font-mono text-white/40 mb-1">
            Current plan
          </div>
          <h2 className="text-lg font-semibold text-white/95">{summary.plan.display_name}</h2>
          {summary.plan.description && (
            <p className="text-[12px] text-white/55 mt-1 max-w-md">{summary.plan.description}</p>
          )}
        </div>
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-widest font-mono text-white/40 mb-1">
            Monthly
          </div>
          <div className="tabular-nums font-mono">
            {isOverridden ? (
              <>
                <span className="line-through text-white/35 text-sm mr-2">{formatCents(baseline)}</span>
                <span className="text-white font-semibold text-base">{formatCents(overridden)}</span>
              </>
            ) : (
              <span className="text-white font-semibold text-base">{formatCents(baseline)}</span>
            )}
          </div>
        </div>
      </div>
      <div className="mt-4 pt-4 border-t border-white/[0.06]">
        <PlanIncludedRow plan={summary.plan} />
      </div>
    </section>
  );
}

function PlanIncludedRow({ plan }: { plan: BillingPlan }) {
  return (
    <>
      <div className="text-[10px] uppercase tracking-widest font-mono text-white/35 mb-2">
        Included modules
      </div>
      {plan.included_modules.length === 0 ? (
        <p className="text-[12px] text-white/45">None — contact sales for a custom plan.</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {plan.included_modules.map((m) => (
            <span
              key={m}
              className="text-[11px] font-mono text-white/65 bg-white/[0.04] border border-white/[0.08] rounded px-1.5 py-0.5"
            >
              {m}
            </span>
          ))}
        </div>
      )}
    </>
  );
}

function ModulesCard({ summary }: { summary: BillingSummary }) {
  const moduleOverrides = summary.active_overrides.filter((o) => o.override_type === 'module_price');
  return (
    <section className="rounded-xl border border-white/[0.06] bg-bg-card p-5">
      <div className="text-[10px] uppercase tracking-widest font-mono text-white/40 mb-3">
        À-la-carte modules
      </div>
      <div className="space-y-2">
        {summary.per_module_subscriptions.map((m) => {
          const ovr = moduleOverrides.find((o) => o.module_key === m.module_key);
          const isOverridden = ovr !== undefined;
          const effective = ovr?.custom_price_cents ?? m.price_cents;
          return (
            <div
              key={m.module_key}
              className="flex items-center justify-between gap-3 py-2 border-b border-white/[0.04] last:border-b-0"
            >
              <span className="text-sm text-white/85 font-mono">{m.module_key}</span>
              <div className="tabular-nums font-mono text-sm">
                {isOverridden ? (
                  <>
                    <span className="line-through text-white/35 text-xs mr-2">{formatCents(m.price_cents)}</span>
                    <span className="text-white">{formatCents(effective)}</span>
                  </>
                ) : (
                  <span className="text-white">{formatCents(m.price_cents)}</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function AdjustmentsCard({ summary }: { summary: BillingSummary }) {
  return (
    <section className="rounded-xl border border-white/[0.06] bg-bg-card p-5">
      <h3 className="text-[11px] uppercase tracking-widest font-mono text-white/45 mb-2">
        Active pricing adjustments
      </h3>
      <ul className="space-y-1.5">
        {summary.active_overrides.map((o) => (
          <li key={o.id} className="text-[12px] text-white/65">
            <span className="font-mono text-amber/80">
              {o.override_type === 'discount_percent'
                ? `${o.discount_pct}% off`
                : formatCents(o.custom_price_cents ?? 0)}
            </span>
            {' — '}
            {o.reason}
          </li>
        ))}
      </ul>
    </section>
  );
}

function statusTone(status: string): string {
  if (status === 'active')    return 'text-green';
  if (status === 'trialing')  return 'text-amber';
  if (status === 'past_due')  return 'text-sev-critical';
  if (status === 'cancelled') return 'text-white/55';
  return 'text-white/55';
}

function formatDate(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
