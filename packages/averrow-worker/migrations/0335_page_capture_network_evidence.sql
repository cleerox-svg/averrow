-- Migration 0335: network evidence for page captures (IOK exact fields).
--
-- Additive only: five new nullable columns on page_captures. No data change.
--
-- During a capture the page_capture agent now also records, as ONE compact
-- JSON object in the private R2 bucket (`<capture prefix>/network.json`, same
-- 180-day expiry sweep as the other evidence objects): the main document's
-- response body as served, its headers, the list of requests the page made,
-- and the cookies of the page's own origin (lib/page-capture-network.ts). The
-- IOK kit rules read them as the exact `html`, `headers`, `requests` and
-- `cookies` fields (lib/iok-engine.ts).
--
-- The object's content is NOT in D1: header and cookie values can carry
-- tracking identifiers, and the object has no reader route (staff or tenant).
-- D1 holds only what proves the object exists and says how complete it is:
--
--   net_evidence_status  NULL      = no network evidence (captures stored
--                                    before this migration, or a driver that
--                                    produced none); the IOK engine then
--                                    evaluates `html` / `requests` as the
--                                    approximations it always used
--                        'complete' every part was obtained and stored
--                        'partial'  some part is missing (e.g. the body was
--                                    unavailable, cookies unreadable)
--                        'failed'   collection or the R2 write failed; no
--                                    object, IOK evaluated without it
--   net_evidence_sha256  SHA-256 of the stored object (also in meta.json);
--                        kept after expiry, like the other hashes
--   net_requests         requests listed in the object (cap 300)
--   net_headers          main-response header entries stored
--   net_cookies          own-origin cookies stored (cap 50)
ALTER TABLE page_captures ADD COLUMN net_evidence_status TEXT;
ALTER TABLE page_captures ADD COLUMN net_evidence_sha256 TEXT;
ALTER TABLE page_captures ADD COLUMN net_requests INTEGER;
ALTER TABLE page_captures ADD COLUMN net_headers INTEGER;
ALTER TABLE page_captures ADD COLUMN net_cookies INTEGER;

-- Which of a match's non-exact fields are SUBSETS (incomplete evidence: other
-- rules may have been missed) rather than approximations (can over-match).
-- approx_fields_json keeps listing every non-exact field; this JSON array is
-- the subset part. NULL (matches written before this column) is read as
-- title / js / css only, the fields that were always subsets.
ALTER TABLE page_capture_kit_matches ADD COLUMN subset_fields_json TEXT;
