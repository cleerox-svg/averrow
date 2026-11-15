# phishunt.io: licence snapshot

- **Feed:** `phishunt` (`packages/averrow-worker/src/feeds/phishunt.ts`, migration 0330)
- **Data URL:** https://phishunt.io/feed.json (also `feed.txt`, `feed.csv`)
- **Terms URL:** https://phishunt.io/tos/ (see also https://phishunt.io/llms.txt, "Use policy")
- **Checked:** 2026-11-15 (fetched live, generic User-Agent)
- **Operator:** Daniel López (one-person project), Spain jurisdiction
- **Verdict:** commercial use permitted (CC0 1.0 public-domain dedication)

## Licence text (verbatim, ToS §7 "Data license")

> The data distributed through phishunt.io (JSON, CSV, TXT feeds, and API
> responses) is released into the public domain under Creative Commons CC0
> 1.0. When redistributing or publishing the data, attribution to
> phishunt.io is appreciated but not required. The website design, source
> code, trademarks, and branding remain reserved and are not covered by
> this license.

## Other terms that bind us (verbatim excerpts)

ToS §2: "The Service is provided free of charge, without authentication,
for security research, incident response, brand protection, and other
lawful purposes."

ToS §3, "Nature of the data: suspicion, not verdict": "The data
distributed by phishunt.io reflects suspicion based on automated
heuristics and third-party signals. It is not a legal finding, judicial
determination, or verified assertion that any specific domain or party is
engaged in phishing, fraud, or any other wrongdoing. [...] Anyone relying
on the data must perform their own verification before taking action."

ToS §4 "Acceptable use" (excerpt): "You may NOT: [...] Attempt to
disrupt, overload, reverse-engineer, scrape beyond rate limits [...];
Misrepresent the source of the data or publicly assert that a listed
domain is confirmed phishing based solely on its presence in phishunt.io".

ToS §5: "API and feed endpoints are rate-limited to 10 requests per second
per IP, with a burst of 20. [...] No uptime or availability commitment is
made."

llms.txt "Use policy": "Feeds are cached for 15 minutes." and "feeds,
blocklists and `/api/v1/*` accept any User-Agent".

## What this means for Averrow

- Ingesting, storing, enriching and showing the data in a commercial
  product is allowed; no attribution is required.
- Rows are suspicion, not verdict. They go through normal triage and
  enrichment. A takedown or customer-facing claim must not rest on the
  phishunt listing alone (ToS §3/§4).
- One request per hour, far inside the rate limit.
- phishunt's name and branding are not licensed. Do not use them in
  marketing.
