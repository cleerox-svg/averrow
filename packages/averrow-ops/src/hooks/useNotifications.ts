import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { USER_TOGGLEABLE_EVENTS } from '@averrow/shared';
// Types live in the shared kit (the settings sections are mounted from there).
import type {
  NotificationPrefsV2, SeverityFloor, SeverityFloorWithOff, DigestMode,
  DigestSeverityFloor, GroupCadence, SubscriptionLevel, UpdatePrefsOptions,
} from '@averrow/shared/account';
import type { NotificationEventKey, NotificationSeverity } from '@averrow/shared';

export type NotificationState = 'unread' | 'read' | 'snoozed' | 'done';
export type NotificationAudience = 'tenant' | 'super_admin' | 'team' | 'all';

export interface Notification {
  id: string;
  // N3: tenant-scoping fields surfaced from the row
  brand_id: string | null;
  // Resolved brand identity (LEFT JOINed from brands when brand_id
  // is set) — lets the UI render a real favicon next to brand-
  // scoped notifications instead of a generic severity glyph.
  brand_domain: string | null;
  brand_logo_url: string | null;
  brand_name: string | null;
  org_id: string | null;
  audience: NotificationAudience;
  // System events appear in the feed too (email_security_change,
  // circuit_breaker_tripped) — widen to NotificationEventKey from
  // the shared registry instead of the old user-toggleable subset.
  type: NotificationEventKey;
  severity: NotificationSeverity;
  title: string;
  message: string;
  // Static templates (Q5) — surface in UI as "why" + "what to do".
  reason_text: string | null;
  recommended_action: string | null;
  link: string | null;
  // State machine (Q1)
  state: NotificationState;
  read_at: string | null;
  snoozed_until: string | null;
  done_at: string | null;
  // Grouping
  group_key: string | null;
  created_at: string;
  updated_at: string;
  metadata: string | null;
}

export type NotificationStateFilter = 'inbox' | 'snoozed' | 'done' | 'all';

export interface NotificationFeedFilters {
  /** Notification type — matches a key in @averrow/shared/notification-events. */
  type?: NotificationEventKey;
  severity?: NotificationSeverity;
  q?: string;
  /** ISO timestamp. Returns rows STRICTLY OLDER than this. */
  cursor?: string;
  /**
   * State filter for the triage inbox. 'inbox' (default) hides done +
   * unexpired snoozed rows. 'snoozed' shows only currently-snoozed.
   * 'done' shows only done. 'all' shows everything regardless of state.
   */
  state?: NotificationStateFilter;
  /**
   * N1: audience filter. When set, the API only returns notifications
   * whose `audience` column is in this list. The ops archive page passes
   * OPS_AUDIENCE_FILTER to mirror the bell's scoping.
   */
  audience?: NotificationAudience[];
}

// N1: ops-only audience set — the operator bell ignores tenant brand
// events (DMARC drift, lookalike registered, etc.). Tenant-scoped callers
// (averrow-tenant SPA) pass `['tenant']` instead. Defaults to no filter
// to preserve the legacy contract for any caller that doesn't opt in yet.
export const OPS_AUDIENCE_FILTER: NotificationAudience[] = ['super_admin', 'team', 'all'];

function audienceQueryString(audience?: NotificationAudience[]): string {
  if (!audience || audience.length === 0) return '';
  return `audience=${audience.join(',')}`;
}

export function useUnreadCount(audience?: NotificationAudience[]) {
  const q = audienceQueryString(audience);
  return useQuery({
    queryKey: ['notifications', 'unread-count', audience ?? null],
    queryFn: async () => {
      const url = q ? `/api/notifications/unread-count?${q}` : '/api/notifications/unread-count';
      const res = await api.get(url) as unknown as { count: number };
      return res.count ?? 0;
    },
    refetchInterval: 60_000,
  });
}

