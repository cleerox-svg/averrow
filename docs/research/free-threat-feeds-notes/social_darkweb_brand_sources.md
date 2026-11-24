# Free social, dark-web, credential-leak, mobile-app, ad and brand-impersonation signal sources (state as of 2026-11-13)

Reading notes for the report writer:

- Verification labels used below: **[fetched]** = I read the primary page this session; **[search]** = from search-result summaries this session (third-party or snippet, not the primary page); anything I could not check this session is in *Gaps*, explicitly marked "prior knowledge, unverified" — treat those as leads, not facts.
- "Worker fit" = how hard it is to consume from a fetch-only serverless worker on an hourly cron (no long-lived sockets, no headless browser, ~100 binds, limited wall time).
- Already integrated and therefore excluded: Reddit search, GitHub search API, Telegram public channel monitoring, Mastodon, iTunes search, psbdmp, TweetFeed, name→handle checks, app-store impersonation scoring. HIBP stealer-log API excluded as paid.

---

## 1. Social streams (Bluesky, Threads, X, YouTube, TikTok, Discord, Telegram, others)

### Takeaway
The only big social stream that is genuinely free, public and commercially usable in late 2026 is Bluesky's Jetstream (no auth, but a WebSocket with client-side filtering only); Bluesky's keyword search endpoint is unreliable without auth (403s reported again in Aug 2026), so plan on an app-password session. X has no free tier for new developers, Threads keyword search needs Meta App Review, TikTok's research/ad APIs exclude commercial users, and YouTube gives roughly 100 keyword searches a day for free.

