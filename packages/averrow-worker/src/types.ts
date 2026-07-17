// Averrow — Type Definitions

// ─── Cloudflare Worker Environment Bindings ─────────────────────
export interface Env {
  DB: D1Database;
  AUDIT_DB: D1Database;
  // Dedicated D1 for GeoIP reference data (MaxMind GeoLite2 / db-ip
  // Lite ranges). Optional because:
  //   1. The binding is provisioned out-of-band (operator must run
  //      `wrangler d1 create geoip-db` and uncomment the wrangler.toml
  //      block — see the geoip_refresh agent README for the runbook).
  //   2. Test harnesses + scripts that don't need geo lookups skip
  //      it entirely.
  // The lookup helper (`lib/geoip-mmdb.ts`) treats `undefined` as a
  // clean no-op so cartographer's pipeline degrades gracefully when
  // the binding isn't there.
  GEOIP_DB?: D1Database;
  // Dedicated D1 for the DNS resolution work queue (PR-1 of the
  // DNS-queue split). Holds the ~17K-row drainable subset of threats
  // that need IP resolution, isolating the heavy dns-backfill cycle
  // into its own 25B-row/month budget. Optional during the pre-stage
  // phase: the binding exists in production but no code paths read or
  // write through it yet. Subsequent PRs add dual-write (PR-2), flip
  // reads (PR-3), and remove the main-DB fallback (PR-4). Optional
  // typing means downstream callers must null-check, which forces the
  // cutover diff to land in one explicit place per call site.
  DNS_QUEUE_DB?: D1Database;
  CACHE: KVNamespace;
  ASSETS: Fetcher;
  THREAT_PUSH_HUB: DurableObjectNamespace;
  CERTSTREAM_MONITOR: DurableObjectNamespace;
  CARTOGRAPHER_BACKFILL: Workflow;
  CARTOGRAPHER_MAIN: Workflow;
  NEXUS_RUN: Workflow;
  /** Durable Campaign Hunter runtime — agentic investigation loop with
   *  per-turn checkpointing (workflows/campaignHunter.ts). */
  CAMPAIGN_HUNTER: Workflow;
  /** Durable refresh of the GeoLite2-City CSVs into GEOIP_DB.
   *  Optional because the binding is provisioned alongside the
   *  GEOIP_DB / GEOIP_STAGING setup — older deploys without
   *  geoip support keep typechecking. The agent gracefully
   *  reports an unconfigured workflow when this is undefined. */
  GEOIP_REFRESH?: Workflow;
  // Workers Analytics Engine — per-endpoint D1 read attribution.
  // Optional so non-instrumented Worker entry points (tests, scripts)
  // don't have to bind it.
  AE?: AnalyticsEngineDataset;
  // ARCHITECT meta-agent — bundle storage (optional; only bound where needed)
  ARCHITECT_BUNDLES?: R2Bucket;
  // Environment variables
  ENVIRONMENT: string;
  // Secrets
  JWT_SECRET: string;
  ANTHROPIC_API_KEY?: string;
  LRX_API_KEY?: string;
  VIRUSTOTAL_API_KEY: string;
  ABUSECH_AUTH_KEY: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_API_KEY?: string;
  // Cloudflare Radar
  CF_ACCOUNT_ID?: string;
  CF_API_TOKEN?: string;
  // GeoIP
  IPINFO_TOKEN?: string;
  // MaxMind GeoLite2 license key — required by the geoip_refresh
  // agent to fetch updated CSVs from MaxMind's permalink download
  // endpoint. Free-tier accounts get a key for personal use; the
  // refresh agent gracefully reports a config error when the key
  // isn't present, leaving the geoip table as-is.
  MAXMIND_LICENSE_KEY?: string;
  // Optional R2 binding to stage CSV downloads during refresh.
  // Without it, refresh streams directly from MaxMind in the same
  // invocation — works for small datasets (Country: ~5MB) but the
  // City CSV (~80MB compressed) needs the staging bucket to fit in
  // a single Worker invocation under the 30s CPU ceiling.
  GEOIP_STAGING?: R2Bucket;
  // Tenant-uploaded trademark logo/wordmark images (Trademark module).
  // Optional so non-instrumented entry points (tests/scripts) needn't bind it;
  // the upload/serve handlers return a clear error when it's absent.
  TRADEMARK_ASSETS?: R2Bucket;
  // Threat intelligence feeds (optional)
  OTX_API_KEY?: string;
  ABUSEIPDB_API_KEY?: string;
  HIBP_API_KEY?: string;
  // CIRCL Passive DNS
  CIRCL_PDNS_USER?: string;
  CIRCL_PDNS_PASS?: string;
  // Social feeds
  REDDIT_CLIENT_ID?: string;
  REDDIT_CLIENT_SECRET?: string;
  GITHUB_FEED_TOKEN?: string;
  TELEGRAM_BOT_TOKEN?: string;
  // Google Safe Browsing
  GOOGLE_SAFE_BROWSING_KEY?: string;
  // Google service-account JSON (Web Risk Submission API + future GCP APIs)
  GOOGLE_SERVICE_ACCOUNT_JSON?: string;
  // NetBeacon (DNS Abuse Institute) registrar-routed abuse reporting
  NETBEACON_API_KEY?: string;
  NETBEACON_API_BASE?: string;
  // GoDaddy Abuse API (direct-to-registrar abuse tickets)
  GODADDY_API_KEY?: string;
  GODADDY_API_SECRET?: string;
  GODADDY_API_BASE?: string;
  // GreyNoise IP context
  GREYNOISE_API_KEY?: string;
  // SecLookup domain + IP intelligence
  SECLOOKUP_API_KEY?: string;
  // Anthropic Admin API (optional — budget verification)
  ANTHROPIC_ADMIN_KEY?: string;
  // Resend email API (briefing delivery)
  RESEND_API_KEY?: string;
  /** Takedown outbound-email rollout flag (S1, IMPROVEMENT_PLAN_2026-06).
   *  'live' → email-send submitter actually sends abuse reports via Resend.
   *  Any other value (default 'draft') → queued-draft behavior, no outbound
   *  side effect. Flipping back to 'draft' is the kill switch. */
  TAKEDOWN_SEND_MODE?: string;
  /** Tenant weekly digest rollout flag (S4, IMPROVEMENT_PLAN_2026-06).
   *  'live' → Monday digest cron sends org-scoped weekly emails.
   *  Any other value (default 'off') → cron is a no-op. */
  TENANT_DIGEST_MODE?: string;
  /** Override the daily-briefing recipient. Defaults to claude.leroux@averrow.com when unset. */
  BRIEFING_RECIPIENT?: string;
  /** HMAC secret for List-Unsubscribe one-click tokens
   *  (handlers/abuseMailboxUnsubscribe.ts). REQUIRED for the
   *  unsubscribe path — must be set via
   *  `wrangler secret put ABUSE_UNSUBSCRIBE_SECRET`. When unset the
   *  verify endpoint fails closed (503) and link generation returns
   *  null (no AVERROW_INTERNAL_SECRET fallback — L5,
   *  SECURITY_AUDIT_2026-06-10). */
  ABUSE_UNSUBSCRIBE_SECRET?: string;
  /** Global daily ceiling on paid public AI assessments
   *  (handlers/public.ts handlePublicAssess). Optional override —
   *  defaults to 200/day when unset. Plain var, not a secret. */
  PUBLIC_ASSESS_DAILY_CAP?: string;
  AVERROW_INTERNAL_SECRET?: string;
  /** Master key for org_integrations.config_encrypted (AES-GCM, 32
   *  bytes, base64). Set via `wrangler secret put INTEGRATION_CONFIG_KEY`.
   *  When absent the encryption helpers throw on every read/write —
   *  the worker boots fine but every integration call surfaces a
   *  clear error rather than silently storing plaintext. */
  INTEGRATION_CONFIG_KEY?: string;
}

