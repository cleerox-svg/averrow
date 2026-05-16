import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { NotificationEventKey, NotificationSeverity } from '@averrow/shared';

export type NotificationState = 'unread' | 'read' | 'snoozed' | 'done';
export type NotificationAudience = 'tenant' | 'super_admin' | 'team' | 'all';

export interface Notification {
  id: string;
  // N3: tenant-scoping fields surfaced from the row
  brand_id: string | null;
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

export type SeverityFloor = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type SeverityFloorWithOff = SeverityFloor | 'off';
export type DigestMode = 'realtime' | 'hourly' | 'daily' | 'weekly' | 'off';
export type DigestSeverityFloor = 'high' | 'medium' | 'low' | 'info';
// NX5: per-group cadence (intel + platform). Distinct from digest_mode
// which gates tenant-targeted brand events.
export type GroupCadence = 'realtime' | 'daily_digest' | 'weekly_digest';

export interface NotificationPreferencesV2 {
  inapp_severity_floor: SeverityFloor;
  push_severity_floor: SeverityFloorWithOff;
  email_severity_floor: SeverityFloorWithOff;
  digest_mode: DigestMode;
  digest_severity_floor: DigestSeverityFloor;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
  quiet_hours_timezone: string;
  critical_bypasses_quiet: number;
  show_tenant_notifications: number;
  cadence_intel: GroupCadence;
  cadence_platform: GroupCadence;
}

export function useNotificationPreferencesV2() {
  return useQuery({
    queryKey: ['notification-preferences-v2'],
    queryFn: async (): Promise<NotificationPreferencesV2 | null> => {
      const res = await api.get<NotificationPreferencesV2>('/api/notifications/preferences/v2');
      return res.data ?? null;
    },
  });
}

export function useUpdateNotificationPreferencesV2() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (patch: Partial<NotificationPreferencesV2>) => {
      await api.put('/api/notifications/preferences/v2', patch);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notification-preferences-v2'] });
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

export type SubscriptionLevel = 'watching' | 'default' | 'ignored';

export interface Subscription {
  brand_id: string;
  brand_name: string | null;
  level: SubscriptionLevel;
  snoozed_until: string | null;
  updated_at: string;
}

export function useNotificationSubscriptions() {
  return useQuery({
    queryKey: ['notification-subscriptions'],
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
      await api.put(`/api/notifications/subscriptions/${brandId}`, {
        level,
        ...(snoozedUntil !== undefined ? { snoozed_until: snoozedUntil } : {}),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notification-subscriptions'] });
    },
  });
}

export function useDeleteSubscription() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (brandId: string) => {
      await api.delete(`/api/notifications/subscriptions/${brandId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notification-subscriptions'] });
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
