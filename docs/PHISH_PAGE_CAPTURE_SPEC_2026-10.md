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

## Kit matching (IOK rules, 2026-11-15, migration 0333)
After a capture is stored, the agent matches it against the open IOK
phishing-kit ruleset (phish.report, ODbL; `docs/licences/iok.md`). No new
fetching: the evidence is what the capture already holds.

- **Ruleset:** vendored and compiled at dev time by
  `scripts/vendor-iok-rules.ts` (`pnpm vendor:iok --src <IOK checkout>`) into
  `src/data/iok/rules.json`, with `LICENSE` and `SOURCE.md` (origin, commit,
  counts, drop reasons, refresh steps). Commit `142f762a`: 266 rules, 258
  kept, 8 dropped (2 need `headers`, 1 needs `cookies`, 2 have a regex that
  is not on the allowlist, 1 negates a non-exact field, 2 carry a
  credential-shaped token in a match value — third-party tokens are not
  vendored). About 130 KB.
- **Evidence** (`buildIokEvidence`, `lib/iok-engine.ts`):

  | IOK field | What we evaluate | Fidelity |
  |---|---|---|
  | `dom` | rendered HTML (`page.html`) | exact |
  | `hostname` | host of `final_url` (else target) | exact |
  | `title` | `page_title` (final title only) | subset: can miss |
  | `js` / `css` | inline `<script>` / `<style>` bodies only | subset: can miss |
  | `html` | the rendered HTML; the raw server response is not stored | approximate: can miss and over-match (script-injected markup) |
  | `requests` | redirect chain, final URL, and URLs the DOM's own start tags reference (`src=`, `<link rel=stylesheet\|icon\|preload\|modulepreload\|manifest>`) | approximate: can miss (fetch/XHR) and over-match (referenced, never requested) |
  | `cookies`, `headers` | not stored; rules using them are dropped | none |

  Under `not` only an exact field is allowed; such rules are dropped. Positive
  use of an approximate field is kept: the over-match is bounded to "the
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
- **Not done:** captures stored before 0333 are not backfilled; no ops UI
  renders the field yet.

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
