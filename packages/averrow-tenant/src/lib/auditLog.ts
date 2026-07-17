// Tenant audit-log API client.
//
// Backed by GET /api/orgs/:orgId/audit-log (handler:
// averrow-worker/src/handlers/tenantData.ts handleTenantAuditLog). Analyst+
// org role; the backend enforces it too. Shows org-scoped automation +
// human actions (who/what/when); ip/user-agent are not exposed.

import { useQuery } from '@tanstack/react-query';
import { apiGet } from './api';
import { useAuth } from './auth';

export interface AuditEntry {
  id:            string;
  timestamp:     string;
  actor:         string | null;
  action:        string;
  resource_type: string | null;
  outcome:       string;
  details:       string | null;
}

export interface AuditLogResponse {
  entries: AuditEntry[];
  total:   number;
}

/** Analyst+ org role (mirrors backend canPerformHITL). Gates both the
 *  query and the nav item so viewers don't see a 403. */
export function useCanViewAudit(): boolean {
  const { user } = useAuth();
  const orgRole = user?.organization?.role ?? '';
  return orgRole === 'analyst' || orgRole === 'admin' || orgRole === 'owner' || user?.role === 'super_admin';
}

export function useTenantAuditLog({ limit = 50, offset = 0 }: { limit?: number; offset?: number } = {}) {
  const { user, hasOrg } = useAuth();
  const orgId = user?.organization?.id ?? null;
  const canView = useCanViewAudit();

  const params = new URLSearchParams();
  params.set('limit', String(limit));
  if (offset) params.set('offset', String(offset));

  return useQuery<AuditLogResponse>({
    queryKey: ['tenant-audit-log', orgId, limit, offset],
    queryFn: async () => {
      const res = await apiGet<AuditEntry[]>(`/api/orgs/${orgId}/audit-log?${params}`);
      return { entries: res.data ?? [], total: res.total ?? 0 };
    },
    enabled: hasOrg && !!orgId && canView,
    staleTime: 30_000,
  });
}

const ACTION_LABELS: Record<string, string> = {
  tenant_alert_update:            'Signal updated',
  takedown_update:                'Takedown updated',
  takedown_authorization_signed:  'Authorization signed',
  takedown_authorization_revoked: 'Authorization revoked',
  org_invite_created:             'Member invited',
  org_member_removed:             'Member removed',
  org_member_role_updated:        'Member role changed',
  org_brand_assigned:             'Brand added',
  org_brand_removed:              'Brand removed',
  monitoring_config_update:       'Monitoring updated',
  tenant_abuse_message_update:    'Abuse message updated',
};

/** Human label for an audit action; falls back to a de-snaked action name. */
export function auditActionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action.replace(/_/g, ' ');
}

/** A short, safe one-line summary of the action's effect, parsed from the
 *  details JSON. Returns null when there's nothing useful to add. */
export function auditSummary(entry: AuditEntry): string | null {
  if (!entry.details) return null;
  let d: Record<string, unknown>;
  try { d = JSON.parse(entry.details) as Record<string, unknown>; } catch { return null; }

  const from = typeof d.previous_status === 'string' ? d.previous_status : null;
  const to   = typeof d.new_status === 'string' ? d.new_status : null;
  if (to) return from ? `${from} → ${to}` : to;

  if (entry.action === 'org_invite_created' && typeof d.email === 'string') {
    return typeof d.org_role === 'string' ? `${d.email} · ${d.org_role}` : d.email;
  }
  if (typeof d.notes === 'string' && d.notes) return d.notes;
  return null;
}
