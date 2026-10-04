// Tenant Alerts API client.
//
// Backed by GET /api/orgs/:orgId/alerts (handler:
// averrow-worker/src/handlers/tenantData.ts:handleTenantAlerts).
// Org-scoped at handler level via org_brands ownership.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPatch, apiPost } from './api';
import { useAuth } from './auth';

export type AlertSeverity = 'critical' | 'high' | 'medium' | 'low';
export type AlertStatus = 'new' | 'acknowledged' | 'investigating' | 'resolved' | 'false_positive';

/** Analyst-driven status transitions accepted by
 *  PATCH /api/orgs/:orgId/alerts/:alertId (handler: tenantData.ts
 *  handleTenantUpdateAlert). 'new' is the system default and is NOT a
 *  valid transition target. */
export type AlertAction = 'acknowledged' | 'investigating' | 'resolved' | 'false_positive';

export interface Alert {
  id:                  string;
  brand_id:            string;
  brand_name:          string;
  brand_domain:        string;
  alert_type:          string;
  severity:            AlertSeverity;
  title:               string;
  summary:             string;
  details:             string | null;
  source_type:         string | null;
  source_id:           string | null;
  ai_assessment:       string | null;
  ai_recommendations:  string | null;
  status:              AlertStatus;
  acknowledged_at:     string | null;
  resolved_at:         string | null;
  resolution_notes:    string | null;
  assigned_to:         string | null;
  assigned_to_name:    string | null;
  /** True when Averrow staff hold the signal (assigned_to is null and
   *  assigned_to_name is "Averrow SOC"). Staff are never named to customers. */
  handled_by_averrow?: boolean;
  created_at:          string;
}

/** Display name for a signal's assignee, or null when truly unassigned.
 *  Falls back to "Averrow SOC" when staff hold it but the name is missing. */
export function alertAssigneeLabel(a: Pick<Alert, 'assigned_to_name' | 'handled_by_averrow'>): string | null {
  if (a.assigned_to_name) return a.assigned_to_name;
  return a.handled_by_averrow ? 'Averrow SOC' : null;
}

export interface SeverityBreakdown {
  severity: AlertSeverity;
  count:    number;
}

export interface AlertsResponse {
  alerts:              Alert[];
  total:               number;
  severity_breakdown:  SeverityBreakdown[];
}

interface AlertsFilters {
  status?:    AlertStatus | 'all';
  severity?:  AlertSeverity | 'all';
  brandId?:   string;
  /** Server-side `alert_type` exact match (handleTenantAlerts already
   *  accepts this param; only the client type was missing it — added
   *  for EXEC_IMPERSONATION_2026-07 Stage 5 so the executives registry
   *  can deep-link into "this brand's executive_impersonation alerts"). */
  alertType?: string;
  limit?:     number;
  offset?:    number;
  /** Extra gate ANDed with the existing hasOrg/orgId gate below. Defaults
   *  to true (existing callers are unaffected). Added so callers like the
   *  executives registry can skip the request entirely when there's no
   *  useful scope to query yet (e.g. no single brand selected), instead of
   *  firing and discarding the result. */
  enabled?:   boolean;
}

/** Detection confidence (0–100) when the alert carries a structured score —
 *  impersonation alerts stash it in details.score / details.impersonation_score
 *  (0–1). Returns null for alert types without a detection score (campaign /
 *  phishing feeds), where severity carries the weight instead. */
export function extractConfidence(details: string | null): number | null {
  if (!details) return null;
  try {
    const d = JSON.parse(details) as Record<string, unknown>;
    const raw = d.score ?? d.impersonation_score ?? d.confidence;
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
    const pct = raw <= 1 ? raw * 100 : raw;
    return Math.round(Math.max(0, Math.min(100, pct)));
  } catch {
    return null;
  }
}

// The AI judge (alert-ai-judge.ts) auto-resolves only at/above this
// confidence; anything below is left in 'new' for a human. Surfaced so the
// reasoning trail can explain *why* a signal wasn't auto-handled.
export const AUTO_RESOLVE_CONFIDENCE_FLOOR = 90;

