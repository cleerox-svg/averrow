-- Cartographer-exhaust recovery — fixes the two bugs that produced
-- the 1,609-row stuck pile observed on 2026-05-06.
--
-- Bug 1 (~761 rows): ThreatFox emits IOCs of type 'ip:port' as
-- `1.2.3.4:443`. We stored the whole string in threats.ip_address.
-- Both Phase 0 (ip-api.com) and Phase 0.5 (MMDB) reject it as
-- invalid IPv4 — Phase 0 silently fails at the ip-api boundary,
-- Phase 0.5's ipv4ToInt() returns null on the first call to
-- Number("4.443") and short-circuits before the D1 lookup. After 5
-- attempts the row exhausts. The bare IPs (without :port) resolve
-- cleanly in the existing geoip-db.
--
-- Bug 2 (~2,551 rows, of which 841 also exhausted): rows have
-- lat/lng/asn/hosting_provider_id all populated but enriched_at IS
-- NULL. They show as unenriched in every dashboard because
-- platform-diagnostics, cartographer-health, and the agent SELECT
-- filters all key on `enriched_at IS NULL`. Most-likely culprit is
-- a historical write-path (probably an early version of the
-- backfill workflow) that landed lat without stamping enriched_at.
-- The forward-going code paths now all stamp it, so this is a
-- one-shot data fix; the long-term invariant audit can follow.
--
-- Both fixes are idempotent — re-running this migration is a no-op
-- because the WHERE clauses self-gate.

-- ─── Bug 1: strip :port from ip_address, reset retry counter ───
--
-- Match shape: 1-3 digits, dot, 1-3 digits, dot, 1-3 digits, dot,
-- 1-3 digits, colon, anything. SQLite GLOB is the cheapest way to
-- gate the SUBSTR — instr(ip, ':') < 16 keeps us out of IPv6
-- territory (any plausible IPv4 with port has the colon at offset
-- < 16: '255.255.255.255:65535' fits inside that bound).
UPDATE threats
   SET ip_address          = SUBSTR(ip_address, 1, INSTR(ip_address, ':') - 1),
       enrichment_attempts = 0
 WHERE ip_address LIKE '%.%.%.%:%'
   AND ip_address NOT GLOB '*[a-fA-F]*'        -- exclude IPv6 (hex chars)
   AND INSTR(ip_address, ':') BETWEEN 8 AND 16;

-- malicious_domain on these rows mirrors the IP string (set at
-- ingest by the threatfox feed). Strip the port there too so
-- downstream consumers don't see `1.2.3.4:443` as a "domain".
UPDATE threats
   SET malicious_domain = SUBSTR(malicious_domain, 1, INSTR(malicious_domain, ':') - 1)
 WHERE malicious_domain LIKE '%.%.%.%:%'
   AND malicious_domain NOT GLOB '*[a-fA-F]*'
   AND INSTR(malicious_domain, ':') BETWEEN 8 AND 16;

-- ─── Bug 2: stamp enriched_at where geo is already populated ───
--
-- Any threat with lat IS NOT NULL is already enriched by definition
-- — the COALESCE-and-CASE patterns in cartographer.ts and
-- geoip.ts only ever land lat alongside an enriched_at stamp on
-- the *current* code path. The orphaned rows came from earlier
-- write-paths.
UPDATE threats
   SET enriched_at = datetime('now')
 WHERE lat         IS NOT NULL
   AND enriched_at IS NULL;
