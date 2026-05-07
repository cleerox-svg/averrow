// Abuse Mailbox API client.
//
// Backed by:
//   GET /api/orgs/:orgId/modules/abuse-mailbox
//   GET /api/orgs/:orgId/modules/abuse-mailbox/messages[?brandId=…]

import { useQuery } from '@tanstack/react-query';
import { apiGet } from './api';
import { useAuth } from './auth';

export interface AbuseMailboxBrandSummary {
  brand_id:                string;
  brand_name:              string;
  canonical_domain:        string;
  messages_total:          number;
  messages_phishing:       number;
  messages_malware:        number;
  messages_spam:           number;
  messages_benign:         number;
  messages_pending:        number;
  messages_high_critical:  number;
}

export interface AbuseMailboxTotals {
  messages_total:         number;
  messages_phishing:      number;
  messages_malware:       number;
  messages_spam:          number;
  messages_benign:        number;
  messages_pending:       number;
  messages_high_critical: number;
}

export interface AbuseAlias {
  alias:                   string;
  forwarding_instructions: string | null;
}

export interface AbuseMailboxSummary {
  org_id: number;
  alias:  AbuseAlias | null;
  brands: AbuseMailboxBrandSummary[];
  totals: AbuseMailboxTotals;
  unbound: { total: number; pending: number };
}

export interface AbuseInboxMessageRow {
  id:                       string;
  org_id:                   number;
  brand_id:                 string | null;
  received_at:              string;
  forwarded_by_email:       string | null;
  inbound_alias:            string | null;
  original_from:            string | null;
  original_subject:         string | null;
  original_body_snippet:    string | null;
  attachment_count:         number;
  url_count:                number;
  classification:           string;
  classified_by:            string | null;
  classification_confidence: number | null;
  classification_reason:    string | null;
  ai_assessment:            string | null;
  ai_action:                string | null;
  severity:                 string;
  status:                   string;
  ack_sent_at:              string | null;
  determination_sent_at:    string | null;
}

export interface AbuseInboxMessages {
  org_id:    number;
  brand_id:  string | null;
  messages:  AbuseInboxMessageRow[];
  page_size: number;
}

export function useAbuseMailboxSummary() {
  const { user, hasOrg } = useAuth();
  const orgId = user?.organization?.id ?? null;
  return useQuery<AbuseMailboxSummary>({
    queryKey: ['abuse-mailbox-summary', orgId],
    queryFn: async () => {
      const res = await apiGet<AbuseMailboxSummary>(`/api/orgs/${orgId}/modules/abuse-mailbox`);
      return res.data;
    },
    enabled: hasOrg && !!orgId,
    staleTime: 30_000,
  });
}

export function useAbuseInboxMessages(brandId: string | null = null) {
  const { user, hasOrg } = useAuth();
  const orgId = user?.organization?.id ?? null;
  const qs = brandId ? `?brandId=${encodeURIComponent(brandId)}` : '';
  return useQuery<AbuseInboxMessages>({
    queryKey: ['abuse-mailbox-messages', orgId, brandId ?? null],
    queryFn: async () => {
      const res = await apiGet<AbuseInboxMessages>(
        `/api/orgs/${orgId}/modules/abuse-mailbox/messages${qs}`,
      );
      return res.data;
    },
    enabled: hasOrg && !!orgId,
    staleTime: 30_000,
  });
}
