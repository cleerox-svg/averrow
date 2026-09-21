import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface LookalikeDomain {
  id: string;
  brand_id: string;
  domain: string;
  registered: number;
  threat_level: 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE' | 'CRITICAL' | null;
  status: string | null;
  ip_address: string | null;
  registrar: string | null;
  bimi_record: string | null;
  created_at: string;
  updated_at: string;

  // ── Page analysis (migrations 0243, 0260, 0264) ──────────────────────
  // Deterministic page-content phishing scorer output + Lane 3 Phase 1
  // shadow-mode signals. See docs/LANE3_AI_BUILD_ARTIFACTS_SPEC.md §3.5.
  // The staff API is already `SELECT *` (handlers/lookalikeDomains.ts) so
  // these fields are already in the payload — only this interface was
  // missing them.
  //
  // `page_fetched_at === null` is the authoritative "never scanned"
  // marker — every other page_* field is null on an unscanned row too,
  // but page_fetched_at is the one to gate on. A non-null
  // page_fetched_at with empty signal arrays means "checked, nothing
  // found" (a result, not an absence).
  /** ISO-8601 timestamp of the last (attempted or successful) page fetch. Null = never scanned. */
  page_fetched_at: string | null;
  /** Final HTTP status of the fetched page. */
  page_http_status: number | null;
  /** 0-100 deterministic score from the live (scored) signal set. */
  page_phishing_score: number | null;
  /** JSON array (string, un-parsed) of fired LIVE/scored signal keys — parse before rendering. */
  page_signals: string | null;
  /** SHA-256 of the fetched page body — change detection only, not for display. */
  page_content_hash: string | null;
  /** Authoritative anti-bot-wall family, or null: turnstile|recaptcha|hcaptcha|cf_challenge|js_challenge. */
  page_anti_bot_wall: string | null;
  /** JSON array (string, un-parsed) of fired Lane 3 SHADOW signal keys — computed but NEVER scored. */
  page_ai_signals: string | null;
  /** Would-be shadow score contribution. NOT added to page_phishing_score. */
  page_score_delta: number | null;
  /** `<meta name="generator">` content, truncated to 64 chars. Weight zero — grouping dimension only. */
  page_generator: string | null;
  /** Host only of a matched covert/relay exfil sink (e.g. 'api.telegram.org'). NEVER render as a link — defang before display. */
  page_exfil_sink: string | null;
  /** Bot/webhook id extracted from `page_exfil_sink` — non-secret pivot key for cross-brand kit clustering. */
  page_exfil_sink_id: string | null;
  /** JSON object (string, un-parsed) mapping fired key -> matched literal, truncated to 64 chars. Staff-only field. */
  page_evidence: string | null;
}

export interface LookalikesParams {
  registered?: 0 | 1;
  threat_level?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

export function useLookalikes(brandId: string, params: LookalikesParams = {}) {
  const qs = new URLSearchParams();
  if (params.registered !== undefined) qs.set('registered', String(params.registered));
  if (params.threat_level) qs.set('threat_level', params.threat_level);
  if (params.status) qs.set('status', params.status);
  if (params.limit !== undefined) qs.set('limit', String(params.limit));
  if (params.offset !== undefined) qs.set('offset', String(params.offset));
  const query = qs.toString();

  return useQuery({
    queryKey: ['lookalikes', brandId, params],
    queryFn: async () => {
      const res = await api.get<LookalikeDomain[]>(
        `/api/lookalikes/${brandId}${query ? `?${query}` : ''}`,
      );
      return {
        data: (res.data || []) as LookalikeDomain[],
        total: res.total ?? 0,
      };
    },
    placeholderData: keepPreviousData,
    enabled: !!brandId,
  });
}

export function useScanLookalikes() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (brandId: string) =>
      api.post(`/api/lookalikes/${brandId}/scan`),
    onSuccess: (_, brandId) => {
      qc.invalidateQueries({ queryKey: ['lookalikes', brandId] });
    },
  });
}