export function useNotifications(enabled: boolean, audience?: NotificationAudience[]) {
  const audQs = audienceQueryString(audience);
  return useQuery({
    queryKey: ['notifications', 'list', audience ?? null],
    queryFn: async () => {
      const url = audQs ? `/api/notifications?limit=20&${audQs}` : '/api/notifications?limit=20';
      const res = await api.get(url) as unknown as {
        data: Notification[];
        unread_count: number;
      };
      return {
        notifications: res.data ?? [],
        unread_count: res.unread_count ?? 0,
      };
    },
    enabled,
  });
}

export function useMarkRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api.post(`/api/notifications/${id}/read`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
}

export function useMarkAllRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      await api.post('/api/notifications/read-all');
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
}

// N3 — snooze a single notification until an ISO-8601 timestamp.
// The row stays in the DB but is hidden from the inbox until
// `until <= now`. UI surfaces this in N4.
export function useSnoozeNotification() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, until }: { id: string; until: string }) => {
      await api.post(`/api/notifications/${id}/snooze`, { until });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
}

// N3 — mark a notification done (Linear-style fourth state).
// Done rows are hidden from the inbox but stay queryable from
// the archive page.
export function useMarkDone() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api.post(`/api/notifications/${id}/done`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
}

// ─── N5: preferences_v2 ───────────────────────────────────────────────

// Re-exported so existing imports from this hook keep working.
export type {
  SeverityFloor, SeverityFloorWithOff, DigestMode, DigestSeverityFloor, GroupCadence, SubscriptionLevel,
};
export type NotificationPreferencesV2 = NotificationPrefsV2;

// Mutations resolve with a `{ success: false, error }` envelope on 4xx/5xx
// (only GETs reject — see lib/api.ts), so a write that "succeeded" at the
// network level can still have failed. Throw so react-query's error path (and
// the optimistic rollback below) actually runs.
function assertWritten(res: { success?: boolean; error?: string } | undefined): void {
  if (res && res.success === false) {
    throw new Error(res.error || "Couldn't save. Check your connection and try again.");
  }
}

/** Restore only the keys a failed write touched, so a concurrent edit to another field survives. */
function rollbackKeys<T extends object>(current: T | undefined, previous: T | undefined, keys: string[]): T | undefined {
  if (!current || !previous) return previous ?? current;
  const next = { ...current } as Record<string, unknown>;
  const prev = previous as Record<string, unknown>;
  for (const k of keys) next[k] = prev[k];
  return next as T;
}

const PREFS_V2_KEY = ['notification-preferences-v2'] as const;

export function useNotificationPreferencesV2() {
  return useQuery({
    queryKey: PREFS_V2_KEY,
    queryFn: async (): Promise<NotificationPreferencesV2 | null> => {
      const res = await api.get<NotificationPreferencesV2>('/api/notifications/preferences/v2');
      return res.data ?? null;
    },
  });
}

export interface UpdatePrefsV2Variables {
  patch: Partial<NotificationPreferencesV2>;
  /** Default true: flip the cached value immediately and roll back on failure. */
  options?: UpdatePrefsOptions;
}

/**
 * v2 preference write (floors, summary, cadence, quiet hours, critical
 * breakthrough). Optimistic with rollback; `options.optimistic: false` is for
 * explicit-save forms, which keep the user's edits on screen if the save fails.
 */
export function useUpdateNotificationPreferencesV2() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ patch }: UpdatePrefsV2Variables) => {
      assertWritten(await api.put('/api/notifications/preferences/v2', patch));
    },
    onMutate: async ({ patch, options }) => {
      if (options?.optimistic === false) return { previous: undefined };
      await queryClient.cancelQueries({ queryKey: PREFS_V2_KEY });
      const previous = queryClient.getQueryData<NotificationPreferencesV2 | null>(PREFS_V2_KEY) ?? undefined;
      if (previous) queryClient.setQueryData<NotificationPreferencesV2 | null>(PREFS_V2_KEY, { ...previous, ...patch });
      return { previous };
    },
    onError: (_err, { patch }, ctx) => {
      if (!ctx?.previous) return;
      queryClient.setQueryData<NotificationPreferencesV2 | null>(PREFS_V2_KEY, (cur) =>
        rollbackKeys(cur ?? undefined, ctx.previous, Object.keys(patch)) ?? null);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: PREFS_V2_KEY });
    },
  });
}

