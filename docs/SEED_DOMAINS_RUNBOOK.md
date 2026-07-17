# Seed Domains Runbook

Audit-recommended expansion (Wave 2.1) of the seeded-honeypot domain footprint from 3-4 production domains to ~20 throwaway domains. Larger footprint = more harvester first-touch surface (Project Honey Pot's distributed-bait principle). Each new domain serves the same four bait paths (`/admin-portal`, `/internal-staff`, `/team-directory`, `/staff-contacts`) with a rotated address roster pulled from the auto-seeder.

## The five-minute workflow per new domain

1. **Register the domain** — Cheap throwaway TLDs (`.xyz`, `.online`, `.shop`, `.fun`, `.click`) are typical (~$2-5/yr each). Buy through Cloudflare Registrar to skip the manual nameserver step.

2. **Add to Cloudflare** — If not registered through CF, add as a site (free plan is fine; we use Workers Routes, not page rules). Verify nameservers, then wait for active.

3. **Email Routing (optional but recommended)** — Enable Email Routing on the domain, point catch-all to `cleerox-svg@gmail.com` (or your operator inbox). This isn't required for the bait pages themselves but lets harvested addresses on this domain receive mail when they get spammed. Without Email Routing, captures land but the harvester's email bounces (still useful for source attribution).

4. **Wrangler route** — Add to `packages/averrow-worker/wrangler.toml` `routes`:
   ```toml
   { pattern = "<new-domain>", custom_domain = true },
   { pattern = "www.<new-domain>", custom_domain = true },
   ```
   Deploy with `pnpm deploy:worker`. CF provisions the custom-hostname cert (~30s).

5. **Add to `HONEYPOT_HOSTNAMES`** in `packages/averrow-worker/src/index.ts` so the bait-page handlers fire on the new domain:
   ```ts
   const HONEYPOT_HOSTNAMES = new Set([
     "averrow.com", "www.averrow.com",
     ...,
     "<new-domain>", "www.<new-domain>",  // ← add
   ]);
   ```

6. **Add to `seed_domains` table** so the auto-seeder plants against the new bait paths on its next tick:
   ```bash
   curl -X POST "https://averrow.com/api/admin/seed-domains" \
     -H "Authorization: Bearer $JWT" \
     -H "Content-Type: application/json" \
     -d '{
       "domain": "<new-domain>",
       "notes": "Throwaway expansion domain — Wave 2.1 cohort"
     }'
   ```
   `pages` and `seeds_per_page` default to the standard four paths × 6 seeds/page = 24 fresh addresses per weekly auto-seeder tick.

7. **Verify** — Wait for the next auto-seeder tick (weekly, Sunday) or trigger manually via `POST /api/internal/agents/auto_seeder/run`. Confirm:
   ```bash
   wrangler d1 execute trust-radar-v2 --remote --command \
     "SELECT domain, COUNT(*) AS seeds FROM seed_addresses
      WHERE domain = '<new-domain>' AND status = 'active'
      GROUP BY domain"
   ```
   Expect ~24 rows the first tick (4 pages × 6 seeds), growing linearly each subsequent tick (auto-seeder appends, doesn't replace).

   Open `https://<new-domain>/admin-portal` in a browser — should render the bait page with five visible mailto links. View source to confirm the addresses match the freshly planted seeds.

## Pausing or retiring a domain

- **Pause** (stop new seeds, keep historical):
  ```bash
  curl -X PATCH "https://averrow.com/api/admin/seed-domains/<domain>" \
    -H "Authorization: Bearer $JWT" \
    -H "Content-Type: application/json" \
    -d '{"status":"paused"}'
  ```

- **Retire** (same as pause; convention is `retired` when the domain is permanently dead — e.g. registration lapsed):
  ```bash
  -d '{"status":"retired"}'
  ```

- **Hard delete** (super_admin only; rare — prefer `retired` so historical `seed_addresses` rows still resolve):
  ```bash
  curl -X DELETE "https://averrow.com/api/admin/seed-domains/<domain>" \
    -H "Authorization: Bearer $JWT"
  ```

## Why throwaways and not subdomains

Harvesters cluster their target lists by domain. Once `*.averrow.com` is in a list, *all* `*@averrow.com` addresses get the same level of attention — duplicating the bait surface inside one zone doesn't multiply yield. A separate domain creates a separate list-membership decision in the harvester. The audit's recommendation of 20 distinct domains is about maximizing distinct list memberships.

## Budget guidance

| Quantity | TLD mix | Annual cost (CHF/USD-ish) |
|---|---|---|
| 4 (today)   | mixed `.com`/`.ca` | ~$60-80 |
| 10 (Wave 2.1 minimum target) | mostly `.xyz`/`.online` | ~$30-50 |
| 20 (Wave 2.1 audit target) | mostly `.xyz`/`.fun`/`.click` | ~$50-80 |

Throwaway domains are bare hosting (no MX needed beyond Email Routing's free tier). Workers traffic on each is negligible — the bait pages are cached at the edge for 24h.

## Troubleshooting

- **New domain serves the bait page but the address list is empty / stale**: auto-seeder hasn't ticked yet. Trigger manually via `POST /api/internal/agents/auto_seeder/run`.

- **Bait page returns 404**: domain isn't in `HONEYPOT_HOSTNAMES` (src/index.ts) or the wrangler route hasn't propagated. Check `wrangler tail` while curling the URL.

- **`seed_domains` is empty in production**: migration 0181 hasn't been applied. Run `wrangler d1 migrations apply trust-radar-v2 --remote`.

- **Auto-seeder still planting only on averrow.com after adding new domains**: the agent fell back to the hardcoded `FALLBACK_TARGETS` because `loadActiveTargets()` errored or returned 0 rows. Check `agent_outputs WHERE agent_id='auto_seeder'` for the diagnostic line; the runtime D1 read is non-fatal so a transient failure is silent in agent_runs but logged in agent_outputs.

## Related

- `migrations/0181_seed_domains_config.sql` — schema
- `src/agents/auto-seeder.ts` — agent that consumes the table
- `src/handlers/seedDomains.ts` — admin endpoints
- `src/index.ts` — `HONEYPOT_HOSTNAMES` (hostname predicate) + per-path handlers
- `src/templates/honeypot-pages.ts` — bait-page templates
- `src/templates/robots-sitemap.ts` — `Disallow` list (the harvester signal)
