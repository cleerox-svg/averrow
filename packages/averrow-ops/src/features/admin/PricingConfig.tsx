// Pricing Config — global super_admin page.
//
// Edits the BASELINE prices for plans + modules (the values stamped
// in migration 0153 plus any subsequent operator edits). Per-customer
// overrides live in SuperAdminOrgs > Pricing tab — this page is the
// global config that overrides layer ON TOP of.
//
// Sprint 3b of the Phase D Stripe track.

import { useState } from 'react';
import { useAuth } from '@/lib/auth';
import { roleHasPermission } from '@/lib/permissions';
import { Card } from '@/components/ui/Card';
import { SectionLabel } from '@/components/ui/SectionLabel';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import {
  usePricingPlans, useModulePrices,
  useUpdatePricingPlan, useUpdateModulePrice,
  formatCents,
  type PricingPlan, type ModulePrice,
} from '@/hooks/useAdminPricing';

export function PricingConfig() {
  // GM2: gate on the documented permission model (view_billing to read,
  // edit_pricing to change) instead of super_admin — the endpoints already
  // honor these flags, so sales/billing can use the page they're meant to.
  const { user } = useAuth();
  const canView = roleHasPermission(user?.role, 'view_billing');
  const canEdit = roleHasPermission(user?.role, 'edit_pricing');
  if (!canView) {
    return <EmptyState message="Access Denied" description="You don't have billing access to pricing config." />;
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <header>
        <h1 className="text-xl font-bold text-[color:var(--text-primary)] font-display">Pricing Config</h1>
        <p className="text-[12px] text-[color:var(--text-secondary)] mt-1">
          Baseline prices for tiers + modules. Per-customer overrides are managed
          in <code className="font-mono">/admin/customers/&lt;org&gt;</code> &gt; Pricing.
        </p>
      </header>

      <PlansSection canEdit={canEdit} />
      <ModulesSection canEdit={canEdit} />
    </div>
  );
}

// ─── Plans ───────────────────────────────────────────────────────

function PlansSection({ canEdit }: { canEdit: boolean }) {
  const { data, isLoading, error } = usePricingPlans();
  if (isLoading) return <div className="text-sm text-white/55 font-mono py-12 text-center">Loading plans…</div>;
  if (error)     return <Card hover={false} className="border-accent/20"><p className="text-sm text-accent">Couldn't load plans: {error.message}</p></Card>;
  if (!data)     return null;

  return (
    <section>
      <SectionLabel className="mb-3">Tiers</SectionLabel>
      <div className="space-y-3">
        {data.plans.map((p) => <PlanRow key={p.id} plan={p} canEdit={canEdit} />)}
      </div>
    </section>
  );
}

