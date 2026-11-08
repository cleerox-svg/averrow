# Free Domain Scan — how it works (internal KB)

**Audience:** Averrow staff (sales, support, SOC). **Internal only — do not
publish, paste into customer email, or put on the marketing site.** The public
`/scan` page shows a grade and a two-line summary on purpose; this article is
the drill-down behind it.

Last verified against code: 2026-11-08.

| What | Where |
|---|---|
| Public page | `packages/averrow-marketing/src/pages/scan.astro` (`/scan`) |
| API | `POST /api/brand-scan/public`, `GET /api/brand-scan/public/:id` (`handlers/brandScan.ts`) |
| Public response shaper | `packages/averrow-worker/src/lib/free-scan-view.ts` |
| Email grading engine | `packages/averrow-worker/src/email-security.ts` (`calculateEmailSecurityScore`) |
| Lookalike sample + check | `packages/averrow-worker/src/lib/scan-lookalikes.ts` |
| Full (emailed) report | `handlers/qualifiedReport.ts`, delivered from the lead form |

---

## 1. What the visitor sees vs. what we keep

Disclosure decision (owner, 2026-11-08): the public result is a **score and a
short summary**. The per-check breakdown describes how we grade, so it is not
returned to anonymous callers.

| Data | Public `/scan` page + API | Stored (`brand_scans.public_view`) | Emailed full report |
|---|---|---|---|
| Email grade (A+–F) | yes | yes | yes |
| Protection level (Strong / Partial / Weak) | yes (derived from the grade on the page) | — | — |
| Registered lookalike **count** | yes (`null` if nothing could be checked) | yes | yes |
| SPF / DKIM / DMARC / MX / BIMI status | **no** | yes | yes |
| Lookalike sample size (how many we checked) | **no** | yes (`checked`) | — |
| Registered lookalike **names** | no | yes (`registered_lookalikes`) | yes |
| Threat-feed data | never | never (public rows store NULL) | — |

Public response shape:

```json
{ "id": "…", "domain": "acme.com", "checked_at": "…",
  "email": { "grade": "B" },
  "lookalikes": { "registered": 4 } }
```

## 2. The grade — email spoofing protection

The grade is the email-security engine's own grade; there is no second scale.
Points (max 95, which is still A+):

| Check | Points |
|---|---|
| DMARC record exists | +10 |
| DMARC policy `reject` / `quarantine` / `none` | +20 / +12 / +4 |
| DMARC aggregate reporting (`rua`) set | +5 |
| SPF record exists | +10 |
| SPF `-all` / `~all` / `?all` | +15 / +10 / +3 |
| SPF under the 10-DNS-lookup limit | +5 |
| DKIM found on a common selector | +20 |
| …or no DKIM found but MX is an enterprise provider (Google Workspace, Microsoft 365, Proofpoint, …) that always signs | +10 |
| MX records present | +10 |

Grade bands: **A+** ≥ 90 · **A** ≥ 80 · **B** ≥ 70 · **C** ≥ 55 · **D** ≥ 40 · **F** < 40.

BIMI is checked but **does not affect the grade**.

### Protection level shown on the page

| Grade | Level | Public summary line |
|---|---|---|
| A+, A | Strong | Receivers can reject email forged to look like it comes from *domain*. |
| B, C | Partial | Some email forged to look like it comes from *domain* could still be delivered. |
| D, F | Weak | Anyone can send email that looks like it comes from *domain*. |

## 3. The individual checks (drill-down)

Use these when a prospect asks "why did I get a B?". The emailed report and
the staff tools have the per-check values.

### DMARC — the policy that tells receivers what to do with forged mail
- **reject** — receivers should refuse mail that fails SPF/DKIM alignment. Best.
- **quarantine** — failing mail goes to spam. Enforcing, slightly weaker.
- **none** — monitor only; forged mail is still delivered. Counts as *not enforcing*.
- **missing** — no `_dmarc` record. Anyone can spoof the domain.
- `rua` reporting earns points because without it the owner can't see who sends as them. Where reports go does not matter (any destination scores the same).

### SPF — which servers may send for the domain
Public status comes from the record's `all` qualifier:
- **pass** (`-all`) — mail from unlisted servers fails.
- **soft fail** (`~all`) — unlisted servers are flagged, usually still delivered.
- **neutral** (`?all`, `+all`, or no `all` term — RFC 7208 §4.7 default) — the record exists but restricts no one.
- **missing** — no SPF record.
- More than 10 DNS lookups breaks SPF evaluation at many receivers, so staying under the limit earns points.

### DKIM — cryptographic signature on outgoing mail
- We probe a fixed list of common selectors (`google`, `default`, `selector1`, `selector2`, `k1`–`k3`, `smtp`, `mail`, `email`, …). **Not found** means *not found on the selectors we probe*, not that the domain doesn't sign — custom or rotating selectors are invisible to us. That is why enterprise mail providers get partial credit.
- The selector list is never published.

### MX — does the domain receive mail
- **present / none.** No MX means the domain can't receive mail. A non-mail domain should still publish SPF `-all` and DMARC `reject` so it can't be spoofed.

### BIMI — brand logo in the inbox
- **set / not set.** Requires DMARC at quarantine or reject. Informational only; no grade impact.

### How the old on-page sentence was chosen (kept for support scripts)
First match wins: no DMARC → "no DMARC record"; DMARC `none` → "DMARC isn't
enforcing"; no SPF; no MX; SPF soft/neutral → "SPF policy is loose"; no DKIM
found → "didn't find DKIM on the common selectors"; otherwise "SPF, DKIM and
DMARC are in place".

## 4. Lookalike domains

- We generate permutations of the registrable domain (eight families: TLD swap,
  missing/doubled/transposed character, prefix/suffix such as `secure-`/`-login`,
  homoglyph, hyphenation) and check a **ranked sample of 40** (`LOOKALIKE_SAMPLE_SIZE`).
  Per-family caps: TLD swap 10, typo families 18, prefix/suffix 8, homoglyph 6, hyphen 4;
  leftover slots are refilled in the same order. Characters that can't be registered
  as typed are dropped first.
- "Registered" = an NS answer over DoH (Cloudflare). 8 concurrent lookups, 2.5s
  each, 6s total. SERVFAIL/timeouts count as *unknown*, never registered.
- Results are cached in KV `scan:lookalikes:<domain>`: 24h for a complete
  result, 1h for a partial one, nothing if no name got an answer (the page then
  says it couldn't check).
- A registered lookalike is **not** necessarily malicious — many are defensive
  registrations by the brand itself, parked domains, or unrelated businesses.
  The full report lists the names so the prospect can tell.
- The free scan is a sample. The platform's lookalike monitoring checks the full
  permutation set continuously, plus new-registration feeds and CT logs.

## 5. Input handling and limits

- Input is reduced to its registrable domain (`shop.acme.co.uk` → `acme.co.uk`); a bare public suffix is rejected.
- Rate limit: 10 scans/hour per IP (shared with `/assess`). Turnstile per `TURNSTILE_MODE`.
- Email scan wall-clock cap: 8s (→ 504 "took too long").
- Results link (`/scan/?id=…`) works for 90 days, then the row is deleted.
- The full report is emailed automatically only when the lead's email domain is exactly the scanned domain (and not a mailbox/SaaS provider); otherwise the team follows up.

## 6. Talking points

- "Your score is about how easy it is to send email that looks like it comes from you."
- "The free scan is a snapshot from public DNS. It doesn't use any of our threat intelligence about your domain."
- Don't recite the point table or the sample size to prospects; offer the full report or a demo instead.
