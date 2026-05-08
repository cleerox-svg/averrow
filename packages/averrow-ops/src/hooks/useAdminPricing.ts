// Pricing config hooks for the staff Customers page (averrow-ops).
//
// Backed by:
//   GET    /api/admin/customers/:orgId/pricing
//   GET    /api/admin/pricing/plans
//   GET    /api/admin/pricing/modules
//   POST   /api/admin/customers/:orgId/pricing-overrides
//   PATCH  /api/admin/customers/:orgId/pricing-overrides/:id
//
// Sprint 2 of the Phase D Stripe track. Edit forms (PATCH for plans
// / modules + override-create form) land in sprint 3.

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface PricingPlan {
  id:                  string;
  display_name:        string;
  monthly_price_cents: number;
  trial_days:          number;
  included_modules:    string[];
  stripe_price_id:     string | null;
  description:         string | null;
  is_active:           boolean;
  sort_order:          number;
}

export interface ModulePrice {
  module_key:          string;
  display_name:        string;
  monthly_price_cents: number;
  stripe_price_id:     string | null;
  is_active:           boolean;
}

export type OverrideType = 'tier_price' | 'module_price' | 'discount_percent';

export interface OrgPricingOverride {
  id:                 string;
  org_id:             number;
  override_type:      OverrideType;
  plan_id:            string | null;
  module_key:         string | null;
  custom_price_cents: number | null;
  discount_pct:       number | null;
  reason:             string;
  set_by_user_id:     string | null;
  effective_from:     string;
  effective_until:    string | null;
  created_at:         string;
}

export interface OrgPricingSummary {
  org_id:                       number;
  plan:                         PricingPlan | null;
  per_module_subscriptions:     Array<{ module_key: string; price_cents: number }>;
  active_overrides:             OrgPricingOverride[];
  effective_monthly_total_cents: number;
  trial_ends_at:                string | null;
  billing_status:               string;
}

export function useCustomerPricing(orgId: string | null) {
  return useQuery<OrgPricingSummary>({
    queryKey: ['admin-customer-pricing', orgId],
    queryFn: async () => {
      const res = await api.get<OrgPricingSummary>(`/api/admin/customers/${orgId}/pricing`);
      if (!res.success || !res.data) throw new Error(res.error ?? 'Failed to load pricing');
      return res.data;
    },
    enabled: !!orgId,
    staleTime: 30_000,
  });
}

export function usePricingPlans() {
  return useQuery<{ plans: PricingPlan[] }>({
    queryKey: ['admin-pricing-plans'],
    queryFn: async () => {
      const res = await api.get<{ plans: PricingPlan[] }>('/api/admin/pricing/plans');
      if (!res.success || !res.data) throw new Error(res.error ?? 'Failed to load plans');
      return res.data;
    },
    staleTime: 60_000,
  });
}

export function useModulePrices() {
  return useQuery<{ modules: ModulePrice[] }>({
    queryKey: ['admin-module-prices'],
    queryFn: async () => {
      const res = await api.get<{ modules: ModulePrice[] }>('/api/admin/pricing/modules');
      if (!res.success || !res.data) throw new Error(res.error ?? 'Failed to load module prices');
      return res.data;
    },
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

// ─── Mutations ──────────────────────────────────────────────────

export interface CreateOverrideInput {
  override_type:      OverrideType;
  plan_id?:           string;
  module_key?:        string;
  custom_price_cents?: number;
  discount_pct?:      number;
  reason:             string;
  effective_until?:   string | null;
}

export function useCreatePricingOverride(orgId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateOverrideInput) => {
      if (!orgId) throw new Error('orgId required');
      const res = await api.post<{ id: string }>(
        `/api/admin/customers/${orgId}/pricing-overrides`,
        input,
      );
      if (!res.success || !res.data) throw new Error(res.error ?? 'Override create failed');
      return res.data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-customer-pricing', orgId] });
    },
  });
}

export function useRevokePricingOverride(orgId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (overrideId: string) => {
      if (!orgId) throw new Error('orgId required');
      const res = await api.patch<{ id: string; revoked: boolean }>(
        `/api/admin/customers/${orgId}/pricing-overrides/${overrideId}`,
        {},
      );
      if (!res.success || !res.data) throw new Error(res.error ?? 'Override revoke failed');
      return res.data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-customer-pricing', orgId] });
    },
  });
}

// Global pricing-config mutations (sprint 3b).
// These edit the BASELINE prices, not per-customer. Affect every
// new subscription + every getOrgPricingSummary read until an
// override is layered on per-org.

export interface UpdatePlanInput {
  display_name?:        string;
  monthly_price_cents?: number;
  trial_days?:          number;
  included_modules?:    string[];
  stripe_price_id?:     string | null;
  description?:         string | null;
  is_active?:           boolean;
  sort_order?:          number;
}

export interface UpdateModulePriceInput {
  display_name?:        string;
  monthly_price_cents?: number;
  stripe_price_id?:     string | null;
  is_active?:           boolean;
}

export function useUpdatePricingPlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { planId: string; patch: UpdatePlanInput }) => {
      const res = await api.patch<{ plan: PricingPlan }>(
        `/api/admin/pricing/plans/${input.planId}`,
        input.patch,
      );
      if (!res.success || !res.data) throw new Error(res.error ?? 'Plan update failed');
      return res.data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-pricing-plans'] });
      // Customer pricing summaries depend on plan baseline → invalidate
      // them too so any open Customer pricing tab shows the new price.
      void qc.invalidateQueries({ queryKey: ['admin-customer-pricing'] });
    },
  });
}

export function useUpdateModulePrice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { moduleKey: string; patch: UpdateModulePriceInput }) => {
      const res = await api.patch<{ module: ModulePrice }>(
        `/api/admin/pricing/modules/${input.moduleKey}`,
        input.patch,
      );
      if (!res.success || !res.data) throw new Error(res.error ?? 'Module price update failed');
      return res.data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-module-prices'] });
      void qc.invalidateQueries({ queryKey: ['admin-customer-pricing'] });
    },
  });
}
