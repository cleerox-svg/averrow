// Abuse Mailbox API client.
//
// Backed by:
//   GET /api/orgs/:orgId/modules/abuse-mailbox
//   GET /api/orgs/:orgId/modules/abuse-mailbox/messages[?brandId=…]

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPatch } from './api';
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

export interface AbuseInboxMessageDetail extends AbuseInboxMessageRow {
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

export function useAbuseInboxMessageDetail(messageId: string | null) {
  const { user, hasOrg } = useAuth();
  const orgId = user?.organization?.id ?? null;
  return useQuery<AbuseInboxMessageDetail | null>({
    queryKey: ['abuse-mailbox-message-detail', orgId, messageId],
    queryFn: async () => {
      const res = await apiGet<AbuseInboxMessageDetail>(
        `/api/orgs/${orgId}/modules/abuse-mailbox/messages/${encodeURIComponent(messageId!)}`,
      );
      return res.data ?? null;
    },
    enabled: hasOrg && !!orgId && Boolean(messageId),
    staleTime: 60_000,
  });
}

// ─── PR-BD: status mutation + intel summary (tenant) ─────────

export type AbuseMessageStatus = 'new' | 'investigating' | 'resolved' | 'dismissed';

export function useUpdateAbuseMessageStatus() {
  const { user } = useAuth();
  const orgId = user?.organization?.id ?? null;
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ messageId, status }: { messageId: string; status: AbuseMessageStatus }) => {
      const res = await apiPatch<{ id: string; status: AbuseMessageStatus }, { status: AbuseMessageStatus }>(
        `/api/orgs/${orgId}/modules/abuse-mailbox/messages/${encodeURIComponent(messageId)}/status`,
        { status },
      );
      return res.data;
    },
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ['abuse-mailbox-message-detail', orgId, vars.messageId] });
      qc.invalidateQueries({ queryKey: ['abuse-mailbox-messages'] });
      qc.invalidateQueries({ queryKey: ['abuse-mailbox-summary'] });
    },
  });
}

export interface IntelCampaign  { campaign_id: string; campaign_name: string | null; first_seen: string; count: number; }
export interface IntelTakedown  { message_id: string; received_at: string; original_subject: string | null; target: string | null; hosting_provider: string | null; hosting_country: string | null; }
export interface IntelProvider  { hosting_provider: string; hosting_country: string | null; count: number; }
export interface AbuseMailboxIntel {
  campaigns:          IntelCampaign[];
  recent_takedowns:   IntelTakedown[];
  hosting_providers:  IntelProvider[];
  analyzed_count_7d:  number;
  analyzed_count_30d: number;
}

export function useAbuseMailboxIntel() {
  const { user, hasOrg } = useAuth();
  const orgId = user?.organization?.id ?? null;
  return useQuery<AbuseMailboxIntel>({
    queryKey: ['abuse-mailbox-intel', orgId],
    queryFn: async () => {
      const res = await apiGet<AbuseMailboxIntel>(`/api/orgs/${orgId}/modules/abuse-mailbox/intel`);
      return res.data;
    },
    enabled: hasOrg && !!orgId,
    staleTime: 60_000,
  });
}