// ─── Enums ──────────────────────────────────────────────────────
export type ThreatType =
  | "phishing"
  | "typosquatting"
  | "impersonation"
  | "malware_distribution"
  | "credential_harvesting";

export type ThreatStatus = "active" | "down" | "remediated";
export type CampaignStatus = "active" | "dormant" | "disrupted";
export type FeedHealthStatus = "healthy" | "degraded" | "down" | "disabled";
export type Severity = "critical" | "high" | "medium" | "low" | "info";
export type Grade = "A" | "B" | "C" | "D" | "F";

/**
 * Global user roles. NOT to be confused with org-level roles
 * (viewer / analyst / admin / owner) which exist independently
 * inside org_members.role for customer org membership semantics.
 *
 * The global `analyst` role (Averrow internal SOC analyst) is
 * distinct from the org-level `analyst` role (a customer's
 * internal investigator) — same string, different scope. The
 * codebase always disambiguates by which table/column the role
 * is read from: `users.role` = global, `org_members.role` = org.
 *
 * Hierarchy (for `requireRole(min)` checks) — see
 * middleware/auth.ts ROLE_HIERARCHY:
 *   super_admin (5) > admin (4) > {analyst, sales, support,
 *   billing} (3) > client (1)
 *
 * The Averrow-staff roles (analyst, sales, support, billing) all
 * sit at level 3 because hierarchy can't capture their
 * differentiated permission sets — a sales user can edit pricing
 * overrides but not handle alerts; an analyst can do the
 * opposite. Use the `roleHasPermission` helper from
 * lib/role-permissions.ts when permission semantics matter
 * beyond "is this user staff or a customer".
 */
