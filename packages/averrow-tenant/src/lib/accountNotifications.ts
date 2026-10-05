// Tenant notification-preference hooks for the shared NotificationSettings page.
//
// Same endpoints and optimistic-update/rollback semantics as averrow-ops
// (hooks/useNotifications.ts); all are caller-scoped `requireAuth` routes, so
// client users get them too:
//   per-event toggles  v1  GET/PATCH /api/notifications/preferences
//   everything else    v2  GET/PUT   /api/notifications/preferences/v2
//   brand overrides        GET/PUT/DELETE /api/notifications/subscriptions[/:brandId]
// Unlike ops' api client, the tenant helpers throw on non-2xx, so a failed
// write rejects and react-query's rollback path runs without extra checks.

import { useQuery, useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { USER_TOGGLEABLE_EVENTS } from '@averrow/shared';
import type { NotificationPrefsV2, SubscriptionLevel, UpdatePrefsOptions } from '@averrow/shared/account';
import { apiDelete, apiGet, apiPatch, apiPut } from './api';

/** Server defaults (handlers/notifications.ts PREF_V2_DEFAULTS). A partial row is topped up from these. */
export const V2_DEFAULTS: NotificationPrefsV2 = {
  inapp_severity_floor: 'info',
  push_severity_floor: 'low',
  email_severity_floor: 'high',
  digest_mode: 'daily',
  digest_severity_floor: 'medium',
  quiet_hours_start: null,
  quiet_hours_end: null,
  quiet_hours_timezone: 'UTC',
  critical_bypasses_quiet: 1,
  show_tenant_notifications: 0,
  cadence_intel: 'realtime',
  cadence_platform: 'realtime',
};

export interface BrandSubscriptionRow {
  brand_id: string;
  brand_name: string | null;
  level: SubscriptionLevel;
  snoozed_until: string | null;
  updated_at: string;
}

export type EventPreferences = Record<string, boolean>;

const PREFS_V2_KEY = ['account-notification-preferences-v2'] as const;
const PREFS_V2_MUTATION = [...PREFS_V2_KEY, 'update'] as const;
const EVENT_PREFS_KEY = ['account-notification-preferences'] as const;
const EVENT_PREFS_MUTATION = [...EVENT_PREFS_KEY, 'update'] as const;
const SUBSCRIPTIONS_KEY = ['account-notification-subscriptions'] as const;
const SUBSCRIPTIONS_MUTATION = [...SUBSCRIPTIONS_KEY, 'update'] as const;

const EVENT_KEYS: readonly string[] = USER_TOGGLEABLE_EVENTS.map((e) => e.key);

/** Refetch only once the LAST in-flight write of a family settles (the settling one still counts, hence 1). */
function invalidateWhenIdle(qc: QueryClient, mutationKey: readonly unknown[], queryKey: readonly unknown[]): void {
  if (qc.isMutating({ mutationKey }) <= 1) void qc.invalidateQueries({ queryKey });
}

export function useNotificationPreferencesV2() {
  return useQuery({
    queryKey: PREFS_V2_KEY,
    queryFn: async (): Promise<NotificationPrefsV2 | null> => {
      const res = await apiGet<NotificationPrefsV2>('/api/notifications/preferences/v2');
      return res.data ?? null;
    },
  });
}

export function useUpdateNotificationPreferencesV2() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: PREFS_V2_MUTATION,
    mutationFn: async ({ patch }: { patch: Partial<NotificationPrefsV2>; options?: UpdatePrefsOptions }) => {
      await apiPut('/api/notifications/preferences/v2', patch);
    },
    onMutate: async ({ patch, options }) => {
      if (options?.optimistic === false) return { previous: undefined };
      await qc.cancelQueries({ queryKey: PREFS_V2_KEY });
      const previous = qc.getQueryData<NotificationPrefsV2 | null>(PREFS_V2_KEY) ?? undefined;
      if (previous) qc.setQueryData<NotificationPrefsV2 | null>(PREFS_V2_KEY, (cur) => ({ ...(cur ?? previous), ...patch }));
      return { previous };
    },
    onError: (_err, { patch }, ctx) => {
      if (!ctx?.previous) return;
      const prev = ctx.previous as unknown as Record<string, unknown>;
      qc.setQueryData<NotificationPrefsV2 | null>(PREFS_V2_KEY, (cur) => {
        if (!cur) return ctx.previous ?? null;
        const next = { ...cur } as unknown as Record<string, unknown>;
        for (const k of Object.keys(patch)) next[k] = prev[k];
        return next as unknown as NotificationPrefsV2;
      });
    },
    onSettled: () => invalidateWhenIdle(qc, PREFS_V2_MUTATION, PREFS_V2_KEY),
  });
}

