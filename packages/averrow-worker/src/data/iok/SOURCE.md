# IOK ruleset — vendored copy

Rules: IOK by phish.report (ODbL). Source: <https://phish.report/IOK>.

| | |
|---|---|
| Origin | https://github.com/phish-report/IOK (`indicators/*.yml`) |
| Commit | `142f762aa12994cbd26ddf7d40d40c07ac01bd66` (2025-04-24T21:22:21+01:00) |
| Vendored | 2026-11-15 by `scripts/vendor-iok-rules.ts` |
| Licence | Open Database License (ODbL) 1.0 — full text in `LICENSE` (this directory) |
| Attribution | "Rules: IOK by phish.report (ODbL)" |
| `rules.json` | 130443 bytes, format 1 |

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
- Kept (evaluable on stored capture fields): **260**
- Dropped: **6**

| Drop reason | Rules |
|---|---|
| regex not on allowlist | 2 |
| field not stored: headers | 2 |
| field not stored: cookies | 1 |
| negated non-exact field: html | 1 |

Dropped rules: `cazanova-cookie`, `class-attribute-obfuscation`, `data-content-attribute-obfuscation`, `facebook-parachute`, `fake-404-page`, `kimsuky-nginx-fake-error-9b43f670`.

## Fields

Evidence comes only from what a page capture already stores (rendered HTML,
title, final URL, redirect chain). Not stored at all:
`cookies`, `headers` (rules using them are dropped).

| IOK field | Fidelity |
|---|---|
| `dom` | exact |
| `hostname` | exact |
| `title` | subset |
| `js` | subset |
| `css` | subset |
| `html` | approximate |
| `requests` | approximate |

- **exact** — the same data IOK evaluates (`dom` is the rendered HTML;
  `hostname` is the final URL's host).
- **subset** — part of what IOK sees: `title` is the final title only;
  `js` / `css` are inline `<script>` / `<style>` bodies only. A subset
  can miss a match. It cannot produce one IOK would not.
- **approximate** — a stand-in that can miss AND over-match. `html` is
  evaluated against the rendered DOM (the server response is not stored), so
  a string a script injected matches although it was never in the response.
  `requests` is the redirect chain and final URL plus the sub-resource URLs
  the DOM's own start tags reference (`src=`, `<link rel=stylesheet|icon|
  preload|modulepreload|manifest>`); a referenced URL that was never
  requested matches, and fetch / XHR requests are missed.

Under `not` only an exact field is allowed; other rules are dropped (a
missed match under negation would be a false positive). Positive use of an
approximate field is kept: the over-match is bounded to "the kit's literal
string is in the rendered page" or "the page's own markup points at the
kit's file", which is the evidence IOK's `dom` field targets. Matches are
staff-only context that never alerts, and each match lists the non-exact
fields its rule reads (`approximate_fields`).

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
2. Read the vendor output for dropped rules. A rule dropped as
   "regex not on allowlist" stays dropped unless you add its pattern on
   purpose: read the pattern, time it on adversarial input at 256K chars
   (repeat its own prefix; near-misses of each quantified part), and add an
   entry to `src/lib/iok-regex-allowlist.ts` with the rule id, this commit
   and the measured time. More than a few milliseconds: leave it dropped.
   If a listed pattern changed upstream, its old entry no longer applies.
3. Re-read the upstream `LICENSE` and README licence section, and update
   `docs/licences/iok.md` if the terms changed.