export type UserRole =
  | "super_admin"   // full platform access
  | "admin"         // platform admin (everything except super_admin-only actions)
  | "analyst"       // Averrow SOC analyst — read intel, handle alerts/takedowns/incidents
  | "sales"         // Averrow sales — read customer data, edit pricing overrides, send invites
  | "support"       // Averrow customer support — read customer data + alerts, no edits
  | "billing"       // Averrow finance — Stripe + pricing only, no customer ops access
  | "auditor"       // read-only global seat — sees ALL backend + tenant data, mutates nothing, never super_admin (AUTH_AUDIT_2026-06). Minted-only: see note below.
  | "client";       // customer (lives in /tenant; never reaches /v2)
// NOTE on `auditor` (AUTH_AUDIT_2026-06): it is a fully-functional role at
// the auth layer (read-only permission set + super_admin-style global org
// scope) but is currently **minted-only** — issued via
// /api/internal/auth/mint-ui-preview-jwt, never assigned to a stored user.
// The prod `users.role`/`invitations.role` CHECK constraints only allow
// super_admin/admin/analyst/client, and relaxing them needs a `users`
// table rebuild that is UNSAFE to auto-apply (D1 enforces FKs, so dropping
// the parent `users` cascades into sessions/passkeys/notifications). Until
// that is done in a maintenance window, `auditor` is excluded from invite
// VALID_ROLES and preview users are stored with a CHECK-valid placeholder
// role while their minted JWT carries `auditor`.
export type UserStatus = "active" | "suspended" | "deactivated";
export type InvitationStatus = "pending" | "accepted" | "expired" | "revoked";

export type AgentId = "sentinel" | "analyst" | "cartographer" | "strategist" | "observer" | "pathfinder" | "sparrow" | "nexus";
export type AgentOutputType = "insight" | "classification" | "correlation" | "score" | "trend_report" | "diagnostic";
export type RunStatus = "success" | "partial" | "failed";

export type LeadStatus = "new" | "contacted" | "qualified" | "proposal_sent" | "converted" | "closed_lost";
export type AuditOutcome = "success" | "failure" | "denied";

// ─── Core Data Models ───────────────────────────────────────────
export interface Brand {
  id: string;
  name: string;
  canonical_domain: string;
  sector: string | null;
  first_seen: string;
  threat_count: number;
  active_threat_count: number;
  last_threat_seen: string | null;
  email_security_grade: string | null;
  email_security_score: number | null;
  email_security_scanned_at: string | null;
  exposure_score: number | null;
  social_risk_score: number | null;
  domain_risk_score: number | null;
  monitoring_status: string;
  monitoring_tier: string | null;
  tranco_rank: number | null;
  official_handles: string | null;
  aliases: string | null;
  brand_keywords: string | null;
  logo_url: string | null;
  website_url: string | null;
  threat_analysis: string | null;
  analysis_updated_at: string | null;
  last_social_scan: string | null;
}

export interface Threat {
  id: string;
  source_feed: string;
  threat_type: string;
  malicious_url: string | null;
  malicious_domain: string | null;
  target_brand_id: string | null;
  hosting_provider_id: string | null;
  ip_address: string | null;
  asn: string | null;
  country_code: string | null;
  lat: number | null;
  lng: number | null;
  registrar: string | null;
  first_seen: string;
  last_seen: string;
  status: string;
  confidence_score: number | null;
  campaign_id: string | null;
  ioc_value: string | null;
  severity: string | null;
  created_at: string;
}

