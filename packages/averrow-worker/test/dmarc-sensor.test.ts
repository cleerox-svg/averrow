/**
 * Hosted DMARC aggregate reporting — the receiver, parser, enrollment gate,
 * source rollup, schema and staff read endpoints, against the
 * migration-derived schema (openMigratedDb) with NO error swallowing.
 *
 * Fixtures: a Google-style ZIP, a Microsoft-style GZIP and a namespaced
 * RFC 9990 (DMARCbis) report; a resent duplicate; a forged report for an
 * unenrolled domain; a subdomain report.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { deflateRawSync, gzipSync } from "node:zlib";
import { hasSqlite, openMigratedDb, d1FromSqlite, fakeKv, type SqliteDb, type StatementLogEntry } from "./sqlite-d1-harness";
import { PROD_DMARC_REPORT_RECORDS_DDL } from "./dmarc-prod-ddl";
import type { Env } from "../src/types";

const notify = vi.fn(async (_env: unknown, _opts: Record<string, unknown>) => 1);
vi.mock("../src/lib/notifications", () => ({
  createNotification: (env: unknown, opts: Record<string, unknown>) => notify(env, opts),
}));

import { handleDmarcEmail, dmarcReportDay, type EmailMessage } from "../src/dmarc-receiver";
import {
  parseDmarcAggregateXml,
  normalizeSourceIp,
  xmlElements,
  stripXmlComments,
} from "../src/lib/dmarc-aggregate-xml";
import {
  ruaIncludesAverrow,
  isDmarcRuaRecipient,
  DMARC_RUA_PRIMARY,
  DMARC_REPORT_AUTH_HOST,
  isRuaAuthorizationRequired,
  ruaAuthorizationRecordName,
} from "../src/lib/dmarc-rua";
import { brandDomainCandidates, readDmarcDrops24h } from "../src/lib/dmarc-enrollment";
import { recordDmarcPassed, runDmarcSourceRollup, clusterIdForIp } from "../src/lib/dmarc-source-rollup";
import {
  handleGetDmarcSetup,
  handleGetDmarcSpoofSources,
  deriveDmarcSetupState,
  mergeClassList,
} from "../src/handlers/dmarcReports";

// ─── Fixture builders ────────────────────────────────────────────────

interface FixtureRecord {
  ip: string;
  count: number;
  dkim: string;
  spf: string;
  headerFrom?: string;
  dkimAuth?: Array<{ d: string; r: string }>;
  spfAuth?: { d: string; r: string };
  reasons?: string[];
  disposition?: string;
}

function reportXml(opts: {
  org: string;
  reportId: string;
  domain: string;
  begin?: number;
  end?: number;
  records: FixtureRecord[];
  prefix?: string;
  dmarcbis?: boolean;
}): string {
  const p = opts.prefix ? `${opts.prefix}:` : "";
  const t = (name: string, inner: string) => `<${p}${name}>${inner}</${p}${name}>`;
  const begin = opts.begin ?? 1_763_078_400; // 2025-11-14 00:00:00Z
  const end = opts.end ?? begin + 86_399;
  const ns = opts.dmarcbis
    ? ` xmlns${opts.prefix ? `:${opts.prefix}` : ""}="urn:ietf:params:xml:ns:dmarc-2.0"`
    : "";
  const records = opts.records.map((r) =>
    t("record",
      t("row",
        t("source_ip", r.ip) + t("count", String(r.count)) +
        t("policy_evaluated",
          t("disposition", r.disposition ?? "none") + t("dkim", r.dkim) + t("spf", r.spf) +
          (r.reasons ?? []).map((x) => t("reason", t("type", x) + t("comment", "x"))).join(""))) +
      t("identifiers", t("header_from", r.headerFrom ?? opts.domain) + t("envelope_from", r.spfAuth?.d ?? opts.domain)) +
      t("auth_results",
        (r.dkimAuth ?? []).map((d) => t("dkim", t("domain", d.d) + t("selector", "s1") + t("result", d.r))).join("") +
        (r.spfAuth ? t("spf", t("domain", r.spfAuth.d) + t("scope", "mfrom") + t("result", r.spfAuth.r)) : ""))),
  ).join("\n");
  const policy = opts.dmarcbis
    ? t("domain", opts.domain) + t("p", "reject") + t("np", "reject") + t("testing", "n") + t("discovery_method", "treewalk")
    : t("domain", opts.domain) + t("adkim", "r") + t("aspf", "r") + t("p", "none") + t("pct", "100");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- generated <record> fixture -->
<${p}feedback${ns}>
${opts.dmarcbis ? "" : t("version", "1.0")}
${t("report_metadata", t("org_name", opts.org) + t("email", "noreply@reporter.example") + t("report_id", opts.reportId) + t("date_range", t("begin", String(begin)) + t("end", String(end))))}
${t("policy_published", policy)}
${records}
</${p}feedback>`;
}

function zipOne(name: string, data: Buffer): Buffer {
  const comp = deflateRawSync(data);
  const nameB = Buffer.from(name);
  const h = Buffer.alloc(30);
  h.writeUInt32LE(0x04034b50, 0);
  h.writeUInt16LE(20, 4);
  h.writeUInt16LE(8, 8);
  h.writeUInt32LE(comp.length, 18);
  h.writeUInt32LE(data.length, 22);
  h.writeUInt16LE(nameB.length, 26);
  // A trailing central-directory stub, as real archives carry.
  return Buffer.concat([h, nameB, comp, Buffer.from("PK\x01\x02central-directory-stub")]);
}

function mimeEmail(from: string, contentType: string, filename: string, body: Buffer): Uint8Array {
  const b64 = body.toString("base64").replace(/(.{76})/g, "$1\r\n");
  return new TextEncoder().encode(
    `From: ${from}\r\nTo: ${DMARC_RUA_PRIMARY}\r\nSubject: Report domain\r\nMIME-Version: 1.0\r\n` +
    `Content-Type: multipart/mixed; boundary="BOUND_1"\r\n\r\n` +
    `--BOUND_1\r\nContent-Type: text/plain\r\n\r\nThis is a DMARC aggregate report.\r\n` +
    `--BOUND_1\r\nContent-Type: ${contentType}; name="${filename}"\r\n` +
    `Content-Disposition: attachment; filename="${filename}"\r\nContent-Transfer-Encoding: base64\r\n\r\n` +
    `${b64}\r\n--BOUND_1--\r\n`,
  );
}

function emailMessage(from: string, raw: Uint8Array): EmailMessage {
  return {
    from,
    to: DMARC_RUA_PRIMARY,
    headers: new Headers(),
    raw: new Blob([raw]).stream() as ReadableStream<Uint8Array>,
    rawSize: raw.length,
    setReject: () => {
      throw new Error("setReject must never be called");
    },
    forward: async () => {},
  };
}

const googleZip = (xml: string) =>
  emailMessage("noreply-dmarc-support@google.com",
    mimeEmail("noreply-dmarc-support@google.com", "application/zip", "google.com!acme.example!1!2.zip", zipOne("google.com!acme.example!1!2.xml", Buffer.from(xml))));
const microsoftGzip = (xml: string) =>
  emailMessage("dmarcreport@microsoft.com",
    mimeEmail("dmarcreport@microsoft.com", "application/gzip", "enterprise.protection.outlook.com!acme.example!1!2.xml.gz", gzipSync(Buffer.from(xml))));
const plainXml = (xml: string) =>
  emailMessage("dmarc@reporter.example", mimeEmail("dmarc@reporter.example", "text/xml", "report.xml", Buffer.from(xml)));

// Four records: two DMARC passes (one aligned check each), two failures.
const ACME_RECORDS: FixtureRecord[] = [
  { ip: "198.51.100.10", count: 50, dkim: "pass", spf: "fail", dkimAuth: [{ d: "acme.example", r: "pass" }], spfAuth: { d: "fwd.example", r: "pass" } },
  { ip: "198.51.100.20", count: 30, dkim: "fail", spf: "pass", spfAuth: { d: "acme.example", r: "pass" } },
  { ip: "203.0.113.5", count: 40, dkim: "fail", spf: "fail", dkimAuth: [{ d: "evil.test", r: "pass" }], spfAuth: { d: "evil.test", r: "pass" } },
  { ip: "203.0.113.6", count: 30, dkim: "fail", spf: "fail", spfAuth: { d: "acme.example", r: "fail" } },
];

// ─── fetch stub: DoH + ipinfo ────────────────────────────────────────

const dnsTxt: Record<string, string[]> = {};
const geoOrg: Record<string, string> = {};
const fetchCalls: string[] = [];

function stubFetch(): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    fetchCalls.push(url);
    if (url.startsWith("https://cloudflare-dns.com/dns-query")) {
      const name = new URL(url).searchParams.get("name") ?? "";
      const recs = dnsTxt[name];
      return Response.json(recs
        ? { Status: 0, Answer: recs.map((r) => ({ name, type: 16, TTL: 300, data: `"${r}"` })) }
        : { Status: 3 });
    }
    if (url.startsWith("https://ipinfo.io/")) {
      const ip = url.slice("https://ipinfo.io/".length).split("/")[0]!;
      return Response.json({ ip, country: "NL", org: geoOrg[ip] ?? "AS64999 Example Hosting" });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

// ─── Unit: rua helpers ──────────────────────────────────────────────

describe("ruaIncludesAverrow / routing helpers", () => {
  it("parses mailto lists with size suffixes, case and encoding", () => {
    expect(ruaIncludesAverrow("mailto:dmarc_rua@averrow.ca")).toBe(true);
    expect(ruaIncludesAverrow("mailto:reports@acme.example,mailto:DMARC_RUA@Averrow.CA!10m")).toBe(true);
    expect(ruaIncludesAverrow("rua=mailto:x@y.example, MAILTO:dmarc_rua%40averrow.ca!50k")).toBe(true);
    expect(ruaIncludesAverrow("mailto:dmarc_rua@trustradar.ca")).toBe(true); // legacy
    expect(ruaIncludesAverrow("mailto:dmarc_rua@averrow.ca.evil.example")).toBe(false);
    expect(ruaIncludesAverrow("mailto:xdmarc_rua@averrow.ca")).toBe(false);
    expect(ruaIncludesAverrow("https://dmarc_rua@averrow.ca")).toBe(false);
    expect(ruaIncludesAverrow("mailto:reports@acme.example")).toBe(false);
    expect(ruaIncludesAverrow(null)).toBe(false);
    expect(ruaIncludesAverrow("")).toBe(false);
  });

  it("routes the primary + legacy addresses case-insensitively, nothing else", () => {
    expect(isDmarcRuaRecipient("dmarc_rua@averrow.ca")).toBe(true);
    expect(isDmarcRuaRecipient("DMARC_RUA@AVERROW.CA")).toBe(true);
    expect(isDmarcRuaRecipient("<dmarc_rua@averrow.ca>")).toBe(true);
    expect(isDmarcRuaRecipient("dmarc_rua@trustradar.ca")).toBe(true);
    expect(isDmarcRuaRecipient("dmarc_rua@averrow.com")).toBe(true);
    expect(isDmarcRuaRecipient("abuse@averrow.ca")).toBe(false);
    expect(isDmarcRuaRecipient("dmarc_rua@lrxradar.com")).toBe(false);
  });

  it("derives the report-authorization host from the primary address", () => {
    expect(DMARC_REPORT_AUTH_HOST).toBe("averrow.ca");
    expect(ruaAuthorizationRecordName("Acme.Example.")).toBe("acme.example._report._dmarc.averrow.ca");
    expect(isRuaAuthorizationRequired("acme.example")).toBe(true);
    expect(isRuaAuthorizationRequired("averrow.ca")).toBe(false);
    expect(isRuaAuthorizationRequired("mail.averrow.ca")).toBe(false);
  });

  it("brand candidates: the domain then its parents, bounded", () => {
    expect(brandDomainCandidates("WWW.Mail.Acme.Example.")).toEqual(["mail.acme.example", "acme.example"]);
    expect(brandDomainCandidates("a.b.c.d.e.f.example")).toHaveLength(5);
  });
});

// ─── Unit: parser ───────────────────────────────────────────────────

describe("parseDmarcAggregateXml", () => {
  it("DMARC pass = dkim OR spf (aligned)", () => {
    expect(recordDmarcPassed({ dkim_result: "pass", spf_result: "fail" })).toBe(true);
    expect(recordDmarcPassed({ dkim_result: "fail", spf_result: "pass" })).toBe(true);
    expect(recordDmarcPassed({ dkim_result: "fail", spf_result: "fail" })).toBe(false);
    expect(recordDmarcPassed({ dkim_result: "", spf_result: "softfail" })).toBe(false);
  });

  it("parses a prefixed RFC 9990 report incl. auth_results and reasons", () => {
    const xml = reportXml({
      org: "Reporter", reportId: "bis-1", domain: "acme.example", prefix: "dmarc", dmarcbis: true,
      records: [{ ip: "2001:DB8::1", count: 3, dkim: "fail", spf: "fail", disposition: "pass",
        reasons: ["policy_test_mode", "forwarded", "bogus_reason"],
        dkimAuth: [{ d: "Acme.Example", r: "fail" }], spfAuth: { d: "list.example", r: "pass" } }],
    });
    const r = parseDmarcAggregateXml(xml);
    expect(r?.domain).toBe("acme.example");
    expect(r?.dmarc_policy).toBe("reject");
    expect(r?.records).toHaveLength(1);
    const rec = r!.records[0]!;
    expect(rec.source_ip).toBe("2001:db8::1");
    expect(rec.disposition).toBe("pass");
    expect(rec.reasons).toEqual(["policy_test_mode", "forwarded", "other"]);
    expect(rec.dkim_auth).toEqual([{ domain: "acme.example", selector: "s1", result: "fail" }]);
    expect(rec.spf_auth).toEqual([{ domain: "list.example", scope: "mfrom", result: "pass" }]);
  });

  it("drops invalid IPs and non-positive counts, decodes and caps text", () => {
    const xml = reportXml({
      org: "Evil &amp; Co\u0007 <![CDATA[x]]>", reportId: "r", domain: "acme.example",
      records: [
        { ip: "999.1.1.1", count: 5, dkim: "fail", spf: "fail" },
        { ip: "1.2.3", count: 5, dkim: "fail", spf: "fail" },
        { ip: "203.0.113.9", count: 0, dkim: "fail", spf: "fail" },
        { ip: "203.0.113.10", count: 99_999_999_999, dkim: "fail", spf: "fail" },
      ],
    });
    const r = parseDmarcAggregateXml(xml)!;
    expect(r.records.map((x) => x.source_ip)).toEqual(["203.0.113.10"]);
    expect(r.records[0]!.message_count).toBe(1_000_000_000);
    expect(r.reporter_org.startsWith("Evil & Co")).toBe(true);
    expect(r.reporter_org).not.toMatch(/[\x00-\x1f]/);
    expect(normalizeSourceIp("::ffff:192.0.2.1")).toBe("::ffff:c000:201");
    expect(normalizeSourceIp("01.2.3.4")).toBeNull();
  });

  it("is linear on hostile unclosed input and ignores commented-out records", () => {
    const hostile = `<feedback><report_metadata><org_name>x</org_name></report_metadata>` +
      `<policy_published><domain>acme.example</domain></policy_published>` + "<record ".repeat(200_000);
    const t0 = Date.now();
    const r = parseDmarcAggregateXml(hostile);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r?.records).toEqual([]);
    expect(stripXmlComments("a<!-- <record>x</record> -->b<!-- open")).toBe("ab");
    expect(xmlElements("<a>1</a><x:a>2</x:a><a/><ab>no</ab>", "a").items).toEqual(["1", "2", ""]);
  });

  it("report day uses end − 1 s and clamps absurd dates", () => {
    const now = Date.parse("2026-11-14T12:00:00Z");
    const begin = Date.parse("2026-11-13T00:00:00Z") / 1000;
    expect(dmarcReportDay(begin, begin + 86_400, now)).toBe("2026-11-13");
    expect(dmarcReportDay(begin, begin + 86_399, now)).toBe("2026-11-13");
    expect(dmarcReportDay(1, 2, now)).toBe("2026-11-14");
  });
});

// ─── Schema ─────────────────────────────────────────────────────────

describe.skipIf(!hasSqlite())("migration 0329 schema", () => {
  it("dmarc_report_records matches the prod DDL exactly (columns + indexes)", () => {
    const migrated = openMigratedDb();
    const prod = openMigratedDb({ exclude: ["0329_dmarc_sensor.sql"] });
    for (const stmt of PROD_DMARC_REPORT_RECORDS_DDL) prod.exec(stmt);
    const cols = (db: SqliteDb) => db.prepare("PRAGMA table_info(dmarc_report_records)").all();
    expect(cols(migrated)).toEqual(cols(prod));
    const idx = (db: SqliteDb) =>
      (db.prepare("PRAGMA index_list(dmarc_report_records)").all() as Array<{ name: string; unique: number }>)
        .map((i) => ({ name: i.name, unique: i.unique, cols: db.prepare(`PRAGMA index_info(${i.name})`).all() }))
        .sort((a, b) => a.name.localeCompare(b.name));
    expect(idx(migrated)).toEqual(idx(prod));
  });

  it("is idempotent over a prod-shaped database (re-applying 0329 is a no-op)", () => {
    const db = openMigratedDb();
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const { resolve } = require("node:path") as typeof import("node:path");
    const sql = readFileSync(resolve(__dirname, "..", "migrations", "0329_dmarc_sensor.sql"), "utf8");
    expect(() => db.exec(sql)).not.toThrow();
  });
});

// ─── Receiver end-to-end ───────────────────────────────────────────

describe.skipIf(!hasSqlite())("DMARC receiver (migrated schema)", () => {
  let raw: SqliteDb;
  let log: StatementLogEntry[];
  let kv: ReturnType<typeof fakeKv>;
  let env: Env;

  const count = (sql: string): number => (raw.prepare(sql).all()[0] as { n: number }).n;

  beforeEach(() => {
    raw = openMigratedDb();
    log = [];
    kv = fakeKv();
    env = { DB: d1FromSqlite(raw, { log }), CACHE: kv } as unknown as Env;
    notify.mockClear();
    fetchCalls.length = 0;
    for (const k of Object.keys(dnsTxt)) delete dnsTxt[k];
    for (const k of Object.keys(geoOrg)) delete geoOrg[k];
    stubFetch();
    // 203.0.113.6 is unknown to threats; ipinfo puts it on Cloudflare
    // (multi-tenant) → unaligned_shared_esp, not a spoof candidate.
    geoOrg["203.0.113.6"] = "AS13335 Cloudflare, Inc.";

    const brand = raw.prepare("INSERT INTO brands (id, name, canonical_domain, tier) VALUES (?, ?, ?, ?)");
    brand.run("b_acme", "Acme", "acme.example", "customer");
    brand.run("b_other", "Other", "other.example", "monitored");
    // Acme publishes rua=mailto:dmarc_rua@averrow.ca — seen by a fresh scan.
    raw.prepare(
      `INSERT INTO email_security_scans (brand_id, domain, dmarc_exists, dmarc_policy, dmarc_rua, scanned_at)
       VALUES ('b_acme', 'acme.example', 1, 'none', 'mailto:ops@acme.example,mailto:dmarc_rua@averrow.ca!10m', datetime('now'))`,
    ).run();
    // 203.0.113.5 is known: two threat rows. The rollup picks the first in
    // (source_feed, rowid) order — the 'a_feed' row, inserted second.
    const threat = raw.prepare(
      `INSERT INTO threats (id, source_feed, threat_type, ip_address, asn, hosting_provider_id, country_code)
       VALUES (?, ?, 'phishing', ?, ?, ?, ?)`,
    );
    threat.run("t_z", "z_feed", "203.0.113.5", "AS1", "hp_AS1", "US");
    threat.run("t_a", "a_feed", "203.0.113.5", "AS64500", "hp_AS64500", "RU");
    raw.prepare("INSERT INTO hosting_providers (id, name, asn) VALUES ('hp_AS64500', 'Bad Host LLC', 'AS64500')").run();
    raw.prepare(
      `INSERT INTO spamhaus_asn_drop (asn, asn_number, as_name, first_seen, last_seen)
       VALUES ('AS64500', 64500, 'BAD-HOST', '2026-11-01', '2026-11-14')`,
    ).run();
    raw.prepare("INSERT INTO infrastructure_clusters (id, cluster_name) VALUES (?, 'op')").run(clusterIdForIp("203.0.113.5"));
    raw.prepare("INSERT INTO infrastructure_clusters (id, cluster_name, retired_reason) VALUES (?, 'old', 'shared_infra')")
      .run(clusterIdForIp("203.0.113.6"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const acme = (org: string, reportId: string, extra: Partial<Parameters<typeof reportXml>[0]> = {}) =>
    reportXml({ org, reportId, domain: "acme.example", records: ACME_RECORDS, ...extra });

  it("Google-style ZIP: stores with OR pass semantics, notifies, rolls up sources", async () => {
    const out = await handleDmarcEmail(googleZip(acme("google.com", "g-1")), env);
    expect(log.filter((l) => l.error)).toEqual([]);
    expect(out).toMatchObject({ status: "stored", brandId: "b_acme", pass: 80, fail: 70, storedRecords: 4 });

    const rep = raw.prepare("SELECT brand_id, total_messages, total_pass, total_fail, processed, process_error FROM dmarc_reports").all();
    expect(rep).toEqual([{ brand_id: "b_acme", total_messages: 150, total_pass: 80, total_fail: 70, processed: 1, process_error: null }]);
    const recs = raw.prepare("SELECT source_ip, dmarc_result, dkim_domain, spf_domain FROM dmarc_report_records ORDER BY source_ip").all();
    expect(recs).toEqual([
      { source_ip: "198.51.100.10", dmarc_result: "pass", dkim_domain: "acme.example", spf_domain: "fwd.example" },
      { source_ip: "198.51.100.20", dmarc_result: "pass", dkim_domain: null, spf_domain: "acme.example" },
      { source_ip: "203.0.113.5", dmarc_result: "fail", dkim_domain: "evil.test", spf_domain: "evil.test" },
      { source_ip: "203.0.113.6", dmarc_result: "fail", dkim_domain: null, spf_domain: "acme.example" },
    ]);
    const stats = raw.prepare("SELECT domain, brand_id, date, total_messages, passed, failed, top_fail_ips, reporters FROM dmarc_daily_stats").all() as Array<Record<string, unknown>>;
    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({ domain: "acme.example", brand_id: "b_acme", total_messages: 150, passed: 80, failed: 70 });
    expect(JSON.parse(String(stats[0]!.top_fail_ips))).toEqual([{ ip: "203.0.113.5", count: 40 }, { ip: "203.0.113.6", count: 30 }]);
    expect(raw.prepare("SELECT verified_via FROM dmarc_enrollment WHERE brand_id = 'b_acme' AND last_report_at IS NOT NULL").all())
      .toEqual([{ verified_via: "scan" }]);

    // Notification: corrected rate (70/150 = 47%), no reporter free text.
    expect(notify).toHaveBeenCalledTimes(1);
    const opts = notify.mock.calls[0]![1];
    expect(opts).toMatchObject({ audience: "tenant", brandId: "b_acme", type: "email_security_change", severity: "high" });
    expect(String(opts.message)).toContain("47%");
    expect(`${String(opts.title)} ${String(opts.message)}`).not.toContain("google.com");

    // Rollup: failing IPs only, joined against platform intel.
    const src = raw.prepare(
      `SELECT source_ip, messages, fail_messages, source_class, source_rule, asn, as_org, country_code,
              hosting_provider_id, cluster_id, asn_drop_listed, reporters
       FROM dmarc_source_daily ORDER BY source_ip`,
    ).all() as Array<Record<string, unknown>>;
    expect(src).toHaveLength(2);
    expect(src[0]).toMatchObject({
      source_ip: "203.0.113.5", messages: 40, fail_messages: 40, source_class: "spoof_candidate",
      source_rule: "R7_no_legitimacy_evidence", asn: "AS64500", as_org: "Bad Host LLC", country_code: "RU",
      hosting_provider_id: "hp_AS64500", cluster_id: clusterIdForIp("203.0.113.5"), asn_drop_listed: 1,
      reporters: JSON.stringify(["google.com"]),
    });
    // 203.0.113.6: unknown to threats → ipinfo; its cluster is retired → none.
    expect(src[1]).toMatchObject({
      source_ip: "203.0.113.6", source_class: "unaligned_shared_esp", source_rule: "R6_shared_sending_asn",
      asn: "AS13335", as_org: "Cloudflare, Inc.", country_code: "NL", cluster_id: null, asn_drop_listed: 0,
    });
    // Write-back onto the report's records (keeps Cartographer Phase 4 off them).
    expect(raw.prepare("SELECT asn, country_code FROM dmarc_report_records WHERE source_ip = '203.0.113.6'").all())
      .toEqual([{ asn: "AS13335", country_code: "NL" }]);
    // Enrolled via the scan: no DoH lookup was needed.
    expect(fetchCalls.filter((u) => u.includes("cloudflare-dns.com"))).toEqual([]);
  });

  it("Microsoft-style GZIP from a second reporter merges the day; a resend changes nothing", async () => {
    await handleDmarcEmail(googleZip(acme("google.com", "g-1")), env);
    const ms = await handleDmarcEmail(microsoftGzip(acme("Enterprise Outlook", "ms-1")), env);
    expect(ms.status).toBe("stored");

    const statsOf = () => raw.prepare("SELECT total_messages, passed, failed, top_fail_ips, reporters FROM dmarc_daily_stats").all() as Array<Record<string, unknown>>;
    const after2 = statsOf();
    expect(after2[0]).toMatchObject({ total_messages: 300, passed: 160, failed: 140 });
    expect(JSON.parse(String(after2[0]!.top_fail_ips))).toEqual([{ ip: "203.0.113.5", count: 80 }, { ip: "203.0.113.6", count: 60 }]);
    expect(JSON.parse(String(after2[0]!.reporters)).sort()).toEqual(["Enterprise Outlook", "google.com"]);
    expect(raw.prepare("SELECT messages, reporters FROM dmarc_source_daily WHERE source_ip = '203.0.113.5'").all())
      .toEqual([{ messages: 80, reporters: JSON.stringify(["Enterprise Outlook", "google.com"]) }]);

    // Resend of the Microsoft report: dropped before any write.
    notify.mockClear();
    const dup = await handleDmarcEmail(microsoftGzip(acme("Enterprise Outlook", "ms-1")), env);
    expect(dup).toEqual({ status: "dropped", reason: "duplicate" });
    expect(count("SELECT COUNT(*) AS n FROM dmarc_reports")).toBe(2);
    expect(count("SELECT COUNT(*) AS n FROM dmarc_report_records")).toBe(8);
    expect(statsOf()).toEqual(after2);
    expect(raw.prepare("SELECT messages FROM dmarc_source_daily WHERE source_ip = '203.0.113.5'").all()).toEqual([{ messages: 80 }]);
    expect(notify).not.toHaveBeenCalled();
    expect((await readDmarcDrops24h(env)).duplicate).toBe(1);
  });

  it("a report without report_id dedups on the XML hash", async () => {
    const xml = acme("Tiny Receiver", "");
    expect((await handleDmarcEmail(plainXml(xml), env)).status).toBe("stored");
    expect(await handleDmarcEmail(plainXml(xml), env)).toEqual({ status: "dropped", reason: "duplicate" });
    expect(raw.prepare("SELECT report_id FROM dmarc_report_seen").all()).toEqual([
      { report_id: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) as unknown as string },
    ]);
  });

  it("forged report for an unenrolled brand / non-brand: nothing stored, nothing notified, counted", async () => {
    dnsTxt["_dmarc.other.example"] = ["v=DMARC1; p=reject; rua=mailto:reports@other.example"];
    const forged = reportXml({ org: "Attacker", reportId: "f-1", domain: "other.example", records: ACME_RECORDS });
    expect(await handleDmarcEmail(plainXml(forged), env)).toEqual({ status: "dropped", reason: "unenrolled" });
    const nobody = reportXml({ org: "Attacker", reportId: "f-2", domain: "nobody.example", records: ACME_RECORDS });
    expect(await handleDmarcEmail(plainXml(nobody), env)).toEqual({ status: "dropped", reason: "no_brand" });

    for (const t of ["dmarc_reports", "dmarc_report_records", "dmarc_daily_stats", "dmarc_report_seen", "dmarc_source_daily", "dmarc_enrollment"]) {
      expect(count(`SELECT COUNT(*) AS n FROM ${t}`), t).toBe(0);
    }
    expect(notify).not.toHaveBeenCalled();
    const drops = await readDmarcDrops24h(env);
    expect(drops).toMatchObject({ unenrolled: 1, no_brand: 1 });
    // The negative live verdict is cached: a second forged report does no DoH.
    const before = fetchCalls.length;
    await handleDmarcEmail(plainXml(reportXml({ org: "Attacker", reportId: "f-3", domain: "other.example", records: ACME_RECORDS })), env);
    expect(fetchCalls.length).toBe(before);
    // Brand lookup is the indexed IN-list only — never LOWER(name).
    expect(log.some((l) => /LOWER\(name\)/i.test(l.sql))).toBe(false);
  });

  it("live DNS enrollment: a brand whose _dmarc names us is accepted without a scan", async () => {
    dnsTxt["_dmarc.other.example"] = ["v=DMARC1; p=none; rua=mailto:dmarc_rua@averrow.ca"];
    const out = await handleDmarcEmail(plainXml(reportXml({ org: "R", reportId: "o-1", domain: "other.example", records: ACME_RECORDS.slice(0, 1) })), env);
    expect(out.status).toBe("stored");
    expect(raw.prepare("SELECT verified_via FROM dmarc_enrollment WHERE brand_id = 'b_other'").all()).toEqual([{ verified_via: "live_dns" }]);
  });

  it("subdomain report rolls into the parent brand; RFC 9990 namespaced shape parses", async () => {
    const xml = reportXml({
      org: "Bis Receiver", reportId: "sub-1", domain: "mail.acme.example", prefix: "d", dmarcbis: true,
      records: [{ ip: "203.0.113.5", count: 12, dkim: "fail", spf: "fail", headerFrom: "mail.acme.example", reasons: ["mailing_list"],
        dkimAuth: [{ d: "acme.example", r: "fail" }], spfAuth: { d: "lists.example", r: "pass" } }],
    });
    const out = await handleDmarcEmail(plainXml(xml), env);
    expect(out).toMatchObject({ status: "stored", brandId: "b_acme", pass: 0, fail: 12 });
    expect(raw.prepare("SELECT domain, brand_id FROM dmarc_reports").all()).toEqual([{ domain: "mail.acme.example", brand_id: "b_acme" }]);
    expect(raw.prepare("SELECT domain FROM dmarc_daily_stats").all()).toEqual([{ domain: "acme.example" }]);
    expect(raw.prepare("SELECT source_class, source_rule FROM dmarc_source_daily").all())
      .toEqual([{ source_class: "forwarder_likely", source_rule: "R2_receiver_forwarding_override" }]);
    // < 100 messages → no notification.
    expect(notify).not.toHaveBeenCalled();
  });

  it("the rollup's class merge keeps the most suspicious class across reports", async () => {
    await handleDmarcEmail(plainXml(reportXml({
      org: "A", reportId: "m-1", domain: "acme.example",
      records: [{ ip: "203.0.113.5", count: 5, dkim: "fail", spf: "fail", reasons: ["forwarded"] }],
    })), env);
    await handleDmarcEmail(plainXml(reportXml({
      org: "B", reportId: "m-2", domain: "acme.example",
      records: [{ ip: "203.0.113.5", count: 7, dkim: "fail", spf: "fail" }],
    })), env);
    await handleDmarcEmail(plainXml(reportXml({
      org: "C", reportId: "m-3", domain: "acme.example",
      records: [{ ip: "203.0.113.5", count: 1, dkim: "fail", spf: "fail", reasons: ["trusted_forwarder"] }],
    })), env);
    expect(raw.prepare("SELECT messages, fail_messages, source_class, source_rule FROM dmarc_source_daily").all())
      .toEqual([{ messages: 13, fail_messages: 13, source_class: "spoof_candidate", source_rule: "R7_no_legitimacy_evidence" }]);
  });

  it("threats lookup: one deterministic row per IP, one index seek, no sort", async () => {
    await runDmarcSourceRollup(env, {
      brandId: "b_acme", date: "2026-11-14", reporterOrg: "x", reportRowId: 0,
      firstSeen: "2026-11-14T00:00:00.000Z", lastSeen: "2026-11-14T23:59:59.000Z",
      records: [{ source_ip: "203.0.113.5", message_count: 1, disposition: "none", dkim_result: "fail", spf_result: "fail",
        reasons: [], header_from: "acme.example", envelope_from: "", envelope_to: "", dkim_auth: [], spf_auth: [] }],
    });
    const q = log.find((l) => /FROM v JOIN threats t/.test(l.sql))!;
    const plan = raw.prepare(`EXPLAIN QUERY PLAN ${q.sql}`).all(...(q.binds ?? [])) as Array<{ detail: string }>;
    const details = plan.map((p) => p.detail).join(" | ");
    expect(details).toMatch(/SEARCH t2 USING (COVERING )?INDEX idx_threats_ip_source_feed \(ip_address=\?\)/);
    expect(details).not.toMatch(/TEMP B-TREE|SCAN t2\b|SCAN threats/);
    expect(raw.prepare("SELECT asn FROM dmarc_source_daily").all()).toEqual([{ asn: "AS64500" }]);
  });

  it("staff endpoints: setup state and spoof-sources read the rollup", async () => {
    await handleDmarcEmail(googleZip(acme("google.com", "g-1")), env);
    // D1 Sessions API shim: the handlers read through getReadSession.
    const session = Object.assign(Object.create(env.DB) as object, { getBookmark: () => null });
    const sessionEnv = { ...env, DB: Object.assign(env.DB, { withSession: () => session }) } as unknown as Env;
    dnsTxt["acme.example._report._dmarc.averrow.ca"] = ["v=DMARC1;"];

    const setupRes = await handleGetDmarcSetup(new Request("https://x.test/api/dmarc-reports/b_acme/setup"), sessionEnv, "b_acme");
    const setup = (await setupRes.json()) as { data: Record<string, unknown>; error?: string };
    expect(setup.error).toBeUndefined();
    expect(setup.data).toMatchObject({
      state: "receiving", rua_value: "rua=mailto:dmarc_rua@averrow.ca", rua_includes_averrow: true,
      authorization_required: true, authorization_record_ok: true,
      authorization_record_name: "acme.example._report._dmarc.averrow.ca", enrolled: true,
    });

    const bad = await handleGetDmarcSpoofSources(new Request("https://x.test/api/dmarc-reports/b_acme/spoof-sources?days=9"), sessionEnv, "b_acme");
    expect(bad.status).toBe(400);
    // Report dates are fixtures in 2025 → use rows dated today for the window.
    raw.prepare("UPDATE dmarc_source_daily SET date = ?").run(new Date().toISOString().slice(0, 10));
    raw.prepare("UPDATE dmarc_daily_stats SET date = ?").run(new Date().toISOString().slice(0, 10));
    const res = await handleGetDmarcSpoofSources(new Request("https://x.test/api/dmarc-reports/b_acme/spoof-sources?days=30"), sessionEnv, "b_acme");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { sources: Array<Record<string, unknown>>; daily: unknown[]; summary: Record<string, unknown> } };
    expect(body.data.sources[0]).toMatchObject({
      source_ip: "203.0.113.5", source_class: "spoof_candidate", fail_messages: 40,
      provider: { id: "hp_AS64500", name: "Bad Host LLC" }, asn_drop_listed: true,
    });
    expect(body.data.daily).toEqual([{ date: expect.any(String) as unknown as string, total: 150, passed: 80, failed: 70 }]);
    expect(body.data.summary).toMatchObject({ sources: 2, spoof_candidate_sources: 1 });
    // KV-cached for 300s.
    expect(kv.store.has("dmarc:spoof_sources:v1:b_acme:30")).toBe(true);
    // No request-time aggregation over dmarc_report_records.
    expect(log.some((l) => /FROM dmarc_report_records[\s\S]*GROUP BY/i.test(l.sql))).toBe(false);
  });
});

describe("setup state machine / class list", () => {
  const now = Date.parse("2026-11-14T00:00:00Z");
  it("derives every state", () => {
    expect(deriveDmarcSetupState({ lastReportAt: "2026-11-13 10:00:00", ruaIncludesAverrow: true, dmarcRecordExists: true, nowMs: now })).toBe("receiving");
    expect(deriveDmarcSetupState({ lastReportAt: "2026-10-01 10:00:00", ruaIncludesAverrow: true, dmarcRecordExists: true, nowMs: now })).toBe("stale");
    expect(deriveDmarcSetupState({ lastReportAt: null, ruaIncludesAverrow: true, dmarcRecordExists: true, nowMs: now })).toBe("awaiting_reports");
    expect(deriveDmarcSetupState({ lastReportAt: null, ruaIncludesAverrow: false, dmarcRecordExists: true, nowMs: now })).toBe("rua_missing");
    expect(deriveDmarcSetupState({ lastReportAt: null, ruaIncludesAverrow: false, dmarcRecordExists: false, nowMs: now })).toBe("no_dmarc");
  });
  it("merges a group_concat class list with the classifier's order", () => {
    expect(mergeClassList("forwarder_likely,spoof_candidate,aligned_pass")).toBe("spoof_candidate");
    expect(mergeClassList("forwarder_likely,bogus")).toBe("forwarder_likely");
    expect(mergeClassList(null)).toBe("aligned_pass");
  });
});
