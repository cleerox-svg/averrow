# Website & Rebrand Brief — 2026-11

_For the session doing the rebrand and UI redesign of the marketing site (`packages/averrow-marketing`). Owner-approved 2026-11-07._

Companion docs:
- `docs/DRPS_RESPONSE_PLAN_2026-11.md`: the full 6-month plan (the engineering sprints are a separate track).
- `docs/DISCLOSURE_REGISTER.md`: the claim-by-claim source of truth. If this brief and the register disagree, the register wins.

## 1. Why this exists

An outside analyst assessed Averrow using **only the public website**. The owner's rule: **wherever the assessment gets Averrow wrong, the website is wrong.** The rebrand should fix those gaps. It should not carry the old framing across into the new design.

What the assessment got wrong or missed, and the cause on the site:

| Assessment said / missed | Cause on the site | What the rebrand should do |
|---|---|---|
| Filed us as generic "DRPS" | `<title>` and JSON-LD said DRPS while the hero said threat-actor intelligence | Lead with one category line (§2) everywhere |
| "Correlates registrar, hosting, **MX, kit characteristics**" | Homepage operation story and JSON-LD implied kit and registration-pattern correlation | Describe only what is built (§3) |
| "Transparent pricing" | A module grid that looks like a price list; prices were removed 2026-10-05 | Say plainly that pricing is scoped per customer (§4) |
| "Zero-friction, fast time-to-value" | The free scan is instant, but monitoring needs onboarding by our team | Show the real onboarding steps (§4) |
| "MSSP-ready" | A blog post claimed "multi-tenant from the ground up" | One organisation per login today (§3) |
| Weak takedown reach | The site never named a channel or the stay-down checks | Surface them at T2 wording (§5) |
| SecOps vs Legal buyer split | Persona pages exist but don't map to plans | Map plans to personas (§5) |
| Missed the abuse mailbox, dark web, app stores, trademark, integrations | No pages for them | Add them (§5) |

## 2. Positioning (owner decisions, 2026-11-07)

- **Primary category line:** *"Brand protection that traces the operation."* Use it in the `<title>`, meta description, JSON-LD, hero, Plans page and press boilerplate.
- "Digital Risk Protection (DRPS)" stays as a **secondary** SEO keyword. It is not the lead.
- Wherever operation or campaign mapping appears, also say: **"Operation mapping is part of the Enterprise plan."**
- **Lead buyer:** SecOps and mid-market security teams. Legal/Brand is the secondary persona, and MSSP is roadmap.
- **Voice:** global audience. No aviation or military framing (CLAUDE.md §13). No internal agent codenames.

## 3. Claim rules — what the code actually supports

**Say (true today):**
- Monitoring covers lookalike domains, certificate issuance, impersonation accounts on social platforms, copycat apps (**Apple App Store only**), executive impersonation, leak-site and paste mentions, an abuse mailbox, and email-security posture (SPF/DMARC/DKIM grade).
- **Takedowns** have three automation modes: Off, Semi-auto (customer approves) and Auto (within a signed authorization). Reports go to registrars and hosts and to industry abuse services through APIs, plus email. Taken-down domains are re-checked to confirm they stay down.
- **Enterprise operation mapping:** related **phishing infrastructure** (domains, URLs and IPs that share hosting or certificates) is grouped into one operation.
- **Evidence:** each takedown draft carries an evidence summary. Rule-based scoring with traceable signals: we do not show black-box AI scores to customers.
- **Integrations:** Splunk, Microsoft Sentinel, QRadar, Jira, ServiceNow and webhooks, **set up with our team**.

**Do NOT say (not built, or the T3 tier — protects detection):**
- Correlation by MX, nameserver, registration patterns or phishing kit. Social profiles or apps "linked to" an operation (call them *related findings*).
- That lookalike-monitoring findings are grouped into campaigns (only threat-feed phishing infrastructure is grouped).
- A customer-facing operation view (not built yet).
- Social or app takedowns as "filed". Say *drafted for review*.
- Multi-tenant or MSSP single login, a self-serve REST API, self-serve SIEM setup, self-serve signup, Google Play coverage, or visual or logo similarity.
- Removal-speed numbers or SLAs (wait for the metrics; see §6). Never claim cloaking or anti-bot evasion.
- Detection internals: homoglyph/TLD-swap specifics, "12+ DKIM selectors" outside the approved email-security page, certificate age as a scoring input, the exact escalation rules. The approved phrase is *"character swaps and brand-plus-keyword domains"*.
- That no third-party AI is involved. **Anthropic is a disclosed AI sub-processor** (DPA). Keep the DPA's sub-processor list as it is.

**Preferred terms:** "impersonation accounts" (not "fake social profiles"), "copycat apps" (not "cloned apps"), "phishing domains" for grouped infrastructure.

## 4. Copy blocks the owner has already approved — reuse them verbatim

**Plans page (hero):**
> Brand protection that traces the operation. Operation mapping is part of the Enterprise plan.

**Pricing (above the plan grid and in the FAQ):**
> We don't publish prices. Each plan is quoted for your organisation, based on the plan and the brands you need covered. Talk to us for a quote.

