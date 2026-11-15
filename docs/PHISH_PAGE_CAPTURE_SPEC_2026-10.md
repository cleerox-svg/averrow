# Phishing Page Capture — Build Spec (2026-10-12)

Owner decisions (2026-10-12): capture engine **Cloudflare Browser Rendering**
(Worker `[browser]` binding); retention **180 days**; build it. This approves
the `wrangler.toml` binding, the new R2 bucket and the dedicated cron below
(CLAUDE.md §9a items that normally need an explicit OK).

## Goal
Render suspected fake login pages in a real headless browser, save a
screenshot + the rendered HTML as tamper-evident evidence, and show it on the
Identity Threats detection detail (and attach it to takedowns).

## Scope (v1)
- **What gets captured:** threats in the IdP family
  (`IDP_FAMILY_TECHNIQUES`, `lib/idp-impersonation.ts`) that have a
  `malicious_url` or `malicious_domain`, newest first; plus manual
  "Capture now" from the detail panel. Lookalike-domain rows are a later slice.
- **Never:** submit forms, type into inputs, click, download files, or follow
  `javascript:`/`data:` navigations. Navigation only, then capture.

## Pipeline
1. **Queue table** — migration `NNNN_page_captures.sql` (additive):
   `page_captures(id TEXT PK, threat_id TEXT, target_url TEXT NOT NULL,
   status TEXT CHECK IN ('queued','capturing','captured','failed','blocked','expired'),
   attempts INTEGER DEFAULT 0, requested_by TEXT NULL /* user id for manual */,
   final_url TEXT, http_status INTEGER, page_title TEXT,
   redirect_chain_json TEXT, form_action_hosts_json TEXT,
   desktop_key TEXT, mobile_key TEXT, html_key TEXT,
   desktop_sha256 TEXT, mobile_sha256 TEXT, html_sha256 TEXT,
   html_bytes INTEGER, error TEXT, anti_bot_wall TEXT,
   queued_at TEXT, captured_at TEXT, expires_at TEXT, created_at TEXT)`.
   Indexes: `(status, queued_at)`, `(threat_id, created_at)`, and a partial
   unique index so a threat has at most ONE `queued|capturing` row.
2. **Enqueue** (`lib/page-capture.ts` `enqueueCapture`): `INSERT … WHERE NOT EXISTS`
   open row. Called (a) when a threat is tagged into the IdP family
   (`lib/idp-tagging.ts` call sites — bounded, cheap), (b) by the manual POST.
   Backfill: a bounded internal route enqueues existing IdP-family threats from
   the last 7 days (most phishing pages are dead after that).
3. **Worker** — dedicated cron **`*/10 * * * *`** (own Worker budget; early-return
   on an exact `event.cron` match like `executive_monitor`). Runs as an
   `executeAgent` AgentModule `page_capture` so it writes `agent_runs` +
   `agent_events` (CLAUDE.md §6). Per run: claim up to `CAPTURE_BATCH` (5) rows
   (`queued` → `capturing`, attempts+1), capture sequentially with ONE browser
   session, per-page hard timeout 20 s, total run budget ~4 min. Reaper: rows
   stuck `capturing` > 15 min go back to `queued` (max 3 attempts → `failed`).
4. **Capture** (`@cloudflare/puppeteer`, binding `env.BROWSER`):
   - Pre-flight: reuse `assertResolvedHostSafe` (`lib/page-fetch.ts`) — refuse
     private/loopback targets.
   - Request interception: abort downloads/media/fonts > limits; block
     non-http(s) schemes; record the redirect chain.
   - Desktop viewport 1366×900 screenshot (PNG, full viewport, not full page),
     then mobile viewport 390×844 + mobile UA screenshot.
   - `page.content()` → rendered HTML, capped at 2 MB.
   - Extract `<form action>` hosts and `<title>`; detect anti-bot walls via the
     existing `CHALLENGE_PHRASES` → status `blocked` (still store the screenshot).
5. **Storage** — new private R2 bucket **`averrow-phish-captures`**, binding
   `PHISH_CAPTURES`. Keys: `captures/{yyyy}/{mm}/{capture_id}/desktop.png`,
   `mobile.png`, `page.html`, `meta.json` (meta = target, final URL, chain,
   hashes, UA, timestamps, worker version). SHA-256 of every object stored in
   D1 and in `meta.json`. R2 `customMetadata` carries `threat_id`.
