// Tenant Notifications API client.
//
// User-scoped (not org-scoped). Hits /api/notifications which is the
// canonical notifications inbox already powering averrow-ops's bell.

import { useQuery } from '@tanstack/react-query';
import { apiGet } from './api';
import { useAuth } from './auth';

export interface Notification {
  id:                  string;
  user_id:             string;
  type:                string;
  severity:            string;
  title:               string;
  message:             string;
  link:                string | null;
  recommended_action:  string | null;
  state:               'unread' | 'read' | 'snoozed' | 'done';
  group_key:           string | null;
  snoozed_until:       string | null;
  created_at:          string;
}

export interface NotificationsResponse {
  notifications: Notification[];
  unread_count:  number;
}

export function useTenantNotifications() {
  const { user } = useAuth();

  return useQuery<NotificationsResponse>({
    queryKey: ['tenant-notifications', user?.id],
    queryFn: async () => {
      // Handler returns { success, data: Notification[], unread_count, next_cursor }
      // — unread_count + next_cursor live at the response root, NOT inside
      // data. Mirror averrow-ops's hook (src/hooks/useNotifications.ts)
      // which does the same shape pivot.
      const res = await apiGet<Notification[]>(`/api/notifications`) as unknown as {
        data:         Notification[];
        unread_count: number;
      };
      return {
        notifications: res.data ?? [],
        unread_count:  res.unread_count ?? 0,
      };
    },
    enabled: !!user,
    staleTime: 30_000,
  });
}
