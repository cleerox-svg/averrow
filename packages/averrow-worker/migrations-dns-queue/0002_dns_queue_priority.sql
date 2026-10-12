-- 0002_dns_queue_priority.sql — priority lane for the DNS work queue
--
-- Identity-provider-impersonation threats (threats.technique IN
-- IDP_FAMILY_TECHNIQUES, lib/idp-impersonation.ts) must resolve FIRST:
-- every downstream enrichment (Cartographer Phase 0 geo/ASN/provider,
-- GreyNoise) is gated on threats.ip_address. Before this, the drain
-- (lib/dns-backfill.ts) walked idx_dns_queue_drainable in
-- attempted_resolve_at order, so an IdP row waited behind the whole
-- ~17K-35K drainable set.
--
-- Additive only:
--   priority  0 = normal (every existing row, the DEFAULT)
--             1 = IdP family (lib/dns-queue-priority.ts DNS_PRIORITY_IDP)
--   Writers: the reconciler (stamps 1 when the candidate threat's technique
--   is IdP-family), CertStreamMonitor's direct enqueue, and
--   POST /api/internal/dns-queue/prioritize-idp. All upsert with
--   ON CONFLICT … DO UPDATE SET priority = excluded.priority
--   WHERE excluded.priority > dns_queue.priority — a row is only ever
--   promoted, never demoted.
--
-- idx_dns_queue_priority_drainable is a partial index over ONLY the
-- drainable priority rows (a handful to a few hundred), so the drain's
-- priority read costs ≤ that many rows per Navigator tick. The normal read
-- keeps idx_dns_queue_drainable and adds `priority = 0` as a residual, so a
-- priority row is never returned twice. EXPLAIN pinned in
-- test/dns-queue-priority.test.ts:
--   SCAN dns_queue USING INDEX idx_dns_queue_priority_drainable
--   SCAN dns_queue USING INDEX idx_dns_queue_drainable

ALTER TABLE dns_queue ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_dns_queue_priority_drainable
  ON dns_queue(attempted_resolve_at)
  WHERE priority > 0 AND enrichment_attempts < 8;