6. **Retention (180 days)** — R2 lifecycle rule on prefix `captures/`
   (delete after 180 days, set when the bucket is created) + a daily sweep in
   the capture cron's first run after 00:00 UTC that marks D1 rows
   `expired` and nulls their keys once `expires_at < now`
   (`expires_at = captured_at + 180 days`).
7. **Evidence linking** — on success, if a `takedown_requests` row exists for
   the threat (`source_type='threat'`, `source_id`), insert a
   `takedown_evidence` row (`evidence_type='screenshot'`) and set
   `takedown_requests.screenshot_url` if NULL (value = the staff API path, not
   a public URL).

## API (all `requireStaff` unless noted; add to docs/API_REFERENCE.md)
- `GET /api/intel/captures/:id/screenshot?variant=desktop|mobile` → streams PNG
  from R2 (`image/png`, `Cache-Control: private, max-age=3600`,
  `X-Content-Type-Options: nosniff`).
- `GET /api/intel/captures/:id/html` → download only:
  `Content-Type: application/octet-stream`,
  `Content-Disposition: attachment; filename="capture-<id>.html.txt"`,
  `Content-Security-Policy: sandbox`, `X-Content-Type-Options: nosniff`.
  Never served as `text/html`.
- `POST /api/intel/identity-threats/detections/:threatId/capture` → enqueue a
  manual capture; `requirePermission('edit_alerts')`; audited
  (`page_capture_requested`); 409 if one is already open; per-user KV rate limit
  (20/hour). Returns `{ id, status: 'queued' }`.
- Detail endpoint (`/api/intel/identity-threats/detections/:threatId`) gains:
  ```ts
  captures: {
    id: string;
    status: 'queued'|'capturing'|'captured'|'failed'|'blocked'|'expired';
    queued_at: string; captured_at: string | null; expires_at: string | null;
    final_url: string | null; http_status: number | null; page_title: string | null;
    redirect_chain: string[]; form_action_hosts: string[];
    anti_bot_wall: string | null; error: string | null;
    screenshot_desktop_url: string | null;   // API path, null unless stored
    screenshot_mobile_url: string | null;
    html_download_url: string | null;
    sha256: { desktop: string | null; mobile: string | null; html: string | null };
  }[]   // newest first, max 5
  ```
- Internal (AVERROW_INTERNAL_SECRET): `POST /api/internal/captures/backfill?days=7&limit=200`
  and `POST /api/internal/agents/page_capture/run`.

## Network evidence (2026-11-15, migration 0335)
A capture also stores ONE compact JSON object, `captures/{yyyy}/{mm}/{id}/network.json`,
so the IOK rules read the real `html`, `headers`, `requests` and `cookies`
(`lib/page-capture-network.ts`, wired in `lib/page-capture-browser.ts`).

