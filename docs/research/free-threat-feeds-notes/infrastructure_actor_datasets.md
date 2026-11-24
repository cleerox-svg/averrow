# Free infrastructure, internet-measurement and threat-actor attribution datasets (state as of 2026-11-13)

Scope note: everything below was checked by fetching the provider's own page on 2026-11-13 unless marked otherwise. "Verified live" means the page/endpoint returned current content in this session; it does not mean I pulled the feed payload itself. Items I could not check in this session are listed under each question's Gaps, without claims. Already-integrated sources (abuse.ch, Spamhaus DROP/DBL, crt.sh, CIRCL PDNS, Cloudflare Radar, etc.) are excluded, except where a sibling product of an integrated source is new (Spamhaus ASN-DROP, Radar CT API).

Licence shorthand used throughout:
- OK-COMMERCIAL = terms explicitly allow commercial use (possibly with attribution).
- NC = non-commercial only / commercial needs a paid licence or written approval. Not usable in a paid product as-is.
- SA = share-alike obligation attaches to derived data.
- UNSTATED = no licence published; legally you have no grant, ask first.

---

## 1. C2 / malicious-infrastructure trackers and internet-scan data: what is alive, free and commercially usable?

### Takeaway
Most "free" scan/C2 sources are free only for non-commercial use (Shodan InternetDB, Maltrail static trails, JA4+ beyond plain JA4) or publish no licence at all (ViriBack, ThreatView). The only one in this group I could confirm as both alive and needing nothing but attribution-free HTTPS fetch is ViriBack/ThreatView (licence UNSTATED), so every candidate here needs a written permission step or must be kept internal-only.

### Cited Findings