// ─── Per-event toggles (v1 endpoint — no v2 columns exist for these) ───
//
// GET/PATCH /api/notifications/preferences also carries the old quiet-hours
// columns. The settings UI never reads or writes them (quiet hours live on v2);
// the PATCH below is built only from USER_TOGGLEABLE_EVENTS keys.

const EVENT_KEYS: readonly string[] = USER_TOGGLEABLE_EVENTS.map((e) => e.key);
const EVENT_PREFS_KEY = ['notification-preferences'] as const;

export type EventPreferences = Record<string, boolean>;

export function useNotificationEventPreferences() {
  return useQuery({
    queryKey: EVENT_PREFS_KEY,
    queryFn: async (): Promise<EventPreferences> => {
      const res = await api.get<Record<string, unknown>>('/api/notifications/preferences');
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
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (patch: EventPreferences) => {
      const body: EventPreferences = {};
      for (const key of EVENT_KEYS) if (key in patch) body[key] = patch[key] as boolean;
      assertWritten(await api.patch('/api/notifications/preferences', body));
    },
    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey: EVENT_PREFS_KEY });
      const previous = queryClient.getQueryData<EventPreferences>(EVENT_PREFS_KEY);
      queryClient.setQueryData<EventPreferences>(EVENT_PREFS_KEY, { ...(previous ?? {}), ...patch });
      return { previous };
    },
    onError: (_err, patch, ctx) => {
      queryClient.setQueryData<EventPreferences>(EVENT_PREFS_KEY, (cur) => {
        const next = { ...(cur ?? {}) };
        for (const key of Object.keys(patch)) {
          if (ctx?.previous && key in ctx.previous) next[key] = ctx.previous[key] as boolean;
          else delete next[key];
        }
        return next;
      });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: EVENT_PREFS_KEY });
    },
  });
}

// ─── NX5: Notification Center admin (super_admin only) ──────────────

export interface NotificationStatsRow {
  type: string;
  audience: string;
  severity: string;
  fired: number;
  unique_recipients: number;
}

export interface NotificationStatsTotals {
  total: number;
  types: number;
  unique_recipients: number;
  super_admin_count: number;
  tenant_count: number;
  team_count: number;
  all_count: number;
  critical_count: number;
  high_count: number;
}

export interface NotificationStats {
  window_hours: number;
  totals: NotificationStatsTotals;
  by_type: NotificationStatsRow[];
}

export function useNotificationStats(hours = 24) {
  return useQuery({
    queryKey: ['notification-admin', 'stats', hours],
    queryFn: async (): Promise<NotificationStats | null> => {
      const res = await api.get<NotificationStats>(`/api/admin/notifications/stats?hours=${hours}`);
      return res.data ?? null;
    },
    refetchInterval: 60_000,
  });
}

export interface NotificationMute {
  id: string;
  type: string;
  muted_until: string;
  reason: string | null;
  created_by: string;
  created_at: string;
}

export function useNotificationMutes() {
  return useQuery({
    queryKey: ['notification-admin', 'mutes'],
    queryFn: async (): Promise<NotificationMute[]> => {
      const res = await api.get<NotificationMute[]>('/api/admin/notifications/mutes');
      return res.data ?? [];
    },
    refetchInterval: 30_000,
  });
}

export function useCreateNotificationMute() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ type, hours, reason }: { type: string; hours: number; reason?: string }) => {
      await api.post('/api/admin/notifications/mute', { type, hours, reason });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notification-admin'] });
    },
  });
}

