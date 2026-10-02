import { useAlertTriageSummary } from '@/hooks/useAlerts';

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
  const q = useAlertTriageSummary();
  const data = q.data?.new_count;
  return {
    data,
    isSuccess: data !== undefined,
    isError: q.isError && data === undefined,
    isLoading: q.isLoading,
  };
}