export type AiVerdict = 'active_threat' | 'likely_safe' | 'needs_human' | string;
export interface AiAssessment {
  verdict:    AiVerdict;
  confidence: number;
  reasoning:  string;
}

/** Parse the AI judge's assessment, stored as a formatted string:
 *  "[AI <verdict> @<confidence>%] <reasoning>". Returns null when absent or
 *  in an unexpected shape. */
export function parseAiAssessment(raw: string | null): AiAssessment | null {
  if (!raw) return null;
  const m = raw.match(/^\s*\[AI\s+([a-z_]+)\s*@\s*(\d+)\s*%\]\s*([\s\S]*)$/i);
  if (!m) return null;
  return {
    verdict:    (m[1] ?? '').toLowerCase(),
    confidence: parseInt(m[2] ?? '0', 10),
    reasoning:  (m[3] ?? '').trim(),
  };
}

export function useTenantAlerts(filters: AlertsFilters = {}) {
  const { user, hasOrg } = useAuth();
  const orgId = user?.organization?.id ?? null;

  const params = new URLSearchParams();
  if (filters.status   && filters.status   !== 'all') params.set('status',   filters.status);
  if (filters.severity && filters.severity !== 'all') params.set('severity', filters.severity);
  if (filters.brandId)                                  params.set('brand_id', filters.brandId);
  if (filters.alertType)                                params.set('alert_type', filters.alertType);
  params.set('limit', String(filters.limit ?? 50));
  if (filters.offset)                                   params.set('offset', String(filters.offset));

  return useQuery<AlertsResponse>({
    queryKey: ['tenant-alerts', orgId, params.toString()],
    queryFn: async () => {
      // Handler returns { success, data: Alert[], total, severity_breakdown }
      // — total + severity_breakdown live at the response ROOT, not inside
      // data. We pivot here to the AlertsResponse shape the page expects.
      const res = await apiGet<Alert[]>(`/api/orgs/${orgId}/alerts?${params}`) as unknown as {
        success?:            boolean;
        error?:              string;
        data:                Alert[];
        total:               number;
        severity_breakdown:  SeverityBreakdown[];
      };
      // apiFetch already throws on non-2xx; also guard a 2xx envelope that
      // reports { success:false } so it never reads as an empty list.
      if (res.success === false) throw new Error(res.error ?? 'Failed to load signals');
      return {
        alerts:              res.data ?? [],
        total:               res.total ?? 0,
        severity_breakdown:  res.severity_breakdown ?? [],
      };
    },
    enabled: hasOrg && !!orgId && (filters.enabled ?? true),
    staleTime: 30_000,
  });
}

/** Single-signal detail for the Intelligence Card. Deep-linkable: backed by
 *  GET /api/orgs/:orgId/alerts/:alertId (handler handleTenantAlertDetail), so
 *  the card resolves on a hard refresh / direct nav without the list cached. */
export function useAlert(alertId: string | undefined) {
  const { user, hasOrg } = useAuth();
  const orgId = user?.organization?.id ?? null;
  return useQuery<Alert>({
    queryKey: ['tenant-alert', orgId, alertId],
    queryFn: async () => {
      const res = await apiGet<Alert>(`/api/orgs/${orgId}/alerts/${alertId}`);
      return res.data;
    },
    enabled: hasOrg && !!orgId && !!alertId,
    staleTime: 30_000,
  });
}

/** Pure triage gate. Any global role other than `client` is Averrow staff and
 *  is refused by the worker on tenant alert writes (403), so staff never get
 *  triage controls here. Clients need an analyst+ org role — mirrors the
 *  backend `canPerformHITL` gate (viewer<analyst<admin<owner). */
export function canTriageFor(globalRole: string | null | undefined, orgRole: string | null | undefined): boolean {
  if (globalRole && globalRole !== 'client') return false;
  return orgRole === 'analyst' || orgRole === 'admin' || orgRole === 'owner';
}

/** True for any platform-staff global role (everything except `client`). */
export function isStaffRole(globalRole: string | null | undefined): boolean {
  return !!globalRole && globalRole !== 'client';
}