export function useNotificationEventPreferences() {
  return useQuery({
    queryKey: EVENT_PREFS_KEY,
    queryFn: async (): Promise<EventPreferences> => {
      const res = await apiGet<Record<string, unknown>>('/api/notifications/preferences');
      const out: EventPreferences = {};
      for (const key of EVENT_KEYS) {
        const v = res.data?.[key];
        if (v !== undefined && v !== null) out[key] = Boolean(v);
      }
      return out;
    },
  });
}

export function useUpdateNotificationEventPreferences() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: EVENT_PREFS_MUTATION,
    mutationFn: async (patch: EventPreferences) => {
      const body: EventPreferences = {};
      for (const key of EVENT_KEYS) if (key in patch) body[key] = patch[key] as boolean;
      await apiPatch('/api/notifications/preferences', body);
    },
    onMutate: async (patch) => {
      await qc.cancelQueries({ queryKey: EVENT_PREFS_KEY });
      const previous = qc.getQueryData<EventPreferences>(EVENT_PREFS_KEY);
      qc.setQueryData<EventPreferences>(EVENT_PREFS_KEY, (cur) => ({ ...(cur ?? previous ?? {}), ...patch }));
      return { previous };
    },
    onError: (_err, patch, ctx) => {
      qc.setQueryData<EventPreferences>(EVENT_PREFS_KEY, (cur) => {
        const next = { ...(cur ?? {}) };
        for (const key of Object.keys(patch)) {
          if (ctx?.previous && key in ctx.previous) next[key] = ctx.previous[key] as boolean;
          else delete next[key];
        }
        return next;
      });
    },
    onSettled: () => invalidateWhenIdle(qc, EVENT_PREFS_MUTATION, EVENT_PREFS_KEY),
  });
}

export function useNotificationSubscriptions() {
  return useQuery({
    queryKey: SUBSCRIPTIONS_KEY,
    queryFn: async (): Promise<BrandSubscriptionRow[]> => {
      const res = await apiGet<BrandSubscriptionRow[]>('/api/notifications/subscriptions');
      return res.data ?? [];
    },
  });
}

export function useUpdateSubscription() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: SUBSCRIPTIONS_MUTATION,
    mutationFn: async ({ brandId, level }: { brandId: string; level: SubscriptionLevel }) => {
      await apiPut(`/api/notifications/subscriptions/${encodeURIComponent(brandId)}`, { level });
    },
    onMutate: async ({ brandId, level }) => {
      await qc.cancelQueries({ queryKey: SUBSCRIPTIONS_KEY });
      const previous = qc.getQueryData<BrandSubscriptionRow[]>(SUBSCRIPTIONS_KEY);
      qc.setQueryData<BrandSubscriptionRow[]>(SUBSCRIPTIONS_KEY, (cur) =>
        (cur ?? []).map((s) => (s.brand_id === brandId ? { ...s, level } : s)));
      return { previous };
    },
    onError: (_err, { brandId }, ctx) => {
      const before = ctx?.previous?.find((s) => s.brand_id === brandId);
      if (!before) return;
      qc.setQueryData<BrandSubscriptionRow[]>(SUBSCRIPTIONS_KEY, (cur) =>
        (cur ?? []).map((s) => (s.brand_id === brandId ? { ...s, level: before.level } : s)));
    },
    onSettled: () => invalidateWhenIdle(qc, SUBSCRIPTIONS_MUTATION, SUBSCRIPTIONS_KEY),
  });
}

export function useDeleteSubscription() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: SUBSCRIPTIONS_MUTATION,
    mutationFn: async (brandId: string) => {
      await apiDelete(`/api/notifications/subscriptions/${encodeURIComponent(brandId)}`);
    },
    onMutate: async (brandId) => {
      await qc.cancelQueries({ queryKey: SUBSCRIPTIONS_KEY });
      const previous = qc.getQueryData<BrandSubscriptionRow[]>(SUBSCRIPTIONS_KEY);
      qc.setQueryData<BrandSubscriptionRow[]>(SUBSCRIPTIONS_KEY, (cur) => (cur ?? []).filter((s) => s.brand_id !== brandId));
      return { previous };
    },
    onError: (_err, brandId, ctx) => {
      const removed = ctx?.previous?.find((s) => s.brand_id === brandId);
      if (!removed) return;
      qc.setQueryData<BrandSubscriptionRow[]>(SUBSCRIPTIONS_KEY, (cur) =>
        (cur ?? []).some((s) => s.brand_id === brandId) ? (cur ?? []) : [...(cur ?? []), removed]);
    },
    onSettled: () => invalidateWhenIdle(qc, SUBSCRIPTIONS_MUTATION, SUBSCRIPTIONS_KEY),
  });
}
