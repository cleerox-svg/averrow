# Homepage hero copy: H4A "Auto-play steps" (facelift Phase 5)

Status: **approved for build** by `disclosure-strategist` (claims) and `content-strategist` /
`web-copywriter` (wording), 2026-11-08. `seo-strategist` wording for title and meta.
Source decision: `docs/brand/BRAND_BRIEF.md` §10 G5. Prototype: `docs/brand/hero-prototype/`
(`h4a.html`, `src/build4.js`, `src/core.js`). This file replaces every customer-visible string in
the prototype. The build in `packages/averrow-marketing` copies these strings exactly; any change
goes back through the register (`docs/DISCLOSURE_REGISTER.md`, §3.13).

Every string carries its register row in brackets. "H" rows are new in §3.13.

**Owner OK needed** before launch: none of the strings below change positioning or plan claims.
Two optional alternatives are marked *Option, owner OK*; ship the default if there's no answer.

---

## 1. What the hero may show (rules for the build)

1. The graph is a **fictional Enterprise example**. The disclosure line (§5) is always visible,
   in the animated, reduced-motion and no-JS versions, at every width. [H1, L48]
2. The graph shows **phishing domains** found in threat intelligence, not lookalike-module
   findings. Lookalike-module rows are never clustered, and a domain found in new-registration
   data lands in that module, so it can't start this chain. [H2, L48]
3. Infrastructure is shown as **hosting and a certificate**. No ASN, no /24, no registrar, no
   "serial": those name clustering methods. IPs use the documentation ranges only. [H3, L33, §3.5]
4. No actor is ever named as if Averrow identified it. The actor label is fictional and
   conditional on public reporting. [H4, §3.5 attribution row]
5. Social and app nodes are **related findings reviewed alongside** (dashed), never part of the
   operation. [N2, L49]
6. Takedowns are shown for **domains only**. [§3.7]
7. Counts in the graph must add up (the prototype's "19 findings" counted three
   infrastructure nodes as findings). [H5]

## 2. Hero text

| Element | Approved string | Row |
|---|---|---|
| Eyebrow | Digital risk protection · threat-actor intelligence | L49 (category wording; fine on the homepage, never the lead on a Pro/Business surface) |
| H1 | Brand protection that *traces the operation*. | N3, §3.12 category line. Kept: still the strongest cleared line, and the graph now illustrates it literally |
| Lede (desktop) | Averrow finds lookalike domains, impersonation accounts and copycat apps aimed at your brand and executives, and files takedowns for lookalike domains and phishing URLs under your authorization. On the Enterprise plan, operation mapping groups phishing domains that share hosting or certificates into one operation, so you act on the operation, not one alert at a time. | L48, L49, §3.3, §3.7, §3.12 |
| Lede (short, under 600px) | Find the fakes, file takedowns, and on Enterprise, trace the operation. | N3 (unchanged) |

*Option, owner OK (positioning):* eyebrow "Digital risk protection" alone. It stops the hero
leading with threat actors (§3.5 "don't lead with WHO"), but CLAUDE.md §13 calls Averrow a
threat-actor intelligence platform, so dropping it is the owner's call. Default: keep.

