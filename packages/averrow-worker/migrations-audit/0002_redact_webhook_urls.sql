-- Averrow — redact org webhook URLs from historic audit rows
--
-- Before PR #1749, handleUpdateWebhook (handlers/organizations.ts) logged
--   action  = 'webhook_config_updated'
--   details = { "webhook_url": <the full URL as submitted>, "webhook_events": [...] }
-- Slack / Teams / Discord webhook URLs carry their own credential in the
-- path (and sometimes the subdomain, userinfo or query), and since #1748
-- view_audit roles (analyst, auditor) can read and CSV-export audit_log.
-- #1749 made new rows store redactWebhookUrl() (lib/org-public.ts). This
-- migration rewrites the rows written before it to the same form.
--
-- audit_log is append-only by convention only (0001's comment; lib/audit.ts
-- INSERTs). There is no UPDATE/DELETE trigger, hash chain, sequence or
-- signature column, so this UPDATE breaks no tamper evidence. It does leave
-- a mark: every rewritten row gets "webhook_url_redacted_by" (+ the original
-- value's length), and the run itself is recorded as an
-- 'audit_redaction_applied' row (statement 3).
--
-- Redaction rule (SQL port of redactWebhookUrl / redactHost). After trimming
-- surrounding space/tab/CR/LF, a value is kept in reduced form ONLY when it
-- parses as  http(s)://[userinfo@]<host>[:<port>][/ \ ? # ...]  with
--   * <host> plain dotted DNS labels of [a-z0-9_-] (case-folded), no empty
--     label, no "xn--" label, and a last label that is neither all digits
--     nor "0x…" (WHATWG would parse those as IPv4); or a strict dotted-quad
--     IPv4 (octets 0-255, no leading zeros); or a bracketed IPv6 literal of
--     hex groups (<= 4 digits, 2-7 colons, at most one "::", no zone/dots);
--   * <port> empty or decimal <= 65535;
-- and the output is "<scheme>://<reduced host>/…" where <reduced host> is the
-- host as-is when it has <= the kept number of labels or is an IP literal,
-- otherwise "…" + the last 2 labels, or the last 3 when the TLD is 2 chars
-- and the second-level label is <= 3 chars (co.uk, com.au) — exactly
-- redactHost(). Path, query, fragment, userinfo and port are never kept.
-- Everything else becomes "[redacted]".
--
-- Parity with the TS helper. For every input, the SQL output is either
-- identical to redactWebhookUrl(input) or "[redacted]", with ONE exception:
-- a valid IPv6 literal is kept as written (lowercased) where WHATWG would
-- re-spell it in canonical compressed form (e.g. "[2001:db8:0:0:0:0:0:1]"
-- vs "[2001:db8::1]") — the same address, no extra information. Inputs
-- that become "[redacted]" here but not in TS include: schemes other than
-- http/https, "https:host" without "//", IDN / punycode / %-escaped hosts,
-- WHATWG-normalised IPv4 forms (shorthand, hex, octal, leading zeros),
-- IPv6 with embedded IPv4 or a zone, a trailing-dot host ("a.com."),
-- internal tabs/newlines, and non-string values.
--
-- Fixed points. A host starting with "…" is accepted ONLY when the whole
-- trimmed value is exactly "<http|https>://…label(.label)+/…" with no more
-- labels than redactHost keeps; any other "…" host becomes "[redacted]". So
-- every value redactWebhookUrl produced after #1749 maps to itself and is not
-- stamped, EXCEPT TS outputs for hosts this rule redacts (trailing dot gives
-- TS "https://…com./…"; punycode gives "https://…xn--….com/…"): those rows
-- are re-redacted to "[redacted]" and stamped. Re-running is a no-op.
-- '' (webhook cleared) and JSON null carry no credential and are left as-is.

-- 1. Rows with valid JSON details and a credential-bearing webhook_url.
--    Each CTE step is MATERIALIZED: without it SQLite flattens the chain and
--    inlines every column reference, which grows the expression tree
--    exponentially.
WITH
  src AS MATERIALIZED (
    SELECT id,
      -- CASE guards keep json_* off malformed details (json_extract raises
      -- on invalid JSON); those rows are handled by statement 2.
      CASE WHEN json_valid(details) THEN json_type(details, '$.webhook_url') END AS vtype,
      CASE WHEN json_valid(details) THEN json_extract(details, '$.webhook_url') END AS original
    FROM audit_log
    WHERE action = 'webhook_config_updated'
  ),
  s1 AS MATERIALIZED (
    SELECT id, vtype, original,
      CASE WHEN vtype = 'text' THEN trim(original, ' ' || char(9) || char(10) || char(13)) END AS v
    FROM src
    WHERE vtype IS NOT NULL AND vtype <> 'null'
  ),
  s2 AS MATERIALIZED (
    SELECT id, vtype, original, v, instr(v, '://') AS sep FROM s1
  ),
  s3 AS MATERIALIZED (
    SELECT id, vtype, original, v, sep,
      lower(CASE WHEN sep > 0 THEN substr(v, 1, sep - 1) ELSE '' END) AS scheme,
      CASE WHEN sep > 0 THEN substr(v, sep + 3) ELSE '' END AS rest
    FROM s2
  ),
  -- authority = rest cut at the first '/', '\', '?' or '#' (cutting at each
  -- delimiter in turn leaves the prefix before the earliest of them)
  s4 AS MATERIALIZED (
    SELECT id, vtype, original, v, sep, scheme,
      CASE WHEN instr(rest, '/') > 0 THEN substr(rest, 1, instr(rest, '/') - 1) ELSE rest END AS a1
    FROM s3
  ),
  s5 AS MATERIALIZED (
    SELECT id, vtype, original, v, sep, scheme,
      CASE WHEN instr(a1, '\') > 0 THEN substr(a1, 1, instr(a1, '\') - 1) ELSE a1 END AS a2
    FROM s4
  ),
  s6 AS MATERIALIZED (
    SELECT id, vtype, original, v, sep, scheme,
      CASE WHEN instr(a2, '?') > 0 THEN substr(a2, 1, instr(a2, '?') - 1) ELSE a2 END AS a3
    FROM s5
  ),
  s7 AS MATERIALIZED (
    SELECT id, vtype, original, v, sep, scheme,
      CASE WHEN instr(a3, '#') > 0 THEN substr(a3, 1, instr(a3, '#') - 1) ELSE a3 END AS auth
    FROM s6
  ),
  -- drop userinfo: rtrim(X, <every char of X except '@'>) strips the
  -- trailing non-'@' run, so its length is the position of the LAST '@'
  s8 AS MATERIALIZED (
    SELECT id, vtype, original, v, sep, scheme,
      substr(auth, length(rtrim(auth, replace(auth, '@', ''))) + 1) AS hp
    FROM s7
  ),
  -- split host from port; a bracketed IPv6 literal is taken whole
  s9 AS MATERIALIZED (
    SELECT id, vtype, original, v, sep, scheme, hp,
      CASE
        WHEN substr(hp, 1, 1) = '['
          THEN CASE WHEN instr(hp, ']') > 0 THEN substr(hp, 1, instr(hp, ']')) ELSE hp END
        WHEN instr(hp, ':') > 0 THEN substr(hp, 1, instr(hp, ':') - 1)
        ELSE hp
      END AS host_raw
    FROM s8
  ),
  -- label split, same rtrim trick on '.':
  --   p1 = host up to and including its last '.', tld = what follows
  --   p2 / p3 = host up to the 2nd / 3rd-from-last '.'
  s10 AS MATERIALIZED (
    SELECT id, vtype, original, v, sep, scheme,
      lower(host_raw) AS host,
      substr(hp, length(host_raw) + 1) AS port_part,
      CASE WHEN substr(host_raw, 1, 1) = '…' THEN lower(substr(host_raw, 2)) ELSE lower(host_raw) END AS dns_host,
      CASE WHEN substr(host_raw, 1, 1) = '[' AND substr(host_raw, -1, 1) = ']' AND length(host_raw) > 2
        THEN lower(substr(host_raw, 2, length(host_raw) - 2)) ELSE '' END AS v6,
      rtrim(lower(host_raw), replace(lower(host_raw), '.', '')) AS p1
    FROM s9
  ),
  s11 AS MATERIALIZED (
    SELECT id, vtype, original, v, sep, scheme, host, port_part, dns_host, v6, p1,
      substr(host, length(p1) + 1) AS tld,
      CASE WHEN p1 = '' THEN '' ELSE substr(p1, 1, length(p1) - 1) END AS q1
    FROM s10
  ),
  s12 AS MATERIALIZED (
    SELECT id, vtype, original, v, sep, scheme, host, port_part, dns_host, v6, p1, tld, q1,
      rtrim(q1, replace(q1, '.', '')) AS p2
    FROM s11
  ),
  s13 AS MATERIALIZED (
    SELECT id, vtype, original, v, sep, scheme, host, port_part, dns_host, v6, p1, tld, p2,
      substr(q1, length(p2) + 1) AS second,
      CASE WHEN p2 = '' THEN '' ELSE substr(p2, 1, length(p2) - 1) END AS q2
    FROM s12
  ),
  s14 AS MATERIALIZED (
    SELECT id, vtype, original, v, sep, scheme, host, port_part, dns_host, v6, p1, tld, p2, second, q2,
      rtrim(q2, replace(q2, '.', '')) AS p3
    FROM s13
  ),
  s15 AS MATERIALIZED (
    SELECT id, vtype, original, v, sep, scheme, host, port_part, dns_host, v6, tld, p2, p3,
      CASE WHEN p1 = '' THEN 1 WHEN p2 = '' THEN 2 WHEN p3 = '' THEN 3 ELSE 4 END AS nlabels,
      CASE WHEN length(tld) = 2 AND length(second) <= 3
                AND p1 <> '' AND p2 <> '' THEN 3 ELSE 2 END AS keep,
      -- octets, meaningful only for a 4-label host (IPv4 check)
      second AS o3,
      substr(q2, length(p3) + 1) AS o2,
      CASE WHEN p3 = '' THEN '' ELSE substr(p3, 1, length(p3) - 1) END AS o1,
      -- IPv6 group checks
      length(v6) - length(replace(v6, ':', '')) AS v6_colons,
      (length(v6) - length(replace(v6, '::', ''))) / 2 AS v6_dbl
    FROM s14
  ),
  redacted AS MATERIALIZED (
    SELECT id, original,
      CASE
        WHEN vtype <> 'text' THEN '[redacted]'
        WHEN v = '' THEN original
        -- (a) only http / https
        WHEN sep = 0 OR scheme NOT IN ('http', 'https') THEN '[redacted]'
        -- (b) port: nothing, or ':' + at most 5 decimal digits <= 65535
        WHEN port_part <> ''
             AND (substr(port_part, 1, 1) <> ':'
                  OR length(port_part) > 6
                  OR substr(port_part, 2) GLOB '*[^0-9]*'
                  OR (length(port_part) > 1 AND CAST(substr(port_part, 2) AS INTEGER) > 65535))
          THEN '[redacted]'
        -- (d) bracketed IPv6: hex groups of <= 4 digits, 2..7 colons, at most
        --     one '::' (exactly 7 colons without one), no ':::', no lone
        --     leading/trailing ':'; no zone, no embedded IPv4
        WHEN substr(host, 1, 1) = '['
          THEN CASE
                 WHEN v6 <> ''
                      AND v6 NOT GLOB '*[^0-9a-f:]*'
                      AND v6 NOT GLOB '*[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]*'
                      AND instr(v6, ':::') = 0
                      AND v6_colons BETWEEN 2 AND 7
                      AND v6_dbl <= 1
                      AND (v6_dbl = 1 OR v6_colons = 7)
                      AND (substr(v6, 1, 1) <> ':' OR substr(v6, 1, 2) = '::')
                      AND (substr(v6, -1, 1) <> ':' OR substr(v6, -2, 2) = '::')
                   THEN scheme || '://' || host || '/…'
                 ELSE '[redacted]'
               END
        -- DNS host: plain dotted labels only
        WHEN dns_host = ''
             OR dns_host GLOB '*[^a-z0-9._-]*'
             OR instr(dns_host, '..') > 0
             OR substr(dns_host, 1, 1) = '.' OR substr(dns_host, -1, 1) = '.'
             OR instr(dns_host, 'xn--') > 0
          THEN '[redacted]'
        -- (c) numeric (or 0x) last label = WHATWG IPv4 parse: keep only a
        --     strict dotted quad, octets 0-255 without leading zeros
        WHEN tld NOT GLOB '*[^0-9]*' OR tld GLOB '0x*'
          THEN CASE
                 WHEN host NOT GLOB '*[^0-9.]*'
                      AND nlabels = 4
                      AND length(host) - length(replace(host, '.', '')) = 3
                      AND host NOT GLOB '*[0-9][0-9][0-9][0-9]*'
                      AND host NOT GLOB '0[0-9]*' AND host NOT GLOB '*.0[0-9]*'
                      AND CAST(o1 AS INTEGER) <= 255 AND CAST(o2 AS INTEGER) <= 255
                      AND CAST(o3 AS INTEGER) <= 255 AND CAST(tld AS INTEGER) <= 255
                   THEN scheme || '://' || host || '/…'
                 ELSE '[redacted]'
               END
        -- (e) a leading '…' is a fixed point only in the exact redacted form
        WHEN substr(host, 1, 1) = '…'
          THEN CASE
                 WHEN v = scheme || '://' || host || '/…'
                      AND nlabels >= 2 AND nlabels <= keep
                   THEN v
                 ELSE '[redacted]'
               END
        WHEN nlabels <= keep THEN scheme || '://' || host || '/…'
        WHEN keep = 2 THEN scheme || '://…' || substr(host, length(p2) + 1) || '/…'
        ELSE scheme || '://…' || substr(host, length(p3) + 1) || '/…'
      END AS value
    FROM s15
  )
UPDATE audit_log
   SET details = json_set(audit_log.details,
                          '$.webhook_url', r.value,
                          '$.webhook_url_redacted_by', '0002_redact_webhook_urls',
                          '$.webhook_url_original_length', length(r.original))
  FROM redacted AS r
 WHERE audit_log.id = r.id
   AND r.value IS NOT r.original;

-- 2. Rows whose details is not valid JSON cannot be edited key-by-key.
--    lib/audit.ts always writes JSON.stringify output, so none are expected;
--    if one exists for this action it may hold a URL, so replace it whole.
UPDATE audit_log
   SET details = json_object('webhook_url', '[redacted]',
                             'details_unparseable', 1,
                             'webhook_url_redacted_by', '0002_redact_webhook_urls')
 WHERE action = 'webhook_config_updated'
   AND details IS NOT NULL
   AND NOT json_valid(details);

-- 3. Record the cleanup in the audit log itself (same columns lib/audit.ts
--    writes; system action, so user_id/ip/user_agent are NULL). Fixed id +
--    ON CONFLICT DO NOTHING keeps a re-run from adding a second row.
INSERT INTO audit_log (id, user_id, action, resource_type, resource_id, details, ip_address, user_agent, outcome)
VALUES (
  'migration-audit-0002_redact_webhook_urls',
  NULL,
  'audit_redaction_applied',
  'audit_log',
  'webhook_config_updated',
  json_object(
    'migration', '0002_redact_webhook_urls',
    'field', 'details.webhook_url',
    'reason', 'webhook URLs embed credentials; audit_log is readable by view_audit roles',
    'rows_redacted', (
      SELECT count(*) FROM audit_log
       WHERE action = 'webhook_config_updated'
         AND (CASE WHEN json_valid(details)
                   THEN json_extract(details, '$.webhook_url_redacted_by') END) = '0002_redact_webhook_urls'
    )
  ),
  NULL,
  NULL,
  'success'
)
ON CONFLICT(id) DO NOTHING;