- **What the Browser Rendering puppeteer API gives us, and what we store.**
  Nothing is fetched: the collector reads what the browser already did.

  | Artifact | Source | Stored |
  |---|---|---|
  | Main response headers | `page.goto()`'s `HTTPResponse.headers()` (lower-cased names; repeated headers joined with `\n`) | `Canonical-Name: value`, one entry per value, sorted (the form IOK renders); ≤ 100 entries, value ≤ 4096 chars |
  | Main response body as served (pre-JS) | `HTTPResponse.buffer()` (CDP `Network.getResponseBody`: the whole decoded body as one base64 message), **only when its decoded size is known to be ≤ 2 MB** (see below) | text in the JSON object, decoded with the response's charset, cut at 2 MB (`NET_MAX_BODY_BYTES` = the stored HTML cap) |
  | Request log | the `request` event the driver already handles (every frame, redirects included): method, resource type, URL | ≤ 300 distinct entries, URL ≤ 2 KB; `b: 1` marks a request our interception aborted; later (mobile reload) requests are ignored |
  | Cookies | `page.cookies()` at the end of the desktop capture (own origin: URL-scoped, then domain-checked) | ≤ 50, name ≤ 128, value ≤ 512, plus domain / path / secure / httpOnly; the jar is cleared at the start of each capture so a previous capture's cookies cannot appear |

  Not obtainable here, so not claimed: third-party cookies, WebSocket and
  service-worker traffic (not seen by request interception), external
  script / stylesheet bodies (not needed: `js` / `css` stay inline-only
  subsets), headers of earlier redirect hops (the final response's headers
  are what IOK's `headers` means).
- **Body size gate (the body can exhaust the isolate otherwise).**
  `Content-Length` is the compressed size and is absent for chunked / endless
  responses, so it cannot bound a decompression bomb. The driver therefore
  asks the browser for the body only when the decoded size is known:
  (1) CDP `Network.dataReceived` (decoded chunk length) summed per request id
  on the capture's own CDP session, once `Network.loadingFinished` arrived —
  a running total above 2 MB means `too_large` immediately, never read;
  (2) without those events, a `Content-Length` ≤ 2 MB with no
  `Content-Encoding` and no chunked transfer. Anything else is recorded as
  `unavailable` / `too_large` and never fetched (`bodyFetchVerdict`). A body
  that arrives after the 3 s read deadline is dropped, and its size was
  already bounded by the gate. `html` then stays the rendered-DOM
  approximation for that capture.
- **Other documents and encodings.** `matches_final` records whether the
  main response URL is the document the page ended on (fragment ignored); after
  a JS / meta-refresh navigation headers and body belong to an earlier
  document, so `html` and `headers` are a subset, never exact, and a rule that
  negates them does not run. The body is decoded with the response's charset;
  only clean UTF-8 or pure ASCII is "text exact" (IOK compares raw bytes), so
  a windows-1252 page with non-ASCII bytes, invalid UTF-8 or an unsupported
  label makes `html` a subset.
- **Cookie jar.** The browser context is shared inside a run, so each capture
  starts with `Network.clearBrowserCookies` on its own CDP session (opening
  the session and the clear each time-boxed to 1 s). If either fails or times
  out, this capture records NO cookies (`cookies: null`) rather than risk
  attributing a previous page's; an empty / unparseable page host also drops
  all cookies.
- **Request log freeze.** The log stops at the desktop settle point
  (`freeze()`): "complete" means up to then; a request issued afterwards is
  not in it.
- **Fidelity switch** (`IokEvidence.fidelity`, `lib/iok-engine.ts`): `html` is
  exact when the raw body was stored uncut; `headers` exact when the header
  list is complete; `requests` exact when the log is complete (no cap hit and
  no request our own interception aborted for the SSRF guard, the host cap or
  a non-http scheme — a blocked response cannot have requested what it would
  have; media / font aborts do not count); `cookies` is always a subset (page
  origin only). A cut artifact is a subset. Without network evidence (older
  captures, a failed collection, a failed R2 write) the old approximations
  apply. A match lists the fields that were not exact on that capture.
- **Negation:** a rule that negates a field is evaluated only when that field
  is exact on the capture; otherwise it is `not_applicable` (never matches,
  not a budget skip, `kit_eval_status` unchanged). An empty header list must
  not make `not nginxHeader` true.
- **Storage / privacy:** header and cookie values can carry tracking ids, so
  they exist only in the private R2 object (same bucket, 180-day lifecycle +
  daily sweep, the sweep deleting `network.json` for EVERY expired capture
  whatever its recorded status — a put that committed and then threw leaves an
  object with no status; the R2 lifecycle rule on the `captures/` prefix is the
  backstop and must exist in prod: **owner check** (see Deploy dependencies);
  SHA-256 in `page_captures.net_evidence_sha256` and in
  `meta.json` `objects.network`). D1 holds only `net_evidence_status`
  (`complete` | `partial` | `failed` | NULL = none / older capture) and the
  counters `net_requests`, `net_headers`, `net_cookies`. There is no staff or
  tenant route for the object, no value in logs, `agent_outputs` or
  `meta.json` (counters only) — pinned by `test/iok-kit-matches-exposure.test.ts`.
- **Failure isolation:** every collector call is bounded and never throws; a
  hung body / cookie read is cut after at most 3 s and runs while the
  screenshot is taken; a failure only sets the status flag, and the capture,
  the screenshots and the DOM-based matching are unaffected.
- **Unverified against the real service** (only a fake page was tested):
  (a) that `response.buffer()` on the main document returns the decoded body
  while request interception is on and the page is `waitUntil: load`; (b)
  that a second CDP session on the page receives `Network.dataReceived` /
  `loadingFinished` for the main document with the same request id as
  Puppeteer's `HTTPRequest.id` (typed `@internal`, present at runtime in
  1.4.0) — if not, only the strict `Content-Length` path applies and
  compressed pages keep the DOM approximation; (c) that `page.cookies()`
  returns JS-set cookies; (d) that `Network.clearBrowserCookies` /
  `Network.enable` are permitted in Browser Rendering (a refusal means no
  cookies and no size events, never a failed capture); (e) extra wall time /
  CPU per capture — the body and cookie reads overlap the desktop screenshot.
  **After the first deploy check:** the `net_evidence_status` distribution
  (complete / partial / failed / NULL), how often `html` is still the DOM
  approximation (`partial` with no body), the capture success rate against
  the previous week (`page_captures.status`, `agent_runs` of `page_capture`),
  and capture duration (`agent_runs` duration, `captured_at - claimed`);
  roll back by reverting the driver wiring if any regresses.

