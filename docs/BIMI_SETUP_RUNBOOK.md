# BIMI Setup Runbook

BIMI (Brand Indicators for Message Identification) shows the Averrow logo next to outbound emails in Gmail, Yahoo, Apple Mail, and Fastmail. End-user effect: instead of a generic letter avatar next to your messages in the recipient's inbox, they see the red Avro Arrow.

## ⚠️ ACTION REQUIRED — 2026-05-30 (DMARC ramp)

**Status as of 2026-05-16**: DMARC + BIMI records are published on both `averrow.com` and `averrow.ca`. DMARC is currently at `p=none` (observe-only) for safety. BIMI is published but **NOT YET DISPLAYING** in inboxes because BIMI requires DMARC at `p=quarantine` or `p=reject` to activate.

**On or after 2026-05-30** (~14 days after setup):

1. Review the DMARC reports collected during the observation window:
   - `averrow.com` reports → Cloudflare Dashboard → Email → DMARC Management
   - `averrow.ca` reports → trust-radar worker's email handler (`dmarc_rua@trustradar.ca`)
2. Verify that all legitimate senders (Resend, Google Workspace) are passing both SPF + DKIM alignment — no surprises in the "failed" column
3. If clean, edit both DMARC TXT records via CF Dashboard → DNS:
   - `_dmarc.averrow.com`: change `p=none` → `p=quarantine` (keep `pct=100`)
   - `_dmarc.averrow.ca`: same change
4. Within 1–24h the red Avro Arrow appears in Yahoo / Apple Mail / Fastmail inboxes for any mail sent from these domains
5. Gmail will still show the auto-generated letter avatar — that needs a Verified Mark Certificate (VMC, ~$1500/yr). **Parked indefinitely until revenue justifies it.**

Validators to check publish state (no auth needed):
- https://easydmarc.com/tools/bimi-lookup
- https://bimigroup.org/bimi-generator/

## Prerequisites

1. **DMARC** at `p=quarantine` or `p=reject` with `pct=100` on the sending domain
2. **A BIMI-compliant SVG** (SVG Tiny PS profile) hosted publicly
3. **DNS TXT record** at `default._bimi.<domain>`
4. **Optional but recommended for Gmail**: a Verified Mark Certificate (VMC) from DigiCert or Entrust. Without a VMC, Gmail won't show the logo. Yahoo, Apple, Fastmail show without VMC.

## Files already in place

- `packages/trust-radar/public/bimi.svg` — BIMI-compliant SVG (SVG Tiny 1.2 PS)
- Same artwork as `favicon.svg` but with `baseProfile="tiny-ps"` and `<title>` element required by BIMI
- Served at `https://<any-platform-domain>/bimi.svg` automatically by the trust-radar Worker (static assets)

Verify after deploy:
```bash
curl -sI https://averrow.com/bimi.svg | head -5    # expect 200 OK
curl -sI https://averrow.ca/bimi.svg  | head -5    # expect 200 OK
```

## Step 1 — DMARC

BIMI requires DMARC. Add or update the `_dmarc` TXT record on each domain. Current state per mxtoolbox: neither averrow.com nor averrow.ca have DMARC records.

Add in **CF Dashboard → averrow.com → DNS → Records → Add record**:

| Type | Name | Content | TTL |
|---|---|---|---|
| TXT | `_dmarc` | `v=DMARC1; p=quarantine; pct=100; rua=mailto:dmarc_rua@averrow.com; ruf=mailto:dmarc_rua@averrow.com; fo=1` | Auto |

Same on averrow.ca, trustradar.ca, lrxradar.com (any domain you intend to send email from).

The trust-radar Worker is configured to receive DMARC reports at `dmarc_rua@averrow.com` and `dmarc_rua@trustradar.ca` per `src/index.ts:117` — that wiring already works.

### Starting more conservatively

If you're worried about legitimate mail being quarantined unexpectedly, start with `p=none` for 14 days while monitoring DMARC reports, then ramp:

- Week 0-2: `p=none; pct=100` — observation only, no rejection
- Week 2-4: `p=quarantine; pct=25` — quarantine 25% of failing mail
- Week 4-6: `p=quarantine; pct=100` — full quarantine
- Optional: `p=reject; pct=100` — strictest

BIMI only activates at `p=quarantine` or `p=reject` with `pct=100`. So minimum 4-6 weeks to safely ramp.

## Step 2 — BIMI TXT records

Per domain you want the logo shown for. The TXT record points at the hosted SVG.

**CF Dashboard → averrow.com → DNS → Records → Add record**:

| Type | Name | Content | TTL |
|---|---|---|---|
| TXT | `default._bimi` | `v=BIMI1; l=https://averrow.com/bimi.svg;` | Auto |

Same shape for averrow.ca, trustradar.ca, lrxradar.com — pointing at each domain's own `/bimi.svg` (they're all served by the same Worker so the file is identical, but the URL needs to match the domain).

## Step 3 — Verify

```bash
# DMARC record published
dig TXT _dmarc.averrow.com +short
# expect: "v=DMARC1; p=quarantine; ..."

# BIMI record published
dig TXT default._bimi.averrow.com +short
# expect: "v=BIMI1; l=https://averrow.com/bimi.svg;"

# Hosted SVG is reachable
curl -sI https://averrow.com/bimi.svg | head -3
# expect: HTTP/2 200, content-type: image/svg+xml
```

Then use a BIMI validator:
- https://bimigroup.org/bimi-generator/ (validator + DNS-record builder)
- https://easydmarc.com/tools/bimi-lookup (live check against multiple resolvers)

Once DNS has propagated (1-24h), the logo will appear in Gmail/Yahoo/Apple Mail inboxes for any mail sent from the configured domain. Note: Gmail also needs a VMC for the logo to show — without one, only Yahoo / Apple Mail / Fastmail display.

## Optional — Verified Mark Certificate (Gmail)

Gmail requires a VMC to display the BIMI logo. VMCs verify trademark ownership and cost ~$1500/yr from DigiCert or Entrust.

- Apply via DigiCert: https://www.digicert.com/tls-ssl/verified-mark-certificates
- Trademark must be registered (Averrow / LRX Enterprises) at USPTO, CIPO, EUIPO, or another supported registry
- Process: trademark verification → certificate issuance → publish PEM at the BIMI URL

Without VMC: BIMI shows in Yahoo Mail, Apple Mail, Fastmail. Without showing in Gmail it's still worth doing — Yahoo + Apple Mail combined are non-trivial inbox share.

## Effect

When a recipient at a BIMI-supporting client receives email from `abuse-noreply@averrow.com`:

- **Before**: generic letter avatar with "A" or coloured circle
- **After**: red Avro Arrow logo

Plus DMARC at p=quarantine/p=reject prevents spoofed mail from impersonating your domain.

## Related

- `packages/trust-radar/public/bimi.svg` — the hosted BIMI SVG
- `packages/trust-radar/public/favicon.svg` — same artwork, regular SVG
- `src/handlers/dmarc-email.ts` — DMARC report receiver (already wired)
- `src/lib/abuse-mailbox-responder.ts` — the abuse-mailbox emails that benefit from BIMI
- BIMI spec: https://bimigroup.org/
- VMC info: https://www.digicert.com/tls-ssl/verified-mark-certificates