Changes from the live lede (`M/index.astro:81-85`): "fake profiles and cloned apps" →
"impersonation accounts and copycat apps" (L49); "groups related lookalike domains into one
campaign" → "groups phishing domains that share hosting or certificates into one operation"
(L48); "then files" → "and files" (the order isn't a pipeline).

## 3. The four steps

Rail labels: long at ≥1120px, short below. Captions: the long one goes in the static step list
(reduced motion, no JS); the short one is the live caption under the rail.

| # | Rail (long) | Rail (short) | Static-list caption | Live caption | Row |
|---|---|---|---|---|---|
| 1 | Domain found | Found | acme-payroll-login.example turns up in phishing intelligence and is matched to Acme. | Phishing intelligence surfaces acme-payroll-login.example, matched to Acme. | H2, §3.1 ("from phishing intelligence sources", L33) |
| 2 | Infrastructure linked | Linked | Shared hosting and one shared TLS certificate tie it to 13 more phishing domains. | Shared hosting and one TLS certificate tie it to 13 more phishing domains. | H3, §3.5 ("shared hosting and certificates") |
| 3 | Operation mapped | Mapped | On Enterprise, the cluster becomes one operation. A known actor is shown only where public reporting names one; this one is fictional. Related findings, shown dashed, are reviewed alongside. | Grouped into one operation; a known actor is shown only where public reporting names one. | H4, §3.5, N2 |
| 4 | Takedowns filed | Takedown | Takedowns are filed for each domain under your authorization, at the automation level you choose. Status updates as registrars and hosts act. | Takedowns filed for each domain under your authorization; status updates as hosts act. | §3.7 (submission + automation-level rows) |

Step 3 was "Actor attributed" in the prototype. That is **not cleared**: attribution is
Enterprise, comes only from public reporting (OTX inheritance) or an analyst
(`W/agents/attributor.ts:1-40`), and is never Averrow naming an actor. Renamed, and the actor
moved into a conditional caption. [H4]

Accessible names: `Step N of 4: <rail long>`. Pause button: "Pause step animation" / "Play
step animation" (unchanged).

## 4. Graph labels

| Node / element | Prototype | Approved | Row |
|---|---|---|---|
| Hub title | Acme payroll sign-in impersonation | Acme payroll sign-in impersonation | H1 (fictional brand Acme, `.example` domains) |
| Hub id | OP-2291 | OP-2291 | H1 (matches `OperationStory.astro`) |
| Hub sub | 19 findings | 14 phishing domains | H5 |
| Actor line under hub | Actor FX-114 · example | Known actor: FX-114 (fictional) | H4, H6 |
| Domain labels (shown at desktop only) | acme-payroll-login.example, acme-hr-portal.example, acmepay-support.example | unchanged | H1 (RFC 2606 `.example`) |
| Hosting node A | AS64500 / 203.0.113.0/24 | Hosting · 203.0.113.24 | H3 (no ASN or /24; RFC 5737 documentation IP) |
| Hosting node B | AS64501 / 198.51.100.0/24 | Hosting · 198.51.100.7 | H3 |
| Certificate node | TLS cert / one shared serial | TLS certificate / shared by 5 domains | H3 (the prototype links 5 domains to it, `core.js` `[6,7,8,9,10]`) |
| Social node | @acme_hr_support / fake profile | @acme_hr_support / impersonation account | L49, §3.3 |
| App node | Acme Pay / cloned app | Acme Pay / copycat app | L49, §3.3 |
| Takedown card header | Takedowns · Active | Takedowns · Active | §3.7 |
| Takedown card counts | 8 removed · 4 pending · 2 queued | 8 taken down · 4 submitted · 2 to approve | §3.9 status row; labels match the tenant app (`T/lib/takedowns.ts:172-181`). "Queued" is not a status |

If the hosting labels don't fit at 11px, drop the IP and keep "Hosting A" / "Hosting B". Never
put an ASN back to fill the space.

Screen-reader figure caption:
"Fictional example of Enterprise operation mapping, in four steps: a phishing domain imitating
Acme is found, shared hosting on two networks and one shared TLS certificate link it to 13 more,
the 14 domains are grouped into one operation, OP-2291, and takedowns are filed for each domain
(8 taken down, 4 submitted, 2 waiting for approval). An impersonation account and a copycat app
are shown as related findings." [H1, H5]

## 5. Illustrative disclosure line

**"Fictional example · operation mapping is on the Enterprise plan"** [H1, §3.12]

Replaces "Illustrative example · names changed". "Names changed" says a real case sits behind
it, and there isn't one (§3.11: no customers, case studies or press may be implied). The line
also carries the Enterprise qualifier the category line needs on the same page.

## 6. Calls to action (unchanged, re-cleared)

| Element | String | Row |
|---|---|---|
| Scan input label (sr-only) | Domain to scan for brand threats | §3.1 free scan |
| Placeholder | yourcompany.com | — |
| Scan button | Scan your domain | §3.1 |
| Under the form | Free scan · no sign-up · no card | §3.1 (the scan needs no account, so no card is trivially true) |
| Secondary button | Book a demo | §3.11 |

## 7. Homepage section heads (44px scale)

At 44/1.06 a head should fit two lines in the content column: about 45 characters at most.

| Section | Head | Row |
|---|---|---|
| Operation story | From one fake domain to the operation behind it. | N2 (head unchanged; the body still needs the L48 fix) |
| Takedown flow | You set the rules. We do the filing. | §3.7 (approved headline) |
| Coverage | Where attackers pretend to be you. | §3.3, H7 ("Everywhere" dropped: no Facebook or Google Play) |
| By the numbers | What the platform sees, counted plainly. | §5 proof points (unchanged) |
| Onboarding (new section, if built) | From free scan to monitoring. | §3.12 onboarding row (no day count until the owner confirms one) |
| Closing CTA | See what's aimed at your brand. | §3.1 (pairs with "Scan your domain"; replaces "Ready to protect your brand?", optional) |

## 8. Page title and meta

| Tag | String | Row |
|---|---|---|
| `<title>` (52 chars) | Averrow — Brand protection that traces the operation | N3 (unchanged) |
| Meta description (160 chars) | Find lookalike domains, impersonation accounts and copycat apps aimed at your brand, and file takedowns for lookalike domains and phishing URLs. Free scan, no sign-up. | H8, L49, §3.7 |
| `og:title` / `twitter:title` | same as `<title>` | — |
| `og:description` / `twitter:description` | same as meta description | — |

The live description (`M/index.astro:73`, ~330 characters) is truncated in results and still
says "fake profiles and cloned apps" (L49). DRPS is dropped from the meta: it stays in the
JSON-LD and on `/platform` as the secondary SEO term (§3.12).

## 9. Not changed by this file (still open)

- `L/Layout.astro:53` site-wide JSON-LD still says "groups related lookalike domains" (L48)
  and "fake social profiles and cloned apps" (L49).
- `OperationStory.astro` body still groups "nine lookalikes" into OP-2291 (L48). With the hero
  now telling the same story, consider cutting the section or rewriting it to the §1 rules.
- `resources/sample-operation-report.astro` (L50).