export interface HostingProvider {
  id: string;
  name: string;
  asn: string | null;
  country: string | null;
  active_threat_count: number;
  total_threat_count: number;
  trend_7d: number;
  trend_30d: number;
  trend_90d: number;
  avg_response_time: number | null;
  reputation_score: number | null;
}

export interface Campaign {
  id: string;
  name: string;
  first_seen: string;
  last_seen: string;
  threat_count: number;
  brand_count: number;
  provider_count: number;
  attack_pattern: string | null;
  status: CampaignStatus;
}

// ─── Auth Models ────────────────────────────────────────────────
export interface User {
  id: string;
  google_sub: string | null;
  email: string;
  name: string;
  role: UserRole;
  status: UserStatus;
  invited_by: string | null;
  created_at: string;
  last_login: string | null;
  last_active: string | null;
}

export interface Session {
  id: string;
  user_id: string;
  refresh_token_hash: string;
  issued_at: string;
  expires_at: string;
  revoked_at: string | null;
  ip_address: string | null;
  user_agent: string | null;
}

// ─── JWT ────────────────────────────────────────────────────────
export interface JWTPayload {
  sub: string;        // user ID
  email: string;
  role: UserRole;
  org_id?: string;    // organization ID (null for superadmin/internal users)
  org_role?: string;  // role within the org (owner, admin, analyst, viewer)
  /**
   * Pre-resolved org scope so getOrgScope() doesn't need 2 D1 queries on
   * every authenticated request. Optional so tokens issued before this field
   * still verify — older tokens fall back to a DB lookup at request time.
   * For super_admins this is always omitted; their scope is null by role.
   */
  org_scope?: { org_id: number; brand_ids: string[] };
  /**
   * Restricted-session marker (H-3, AUTH_AUDIT_2026-06). When set to
   * 'passkey_enroll', this token grants ONLY passkey-enrollment access
   * (register endpoints + /me + logout). It is minted for privileged
   * users (admin / super_admin) who authenticated via a non-passkey
   * method, forcing them to enroll/use a passkey before reaching any
   * protected route. Absent on every normal full session.
   */
  scope?: "passkey_enroll";
  plan?: UserPlan;    // v1 compat — remove when v1 auth handlers are replaced
  iat: number;
  exp: number;
}

// ─── Email Security ─────────────────────────────────────────────
export interface EmailSecurityScan {
  id: number;
  brand_id: string;
  domain: string;
  dmarc_exists: number;
  dmarc_policy: string | null;
  dmarc_pct: number | null;
  dmarc_rua: string | null;
  dmarc_ruf: string | null;
  dmarc_raw: string | null;
  spf_exists: number;
  spf_policy: string | null;
  spf_includes: number;
  spf_too_many_lookups: number;
  spf_raw: string | null;
  dkim_exists: number;
  dkim_selectors_found: string | null;
  dkim_raw: string | null;
  mx_exists: number;
  mx_providers: string | null;
  email_security_score: number;
  email_security_grade: string | null;
  scanned_at: string;
  scan_duration_ms: number | null;
}

// ─── Organizations ──────────────────────────────────────────────
export interface Organization {
  id: number;
  name: string;
  slug: string;
  plan: string;
  created_at: string;
}

export interface OrgBrand {
  id: number;
  org_id: number;
  brand_id: string;
  is_primary: number;
  monitoring_config_json: string | null;
  created_at: string;
}

export interface OrgMember {
  id: number;
  org_id: number;
  user_id: string;
  role: string;
  created_at: string;
}

// ─── Takedowns ──────────────────────────────────────────────────
export type TakedownStatus = 'draft' | 'requested' | 'submitted' | 'pending_response' | 'taken_down' | 'failed' | 'expired' | 'withdrawn';
export type TakedownTargetType = 'domain' | 'social_profile' | 'url' | 'email';

export interface TakedownRequest {
  id: string;
  org_id: number;
  brand_id: string;
  target_type: TakedownTargetType;
  target_value: string;
  target_platform: string | null;
  target_url: string | null;
  source_type: string | null;
  source_id: string | null;
  evidence_summary: string;
  evidence_detail: string | null;
  evidence_urls: string | null;
  provider_name: string | null;
  provider_abuse_contact: string | null;
  provider_method: string;
  status: TakedownStatus;
  severity: string;
  priority_score: number;
  notes: string | null;
  requested_by: string | null;
  requested_at: string | null;
  submitted_by: string | null;
  submitted_at: string | null;
  resolved_at: string | null;
  resolution: string | null;
  response_notes: string | null;
  created_at: string;
  updated_at: string;
}

