import { useAlertTriageSummary } from '@/hooks/useAlerts';
import { useAuth } from '@/lib/auth';
import { roleHasPermission } from '@/lib/permissions';

/**
 * Alerts awaiting triage (status='new') for the Console / Overview KPI tiles
 * and the nav badge. Derived from the shared triage-summary query (same cache
 * entry the notification bell polls) — no extra request. Alert statuses are
 * new|acknowledged|investigating|resolved|false_positive; there is no 'open'.
 *
 * A failed background refetch with a cached value keeps showing the last good
 * number: `isError` is only reported when there is nothing to show.
 */
export function useOpenAlertCount() {
  // Gated like Home and the bell: roles without edit_alerts (sales, billing,
  // auditor) don't fetch the triage summary, so callers get `enabled: false`
  // and must hide the count rather than show a placeholder.
  const { user } = useAuth();
  const enabled = roleHasPermission(user?.role, 'edit_alerts');
  const q = useAlertTriageSummary({ enabled });
  const data = q.data?.new_count;
  return {
    data,
    enabled,
    isSuccess: data !== undefined,
    isError: q.isError && data === undefined,
    isLoading: q.isLoading,
  };
}