## Kit matching (IOK rules, 2026-11-15, migration 0333)
After a capture is stored, the agent matches it against the open IOK
phishing-kit ruleset (phish.report, ODbL; `docs/licences/iok.md`). No new
fetching: the evidence is what the capture already holds.

- **Ruleset:** vendored and compiled at dev time by
  `scripts/vendor-iok-rules.ts` (`pnpm vendor:iok --src <IOK checkout>`) into
  `src/data/iok/rules.json`, with `LICENSE` and `SOURCE.md` (origin, commit,
  counts, drop reasons, refresh steps). Commit `142f762a`: 266 rules, 262
  kept, 4 dropped (2 have a regex that is not on the allowlist, 2 carry a
  credential-shaped token in a match value — third-party tokens are not
  vendored). Before migration 0335 it was 258 kept / 8 dropped: the 3 rules
  using `headers` / `cookies` and the 1 negating `html` are now kept. About
  132 KB.
- **Evidence** (`buildIokEvidence`, `lib/iok-engine.ts`):

  | IOK field | What we evaluate | Fidelity |
  |---|---|---|
  | `dom` | rendered HTML (`page.html`) | exact |
  | `hostname` | host of `final_url` (else target) | exact |
  | `title` | `page_title` (final title only) | subset: can miss |
  | `js` / `css` | inline `<script>` / `<style>` bodies only | subset: can miss |
  | `html` | the main response as served (network evidence); else the rendered HTML | exact with network evidence; otherwise approximate: can miss and over-match (script-injected markup) |
  | `requests` | the browser's request log (network evidence); else redirect chain, final URL, and URLs the DOM's own start tags reference | exact with a complete log; otherwise approximate: can miss (fetch/XHR) and over-match (referenced, never requested) |
  | `headers` | the main response's headers (network evidence) | exact when complete; no data without network evidence |
  | `cookies` | the page origin's cookies (network evidence) | subset (IOK also reads third-party cookies); no data without network evidence |

  Under `not` only a field that can be exact is allowed (`dom`, `hostname`,
  `html`, `requests`, `headers`); a rule negating `title` / `js` / `css` /
  `cookies` is dropped, and a rule negating `html` / `requests` / `headers`
  runs only where that field is exact on the capture (see Network evidence).
  Positive use of an approximate field is kept: the over-match is bounded to "the
  kit's string is in the rendered page" or "the page's markup points at the
  kit's file", and each match lists the non-exact fields its rule reads
  (`approximate_fields`). `src=` inside script text, comments, `<noscript>`
  or page text is not a reference.
- **Semantics** follow the reference implementation (iok.go on sigma-go
  v0.6.4, case-sensitive; `*` in a `contains` value is a literal there too):
  checked against it on generated inputs with 0 differences.
