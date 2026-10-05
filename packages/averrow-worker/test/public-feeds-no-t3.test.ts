/**
 * GET /api/v1/public/feeds — disclosure register L19.
 *
 * The endpoint used to publish every enabled feed's name, vendor display
 * name, method description, health and per-feed volume (T3). It must now
 * return aggregate counts only, in a shape the frozen legacy SPA
 * (public/app.js loadFeeds: `res.data || []`, returns on empty) tolerates.
 */
import { describe, it, expect } from "vitest";
import { hasSqlite, openDerivedDb, d1FromSqlite, fakeKv } from "./sqlite-d1-harness";
import { handlePublicFeeds, publicFeedCategory } from "../src/handlers/public";
import type { Env } from "../src/types";

const FEEDS = [
  { name: "vendor_alpha_phish", display: "VendorAlpha Phishing Intel", desc: "checks DNS registration via VendorAlpha", type: "ingest", enabled: 1 },
  { name: "vendor_beta_urls", display: "VendorBeta URL Feed", desc: "pulls malicious URLs from VendorBeta", type: "ingest", enabled: 1 },
  { name: "vendor_gamma_rep", display: "VendorGamma Reputation", desc: "IP reputation lookups", type: "enrichment", enabled: 1 },
  { name: "secret_custom_feed", display: "Secret Custom", desc: "bespoke source", type: "vendor_specific_label", enabled: 1 },
  { name: "disabled_delta", display: "Delta (disabled)", desc: "off", type: "ingest", enabled: 0 },
];

describe("publicFeedCategory", () => {
  it("only echoes the generic allowlist; anything else collapses to other", () => {
    expect(publicFeedCategory("ingest")).toBe("ingest");
    expect(publicFeedCategory("ENRICHMENT")).toBe("enrichment");
    expect(publicFeedCategory("social")).toBe("social");
    expect(publicFeedCategory(null)).toBe("ingest");
    expect(publicFeedCategory("vendor_specific_label")).toBe("other");
  });
});

describe.skipIf(!hasSqlite())("GET /api/v1/public/feeds — no T3 (real SQLite)", () => {
  it("returns counts only — no feed names, vendors, descriptions, health or volumes", async () => {
    const raw = openDerivedDb(["feed_configs", "feed_status"]);
    for (const f of FEEDS) {
      raw.prepare(
        `INSERT INTO feed_configs (feed_name, display_name, description, schedule_cron, enabled, feed_type)
         VALUES (?, ?, ?, '0 * * * *', ?, ?)`,
      ).run(f.name, f.display, f.desc, f.enabled, f.type);
      raw.prepare(
        `INSERT INTO feed_status (feed_name, health_status, records_ingested_today) VALUES (?, 'healthy', 4242)`,
      ).run(f.name);
    }
    const env = { DB: d1FromSqlite(raw), CACHE: fakeKv() } as unknown as Env;

    const res = await handlePublicFeeds(new Request("https://averrow.com/api/v1/public/feeds"), env);
    expect(res.status).toBe(200);
    const text = await res.text();

    for (const f of FEEDS) {
      expect(text).not.toContain(f.name);
      expect(text).not.toContain(f.display);
      expect(text).not.toContain(f.desc);
    }
    expect(text).not.toContain("Vendor");
    expect(text).not.toContain("vendor_specific_label");
    expect(text).not.toContain("4242");
    expect(text).not.toContain("health");

    const body = JSON.parse(text) as {
      success: boolean; data: unknown[]; total_sources: number; by_category: Record<string, number>;
    };
    expect(body.success).toBe(true);
    // Legacy SPA maps `data`; an empty array renders nothing.
    expect(body.data).toEqual([]);
    expect(body.total_sources).toBe(4);
    expect(body.by_category).toEqual({ ingest: 2, enrichment: 1, other: 1 });
  });
});