// ─── Sales Leads ────────────────────────────────────────────────
export interface SalesLead {
  id: number;
  brand_id: string;
  prospect_score: number;
  score_breakdown_json: string | null;
  status: string;
  company_name: string | null;
  company_domain: string | null;
  company_industry: string | null;
  company_size: string | null;
  company_revenue_range: string | null;
  company_hq: string | null;
  research_json: string | null;
  researched_at: string | null;
  target_name: string | null;
  target_title: string | null;
  target_linkedin: string | null;
  target_email: string | null;
  email_security_grade: string | null;
  threat_count_30d: number | null;
  phishing_urls_active: number | null;
  trap_catches_30d: number | null;
  composite_risk_score: number | null;
  pitch_angle: string | null;
  findings_summary: string | null;
  outreach_variant_1: string | null;
  outreach_variant_2: string | null;
  outreach_selected: string | null;
  outreach_sent_at: string | null;
  outreach_channel: string | null;
  identified_by: string | null;
  rejection_reason: string | null;
  ai_enriched: number;
  ai_enriched_at: string | null;
  // Firmographic snapshot — populated from brand_firmographics + Pathfinder AI research.
  // See migration 0190. Source of truth is brand_firmographics; these are copies-at-qualify-time.
  revenue_band: string | null;
  employee_band: string | null;
  industry_naics: string | null;
  is_public: number | null;
  ticker: string | null;
  founded_year: number | null;
  parent_company: string | null;
  // Buying signals — see migration 0189/0190.
  security_maturity: string | null;
  last_breach_disclosed_at: string | null;
  security_news_headline: string | null;
  security_news_url: string | null;
  cyber_10k_mentions: number | null;
  created_at: string;
  updated_at: string;
}

export interface CreateLeadInput {
  brand_id: string;
  prospect_score: number;
  score_breakdown_json?: string | null;
  company_name?: string | null;
  company_domain?: string | null;
  email_security_grade?: string | null;
  threat_count_30d?: number | null;
  phishing_urls_active?: number | null;
  trap_catches_30d?: number | null;
  composite_risk_score?: number | null;
  pitch_angle?: string | null;
  findings_summary?: string | null;
  identified_by?: string;
  // Firmographic snapshot at create time (Pathfinder pulls from brand_firmographics).
  revenue_band?: string | null;
  employee_band?: string | null;
  industry_naics?: string | null;
  is_public?: number | null;
  ticker?: string | null;
  founded_year?: number | null;
  parent_company?: string | null;
  last_breach_disclosed_at?: string | null;
  security_news_headline?: string | null;
  security_news_url?: string | null;
  cyber_10k_mentions?: number | null;
}

export interface EnrichLeadInput {
  findings_summary: string;
  outreach_variant_1: string | null;
  outreach_variant_2: string | null;
  research_json: string;
  // Dedicated columns persisted from the Haiku research result so the UI
  // can render structured fields instead of cracking the JSON blob.
  company_industry?: string | null;
  company_size?: string | null;
  company_hq?: string | null;
  target_name?: string | null;
  target_title?: string | null;
  target_email?: string | null;
  target_linkedin?: string | null;
  security_maturity?: string | null;
  // Buying signal harvested from web_search (recent_security_news).
  security_news_headline?: string | null;
  security_news_url?: string | null;
  last_breach_disclosed_at?: string | null;
}

// ─── Spam Trap ──────────────────────────────────────────────────
export interface SpamTrapCapture {
  id: number;
  trap_address: string;
  trap_domain: string;
  trap_channel: string | null;
  from_address: string | null;
  from_domain: string | null;
  subject: string | null;
  spf_result: string | null;
  dkim_result: string | null;
  dmarc_result: string | null;
  dmarc_disposition: string | null;
  sending_ip: string | null;
  spoofed_brand_id: string | null;
  spoofed_domain: string | null;
  category: string;
  severity: string;
  url_count: number;
  attachment_count: number;
  raw_headers: string | null;
  body_preview: string | null;
  captured_at: string;
}

// ─── Agent Runs ─────────────────────────────────────────────────
export interface AgentRun {
  id: string;
  agent_id: string;
  status: string;
  error_message: string | null;
  records_processed: number;
  outputs_generated: number;
  tokens_used: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
}

