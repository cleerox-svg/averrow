// Tenant Notifications API client.
//
// User-scoped (not org-scoped). Hits /api/notifications which is the
// canonical notifications inbox already powering averrow-ui's bell.

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
      const res = await apiGet<NotificationsResponse>(`/api/notifications`);
      return res.data;
    },
    enabled: !!user,
    staleTime: 30_000,
  });
}
