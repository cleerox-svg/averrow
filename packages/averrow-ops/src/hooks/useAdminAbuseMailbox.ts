// PR-AA — hooks for the /admin/abuse-mailbox page.
//
// Wraps GET /api/admin/abuse-mailbox + GET /api/admin/abuse-mailbox/messages.
// Same payload shape as the tenant module endpoints — see
// `src/handlers/adminAbuseMailbox.ts` for the wrapping rationale.

import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface AdminAbuseAlias {
  alias: string;
  forwarding_instructions: string | null;
}

export interface AdminAbuseMailboxTotals {
  messages_total:         number;
  messages_phishing:      number;
  messages_malware:       number;
  messages_spam:          number;
  messages_benign:        number;
  messages_pending:       number;
  messages_high_critical: number;
}

export interface AdminAbuseMailboxBrandSummary {
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

export interface AdminAbuseMailboxSummary {
  org_id:  number;
  alias:   AdminAbuseAlias | null;
  brands:  AdminAbuseMailboxBrandSummary[];
  totals:  AdminAbuseMailboxTotals;
  unbound: { total: number; pending: number };
}

export interface AdminAbuseInboxMessage {
  id:                       string;
  org_id:                   number;
  brand_id:                 string | null;
  received_at:              string;
  forwarded_by_email:       string | null;
  forwarded_by_domain:      string | null;
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
  throttled:                number;        // 0 | 1 — PR-AT
  throttle_reason:          string | null; // 'sender_rate_limit' | 'domain_rate_limit' | null
}

export function useAdminAbuseMailboxSummary() {
  return useQuery({
    queryKey: ['admin-abuse-mailbox-summary'],
    queryFn: async () => {
      const res = await api.get<AdminAbuseMailboxSummary>('/api/admin/abuse-mailbox');
      return res.data ?? null;
    },
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });
}

export function useAdminAbuseMailboxMessages(brandId: string | null) {
  return useQuery({
    queryKey: ['admin-abuse-mailbox-messages', brandId],
    queryFn: async () => {
      const qs = brandId ? `?brandId=${encodeURIComponent(brandId)}` : '';
      const res = await api.get<{ messages: AdminAbuseInboxMessage[] }>(
        `/api/admin/abuse-mailbox/messages${qs}`,
      );
      return res.data ?? { messages: [] };
    },
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });
}

// ─── PR-AS detail (raw body / headers / URLs / attachments) ─────

export interface ExtractedUrl {
  url:    string;
  domain: string | null;
  count:  number;
}

export interface ExtractedAttachment {
  filename:  string;
  mime_type: string | null;
}

export interface AdminAbuseInboxMessageDetail extends AdminAbuseInboxMessage {
  raw_body:              string | null;
  raw_headers:           Record<string, string> | null;
  extracted_urls:        ExtractedUrl[]        | null;
  attachment_names:      ExtractedAttachment[] | null;
  raw_size_bytes:        number | null;
  // PR-AX
  auth_results:          { spf: string | null; dkim: string | null; dmarc: string | null } | null;
  sender_ip:             string | null;
  correlated_threat_ids: string[] | null;
  promoted_threat_ids:   string[] | null;
  // PR-BC
  deep_analysis:         DeepAnalysisShape | null;
}

export interface DeepAnalysisShape {
  attribution: {
    hosting_provider:      string | null;
    hosting_country:       string | null;
    sender_asn:            string | null;
    correlated_campaigns:  Array<{ id: string; name: string | null; first_seen: string }>;
  };
  internal_narrative:  string;
  external_narrative:  string;
  recommended_action: {
    category: 'takedown' | 'abuse_report' | 'block' | 'monitor' | 'none';
    target:   string | null;
    details:  string;
  };
  analyzed_at: string;
  model:       string;
}

/**
 * Fetch full per-message detail including the raw body, all headers,
 * the extracted URL list, and attachment filenames. Lazy — only runs
 * when an id is provided (the drill-down panel passes null otherwise).
 */
export function useAdminAbuseMailboxMessageDetail(messageId: string | null) {
  return useQuery({
    queryKey: ['admin-abuse-mailbox-message-detail', messageId],
    queryFn: async () => {
      const res = await api.get<AdminAbuseInboxMessageDetail>(
        `/api/admin/abuse-mailbox/messages/${encodeURIComponent(messageId!)}`,
      );
      return res.data ?? null;
    },
    enabled: Boolean(messageId),
    staleTime: 60_000,
  });
}

/**
 * Clear the rate-limit flag on a specific message. Caller can re-run
 * the classifier afterwards to pick it up. Used from the drill-down
 * UI when a legit submission was caught in a flood.
 */
export function useUnthrottleAbuseMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (messageId: string) => {
      const res = await api.post<{ id: string; rows_changed: number }>(
        `/api/admin/abuse-mailbox/messages/${encodeURIComponent(messageId)}/unthrottle`,
        {},
      );
      return res.data;
    },
    onSuccess: (_data, messageId) => {
      qc.invalidateQueries({ queryKey: ['admin-abuse-mailbox-message-detail', messageId] });
      qc.invalidateQueries({ queryKey: ['admin-abuse-mailbox-messages'] });
    },
  });
}