### Cited Findings
**Bluesky / AT Protocol**
- Jetstream (JSON firehose) needs no key for the live stream; it has no server-side keyword or language filter, so keyword matching is client-side. Retention/replay window is disputed across sources (≈72 h vs ≈36 h), and one vendor says replay of older data is keyed/metered [search] — [Bright Data: best Bluesky scrapers 2026](https://brightdata.com/blog/web-data/best-bluesky-scrapers); [Skyline README](https://forge.blacksky.community/natespilman.com/skyline/raw/main/README.md)
- `app.bsky.feed.searchPosts` on `public.api.bsky.app` returned 403 without auth from Feb 2025; a contributor said the AppView returns 403 "deliberately" to reduce load; it recovered in Mar 2025; third-party projects added fallbacks to `api.bsky.app` in Jan and Jul 2026; on 2026-08-18 a user reported both `public.api.bsky.app` and `api.bsky.app` returning 403 again. The issue is still open and the docs repo was archived (read-only) on 2026-08-18 [fetched] — [bsky-docs issue #332](https://github.com/bluesky-social/bsky-docs/issues/332)
- The official endpoint reference is still published; Bluesky's docs say unauthenticated public endpoints can be called against the public AppView, but the searchPosts page does not settle whether auth is required [search] — [docs.bsky.app searchPosts](https://docs.bsky.app/docs/api/app-bsky-feed-search-posts)
- Several 2026 scraper tools state post search needs a Bluesky app password because the endpoint "can require authentication" [search] — [Apify bluesky-posts actor](https://apify.com/danielainsworth/bluesky-posts.md)

**X / Twitter**
- X made pay-per-use the default on 2026-02-06 and no longer offers a free tier to new signups; free access is limited to case-by-case "public utility" apps. Reads ≈ $0.005 per post returned (a 100-result search ≈ $0.50), recent search only (7-day window), 2M post reads/month cap, full-archive is Enterprise (from ~$42K/month). These figures are from third-party blogs, not docs.x.com [search] — [opentweet: is the X API free in 2026](https://opentweet.io/answers/is-the-x-api-free-in-2026); [socialcrawl: X API 2026](https://www.socialcrawl.dev/blog/x-twitter-api-2026); [wearefounders: X API pricing 2026](https://www.wearefounders.uk/the-x-api-price-hike-a-blow-to-indie-hackers/)
- One source says the $200 legacy Basic tier was force-migrated to pay-per-use on 2026-06-01; not corroborated by a second source [search] — [opentweet migration guide](https://opentweet.io/how-to/migrate-x-api-basic-to-pay-per-use)

**Threads**
- Keyword search requires the `threads_keyword_search` permission; without Meta approval the search covers only the authenticated user's own posts, after approval public posts are searchable [search of Meta docs] — [Meta Threads keyword search docs](https://developers.facebook.com/documentation/threads/keyword-search)
- Rate limit is reported inconsistently: 2,200 queries per user per 24 h in one guide, 500/week in another; neither confirmed on Meta's page [search] — [upload-post Threads API guide](https://www.upload-post.com/threads-api/); [socialcrawl Threads keyword search](https://www.socialcrawl.dev/blog/threads-keyword-search)
- Meta's Threads changelog mentions a tokenless oEmbed API for public posts (no token, no App Review) [search] — [Threads changelog](https://developers.facebook.com/documentation/threads/changelog)

**YouTube Data API v3**
- Google's quota calculator page, as read this session: default 10,000 units/day; `search.list` now has its own separate bucket of 100 calls/day (1 unit each) outside the 10,000-unit pool; `videos.list` and `channels.list` cost 1 unit; each `liveBroadcasts` method costs 1 unit [fetched] — [YouTube quota calculator](https://developers.google.com/youtube/v3/determine_quota_cost)
- Third-party 2026 guides still describe `search.list` as 100 units out of 10,000; one says this changed on 2026-06-01. Either way the practical ceiling is ~100 keyword searches/day per project, and each extra results page is charged again [search] — [outlierkit YouTube search API guide](https://outlierkit.com/resources/youtube-search-api/); [Google quota calculator](https://developers.google.com/youtube/v3/determine_quota_cost)

**TikTok**
- Research API: applicants must be in an eligible region and affiliated with an eligible organisation (non-profit academic institutions in US/EEA/UK/Switzerland, or independent researchers); TikTok's FAQ says creators, advertisers and commercial users are not eligible [search of TikTok developer pages] — [TikTok Research API](https://developers.tiktok.com/products/research-api); [About Research API](https://developers.tiktok.com/doc/about-research-api/)
- A non-university non-profit research institute reported being refused because of TikTok's narrow reading of "academic" [search] — [KInIT: When Research APIs Close the Door](https://kinit.sk/when-research-apis-close-the-door-when-you-finally-get-it-it-is-not-what-you-have-asked-for/)

**Discord**
- `GET /invites/{code}` accepts `with_counts` and returns `approximate_member_count` / `approximate_presence_count`; third-party connector docs show it called without an auth header (not confirmed against Discord's official page this session) [search] — [Discord invite resource docs](https://docs.discord.com/developers/resources/invite.md); [discord-api-types APIInvite](https://discord-api-types.dev/api/discord-api-types-v9/interface/APIInvite)

**Telegram (beyond the existing integration)**
- Public channels expose a login-free web preview at `t.me/s/{channel}`; comments and reaction counts are not exposed there; private channels are unreachable [search, scraper vendors] — [dev.to: scrape public Telegram channels without the API](https://dev.to/perufitlife/how-to-scrape-public-telegram-channels-without-the-api-login-or-mtproto-4438)
- A third-party terms tracker says Telegram's terms now prohibit data scraping ("Content Licensing and AI Scraping Terms"); I did not read Telegram's own text [search] — [Conduct Atlas: Telegram ToS](https://conductatlas.com/platform/telegram/telegram-terms-of-service/)
- TGStat: Bellingcat lists Free / Personal / Corporate tiers; a Russian help page says the API is available on paid plans only [search] — [Bellingcat toolkit: TGStat](https://bellingcat.gitbook.io/toolkit/more/all-tools/tgstat)

### Inferences
- **Bluesky is the one new social source worth building.** Two worker-compatible designs: (a) authenticated `searchPosts` per brand keyword each hour using an app-password session (simple, fetch-only; treat 403 as "skipped", not failure); (b) a Jetstream consumer, which needs a long-lived WebSocket — on Cloudflare that means a Durable Object or a short "connect, replay from cursor, drain for N seconds, disconnect" cron pattern. (b) only works if the replay window is at least one cron interval; both reported windows (36 h / 72 h) are far longer than an hour, but the replay-requires-key claim needs testing.
- **X is off the table as a free source.** At ~$0.005/post, monitoring ~1,900 brands hourly would cost real money; TweetFeed (already integrated) remains the only free X-derived signal.
- **YouTube is usable but must be rationed:** ~100 searches/day means roughly 4 per hour — enough for customer-tier brands plus a rotating slice of the monitored catalogue (e.g. `q="<brand> giveaway"`, `type=video`, `eventType=live`), with cheap `videos.list`/`channels.list` follow-ups from the 10,000-unit pool.
- **Threads is "free but gated":** no cost, but a multi-week Meta App Review and a business-verified app. Reasonable to queue as a later item; do not plan on it for an hourly cron until approved.
- **TikTok is closed to a commercial platform** by its own eligibility rules; any TikTok coverage would be unofficial scraping, which is ToS-prohibited.
- **Discord invite lookup is a cheap enrichment, not a discovery feed:** it tells you the guild name, icon and member count behind an invite code you already found elsewhere (in phishing pages, Telegram posts, lookalike sites) — useful for fake "official support server" detection.

### Gaps
- Prior knowledge, unverified this session (leads only): Hacker News Algolia search API (`hn.algolia.com/api/v1/search`, no key); Stack Exchange API (keyless low quota, higher with free key); Lemmy instance search APIs (`/api/v3/search`, per-instance); Nostr relays (WebSocket, no auth, NIP-50 search on some relays). I believe all are free and commercially usable but did not re-check terms, quotas or liveness in Nov 2026.
- LinkedIn: I found no free API for profile or post search this session and know of none; fake-profile detection there remains scraping, which LinkedIn's terms prohibit. Not verified against 2026 terms.
- Telemetr: not researched.
- I could not confirm from an official Bluesky statement whether unauthenticated `searchPosts` is now permanently blocked, nor the exact Jetstream replay window or whether replay needs a key.
- Official docs.x.com pricing was not read directly; per-unit prices come from vendor blogs.
- Whether Discord `GET /invites/{code}` and guild preview/widget endpoints work unauthenticated in 2026, and their rate limits, was not confirmed on Discord's own page.

---

## 2. Ad libraries (malvertising and fake brand ads)

### Takeaway
There are free, keyless-or-self-serve ad repositories, but they are almost entirely EU/EEA(+UK)-scoped because they exist for DSA compliance: Microsoft's Ad Library API is public and unauthenticated, Meta's Ad Library API returns commercial ads only where they reached the EU/UK, and Google has no official Transparency Center API (only an EEA/Turkey BigQuery dataset). TikTok's Commercial Content API is researcher-only.

### Cited Findings
**Microsoft / Bing Ad Library API**
- Base URI `https://adlibrary.api.bingads.microsoft.com/api/v1/`; templates `Advertisers?searchText=&top=&skip=`, `Advertisers/{id}`, `Ads?searchText=&advertiserId=&startDate=&endDate=&countryCodes=&top=&skip=`, `Ads/{id}?expand=AdDetails(expand=ImpressionsByCountry,Targets)` [fetched] — [Microsoft Learn: Ad Library API](https://learn.microsoft.com/en-us/advertising/guides/ad-library-api)
- "The Ad Library API is publicly available and doesn't require any user sign-up or log-in"; unauthenticated requests face stricter (unpublished) limits on call frequency and entities per call; higher limits need a Microsoft Advertising account + developer token (headers `DeveloperToken`, `AuthenticationToken`) [fetched] — [Microsoft Learn: Ad Library API](https://learn.microsoft.com/en-us/advertising/guides/ad-library-api)
- Coverage: only ads served in the EEA, recorded since June 2023; 1–3 day delay; fields include `Title`, `Description`, `DisplayUrl`, `DestinationUrl`, `AdvertiserName`, `IsVerified`, `PaidForByName`, `RestrictionReason` [fetched] — [Microsoft Learn: Ad Library API](https://learn.microsoft.com/en-us/advertising/guides/ad-library-api)

**Meta Ad Library API**
- Coverage: political/issue ads worldwide (≈7 years), plus all ads delivered to the EU or UK (≈1 year); outside EU/UK the API returns only political/issue ads even with `ad_type=ALL`. One third-party page contradicts this (claims commercial ads for any country) while the same site's Nov 2026 page agrees with the EU/UK-only reading [search] — [adlibrary.com: EU DSA ad repositories](https://adlibrary.com/posts/eu-dsa-ad-repositories-developers); [shortsintel Meta Ad Library API guide](https://www.shortsintel.com/guides/meta-ad-library-api)
- UK coverage applies to ads that ran after 2025-07-01 [search] — [adlibrary.com: EU DSA ad repositories](https://adlibrary.com/posts/eu-dsa-ad-repositories-developers)
- Access: Meta developer account, identity confirmation, an app, and a token with `ads_read`; each query needs a search term or page ID plus `ad_reached_countries` [search] — [gethookd: Meta Ad Library API token guide](https://www.gethookd.ai/learn/how-to-use-meta-ad-library-api-access-token-generation-documentation/); [admanage: Facebook Ads Library API](https://admanage.ai/blog/facebook-ads-library-api)
- Meta stopped political, electoral and social-issue ads in the EU from early October 2025 (TTPA) — relevant only in that EU political volume drops; commercial EU ads remain archived [search] — [Meta newsroom](https://about.fb.com/news/2025/07/ending-political-electoral-and-social-issue-advertising-in-the-eu/)

**Google Ads Transparency Center**
- No official API or bulk export for the Transparency Center site; third-party tools read the site's internal RPC endpoint or sell it as an API (SerpApi `google_ads_transparency_center`) [search] — [SerpApi Google Ads Transparency Center API](https://serpapi.com/google-ads-transparency-center-api)
- BigQuery public dataset `bigquery-public-data.google_ads_transparency_center` (tables `creative_stats`, `removed_creative_stats`); a Google Cloud community answer says coverage is the EEA/Turkey while the website is global, and tables can lag the site [search] — [Google Cloud Community thread](https://www.googlecloudcommunity.com/gc/Data-Analytics/Querying-public-google-ads-transparency-center-table-doesn-t/m-p/856073)

**TikTok Commercial Content API**
- Requires an application/approval; covers ads shown in the EU/EEA, UK, Switzerland and Turkey; a third-party source says eligibility is limited to academic/non-profit researchers in US/EEA/UK/CH [search] — [TikTok Commercial Content API](https://developers.tiktok.com/products/commercial-content-api); [dev.to honest guide to the TikTok ad library API](https://dev.to/odeeb/the-tiktok-ad-library-api-a-developers-honest-guide-to-the-dsa-commercial-content-library-5446)

### Inferences
- **Best immediate win: Microsoft Ad Library API.** Keyless GET returning JSON with `DestinationUrl` and advertiser verification status; query `Ads?searchText=<brand>` and flag ads whose destination host is not in the brand's trusted domain set. Search-ad malvertising (fake support numbers, fake download pages) is exactly what Bing ads are abused for. Limits are unpublished, so budget conservatively (a few brands per tick, rotate) and register a free dev token if 429s appear. Blunt limitation: EEA impressions only — a US-only malvertising campaign will not appear.
- **Meta Ad Library API is the highest-value ad source for scam/impersonation ads** (fake giveaways, deepfake exec investment ads, fake shops), free, with a documented commercial-ad search for EU/UK-delivered ads. It needs a long-lived token tied to an identity-verified person, which is an operational dependency (token expiry, one staff identity) rather than a cost.
- **Google is the gap.** The BigQuery dataset is free within BigQuery's free query tier, is EEA/Turkey-only, lacks a keyword search designed for brand terms, and needs GCP auth (service-account JWT signing in the worker). Scraping the Transparency Center RPC is ToS-risky and brittle. I would not build on it first.
- All three official ad repositories exist because of the DSA, so a brand with no EU/UK audience gets little from them.

### Gaps
- I did not read Meta's Graph API `ads_archive` reference directly; rate limits and whether `ad_type=ALL` with non-EU countries returns commercial ads should be tested with a real token.
- Schema, update cadence and licence terms of the Google BigQuery dataset were not read from Google's own documentation.
- LinkedIn, Snapchat, Pinterest, Apple and Amazon DSA ad repositories: not researched.
- I found no free source for deepfake-video scam ads specifically; the Meta Ad Library (creative text/page name search) is the closest proxy.

---

## 3. Dark web, ransomware leak sites, breach and stealer-log indicators

### Takeaway
RansomLook is the cleanest free ransomware-leak-site source for a commercial platform (CC BY 4.0, explicitly "even commercially"); ransomware.live has a better API but its terms prohibit commercial use and redistribution without written approval. On credentials, the genuinely free parts are HIBP's unauthenticated breach catalogue and Pwned Passwords; everything that tells you *which of a brand's accounts* are compromised is either paid (HIBP domain/stealer endpoints) or free with unknown terms (Hudson Rock's OSINT endpoints, LeakCheck public API).

### Cited Findings
**ransomware.live**
- v1 deprecated; v2 free, no key, limited to 1 request/minute per endpoint, "personal use only", victim data delayed vs PRO; PRO at `api-pro.ransomware.live` is "free (for ever)" with an API key from `my.ransomware.live`, fair use, 500,000 calls/month; a different snapshot lists 3,000 calls/day [fetched + search] — [ransomware.live API page](https://www.ransomware.live/api)
- Terms §5.2: "Commercial use of the Data is strictly prohibited without prior written approval" — explicitly including incorporation into commercial products, paid consultancy, commercial redistribution and monetising derived insights. §4: no redistribution of the data "as if via an API", no publishing raw data, do not relay customer queries. §6: must name and link Ransomware.live as source [fetched] — [ransomware.live Terms & Conditions](https://www.ransomware.live/t&c)

**RansomLook**
- All content including API responses and datasets is CC BY 4.0 — share and adapt "for any purpose, even commercially" with credit; Swagger docs at `/doc/` on the public instance ransomlook.io; no rate limit stated; posts are unverified operator claims [fetched] — [RansomLook About](https://www.ransomlook.io/about)
- Third-party integrations say the API needs no key [search] — [Synapse RansomLook power-up guide](https://synapse.docs.vertex.link/projects/rapid-powerups/en/latest/storm-packages/synapse-ransomlook/userguide.html)
- RansomLook is based on ransomwatch, which is now archived [search] — [it-connect: RansomLook](https://www.it-connect.tech/ransomlook-the-open-source-aggregator-for-tracking-ransomware-activity/)

**Have I Been Pwned (free parts only)**
- No plan badge / unauthenticated: `/breaches`, `/breach/{name}`, `/latestBreach`, `/dataClasses`. Pwned Passwords range API `https://api.pwnedpasswords.com/range/{first5SHA1}` is free, no key, no rate limit, no attribution required [fetched] — [HIBP API v3](https://haveibeenpwned.com/API/v3)
- Paid key required: `/breachedAccount`, `/pasteAccount`, `/breachedDomain/{domain}`, `/subscribedDomains`, all `/stealerLogs*` (Pro or higher). The docs do not say small domains are free [fetched] — [HIBP API v3](https://haveibeenpwned.com/API/v3)
- Breach and paste API data is CC BY 4.0 with visible attribution and link; every request needs an honest `User-Agent` or gets 403 [fetched] — [HIBP API v3](https://haveibeenpwned.com/API/v3)

**Hudson Rock (Cavalier)**
- Enterprise Cavalier API uses API keys; endpoints include search by emails, usernames, domains, IP/CIDR, keyword, URLs-by-keyword [fetched] — [Hudson Rock docs index](https://docs.hudsonrock.com/llms.txt)
- A separate free "osint-tools" path exists and is used by open-source tools: `https://cavalier.hudsonrock.com/api/json/v2/osint-tools/search-by-email` and `.../osint-tools/search-by-domain?domain=<domain>` [search] — [h8mail issue referencing the free endpoint](https://www.github.com/khast3x/h8mail/issues/171); [Hudson Rock domain search docs](https://docs.hudsonrock.com/docs/domain-search)
- I found no published terms of use, rate limit or commercial-use statement for the free endpoints [search] — [hudsonrock.com llms.txt](https://www.hudsonrock.com/llms.txt)

**LeakCheck**
- Public API needs no authentication and gives limited results for email/username queries; base URL reported as `https://leakcheck.io/api/public?check=<email>` (official wrapper) and `leakcheck.net/api/public` (directory) [search] — [LeakCheck official API wrapper](https://github.com/LeakCheck/leakcheck-api); [freepublicapis listing](https://freepublicapis.com/check-e-mail-or-username-for-a-data-breach)

### Inferences
- **Build on RansomLook, not ransomware.live.** Averrow is a commercial product, so ransomware.live's §5.2 is a hard stop unless the owner obtains written approval; RansomLook gives the same class of signal (victim name posted on a leak site, group, date) under a licence that needs only attribution. Signal for the platform: match posted victim names/domains against the brand catalogue and against customers' suppliers.
- **HIBP free endpoints are a breach-catalogue feed, not a credential feed.** Polling `/latestBreach` or `/breaches` hourly (one keyless GET) and matching `Domain`/`Name` to monitored brands yields "brand X appeared in a new breach" events — cheap, licensed, attribution required. It does not reveal affected accounts.
- **Hudson Rock's free endpoints are technically the best free stealer-log indicator** (counts of compromised employees/users per domain, without exposing credentials), but with no published terms, using them inside a paid product is a legal unknown. Ask Hudson Rock in writing before integrating; do not treat "no key required" as a commercial licence.
- **Stealer logs and combolists — legal/ethical position:** collecting raw logs from Telegram channels or forums means acquiring stolen personal data and live credentials. That raises GDPR/PIPEDA lawful-basis and data-minimisation problems, possible offences around handling stolen credentials in some jurisdictions, and a duty-of-care problem if the store is breached. The defensible design is to consume *derived indicators* (counts per domain, breach names, k-anonymity hashes) from a provider who carries that risk, and never to store plaintext credentials.

### Gaps
- Prior knowledge, unverified this session (leads only): DeepDarkCTI (GitHub lists of forum/market/Telegram/ransomware site addresses — an index, not content); Ahmia (onion search engine with a clearnet front end; no documented stable API that I could confirm); Intelligence X free tier (small daily search/selector quota, non-commercial flavour); Leak-Lookup (free key with limited public results); BreachDirectory (via RapidAPI freemium); DeHashed (paid). I did not re-check any of these in Nov 2026.
- ransomwatch's exact archive date and whether its JSON (`posts.json`) is still served: not verified beyond the "archived" statement.
- psbdmp liveness and other paste sites with APIs: not researched this session (psbdmp is already integrated).
- LeakCheck public API's current quota, canonical domain and terms: not confirmed on LeakCheck's own docs.
- HIBP: whether any free domain-search allowance exists for verified small domains in 2026 was not stated on the API page; pricing page not read.

---

## 4. Source-code, secret-leak and malicious-package sources (brand-named packages, leaked secrets)

### Takeaway
Malicious-package data is the strongest "truly free, commercially usable" category found: OpenSSF malicious-packages (Apache-2.0, OSV format, `MAL-` IDs on osv.dev) and Datadog's malicious-software-packages-dataset (Apache-2.0, attribution welcomed). They let the platform detect npm/PyPI packages that typosquat or name-drop a brand.

### Cited Findings
- OpenSSF `ossf/malicious-packages`: reports of malicious packages in open-source registries, stored in OSV format, consumable via the osv.dev API, osv-scanner and deps.dev; Apache-2.0; withdrawn (false-positive) reports are moved to `osv/withdrawn` [search] — [ossf/malicious-packages](https://redirect.github.com/ossf/malicious-packages); [pkg.go.dev listing (licence)](https://pkg.go.dev/github.com/ossf/malicious-packages)
- `MAL-` advisories appear on osv.dev with the OpenSSF repo's `osv/malicious` directory as import source (example MAL-2025-192406, npm) [search] — [osv.dev MAL-2025-192406](https://osv.dev/vulnerability/MAL-2025-192406)
- Sources feeding the OpenSSF repo include Checkmarx, GitHub's malware advisories export and the Package Analysis project [search] — [ossf/malicious-packages](https://redirect.github.com/ossf/malicious-packages); [GitHub blog: malware advisories beyond npm](https://github.blog/security/supply-chain-security/how-we-took-malware-advisories-beyond-npm/)
- Datadog `malicious-software-packages-dataset`: Apache-2.0, "you're welcome to use it with attribution", PyPI and npm, mostly found by GuardDog; a cached page showed 1,484 packages (count may be stale); bundled package samples keep their original licences [search] — [DataDog/malicious-software-packages-dataset](https://redirect.github.com/DataDog/malicious-software-packages-dataset)

### Inferences
- **Worker fit is good.** Hourly: list new `MAL-` advisories (GitHub commits API on `osv/malicious/`, or the OSV bulk export per ecosystem), then run the existing lookalike/typosquat matcher over the *package name* against brand names and official package names. Emit a threat with type "malicious package" and the registry URL as evidence. No scraping, permissive licence, tiny payloads if consumed incrementally (the full repo is large — never clone it from a worker).
- This is actor evidence as well as brand evidence: the same publisher accounts and exfil hosts recur across packages, which fits the platform's infrastructure-clustering model.
- GitHub secret-leak monitoring beyond the existing code-search integration (events firehose, GH Archive on BigQuery, TruffleHog-style regex over new commits) is feasible but a poor fit for an hourly fetch-only worker: the public events API is a sampled, paginated window and GH Archive requires BigQuery auth and scan budget.

### Gaps
- Prior knowledge, unverified this session: OSV API endpoints (`api.osv.dev/v1/query`, GCS bulk zips per ecosystem); GitHub public events API (`/events`, 300-event window); GH Archive hourly JSON dumps at `data.gharchive.org` and the BigQuery dataset; Socket and Phylum free feeds (I believe both are product-gated, not open feeds — Phylum was acquired by Veracode in 2025); Docker Hub search API for brand-named images. None re-verified.
- Current size, update cadence and last-commit dates of both repositories were not checked on GitHub directly.

---

## 5. Mobile app stores and browser-extension stores

### Takeaway
Outside Apple's search API (already integrated) there is no official free search API for Google Play, the Chrome Web Store or Edge Add-ons — coverage there is unofficial scraping. Firefox AMO has a real public API, Koodous has a tiny free quota (15 searches/day), and AndroZoo is application-gated for research institutions.

### Cited Findings
- Chrome Web Store: the official API (V2 since Oct 2025, supports service accounts) is for publishing and managing your own items, not for searching the store; store search/metadata comes only from unofficial scrapers and npm packages that may break [search] — [Chrome Web Store API reference](https://developer.chrome.com/docs/webstore/api?hl=nl); [chrome-extension-meta npm](https://www.npmjs.com/package/chrome-extension-meta)
- Firefox AMO: public API at `/api/v5/` (stable; v4 frozen); described as needing no authentication for reads but rate-limited, with no published numeric limit; one developer reported an ~1 h block after ~20 rapid curl requests (anecdotal, may be WAF) [search] — [addons-server API overview](https://addons-server.readthedocs.io/topics/api/overview.html); [Mozilla Discourse: AMO API firewall](https://discourse.mozilla.org/t/complaining-about-amo-developer-api-firewall-being-too-sensitive)
- Koodous: free API tier at €0 with 15 APK searches/day and 4 APK detail requests/minute; overall cap 100 requests/minute; paid tiers include "Research" at €300/month (quota table partly garbled in the source) [search] — [Koodous usage limits](https://docs.koodous.com/quotas.html)
- AndroZoo: access by emailing androzoo@uni.lu with research institution and requester name; keys expire after 6 months; cap 500,000 APKs per 6 months; applicants must assess the legal implications of handling copyrighted apps. A secondary source describes it as non-commercial, non-redistributable, with faculty sponsor endorsement (unverified on the official page) [search] — [AndroZoo access conditions](https://androzoo.uni.lu/access)

### Inferences
- **AMO is the only extension store worth a first-class integration:** keyless JSON search (`/api/v5/addons/search/?q=<brand>`), returns author, homepage, user counts and permissions — enough for the same "official developer/handle" rule the app-store triage already uses. Keep it slow (a few requests per tick) given the WAF anecdote.
- **Chrome Web Store and Edge Add-ons impersonation monitoring means scraping HTML/internal endpoints** — technically possible from a worker, ToS-prohibited and brittle. If done, treat it as best-effort and never as a contractual coverage claim.
- **Koodous's 15 searches/day is too small** for catalogue-wide monitoring but is enough for an on-demand "check this suspicious APK hash/package name" enrichment from a threat detail page.
- **AndroZoo is not available to a commercial product** in practice (institution-based application, copyright caveats).

### Gaps
- Not researched or unanswered this session: Google Play scraping options and ToS specifics; Aptoide's web-services API; APKPure/APKMirror terms; Huawei AppGallery, Samsung Galaxy Store and Microsoft Store search endpoints; Edge Add-ons search. My combined search for these returned nothing relevant. Prior knowledge (unverified): Aptoide has long exposed a keyless JSON search (`ws75.aptoide.com/api/7/apps/search`), and Microsoft Store has an unofficial storefront search JSON; both need liveness and ToS checks.
- Browser-extension threat feeds (lists of known-malicious extension IDs): not researched.
- AMO's official numeric rate limits and terms for automated use were not found.

---

## 6. Scam/fraud reporting corpora, fake-shop lists, crypto scam lists and data-sharing schemes

### Takeaway
Government fraud data that is free and openly licensed (e.g. the Canadian Anti-Fraud Centre dataset) is aggregate statistics, not indicators — good for context and reporting, not detection. The indicator-bearing sources are either membership/partner-gated (Global Signal Exchange, Chainabuse premium) or open GitHub lists (PhishDestroy CC0, MetaMask's list, ScamSniffer's public database) whose licences need checking.

### Cited Findings
- Canadian Anti-Fraud Centre Fraud Reporting System dataset: published by the RCMP on the Open Government Portal under the Open Government Licence – Canada; CSV covering 2021-01-01 to 2025-03-31 plus a definitions PDF; launched July 2023 with a quarterly update commitment; page last modified 2025-04-01 in the results [search] — [open.canada.ca CAFC dataset](https://open.canada.ca/data/en/dataset/6a09c998-cddb-4a22-beff-4dca67ab892f); [RCMP announcement](https://rcmp.ca/en/news/2023/07/canadian-anti-fraud-centres-fraud-reporting-datasets-mark-first-rcmp-addition-open-government-portal)
- Global Signal Exchange: GASA's announcements describe a verified-partner model — organisations with their own abuse feeds are encouraged to contribute, and verified partners get access to fraud intelligence and a customised dashboard; no public pricing or open sign-up found [search] — [GASA: Kitboga joins Global Signal Exchange](https://www.gasa.org/post/internet-s-top-scambaiter-kitboga-joins-global-signal-exchange)
- Chainabuse API (run by TRM Labs): proprietary licence, Basic auth with a key generated from a logged-in profile; a rate limit starting "1000 re…" is mentioned for key holders (truncated); premium access is by partner request [search] — [TRM docs: Chainabuse API](https://docs.trmlabs.com/guides/chainabuse/welcome-to-chainabuse-api); [Chainabuse getting started](https://docs.trmlabs.com/guides/chainabuse/getting-started-2-1)
- ScamSniffer describes its free tier as the public scam database on GitHub for research and evaluation; its paid tiers include a daily-updated domain blacklist [search] — [scamsniffer.io](https://scamsniffer.io/)
- MetaMask `eth-phishing-detect` is a public list of malicious Web3 domains; aggregators report its licence inconsistently ("other" / flagged as a licence-policy violation), so the LICENSE file must be read before commercial use [search] — [MetaMask/eth-phishing-detect](https://github.com/MetaMask/eth-phishing-detect)
- PhishDestroy open dataset: claims 216,000+ phishing domains, CC0, daily updates, STIX 2.1 bundle download [search] — [PhishDestroy dataset](https://phishdestroy.io/dataset)
- Watchlist Internet (Austria) maintains public lists of fraudulent and problematic online shops; the data feeds the Fake-Shop Detector tool [search] — [fakeshop.at about](https://www.fakeshop.at/en/about-us/); [fakeshop.at shop ratings](https://fakeshop.at/en/shop-ratings/)
- A separate German fake-shop warning site publishes per-domain warning pages by month (`warnung.fakeshop-finder.de/2026_02/...`) [search] — [fakeshop-finder warning page example](https://warnung.fakeshop-finder.de//2026_02/groffa_shop.html)

### Inferences
- **PhishDestroy (CC0) and fake-shop lists are the worker-friendly picks** here: plain downloads, matchable against brand keywords with the existing lookalike matcher. Fake-shop lists carry a distinct signal (brand-named counterfeit/discount stores) that IOC phishing feeds mostly miss. PhishDestroy is, however, an IOC-style domain list, so it may overlap with feeds another researcher covers.
- **Global Signal Exchange is the strategic one, not a quick integration.** It is a contribute-to-receive clearing house; a platform that already ingests abuse-mailbox reports and takedown outcomes has something to contribute. Expect an application, vetting and a data-sharing agreement, not an API key.
- **Crypto lists (MetaMask, ScamSniffer public DB, Chainabuse) only matter for crypto/fintech brands** and for wallet-drainer infrastructure clustering. Chainabuse's proprietary licence and ScamSniffer's "research and evaluation" wording both argue against embedding them in a paid product without permission.
- Government corpora (CAFC and, by extension, FTC/IC3/Scamwatch aggregates) belong in marketing/briefing content and trend panels, not in the detection pipeline.

### Gaps
- Not found / not researched this session: FTC Consumer Sentinel downloads, IC3, Action Fraud, Scamwatch statistics, BBB Scam Tracker, Scamadviser, Trustpilot, Whoscall, ScamSearch.io, Trusted Shops, CryptoScamDB's status (its GitHub org still appears in results but I did not check activity), smishing corpora (smishtank), open phishing-email corpora (phishing_pot), APWG eCX terms, DNS Abuse Institute NetBeacon/Compass, Spamhaus/SURBL data-sharing programmes, Google Web Risk submission, and registrar/Cloudflare/Microsoft abuse-report APIs with verdict feedback. Prior knowledge (unverified): APWG eCX is membership-gated; phishing_pot is a GitHub repo of raw phishing emails collected from honeypot mailboxes; Smishtank is a public smishing-report site with an academic dataset; NetBeacon is a free abuse *reporting* channel rather than a feed.
- Whether Watchlist Internet offers a machine-readable download or API (vs HTML lists), and its reuse terms, was not confirmed.
- GSE's current signal volume, partner count, fees and API shape in 2026 were not found; the gasa.org GSE page returned 404 and the official globalsignalexchange.org site did not appear in results.
- Whether ScamSniffer's free GitHub database is deliberately delayed relative to the paid feed is unverified.

---

## 7. Search-engine based discovery (SEO poisoning, fake support numbers, lookalike sites)

### Takeaway
Free web-search APIs collapsed in 2025–2026: Bing Search API was retired on 2025-08-11, Brave removed its free tier in February 2026, and Google's Custom Search JSON API is closed to new customers and shuts down on 2027-01-01. What remains free is index-style data (Common Crawl, Wayback CDX, urlscan search), each heavily rate-limited.

### Cited Findings
- Bing Search API v7 was retired on 2025-08-11; existing instances decommissioned, new sign-ups closed; Microsoft points to "Grounding with Bing Search" in Azure AI Agents [search] — [Microsoft Learn: Bing Search API retirement](https://learn.microsoft.com/en-us/lifecycle/announcements/bing-search-api-retirement); [The Register](https://www.theregister.com/2025/05/15/bing_search_apis_retired/)
- Brave removed its free Search API tier in February 2026, replacing it with metered billing at $5 per 1,000 requests; paid plans reportedly include $5 monthly credit (~1,000 queries) conditional on attributing Brave; sources disagree on the old free allowance (2,000 vs 5,000/month) and one says there is no free plan at all [search] — [Implicator: Brave drops free Search API tier](https://www.implicator.ai/brave-drops-free-search-api-tier-puts-all-developers-on-metered-billing.md); [agentdeals: Brave Search API](https://agentdeals.dev/vendor/brave-search-api)
- Google Custom Search JSON API is closed to new customers and will be discontinued on 2027-01-01; Google's suggested replacement (Vertex AI Search) targets searching up to 50 domains, not the whole web [search] — [Brave: Google API shutdown explainer](https://brave.com/learn/google-api-shutdown/); [Apify: Google Custom Search API shutting down](https://blog.apify.com/google-custom-search-api-alternative/)
- Common Crawl: the CDX index server is strictly rate-limited and an IP can be temporarily blocked; Common Crawl points heavy users to the columnar index, which is not subject to the same limits [search] — [Common Crawl FAQ](https://commoncrawl.org/faq); [Common Crawl blog](https://commoncrawl.org/blog/you-can-now-build-directly-on-common-crawl-from-the-browser)
- urlscan.io: quotas are tracked per minute, hour and day per action, with separate limits for search and scans; a third-party tracker lists 1,000 searches/day on the free tier, other sites give conflicting scan numbers; `/api/v1/quotas` reports the authoritative values for a key [search] — [urlscan API rate limits](https://docs.urlscan.io/pages/api-rate-limits); [agentdeals: urlscan.io](https://agentdeals.dev/vendor/urlscan-io)
- Wayback CDX API: no official hard limit found; community sources cite ~15 requests/minute per IP before 429/503, and a Python client lowered its default to 24 requests/minute citing server limits [search] — [wayback client release history](https://wayback.readthedocs.io/en/latest/release-history.html); [cirosantilli: Wayback rate limit](https://cirosantilli.com/wayback-machine-rate-limit)
- PublicWWW publishes API quota documentation (source-code search for pages embedding a string, e.g. a hot-linked brand asset URL) [search] — [PublicWWW API limits](https://publicwww.com/docs/api/limits/)

### Inferences
- **There is no longer a free, official way to ask a general search engine "what ranks for `<brand> support phone number`".** Any SEO-poisoning detector must either pay (Brave at $5/1K is the cheapest official option: ~1,900 brands × 1 query/day ≈ $285/month) or use indirect signals.
- **Indirect, free signals that fit a worker:** (a) urlscan search pivots (`page.title:"<brand>" AND NOT page.domain:<official>`, or by favicon/asset hash) — a single keyed GET per brand, well within a ~1,000/day budget if rotated; (b) Wayback CDX to date a suspicious domain's first capture; (c) Common Crawl for retrospective host discovery only — its index lags by weeks, so it is a backfill tool, not an hourly feed.
- Hot-linked brand assets are also detectable without any third party: the brand's own CDN/access logs or a `Referer`-logging pixel show which foreign pages load official logos. That is a customer-integration feature, not a feed.
- The Google CSE shutdown on 2027-01-01 means anything built on an existing key has under two months of life; do not start work on it.

### Gaps
- Prior knowledge, unverified this session: Marginalia Search has a free API key programme (non-commercial flavour, small index); Mojeek's API is paid; SearXNG is self-hosted meta-search that itself scrapes engines (ToS risk shifts to the operator, and it needs a server, not a worker); NerdyData is paid. None re-checked.
- PublicWWW's free-tier limits (result truncation for non-paying users) were not read.
- urlscan's exact 2026 free search quota and its terms on commercial use of search results were not confirmed on urlscan's pricing page.

---

## 8. Executive impersonation and deepfake detection

### Takeaway
I found no free dataset or API that detects fake executive profiles on LinkedIn, WhatsApp or Telegram, and no free deepfake-ad feed. The usable free techniques are indirect: ad-library text/page-name search for executive names, Bluesky/Threads/YouTube keyword search on executive names, and Telegram/Discord public-preview lookups of handles found elsewhere.

### Cited Findings
- Meta's Ad Library API searches by term or page ID over all ads delivered to the EU/UK, which covers scam ads that name an executive or use a lookalike page name [search] — [adlibrary.com: EU DSA ad repositories](https://adlibrary.com/posts/eu-dsa-ad-repositories-developers)
- Microsoft's Ad Library API searches ad copy by keyword and returns the advertiser's verification status and destination URL, keyless [fetched] — [Microsoft Learn: Ad Library API](https://learn.microsoft.com/en-us/advertising/guides/ad-library-api)
- YouTube `search.list` supports roughly 100 free keyword searches per day per project, enough for a small executive-name watchlist (fake-giveaway livestreams typically pair an executive's name with "live"/"giveaway") [fetched] — [YouTube quota calculator](https://developers.google.com/youtube/v3/determine_quota_cost)
- Public Telegram channels can be previewed without login at `t.me/s/{channel}` [search] — [dev.to: scrape public Telegram channels](https://dev.to/perufitlife/how-to-scrape-public-telegram-channels-without-the-api-login-or-mtproto-4438)

### Inferences
- The platform's existing executive registry (`org_executives`, name→handle checks) can be extended at near-zero cost by adding executive names as search terms to the Meta and Microsoft ad-library queries and the YouTube live-search rotation. This targets the "deepfake CEO investment ad" and "fake giveaway livestream" patterns without any media-forensics capability.
- Actual deepfake *video* classification is out of scope for free sources: it needs paid inference or self-hosted models, and a text/metadata heuristic (executive name + investment/giveaway vocabulary + unverified advertiser + non-official destination domain) is the realistic free substitute.
- WhatsApp has no lookup surface at all; reports from the customer's own staff (abuse mailbox) remain the only signal.

### Gaps
- No reliable source found on free LinkedIn fake-profile detection; LinkedIn offers no public search API that I could identify, and scraping is contrary to its terms (not re-verified against 2026 terms).
- No free deepfake-scam-ad corpus or feed found. Vendor research reports on deepfake ads were not surveyed this session.

---

## 9. What launched or shut down in 2025–2026 that changes the landscape

### Takeaway
The trend is closure of free general-purpose access (search APIs, X) and growth of regulation-driven transparency repositories (DSA ad libraries, UK coverage in Meta's library) and of openly licensed community datasets (RansomLook CC BY, OpenSSF/Datadog Apache-2.0).

### Cited Findings
- Bing Search APIs retired 2025-08-11 — [Microsoft Learn](https://learn.microsoft.com/en-us/lifecycle/announcements/bing-search-api-retirement)
- Brave Search API free tier removed February 2026 — [Implicator](https://www.implicator.ai/brave-drops-free-search-api-tier-puts-all-developers-on-metered-billing.md)
- Google Custom Search JSON API closed to new customers; discontinuation 2027-01-01 — [Brave explainer](https://brave.com/learn/google-api-shutdown/)
- X moved to pay-per-use by default on 2026-02-06 with no free tier for new developers (third-party reporting) — [opentweet](https://opentweet.io/answers/is-the-x-api-free-in-2026)
- Bluesky's unauthenticated `searchPosts` reported blocked (403) again in August 2026; the bsky-docs repo was archived 2026-08-18 — [bsky-docs issue #332](https://github.com/bluesky-social/bsky-docs/issues/332)
- Meta ended political/issue ads in the EU from October 2025; Meta's ad library gained UK all-ads coverage for ads run after 2025-07-01 — [Meta newsroom](https://about.fb.com/news/2025/07/ending-political-electoral-and-social-issue-advertising-in-the-eu/); [adlibrary.com](https://adlibrary.com/posts/eu-dsa-ad-repositories-developers)
- Chrome Web Store API moved to V2 (service-account support) after October 2025 — still publishing-only — [Chrome Web Store API reference](https://developer.chrome.com/docs/webstore/api?hl=nl)
- ransomwatch is archived; RansomLook continues the lineage under CC BY 4.0 — [it-connect](https://www.it-connect.tech/ransomlook-the-open-source-aggregator-for-tracking-ransomware-activity/); [RansomLook About](https://www.ransomlook.io/about)
- ransomware.live deprecated its v1 API and now steers business users to a free keyed PRO API under terms that prohibit unapproved commercial use — [ransomware.live API](https://www.ransomware.live/api); [ransomware.live T&C](https://www.ransomware.live/t&c)
- YouTube's quota page now shows `search.list` in its own 100-calls/day bucket; one third-party guide dates a quota change to 2026-06-01 — [YouTube quota calculator](https://developers.google.com/youtube/v3/determine_quota_cost); [outlierkit](https://outlierkit.com/resources/youtube-search-api/)

### Inferences
- Shortlist by "free for commercial use + worker-friendly + new signal", in order: (1) RansomLook API; (2) OpenSSF/Datadog malicious-package data matched on brand names; (3) Microsoft Ad Library API; (4) Bluesky authenticated `searchPosts` (Jetstream later); (5) Meta Ad Library API; (6) Firefox AMO search; (7) HIBP `/latestBreach` + `/breaches`; (8) YouTube live/giveaway search for customer-tier brands and executives; (9) fake-shop lists / PhishDestroy.
- Needs a written permission or membership before use: ransomware.live (commercial approval), Hudson Rock free endpoints (terms unknown), Global Signal Exchange (partner vetting), Chainabuse (proprietary), ScamSniffer public DB (research/evaluation wording), Threads keyword search (App Review).
- Do not build: X API (paid), TikTok Research/Commercial Content APIs (commercial users excluded), Google CSE (dies 2027-01-01), AndroZoo (research institutions), raw stealer-log/combolist collection (legal exposure).

### Gaps
- I exceeded the suggested call budget and still could not cover every named source; sections 5, 6 and 7 have the most unverified items (listed in their Gaps). A follow-up pass should test live endpoints with real requests (Bluesky search with and without auth, Jetstream replay, Microsoft Ad Library unauthenticated limits, RansomLook `/api/recent`, AMO search, Hudson Rock osint-tools) because several key facts here rest on third-party descriptions rather than on a successful call.