export function useDeleteNotificationMute() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (type: string) => {
      await api.delete(`/api/admin/notifications/mute/${encodeURIComponent(type)}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notification-admin'] });
    },
  });
}

// ─── N5: subscriptions ────────────────────────────────────────────────

export interface Subscription {
  brand_id: string;
  brand_name: string | null;
  level: SubscriptionLevel;
  snoozed_until: string | null;
  updated_at: string;
}

const SUBSCRIPTIONS_KEY = ['notification-subscriptions'] as const;

export function useNotificationSubscriptions() {
  return useQuery({
    queryKey: SUBSCRIPTIONS_KEY,
    queryFn: async (): Promise<Subscription[]> => {
      const res = await api.get<Subscription[]>('/api/notifications/subscriptions');
      return res.data ?? [];
    },
  });
}

export function useUpdateSubscription() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ brandId, level, snoozedUntil }: {
      brandId: string;
      level: SubscriptionLevel;
      snoozedUntil?: string | null;
    }) => {
      assertWritten(await api.put(`/api/notifications/subscriptions/${brandId}`, {
        level,
        ...(snoozedUntil !== undefined ? { snoozed_until: snoozedUntil } : {}),
      }));
    },
    onMutate: async ({ brandId, level }) => {
      await queryClient.cancelQueries({ queryKey: SUBSCRIPTIONS_KEY });
      const previous = queryClient.getQueryData<Subscription[]>(SUBSCRIPTIONS_KEY);
      queryClient.setQueryData<Subscription[]>(SUBSCRIPTIONS_KEY, (cur) =>
        (cur ?? []).map((s) => (s.brand_id === brandId ? { ...s, level } : s)));
      return { previous };
    },
    onError: (_err, { brandId }, ctx) => {
      const before = ctx?.previous?.find((s) => s.brand_id === brandId);
      if (!before) return;
      queryClient.setQueryData<Subscription[]>(SUBSCRIPTIONS_KEY, (cur) =>
        (cur ?? []).map((s) => (s.brand_id === brandId ? { ...s, level: before.level } : s)));
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: SUBSCRIPTIONS_KEY });
    },
  });
}

export function useDeleteSubscription() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (brandId: string) => {
      assertWritten(await api.delete(`/api/notifications/subscriptions/${brandId}`));
    },
    onMutate: async (brandId) => {
      await queryClient.cancelQueries({ queryKey: SUBSCRIPTIONS_KEY });
      const previous = queryClient.getQueryData<Subscription[]>(SUBSCRIPTIONS_KEY);
      queryClient.setQueryData<Subscription[]>(SUBSCRIPTIONS_KEY, (cur) =>
        (cur ?? []).filter((s) => s.brand_id !== brandId));
      return { previous };
    },
    onError: (_err, _brandId, ctx) => {
      if (ctx?.previous) queryClient.setQueryData<Subscription[]>(SUBSCRIPTIONS_KEY, ctx.previous);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: SUBSCRIPTIONS_KEY });
    },
  });
}

// Used by /v2/notifications archive page. Distinct from
// useNotifications() (bell preview) because:
//   - This one supports filters + search + cursor pagination.
//   - It deduplicates the queryKey by filter so navigating between
//     filter combinations doesn't blow away the previous list.
//   - keepPreviousData prevents the list from flashing empty
//     between paginated fetches.
export interface NotificationFeedPage {
  notifications: Notification[];
  unread_count: number;
  next_cursor: string | null;
}

export function useNotificationsArchive(filters: NotificationFeedFilters = {}) {
  return useQuery({
    queryKey: ['notifications', 'archive', filters],
    queryFn: async (): Promise<NotificationFeedPage> => {
      const params = new URLSearchParams();
      params.set('limit', '50');
      if (filters.type) params.set('type', filters.type);
      if (filters.severity) params.set('severity', filters.severity);
      if (filters.q) params.set('q', filters.q);
      if (filters.cursor) params.set('cursor', filters.cursor);
      if (filters.state) params.set('state', filters.state);
      if (filters.audience && filters.audience.length > 0) {
        params.set('audience', filters.audience.join(','));
      }
      const res = await api.get(`/api/notifications?${params.toString()}`) as unknown as {
        data: Notification[];
        unread_count: number;
        next_cursor: string | null;
      };
      return {
        notifications: res.data ?? [],
        unread_count: res.unread_count ?? 0,
        next_cursor: res.next_cursor ?? null,
      };
    },
    placeholderData: keepPreviousData,
  });
}
