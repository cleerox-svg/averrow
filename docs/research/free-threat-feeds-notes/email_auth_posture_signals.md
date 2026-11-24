# Email-authentication and DNS/web posture-derived signals (state as of 2026-11-13)

Reading notes for the report writer:
- "Verified" = confirmed in a page fetched or a search result read in this session. Anything from the researcher's prior knowledge only is placed under **Gaps** or **Inferences** and labelled UNVERIFIED.
- RFC citations (rfc-editor.org links) point to the standard that defines the mechanism; the RFC text was not re-fetched this session, the section references are from prior knowledge of the standards.
- Several adoption statistics come from vendor reports with different samples; they are not comparable with each other.

## 1. Cloudflare Radar email endpoints and other Radar datasets (endpoints, license, limits)

### Takeaway
The Radar email API is live and free with an API token, with a generic `summary/{dimension}` / `timeseries_groups/{dimension}` shape plus top-TLD endpoints, but all Radar API data is licensed CC BY-NC 4.0 (non-commercial). Showing it inside a paid SaaS product is commercial use the licence does not grant, so it needs Cloudflare's permission or must stay internal-only context; this also applies to the bot/L7 data the platform already pulls.

### Cited Findings
- Email **security** endpoints listed in the current API reference: `GET /radar/email/security/summary/{dimension}`, `GET /radar/email/security/timeseries_groups/{dimension}`, `GET /radar/email/security/top/tlds`, `GET /radar/email/security/top/tlds/malicious/{malicious}`, `GET /radar/email/security/top/tlds/spam/{spam}`, `GET /radar/email/security/top/tlds/spoof/{spoof}` — [Cloudflare API reference, Radar email security](https://developers.cloudflare.com/api/resources/radar/subresources/email/subresources/security/)
- Email **routing** endpoints: `GET /radar/email/routing/summary/{dimension}` and `GET /radar/email/routing/timeseries_groups/{dimension}`. The older per-metric routing paths `summary/arc`, `summary/dkim`, `summary/dmarc`, `summary/encrypted`, `summary/ip_version`, `summary/spf` are marked **deprecated** in favour of the `{dimension}` form — [Cloudflare API reference, Radar email](https://developers.cloudflare.com/api/resources/radar/subresources/email/)
- Licence, verbatim from Cloudflare's Radar docs: "Data available via Radar API endpoints is made available under the CC BY-NC 4.0 license." and "Radar's API is free, allowing academics, technology professionals, and other web enthusiasts to investigate Internet usage across the globe." — [Cloudflare Radar docs index](https://developers.cloudflare.com/radar/index.md)
- A search summary of Radar's "about" pages reports that embedded charts and downloadable images are under CC BY 4.0 (more permissive than the API data) — [radar.cloudflare.com/about](https://radar.cloudflare.com/about) (the page itself returned HTTP 403 to the fetch tool; statement taken from search-result summary only, treat as partially verified)
- Radar documentation sections that exist as of this session: Application layer attacks, BGP anomalies (hijack and route-leak detection), DNS (aggregated 1.1.1.1 resolver data), Domains ranking (top-100 lists and bucket datasets), HTTP requests, NetFlows, Network layer attacks, Outages (Outage Center API), URL Scanner — [Cloudflare Radar docs llms.txt](https://developers.cloudflare.com/radar/llms.txt)
- No Radar-specific rate limit is documented on the Radar index page. A third-party summary cites Cloudflare's general REST API quota of 1,200 requests per 5 minutes per token; it is not confirmed to apply to Radar — [Radar docs index](https://developers.cloudflare.com/radar/index.md); [x-cmd third-party rate-limit summary](https://www.x-cmd.com/ratelimit/cloudflare/)

### Inferences
- CC BY-NC 4.0 in plain terms for a commercial SaaS: you may copy and adapt the data with attribution only for non-commercial purposes. Displaying Radar-derived numbers to paying customers, or using them as a product feature, is outside the licence. Options: (a) ask Cloudflare for written permission, (b) use the data only for internal analysis/calibration that never reaches a customer screen, (c) link out to or embed Radar's own charts (reported as CC BY 4.0, see above), (d) use it in non-commercial public content with attribution. This is a licence reading, not legal advice.
- Because every Radar API dataset carries the same licence, the same constraint already applies to the platform's existing bot-traffic and L7 attack pulls (`bot_traffic_snapshots`, `radar_country_snapshots`) if they are shown to tenants.
- Radar email-security data is global aggregate share data (not per-domain). Its value is as a benchmark/context series (e.g. global share of mail failing DMARC, top TLDs by malicious share) and as a TLD-risk weight for lookalike scoring, not as a per-brand sensor.
- "Top TLDs by malicious/spam/spoof share" is the one Radar email output that maps directly onto an existing platform decision: weighting newly registered lookalikes by TLD abuse rate.

### Gaps
- The allowed `{dimension}` values and filter parameters were not visible in the fetched portion of the API reference (page is ~490K characters; only the first 100K was read). UNVERIFIED from prior knowledge: security dimensions were historically `arc`, `dkim`, `dmarc`, `malicious`, `spam`, `spf`, `spoof`, `threat_category`, `tls_version`; routing dimensions `arc`, `dkim`, `dmarc`, `encrypted`, `ip_version`, `spf`; common filters `dateRange`/`dateStart`/`dateEnd`, `aggInterval`, `format`, and per-result filters (`arc`, `dkim`, `dmarc`, `spf`, `tlsVersion`). Confirm against the API reference before building.
- Not verified this session whether Radar exposes: domain categorization, AS112, certificate-transparency endpoints, internet quality, leaked-credentials stats, AI-bot stats, TLD abuse stats. They did not appear in the docs index fetched (which lists only the "Investigate" guide pages, not the full API tree). UNVERIFIED from prior knowledge: the API reference has `/radar/ranking/*`, `/radar/bgp/hijacks/events`, `/radar/bgp/leaks/events`, `/radar/as112/*`, `/radar/quality/*`, `/radar/ai/bots/*`, `/radar/leaked_credential_checks/*`, `/radar/ct/*`, `/radar/tlds/*`, `/radar/annotations/outages`.
- Source of the email-security data (UNVERIFIED: Cloudflare's own email security product, so it reflects that customer base, not global mail).
- No Radar-specific rate limit or attribution wording found.

## 2. DMARC aggregate (RUA) / forensic (RUF) reports as a first-party spoofing sensor; DMARCbis status

### Takeaway
DMARCbis was published in May 2026 as RFC 9989 (with 9990 and 9991), replacing RFC 7489: `pct`, `rf`, `ri` are deprecated, `np`, `psd`, `t` are added, and the Public Suffix List is replaced by a DNS tree walk. Hosting an RUA mailbox for customers is a standard, free, Worker-compatible way to get per-brand spoofing telemetry (sending IPs, volumes, auth results) that the platform does not currently have.

### Cited Findings
- "In May 2026, the IETF published RFC 9989, colloquially known as DMARCbis", moving it to Proposed Standard; the set of three documents (RFC 9989, 9990, 9991) replaces RFC 7489, and RFC 9989 also obsoletes RFC 9091 — [Red Sift, DMARC RFC 9989](https://redsift.com/blog/dmarc-rfc-9989); [Suped](https://www.suped.com/blog/dmarcbis-is-now-published-as-rfc-9989-9990-9991); [dmarcreport.com](https://dmarcreport.com/blog/dmarcbis-rfc-9989-9990-9991-replace-rfc-7489-official-update/)
- Record version tag stays `v=DMARC1`; no breaking changes for existing records — [Red Sift](https://redsift.com/blog/dmarc-rfc-9989)
- Deprecated tags: `pct`, `rf`, `ri`. New optional tags: `np` (policy for non-existent subdomains), `psd` (Public Suffix Domain flag), `t` (explicit test mode, replaces the `pct` use case) — [Red Sift](https://redsift.com/blog/dmarc-rfc-9989); [Warmy summary](https://www.warmy.io/blog/email-best-practices/dmarcbis-what-changed/)
- RFC 9989 replaces the Public Suffix List dependency with a DNS Tree Walk for policy discovery and Organizational Domain determination — [Red Sift](https://redsift.com/blog/dmarc-rfc-9989)
- Hosting RUA for another domain requires the receiving domain to publish an authorization record (external destination verification) at `<customer-domain>._report._dmarc.<vendor-domain>` TXT `v=DMARC1` — [RFC 7489 §7.1](https://www.rfc-editor.org/rfc/rfc7489#section-7.1) (mechanism defined in the standard; carried into the DMARCbis reporting documents — section numbering in RFC 9990 not checked)
- Aggregate report content defined by the standard: reporting org, date range, published policy, and per-row source IP, message count, disposition, SPF/DKIM results and identifiers (header-from, envelope-from, DKIM d= and selector) — [RFC 7489 Appendix C (XML schema)](https://www.rfc-editor.org/rfc/rfc7489#appendix-C)

### Inferences
- Attacker intelligence that falls out of RUA rows, per brand per day: (1) source IPs sending mail with the brand's exact header-from that fail both aligned SPF and DKIM — join to the existing ASN/hosting-provider tables and NEXUS clusters; (2) volume and geographic spread of direct-domain spoofing; (3) DKIM `d=` domains signing unaligned mail (third-party senders or attacker domains); (4) envelope-from domains, which can be lookalikes; (5) which receivers are seeing the abuse. This is exact-domain spoofing only — RUA never reports mail sent from lookalike domains, because those are different header-from domains.
- A wildcard authorization record (`*._report._dmarc.<vendor>` TXT `v=DMARC1`) lets a vendor accept reports for any customer domain without per-customer DNS; this is common vendor practice (UNVERIFIED this session).
- With `np` now standard, "brand publishes no `np`/`sp` and has p=reject only at the apex" becomes a checkable posture gap; and scanners must stop treating `pct` as meaningful and must implement the tree walk to find the governing record for subdomains.
- Feasibility on Workers: inbound Email Workers can receive the report mail; attachments are gzip or zip XML (zip needs a small unzip library; gzip is native via `DecompressionStream`). Reports are small. No AI needed. (Design inference; Email Worker message-size limit not checked this session.)

### Gaps
- RUF (failure/forensic) reports: UNVERIFIED from prior knowledge — the large mailbox providers (Google, Microsoft, Yahoo) do not send RUF, so it yields little; DMARCbis moved failure reporting to its own document (RFC 9991). No source fetched this session quantifying RUF availability.
- Open-source parsers: UNVERIFIED this session — `parsedmarc` (Python, domainaware/parsedmarc, Apache-2.0) and `dmarc-report-converter` (Go, tierpod) exist and are the usual references; both are server-side tools, so a Worker implementation would re-implement the XML parse rather than run them. Licences and current maintenance not checked.
- No measured figure found for what share of a brand's spoofed mail RUA actually reveals (only receivers that send reports are covered).
- Exact text of the `np`/`psd`/`t` definitions and tree-walk algorithm was taken from vendor summaries, not from RFC 9989 itself.

## 3. TLS-RPT, MTA-STS, DANE, DNSSEC, BIMI VMC/CMC in CT logs, ARC

### Takeaway
All of these are cheap DNS/HTTPS lookups a Worker can do, but evidence that they are useful *threat* signals is thin: no documented case of CMC/VMC abuse was found, so mark-certificate CT monitoring is a plausible but unproven brand-abuse sensor. Their firmer use is brand posture scoring and, for TLS-RPT, a second first-party report stream.

### Cited Findings
- TLS-RPT: a domain publishes `_smtp._tls.<domain>` TXT `v=TLSRPTv1; rua=mailto:...|https:...`; senders report daily JSON with success/failure counts and failure types (e.g. `starttls-not-supported`, `certificate-host-mismatch`, `validation-failure`, `sts-policy-invalid`) — [RFC 8460](https://www.rfc-editor.org/rfc/rfc8460)
- MTA-STS: `_mta-sts.<domain>` TXT `v=STSv1; id=...` plus policy at `https://mta-sts.<domain>/.well-known/mta-sts.txt` with `mode: enforce|testing|none`, `mx:`, `max_age:` — [RFC 8461](https://www.rfc-editor.org/rfc/rfc8461)
- DANE for SMTP uses TLSA records at `_25._tcp.<mx-host>` and requires DNSSEC — [RFC 7672](https://www.rfc-editor.org/rfc/rfc7672)
- ARC (Authenticated Received Chain) is an experimental header-based chain of custody for authentication results across forwarders — [RFC 8617](https://www.rfc-editor.org/rfc/rfc8617)
- Mark Verifying Authorities must publish pre-certificates to public CT logs before issuing VMCs; the BIMI Group FAQ says the same logging applies to CMCs — [BIMI Group MVA FAQs](https://bimigroup.org/mva-faqs/)
- A CMC requires no registered trademark, only documented prior use of the logo for 12 months (or limited modification of a registered mark) — [GoDaddy, how mark certificates are issued](https://www.godaddy.com/resources/news/how-godaddy-issues-mark-certificates-for-bimi); [PowerDMARC CMC guide](https://powerdmarc.com/ja/common-mark-certificate-bimi/)
- Mark certificates have a maximum validity of 398 days — [BIMI Group MVA FAQs](https://bimigroup.org/mva-faqs/)
- Monitoring CT logs for mark certificates to spot infringing logos is proposed in trademark-practice commentary, as an extension of existing TLS-certificate CT watching; it is a proposal, not a documented practice — [World Trademark Review](https://www.worldtrademarkreview.com/brand-management/everything-you-need-know-about-bimi-and-validated-mark-certificates-how-they-heighten-brand-trust-and-how-companies-have-adopted-them)
- PowerDMARC publishes a 2026 US report covering MTA-STS adoption alongside DMARC (figures for MTA-STS not captured in this session) — [PowerDMARC US DMARC & MTA-STS Adoption Report 2026](https://powerdmarc.com/united-states-dmarc-adoption-rates/)

### Inferences
- TLS-RPT hosting works like RUA hosting (a `mailto:` or `https:` endpoint the vendor runs). The `https:` rua form is directly receivable by a Worker with no email parsing. Signal: a spike in `starttls-not-supported` / certificate failures from many senders toward a customer's MX is consistent with a downgrade or interception attempt, but far more often it is an expired certificate or MX misconfiguration — treat as an operational alert, not attribution evidence.
- MTA-STS / DANE / DNSSEC on a **lookalike** domain: no evidence found either way; an attacker rarely configures them, so presence more likely indicates a legitimate (or defensively registered) domain. Useful only as a weak negative feature.
- BIMI on a lookalike: a `default._bimi.<lookalike>` TXT that references the brand's logo URL or an `a=` certificate is a strong intent signal if it ever appears, but no prevalence data was found.
- Mark-certificate CT watching would have very low volume (certs are expensive, validated, 398-day validity), so it is cheap to run but likely near-zero yield.

### Gaps
- No security-research report, incident write-up or CA revocation statistic on fraudulent VMC/CMC issuance was found (search explicitly returned none).
- Which CT logs carry mark certificates and whether crt.sh / the platform's existing CT feed indexes them was not verified. UNVERIFIED: mark certificates use dedicated logs (e.g. DigiCert "Gorgon"), separate from the WebPKI logs, so the existing `ct_logs` feed probably does not see them.
- No measured data on TLS-RPT as an attack detector (downgrade/MITM detections in the wild).
- MTA-STS, DANE and DNSSEC adoption figures were not collected.

## 4. Email-DNS signals on attacker / lookalike domains (MX, SPF includes, DKIM keys, tenant IDs, verification TXT pivots)

### Takeaway
MX presence on lookalikes is common (roughly 16%–48% in two non-academic 2026 scans) so by itself it is a weak signal; the academic evidence says mail-collection infrastructure is highly concentrated on a handful of mail servers, which makes "which MX" a better pivot than "has MX". No published source was found for tenant-ID or site-verification-TXT pivoting, so those are derivable-but-unproven techniques.

### Cited Findings
- Szurdi & Christin (IMC 2017), first in-depth measurement of email typosquatting: the authors registered 76 typosquatting domains and collected mail for over seven months (4 June 2016 – 15 January 2017); they found "millions of registered typosquatting domains have MX records pointing to only a handful of mail servers" — [Email Typosquatting, IMC '17 (CMU copy)](https://www.andrew.cmu.edu/user/nicolasc/publications/Szurdi-IMC17.pdf)
- Same work estimated 1,211 typosquatting domains receive in the vicinity of 800,000 emails per year; a honey-email experiment showed "only very limited evidence of emails being read" — [Szurdi PhD thesis](https://jszurdi.github.io/content/thesis/jszurdi-phd-thesis.pdf); [IMC '17 paper](https://jszurdi.github.io/content/academicpapers/emailtypo-imc17.pdf)
- WhoisFreaks 2026 census of lookalikes of the Tranco top-1,000 brands: 5,995,643 domains in registration records, of which 955,840 carry live MX records (about 16% — ratio computed by the researcher, and the denominator includes historical registrations) — [WhoisFreaks, Typosquatting and the Top 1,000 Brands: A 2026 Census](https://whoisfreaks.com/resources/case-study/typosquatting-and-the-top-1-000-brands-a-2026-census)
- Hard2bit vendor scan: 282 of 591 lookalike domains of 24 brands (48%) had MX records — [Hard2bit blog](https://hard2bit.com/en/blog/typosquatting-scan-24-brands-591-domains/) (vendor blog, small sample)
- A domain with no MX can still receive mail: per RFC 5321 the A record is tried when no MX exists — [SANS ISC diary](https://secure.dshield.org/diary/18363)
- Null MX (`MX 0 .`) is the standard way to declare a domain accepts no mail — [RFC 7505](https://www.rfc-editor.org/rfc/rfc7505)
- Attackers run purpose-built or free-trial Microsoft 365 tenants at scale: Abnormal analysed 2,000 unique messages across over 250 abused M365 tenants registered on `onmicrosoft.com` subdomains — [Abnormal AI](https://abnormal.ai/de/blog/system-notification-abuse-microsoft-phishing)
- The EchoSpoofing campaign used over 700 Microsoft 365 tenant accounts — [The Hacker News, citing Proofpoint](https://thehackernews.com/2024/07/proofpoint-email-routing-flaw-exploited.html)
- A phishing kit fetches a victim tenant's branding from Microsoft's CDN using the tenant ID — [Doppel](https://www.doppel.com/blog/invisible-by-design-phishing-kit)
- Attackers use legitimate `login.microsoftonline.com` links with an application ID pointing to an actor-controlled tenant — [Eye Security](https://labs.eye.security/microsoft-login-page-abused-as-phishing-redirector/)
- Threat actors distribute functions across multiple M365 tenants to obscure attribution — [Guardz](https://guardz.com/blog/sophisticated-phishing-campaign-exploiting-microsoft-365-infrastructure/)
- 73.5% of SPF-publishing domains use `include`, and 20% recursively include outlook.com (Tranco top 1M, BreakSPF authors' slides) — [SNU slides on BreakSPF](https://mmlab.snu.ac.kr/wp-content/uploads/2025/06/20240404_BreakSPF_sbsong-20250609-073305.pdf)

### Inferences
- Derivable signals, all DoH-only (TXT/MX/NS queries), ranked by likely value:
  1. **MX added to a previously MX-less monitored lookalike** (state change, not presence). Presence is too common (16–48%) to alert on; the change event on a domain already matched to a brand is the BEC-precursor candidate. No quantitative study of the change event was found.
  2. **MX target clustering**: group lookalikes by MX host / MX host's registered domain. IMC'17 shows concentration on a handful of servers; a small non-mainstream MX shared by many lookalikes of different brands is an operator pivot. Exclude parking/forwarding MX (registrar parking, e.g. large domain-parking mail hosts) and the big providers.
  3. **Mail-provider fingerprint** from MX + SPF `include:`: `*.mail.protection.outlook.com` (M365), `aspmx.l.google.com` (Workspace), `include:sendgrid.net`, `include:mailgun.org`, `include:amazonses.com`, `include:zoho.com` etc. Useful as a routing key for abuse reports (which provider to notify) more than as a threat score, because 20% of all SPF domains include outlook.com.
  4. **Site-verification TXT tokens** (`google-site-verification=`, `MS=ms…`, `facebook-domain-verification=`, `apple-domain-verification=`, `stripe-verification=`, `atlassian-domain-verification=`): a token is issued per account, so identical tokens on two domains suggest the same account. Unproven in published research (see Gaps); false positives where agencies/resellers verify many client domains.
  5. **M365 tenant ID** from `https://login.microsoftonline.com/<domain>/.well-known/openid-configuration` (issuer contains the tenant GUID): lookalikes sharing one tenant GUID belong to one tenant. Given 250–700+ throwaway tenants per campaign, the tenant is a short-lived pivot, but joins domains within a campaign.
  6. **DKIM public-key reuse**: only observable when a selector is known (from abuse-mailbox samples: `s=` and `d=` in `DKIM-Signature`), then `<selector>._domainkey.<domain>` TXT; hash the `p=` value and join across domains. Shared keys at ESPs (CNAME'd selectors) are the false-positive case — hash only keys published directly as TXT, or key on the CNAME target.
  7. `v=spf1 +all` or very broad `ip4:` ranges on a lookalike; wildcard MX / catch-all behaviour.
- Catch-all detection requires an SMTP RCPT probe, which is not possible from a Worker (no port 25); only DNS-level wildcard MX (`*.domain` MX answers for a random label) is checkable.

### Gaps
- No source found for pivoting on `google-site-verification` or other verification TXT tokens, or on `getuserrealm` / `openid-configuration` responses for clustering attacker domains (the search explicitly returned nothing). UNVERIFIED from prior knowledge: both Microsoft endpoints are public and unauthenticated; `getuserrealm.srf` returns namespace type (Managed/Federated) and federation brand name; these endpoints have no published quota and Microsoft may throttle bulk use.
- No quantitative evidence found that MX appearance on a newly registered lookalike predicts BEC (rate, lead time).
- No measured data on DKIM key reuse across malicious domains, on `+all` prevalence among malicious domains, or on SPF macro abuse.
- The exact percentage of typosquatting domains with MX in the IMC'17 paper was not extracted.

## 5. SPF/DKIM/DMARC weaknesses in brand posture beyond record presence, and benchmark statistics

### Takeaway
The best-evidenced new brand-posture checks are (a) dangling SPF `include:`/CNAME targets pointing at expired, re-registrable domains (SubdoMailing: ~8,000 domains, ~13,000 subdomains, ~5M emails/day) and (b) SPF records that authorise shared provider IP pools (BreakSPF: 23,916 vulnerable domains in the Tranco top 1M). For benchmarking, roughly half of large-sample domains publish DMARC but only about 9–36% are at p=reject depending on the sample.

### Cited Findings
**Attack evidence**
- SubdoMailing (Guardio Labs, Feb 2024): about 8,000–8,800 hijacked domains and about 13,000 subdomains used to send approximately five million emails per day; activity since at least September 2022 — [SecurityWeek](https://www.securityweek.com/domains-once-owned-by-major-firms-help-millions-of-spam-emails-bypass-security/); [Kaspersky](https://www.kaspersky.com/blog/domain-hijacking-subdomailing/51097/); [The Hacker News](https://thehackernews.com/2024/02/8000-subdomains-of-trusted-brands.html)
- SubdoMailing mechanism 1: subdomains of reputable brands with CNAME records pointing to expired external domains, which attackers re-registered. Mechanism 2: a known domain's SPF record still includes abandoned domains of defunct email/marketing services, which attackers claim — [Kaspersky](https://www.kaspersky.com/blog/domain-hijacking-subdomailing/51097/); [Red Sift guide](https://blog.redsift.com/cybersecurity/your-guide-to-the-subdomailing-campaign)
- EchoSpoofing (Guardio / Proofpoint, disclosed July 2024): Proofpoint's relay accepted mail from any Microsoft 365 tenant when a configuration option was enabled, and added the customer's legitimate DKIM signature, so spoofed mail passed SPF and DKIM; brands spoofed included Disney, Best Buy, ESPN, IBM, Coca-Cola, Nike, Fox News; headline volume 3 million emails a day — [The Hacker News](https://thehackernews.com/2024/07/proofpoint-email-routing-flaw-exploited.html); [Dark Reading](https://darkreading.com/cloud-security/disney-nike-ibm-signatures-3m-fake-emails); [The Register](https://www.theregister.com/2024/07/30/scammers_spoofed_emails/)
- Proofpoint's fix: a vendor-specific header so customers can restrict relaying to their own M365 tenants — [The Hacker News](https://thehackernews.com/2024/07/proofpoint-email-routing-flaw-exploited.html)
- BreakSPF (NDSS 2024): combining shared IP pools of cloud services, proxies and CDNs with permissive SPF records, 23,916 vulnerable domains found in the Tranco top 1M, including 23 in the top 1,000 — [NDSS 2024 paper](https://www.ndss-symposium.org/wp-content/uploads/2024-113-paper.pdf)
- BreakSPF slides: 51.7% of domains authorise more than 65,536 IP addresses in SPF; a single vulnerable record can affect more than 10,000 domains — [NDSS 2024 slides](https://ndss-symposium.org/wp-content/uploads/2024-113-slides.pdf)
- Ashiq et al. (USENIX Security 2024): about 60% of domains use `include`, almost all pointing to external providers; a handful of providers account for most records exceeding the 10-lookup limit — [USENIX Security 2024 slides](https://usenix.org/system/files/usenixsecurity24_slides-ashiq.pdf); [paper](https://usenix.org/system/files/usenixsecurity24-ashiq.pdf)
- SPF evaluation is limited to 10 DNS-querying mechanisms; exceeding it is a permerror — [RFC 7208 §4.6.4](https://www.rfc-editor.org/rfc/rfc7208#section-4.6.4)
- DKIM: signers must use RSA keys of at least 1024 bits and should use 2048; verifiers must not accept keys under 1024 bits — [RFC 8301](https://www.rfc-editor.org/rfc/rfc8301)

**Benchmark figures (vendor samples; not comparable with each other)**
- EasyDMARC 2026 (top 1.8M domains): 52.1% had valid DMARC records in early 2026, up from 47.7% in 2025 and 29.1% in 2023 (another excerpt of the same report gives 27.2% for 2023); 29.2% at p=none; 22.9% at quarantine or reject; only 8.9% combine p=reject with RUA reporting — [EasyDMARC 2026 DMARC Adoption & Enforcement Report](https://easydmarc.com/blog/dmarc-adoption-report-2026/); [dmarcreport.com summary](https://dmarcreport.com/blog/the-dmarc-adoption-2026-domains-records-only-9-percent-protected/)
- EasyDMARC: 475 of the Fortune 500 (95%) had valid DMARC in early 2026 and more than 80% were at enforcement — [EasyDMARC report](https://easydmarc.com/blog/dmarc-adoption-report-2026/)
- Palisade (top 100,000 domains, scan of 13 August 2026), among domains with a valid record: p=reject 35.6% (20,537 domains), p=quarantine 28.4%, p=none 36.0% — [Palisade, State of DMARC 2026](https://www.palisade.email/research/state-of-dmarc-2026)
- Red Sift (5,000 US domains): 38.4% at p=reject — [Red Sift US DMARC adoption report](https://redsift.com/blog/us-dmarc-adoption-report); PowerDMARC's US report gives 49.0% at the strictest policy — [PowerDMARC US report 2026](https://powerdmarc.com/united-states-dmarc-adoption-rates/) (the two conflict; samples differ)
- Other samples reported in search results: Sendmarc — 71.5% of tracked domains publish DMARC, 26.6% at p=reject (June 2026); DmarcDkim.com — 10.7% at full p=reject across 859,048 domains (Feb 2026); a CyberFurl scan — 42.1% of the Fortune 500 at p=reject. Primary pages not opened — [aggregated in technologychecker.io](https://technologychecker.io/blog/dmarc-adoption-statistics)

### Inferences
- New brand-posture checks, all DoH-only, in order of evidence strength:
  1. **Dangling SPF include/redirect**: flatten the brand's SPF tree; for each `include:`/`redirect=`/`a:`/`mx:` target, check whether its registered domain resolves (NXDOMAIN at the registrable level) and whether RDAP shows it unregistered. An unregistered target is a takeover-ready finding (SubdoMailing mechanism 2). High severity, very low false-positive rate when RDAP confirms availability.
  2. **Dangling CNAME on brand subdomains** pointing to an expired/unregistered domain or a deprovisioned SaaS resource (SubdoMailing mechanism 1). Needs a subdomain inventory (CT logs the platform already ingests are a source).
  3. **SPF lookup count > 10** (permerror → SPF effectively void) and **void lookups**.
  4. **Over-broad SPF**: total authorised IPv4 space (BreakSPF's >65,536-address threshold is a citable cut-off) and includes of shared cloud/CDN ranges.
  5. **Third-party relay exposure** (EchoSpoofing class): brand MX/SPF routes via a shared security gateway plus M365 — not confirmable from DNS alone; report as "review relay restrictions", not as a vulnerability.
  6. **DKIM key strength** for discoverable selectors: RSA modulus length from the `p=` value; flag <1024 as broken, 1024 as weak. Selectors must be guessed (see Gaps).
  7. **DMARC policy quality**: `p=none` with no RUA; missing `sp=`/`np=`; `pct<100` (now deprecated); RUA pointing to an external domain with no `_report._dmarc` authorization record; non-sending/parked domains without `v=spf1 -all` + `p=reject` + null MX.
- Benchmark sentence the product can safely use: "about half of the top ~1.8M domains publish DMARC and under a quarter enforce it (EasyDMARC, early 2026); among the top 100K with a record, about 36% are at p=reject (Palisade, Aug 2026)". Always name the sample.

### Gaps
- Not collected this session (UNVERIFIED from prior knowledge): Google/Yahoo bulk-sender requirements effective Feb 2024 (DMARC required for senders of >5,000 messages/day); Microsoft Outlook.com equivalent enforcement from 5 May 2025; PCI DSS v4.0 anti-phishing requirement (5.4.1) becoming mandatory 31 March 2025 (DMARC is recommended practice under it rather than named in the requirement text); national mandates such as US BOD 18-01 and UK government guidance. Each needs a primary-source check before being quoted.
- No industry-by-industry or country-by-country DMARC table was captured; the vendor reports cited above contain them but the pages were not opened.
- dmarc.org and Valimail statistics were not retrieved.
- No "dangling SPF include" prevalence percentage found in the academic sources. Percentages on some blogs (e.g. "~25% overly permissive includes", "3.2% use ?all") are unsourced and should not be used — [flagged pages](https://catandmouse-776215.gitlab.io/entries/spf-misconfiguration-exploitation); [dstreefkerk blog](https://dstreefkerk.github.io/2025-05-spf-unregistered-domain-vulnerabilities-research)
- The "14 million emails/day peak" figure for EchoSpoofing could not be confirmed; only "3 million a day" (Dark Reading headline) was found.
- DKIM selector enumeration: no source fetched. UNVERIFIED: common selectors to probe include `google`, `selector1`/`selector2` (M365), `k1`/`k2`/`k3` (Mailchimp), `s1`/`s2` (SendGrid), `default`, `dkim`, `mail`, `smtp`, `mandrill`, `amazonses`-style CNAMEs, `protonmail`, `zoho`; an empty-non-terminal trick (`_domainkey.<domain>` returning NOERROR vs NXDOMAIN) indicates whether any selector exists. DKIM replay has no DNS-visible signature.

## 6. Free reputation / telemetry programs and DNSBL commercial-use limits

### Takeaway
Spamhaus's free tiers are explicitly non-commercial and are blocked when queried through public/cloud resolvers, which rules out both DoH-via-1.1.1.1 lookups from a Worker and use inside a commercial product without a paid subscription. Google Postmaster Tools API v2 is GA but no longer exposes domain/IP reputation and only covers domains the account has verified, so it is a per-customer opt-in at best.

### Cited Findings
- Spamhaus public mirrors are for small-scale, non-commercial use; queries arriving via open/public resolvers are blocked and receive an error return code (`127.255.255.254` for open/public resolver) — [Spamhaus DNSBL usage terms](https://www.spamhaus.org/organization/dnsblusage/); [Spamhaus notice re AWS DNS](https://www.spamhaus.org/resource-hub/email-security/if-you-query-the-legacy-dnsbls-via-amazon-web-services-dns-move-to-spamhaus-technologys-free-data-query-service/)
- Spamhaus published specific notices that queries via Cloudflare's DNS are not served and that such users must move to the Data Query Service (DQS) — [Spamhaus notice re Cloudflare DNS](https://www.spamhaus.org/resource-hub/email-security/if-you-query-the-legacy-dnsbls-via-cloudflares-dns-move-to-spamhaus-technologys-free-data-query-service/)
- The free DQS is "for non-commercial users only"; ISPs, commercial spam-filter services and anyone exceeding fair use require a paid subscription; Spamhaus may revoke free access without notice — [Spamhaus free Data Query Service](https://www.spamhaus.com/data-access/free-data-query-service/)
- The free DQS includes the Zero Reputation Domain blocklist (ZRD) and the Auth BL in addition to the standard lists — [Spamhaus free DQS](https://www.spamhaus.com/data-access/free-data-query-service/)
- Google Postmaster Tools: Google's FAQ says the v2 API covers all v1 functionality "except Domain and IP reputation", and adds compliance status, domain-management APIs and batch APIs; client code must be updated for the new schema — [Google support, deprecation of old Postmaster Tools](https://support.google.com/mail/answer/16594218)
- v2 API reported generally available on 3 February 2026 (third-party guide) — [Folderly migration guide](https://folderly.com/blog/google-postmaster-tools-v2-migration-guide-2025)
- Sources conflict on when v1 / reputation data stopped: some say v1 was shut down by end of 2025, one says reputation data stopped flowing through the API in September 2026 — [Postmastery](https://www.postmastery.com/gmail-postmaster-tools-v1-is-retiring-what-you-need-to-know/); contradicted by [Warmy](https://www.warmy.io/blog/google-postmaster-retired-domain-reputation-warmy-is-building-its-own/)

### Inferences
- From a Cloudflare Worker, DNSBL lookups can only be done over DoH, i.e. through a public resolver — exactly the path Spamhaus blocks. The only supported Spamhaus route is DQS (key embedded in the query hostname), and the free DQS key is non-commercial. Conclusion: Spamhaus ZRD/DBL/HBL are **not** "truly free" for this platform; using them means a paid Spamhaus Technology subscription.
- The platform already runs a `surbl` enrichment feed; the same class of commercial-use restriction should be assumed for SURBL and URIBL until their terms are checked (see Gaps).
- Sender-side programs (Google Postmaster, Microsoft SNDS/JMRP, Yahoo Sender Hub/CFL, Validity FBL) report on mail the *verified owner* sends. They are not attacker telemetry and need each customer to delegate access. Value: a customer-posture add-on ("your Gmail spam rate / authentication rate"), not threat intelligence.

### Gaps
- Not verified this session (UNVERIFIED from prior knowledge): Microsoft SNDS/JMRP (IP-owner only, free); Yahoo Sender Hub complaint feedback loop (DKIM-domain based, free); Validity universal FBL moved to paid tiers; Talos reputation lookup and SenderScore have no free public API; Abusix Mail Intelligence free tier limits; SURBL and URIBL block high-volume/public-resolver queries and require a paid datafeed for commercial use; MXToolbox free API quota. Each needs a primary-source check.
- Spamhaus HBL free-tier availability was not confirmed (search results mention ZRD and Auth BL only).
- Current paid DQS pricing not found.
- Exact Postmaster v2 quotas and the definitive v1 shutdown date not confirmed against Google's API docs.

## 7. Other cheap DNS/web posture signals (DoH + fetch only) and DoH resolver limits

### Takeaway
Cloudflare's and Google's JSON DoH endpoints are unauthenticated and usable from Workers, with no published per-client quota found; most remaining posture signals (CAA, DNSSEC, NS concentration, RDAP lock status, security.txt, headers, dangling CNAMEs) are standard lookups whose threat-predictive value is mostly unmeasured in the sources reviewed, so they belong in brand posture scoring and as pivot keys rather than as alert triggers.

### Cited Findings
- Cloudflare DoH JSON: `GET https://cloudflare-dns.com/dns-query?name=<n>&type=<t>` with header `accept: application/dns-json`; no authentication required; invalid requests return `400 Bad Request`; the endpoint also supports GET/POST wire format — [Cloudflare 1.1.1.1 docs, DNS JSON](https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/dns-json/index.md)
- Cloudflare notes the JSON format has no formal RFC and behaviour may differ between providers; wire format is recommended for critical use; Cloudflare follows Google's JSON schema — [Cloudflare DoH docs](https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/dns-json/index.md)
- Google Public DNS documents a default rate limit of 1,500 QPS per client IP in its ISP guidance (written for resolver use, not specifically for `/resolve`) — [Google Public DNS for ISPs](https://developers.google.com/speed/public-dns/docs/isp)
- CAA records name the CAs authorised to issue for a domain — [RFC 8659](https://www.rfc-editor.org/rfc/rfc8659)
- `security.txt` is served at `/.well-known/security.txt` — [RFC 9116](https://www.rfc-editor.org/rfc/rfc9116)
- Subdomain hijack via dangling CNAME to an expired domain was exploited at scale in SubdoMailing (≈13,000 subdomains) — [Kaspersky](https://www.kaspersky.com/blog/domain-hijacking-subdomailing/51097/)

### Inferences
- Signal catalogue (query → use → main false-positive):
  - `CAA` on lookalike → which CA the operator authorises; pivot key when unusual. Most domains have none.
  - `DS`/`DNSKEY` (or the `AD` flag in the DoH JSON response) → DNSSEC status; brand posture item. Absence is the norm, so not a risk alert by itself.
  - `NS` set + `SOA` rname/mname/serial → cluster lookalikes by nameserver set and SOA rname; many registrars use default NS, so only non-default or self-hosted NS are distinctive. Some DNS providers hand out per-account NS pairs, which makes the pair an account-level pivot (provider-specific; UNVERIFIED per provider).
  - Random-label query (`<random>.<domain>` A/MX) → wildcard DNS detection; needed anyway to suppress false "subdomain exists" results.
  - TTL very low + changing A sets across repeated lookups → fast-flux candidate; CDNs and load balancers behave the same, so require non-CDN ASNs.
  - RDAP `status` (`clientTransferProhibited`, `serverTransferProhibited` = registry lock) and `expiration` event on **brand** domains → hijack/expiry-risk posture item. RDAP is HTTPS and fetchable from Workers; the platform already calls RDAP in Cartographer, so status and expiry can be read from the same response.
  - HTTP headers on the brand apex (`Strict-Transport-Security`, `Content-Security-Policy`, etc.) and `/.well-known/security.txt` → posture items only.
  - Parked-domain detection → known parking NS and parking-page markers; needed to keep parked lookalikes from being scored as live phishing.
- DoH etiquette: no published quota is not the same as unlimited. Batch per tick, cache by TTL, and prefer querying only state that can change.

### Gaps
- No published per-client rate limit found for `cloudflare-dns.com/dns-query` or `dns.google/resolve`; behaviour of DoH fetches from inside Workers under volume is unverified.
- No studies were retrieved quantifying CAA, DNSSEC, NS concentration, SOA pivots, TTL anomalies, security.txt or header posture as predictors of abuse.
- Parked-domain signature lists (parking NS, MX and page fingerprints) were not sourced.
- RDAP coverage and rate limits per registry/registrar were not checked.

## 8. Free phishing-email corpora and header-derived actor pivots

### Takeaway
No sources were retrieved for this question within the tool budget; everything below is unverified background and should be treated as leads to check, not findings.

### Cited Findings
- None retrieved this session.

### Inferences
- The platform's own abuse mailbox is the better calibration corpus for header pivots, because public corpora are dated and stripped of recipient-side headers; public corpora are mainly useful as a ham/spam baseline for rule false-positive testing.
- Header pivots worth extracting from abuse-mailbox samples (cheap string operations, no AI): `DKIM-Signature` `d=`/`s=` (feeds the DKIM-key pivot in section 4), `Return-Path` domain, `Message-ID` right-hand side, `X-Mailer`/`User-Agent`, first external `Received` hop IP and HELO name, `Authentication-Results` verdicts, `X-MS-Exchange-Organization-*`/`X-OriginatorOrg` (M365 tenant domain), `List-Unsubscribe` domain, ESP-specific headers (e.g. SendGrid/Mailgun/SES identifiers that encode the sending account).

### Gaps
- UNVERIFIED, not checked this session: `phishing_pot` (GitHub, rf-peixoto; community-submitted real phishing `.eml` samples), the Nazario phishing corpus (monkey.org/~jose/phishing), the SpamAssassin public corpus, and the Enron corpus as a ham baseline. Licences, update recency and whether full headers are preserved all need checking before use.
- No source found quantifying how well X-Mailer / Message-ID / PHPMailer fingerprints cluster actors.
