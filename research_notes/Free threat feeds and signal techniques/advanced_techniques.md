# Advanced techniques (not feeds) for threat signal and threat-actor attribution from infrastructure and phishing content — state as of November 2026

Researcher notes on method and reliability (read first):

- 25 tool calls were used (search + fetch). Four pages were fetched and read in full: the IOK rule reference, the Thinkst cloned-site post, the Infoblox RDGA post, and arXiv 2509.13186. Everything else comes from search-result summaries of the linked pages, which is weaker evidence; those items are marked "(search summary)".
- Where a point comes from my own background knowledge and was not confirmed by a source this session, it is placed under Inferences or Gaps and labelled "unverified this session". The report writer should not present those as cited facts.
- Almost all effectiveness numbers in this field are vendor telemetry. They are marked "vendor-reported". Peer-reviewed numbers are marked "academic".
- Implementation-cost estimates are my own engineering judgement for a fetch + headless browser + SQL stack; they are in Inferences, never in Cited Findings.

---

## 1. Phishing-kit fingerprinting and PhaaS attribution

### Takeaway
The cheapest high-value addition is a rules engine in the IOK (Indicator of Kit) style over data the platform already captures (HTML, post-JS DOM, JS, CSS, cookies, headers, request URLs), plus a "set of resource hashes with Jaccard similarity" kit-family key; academic work shows hash-set and browser-API-set clustering identifies kit families with 0.8–0.97 agreement on labelled data, but accuracy falls sharply (to 0.69) when one mass-deployed kit no longer dominates the sample. For AiTM PhaaS (Tycoon 2FA, Sneaky 2FA etc.) static URL/string signatures decay within months, so durable detection is behavioural (anti-bot checks, redirect-to-benign behaviour, cookie names, backend banner/header hashes) and, on the defender-tenant side, referrer-checking CSS canaries.

### Cited Findings