function PlanRow({ plan, canEdit }: { plan: PricingPlan; canEdit: boolean }) {
  const update = useUpdatePricingPlan();
  const [editing, setEditing] = useState(false);
  const [priceDollars, setPriceDollars]     = useState((plan.monthly_price_cents / 100).toString());
  const [trialDays,    setTrialDays]        = useState(plan.trial_days.toString());
  const [stripePriceId, setStripePriceId]   = useState(plan.stripe_price_id ?? '');
  const [isActive,     setIsActive]         = useState(plan.is_active);

  const reset = () => {
    setPriceDollars((plan.monthly_price_cents / 100).toString());
    setTrialDays(plan.trial_days.toString());
    setStripePriceId(plan.stripe_price_id ?? '');
    setIsActive(plan.is_active);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await update.mutateAsync({
        planId: plan.id,
        patch: {
          monthly_price_cents: Math.round(Number(priceDollars) * 100),
          trial_days:          Number(trialDays),
          stripe_price_id:     stripePriceId.trim() === '' ? null : stripePriceId.trim(),
          is_active:           isActive,
        },
      });
      setEditing(false);
    } catch {
      // surfaced inline below
    }
  };

  if (!editing) {
    return (
      <Card hover={false}>
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-base font-semibold text-[color:var(--text-primary)]">{plan.display_name}</h3>
              <Badge variant={plan.is_active ? 'success' : 'default'}>
                {plan.is_active ? 'active' : 'retired'}
              </Badge>
            </div>
            {plan.description && (
              <p className="text-[12px] text-[color:var(--text-secondary)] mt-1">{plan.description}</p>
            )}
            <div className="flex items-center gap-3 mt-2 flex-wrap">
              <span className="text-[11px] font-mono text-[color:var(--text-tertiary)]">id: {plan.id}</span>
              <span className="text-[11px] font-mono text-[color:var(--text-tertiary)]">trial: {plan.trial_days}d</span>
              {plan.stripe_price_id && (
                <span className="text-[11px] font-mono text-[color:var(--text-tertiary)]">stripe: {plan.stripe_price_id}</span>
              )}
            </div>
          </div>
          <div className="text-right">
            <div className="text-lg font-bold tabular-nums text-[color:var(--text-primary)]">
              {formatCents(plan.monthly_price_cents)}
            </div>
            <div className="text-[10px] uppercase tracking-widest font-mono text-[color:var(--text-tertiary)]">/ month</div>
            {canEdit && <Button variant="secondary" size="sm" onClick={() => setEditing(true)} className="mt-2">Edit</Button>}
          </div>
        </div>
        <div className="mt-3 pt-3 border-t border-white/[0.06]">
          <div className="text-[10px] uppercase tracking-widest font-mono text-[color:var(--text-tertiary)] mb-1.5">
            Included modules
          </div>
          <div className="flex flex-wrap gap-1.5">
            {plan.included_modules.length === 0 ? (
              <span className="text-[11px] text-[color:var(--text-tertiary)]">none</span>
            ) : plan.included_modules.map((m) => (
              <span key={m} className="text-[11px] font-mono text-[color:var(--text-secondary)] bg-white/[0.04] border border-white/[0.08] rounded px-1.5 py-0.5">
                {m}
              </span>
            ))}
          </div>
        </div>
      </Card>
    );
  }

  return (
    <Card hover={false}>
      <form onSubmit={submit} className="space-y-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <h3 className="text-base font-semibold text-[color:var(--text-primary)]">{plan.display_name}</h3>
          <span className="text-[11px] font-mono text-[color:var(--text-tertiary)]">id: {plan.id}</span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="block text-[11px] text-[color:var(--text-secondary)] font-mono uppercase tracking-wide mb-1">
              Monthly price (USD)
            </label>
            <Input type="number" min="0" step="0.01" value={priceDollars} onChange={(e) => setPriceDollars(e.target.value)} required />
          </div>
          <div>
            <label className="block text-[11px] text-[color:var(--text-secondary)] font-mono uppercase tracking-wide mb-1">
              Trial days
            </label>
            <Input type="number" min="0" step="1" value={trialDays} onChange={(e) => setTrialDays(e.target.value)} required />
          </div>
        </div>
        <div>
          <label className="block text-[11px] text-[color:var(--text-secondary)] font-mono uppercase tracking-wide mb-1">
            Stripe price ID (blank = unset)
          </label>
          <Input value={stripePriceId} onChange={(e) => setStripePriceId(e.target.value)} placeholder="price_..." />
        </div>
        <label className="flex items-center gap-2 text-[12px] text-[color:var(--text-secondary)]">
          <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
          Active (uncheck to retire)
        </label>
        {update.error && (
          <p className="text-[12px] text-accent">
            Update failed: {update.error instanceof Error ? update.error.message : String(update.error)}
          </p>
        )}
        <div className="flex items-center gap-2">
          <Button variant="primary" type="submit" disabled={update.isPending}>
            {update.isPending ? 'Saving…' : 'Save'}
          </Button>
          <Button variant="ghost" type="button" onClick={() => { reset(); setEditing(false); }} disabled={update.isPending}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}

// ─── Modules ─────────────────────────────────────────────────────

