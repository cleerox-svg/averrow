# IOK ruleset — vendored copy

Rules: IOK by phish.report (ODbL). Source: <https://phish.report/IOK>.

| | |
|---|---|
| Origin | https://github.com/phish-report/IOK (`indicators/*.yml`) |
| Commit | `142f762aa12994cbd26ddf7d40d40c07ac01bd66` (2025-04-24T21:22:21+01:00) |
| Vendored | 2026-11-15 by `scripts/vendor-iok-rules.ts` |
| Licence | Open Database License (ODbL) 1.0 — full text in `LICENSE` (this directory) |
| Attribution | "Rules: IOK by phish.report (ODbL)" |
| `rules.json` | 131838 bytes, format 1 |

## What this directory is

`rules.json` is a converted copy of the IOK indicator rules (a Derivative
Database under ODbL §4.4): each rule's detection block compiled into a small
JSON AST evaluated by `src/lib/iok-engine.ts`. It is licensed under the
ODbL 1.0, the same as the source. The conversion method — the
"alterations" ODbL §4.6(b) refers to — is `scripts/vendor-iok-rules.ts` +
`scripts/iok-compile.ts`: rules dropped as listed below; regexes translated
from RE2 to JavaScript; `1 of …` / `all of them` expanded; descriptions and
references left out; tags beyond 20 per rule or longer than 100 characters
left out. Titles, ids and match values are copied unchanged (a rule whose id,
title or value is out of bounds is dropped, not trimmed), and nothing is
added.

Matches are staff-only context on a page capture (never alerts, never
tenant-facing). If they are ever shown outside Averrow staff, the ODbL §4.3
notice ("Contains information from IOK (phish.report), which is made
available here under the Open Database License (ODbL)") must go with them,
and §4.6 applies: offer this `rules.json` (or the conversion scripts).

## Counts

- Indicators in the source: **266**
- Kept (evaluable on capture evidence): **262**
- Dropped: **4**

| Drop reason | Rules |
|---|---|
| regex not on allowlist | 2 |
| token-like value | 2 |

Dropped rules: `class-attribute-obfuscation`, `data-content-attribute-obfuscation`, `generic-email-ec34bc68`, `transferwise-d777126`.

## Fields

Evidence comes from what a page capture stores: the rendered HTML, title,
final URL and redirect chain, and — for captures made since migration 0335 —
the network evidence object (main response body as served + headers, the
browser's request log, own-origin cookies; `lib/page-capture-network.ts`).

| IOK field | Capture without network evidence | Capture with network evidence |
|---|---|---|
| `dom` | exact | exact |
| `hostname` | exact | exact |
| `title` | subset | subset |
| `js` | subset | subset |
| `css` | subset | subset |
| `html` | approximate | exact (response body as served; subset if cut) |
| `requests` | approximate | exact (request log; subset if cut or a request was blocked) |
| `headers` | absent | exact (main response headers; subset if cut) |
| `cookies` | absent | subset (page origin only) |

- **exact** — the same data IOK evaluates (`dom` is the rendered HTML;
  `hostname` is the final URL's host; with network evidence `html` is the
  main response body as served, `headers` its headers, `requests` the
  browser's own request log).
- **subset** — part of what IOK sees: `title` is the final title only;
  `js` / `css` are inline `<script>` / `<style>` bodies only; `cookies`
  are the page's own origin only (IOK also reads third-party cookies). A real
  artifact that a cap cut (body over 2 MB, more than 300 requests, a clipped
  header or cookie value) is a subset too. A subset can miss a match. It
  cannot produce one IOK would not.
- **approximate** — a stand-in that can miss AND over-match, used only when
  the capture has no network evidence. `html` is evaluated against the
  rendered DOM, so a string a script injected matches although it was never
  in the response. `requests` is the redirect chain and final URL plus the
  sub-resource URLs the DOM's own start tags reference; a referenced URL that
  was never requested matches, and fetch / XHR requests are missed.
- **absent** — `headers` / `cookies` on a capture without network
  evidence: an empty list, so a positive match on them never happens.
- The request log is only treated as exact when nothing cut it: no cap hit,
  and no request our own interception aborted for the SSRF guard, the host
  cap or a non-http scheme (a blocked response cannot have requested what it
  would have requested next). "Complete" means up to the freeze point: the
  log stops when the desktop capture settles, so a request issued after that
  (a late timer, the mobile reload) is not in it.
- `html` and `headers` are the response to the FIRST navigation. If a JS or
  meta-refresh navigation followed, they belong to an earlier document than
  the rendered DOM and are a subset, never exact. `html` is also a subset
  when the body was not clean UTF-8 / ASCII (decoded with the response's
  charset, but IOK compares raw bytes) or when it was cut.
- A response body is only read from the browser when its decoded size is
  known to be at most 2 MB (CDP's decoded byte count, else a plain
  `Content-Length` with no `Content-Encoding`); otherwise `html` stays the
  rendered-DOM approximation.

Under `not` only a field that can be exact is allowed (`dom`, `hostname`, `html`, `requests`, `headers`);
a rule negating `title`, `js`, `css` or `cookies` is dropped (a missed
match under negation would be a false positive). A rule that negates
`html`, `requests` or `headers` is kept but is evaluated only on a capture
where that field is exact; on any other capture it is not applicable and
cannot match (an empty header list must not make "not nginx" true). Positive
use of a non-exact field is kept: the over-match is bounded to "the kit's
literal string is in the rendered page" or "the page's own markup points at
the kit's file", which is the evidence IOK's `dom` field targets. Matches
are staff-only context that never alerts, and each match lists the non-exact
fields its rule reads on that capture (`approximate_fields`).

## Regexes

A regex runs only if its exact source is on the hand-reviewed allowlist
`src/lib/iok-regex-allowlist.ts` (checked at vendor time and again at run
time, so editing `rules.json` by hand cannot add one). Currently allowed:

- `(Spox|Crax)\/Files` (rule `spox-chase-8b20b051`, reviewed at `142f762aa129`, worst 0.3 ms on 256K chars)

## Refresh

```bash
git clone --depth 1 https://github.com/phish-report/IOK /tmp/iok
cd packages/averrow-worker
pnpm vendor:iok --src /tmp/iok
git diff -- src/data/iok/rules.json
npx vitest run test/iok-engine.test.ts
```

The rules are third-party input. Before committing a refresh:

1. Read the `rules.json` diff. Review every new or changed rule by hand:
   what it matches, which fields it reads, whether its strings are specific
   enough to mean a kit.
2. A rule dropped as "token-like value" carries a credential-shaped string
   (a kit's download token or client key) in a match value. It stays
   dropped: third-party tokens are not vendored, and secret scanning would
   flag them.
3. Read the vendor output for dropped rules. A rule dropped as
   "regex not on allowlist" stays dropped unless you add its pattern on
   purpose: read the pattern, time it on adversarial input at 256K chars
   (repeat its own prefix; near-misses of each quantified part), and add an
   entry to `src/lib/iok-regex-allowlist.ts` with the rule id, this commit
   and the measured time. More than a few milliseconds: leave it dropped.
   If a listed pattern changed upstream, its old entry no longer applies.
4. Re-read the upstream `LICENSE` and README licence section, and update
   `docs/licences/iok.md` if the terms changed.