**IOK rule format (phish.report)**
- IOK is based on Sigma, adapted to analyse websites rather than security logs; rules use a Sigma `detection` block with a `condition` line (search summary) — [phish.report/IOK](https://phish.report/IOK), [github.com/phish-report/IOK](https://github.com/phish-report/IOK)
- Fields available to a rule: `title` (all titles, including ones set by JS), `hostname`, `html` (as returned by the server), `dom` (HTML after JS execution), `js` (inline and external), `css` (inline and external), `cookies` (`name=value`), `headers` (`Header-Name: value`), `requests` (URLs of all requests the page makes) — [IOK rule reference](https://phish.report/docs/iok-rule-reference)
- Modifiers: `|startswith`, `|endswith`, `|contains`, `|re`, and `|all` (all listed values must match; default is any) — [IOK rule reference](https://phish.report/docs/iok-rule-reference)
- A `level` field (e.g. `likely_malicious`) drives automatic action in Phish Report; custom metadata is allowed but not interpreted — [IOK rule reference](https://phish.report/docs/iok-rule-reference)
- The open-source core is stated to contain "over 200 rules" — [IOK rule reference](https://phish.report/docs/iok-rule-reference)
- The reference example is a "Fake Chrome error page" rule: Chrome's error page HTML is built into the browser, so a server returning it indicates cloaking / anti-analysis; it uses `html|contains|all` on two fragments — [IOK rule reference](https://phish.report/docs/iok-rule-reference)
- The ruleset is ODbL-licensed, free to reuse with attribution (search summary) — [github.com/phish-report/IOK](https://github.com/phish-report/IOK)
- Because it is Sigma-based, IOK rules can be converted to other query languages; Phish Report converts rules for data sources whose support ranges from URL-only to static HTML scans (search summary) — [IOK rule conversion blog](https://phish.report/blog/iok-rule-conversion)
- phish.report documents "unique kit IDs" as a rule-writing topic (kit-embedded identifiers usable as actor pivots) (search summary, title only) — [Unique kit IDs](https://phish.report/IOK/learn/050-unique-kit-ids)

**Kit-family clustering — academic evidence**
- (academic) "Characterizing Phishing Pages by JavaScript Capabilities" (arXiv 2509.13186) crawled 1,328,917 phishing URLs over 523 days (Aug 2023 – Jan 2025) from OpenPhish, PhishTank, URLScan, SMS gateways, PhishDB and APWG, using VisibleV8 (instrumented Chromium logging every browser API call per script) plus KitPhishr to find leftover kit zips — [arXiv 2509.13186](https://arxiv.org/html/2509.13186v1)
- (academic) Ground-truth kit families were defined by comparing the sets of SHA-256 hashes of kit source files; two kits with Jaccard similarity ≥ 90% were treated as one family — giving 548 kit families across 4,562 URLs — [arXiv 2509.13186](https://arxiv.org/html/2509.13186v1)
- (academic) Clustering pages by the set of browser APIs their first-party scripts call (HDBSCAN, Jaccard distance, 4-week rolling windows merged by shared pages) scored Fowlkes-Mallows 0.97 and V-measure 0.91 against kit labels; a simpler baseline using script SHA-256 hashes scored FMI 0.80–0.89 — [arXiv 2509.13186](https://arxiv.org/html/2509.13186v1)
- (academic) Pitfall: one Wells Fargo kit was 1,073 of the 4,562 labelled URLs (~24%); rebalancing it away dropped FMI to 0.69 — [arXiv 2509.13186](https://arxiv.org/html/2509.13186v1)
- (academic) In the wild, 434,050 pages qualified for clustering and formed 11,377 clusters; 69% of brand-labelled clusters target a single brand — [arXiv 2509.13186](https://arxiv.org/html/2509.13186v1)
- (academic) Technique prevalence by cluster: basic fingerprinting 80%, advanced fingerprinting 69%, timing-based bot detection (`Performance.now` + `setTimeout`) 22%, obfuscation 21% (`Window.atob` in 1,455 clusters, `eval` in 982), client-side IP checks in 504 clusters (api.ipify.org in 177, ipapi.co in 106), Cloudflare Turnstile in only 7 clusters (181 pages), WebAssembly in 199 clusters (mostly FriendlyCaptcha-style bot checks) — [arXiv 2509.13186](https://arxiv.org/html/2509.13186v1)
- (academic) The paper does not measure Telegram exfiltration or anti-debugging, and releases no tooling of its own — [arXiv 2509.13186](https://arxiv.org/html/2509.13186v1)
- (academic) Bijmans et al., USENIX Security 2021: 70 Dutch phishing kits grouped into 10 families; unique fingerprints built per kit to measure prevalence in the wild; CT logs used to find phishing domains; median phishing-domain uptime 24 hours (search summary) — [TU Delft repository copy](https://repository.tudelft.nl/file/File_63ab4779-a48f-424f-83d8-6ae6cc5fab30?preview=1)

**Open kit collections and rules**
- PhishingKit-Yara-Rules (t4d, a StalkPhish project): YARA rules for phishing-kit zip files, based on raw zip format analysis to match directory and file names (so no yara-extend is needed); AGPL-3.0; created December 2019 (search summary; rule count not found) — [github.com/t4d/PhishingKit-Yara-Rules](https://github.com/t4d/PhishingKit-Yara-Rules)
- KitPhishr is described in the academic paper above as a third-party fuzzer that looks for leftover kit zip files on phishing servers — [arXiv 2509.13186](https://arxiv.org/html/2509.13186v1)

**AiTM / PhaaS kits**
- Tycoon 2FA checks for automation tooling — `navigator.webdriver`, `window.callPhantom` / `window._phantom`, "Burp" in the user agent — and redirects to `about:blank` on detection (search summary) — [Elastic Security Labs](https://www.elastic.co/security-labs/tycoon-2fa-aitm-detection-engineering)
- Tycoon 2FA added browser fingerprinting in an April 2025 sample; later capabilities listed include CAPTCHA front ends, dynamic JS obfuscation, Unicode-based code hiding, and a debugger timing check (search summary) — [SC World](https://www.scworld.com/news/tycoon-2fa-phishing-kit-update-timeline-reveals-new-evasion-techniques), [CYFIRMA](https://www.cyfirma.com/?p=49631)
- Sneaky 2FA: found by Sekoia in December 2024, active since at least October 2024, sold via Telegram, targets Microsoft 365; hosted largely on compromised WordPress sites plus attacker domains; uses Cloudflare Turnstile, obfuscation and anti-debugging (search summary) — [Hackread](https://hackread.com/telegram-sneaky-2fa-phishing-kit-microsoft-365-accounts/), [CyberInsider](https://cyberinsider.com/new-aitm-phaas-platform-sneaky-2fa-targets-microsoft-365-accounts/)
- Sneaky 2FA URL signature decay: early versions used a 150-character random alphanumeric path segment followed by `/index` or `/verify`; from April 2025 the operators randomised both the suffix and the string length (search summary) — [Push Security](https://pushsecurity.com/threat-intelligence/sneaky-2fa)
- Sneaky 2FA uses different hard-coded User-Agent strings at different steps of the authentication flow, which Sekoia considers a high-fidelity detection point ("impossible device shift") — this is a sign-in-log detection, not a web-crawl one (search summary) — [Hackread](https://hackread.com/telegram-sneaky-2fa-phishing-kit-microsoft-365-accounts/)
- Sneaky 2FA domains are often live only a few days with limited overlap (search summary) — [Centripetal](https://www.centripetal.ai/threat-research/typhoon-versus-sneaky)
- An independent DNS analysis reported an average 113 days between domain registration and threat-intel detection for Sneaky 2FA domains (search summary; source not identified precisely, treat as low confidence) — [Push Security](https://pushsecurity.com/threat-intelligence/sneaky-2fa)

**Smishing kits (Darcula / Lucid / Lighthouse)**
- Lucid was first documented by PRODAFT in April 2025; it delivers via iMessage and RCS, is attributed to the Chinese-speaking XinXin group (developer tracked as LARVA-242); its pages use IP blocking, user-agent filtering and time-limited single-use URLs (search summary) — [The Hacker News](https://thehackernews.com/2025/04/lucid-phaas-hits-169-targets-in-88.html?hl=en)
- Darcula (developer LARVA-246): Netcraft reports taking down more than 25,000 Darcula pages, blocking nearly 31,000 IPs and flagging over 90,000 phishing domains since March 2024 (vendor-reported; search summary) — [The Hacker News](https://thehackernews.com/2025/04/darcula-adds-genai-to-phishing-toolkit.html?hl=en)
- Lighthouse and Lucid were linked to more than 17,500 phishing domains targeting 316 brands in 74 countries (vendor-reported; search summary) — [The Hacker News](https://thehackernews.com/2025/04/chinese-smishing-kit-behind-widespread.html)
- Sources conflict on Lighthouse's relationship to XinXin: one report says it operates independently, another cites PRODAFT saying it shares significant similarities in targeting, landing pages and domain-creation patterns (search summary) — [The Hacker News](https://thehackernews.com/2025/04/chinese-smishing-kit-behind-widespread.html); conflicting framing in [The Hacker News](https://thehackernews.com/2025/04/lucid-phaas-hits-169-targets-in-88.html?hl=en)

**AiTM detection via canaries (defender-tenant side)**
- Thinkst's cloned-website token (JS version): a small, optionally obfuscated script checks that the page is served from the expected domain and fires only when it is not; no request reaches Canarytokens on legitimate loads — [Thinkst](https://blog.thinkst.com/2024/01/defending-against-the-attack-of-the-cloned-websites.html)
- CSS version: a `url()` reference to an invisible background image; the server checks the Referer header. Stated limitations: some browsers omit or spoof Referer, and the token server sits in the path of every page load — [Thinkst](https://blog.thinkst.com/2024/01/defending-against-the-attack-of-the-cloned-websites.html)
- Thinkst moved the check to a CloudFront Function at the edge (≈1 ms execution limit): matching Referer → 1×1 transparent GIF; mismatch → redirect to the token server with the token ID — [Thinkst](https://blog.thinkst.com/2024/01/defending-against-the-attack-of-the-cloned-websites.html)
- For Entra ID the CSS is installed through company branding, which requires Entra ID P1 or P2 and a tenant administrator; propagation can take minutes to hours — [Thinkst](https://blog.thinkst.com/2024/01/defending-against-the-attack-of-the-cloned-websites.html)
- The post gives no detection-rate or alert-volume numbers — [Thinkst](https://blog.thinkst.com/2024/01/defending-against-the-attack-of-the-cloned-websites.html)
- Evasion: a reader comment (unverified) reports a kit that proxied the CSS, rewrote the background URLs and emulated a safe Referer — [Thinkst](https://blog.thinkst.com/2024/01/defending-against-the-attack-of-the-cloned-websites.html); a Hack.lu 2024 talk notes AiTM operators can inject a `Referrer-Policy` header so no referrer is sent (search summary) — [Hack.lu 2024 slides](https://archive.hack.lu/media/hack-lu-2024/submissions/MAVVT3/resources/HackLU_2024_Slides_ShAEOfh.pdf)
- Zolder independently built a similar token; the community project Clarion builds on Zolder's idea and describes itself as extremely experimental (search summary) — [Zolder blog](https://zolder-astro.pages.dev/blog/using-honeytokens-to-detect-aitm-phishing-attacks-on-your-microsoft-365-tenant/), [Canarytokens Entra ID docs](https://docs.canarytokens.org/guide/entraid-token.html)

### Inferences
- An IOK-compatible evaluator is a small build for this platform: the nine IOK fields map onto what a headless capture already yields (server HTML, post-JS DOM, script and stylesheet bodies, cookies, response headers, request list). Rules are string/regex containment, so they run deterministically in the Worker at capture time; the ODbL ruleset (200+ rules) can be imported with attribution. Estimated cost: days, not weeks. Storing matched rule ids + tags per capture gives a kit/actor label that SQL can group on.
- A kit-family key that needs no ML: per capture, store the set of SHA-256 hashes of first-party scripts/stylesheets/images (already hashed for evidence), then join captures on shared hashes and compute Jaccard in SQL (`shared / (a + b - shared)`). The academic baseline for script hashes alone was FMI 0.80–0.89, so this is a reasonable first tier; exclude hashes seen on many unrelated sites (jQuery, Bootstrap, brand assets) with a document-frequency cutoff, which is the same over-match urlscan warns about.
- The 0.97 → 0.69 drop when one kit stops dominating means any accuracy figure measured on your own corpus will be flattered by whichever kit is most common; evaluate per family, not per page.
- Because Turnstile appeared in only 7 of 11,377 clusters up to Jan 2025 while 2025 AiTM kits use it routinely, "Turnstile/CAPTCHA gate + login-brand keywords behind it" is a newer signal than that dataset reflects (my inference from combining the two sources; no single source states this).
- Static URL-shape rules for AiTM kits (e.g. Sneaky 2FA's 150-char path) should carry an expiry/"last matched" date; the documented change within ~6 months shows they rot.
- The CSS canary is a customer-deployed sensor, not something a crawler can run. For a brand-protection product it is a cheap add-on offering: host a referrer-checking pixel endpoint (a Worker can do what Thinkst does with CloudFront Functions), give customers a CSS snippet for their login/branding, and turn mismatched referrers into "clone detected" alerts with the phishing hostname. It will miss kits that strip or spoof Referer.
- Favicon mmh3, TLSH/ssdeep on HTML, CSS-class signatures and resource-path patterns were named in the brief; I found no measured accuracy for any of them this session (see Gaps). From background knowledge (unverified this session): mmh3-of-base64 favicon is the Shodan convention; TLSH needs ≥50 bytes and gives a distance, which SQL cannot index directly — bucket by the first bytes of the digest or precompute pairs.

### Gaps
- No primary Sekoia document was retrieved for Tycoon 2FA / Sneaky 2FA / Mamba 2FA detection opportunities; EvilProxy, Mamba 2FA and Rockstar 2FA specifics were not researched at all.
- No source found this session with measured precision/recall for favicon-hash, TLSH/ssdeep, DOM-structure hash, or CSS-class-signature kit matching.
- PhishingKit-Yara-Rules rule count, KitPhishr and StalkPhish current maintenance status, and any open kit-zip corpus were not confirmed.
- No numbers found on how often phishing servers leave kit zips / open directories exposed.
- No public detection-rate data for the CSS canary; only mechanism and anecdotal evasion.
- Primary PRODAFT / Netcraft reports for Darcula, Lucid and Lighthouse were not opened; kit-specific page fingerprints for them were not found. A June 2026 Google lawsuit against a Chinese smishing network surfaced in results but was not verified.

---

## 2. Infrastructure fingerprint pivots

### Takeaway
The pivots that vendors report as surviving longest are server-side response fingerprints (banner / header hashes), nameservers and registration patterns; favicons, page titles, IPs and CSS hashes go stale fastest. Every fingerprint (JARM, JA4X, favicon, tracker ID, file hash) is a clustering aid that over-matches on shared hosting, CDNs and common libraries, so it should feed a weighted evidence score with a "how many unrelated sites share this value" guard rather than act as attribution on its own.

### Cited Findings

**Response hashing (Validin-style)**
- A Validin re-test of pivots from four earlier investigations found host-response, header/body-hash, DNS/IP and registration pivots still productive months later, while favicons, title tags and wildcard subdomains aged out faster (search summary of an aggregator mirror of the Validin post; original not fetched) — [mirror: "Pivots Revisited"](https://www.hendryadrian.com/?p=78289)
- A six-month follow-up on a fake YouTube-DMCA phishing campaign found older IP, favicon and CSS-hash pivots went stale quickly while C2 banner and header fingerprints kept finding new infrastructure (search summary of mirror) — [mirror: "Six Months Later"](https://www.hendryadrian.com/?p=101623)
- One hunt combining a shared header hash with a banner hash returned 206 unique IoCs, all impersonating crypto exchanges (search summary) — [Intel Insights substack](https://intelinsights.substack.com/p/host-long-and-prosper)
- An HTTP body-hash pivot uncovered nearly 300 domains tied to malicious Chrome/Edge extension C2 (vendor-reported; search summary) — [mirror: "Finding Fake/Phishing Domains with HTML Features in Validin"](https://www.hendryadrian.com/?p=70547)

**urlscan pivots**
- urlscan's threat research describes pivoting on: page hashes; a cookie name set by the kit's backend (which surfaced sites sharing the same JS codebase); and nameservers, described as a more durable pivot than IPs because actors rotate IPs easily (search summary) — [urlscan blog, FluxPanel and fast flux, 2026-09-03](https://urlscan.io/blog/2026/09/03/FluxPanelandFastFlux/), [urlscan blog, 2026-08-17](https://urlscan.io/blog/2026/08/17/InfluencerPhishing/)
- urlscan warns that a file hash as the only overlapping indicator over-matches when the file is a common library and should be paired with a second parameter; Cloudflare fronting hides the underlying hosting for most hostnames in such clusters (search summary) — [urlscan blog, 2026-08-04](https://urlscan.io/blog/2026/08/04/ProveFinancialPhishingFramework/)

**Favicon and tracker IDs**
- Favicon pivot: compute the MMH3 hash (the minus sign is part of the value) and search it, e.g. with Shodan's `http.favicon.hash`; phishing pages often copy or hotlink the impersonated brand's favicon (search summary) — [OSINTme](https://www.osintme.com/index.php/2021/12/06/how-to-investigate-a-massive-phishing-campaign/)
- Web-analytics IDs: kits copied from a legitimate site often carry the original analytics ID; Akamai reported two cases where analytics UIDs led to much larger campaigns, and notes false positives when the extracted ID is a generic string (search summary) — [Akamai](https://www.akamai.com/blog/security/phishing-detection-via-analytic-networks), [CSO Online](https://www.csoonline.com/article/568043/defenders-can-discover-phishing-sites-through-web-analytics-ids.html)
- Silent Push describes favicon-hash search for Gmail clones and pivoting on a server's technical signatures because one actor's different lures often share an identical server setup (vendor; search summary) — [Silent Push](https://www.silentpush.com/?p=14251)
- A Silent Push case study expanded two seed domains to 688 using IP pivots, shared web resources and SHV/JARM fingerprints (vendor-reported; search summary) — [Silent Push help centre](https://help.silentpush.com/docs/silent-push-exposes-cdc-voucher-scammers)

**TLS fingerprints (JARM, JA4+)**
- JARM is an active server-side fingerprint: it sends multiple TLS ClientHellos and hashes how the server responds (search summary) — [Hunt.io glossary](https://hunt.io/glossary/ja4-fingerprinting)
- JA4X (certificate-structure fingerprint) is useful for grouping servers when domains and IPs change, but shared hosting, managed services and load balancers cause false positives; it should be a prioritisation aid, not a verdict (search summary of a glossary page; low authority) — [NHI Mgmt Group glossary](https://nhimg.org/glossary/ja4x/)
- FoxIO notes potential false positives for JA4T on standard ports 80/443 and recommends combining JA4 fingerprints (search summary) — [FoxIO on JA4T](https://medium.com/foxio/ja4t-tcp-fingerprinting-12fb7ce9cb5a)
- (academic, malware not phishing) A 2026 evaluation found only 64.9% of malware families have unique signatures, capping achievable recall (search summary) — [arXiv 2602.09606](https://www.arxiv.org/pdf/2602.09606)
- Infoblox (with Confiant) reports using a JA4+ fingerprinting approach to surface Keitaro servers used for malware delivery (vendor; search summary) — [Infoblox](https://www.infoblox.com/blog/?p=13206)

**DNS-characteristic actor tracking / RDGA**
- Infoblox introduced the term RDGA in October 2023: the actor keeps the algorithm private and registers every generated domain (search summary) — [Infoblox](https://www.infoblox.com/blog/threat-intelligence/rdgas-the-next-chapter-in-domain-generation-algorithms/)
- (vendor-reported) Between 17 Oct 2023 and 17 Apr 2024 Infoblox detected over 2 million unique RDGA domains, averaging over 11,000 new per day, initially in about 117,000 actor clusters, reduced to about 52,000 after automated refinement and manual analysis — [Infoblox](https://www.infoblox.com/blog/threat-intelligence/rdgas-the-next-chapter-in-domain-generation-algorithms/)
- (vendor-reported) Revolver Rabbit registered over 500,000 domains on `.bond` alone; its pattern is dictionary words or country codes/years plus a five-digit number, with variants (one or two digits plus a letter, double dashes) — [Infoblox](https://www.infoblox.com/blog/threat-intelligence/rdgas-the-next-chapter-in-domain-generation-algorithms/); registration fees estimated at over $1 million (search summary) — [Infoblox press release](https://www.infoblox.com/news/news-events/press-releases/revolver-rabbits-million-dollar-masquerade-infoblox-uncovers-the-hidden-world-of-rdgas/)
- RDGA pattern types described: random/high-entropy; nonsensical dictionary-word combinations (VexTrio Viper); themed dictionaries; variant-based (insert/shift/delete characters from a base name); low-entropy English-like repeated sequences (Hancitor, flagged in 2018 with a statistical model on repeated character sequences); word-number formats — [Infoblox](https://www.infoblox.com/blog/threat-intelligence/rdgas-the-next-chapter-in-domain-generation-algorithms/)
- Caveats from the same post: legitimate businesses also use RDGAs; Namecheap's "Beast Mode" lets any customer bulk-generate variants; some RDGA domains read like ordinary phrases (e.g. `online-jobs-42681`); the article does not quantify false positives or describe registrar/DNS features in detail — [Infoblox](https://www.infoblox.com/blog/threat-intelligence/rdgas-the-next-chapter-in-domain-generation-algorithms/)
- Silent Push defines "Indicators of Future Attack" as domains and IPs that show where an attack will be launched, derived from how an adversary manages infrastructure; an example is detecting Aeza Group IP ranges moving to a new AS after OFAC sanctions in July 2025 (vendor marketing; search summary) — [Silent Push IOFA paper](https://info.silentpush.com/hubfs/Silent%20Push%20Know%20First.pdf), [Silent Push news](https://www.silentpush.com/news/iofa-detects-aeza-group-infrastructure/)
- Silent Push's Scattered Spider report lists reused dedicated servers and bulk domain registration as recurring patterns (vendor; search summary) — [Silent Push](https://www.silentpush.com/?p=9943)

**TDS detection**
- A Keitaro detection framework uses Keitaro-specific artifacts — a `/click_api/v3` endpoint, distinctive cookies, panel paths, response headers and JS signatures — and requires at least two independent checks to pass before reporting a match; its claim that all 1,565 panels it found are malicious is self-reported and unverified (search summary) — [PhishDestroy](https://phishdestroy.io/keitaro-tds-exposed)
- Infoblox identified eight threat actors using Keitaro for cloaking, and notes Keitaro is an advertising tracker with legitimate uses whose vendor can terminate abusive instances (search summary) — [Infoblox](https://www.infoblox.com/blog/?p=13206)
- A 15,000+ domain AI-investment scam network used Keitaro as part of its cloaking layer (search summary) — [Malwarebytes](https://www.malwarebytes.com/blog/news/2026/05/massive-ai-investment-scam-network-spans-15500-domains)
- VexTrio Viper has used Sitting Ducks hijacks since early 2020 for a TDS that serves SocGholish and ClearFake, and its affiliate program has routed traffic to over 65 partners (vendor-reported; search summary) — [The Hacker News](https://thehackernews.com/2024/08/over-1-million-domains-at-risk-of.html?m=0)

**Sitting Ducks / lame delegation**
- Sitting Ducks exploits lame delegation: the domain's delegated authoritative nameserver cannot answer for the zone, letting an attacker claim the zone at the DNS provider (search summary) — [Infoblox research report](https://infoblox.com/resources/research-reports/dns-predators-attack-vipers-hawks-hijack-sitting-ducks-domains)
- (vendor-reported) Infoblox identified about 800,000 vulnerable domains, of which about 70,000 were identified as hijacked (search summary) — [TechTarget](https://www.techtarget.com/cybersecurity/news/366615752/Infoblox-800000-domains-vulnerable-to-hijacking-attack?amp=1); earlier coverage cited over 35,000 hijacked and over 1 million at risk — [BleepingComputer](https://www.bleepingcomputer.com/news/security/sitting-ducks-dns-attacks-let-hackers-hijack-over-35-000-domains/amp/), [The Hacker News](https://thehackernews.com/2024/08/over-1-million-domains-at-risk-of.html?m=0)
- Rotational use of hijacked domains by different actors makes the technique hard to detect (search summary) — [Infoblox research report](https://infoblox.com/resources/research-reports/dns-predators-attack-vipers-hawks-hijack-sitting-ducks-domains)

### Inferences
- Cheapest new pivots for a fetch-only stack, in order of expected durability per the Validin/urlscan observations: (1) response-header fingerprint — hash of ordered header names plus selected stable values (Server, X-Powered-By, cookie names) from the capture; (2) backend cookie names; (3) nameserver set and SOA rname from DoH lookups; (4) tracker IDs (GA `UA-`/`G-`, GTM, AdSense `pub-`, Meta pixel, Yandex Metrika) by regex over captured HTML/JS; (5) favicon mmh3. All are single-column extractions at capture time plus a `GROUP BY value HAVING COUNT(DISTINCT domain) BETWEEN 2 AND N`.
- Each pivot value needs a commonness guard, mirroring the platform's existing "hub IP > 150 brands" rule: drop values seen on too many unrelated registrable domains, and drop tracker IDs that also appear on the impersonated brand's real site (a copied ID points at the victim, not the actor — still useful as a "cloned from brand X" signal, which is the Akamai use).
- JARM and JA4S/JA4X need raw TLS handshakes. A Cloudflare Worker `fetch()` does not expose the server hello or certificate chain, so these are not obtainable from fetch-only HTTP; they need a small external prober (raw sockets) or a paid/free-tier scan dataset. Certificate fields (issuer, validity length, SAN count/pattern) are obtainable from CT without a handshake, so "cert template" grouping (issuer + validity days + SAN shape) is the SQL-friendly substitute. (My assessment; unverified this session.)
- RDGA-style detection can be approximated in SQL on the platform's NRD archive without ML: reduce each second-level label to a shape string (letters→`a`, digits→`9`, keep hyphens; collapse runs with lengths, e.g. `a{6}-a{4}-9{5}`), then group by (shape, TLD, registrar or nameserver set, registration day) and flag groups above a size threshold. Infoblox's own caveat applies: bulk patterned registration is also legitimate behaviour, so this labels "bulk registrant cluster", and needs a second signal (brand match, later weaponisation) before it means "malicious".
- Sitting-Ducks monitoring for customer domains is fetch-only: for each delegated NS of a customer zone, query that NS directly (or via DoH with the NS's answers) for the SOA; REFUSED/SERVFAIL/no-authority from a provider-hosted NS = lame delegation. This is a customer-posture check that fits beside the existing email-security posture scan.
- A TDS/cloaker signal can reuse existing page capture: fetch the same URL with two or three client profiles (mobile vs desktop UA, with/without referrer) and record whether the final registrable domain differs; add the Keitaro artifact checks with the same "two independent checks" rule PhishDestroy uses.

### Gaps
- Original Validin posts were not fetched (only aggregator mirrors appeared); exact definitions of Validin's banner/header/body hash were not confirmed.
- No rigorous false-positive study of JARM for phishing infrastructure was found; no source on JA4H/HTTP header-order hashing effectiveness for phishing was found.
- SSH host-key reuse, registrant/registrar/SOA-email pivots, RDAP registration-timing bursts, parked→weaponised state transitions, fast-flux detection thresholds and 404TDS were not researched to a citable level.
- No figure found for RDGA domains as a share of all new registrations, nor for VexTrio's share of TDS traffic.
- JA4+ licensing (which components are BSD vs FoxIO licence) and whether JARM/JA4 data is obtainable free from any scan dataset in 2026 were not checked.
- Infoblox's "DNS fingerprint" methodology is described only in general terms in what I read; the specific features are not public in that post.

---

## 3. Predictive / pre-weaponization signals

### Takeaway
Published timing data supports acting in the first hours after registration: a vendor measurement has ~60% of new phishing domains holding a working certificate within 2 hours, and an academic study found a 24-hour median phishing-domain uptime, so signals that fire days later arrive after the campaign. Evidence that mail setup (MX/SPF/DKIM) on a lookalike precedes BEC is case-level only — I found no population measurement — and search-ad monitoring via ad transparency archives has academic support but currently depends on OCR/LLM steps.

### Cited Findings
- (vendor-reported) Zimperium: within the first 2 hours almost 60% of newly created phishing domains already have a working SSL certificate; around half of phishing domains were reported within a week of creation and almost 25% within a day (search summary) — [Zimperium](https://zimperium.com/blog/deep-dive-into-phishing-chronology-threats-and-trends)
- (academic) Bijmans et al. (USENIX Security 2021) used CT logs to find phishing domains and measured a median phishing-domain uptime of 24 hours (search summary) — [TU Delft repository copy](https://repository.tudelft.nl/file/File_fd4103a9-7e0a-4a81-a133-d1dde52f3c11)
- Case evidence that lookalikes get mail infrastructure immediately: a typosquat registered 23 Feb 2026 via Wild West Domains had MX pointed at Microsoft 365, giving a working mail environment within minutes; in another case the attacker mirrored the real vendor's setup — same MX provider, valid SPF, valid DKIM, no DMARC (single incidents; search summary) — [IRONSCALES](https://ironscales.com/threat-intelligence/lookalike-domain-invoice-diversion-missing-letter), [IRONSCALES](https://ironscales.com/threat-intelligence/lookalike-domain-display-name-impersonation-zero-payload-trust-building)
- Vendor argument: SPF/DKIM/DMARC validate sending infrastructure, not whether a domain should be trusted, and a fully authenticated lookalike is trivial to create (search summary) — [IRONSCALES](https://ironscales.com/threat-intelligence/the-one-letter-typosquat-that-passed-every-authentication-check)
- Clone-detection beacons: the Thinkst cloned-site token (JS or CSS) alerts with the client IP and the referring domain when a page is served from an unexpected host — i.e. it reveals the phishing hostname at first victim/tester load — [Thinkst](https://blog.thinkst.com/2024/01/defending-against-the-attack-of-the-cloned-websites.html)
- Brand favicons are often hotlinked directly from the impersonated site rather than copied (search summary) — [OSINTme](https://www.osintme.com/index.php/2021/12/06/how-to-investigate-a-massive-phishing-campaign/)
- Search-ad abuse, academic: a 2025 TU Delft thesis (with BforeAI) on brand impersonation in Google Ads used manual inspection plus six brand-agnostic heuristics and flagged 4,160 ads (7.9%) as abusive, 3,781 of them affiliate brand bidding (search summary; method details not confirmed) — [TU Delft repository](https://repository.tudelft.nl/record/uuid:319e926c-a55f-430f-a0a3-9a816bd9b2c4)
- Search-ad abuse, academic (AdLens, NYU/Radboud): a Puppeteer crawler pulled 188,000 software-related ad creatives from Google's Ads Transparency Center (EEA data carries impression counts, topic labels and broad targeting), then used a cheap similarity search followed by a panel of open-source language models, with OCR and translation steps; Google confirmed only 6 of 24 reported ads as violations (secondary reporting; search summary) — [Help Net Security, 2026-09-02](https://www.helpnetsecurity.com/2026/09/02/google-scareware-ads-research/)
- Scam advertisers reuse the same ad accounts over time (search summary) — [Malwarebytes](https://www.malwarebytes.com/fr/blog/scams/2024/12/repeat-offenders-drive-bulk-of-tech-support-scams-via-google-ads)
- Silent Push reports that brand-impersonation scans surface newly registered malicious domains appearing as sponsored search ads (vendor; search summary) — [Silent Push](https://www.silentpush.com/blog/google-malvertising/)

### Inferences
- A state-transition ladder per lookalike domain is implementable with DoH + HEAD/GET only and stored as timestamps: registered → NS set → A/AAAA → certificate in CT → MX present → SPF/DKIM/DMARC TXT present → HTTP 200 with content → login form / brand assets. The platform already has velocity and email-posture scanners for its own brands; pointing the same posture scan at lookalikes yields a "mail-enabled lookalike" flag. Given only case-level evidence, weight MX-on-lookalike as a severity raiser for BEC risk, not as proof.
- Lookalike mail setup that mirrors the brand's own MX provider (e.g. both on Microsoft 365) is the specific pattern in the cited cases and is a one-join comparison against the brand's stored email-security scan.
- Hotlinked brand assets mean the brand's own web logs (or a canary asset URL the customer embeds) show foreign Referers before any feed lists the phish; a referrer-checking pixel endpoint as described in §1 covers both "clone detection" and "hotlink detection".
- Ad-transparency monitoring is feasible with a headless browser, and repeat-advertiser tracking is a plain SQL signal; the classification step in the academic pipeline used OCR + LLMs, so a rules-only version would be limited to text creatives and landing-domain matching against the lookalike table.
- With a 24 h median uptime and most certificates issued within 2 h, a 6-hourly scan cadence loses a large share of the useful window; the registration→certificate gap should be scanned sub-hourly for high-score lookalikes only (budget-bounded).

### Gaps
- No measured rate of MX/SPF presence on lookalike domains, and no measured lead time between MX setup and first BEC email, was found. A Politecnico di Torino thesis may contain one but was not readable ([link](https://webthesis.biblio.polito.it/39728/1/tesi.pdf)).
- DMARC aggregate (RUA) ingestion as a spoofing sensor, BIMI/VMC abuse, and SEO-poisoning detection were not researched to a citable level this session.
- No peer-reviewed measurement of hours from certificate issuance to first blocklist detection was found.
- Meta Ad Library / Microsoft Ads transparency coverage for phishing ads was not researched; whether Google's Ads Transparency Center can be queried by keyword (rather than advertiser/domain) in 2026 was not confirmed.

---

## 4. Graph / statistical methods cheap enough for SQL

### Takeaway
The best-evidenced deterministic similarity method found is set-Jaccard over artifact sets (file hashes at ≥0.9 for kit family; browser-API sets for behaviour), which translates directly to SQL joins; perceptual hashing of screenshots alone is weak (one 2025 paper reports 0.79 accuracy) and is better used as a candidate generator than a verdict. Domain-shape grouping reproduces the pattern classes Infoblox describes for RDGAs without ML.

### Cited Findings
- (academic) Kit-family grouping by Jaccard ≥ 0.90 over sets of source-file SHA-256 hashes — [arXiv 2509.13186](https://arxiv.org/html/2509.13186v1)
- (academic) Page clustering by Jaccard distance over browser-API sets reached FMI 0.97 (0.69 rebalanced) vs 0.80–0.89 for script hashes; removing DOM/CSS APIs or property reads did not improve accuracy; pages needed ≥4 distinct APIs (labelled) or ≥8 (unlabelled) to be clustered — [arXiv 2509.13186](https://arxiv.org/html/2509.13186v1)
- (academic) The full pairwise distance matrix was too large, so the authors clustered inside 4-week rolling windows advancing 2 weeks and merged local clusters sharing at least one page — [arXiv 2509.13186](https://arxiv.org/html/2509.13186v1)
- (academic, preprint) PhishSnap (arXiv 2512.02243): pHash of screenshots (resize to 32×32, DCT, keep low-frequency 8×8 coefficients), compared by Hamming distance against stored legitimate-template hashes; reported accuracy 0.79, precision 0.76, recall 0.78; misclassifies brandless templates and adaptive layouts (search summary; the reported F1 of 0.82 is inconsistent with that precision/recall, so treat the table with caution) — [arXiv 2512.02243](https://arxiv.org/html/2512.02243)
- Multi-evidence rule: a Keitaro checker requires ≥2 independent artifact checks before declaring a match (search summary) — [PhishDestroy](https://phishdestroy.io/keitaro-tds-exposed)
- Over-match guard: a file hash that belongs to a common library must be paired with a second parameter (search summary) — [urlscan blog](https://urlscan.io/blog/2026/08/04/ProveFinancialPhishingFramework/)
- Domain-name pattern classes usable for statistical/shape scoring, including Hancitor being caught in 2018 by a statistical model on repeated character sequences — [Infoblox](https://www.infoblox.com/blog/threat-intelligence/rdgas-the-next-chapter-in-domain-generation-algorithms/)
- (vendor-reported) Infoblox's automated clustering produced ~117,000 clusters that needed refinement and manual analysis to reach ~52,000 — evidence that unsupervised registration clustering over-fragments — [Infoblox](https://www.infoblox.com/blog/threat-intelligence/rdgas-the-next-chapter-in-domain-generation-algorithms/)

### Inferences
- Bipartite IOC co-occurrence in SQL: one narrow table `capture_artifact(capture_id, kind, value)` with kinds such as `script_sha256`, `favicon_mmh3`, `header_fp`, `cookie_name`, `tracker_id`, `exfil_sink`, `ns_set`, `cert_template`, `iok_rule`. Edges between captures are a self-join on (kind, value) filtered by document frequency; edge weight = sum of per-kind weights (rare, actor-controlled artifacts such as exfil sink id or tracker id high; favicon and title low). The platform's existing connected-components pass can consume these edges; require either one high-weight artifact or ≥2 independent kinds, matching the two-check practice cited above.
- Weighting by inverse document frequency (`log(N / df)`) is computable in SQL and automatically suppresses jQuery-class artifacts; a hard `df` ceiling prevents giant components (same failure mode the platform already guards against with hub IPs and shared ASNs).
- MinHash/SimHash: only needed when exact-hash sets fail (kits that randomise file contents per deployment). A 64-bit SimHash over DOM tag-sequence shingles can be computed at capture time and stored as four 16-bit band columns; candidates are rows sharing any band (indexed equality), then Hamming distance is checked in application code. I found no phishing-specific accuracy evidence for this (see Gaps), so treat thresholds as something to calibrate locally.
- pHash/dHash of screenshots: per the PhishSnap numbers, use it to group near-identical captures and to shortlist "looks like brand X login" against customer-supplied reference screenshots, never to dismiss. Cloaked/CAPTCHA-gated captures will all hash alike — exclude captures flagged as anti-bot walls.
- Temporal burst detection without ML: per (registrar, TLD, nameserver set) compare today's NRD count with a trailing 28-day median and flag ratios above a threshold; store only groups, not rows, to stay within D1 read budgets.
- Rolling-window clustering with merge-on-shared-member (as the paper did) is the right shape for D1's limits: cluster only the last N weeks, keep stable cluster ids by merging into existing components.
- Character n-gram/Markov scoring and entropy for DGA-like names are well-known techniques (background knowledge, unverified this session); given Infoblox's point that many RDGA names are dictionary words, entropy alone will miss them, so shape + bulk-timing grouping is the more useful cheap signal.

### Gaps
- No source found with measured accuracy for SimHash/MinHash/LSH on phishing-page DOMs, for logo detection without ML, or for community-detection alternatives on IOC graphs.
- No published benchmark comparing dHash vs pHash for phishing screenshots was found.
- No citable thresholds for burst detection or n-gram domain scoring were found.

---

## 5. New 2025–2026 attacker tradecraft that needs new detection

### Takeaway
The shifts with the strongest numbers are ClickFix-style fake-CAPTCHA lures (ESET: +517% H1 2025, a further +108% into H1 2026; Microsoft: 47% of initial-access cases seen by Defender Experts) and phishing built on AI site builders and other trusted platforms (Proofpoint: tens of thousands of Lovable URLs flagged per month). Both defeat domain-centric detection — the hostname is a legitimate platform or a compromised site — so detection has to move to page-content rules (clipboard writes, Win+R instructions, builder fingerprints, credential forms on platform subdomains) and to tenant-side controls for flows with no phishing page at all (device-code phishing).

### Cited Findings
- ClickFix: ESET's H1 2025 report showed about a 517% rise in the HTML/FakeCaptcha detection versus late 2024, with ClickFix nearly 8% of all blocked attacks (vendor telemetry; search summary) — [Help Net Security](https://www.helpnetsecurity.com/2025/06/26/clickfix-attacks-fakecaptcha-eset-report/), [The Hacker News](https://thehackernews.com/2025/06/new-filefix-method-emerges-as-threat.html)
- ESET's H1 2026 report (published 8 July 2026) says HTML/FakeCaptcha detections rose a further 108% from H2 2025 to H1 2026, though below the early-2025 peak, with spread into AI-service pages, browser extensions and Microsoft sign-ins (vendor telemetry; search summary of Japanese-language coverage) — [ITmedia](https://www.itmedia.co.jp/enterprise/articles/2607/30/news071.html)
- Microsoft's 2025 Digital Defense Report put ClickFix at 47% of initial-access cases seen by Defender Experts (search summary, via RH-ISAC) — [RH-ISAC](https://rhisac.org/?p=17828)
- ClickFix mechanics: the fake CAPTCHA tells the victim to press Win+R, Ctrl+V, Enter, running a payload the page placed on the clipboard; FileFix (reported June 2025) instead presents a "document shared" message (search summary) — [The Hacker News](https://thehackernews.com/2025/06/new-filefix-method-emerges-as-threat.html)
- AI site builders: Proofpoint has seen tens of thousands of Lovable URLs detected as threats each month in email data since February 2025; campaigns include ~10,000 emails impersonating Aave and ~3,500 UPS-themed emails in June 2025; Lovable URLs also appear in SMS (investment scams, bank credential phishing) (vendor-reported; search summary) — [Proofpoint](https://www.proofpoint.com/us/blog/threat-insight/cybercriminals-abuse-ai-website-creation-app-phishing); one outlet reports "hundreds of thousands" per month, which conflicts with Proofpoint's own wording — [ciso2ciso repost of Hackread](https://ciso2ciso.com/ai-website-builder-lovable-abused-for-phishing-and-malware-scams-sourcehackread-com)
- Attackers used natural-language prompts in v0.dev to generate replicas of Microsoft 365 and Okta sign-in pages (secondary summary of Okta research; no counts found) — [UpGuard](https://www.upguard.com/blog/the-vibe-coding-paradox)
- Darcula added GenAI to its toolkit in April 2025 (search summary) — [The Hacker News](https://thehackernews.com/2025/04/darcula-adds-genai-to-phishing-toolkit.html?hl=en)
- Device-code phishing: Microsoft reports Storm-2372 has run a device-code phishing campaign since August 2024 using fake Teams meeting invitations, later switching to the Microsoft Authentication Broker client ID; Microsoft assesses with moderate confidence it aligns with Russian interests; mitigations are blocking device-code flow where possible, Conditional Access, and `revokeSignInSessions` (search summary) — [Microsoft Security Blog](https://www.microsoft.com/en-us/security/blog/2025/02/13/storm-2372-conducts-device-code-phishing-campaign)
- EtherHiding: malicious code is stored in blockchain smart contracts; ClearFake adopted ClickFix lures in May 2024 and hosts payloads on BNB Smart Chain, with a May 2026 intrusion routing delivery through BSC testnet contracts per Trend Micro (search summary) — [CloudSEK](https://www.cloudsek.com/knowledge-base/clearfake), [Cyberpress](https://cyberpress.org/clearfake-abuses-blockchain-c2/)
- Vendors state EtherHiding has no single takedown point and no on-disk artifact to hash (vendor commentary; search summary) — [OPSWAT](https://www.opswat.com/blog/inside-a-live-clickfix-campaign-using-etherhiding-to-hide-its-next-move)
- Residential/geo/UA cloaking in practice: Lucid pages use IP blocking, user-agent filtering and single-use time-limited URLs (search summary) — [The Hacker News](https://thehackernews.com/2025/04/lucid-phaas-hits-169-targets-in-88.html?hl=en); Keitaro campaigns redirect conditionally on IP geolocation and OS/browser fingerprint (search summary) — [Infoblox](https://www.infoblox.com/blog/?p=13206)
- Client-side IP reputation checks were measured in 504 kit clusters (19,869 pages), most often calling api.ipify.org and ipapi.co — a page-content tell for cloaking — [arXiv 2509.13186](https://arxiv.org/html/2509.13186v1)
- Compromised legitimate sites as hosts: Sneaky 2FA is hosted primarily on compromised WordPress sites (search summary) — [Hackread](https://hackread.com/telegram-sneaky-2fa-phishing-kit-microsoft-365-accounts/)

### Inferences
- ClickFix/FileFix pages are detectable with deterministic content rules on the existing page capture: JS containing a clipboard write (`navigator.clipboard.writeText` or `document.execCommand('copy')` — API names are from background knowledge, not confirmed by a source this session) together with instruction text patterns ("Win+R"/"⊞ + R", "Ctrl+V", "press Enter", "Verify you are human") and command fragments in script strings (`powershell`, `mshta`, `curl … | `, `msiexec`). Because these lures are commonly injected into compromised legitimate sites, the alert target is the site owner/host rather than a registrar takedown.
- EtherHiding cannot be taken down, but the page-side loader is visible to a crawler: requests to public BSC/Ethereum RPC endpoints or `eth_call` JSON-RPC bodies from a non-crypto page are a rule over the captured request list (IOK `requests` field). (My reasoning; no source gave a contract-level detection method.)
- For AI-builder and trusted-platform hosting (`*.lovable.app`, `*.vercel.app`, `*.pages.dev`, `*.workers.dev`, `*.netlify.app`, `*.webflow.io`, `*.framer.app` etc. — the hostname list is background knowledge, not from a source this session), the unit of detection must be the full hostname, never the registrable domain; ASN/IP clustering is meaningless there (the platform's shared-infra ASN list already encodes this). Useful rules: credential/password field + brand keyword on a platform subdomain; builder generator tokens (the platform's Lane 3 already records these); and CT/NRD are blind, so discovery has to come from URL sources (abuse mailbox, urlscan search, customer referrer canaries).
- Device-code and OAuth-consent phishing have no attacker-hosted credential page (the victim types into the real Microsoft page), so web-content detection cannot see them; they are out of reach for a crawler-based platform and belong in customer guidance (block device-code flow, consent policies). The lure pages that display a device code could be matched by text rules, but I found no evidence on how often such a page exists.
- Cloaking by residential-proxy/geo/UA means a single datacenter fetch under-reports; the cheapest mitigation is treating "anti-bot wall observed" plus kit-family match as sufficient evidence, rather than buying proxies.

### Gaps
- Not researched to a citable level: abuse statistics for Cloudflare Pages/Workers/R2, Google AMP/Docs/Sites, Microsoft Dynamics/Forms, Canva, Notion, Glitch; QR/quishing; SVG and HTML-smuggling attachments; `blob:` URI phishing; browser-in-the-browser; deepfake executive impersonation; IPFS phishing; Telegram mini-apps; punycode/IDN in new TLDs.
- Okta's primary v0 report and any counts were not retrieved.
- No source confirmed the exact JS APIs ClickFix pages use, and no public rule set for ClickFix page detection was found this session (IOK may contain one; not checked).
- No contract-level or RPC-pattern detection method for EtherHiding was found in sources.

---

## 6. Standards and data-sharing formats worth adopting

### Takeaway
IOK is the one format with direct evidence of fit: it is purpose-built for phishing-page content, maps to data a headless capture already has, is Sigma-compatible, and ships an ODbL ruleset of 200+ rules. YARA is established for kit zip archives specifically. I found no evidence this session for or against STIX 2.1 patterning, MISP or ATT&CK mapping for this use case.

### Cited Findings
- IOK: Sigma-based, nine page-level fields, five modifiers, `level` + tags metadata, "over 200 rules" in the open core — [IOK rule reference](https://phish.report/docs/iok-rule-reference)
- IOK is ODbL-licensed and reusable with attribution to phish.report/IOK (search summary) — [github.com/phish-report/IOK](https://github.com/phish-report/IOK)
- IOK rules are tagged by target brand (e.g. tag pages `target.remitly`, `target.international_card_services`), i.e. the tag namespace already carries brand and kit/actor labels (search summary, from page titles) — [phish.report tag page](https://phish.report/IOK/tags/target.remitly)
- IOK rules convert to other query languages because of the Sigma base (search summary) — [IOK rule conversion blog](https://phish.report/blog/iok-rule-conversion)
- YARA for kits: PhishingKit-Yara-Rules matches directory and file names inside kit zip files via raw zip analysis; AGPL-3.0 (search summary) — [github.com/t4d/PhishingKit-Yara-Rules](https://github.com/t4d/PhishingKit-Yara-Rules)

### Inferences
- Adopt IOK as the internal rule format for page-content detection: a YAML/JSON rule with `field|modifier` lists and a boolean condition is small to evaluate in TypeScript, keeps rules as data (reviewable, versioned, importable from upstream), and yields rule-id + tag rows that SQL can aggregate for kit/actor attribution. ODbL requires attribution and share-alike for the database of rules; confirm obligations before redistributing derived rules to customers.
- AGPL-3.0 on PhishingKit-Yara-Rules matters for a SaaS: using the rules server-side inside a network service can trigger AGPL obligations; treat as reference material or isolate, pending a licence read. YARA is also only relevant if kit zips are actually collected, which the platform does not do today.
- STIX 2.1 / MISP are export formats rather than detection formats; for a small team they matter only when a customer or sharing community asks for a feed. ATT&CK mapping is a labelling exercise (e.g. T1566 phishing, T1583 acquire infrastructure) with no detection value of its own. (Background judgement; unverified this session.)

### Gaps
- STIX 2.1 patterning, MISP objects/galaxies for phishing kits, and ATT&CK mappings were not researched this session; no adoption or effectiveness evidence was gathered.
- Whether the upstream IOK repository is still actively maintained in 2026 (commit recency, rule growth) was not checked.
- Exact ODbL obligations for commercial use of IOK rules were not reviewed.