function ModulesSection({ canEdit }: { canEdit: boolean }) {
  const { data, isLoading, error } = useModulePrices();
  if (isLoading) return <div className="text-sm text-white/55 font-mono py-12 text-center">Loading module prices…</div>;
  if (error)     return <Card hover={false} className="border-accent/20"><p className="text-sm text-accent">Couldn't load module prices: {error.message}</p></Card>;
  if (!data)     return null;

  return (
    <section>
      <SectionLabel className="mb-3">Modules (à-la-carte)</SectionLabel>
      <div className="space-y-2">
        {data.modules.map((m) => <ModuleRow key={m.module_key} module={m} canEdit={canEdit} />)}
      </div>
    </section>
  );
}

function ModuleRow({ module: m, canEdit }: { module: ModulePrice; canEdit: boolean }) {
  const update = useUpdateModulePrice();
  const [editing, setEditing] = useState(false);
  const [priceDollars,  setPriceDollars]  = useState((m.monthly_price_cents / 100).toString());
  const [stripePriceId, setStripePriceId] = useState(m.stripe_price_id ?? '');
  const [isActive,      setIsActive]      = useState(m.is_active);

  const reset = () => {
    setPriceDollars((m.monthly_price_cents / 100).toString());
    setStripePriceId(m.stripe_price_id ?? '');
    setIsActive(m.is_active);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await update.mutateAsync({
        moduleKey: m.module_key,
        patch: {
          monthly_price_cents: Math.round(Number(priceDollars) * 100),
          stripe_price_id:     stripePriceId.trim() === '' ? null : stripePriceId.trim(),
          is_active:           isActive,
        },
      });
      setEditing(false);
    } catch {
      // surfaced inline
    }
  };

  if (!editing) {
    return (
      <Card hover={false}>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-[color:var(--text-primary)]">{m.display_name}</h3>
              <Badge variant={m.is_active ? 'success' : 'default'}>
                {m.is_active ? 'active' : 'retired'}
              </Badge>
            </div>
            <div className="flex items-center gap-3 mt-1 flex-wrap">
              <span className="text-[11px] font-mono text-[color:var(--text-tertiary)]">key: {m.module_key}</span>
              {m.stripe_price_id && (
                <span className="text-[11px] font-mono text-[color:var(--text-tertiary)]">stripe: {m.stripe_price_id}</span>
              )}
            </div>
          </div>
          <div className="text-right">
            <div className="text-base font-bold tabular-nums text-[color:var(--text-primary)]">
              {formatCents(m.monthly_price_cents)}
            </div>
            {canEdit && <Button variant="secondary" size="sm" onClick={() => setEditing(true)} className="mt-1">Edit</Button>}
          </div>
        </div>
      </Card>
    );
  }

  return (
    <Card hover={false}>
      <form onSubmit={submit} className="space-y-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <h3 className="text-sm font-semibold text-[color:var(--text-primary)]">{m.display_name}</h3>
          <span className="text-[11px] font-mono text-[color:var(--text-tertiary)]">key: {m.module_key}</span>
        </div>
        <div>
          <label className="block text-[11px] text-[color:var(--text-secondary)] font-mono uppercase tracking-wide mb-1">
            Monthly price (USD)
          </label>
          <Input type="number" min="0" step="0.01" value={priceDollars} onChange={(e) => setPriceDollars(e.target.value)} required />
        </div>
        <div>
          <label className="block text-[11px] text-[color:var(--text-secondary)] font-mono uppercase tracking-wide mb-1">
            Stripe price ID (blank = unset)
          </label>
          <Input value={stripePriceId} onChange={(e) => setStripePriceId(e.target.value)} placeholder="price_..." />
        </div>
        <label className="flex items-center gap-2 text-[12px] text-[color:var(--text-secondary)]">
          <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
          Active (uncheck to retire)
        </label>
        {update.error && (
          <p className="text-[12px] text-accent">
            Update failed: {update.error instanceof Error ? update.error.message : String(update.error)}
          </p>
        )}
        <div className="flex items-center gap-2">
          <Button variant="primary" type="submit" disabled={update.isPending}>
            {update.isPending ? 'Saving…' : 'Save'}
          </Button>
          <Button variant="ghost" type="button" onClick={() => { reset(); setEditing(false); }} disabled={update.isPending}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}

export default PricingConfig;
