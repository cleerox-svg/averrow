// Tenant billing API client.
//
// Backed by GET /api/orgs/:orgId/billing — same data shape as the
// super_admin endpoint (/api/admin/customers/:orgId/pricing) but
// tenant-scoped via verifyOrgAccess in the worker.
//
// v3 Phase D Stripe sprint 5.

import { useQuery } from '@tanstack/react-query';
import { apiGet } from './api';
import { useAuth } from './auth';

export interface BillingPlan {
  id:                  string;
  display_name:        string;
  monthly_price_cents: number;
  trial_days:          number;
  included_modules:    string[];
  description:         string | null;
  is_active:           boolean;
}

export interface BillingOverride {
  id:                 string;
  override_type:      'tier_price' | 'module_price' | 'discount_percent';
  plan_id:            string | null;
  module_key:         string | null;
  custom_price_cents: number | null;
  discount_pct:       number | null;
  reason:             string;
  effective_from:     string;
  effective_until:    string | null;
}

export interface BillingSummary {
  org_id:                       number;
  plan:                         BillingPlan | null;
  per_module_subscriptions:     Array<{ module_key: string; price_cents: number }>;
  active_overrides:             BillingOverride[];
  effective_monthly_total_cents: number;
  trial_ends_at:                string | null;
  billing_status:               string;
}

export function useBillingSummary() {
  const { user, hasOrg } = useAuth();
  const orgId = user?.organization?.id ?? null;
  return useQuery<BillingSummary>({
    queryKey: ['tenant-billing', orgId],
    queryFn: async () => {
      const res = await apiGet<BillingSummary>(`/api/orgs/${orgId}/billing`);
      return res.data;
    },
    enabled: hasOrg && !!orgId,
    staleTime: 60_000,
  });
}

export function formatCents(cents: number): string {
  if (cents === 0) return '$0';
  const dollars = cents / 100;
  return dollars.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: dollars >= 100 ? 0 : 2,
  });
}

export const BILLING_STATUS_LABELS: Record<string, string> = {
  unbilled:  'Unbilled',
  trialing:  'Trial',
  active:    'Active',
  past_due:  'Past due',
  cancelled: 'Cancelled',
};