- **Regexes:** a regex runs only if its exact source is on the hand-reviewed
  allowlist `lib/iok-regex-allowlist.ts` (rule id, reviewed commit, measured
  worst case), checked at vendor time and again at run time; a static screen
  (`assessRegexSafety`) is a second check. One pattern is allowed today
  (0.3 ms on adversarial 256K input); `class-attribute-obfuscation` was
  measured at 184 ms and refused.
- **Other limits:** HTML capped at 1M chars, regex input at 256K, lists at
  300 items, matches at 50; a work budget (characters scanned) ends an
  evaluation between comparisons. Workers freezes the clock during
  synchronous work, so the budget does not rely on time. No `eval`.
- **Cost:** about 4 ms for a 50 KB page, 7 ms for 200 KB, 33 ms at the 1M
  cap (Node 22); at most ~165 ms CPU per 5-capture tick.
- **Storage:** `page_capture_kit_matches` (capture_id, rule_id, rule_title,
  rule_tags_json, approx_fields_json, ruleset_commit, matched_at; PK capture
  + rule) and `page_captures.kit_ruleset_commit` / `kit_evaluated_at` /
  `kit_eval_status` (`complete`, `truncated` = input was clipped, `partial` =
  budget ran out; NULL = never evaluated). A re-evaluation deletes the
  capture's rows and inserts the new set in one batch. The 180-day expiry
  sweep deletes a capture's match rows with its evidence. Off-site decoy
  captures are skipped. A failure never fails the capture (`kit_errors`).
- **Context only:** matches never create alerts, change severity or triage,
  or enter takedown text. The only reader is the staff detection detail
  (`captures[].kit_matching`, with the attribution string). No tenant or
  public API returns them (`test/iok-kit-matches-exposure.test.ts`).
- **Not done:** captures stored before 0333 / 0335 are not backfilled (their
  kit matching keeps the approximations); no staff route serves `network.json`.

## UI (ops)
In the detection detail panel (`DetectionsSection.tsx`), a **Page capture**
group above Data points:
- Latest capture: mobile screenshot thumbnail (tap → full-screen viewer with
  desktop/mobile toggle), status badge, captured time, final URL, where the
  login form posts (form-action hosts — highlight if off-domain), redirect
  chain, "Download HTML (evidence)" link, SHA-256 (copyable), expiry date.
- States: queued/capturing ("Capturing… usually within 10 min"), blocked
  ("Page hid behind an anti-bot check" + screenshot), failed (error + retry),
  expired, none ("Capture now" button, permission-gated; disabled with
  reason when the user lacks `edit_alerts`).
- Images load through the authenticated API (fetch → blob URL), never a
  public URL.

## Deploy dependencies (owner)
1. Create R2 bucket `averrow-phish-captures` with a lifecycle rule: prefix
   `captures/`, delete objects after 180 days.
2. Browser Rendering available on the account (Workers Paid).
3. (Migration 0335) the lifecycle rule in (1) also covers `network.json` — it
   holds header and cookie values and is the last line of defence if a sweep
   is missed. Confirm it exists in prod.
Merge only after (1) exists — deploy fails on a missing bucket binding.

## Risks
- Browser Rendering cost/limits (concurrent sessions, browser-hours) — batch
  of 5 every 10 min ≈ 720/day max; tune `CAPTURE_BATCH` down if spend rises.
- Captured pages contain brand logos and possibly victim emails pre-filled in
  URLs — staff-only, private bucket, 180-day expiry.
- Cloaked kits will often render a decoy/blank page — recorded as `blocked`.
  `anti_bot_wall` is `offsite_redirect` when the browser ended on a known
  decoy front door the target was not already on (`isDecoyRedirect`,
  `lib/page-capture.ts`; checked first, ahead of `cf_challenge` / `blank_page`).
  Matching is on the final host, in three tiers: content sites (any path),
  vendor marketing front doors (any path), and user-content platforms
  (homepage / locale path only); tenant and product subdomains are never
  decoys. Such captures are excluded from takedown evidence — at success time
  and in the catch-up probe, which falls back to an older real capture.
  The IdP backfill (`POST /api/admin/backfills/idp-impersonation`) enqueues
  captures only for live threats (`status='active'`, seen within the 7-day
  `CAPTURE_STALE_QUEUE_DAYS`).