export function useCanTriage(): boolean {
  const { user } = useAuth();
  return canTriageFor(user?.role, user?.organization?.role);
}

/** True when the signed-in user is Averrow staff viewing the tenant app. */
export function useIsStaff(): boolean {
  const { user } = useAuth();
  return isStaffRole(user?.role);
}

/** Drive a signal's status lifecycle. Invalidates the signals list +
 *  dashboard rollups so counts and the queue update after a transition. */
export function useUpdateAlert() {
  const { user } = useAuth();
  const orgId = user?.organization?.id ?? null;
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({ alertId, status, notes }: { alertId: string; status: AlertAction; notes?: string }) => {
      return apiPatch<{ message: string }>(
        `/api/orgs/${orgId}/alerts/${alertId}`,
        { status, ...(notes ? { notes } : {}) },
      );
    },
    onSuccess: () => {
      // Prefix-match invalidation covers every severity/status filter variant.
      qc.invalidateQueries({ queryKey: ['tenant-alerts', orgId] });
      qc.invalidateQueries({ queryKey: ['tenant-alert', orgId] });
      qc.invalidateQueries({ queryKey: ['tenant-dashboard', orgId] });
    },
  });
}

/** Max alert ids per POST /api/orgs/:orgId/alerts/bulk call. The backend
 *  400s above this (D1's 100-bound-parameter limit), so larger selections
 *  are split client-side. Keep in sync with tenantData.ts TENANT_BULK_MAX_IDS. */
export const TENANT_BULK_MAX_ALERTS = 90;

/** Split ids into consecutive chunks of at most `size`. */
export function chunkIds<T>(ids: readonly T[], size: number = TENANT_BULK_MAX_ALERTS): T[][] {
  if (size < 1) throw new Error('chunk size must be >= 1');
  const out: T[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

/** Send `ids` (deduped) in ≤90-id chunks, one request at a time, summing
 *  `updated`. A failing chunk rejects with how far the run got — earlier
 *  chunks are already applied server-side. */
export async function runChunkedBulk(
  ids: readonly string[],
  send: (chunk: string[]) => Promise<{ updated: number }>,
): Promise<{ updated: number }> {
  const unique = [...new Set(ids)];
  let updated = 0;
  let done = 0;
  for (const chunk of chunkIds(unique)) {
    try {
      updated += (await send(chunk)).updated;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(done > 0 ? `Bulk action failed after ${done} of ${unique.length} alerts: ${msg}` : msg);
    }
    done += chunk.length;
  }
  return { updated };
}

/** Bulk-triage many signals at once (status and/or assignee). Selections
 *  above TENANT_BULK_MAX_ALERTS are sent as sequential chunks. */
export function useBulkUpdateAlerts() {
  const { user } = useAuth();
  const orgId = user?.organization?.id ?? null;
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({ alertIds, status, assignedTo }: { alertIds: string[]; status?: AlertAction; assignedTo?: string | null }) => {
      return runChunkedBulk(alertIds, async (chunk) => {
        const body: Record<string, unknown> = { alert_ids: chunk };
        if (status) body.status = status;
        if (assignedTo !== undefined) body.assigned_to = assignedTo;
        return (await apiPost<{ updated: number }>(`/api/orgs/${orgId}/alerts/bulk`, body)).data;
      });
    },
    // onSettled, not onSuccess: a partial failure has still applied earlier chunks.
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['tenant-alerts', orgId] });
      qc.invalidateQueries({ queryKey: ['tenant-dashboard', orgId] });
    },
  });
}

/** Assign (or unassign with null) a signal's owner. Same endpoint as the
 *  status update; the backend accepts assigned_to independently. */
export function useAssignAlert() {
  const { user } = useAuth();
  const orgId = user?.organization?.id ?? null;
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({ alertId, assignedTo }: { alertId: string; assignedTo: string | null }) => {
      return apiPatch<{ message: string }>(
        `/api/orgs/${orgId}/alerts/${alertId}`,
        { assigned_to: assignedTo },
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tenant-alerts', orgId] });
      qc.invalidateQueries({ queryKey: ['tenant-alert', orgId] });
    },
  });
}