**What onboarding looks like** (no day counts until the owner confirms one):
1. **Run the free scan** on your domain, no signup.
2. **A call with our team** to choose your brands and modules.
3. **We set up your organisation and brands.** You add your team, executives, official domains and handles, sign the takedown authorization and choose your automation level.
4. **Monitoring starts** and findings appear in your console as checks complete.

**JSON-LD / homepage description:** "Brand protection that traces the operation. Averrow (Digital Risk Protection, DRPS) finds lookalike domains, impersonation accounts and copycat apps … Enterprise adds operation mapping: phishing domains, IPs and certificates that share hosting or certificates are grouped into one operation."

**Press boilerplate:** use the approved text in `DISCLOSURE_REGISTER.md` §3.12.

## 5. Information architecture for the new site

Keep: home, platform plus sub-pages, solutions/personas, plans, security/trust, legal, resources, blog, changelog, scan, demo, contact, report-abuse.

Add:
1. **`/integrations`**: the five connectors plus webhooks, "set up with our team". Add Slack and Teams only after engineering S10.
2. **Takedowns page upgrade:** the three autonomy modes, the T2 channel wording from §3, stay-down re-checks, and the evidence summary. **Do not name Google Web Risk.** Name NetBeacon or GoDaddy only after ops confirms they are live in production.
3. **Surface pages** for dark web (leak sites and pastes), app stores (Apple), and trademark, written to the register's approved wording.
4. **Evidence methodology page**: what an evidence pack contains (screenshots, hashes, timestamps, registration data), with no detection internals.
5. **Plans mapped to personas:**

   | Persona | Plan |
   |---|---|
   | SecOps | Business |
   | Legal/Brand | Business + trademark/takedowns, or Enterprise |
   | Lean teams | Professional + managed SOC |

   Show this on `/pricing` and each solutions page.
6. **Comparison pages** (vs Netcraft, Bolster, ZeroFox): compare coverage, evidence and the operation model. **Never removal speed or price.**
7. **Proof:** aggregate T1 numbers (`src/data/stats.json`, built by `scripts/fetch-stats.mjs`), the sample operation report, and a sample evidence pack as gated downloads.
8. **`/.well-known/security.txt`** (G34). Contents:
   ```
   Contact: mailto:security@averrow.com
   Expires: 2027-11-07T00:00:00.000Z
   Preferred-Languages: en
   Canonical: https://averrow.com/.well-known/security.txt
   Policy: https://averrow.com/security
   ```
   The build copies `public/` into `dist/`, and `scripts/sync-to-worker.mjs` puts it in the worker's assets. Confirm with `curl -I` after deploy that wrangler kept the dot-directory.

## 6. Claims that unlock later (add only after engineering ships and disclosure-strategist verifies)

| Claim | Unlocked by (see DRPS plan) |
|---|---|
| Median time to removal, success rate by channel | S3, with n ≥ 30 takedowns and the owner's OK |
| REST API | S1 (API-key auth) |
| Self-serve integrations; Slack/Teams | S10 |
| Correlation by MX, nameserver or kit (T2 wording only) | S5 + S6 |
| Logo / visual similarity | S9 |
| Legal-grade evidence pack export | S8 |
| Self-serve trial | S11 |
| MSSP single login | S12 |
| Cloaking resistance | **Never** |

## 7. Pending fixes the rebrand should absorb

These were drafted but not merged. The old pages will be replaced, so apply them in the new copy:
- **L48:** "groups related lookalike domains" → "groups related phishing infrastructure" (Layout JSON-LD, homepage, OperationStory).
- **L49:** "fake social profiles / cloned apps" → "impersonation accounts / copycat apps", site-wide.
- **L50:** the sample operation report (`resources/sample-operation-report.astro`):
  - The lede must not tie the social profile or app to the operation. They are related findings.
  - Say "Apple App Store", not "third-party store".
  - Remove the icon-copying claim and the claim that the app listing links to the domains.
- **L51/L52:** in the exposure-score blog, say "several categories" (the score has seven inputs), and that the lookalike score reflects how many registered lookalikes are live. Remove certificate age and "certificate issued yesterday" as scoring inputs.
- **Restore** "character swaps and brand-plus-keyword domains" in the lookalike blog post.
- **L53:** the press boilerplate in `src/lib/company.ts` → §3.12 approved text.
- **L45 (worker, not marketing):** in `packages/averrow-worker/src/templates/terms.ts`, "as listed on our pricing page" → "as set out in your order form or subscription".
- **Honeypot meta description:** `packages/averrow-worker/src/honeypot.ts:157` says "AI-powered brand threat intelligence". Route it to platform-security.

## 8. Process for the rebrand session

- Before publishing any page, run new or changed claims past **disclosure-strategist** and record them in `docs/DISCLOSURE_REGISTER.md`.
- Check the design with **design-reviewer** (both themes, mobile), and SEO metadata with **seo-strategist** (title, JSON-LD, sitemap).
- Gate: `pnpm exec astro build` passes, and the Playwright suite in `packages/averrow-marketing/tests` passes. `no-pricing.spec.ts` must keep passing, because no prices on the site. `company-pages.spec.ts` may assert the boilerplate text.
- The DPA, terms and privacy pages are legal content: changes need the owner's OK (CLAUDE.md §9a). The DPA's Anthropic disclosure still needs a lawyer's review (US data transfers, Anthropic's training and retention terms, a notice period for new sub-processors).
