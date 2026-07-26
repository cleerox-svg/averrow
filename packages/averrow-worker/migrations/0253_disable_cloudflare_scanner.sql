-- Re-disable the cloudflare_scanner ingest feed — platform audit 2026-07-26.
--
-- This feed was FIRST disabled on 2026-05-16 (migration 0198,
-- "Tier 1 of the 2026-05-16 platform audit") on the grounds that the
-- four columns it writes (cf_scan_id, cf_verdict, cf_categories,
-- cf_rank) were 99.94-100% NULL AND had zero read consumers anywhere
-- in src/. It was subsequently re-enabled (enabled = 1,
-- paused_reason = NULL) WITHOUT revalidating that rationale — nothing
-- in the codebase re-seeds feed_configs, so like the six feeds in 0252
-- the row was flipped back manually via the admin toggle.
--
-- Live diagnostics 2026-07-26 show it burning ~70M D1 reads/day while
-- the original zero-consumer finding still holds. Re-verified this
-- audit: cf_scan_id / cf_verdict / cf_categories are read ONLY inside
-- feeds/cloudflare_scanner.ts (its own writer + Phase-2 verdict poller)
-- and nowhere else in src/. (cf_rank is a SEPARATE column read in
-- lib/enrichment.ts for the CF Radar domain-ranking check — that is
-- unrelated and unaffected by disabling this feed.)
--
-- To re-enable: fix/justify a real read consumer first, then set
-- feed_configs.enabled = 1, paused_reason = NULL for this feed_name.

UPDATE feed_configs
   SET enabled = 0,
       paused_reason = 'platform-audit-2026-07-26: re-confirmed zero read consumers per 0198, re-enabled without revalidation'
 WHERE feed_name = 'cloudflare_scanner';