export interface CompleteRunStats {
  records_processed: number;
  outputs_generated: number;
  status?: string;
  error_message?: string | null;
  tokens_used?: number | null;
}

// ─── Agent Output ───────────────────────────────────────────────
export interface AgentOutput {
  id: string;
  agent_id: string;
  run_id: string;
  output_type: string;
  content_json: string;
  brand_id: string | null;
  threat_id: string | null;
  campaign_id: string | null;
  created_at: string;
}

// ─── DMARC ──────────────────────────────────────────────────────
export interface DmarcReport {
  id: number;
  brand_id: string | null;
  domain: string;
  reporter_org: string | null;
  reporter_email: string | null;
  report_id: string | null;
  date_begin: string | null;
  date_end: string | null;
  total_records: number;
  total_messages: number;
  total_pass: number;
  total_fail: number;
  policy_published: string | null;
  raw_xml: string | null;
  received_at: string;
  processed: number;
}

// ─── Notifications ──────────────────────────────────────────────
export interface Notification {
  id: number;
  user_id: string;
  type: string;
  title: string;
  body: string | null;
  resource_type: string | null;
  resource_id: string | null;
  read: number;
  created_at: string;
}

// ─── Query Options ──────────────────────────────────────────────
export interface BrandListOptions {
  limit?: number;
  offset?: number;
  orderBy?: string;
  direction?: 'ASC' | 'DESC';
  sector?: string;
  monitoringStatus?: string;
}

export interface ThreatQueryOptions {
  limit?: number;
  offset?: number;
  status?: string;
  type?: string;
  days?: number;
  severity?: string;
}

// ─── API Request Bodies ─────────────────────────────────────────
export interface CreateTakedownBody {
  brand_id: string;
  target_type: string;
  target_value: string;
  evidence_summary: string;
  evidence_detail?: string;
  target_platform?: string;
  target_url?: string;
  source_type?: string;
  source_id?: string;
  evidence_urls?: string;
  notes?: string;
}

export interface UpdateTakedownBody {
  status?: string;
  notes?: string;
  evidence_summary?: string;
  evidence_detail?: string;
  severity?: string;
  response_notes?: string;
}

export interface UpdateThreatBody {
  status?: string;
  severity?: string;
  confidence_score?: number;
}

export interface UpdateSalesLeadBody {
  status?: string;
  notes?: string;
  outreach_variant_1?: string;
  outreach_variant_2?: string;
  outreach_selected?: string;
  outreach_channel?: string;
  target_name?: string;
  target_title?: string;
  target_email?: string;
  target_linkedin?: string;
  // Manual overrides — a rep can correct firmographic snapshot fields if
  // the auto-enricher got something wrong. These don't propagate back to
  // brand_firmographics; that's the auto-enricher's source of truth.
  company_industry?: string;
  company_size?: string;
  company_hq?: string;
  security_maturity?: string;
}

export interface IngestSignalBody {
  source?: string;
  domain?: string;
  range_m?: number;
  intensity_dbz?: number;
  quality?: number;
  tags?: string[];
}

export interface CreateTicketBody {
  title?: string;
  description?: string;
  severity?: string;
  priority?: string;
  category?: string;
  tags?: string[];
}

export interface UpdateTicketBody {
  status?: string;
  severity?: string;
  priority?: string;
  assignee_id?: string;
  notes?: string;
  resolution?: string;
}

export interface AddEvidenceBody {
  capture_type?: string;
  target_url?: string;
  content_hash?: string;
  storage_path?: string;
  metadata?: Record<string, unknown>;
}

export interface CreateErasureBody {
  ticket_id?: string;
  target_type?: string;
  target_value?: string;
  provider?: string;
  provider_email?: string;
  method?: string;
  abuse_notice?: string;
}

export interface UpdateErasureBody {
  status?: string;
  response?: string;
}

export interface UpdateFeedBody {
  enabled?: boolean | number;
  display_name?: string;
  description?: string;
  source_url?: string;
  schedule_cron?: string;
  rate_limit?: number;
  batch_size?: number;
}

export interface MonitoringConfigBody {
  alert_severity_filter?: string[];
  auto_acknowledge_low_days?: number;
  social_platforms_monitored?: string[];
  email_notifications?: boolean;
  email_notification_threshold?: string;
  weekly_digest?: boolean;
  custom_keywords?: string[];
  excluded_domains?: string[];
}

