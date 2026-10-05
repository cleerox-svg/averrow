// One unread signal for every notification count in the shell (bell badge and
// the avatar menu's Notifications row), so they can never disagree on colour.
// Count is the ops-scoped unread count; `hasCritical` comes from the same list
// the bell panel shows (no new endpoint), fetched only while something is
// unread and refreshed when the count moves so a fresh critical turns red.

import { useEffect } from 'react';
import { useUnreadCount, useNotifications, OPS_AUDIENCE_FILTER } from '@/hooks/useNotifications';

export interface UnreadSummary {
  /** Unread count; `undefined` until the first response. */
  count: number | undefined;
  hasCritical: boolean;
}

export function useUnreadSummary(): UnreadSummary {
  const { data: count } = useUnreadCount(OPS_AUDIENCE_FILTER);
  const unread = count ?? 0;
  const { data: feed, refetch } = useNotifications(unread > 0, OPS_AUDIENCE_FILTER);
  useEffect(() => {
    if (unread > 0) void refetch();
  }, [unread, refetch]);
  const hasCritical = (feed?.notifications ?? []).some((n) => n.state === 'unread' && n.severity === 'critical');
  return { count, hasCritical };
}