Shodan InternetDB
- Endpoint `https://internetdb.shodan.io/<ip>`, GET, no API key; JSON fields `ip`, `ports`, `cpes`, `hostnames`, `tags`, `vulns`; no banners. — [Shodan InternetDB](https://internetdb.shodan.io/)
- Updated once a week. — [Shodan InternetDB](https://internetdb.shodan.io/)
- NC: "It's free for non-commercial use! If you're using the InternetDB API to make money then you need an enterprise license." — [Shodan InternetDB](https://internetdb.shodan.io/)
- No rate limit is published on the page. — [Shodan InternetDB](https://internetdb.shodan.io/)

Hunt.io C2 feed
- Endpoint `api.hunt.io/v1/feeds/c2`, token header auth, gzip newline-delimited JSON, returns the last 7 days from the time of request; covers C2 plus recon tools and phishing infrastructure. — [Hunt.io C2 feed docs](https://apidocs.hunt.io/docs/c2-feed); [Hunt.io support](https://hunt.io/support/c2-feeds)
- Hunt runs a separate OEM programme for C2-feed licensing to products, which implies product embedding is not covered by a free account. — [Hunt.io OEM](https://hunt.io/oem)

ViriBack C2 tracker
- Alive: page shows 13,149 panels tracked and a newest entry dated 11-11-2026 (Chaos, an IP:8080 panel). — [ViriBack Tracker](https://tracker.viriback.com/)
- Full CSV dump at `https://tracker.viriback.com/dump.php`; fields Malware Family, URL, IP Address, First Seen. No JSON. — [ViriBack Tracker](https://tracker.viriback.com/)
- Licence UNSTATED: only "© 2026 ViriBack Tracker". — [ViriBack Tracker](https://tracker.viriback.com/)

ThreatView.io community feeds
- Eight plaintext feeds under `https://threatview.io/Downloads/`: `High-Confidence-CobaltStrike-C2-Feeds.txt` (C2 hunt, IP/host), `IP-High-Confidence-Feed.txt`, `DOMAIN-High-Confidence-Feed.txt`, `URL-High-Confidence-Feed.txt`, `MD5-HASH-ALL.txt`, `SHA-HASH-FEED.txt`, `MALICIOUS-BITCOIN_FEED.txt`, `Experimental-IOC-Tweets.txt`. — [ThreatView.io](https://threatview.io/)
- Generated every 24 h at 23:00 UTC; the OSINT/tweets feed hourly. — [ThreatView.io](https://threatview.io/)
- Described as "Open-access community feeds forever free" ($0 community tier); licence UNSTATED, licensing questions go to feeds@threatview.io; provided "on a best-effort basis", false positives possible. — [ThreatView.io](https://threatview.io/)
- The page shows no per-feed "last updated" date; only blog dates of May 2026. Feed freshness therefore not verified. — [ThreatView.io](https://threatview.io/)

Maltrail (stamparm) static trails — licence changed, important
- Engine is MIT, but the static trail set is now a separate repo (`stamparm/trails`, "over 3,000 curated files") with its own terms: "free for internal defensive use, research and teaching", while a "commercial product, service, MSSP or MDR offering, or a redistributed feed needs a license". NC. — [stamparm/maltrail](https://github.com/stamparm/maltrail)
- Assembled set is published as a release asset: `https://github.com/stamparm/trails/releases/latest/download/trails.csv.gz`, pinnable to dated `content-YYYYMMDD-HHMM` releases, with a published sha256. — [stamparm/maltrail](https://github.com/stamparm/maltrail)

JA4 / JA4+ fingerprints (FoxIO)
- JA4 (TLS client fingerprint) is BSD 3-Clause; FoxIO states it has no patent claims on it and is not pursuing any. OK-COMMERCIAL. — [FoxIO ja4 README](https://raw.githubusercontent.com/FoxIO-LLC/ja4/main/README.md)
- JA4S, JA4H, JA4X, JA4T, JA4L, JA4D and the rest of JA4+ are patent-pending under FoxIO License 1.1: permissive for academic and internal business use, "not permissive for monetization"; a vendor selling JA4+ inside a product "would need to request an OEM license". NC-for-products. — [FoxIO ja4 README](https://raw.githubusercontent.com/FoxIO-LLC/ja4/main/README.md)
- ja4db.com is "the official JA4+ database of fingerprints, associated applications and recommended detection logic", "under very active development"; the README states no API terms or data licence for it. — [FoxIO ja4 README](https://raw.githubusercontent.com/FoxIO-LLC/ja4/main/README.md)

Censys free tier
- Free accounts: basic protocols and certificates, limited web-property data, 1 page of 100 results, 100 credits/month (expire monthly), collections capped at 100 assets; buying any credits moves the account to Starter. — [Censys data access tiers](https://docs.censys.com/docs/data-access-tiers-entitlements); [Censys free/starter credits](https://docs.censys.com/docs/platform-credits-free-starter)
- Third-party pages still quote the legacy "250 queries/month" figure; that conflicts with the current Platform docs and should be ignored. — [Censys credits docs](https://docs.censys.com/docs/censys-credits); contradicted by [ethicalhacking.ai](https://ethicalhacking.ai/pricing/censys-search-pricing)

Dead or closed
- BinaryEdge: standalone platform shut down, accounts closed 31 March 2025; engine folded into Coalition Control. — [Coalition BinaryEdge transition FAQ](https://help.coalitioninc.com/hc/en-us/articles/34383910057371-BinaryEdge-Transition-FAQ)
- Rapid7 Open Data / Project Sonar: free no-account access ended in 2022; access is by request/commercial via opendata@rapid7.com. Files are still published (listings updated into 2026) but not on a free public tier. — [Rapid7 blog](https://www.rapid7.com/blog/post/2022/02/10/evolving-how-we-share-rapid7-research-data-2/); [Rapid7 Open Data about](https://opendata.rapid7.com/about)

### Inferences
- For a paid product, none of Shodan InternetDB, Maltrail trails or JA4+ (non-JA4) can ship without a licence. InternetDB is the most tempting (no key, one GET per IP, tiny payload, ideal for a Worker) and is exactly the case its terms exclude.
- ViriBack is the best-fitting replacement for the retired montysecurity C2-Tracker on technical grounds (single CSV, ~13K rows total, panel URL + family + first-seen, which is actor-tooling evidence rather than a blocklist), but it needs an email to the maintainer before commercial use because no licence is published.
- ThreatView's Cobalt Strike list overlaps in kind with the already-integrated drb-ra C2IntelFeeds; marginal signal is probably low. Its freshness should be measured (compare two daily pulls) before integrating.
- Plain JA4 hashes can be stored and matched commercially; the JA4X (certificate) and JA4S/JA4H server-side fingerprints that are most useful for C2 clustering are the restricted ones.
- Censys' 100 credits/month is far too small for enrichment at platform volume; usable only for analyst-triggered single lookups.

### Gaps
- Hunt.io: could not read the free-account terms (what the free tier includes for the C2 feed, redistribution rights). Check `https://hunt.io/terms-of-service`. Treat as NC until confirmed.
- Censys Free: could not find explicit commercial-use language for Free accounts; a Sept 2026 community thread asks exactly this but the reply was not retrievable ([thread](https://community.censys.com/censys-platform-q-a-58/commercial-use-of-censys-free-accounts-for-paid-cybersecurity-training-591)).
- Not checked this session (no claims made): ONYPHE free tier, LeakIX, Netlas, FOFA, ZoomEye, Shodan (keyed) free API terms, Bambenek feeds status, RST Cloud free tier, Carbon Black feeds, any direct "C2-Tracker successor" repo, ja4db.com API endpoint and its data licence, Kaspersky OpenTIP free quota.
- ViriBack and ThreatView payload sizes not measured (ViriBack is ~13K rows per the page; ThreatView sizes unknown).

---

## 2. Routing / ASN / hoster reputation and proxy/VPN lists

### Takeaway
Three sources are clearly usable in a commercial product: Spamhaus ASN-DROP (free for any business type, credit required), RIPEstat (no request cap, register above 1,000/day) and IPinfo Lite (unlimited, CC BY-SA 4.0 with attribution). bgp.tools bulk tables and Team Cymru are free but publish no commercial terms; the popular "bad ASN" list is a hosting/cloud list, not a bulletproof-hoster list.

### Cited Findings

Spamhaus ASN-DROP (not yet integrated; DROP is)
- `https://www.spamhaus.org/drop/asndrop.json` (also `drop_v4.json`, `drop_v6.json`); JSON is the primary format, text versions are slated for deprecation. — [Spamhaus DROP](https://www.spamhaus.org/blocklists/do-not-route-or-peer/)
- Re-evaluated daily; do not fetch more than once per hour, once a day is usually enough. — [Spamhaus DROP](https://www.spamhaus.org/blocklists/do-not-route-or-peer/)
- OK-COMMERCIAL with credit: available "at no cost, regardless of size or business type"; if included in a product you must credit The Spamhaus Project and keep the date and copyright text with the file. — [Spamhaus DROP](https://www.spamhaus.org/blocklists/do-not-route-or-peer/)
- eDROP was merged into DROP on 10 April 2024 (relevant if the existing integration still pulls an edrop file). — [Spamhaus DROP](https://www.spamhaus.org/blocklists/do-not-route-or-peer/)

RIPEstat Data API
- Base `https://stat.ripe.net/data/<call>/data.json?resource=...`; "No limit on the amount of requests", but register if regularly above 1,000 requests/day; max 8 concurrent requests per IP; add a `sourceapp` identifier. — [RIPEstat Data API docs](https://stat.ripe.net/docs/02.data-api/)
- Relevant calls: `as-overview`, `announced-prefixes`, `asn-neighbours`, `asn-neighbours-history`, `routing-history`, `routing-status`, `bgp-updates`, `bgp-state`, `visibility`, `prefix-overview`, `related-prefixes`, `rpki-validation`, `rpki-history`, `abuse-contact-finder`, `whois`, `historical-whois`. — [RIPEstat Data API docs](https://stat.ripe.net/docs/02.data-api/)
- Governed by the RIPEstat Service Terms and Conditions (linked from the docs; not read in this session). — [RIPEstat Data API docs](https://stat.ripe.net/docs/02.data-api/)

bgp.tools bulk exports
- `https://bgp.tools/table.jsonl` (prefix, origin ASN, visibility "Hits"), `https://bgp.tools/table.txt`, `https://bgp.tools/asns.csv` (ASN to name). — [bgp.tools API KB](https://bgp.tools/kb/api)
- Do not download tables more often than every 30 min (cache ~2 h); cache asns.csv 24 h. — [bgp.tools API KB](https://bgp.tools/kb/api)
- A descriptive User-Agent with contact is mandatory ("acmeco bgp.tools - contact@acme.co"); generic agents get blocked; HTML scraping gets banned. — [bgp.tools API KB](https://bgp.tools/kb/api)
- Licence UNSTATED for the exports; for anything beyond them the page says to email admin@bgp.tools. — [bgp.tools API KB](https://bgp.tools/kb/api)

IPinfo Lite
- Fields: ASN, AS name, AS domain, country, continent. Unlimited API requests; downloads in CSV, MMDB, JSON, Parquet; updated every 24 h. — [IPinfo Lite](https://ipinfo.io/lite)
- OK-COMMERCIAL + SA: CC BY-SA 4.0; "The only requirement is that you provide attribution to IPinfo as your data source"; licence "allows you to freely use and incorporate the data into commercial and non-commercial applications". — [IPinfo Lite](https://ipinfo.io/lite)

Team Cymru IP-to-ASN
- Offered as a no-cost community service over WHOIS, DNS and HTTPS. — [Team Cymru IP-ASN mapping](https://team-cymru.com/ip-asn-mapping)
- Handles over 1.5 billion queries a day. — [Team Cymru blog](https://www.team-cymru.com/post/celebrating-a-milestone-over-1-5-billion-daily-queries-on-our-ip-to-asn-mapping-service)
- A third-party guide rates its commercial-use terms as unclear; this is secondhand, not Team Cymru's wording. — [ASNSPY API transparency guide](https://asnspy.pages.dev/api-transparency.html)

brianhama/bad-asn-list
- MIT; `bad-asn-list.csv`; 36 commits total. It lists ASNs "known to belong to cloud, managed hosting, and colo facilities". It is not a bulletproof-hoster list. — [brianhama/bad-asn-list](https://github.com/brianhama/bad-asn-list)

X4BNet/lists_vpn
- Files `output/vpn/ipv4.txt`, `output/vpn/ipv6.txt`, `output/datacenter/ipv4.txt`, `output/datacenter/ipv6.txt` (legacy root `ipv4.txt` to be removed in 2027); rebuilt by CI; 6,791 commits; copyright line dated 2026. — [X4BNet/lists_vpn](https://github.com/X4BNet/lists_vpn)
- Scripts and generated lists MIT, but the default upstream IP-to-ASN source (IPLocate) is CC BY-SA 4.0 and "upstream sources keep their own licenses". OK-COMMERCIAL with SA/attribution caveat. — [X4BNet/lists_vpn](https://github.com/X4BNet/lists_vpn)
- Method: ASN lists of VPN/datacenter operators expanded to prefixes, plus keyword match (`VPN`, `Host`, `Huawei`) on ASN name/org/domain. — [X4BNet/lists_vpn](https://github.com/X4BNet/lists_vpn)

### Inferences
- Spamhaus ASN-DROP is the cheapest high-value addition here: one small JSON, daily, same terms and fetch pattern as the DROP feed already integrated, and it gives an ASN-level "hijacked / criminal-operated network" flag that the NEXUS ASN lane and `hosting_providers` currently lack.
- The platform already has `SHARED_INFRA_ASNS` (41 hand-kept ASNs). X4BNet's datacenter/VPN ASN lists and bad-asn-list are the same kind of data at larger scale; they help classify "hosting vs eyeball" but say nothing about maliciousness. bad-asn-list is also small and rarely updated (36 commits), so treat it as a static seed.
- IPinfo Lite overlaps MaxMind GeoLite2 for country but adds ASN + AS domain in one daily file with unlimited API; the SA clause means a redistributed derived dataset would have to be CC BY-SA, which matters if tenants can export it. Internal enrichment plus an attribution line is the low-risk reading.
- RIPEstat `routing-history` and `asn-neighbours-history` give "this prefix moved origin AS" and "this AS changed upstreams" signals, which fit the existing `infra_movement` pivot concept. At 1,000/day unregistered it must be driven by cluster-level events, not per-threat.
- bgp.tools `table.jsonl` is a full routing table (large; size not measured) and would have to go to R2 with a streaming parse, not D1.

### Gaps
- No true free bulletproof-hoster list was verified. Spamhaus ASN-DROP is the closest sourced option. Not checked: Spamhaus botnet-ASN statistics pages, any community BPH list.
- Team Cymru: exact HTTPS endpoint, query format and official terms not retrieved; third-party sources say the bulk interface needs TCP 43.
- Not checked this session (no claims made): bgp.he.net terms, IP2Location LITE and DB-IP Lite licences, IPtoASN.com, RouteViews/RIPE RIS live hijack feeds (RIS Live is a WebSocket, would need a Durable Object), FireHOL status, Stop Forum Spam, residential-proxy trackers.
- File sizes for `asndrop.json`, `table.jsonl`, IPinfo Lite downloads and X4BNet lists not measured.

---

## 3. Passive DNS / DNS history beyond CIRCL

### Takeaway
I could not confirm any additional free passive-DNS source with published quotas and commercial terms in this session. The two bulk open-data routes are closed or restricted (Rapid7 Sonar is by request only since 2022).

### Cited Findings
- Rapid7 FDNS/Sonar: free public access ended in 2022; now by application to opendata@rapid7.com. — [Rapid7 blog](https://www.rapid7.com/blog/post/2022/02/10/evolving-how-we-share-rapid7-research-data-2/); [Rapid7 Open Data about](https://opendata.rapid7.com/about)
- Validin offers a free community account, but I found no published quota or commercial-use terms; a third-party listing says registration needs a professional email. — [cybersectools Validin listing](https://cybersectools.com/tools/validin)
- Robtex free API is rate-limited to 10 requests per hour per IP (per search-result summary of its page; not fetched directly). — [Robtex Free API](https://freeapi.robtex.com/)
- Mnemonic PDNS has a documented API with public and private tiers (docs exist; limits not read). — [Mnemonic PDNS API docs](https://docs.mnemonic.no/api/services/pdns/02-private_api.html)
- RIPEstat exposes `historical-whois` and reverse-DNS style calls that partially substitute for IP-side history at no cost. — [RIPEstat Data API docs](https://stat.ripe.net/docs/02.data-api/)

### Inferences
- Free pDNS at platform volume does not appear to exist; realistic use is analyst-triggered or cluster-triggered lookups against one or two community APIs (Validin, Mnemonic public), each needing a terms check first.
- The platform already archives every NRD to R2 and tails CT; building first-party "first seen" history from those plus its own DNS resolutions (dns_queue) is a more dependable route than a third-party free tier.

### Gaps
- Not verified: Validin community quota and terms; Mnemonic public PDNS limits (historically a low anonymous per-minute/day cap, unconfirmed); DNSDB Community Edition status; SecurityTrails free tier quota; Silent Push community terms; urlscan.io free API quotas and licence; OpenINTEL access model; dns.coffee; ICANN CZDS (zone files are free on per-TLD approval, but CZDS terms on commercial use were not read).

---

## 4. Certificate Transparency beyond crt.sh: what is practical from a fetch-only Worker?

### Takeaway
The CT ecosystem moved to static tile logs during 2025-2026 (Let's Encrypt's RFC 6962 logs went read-only 30 Nov 2025 and were scheduled to shut down 28 Feb 2026), and the tile API is plain cacheable HTTPS GETs, which suits a Worker. Cloudflare Radar's CT API gives aggregates only, and SSLMate's free CT search is capped at 100 hostname or 10 full-domain queries/hour.

### Cited Findings

Static CT (Sunlight / TesseraCT) tile API
- Let's Encrypt made its RFC 6962 logs read-only on 30 November 2025 and planned full shutdown on 28 February 2026; production now runs on Static CT via Sunlight. — [Let's Encrypt, RFC 6962 logs EOL](https://letsencrypt.org/2025/08/14/rfc-6962-logs-eol.html)
- Monitoring paths relative to the log's monitoring prefix: `/checkpoint` (text, cache only a few seconds), hash tiles `/tile/<L>/<N>[.p/<W>]`, data tiles `/tile/data/<N>[.p/<W>]`, issuers `/issuer/<sha256 hex>`. — [C2SP static-ct-api spec](https://raw.githubusercontent.com/C2SP/C2SP/main/static-ct-api.md)
- A full data tile holds 256 entries; `N` is encoded in 3-digit path segments with `x` prefixes (index 1234067 = `x001/x234/067`); clients must support `Content-Encoding: gzip`; partial tiles use `.p/<W>` with W 1-255 and should only be fetched when the checkpoint requires them. — [C2SP static-ct-api spec](https://raw.githubusercontent.com/C2SP/C2SP/main/static-ct-api.md)
- Each data-tile entry is a `TimestampedEntry` (RFC 6962 §3.4), plus the pre-certificate for precert entries, plus a list of 32-byte issuer fingerprints (chains are not embedded; issuers are fetched separately). — [C2SP static-ct-api spec](https://raw.githubusercontent.com/C2SP/C2SP/main/static-ct-api.md)
- Not every monitor has adopted it: MerkleMap says it will not monitor Sunlight-based logs. Vendor position, not consensus. — [MerkleMap static-ct documentation](https://www.merklemap.com/documentation/static-ct)

Cloudflare Radar CT API (Radar already integrated for other data)
- Added 4 Aug 2025: `/radar/ct/timeseries`, `/ct/summary/{dimension}`, `/ct/timeseries_groups/{dimension}`, `/ct/authorities`, `/ct/logs`, `/ct/logs/{log_slug}` under `https://api.cloudflare.com/client/v4/radar/`, bearer-token auth. Log-activity stats added 9 Oct 2025. — [Cloudflare changelog 2025-08-04](https://developers.cloudflare.com/changelog/2025-08-04-radar-ct-insights); [Cloudflare changelog 2025-10-09](https://developers.cloudflare.com/changelog/post/2025-10-09-radar-ct-log-activity-insights/index.md)

SSLMate CT Search API (Cert Spotter)
- Free "Small" plan: 100 single-hostname queries/hour, 10 full-domain (`include_subdomains=true`) queries/hour, 75 queries/min, 5/sec, 15 s query timeout; limits may be reduced under load. — [SSLMate CT Search API](https://sslmate.com/ct_search_api/)
- Unauthenticated use is limited and "for personal or evaluation purposes". — [SSLMate CT Search API](https://sslmate.com/ct_search_api/)

### Inferences
- Most practical for a Worker: tail static-CT logs directly. Each poll is `GET /checkpoint` then a bounded number of `GET /tile/data/...` (256 certs per tile, gzip, immutable and CDN-cacheable). No long-lived connection, no API key, no third-party quota. Cost is CPU for TLS-structure and X.509 SAN parsing, so the tail should run in its own cron with a per-run tile cap and a KV cursor per log, and match SANs against the lookalike set before writing anything to D1.
- Full-firehose tailing of a large CA's log is likely beyond a Worker cron's budget (issuance volume not sourced here); sampling or a Durable Object / Queue fan-out would be needed. This is an inference to validate with a measured tile-rate test.
- Any existing integration that reads RFC 6962 `get-entries` from Let's Encrypt Oak logs is on a path that was scheduled to end in Feb 2026; the `ct_logs` feed should be checked against that.
- Radar's CT API is aggregates (issuance counts by CA, log health); it cannot answer "which certs were issued for domain X". It is context for dashboards, not a detection source.
- SSLMate free tier fits per-brand polling for a handful of customer domains (10 full-domain queries/hour), not catalog-wide coverage of 1,867 monitored brands.

### Gaps
- Not verified: the current list of static-CT log monitoring prefixes (take from Google's/Apple's log lists), per-log issuance rates and tile payload sizes, certstream-server-go status and whether it supports static CT, Censys certificate search under the free tier, SSLMate ToS commercial-use wording, whether Let's Encrypt's Feb 2026 shutdown happened exactly on schedule (primary post gives the plan; a secondary source says it did).

---

## 5. WHOIS / RDAP

### Takeaway
gTLD port-43 and web WHOIS obligations ended on 28 January 2025; RDAP over HTTPS is now the only contractually required interface, which is good for a fetch-only Worker. ccTLDs are outside this and many still have WHOIS only.

### Cited Findings
- ICANN's 2023 global amendments sunset the requirement for gTLD registries and registrars to offer WHOIS (port 43 and web) on 28 January 2025; RDAP has been mandatory for gTLDs since 2019. — [ICANN 2023 global amendments](https://www.icann.org/en/contracted-parties/registry-operators/global-amendments/2023-global-amendments)
- Registries began switching port 43 off after the date; one industry report counts 374 TLDs with it disabled, and notes Nominet-run TLD WHOIS servers stopped answering. — [Domain Incite](https://domainincite.com/30788-registries-have-started-shutting-down-whois)
- ccTLDs are not bound by ICANN contracts; where a ccTLD has no RDAP, port-43 WHOIS remains the fallback. — [CaptainDNS RDAP vs WHOIS guide](https://www.captaindns.com/en/blog/rdap-vs-whois-complete-guide)
- RIPEstat provides `whois` and `historical-whois` for number resources (IP/ASN), free. — [RIPEstat Data API docs](https://stat.ripe.net/docs/02.data-api/)

### Inferences
- Registration date (RDAP `events[].eventAction == "registration"`) is the main free signal and Cartographer already does capped RDAP (20 attempts/run). The WHOIS sunset means no new work is needed for gTLDs, but any ccTLD coverage would need Workers TCP sockets to port 43.
- Registrant data is redacted in most gTLD RDAP responses, so RDAP gives registrar + dates + nameservers + status, not actor identity. Registrar and nameserver are still useful clustering keys.

### Gaps
- rdap.org rate limits and per-registry RDAP rate limits (Verisign, etc.) not found in this session.
- No free WHOIS-history source was verified. I found none that is both free and commercially licensed.
- IANA RDAP bootstrap file URL (`https://data.iana.org/rdap/dns.json`) is from memory, not fetched this session.

---

## 6. Actor / campaign attribution corpora

### Takeaway
The clean, commercially usable attribution corpora are MISP Galaxy (CC0 / BSD-2, ~1,118 threat actors plus ransomware, tool, botnet and vendor-mapping clusters), Microsoft's actor-name mapping JSON, MITRE ATT&CK STIX, RansomLook (CC BY 4.0) and OFAC's own SDN data. Ransomware.live, Malpedia and OpenSanctions are all non-commercial without a paid licence or written approval.

### Cited Findings

MISP Galaxy
- JSON clusters are dual-licensed CC0 1.0 or a 2-clause BSD-style licence. OK-COMMERCIAL. — [MISP/misp-galaxy](https://github.com/MISP/misp-galaxy)
- Element counts listed in the repo: `threat-actor.json` 1,118; `ransomware.json` 2,180; `malpedia.json` 3,683; `microsoft-activity-group.json` 179; `mitre-intrusion-set.json` 197; `tidal-groups.json` 281; `tool.json` 660; `botnet.json` 149; `360net.json` 42; `sigma-rules.json` 3,144. Files under `clusters/`. — [MISP/misp-galaxy](https://github.com/MISP/misp-galaxy)

Microsoft threat-actor naming map
- `https://raw.githubusercontent.com/microsoft/mstic/master/PublicFeeds/ThreatActorNaming/MicrosoftMapping.json` is live: a JSON array of objects with "Threat actor name", "Origin/Threat" and "Other names" (comma-separated aliases); about 184 entries; no version/date field. Example: Antique Typhoon, China, alias Storm-0558. — [MicrosoftMapping.json](https://raw.githubusercontent.com/microsoft/mstic/master/PublicFeeds/ThreatActorNaming/MicrosoftMapping.json)
- Microsoft and CrowdStrike announced a joint actor mapping on 2 June 2025, with Google/Mandiant and Palo Alto Unit 42 contributing; it maps names across taxonomies and does not create one standard. — [Microsoft Security blog 2025-06-02](https://microsoft.com/en-us/security/blog/2025/06/02/announcing-a-new-strategic-collaboration-to-bring-clarity-to-threat-actor-naming)
- CrowdStrike said the effort had deconflicted more than 80 adversaries. — [The Hacker News](https://thehackernews.com/2025/06/microsoft-and-crowdstrike-launch-shared.html)

MITRE ATT&CK STIX
- `https://raw.githubusercontent.com/mitre-attack/attack-stix-data/master/enterprise-attack/enterprise-attack.json` is the latest Enterprise bundle (STIX 2.1); versioned files alongside; `index.json` at the repo root lists releases for change detection. Use is under the ATT&CK Terms of Use. — [mitre-attack/attack-stix-data](https://github.com/mitre-attack/attack-stix-data)

RansomLook
- Data, API responses and datasets from ransomlook.io are CC BY 4.0 (attribution only, OK-COMMERCIAL); the software is AGPL-3.0. — [RansomLook about](https://www.ransomlook.io/about)
- A third-party integration guide says the API needs no key. — [Vertex Synapse RansomLook guide](https://synapse.docs.vertex.link/projects/rapid-powerups/en/latest/storm-packages/synapse-ransomlook/userguide.html)
- One code-host index shows the repo as GPL-3.0 rather than AGPL; conflict is about the code, not the data. — [RansomLook about](https://www.ransomlook.io/about); contradicted by [ecosyste.ms listing](https://repos.ecosyste.ms/hosts/GitHub/repositories/RansomLook%2FRansomLook)

Ransomware.live — NOT free for a commercial product
- API docs: base `https://api.ransomware.live/v2`, GET endpoints `/recentvictims`, `/groups`, `/group/<name>`, `/groupvictims/<name>`, `/victims/<year>/<month>`, `/searchvictims/<kw>`, `/countryvictims/<cc>`, `/sectorvictims/<sector>`, `/recentcyberattacks`, `/allcyberattacks`, `/yara/<group>`, `/certs/<cc>`; docs say no authentication; unspecified rate limiting (HTTP 429). — [Ransomware.live API docs](https://www.ransomware.live/apidocs)
- Terms: "Commercial use of the Data is strictly prohibited without prior written approval from the owner"; no redistribution "as if via an API"; attribution with link required; data cached 30 min; the terms say to use `api-pro.ransomware.live` with a personal token and call the legacy API compatibility-only. NC. — [Ransomware.live T&C](https://www.ransomware.live/t&c)
- The docs ("no authentication") and the terms ("use api-pro with a personal token") disagree; the terms are the binding document. — [Ransomware.live API docs](https://www.ransomware.live/apidocs); contradicted by [Ransomware.live T&C](https://www.ransomware.live/t&c)

Malpedia — NC
- "The whole content of the website is released under Creative Common's CC BY-NC-SA 3.0 license"; invite-only vetted registration; API key per account; non-public material is TLP:AMBER by default. — [Malpedia ToS](https://malpedia.caad.fkie.fraunhofer.de/usage/tos)
- The MISP Galaxy `malpedia.json` cluster (3,683 elements) carries Malpedia family names/aliases inside a CC0/BSD-licensed repo. — [MISP/misp-galaxy](https://github.com/MISP/misp-galaxy)

Sanctions
- OFAC publishes SDN and consolidated lists via its Sanctions List Service (`https://sanctionslist.ofac.treas.gov/Home/SdnList`), with a customised-dataset tool that filters by sanctions program, plus delta-file archives; formats are the Advanced Sanctions Data Model and legacy flat files. No usage restriction is stated on the page. — [OFAC Sanctions List Service](https://ofac.treasury.gov/sanctions-list-service)
- OpenSanctions carries OFAC cyber-related designations (program tag US-CYB) inside its `us_ofac_sdn` dataset, but OpenSanctions itself is free only for non-commercial users; businesses must buy a data licence (CC BY-NC 4.0 in its earlier terms). NC. — [OpenSanctions us_ofac_sdn](https://www.opensanctions.org/datasets/us_ofac_sdn); [OpenSanctions licensing](https://www.opensanctions.org/licensing/)

Maltrail APT trails
- Covered by the same trails licence as section 1: commercial product or redistributed feed needs a licence. NC. — [stamparm/maltrail](https://github.com/stamparm/maltrail)

### Inferences
- Recommended attribution spine, all commercially clean and all single-file HTTPS GETs: MISP Galaxy `threat-actor.json` (aliases, country, synonyms, refs) as the canonical actor table; Microsoft `MicrosoftMapping.json` as an alias crosswalk (~184 rows, trivial); ATT&CK `enterprise-attack.json` for group-to-software and group-to-technique relations; MISP `ransomware.json` + RansomLook for ransomware group naming and leak-site victim events. This is SQL-joinable reference data, which fits the "SQL does correlation" rule and the no-AI Attributor.
- Malpedia must not be called directly in a paid product, and whether the Malpedia-derived MISP cluster launders the NC term is legally unclear; use it for family-name normalisation only, or ask Fraunhofer FKIE.
- Ransomware.live is the richest ransomware dataset but is off-limits commercially without written approval; RansomLook (CC BY 4.0) is the substitute. Expect lower enrichment (sector/country tagging) from RansomLook.
- For sanctions, pull OFAC directly (US government data, no licence stated on the page) instead of OpenSanctions. The CYBER2-tagged SDN entries include aliases and sometimes crypto addresses and email handles, which is a high-precision, low-volume attribution signal.
- ATT&CK bundle size was not measured; from prior knowledge it is tens of MB, so it must be streamed to R2 and reduced to group/software/relationship rows offline or in a chunked Worker job, not parsed inside the hourly tick.

### Gaps
- ATT&CK Terms of Use text not read this session (prior knowledge: royalty-free licence for commercial use with attribution; verify at `https://attack.mitre.org/resources/terms-of-use/`). Latest ATT&CK version/date not captured.
- MISP Galaxy last-commit date not shown on the fetched page (5,367 commits total); liveness is likely but not date-verified.
- RansomLook API endpoints (base path, `/api/recent`, `/api/groups` etc.) and rate limits not fetched directly.
- Ransomwatch (joshhighet) status not checked.
- OFAC direct file URLs (e.g. SDN XML/CSV export endpoints) and the exact program tag for cyber (CYBER2 / CYBER3 / CYBER4) not retrieved; the page links to a program-tag definitions document.
- EU cyber-sanctions list (EU FSF consolidated list requires a token URL), UK OFSI, FBI Cyber's Most Wanted, DOJ indictments: no machine-readable free feed verified.
- ETDA Thailand threat-group cards: no terms or JSON endpoint found. ORKL: API exists and third-party wrappers describe it as keyless with rate limits, but ORKL's own terms were not found; the underlying vendor reports keep their own copyrights.
- Not checked: DeepDarkCTI, APTnotes, OpenCTI datasets, vendor IOC GitHub repos (Unit42, ESET, Mandiant, Volexity, Citizen Lab) and their individual licences, CrowdStrike's side of the mapping (no public JSON located), Kaspersky OpenTIP.

---

## 7. New or changed in 2025-2026

### Takeaway
The notable changes are structural, not new feeds: CT moved to static tiles, WHOIS was sunset for gTLDs, BinaryEdge closed, Maltrail's trail data became commercially licensed, and two new machine-readable additions appeared (Cloudflare Radar CT API, Microsoft/CrowdStrike actor mapping).

### Cited Findings
- Microsoft/CrowdStrike joint actor-name mapping published 2 June 2025. — [Microsoft Security blog](https://microsoft.com/en-us/security/blog/2025/06/02/announcing-a-new-strategic-collaboration-to-bring-clarity-to-threat-actor-naming)
- Cloudflare Radar CT endpoints launched 4 August 2025; CT log-activity stats 9 October 2025. — [Cloudflare changelog](https://developers.cloudflare.com/changelog/2025-08-04-radar-ct-insights)
- Let's Encrypt RFC 6962 logs read-only 30 Nov 2025, shutdown planned 28 Feb 2026; static CT is the production path. — [Let's Encrypt](https://letsencrypt.org/2025/08/14/rfc-6962-logs-eol.html)
- gTLD WHOIS obligations ended 28 January 2025. — [ICANN](https://www.icann.org/en/contracted-parties/registry-operators/global-amendments/2023-global-amendments)
- BinaryEdge accounts closed 31 March 2025. — [Coalition FAQ](https://help.coalitioninc.com/hc/en-us/articles/34383910057371-BinaryEdge-Transition-FAQ)
- Maltrail static trails now live in `stamparm/trails` with a licence that requires a commercial licence for products, MSSP/MDR services and redistributed feeds. — [stamparm/maltrail](https://github.com/stamparm/maltrail)
- IPinfo Lite: unlimited free API and daily downloads under CC BY-SA 4.0. — [IPinfo Lite](https://ipinfo.io/lite)
- Censys moved free users to the Platform credit model (100 credits/month, 100 results). — [Censys docs](https://docs.censys.com/docs/platform-credits-free-starter)
- Ransomware.live now directs API users to a tokened `api-pro` host and prohibits commercial use without approval. — [Ransomware.live T&C](https://www.ransomware.live/t&c)

### Inferences
- Ranked shortlist for a commercial, fetch-only Worker platform, by signal per unit of effort and licence cleanliness:
  1. Spamhaus ASN-DROP JSON (daily, tiny, credit line).
  2. MISP Galaxy threat-actor + ransomware + tool clusters (CC0) joined with Microsoft mapping JSON.
  3. MITRE ATT&CK STIX groups/software (R2-staged).
  4. RansomLook leak-site data (CC BY 4.0).
  5. OFAC SDN cyber-program entries (direct from Treasury).
  6. Static-CT tile tailing for monitored-brand lookalikes (engineering-heavy, no licence risk).
  7. RIPEstat routing-history / asn-neighbours for cluster infra-movement evidence (event-driven, under 1,000/day).
  8. IPinfo Lite (attribution + SA) as an ASN/AS-domain cross-check.
- Needs written permission before use: ViriBack, ThreatView, bgp.tools exports, Team Cymru.
- Do not use commercially without a paid licence: Shodan InternetDB, Maltrail trails, JA4+ beyond JA4, Malpedia, Ransomware.live, OpenSanctions, Hunt.io (until terms confirmed).

### Gaps
- I did not find a genuinely new free infrastructure dataset launched in 2025-2026 beyond those above; this is absence of evidence from roughly 30 lookups, not a survey of every vendor.
- Payload sizes were not measured for any feed in this session; they should be measured with HEAD/ranged requests before budgeting D1 rows.