export interface PaginationParams {
  limit: number;
  offset: number;
}

export interface PaginatedResponse<T> {
  success: boolean;
  data: T[];
  total: number;
}

// ─── API Response ───────────────────────────────────────────────
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

// ─── Takedown Evidence ──────────────────────────────────────────
export type EvidenceType = 'screenshot' | 'whois' | 'dns' | 'brand_comparison' | 'email_headers' | 'url_scan' | 'ai_report';

export interface TakedownEvidence {
  id: string;
  takedown_id: string;
  evidence_type: EvidenceType;
  title: string;
  content_text: string | null;
  storage_key: string | null;
  storage_url: string | null;
  metadata_json: string | null;
  created_at: string;
}

// ─── URL Scan Results ───────────────────────────────────────────
export interface UrlScanResult {
  id: number;
  url: string;
  domain: string;
  source_type: 'spam_trap' | 'threat_signal' | 'manual';
  source_id: string | null;
  brand_id: string | null;
  known_threat: number;
  known_threat_id: string | null;
  google_safe_browsing: string | null;
  phishtank_status: string | null;
  urlhaus_status: string | null;
  virustotal_status: string | null;
  domain_age_days: number | null;
  registrar: string | null;
  hosting_provider: string | null;
  hosting_ip: string | null;
  hosting_country: string | null;
  ssl_issuer: string | null;
  ssl_valid: number | null;
  is_malicious: number;
  malicious_reasons: string | null;
  confidence_score: number | null;
  takedown_id: string | null;
  scanned_at: string;
}

// ─── Takedown Provider ──────────────────────────────────────────
export interface TakedownProvider {
  id: number;
  provider_name: string;
  provider_type: 'registrar' | 'hosting' | 'social_platform' | 'cdn' | 'email_provider' | 'reporting';
  abuse_email: string | null;
  abuse_url: string | null;
  abuse_api_url: string | null;
  abuse_api_type: 'rest' | 'form' | 'email' | null;
  avg_response_hours: number | null;
  success_rate: number | null;
  notes: string | null;
}

// ─── Threat Actors ─────────────────────────────────────────────
export type ThreatActorStatus = "active" | "dormant" | "disrupted" | "unknown";
export type AttributionConfidence = "confirmed" | "high" | "medium" | "low" | "suspected";
export type ThreatActorCapability = "destructive" | "espionage" | "infrastructure" | "influence_ops";

export interface ThreatActor {
  id: string;
  name: string;
  aliases: string | null;
  attribution: string | null;
  country: string | null;
  description: string | null;
  ttps: string | null;
  target_sectors: string | null;
  active_campaigns: string | null;
  first_seen: string | null;
  last_seen: string | null;
  status: ThreatActorStatus;
  created_at: string;
  updated_at: string;
}

export interface ThreatActorInfrastructure {
  id: string;
  threat_actor_id: string;
  asn: string | null;
  ip_range: string | null;
  domain: string | null;
  hosting_provider: string | null;
  country_code: string | null;
  confidence: string;
  first_observed: string;
  last_observed: string;
  notes: string | null;
  created_at: string;
}

export interface ThreatActorTarget {
  id: string;
  threat_actor_id: string;
  brand_id: string | null;
  sector: string | null;
  target_type: string;
  context: string | null;
  first_targeted: string;
  last_targeted: string;
  created_at: string;
}

// ─── v1 Legacy Types (used by existing handlers — remove during v2 migration) ──
export type RiskLevel = "safe" | "low" | "medium" | "high" | "critical";
export type UserPlan = "free" | "pro" | "enterprise";

export interface ScanFlag {
  type: string;
  severity: RiskLevel;
  detail: string;
}

export interface ScanMetadata {
  ip?: string;
  country?: string;
  registrar?: string;
  registered_at?: string;
  ssl_valid?: boolean;
  ssl_expiry?: string;
  redirects?: string[];
  virustotal?: {
    malicious: number;
    suspicious: number;
    harmless: number;
    undetected: number;
  };
  ai_insight?: {
    summary: string;
    explanation: string;
    recommendations: string[];
  };
}

export interface ScanResult {
  id: string;
  url: string;
  domain: string;
  trust_score: number;
  risk_level: RiskLevel;
  flags: ScanFlag[];
  metadata: ScanMetadata;
  cached: boolean;
  created_at: string;
}
