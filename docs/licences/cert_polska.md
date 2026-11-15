# CERT Polska Warning List: licence snapshot

- **Feed:** `cert_polska` (`packages/averrow-worker/src/feeds/certPolska.ts`, migration 0331)
- **Data URL:** https://hole.cert.pl/domains/v2/domains.json (also `domains.txt`, `.csv`, `.xml`, `_adblock.txt`, `_hosts.txt`, `_rpz.db`)
- **Terms URL:** https://cert.pl/en/warning-list/ (section "Data usage policy")
- **Checked:** 2026-11-15 (fetched live, generic User-Agent)
- **Maintainer:** CSIRT NASK / CERT Polska (NASK-PIB), under art. 20 of the Polish Act on Combating Abuse in Electronic Communications (28 July 2023)
- **Verdict:** commercial use permitted

## Licence text (verbatim, "Data usage policy")

> The Warning List may be used by any user for any purpose, including
> commercial purposes, without any representation or warranty as to its
> completeness, accuracy or the malicious nature of the domains included in
> the List. User uses the List and decides whether to block a domain at
> their own risk. To the fullest extent permitted by applicable law,
> NASK-PIB, including CERT Polska, shall not be liable for any consequences
> arising from the use of the List, including, in particular, any
> consequences of blocking domains on the basis thereof.
>
> Attribution of the data source is not required. Where the source is
> identified, such attribution must not imply any cooperation, partnership,
> endorsement, certification or support by NASK-PIB or the CERT Polska team
> in respect of the user or the user's activities, products, services or
> tools. Users are not entitled to use the names, designations, logos or
> other visual identifiers of NASK-PIB or the CERT Polska team in any
> manner that could mislead recipients as to the nature of the relationship
> between the user and either of those entities.

## Operating notes from the same page (verbatim excerpts)

- "list of blocked domains should be updated every 5 minutes"
- "domains are put on the List for a period of 6 months, if an entry is no
  longer on the List or there is information about its deletion, the
  domain should no longer be blocked"
- "subdomains of domains present on the List should be also blocked - if
  a.example.com domain is on the List, then both a.example.com and
  b.a.example.com should be blocked, but not example.com."
- "all List formats are time-limited to the last 6 months"
- Scope: domains "that trick Polish internet users to steal their data and
  credentials".
- The page also names an `actions.log` add/remove stream; on 2026-11-15
  `https://hole.cert.pl/domains/v2/actions.log` returned HTTP 404, so the
  feed reads `domains.json` (which has `InsertDate` / `DeleteDate`).

## What this means for Averrow

- Ingesting and using the list in a commercial product is allowed; no
  attribution is required.
- If the source is named (feed display name, docs, UI), it is a plain
  source credit only. Never imply partnership, endorsement or
  certification by CERT Polska / NASK-PIB, and never use their logos.
- No warranty: listings are evidence, not verdicts. They go through
  normal triage.
- We poll hourly for intelligence, not for blocking, so the 5-minute
  blocking cadence does not apply. Listings older than 6 months (or
  deleted) are not re-checked against the list: Averrow does not block on
  them.
