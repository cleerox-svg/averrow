import type { FeedModule } from "./types";

// ─── Ingest Feed Modules ────────────────────────────────────────
import { certstream } from "./certstream";
import { phishtank } from "./phishtank";
import { urlhaus } from "./urlhaus";
import { openphish } from "./openphish";
import { threatfox } from "./threatfox";
import { feodo } from "./feodo";
// PhishStats removed 2026-03 — service dead (522/404)
import { phishdestroy } from "./phishdestroy";
import { nrd_hagezi } from "./nrd_hagezi";
import { dshield } from "./dshield";
import { cins_army } from "./cins_army";
import { sslbl } from "./sslbl";
import { cloudflare_scanner } from "./cloudflare_scanner";
import { cloudflare_email } from "./cloudflare_email";
import { otx_alienvault } from "./otx_alienvault";
import { cisa_kev } from "./cisa_kev";
import { malwarebazaar } from "./malwarebazaar";
import { cisa_iran_iocs } from "./cisa_iran_iocs";

// ─── Ingest Feed Modules (continued) ────────────────────────────
import { blocklist_de } from "./blocklistde";
import { c2_tracker } from "./c2tracker";
import { spamhaus_drop } from "./spamhausDrop";
import { tor_exit_nodes } from "./torExitNodes";
import { emerging_threats } from "./emergingThreats";
import { disposable_email } from "./disposableEmail";

// ─── Social Feed Modules ────────────────────────────────────────
import { reddit } from "./reddit";
import { github } from "./github";
import { telegram } from "./telegram";
import { mastodon } from "./mastodon";

// ─── Enrichment Feed Modules ────────────────────────────────────
import { surbl } from "./surbl";
import { virustotal } from "./virustotal";
import { hibp_stealer_logs } from "./hibp";
import { google_safe_browsing } from "./googleSafeBrowsing";
import { spamhaus_dbl } from "./spamhausDbl";
import { abuseipdb } from "./abuseipdb";
import { circl_pdns } from "./circlPassiveDns";
import { greynoise } from "./greynoise";
import { seclookup } from "./seclookup";

// ─── Additional Ingest Feed Modules ────────────────────────────
import { c2_intel_feeds } from "./c2intelfeeds";
import { typosquat_scanner } from "./typosquat_scanner";

// ─── Tier-A volume adds (OSINT-expansion plan) ─────────────────
// Public, no-auth phishing feeds that complement the existing
// openphish / phishtank / urlhaus corpus. Each lands as its own
// feed_configs row + module here.
import { phishstats } from "./phishstats";
import { urlscanio } from "./urlscanio";

// ─── No-auth supplemental feeds ────────────────────────────────
// NIST NVD full CVE catalog (supplements CISA KEV with broader
// vuln coverage) + CryptoScamDB (crypto-specific phishing /
// scam URLs, valuable for fintech customers).
import { nvd_cve } from "./nvd_cve";
import { cryptoscamdb } from "./cryptoscamdb";

// ─── Generic STIX/TAXII 2.1 Consumer ────────────────────────────
// One module shared across every TAXII-backed collection; each
// subscribed collection is a feed_configs row whose feed_name
// (e.g. taxii_otx, taxii_circl) dispatches to `taxii` below.
// See lib/taxii-client.ts + lib/stix-parser.ts for the wire +
// parse layers.
import { taxii } from "./taxii";

/**
 * Registry mapping feed_name → FeedModule.
 * Keys match feed_configs.feed_name in the database.
 */
export const feedModules: Record<string, FeedModule> = {
  ct_logs: certstream,
  phishtank,
  urlhaus,
  openphish,
  threatfox,
  feodo,
  phishdestroy,
  nrd_hagezi,
  dshield,
  cins_army,
  sslbl,
  cloudflare_scanner,
  cloudflare_email,
  otx_alienvault,
  cisa_kev,
  malwarebazaar,
  blocklist_de,
  c2_tracker,
  spamhaus_drop,
  tor_exit_nodes,
  emerging_threats,
  disposable_email,
  c2_intel_feeds,
  typosquat_scanner,
  cisa_iran_iocs,

  // Tier-A volume adds — public, no-auth phishing feeds.
  phishstats,
  urlscanio,

  // Supplemental no-auth feeds — vulnerabilities + crypto scams.
  nvd_cve,
  cryptoscamdb,

  // STIX/TAXII collections — all dispatch to the same generic
  // module; the per-collection params live in feed_configs columns.
  taxii_otx: taxii,
};

/**
 * Enrichment feeds — run AFTER ingest feeds complete.
 * These query existing threats and add metadata/scores, rather than creating new threats.
 * Keys match feed_configs.feed_name where feed_type = 'enrichment'.
 */
/**
 * Social feeds — monitor social platforms for brand mentions.
 * These insert into social_mentions table (not threats directly).
 * Watchdog agent handles classification and escalation.
 * Keys match feed_configs.feed_name where feed_type = 'social'.
 */
export const socialModules: Record<string, FeedModule> = {
  reddit,
  github,
  telegram,
  mastodon,
};

export const enrichmentModules: Record<string, FeedModule> = {
  surbl,
  virustotal,
  hibp_stealer_logs,
  google_safe_browsing,
  spamhaus_dbl,
  abuseipdb,
  circl_pdns,
  greynoise,
  seclookup,
};
