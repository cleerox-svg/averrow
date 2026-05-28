-- Backfill: mark name-fallback false positives in dark_web_mentions
--
-- The initial dark-web ransomware ingest (lib/dark-web-ransomware-
-- ingest.ts shipped in PR #1446) used a brand-name substring
-- fallback when the victim_domain wasn't in the brand-domain map.
-- First post-merge cron tick (2026-05-28 06:14 + 12:14 UTC)
-- produced 51 CRITICAL/confirmed rows; only ~3 were genuine domain
-- matches. The remaining ~48 were the name-fallback firing on common
-- English-word brands (Office, One, Line, Current, Tesla, IBM,
-- Opera, Siemens, Cloud, Dns, Domain, Forms, Media, Box, Three) and
-- on a junk catalog row "Www" (canonical_domain www.gov.uk) that
-- caught any URL containing "www.".
--
-- PR #1448 strips the name-fallback in code. This migration
-- retroactively flags the resulting false positives so they stop
-- polluting the UI immediately. A row is a false positive when its
-- matched_terms[0] (the victim's domain captured at ingest time)
-- does not equal the brand's canonical_domain after stripping
-- "www." — exactly the criterion the new domain-exact matcher
-- enforces going forward.
--
-- Idempotent: only touches active ransomware_leak rows. Re-running
-- after deploy is a no-op because the false-positive rows have
-- status='false_positive'.

UPDATE dark_web_mentions
SET status                = 'false_positive',
    classification        = 'false_positive',
    classification_reason = 'backfill PR-1448: matched via removed name-substring fallback; victim_domain != brand canonical_domain',
    updated_at            = datetime('now')
WHERE source = 'ransomware_leak'
  AND status = 'active'
  AND id IN (
    SELECT dwm.id
    FROM dark_web_mentions dwm
    LEFT JOIN brands b ON b.id = dwm.brand_id
    WHERE dwm.source = 'ransomware_leak'
      AND dwm.status = 'active'
      AND (
        b.canonical_domain IS NULL
        OR LOWER(REPLACE(b.canonical_domain, 'www.', ''))
           != LOWER(COALESCE(json_extract(dwm.matched_terms, '$[0]'), ''))
      )
  );
