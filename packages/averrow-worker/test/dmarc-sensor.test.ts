/**
 * Hosted DMARC aggregate reporting — the receiver, parser, provenance,
 * intake gates, rate caps, source rollup (+ Navigator catch-up), retention,
 * schema and staff read endpoints, against the migration-derived schema
 * (openMigratedDb) with NO error swallowing.
 *
 * Fixtures: a Google-style ZIP and a Microsoft-style GZIP (both from a
 * known reporter with a trusted Authentication-Results header → verified),
 * a namespaced RFC 9990 report and plain-XML mail from an unknown sender
 * (unverified); a resent duplicate; forged reports for unenrolled /
 * ineligible brands; a subdomain report.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { deflateRawSync, gzipSync } from "node:zlib";
import { hasSqlite, openMigratedDb, d1FromSqlite, fakeKv, sqlContaining, type SqliteDb, type StatementLogEntry } from "./sqlite-d1-harness";
import { PROD_DMARC_REPORT_RECORDS_DDL } from "./dmarc-prod-ddl";
import type { Env } from "../src/types";

const notify = vi.fn(async (_env: unknown, _opts: Record<string, unknown>) => 1);
vi.mock("../src/lib/notifications", () => ({
  createNotification: (env: unknown, opts: Record<string, unknown>) => notify(env, opts),
}));

import { handleDmarcEmail, dmarcReportDay, clampReportVolume, type EmailMessage } from "../src/dmarc-receiver";
import {
  parseDmarcAggregateXml,
  isDmarcReportInWindow,
  normalizeSourceIp,
  xmlElements,
  stripXmlComments,
  dmarcReportEpochIso,
  encodeRecordAuth,
  decodeRecordAuth,
} from "../src/lib/dmarc-aggregate-xml";
import {
  ruaIncludesAverrow,
  isDmarcRuaRecipient,
  DMARC_RUA_PRIMARY,
  DMARC_REPORT_AUTH_HOST,
  isRuaAuthorizationRequired,
  ruaAuthorizationRecordName,
} from "../src/lib/dmarc-rua";
import {
  brandDomainCandidates,
  readDmarcDrops24h,
  isDmarcEligibleBrand,
  DMARC_BRAND_DAILY_CAP,
  DMARC_GLOBAL_HOURLY_CAP,
} from "../src/lib/dmarc-enrollment";
import { readDmarcProvenance, KNOWN_RUA_REPORTERS, TRUSTED_AUTHSERV_IDS } from "../src/lib/dmarc-provenance";
import { geoEnrichDmarcRecords, DMARC_GEO_QUEUE_SQL } from "../src/lib/dmarc-record-geo";
import {
  recordDmarcPassed,
  runDmarcSourceRollup,
  runDmarcRollupCatchUp,
  rollupStoredDmarcReport,
  DMARC_STALE_RESET_SQL,
  DMARC_ROLLUP_MAX_ATTEMPTS,
  clusterIdForIp,
  isReservedForGeo,
  pickDkimDomain,
  DMARC_ROLLUP_LIMITS,
  DMARC_ROLLUP_PENDING_SQL,
} from "../src/lib/dmarc-source-rollup";
import {
  purgeExpiredDmarcData,
  DMARC_EXPIRED_REPORTS_SQL,
  DMARC_SOURCES_PURGE_SQL,
  DMARC_SEEN_PURGE_SQL,
  DMARC_COUNTERS_PURGE_SQL,
  DMARC_SEEN_RETENTION_DAYS,
} from "../src/lib/dmarc-retention";
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
  // Default: yesterday 00:00:00Z – 23:59:59Z (inside the accepted window).
  const begin = opts.begin ?? (Math.floor(Date.now() / 86_400_000) - 1) * 86_400;
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

function mimeEmail(from: string, contentType: string, filename: string, body: Buffer, extraHeaders = "", b64Override?: string): Uint8Array {
  const b64 = b64Override ?? body.toString("base64").replace(/(.{76})/g, "$1\r\n");
  return new TextEncoder().encode(
    `${extraHeaders}From: ${from}\r\nTo: ${DMARC_RUA_PRIMARY}\r\nSubject: Report domain\r\nMIME-Version: 1.0\r\n` +
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

/** What our receiving MTA would prepend for an authenticated reporter. */
const trustedAr = (d: string) =>
  `Authentication-Results: mx.cloudflare.net; dkim=pass header.d=${d} header.s=s1; spf=pass smtp.mailfrom=${d}; dmarc=pass header.from=${d}\r\n`;

const GOOGLE = "noreply-dmarc-support@google.com";
const MICROSOFT = "dmarcreport@microsoft.com";
const googleZip = (xml: string) =>
  emailMessage(GOOGLE, mimeEmail(GOOGLE, "application/zip", "google.com!acme.example!1!2.zip",
    zipOne("google.com!acme.example!1!2.xml", Buffer.from(xml)), trustedAr("google.com")));
const microsoftGzip = (xml: string) =>
  emailMessage(MICROSOFT, mimeEmail(MICROSOFT, "application/gzip", "enterprise.protection.outlook.com!acme.example!1!2.xml.gz",
    gzipSync(Buffer.from(xml)), trustedAr("microsoft.com")));
const plainXml = (xml: string) =>
  emailMessage("dmarc@reporter.example", mimeEmail("dmarc@reporter.example", "text/xml", "report.xml", Buffer.from(xml)));

/** A public, non-reserved IP unknown to the threats table (ipinfo → Cloudflare). */
const GEO_IP = "45.155.205.6";

// Four records: two DMARC passes (one aligned check each), two failures.
const ACME_RECORDS: FixtureRecord[] = [
  { ip: "198.51.100.10", count: 50, dkim: "pass", spf: "fail", dkimAuth: [{ d: "acme.example", r: "pass" }], spfAuth: { d: "fwd.example", r: "pass" } },
  { ip: "198.51.100.20", count: 30, dkim: "fail", spf: "pass", spfAuth: { d: "acme.example", r: "pass" } },
  { ip: "203.0.113.5", count: 40, dkim: "fail", spf: "fail", dkimAuth: [{ d: "x.test", r: "fail" }, { d: "evil.test", r: "pass" }], spfAuth: { d: "evil.test", r: "pass" } },
  { ip: GEO_IP, count: 30, dkim: "fail", spf: "fail", spfAuth: { d: "acme.example", r: "fail" } },
];

// ─── fetch stub: DoH + ipinfo ────────────────────────────────────────

const dnsTxt: Record<string, string[]> = {};
const dnsFail = new Set<string>();
const geoOrg: Record<string, string> = {};
const fetchCalls: string[] = [];

function stubFetch(): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    fetchCalls.push(url);
    if (url.startsWith("https://cloudflare-dns.com/dns-query")) {
      const name = new URL(url).searchParams.get("name") ?? "";
      if (dnsFail.has(name)) return Response.json({ Status: 2 });
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

const today = () => new Date().toISOString().slice(0, 10);

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

// ─── Unit: parser, clamps ───────────────────────────────────────────

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
    const rec = r!.records[0]!;
    expect(rec.source_ip).toBe("2001:db8::1");
    expect(rec.disposition).toBe("pass");
    expect(rec.reasons).toEqual(["policy_test_mode", "forwarded", "other"]);
    expect(rec.dkim_auth).toEqual([{ domain: "acme.example", selector: "s1", result: "fail" }]);
    expect(rec.spf_auth).toEqual([{ domain: "list.example", scope: "mfrom", result: "pass" }]);
    // auth_json round-trip (what the Navigator catch-up re-classifies from).
    const back = decodeRecordAuth(encodeRecordAuth(rec));
    expect(back.reasons).toEqual(rec.reasons);
    expect(back.dkim_auth.map((d) => [d.domain, d.result])).toEqual([["acme.example", "fail"]]);
    expect(back.spf_auth).toEqual(rec.spf_auth);
    expect(decodeRecordAuth("{not json")).toEqual({ reasons: [], dkim_auth: [], spf_auth: [] });
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
    expect(r.records[0]!.message_count).toBe(10_000_000);
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

  it("report day and timestamps use the same clamp window (S2)", () => {
    const now = Date.parse("2026-11-14T12:00:00Z");
    const begin = Date.parse("2026-11-13T00:00:00Z") / 1000;
    expect(dmarcReportDay(begin, begin + 86_400, now)).toBe("2026-11-13");
    expect(dmarcReportDay(begin, begin + 86_399, now)).toBe("2026-11-13");
    expect(dmarcReportDay(1, 2, now)).toBe("2026-11-14");
    expect(dmarcReportEpochIso(begin, now)).toBe("2026-11-13T00:00:00.000Z");
    // A 12-digit epoch used to yield "+033658-…" and win MIN()/MAX() forever.
    expect(dmarcReportEpochIso(999_999_999_999, now)).toBe("2026-11-14T12:00:00.000Z");
    expect(dmarcReportEpochIso(0, now)).toBe("2026-11-14T12:00:00.000Z");
  });

  it("clamps absurd per-report totals, keeping the fail rate (B3c)", () => {
    const rec = (ip: string, n: number, pass: boolean) => ({
      source_ip: ip, message_count: n, disposition: "none", dkim_result: pass ? "pass" : "fail", spf_result: "fail",
      reasons: [], header_from: "acme.example", envelope_from: "", envelope_to: "", dkim_auth: [], spf_auth: [],
    });
    const { records, clamped } = clampReportVolume([rec("1.1.1.1", 10_000_000, true), ...Array.from({ length: 9 }, (_, i) => rec(`1.1.1.${i + 2}`, 10_000_000, false))]);
    expect(clamped).toBe(true);
    const total = records.reduce((n, r) => n + r.message_count, 0);
    expect(total).toBeLessThanOrEqual(50_000_000);
    expect(records[0]!.message_count / total).toBeCloseTo(0.1, 3);
    expect(clampReportVolume([rec("1.1.1.1", 5, false)]).clamped).toBe(false);
  });

  it("S6: dkim_domain prefers a passing, then a brand-related signature", () => {
    const base = { header_from: "acme.example" };
    expect(pickDkimDomain({ ...base, dkim_auth: [{ domain: "x.test", selector: "", result: "fail" }, { domain: "esp.test", selector: "", result: "pass" }] })).toBe("esp.test");
    expect(pickDkimDomain({ ...base, dkim_auth: [{ domain: "x.test", selector: "", result: "fail" }, { domain: "mail.acme.example", selector: "", result: "fail" }] })).toBe("mail.acme.example");
    expect(pickDkimDomain({ ...base, dkim_auth: [] })).toBeNull();
  });

  it("S9: reserved / private / documentation ranges never go to ipinfo", () => {
    for (const ip of ["10.1.1.1", "100.64.0.1", "0.1.2.3", "127.0.0.1", "192.0.2.1", "198.18.0.1", "198.19.255.1", "198.51.100.4", "203.0.113.4", "2001:db8::1"]) {
      expect(isReservedForGeo(ip), ip).toBe(true);
    }
    expect(isReservedForGeo(GEO_IP)).toBe(false);
  });
});

// ─── Unit: provenance + eligibility ─────────────────────────────────

// ─── Unit: provenance + eligibility ─────────────────────────────────

/** The trusted set an operator would enable after the canary. */
const TRUST = { trustedAuthservIds: new Set(["mx.cloudflare.net"]) };
const yesterday = () => new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

describe("readDmarcProvenance (H1/H2)", () => {
  const msg = (headers: string) => `${headers}Subject: x\r\n\r\nbody`;
  const google = `${trustedAr("google.com")}From: Google <noreply-dmarc-support@google.com>\r\n`;

  it("ships disabled: the trusted authserv set is empty, so nothing is verified", () => {
    expect(TRUSTED_AUTHSERV_IDS.size).toBe(0);
    const p = readDmarcProvenance(msg(google), "");
    expect(p).toEqual({ senderDomain: "google.com", senderAuth: null, verified: false });
  });

  it("verified (trusted set injected): exact reporter address + exact signing domain", () => {
    const p = readDmarcProvenance(msg(google), "bounce@google.com", TRUST);
    expect(p).toMatchObject({ senderDomain: "google.com", verified: true });
    expect(p.senderAuth).toContain("dkim=pass(google.com)");
    expect(readDmarcProvenance(msg(`${trustedAr("microsoft.com")}From: dmarcreport@microsoft.com\r\n`), "", TRUST).verified).toBe(true);
    expect([...KNOWN_RUA_REPORTERS.keys()]).toEqual(["noreply-dmarc-support@google.com", "dmarcreport@microsoft.com"]);
  });

  it("unverified: consumer mailboxes, other addresses, subdomain signers, ARC, forged / untrusted headers", () => {
    // Anyone can hold a free mailbox and pass DKIM for it honestly.
    for (const d of ["yahoo.com", "outlook.com", "mail.ru", "gmail.com"]) {
      expect(readDmarcProvenance(msg(`${trustedAr(d)}From: me@${d}\r\n`), "", TRUST).verified, d).toBe(false);
    }
    // A different @google.com address, or a pass for a google.com subdomain.
    expect(readDmarcProvenance(msg(`${trustedAr("google.com")}From: someone@google.com\r\n`), "", TRUST).verified).toBe(false);
    expect(readDmarcProvenance(msg(`${trustedAr("mail.google.com")}From: noreply-dmarc-support@google.com\r\n`), "", TRUST).verified).toBe(false);
    // ARC-Authentication-Results is never trusted by authserv-id alone.
    expect(readDmarcProvenance(msg(`ARC-Authentication-Results: i=1; mx.cloudflare.net; dkim=pass header.d=google.com\r\nFrom: noreply-dmarc-support@google.com\r\n`), "", TRUST).verified).toBe(false);
    // Untrusted authserv-id; an attacker's header BELOW a failing topmost one.
    expect(readDmarcProvenance(msg(`Authentication-Results: mx.evil.example; dkim=pass header.d=google.com\r\nFrom: noreply-dmarc-support@google.com\r\n`), "", TRUST).verified).toBe(false);
    expect(readDmarcProvenance(msg(`Authentication-Results: mx.cloudflare.net; dkim=fail header.d=google.com; dmarc=fail header.from=google.com\r\n${google}`), "", TRUST).verified).toBe(false);
    expect(readDmarcProvenance(msg(""), "bounces@Mailer.Example").senderDomain).toBe("mailer.example");
  });
});

describe("isDmarcEligibleBrand (B1a + trusted-brand rule)", () => {
  it("needs monitored/customer tier AND the trusted-brand rule AND no shared hosting", () => {
    expect(isDmarcEligibleBrand({ canonical_domain: "acme.example", tier: "customer", trusted: 1 })).toBe(true);
    expect(isDmarcEligibleBrand({ canonical_domain: "acme.example", tier: "monitored", trusted: 0 })).toBe(false);
    expect(isDmarcEligibleBrand({ canonical_domain: "acme.example", tier: "tracked", trusted: 1 })).toBe(false);
    expect(isDmarcEligibleBrand({ canonical_domain: "acme.github.io", tier: "monitored", trusted: 1 })).toBe(false);
  });
});

describe("report date window (L2)", () => {
  const now = Date.parse("2026-11-14T12:00:00Z");
  const sec = (iso: string) => Date.parse(iso) / 1000;
  it("accepts an end within [now − 60 d, now + 2 d]; rejects everything else", () => {
    expect(isDmarcReportInWindow(sec("2026-11-13T00:00:00Z"), sec("2026-11-13T23:59:59Z"), now)).toBe(true);
    // now − 60 d = 2026-09-15T12:00Z.
    expect(isDmarcReportInWindow(sec("2026-09-15T00:00:00Z"), sec("2026-09-15T13:00:00Z"), now)).toBe(true);
    expect(isDmarcReportInWindow(sec("2026-09-14T00:00:00Z"), sec("2026-09-15T11:00:00Z"), now)).toBe(false);
    expect(isDmarcReportInWindow(sec("2026-11-17T00:00:00Z"), sec("2026-11-17T00:00:00Z"), now)).toBe(false);
    expect(isDmarcReportInWindow(0, 0, now)).toBe(false);
    expect(isDmarcReportInWindow(sec("2026-11-13T00:00:00Z"), sec("2026-11-12T00:00:00Z"), now)).toBe(false);
    // Seen keys outlive every acceptable replay (end + 60 d ≤ accept + 62 d).
    expect(DMARC_SEEN_RETENTION_DAYS).toBeGreaterThan(62);
  });
});

// ─── Schema / plans ─────────────────────────────────────────────────

describe.skipIf(!hasSqlite())("migration 0329 schema", () => {
  it("dmarc_report_records = the prod DDL + 0329's additive column and partial index", () => {
    const migrated = openMigratedDb();
    const prod = openMigratedDb({ exclude: ["0329_dmarc_sensor.sql"] });
    for (const stmt of PROD_DMARC_REPORT_RECORDS_DDL) prod.exec(stmt);
    prod.exec("ALTER TABLE dmarc_report_records ADD COLUMN auth_json TEXT");
    prod.exec("CREATE INDEX idx_drr_geo_pending ON dmarc_report_records(source_ip) WHERE country_code IS NULL");
    const cols = (db: SqliteDb) => db.prepare("PRAGMA table_info(dmarc_report_records)").all();
    expect(cols(migrated)).toEqual(cols(prod));
    const idx = (db: SqliteDb) =>
      (db.prepare("PRAGMA index_list(dmarc_report_records)").all() as Array<{ name: string; unique: number; partial: number }>)
        .map((i) => ({ name: i.name, unique: i.unique, partial: i.partial, cols: db.prepare(`PRAGMA index_info(${i.name})`).all() }))
        .sort((a, b) => a.name.localeCompare(b.name));
    expect(idx(migrated)).toEqual(idx(prod));
  });

  const plan = (db: SqliteDb, sql: string, binds: unknown[]): string =>
    (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...binds) as Array<{ detail: string }>).map((p) => p.detail).join(" | ");

  it("B1d: Cartographer Phase 4's queue read rides the partial geo-pending index", () => {
    const db = openMigratedDb();
    expect(plan(db, DMARC_GEO_QUEUE_SQL, [])).toMatch(/idx_drr_geo_pending/);
    const upd = "UPDATE dmarc_report_records SET country_code = ? WHERE source_ip = ? AND country_code IS NULL";
    expect(plan(db, upd, ["XX", "1.2.3.4"])).toMatch(/idx_drr_geo_pending|idx_drr_ip/);
  });

  it("catch-up probes and every retention statement are index-driven", () => {
    const db = openMigratedDb();
    expect(plan(db, DMARC_ROLLUP_PENDING_SQL, ["-5 minutes", 3])).toMatch(/idx_dmarc_reports_rollup_pending/);
    expect(plan(db, DMARC_STALE_RESET_SQL, ["-15 minutes", 20])).toMatch(/idx_dmarc_reports_processing/);
    expect(plan(db, DMARC_EXPIRED_REPORTS_SQL, ["-180 days", 10])).toMatch(/idx_dmarc_reports_received/);
    expect(plan(db, "DELETE FROM dmarc_report_records WHERE report_id IN (?, ?)", [1, 2])).toMatch(/idx_drr_report/);
    expect(plan(db, DMARC_SOURCES_PURGE_SQL, ["-180 days", 500])).toMatch(/idx_dmarc_source_daily_date/);
    expect(plan(db, DMARC_SEEN_PURGE_SQL, ["-63 days", 500])).toMatch(/idx_dmarc_report_seen_first_seen/);
    expect(plan(db, DMARC_COUNTERS_PURGE_SQL, ["2026-11-12", 500])).toMatch(/idx_dmarc_rate_counters_period/);
  });
});

// ─── Receiver end-to-end ───────────────────────────────────────────

/** D1 wrapper that injects batch failures for statements matching `re`. */
function faultyDb(db: D1Database, re: RegExp, opts: { times: number; message: string; after?: boolean }): D1Database {
  let left = opts.times;
  return {
    prepare: (sql: string) => db.prepare(sql),
    batch: async (stmts: D1PreparedStatement[]) => {
      const hit = left > 0 && stmts.some((s) => re.test((s as unknown as { __sql?: string }).__sql ?? ""));
      if (hit) left--;
      if (hit && !opts.after) throw new Error(opts.message);
      const r = await db.batch(stmts);
      if (hit && opts.after) throw new Error(opts.message);
      return r;
    },
  } as unknown as D1Database;
}

describe.skipIf(!hasSqlite())("DMARC receiver (migrated schema)", () => {
  let raw: SqliteDb;
  let log: StatementLogEntry[];
  let kv: ReturnType<typeof fakeKv>;
  let env: Env;

  const count = (sql: string): number => (raw.prepare(sql).all()[0] as { n: number }).n;
  const ipinfoCalls = () => fetchCalls.filter((u) => u.startsWith("https://ipinfo.io/"));
  /** Email with the operator-enabled trust set (the post-canary case). */
  const trusted = (m: EmailMessage, e: Env = env) => handleDmarcEmail(m, e, undefined, { provenance: TRUST });
  const age = (minutes: number) => raw.prepare(`UPDATE dmarc_reports SET received_at = datetime('now', '-${minutes} minutes')`).run();

  beforeEach(() => {
    raw = openMigratedDb();
    log = [];
    kv = fakeKv();
    env = { DB: d1FromSqlite(raw, { log }), CACHE: kv } as unknown as Env;
    notify.mockClear();
    fetchCalls.length = 0;
    dnsFail.clear();
    for (const k of Object.keys(dnsTxt)) delete dnsTxt[k];
    for (const k of Object.keys(geoOrg)) delete geoOrg[k];
    stubFetch();
    // GEO_IP is unknown to threats; ipinfo puts it on Cloudflare
    // (multi-tenant) → unaligned_shared_esp, not a spoof candidate.
    geoOrg[GEO_IP] = "AS13335 Cloudflare, Inc.";

    const brand = raw.prepare("INSERT INTO brands (id, name, canonical_domain, tier, source) VALUES (?, ?, ?, ?, ?)");
    brand.run("b_acme", "Acme", "acme.example", "customer", "manual");
    brand.run("b_other", "Other", "other.example", "monitored", "curated");
    brand.run("b_public", "Public", "public.example", "monitored", "public_assess");
    brand.run("b_tracked", "Tracked", "tracked.example", "tracked", "manual");
    brand.run("b_pages", "Pages", "acme.github.io", "monitored", "manual");
    // The analyst agent's NULL-source brand for a phishing domain, promoted
    // to `monitored` by migration 0156.
    brand.run("b_phish", "Phish", "phish.example", "monitored", null);
    raw.prepare(
      `INSERT INTO email_security_scans (brand_id, domain, dmarc_exists, dmarc_policy, dmarc_rua, scanned_at)
       VALUES ('b_acme', 'acme.example', 1, 'none', 'mailto:ops@acme.example,mailto:dmarc_rua@averrow.ca!10m', datetime('now'))`,
    ).run();
    for (const d of ["public.example", "tracked.example", "acme.github.io", "phish.example"]) {
      dnsTxt[`_dmarc.${d}`] = ["v=DMARC1; p=none; rua=mailto:dmarc_rua@averrow.ca"];
    }
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
      .run(clusterIdForIp(GEO_IP));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const acme = (org: string, reportId: string, extra: Partial<Parameters<typeof reportXml>[0]> = {}) =>
    reportXml({ org, reportId, domain: "acme.example", records: ACME_RECORDS, ...extra });

  it("as shipped (no trusted authserv): Google mail is unverified — stored, no notification, no ipinfo, rollup from platform evidence", async () => {
    const out = await handleDmarcEmail(googleZip(acme("google.com", "g-1")), env);
    expect(log.filter((l) => l.error)).toEqual([]);
    expect(out).toMatchObject({ status: "stored", pass: 80, fail: 70, complete: true, verified: false });
    expect(notify).not.toHaveBeenCalled();
    expect(ipinfoCalls()).toEqual([]);
    expect(raw.prepare("SELECT verified, sender_domain, sender_auth, raw_xml FROM dmarc_reports").all())
      .toEqual([{ verified: 0, sender_domain: "google.com", sender_auth: null, raw_xml: null }]);
    expect(raw.prepare(
      "SELECT source_ip, source_class, asn, hosting_provider_id, cluster_id, asn_drop_listed, verified_fail_messages FROM dmarc_source_daily ORDER BY source_ip",
    ).all()).toEqual([
      { source_ip: "203.0.113.5", source_class: "spoof_candidate", asn: "AS64500", hosting_provider_id: "hp_AS64500",
        cluster_id: clusterIdForIp("203.0.113.5"), asn_drop_listed: 1, verified_fail_messages: 0 },
      { source_ip: GEO_IP, source_class: "spoof_candidate", asn: null, hosting_provider_id: null, cluster_id: null,
        asn_drop_listed: 0, verified_fail_messages: 0 },
    ]);
  });

  it("verified (trust enabled): OR semantics, provenance, team notification, atomic rollup with ipinfo on the wall-clock day", async () => {
    const out = await trusted(googleZip(acme("google.com", "g-1")));
    expect(log.filter((l) => l.error)).toEqual([]);
    expect(out).toMatchObject({ status: "stored", brandId: "b_acme", pass: 80, fail: 70, storedRecords: 4, complete: true, verified: true });
    expect(raw.prepare(
      "SELECT total_messages, total_pass, total_fail, processed, sender_domain, verified, rolled_up_at IS NOT NULL AS rolled FROM dmarc_reports",
    ).all()).toEqual([{ total_messages: 150, total_pass: 80, total_fail: 70, processed: 1, sender_domain: "google.com", verified: 1, rolled: 1 }]);
    expect(raw.prepare("SELECT source_ip, dmarc_result, dkim_domain, spf_domain FROM dmarc_report_records ORDER BY source_ip").all()).toEqual([
      { source_ip: "198.51.100.10", dmarc_result: "pass", dkim_domain: "acme.example", spf_domain: "fwd.example" },
      { source_ip: "198.51.100.20", dmarc_result: "pass", dkim_domain: null, spf_domain: "acme.example" },
      { source_ip: "203.0.113.5", dmarc_result: "fail", dkim_domain: "evil.test", spf_domain: "evil.test" },
      { source_ip: GEO_IP, dmarc_result: "fail", dkim_domain: null, spf_domain: "acme.example" },
    ]);
    const stats = raw.prepare("SELECT domain, date, total_messages, passed, failed, top_fail_ips FROM dmarc_daily_stats").all() as Array<Record<string, unknown>>;
    expect(stats[0]).toMatchObject({ domain: "acme.example", date: yesterday(), total_messages: 150, passed: 80, failed: 70 });
    expect(JSON.parse(String(stats[0]!.top_fail_ips))).toEqual([{ ip: "203.0.113.5", count: 40 }, { ip: GEO_IP, count: 30 }]);

    expect(notify).toHaveBeenCalledTimes(1);
    const opts = notify.mock.calls[0]![1];
    expect(opts).toMatchObject({ audience: "team", brandId: "b_acme", type: "email_security_change", severity: "high" });
    expect(String(opts.message)).toContain("47%");
    expect(`${String(opts.title)} ${String(opts.message)}`).not.toContain("google.com");

    expect(raw.prepare(
      `SELECT source_ip, messages, fail_messages, verified_fail_messages, source_class, source_rule, asn, as_org,
              country_code, hosting_provider_id, cluster_id, asn_drop_listed
       FROM dmarc_source_daily ORDER BY source_ip`,
    ).all()).toEqual([
      {
        source_ip: "203.0.113.5", messages: 40, fail_messages: 40, verified_fail_messages: 40,
        source_class: "spoof_candidate", source_rule: "R7_no_legitimacy_evidence", asn: "AS64500", as_org: "Bad Host LLC",
        country_code: "RU", hosting_provider_id: "hp_AS64500", cluster_id: clusterIdForIp("203.0.113.5"), asn_drop_listed: 1,
      },
      {
        source_ip: GEO_IP, messages: 30, fail_messages: 30, verified_fail_messages: 30,
        source_class: "unaligned_shared_esp", source_rule: "R6_shared_sending_asn", asn: "AS13335", as_org: "Cloudflare, Inc.",
        country_code: "NL", hosting_provider_id: null, cluster_id: null, asn_drop_listed: 0,
      },
    ]);
    // S4: nothing written back onto the records (Cartographer owns them).
    expect(count("SELECT COUNT(*) AS n FROM dmarc_report_records WHERE asn IS NOT NULL OR country_code IS NOT NULL")).toBe(0);
    // B2: allowance keyed on the WALL-CLOCK day, not the report's day.
    expect(ipinfoCalls()).toHaveLength(1);
    expect(kv.store.get(`dmarc:geo_used:${today()}`)).toBe("1");
    expect(kv.store.has(`dmarc:geo_used:${yesterday()}`)).toBe(false);
    expect(fetchCalls.filter((u) => u.includes("cloudflare-dns.com"))).toEqual([]);
  });

  it("daily ipinfo cap (150) is respected", async () => {
    kv.store.set(`dmarc:geo_used:${today()}`, String(DMARC_ROLLUP_LIMITS.maxGeoPerDay));
    await trusted(googleZip(acme("google.com", "g-cap")));
    expect(ipinfoCalls()).toEqual([]);
    expect(raw.prepare(`SELECT asn FROM dmarc_source_daily WHERE source_ip = '${GEO_IP}'`).all()).toEqual([{ asn: null }]);
  });

  it("L2: a report outside the date window is dropped before any D1 statement", async () => {
    const old = Date.parse("2026-01-01T00:00:00Z") / 1000;
    expect(await handleDmarcEmail(googleZip(acme("google.com", "old-1", { begin: old })), env))
      .toEqual({ status: "dropped", reason: "out_of_window" });
    expect(log).toEqual([]);
    expect((await readDmarcDrops24h(env)).out_of_window).toBe(1);
  });

  it("Microsoft GZIP from a second reporter merges the day; a resend changes nothing", async () => {
    await trusted(googleZip(acme("google.com", "g-1")));
    expect(await trusted(microsoftGzip(acme("Enterprise Outlook", "ms-1")))).toMatchObject({ status: "stored", verified: true });

    const statsOf = () => raw.prepare("SELECT total_messages, passed, failed, top_fail_ips, reporters FROM dmarc_daily_stats").all() as Array<Record<string, unknown>>;
    const after2 = statsOf();
    expect(after2[0]).toMatchObject({ total_messages: 300, passed: 160, failed: 140 });
    expect(JSON.parse(String(after2[0]!.top_fail_ips))).toEqual([{ ip: "203.0.113.5", count: 80 }, { ip: GEO_IP, count: 60 }]);
    expect(JSON.parse(String(after2[0]!.reporters)).sort()).toEqual(["Enterprise Outlook", "google.com"]);

    notify.mockClear();
    expect(await trusted(microsoftGzip(acme("Enterprise Outlook", "ms-1")))).toEqual({ status: "dropped", reason: "duplicate" });
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

  it("forged / ineligible / unenrolled / non-brand reports: nothing stored, nothing notified, counted", async () => {
    dnsTxt["_dmarc.other.example"] = ["v=DMARC1; p=reject; rua=mailto:reports@other.example"];
    const send = (domain: string, id: string) =>
      handleDmarcEmail(plainXml(reportXml({ org: "Attacker", reportId: id, domain, records: ACME_RECORDS })), env);
    expect(await send("other.example", "f-1")).toEqual({ status: "dropped", reason: "unenrolled" });
    expect(await send("nobody.example", "f-2")).toEqual({ status: "dropped", reason: "no_brand" });
    for (const [d, id] of [["public.example", "f-3"], ["tracked.example", "f-4"], ["acme.github.io", "f-5"], ["phish.example", "f-6"]] as const) {
      expect(await send(d, id), d).toEqual({ status: "dropped", reason: "ineligible_brand" });
    }
    for (const t of ["dmarc_reports", "dmarc_report_records", "dmarc_daily_stats", "dmarc_report_seen", "dmarc_source_daily", "dmarc_enrollment", "dmarc_rate_counters"]) {
      expect(count(`SELECT COUNT(*) AS n FROM ${t}`), t).toBe(0);
    }
    expect(notify).not.toHaveBeenCalled();
    expect(await readDmarcDrops24h(env)).toMatchObject({ unenrolled: 1, no_brand: 1, ineligible_brand: 4 });
    const before = fetchCalls.length;
    expect(await send("other.example", "f-7")).toEqual({ status: "dropped", reason: "unenrolled" });
    expect(fetchCalls.length).toBe(before);
    expect(kv.store.get("dmarc:rua_live:b_other")).toBe("other_rua");
    expect(log.some((l) => /LOWER\(name\)/i.test(l.sql))).toBe(false);
  });

  it("S1: enrollment reads only the CANONICAL domain's record", async () => {
    dnsTxt["_dmarc.mail.other.example"] = ["v=DMARC1; p=none; rua=mailto:dmarc_rua@averrow.ca"];
    dnsTxt["_dmarc.other.example"] = ["v=DMARC1; p=none"];
    const sub = (id: string) => plainXml(reportXml({ org: "R", reportId: id, domain: "mail.other.example", records: ACME_RECORDS.slice(0, 1) }));
    expect(await handleDmarcEmail(sub("s-1"), env)).toEqual({ status: "dropped", reason: "unenrolled" });
    expect(fetchCalls.some((u) => u.includes("mail.other.example"))).toBe(false);
    kv.store.clear();
    dnsTxt["_dmarc.other.example"] = ["v=DMARC1; p=none; rua=mailto:dmarc_rua@averrow.ca"];
    expect((await handleDmarcEmail(sub("s-2"), env)).status).toBe("stored");
    expect(raw.prepare("SELECT domain, verified_via FROM dmarc_enrollment WHERE brand_id = 'b_other'").all())
      .toEqual([{ domain: "other.example", verified_via: "live_dns" }]);
  });

  it("S1: a DoH failure is not 'no record' — not cached; a lapsed enrollment keeps working", async () => {
    dnsFail.add("_dmarc.other.example");
    const send = (id: string) =>
      handleDmarcEmail(plainXml(reportXml({ org: "R", reportId: id, domain: "other.example", records: ACME_RECORDS.slice(0, 1) })), env);
    expect(await send("d-1")).toEqual({ status: "dropped", reason: "unenrolled" });
    expect(kv.store.has("dmarc:rua_live:b_other")).toBe(false);
    raw.prepare(
      "INSERT INTO dmarc_enrollment (brand_id, domain, rua_verified_at, verified_via) VALUES ('b_other', 'other.example', datetime('now', '-45 days'), 'live_dns')",
    ).run();
    expect((await send("d-2")).status).toBe("stored");
    expect(raw.prepare("SELECT rua_verified_at < datetime('now', '-40 days') AS lapsed FROM dmarc_enrollment").all()).toEqual([{ lapsed: 1 }]);
  });

  it("M1/M2: D1 counters — per-brand daily and global hourly caps, both per provenance class", async () => {
    const iso = new Date().toISOString();
    const seed = raw.prepare("INSERT INTO dmarc_rate_counters (bucket, period, n) VALUES (?, ?, ?)");
    seed.run("brand:b_acme:unverified", iso.slice(0, 10), DMARC_BRAND_DAILY_CAP.unverified);
    expect(await handleDmarcEmail(plainXml(acme("R", "r-1")), env)).toEqual({ status: "dropped", reason: "rate_limited" });
    // A flooded brand does not use up the global hour of its class.
    expect(count("SELECT COUNT(*) AS n FROM dmarc_rate_counters WHERE bucket = 'global:unverified'")).toBe(0);
    // Forged (unverified) mail can't starve a verified reporter.
    expect((await trusted(googleZip(acme("google.com", "r-2")))).status).toBe("stored");

    seed.run("global:unverified", iso.slice(0, 13), DMARC_GLOBAL_HOURLY_CAP.unverified);
    expect(await handleDmarcEmail(plainXml(reportXml({ org: "R", reportId: "r-3", domain: "other.example", records: ACME_RECORDS })), env))
      .toMatchObject({ status: "dropped" }); // other.example not enrolled here → unenrolled before the cap
    raw.prepare("INSERT INTO dmarc_enrollment (brand_id, domain, rua_verified_at, verified_via) VALUES ('b_other', 'other.example', datetime('now'), 'live_dns')").run();
    expect(await handleDmarcEmail(plainXml(reportXml({ org: "R", reportId: "r-4", domain: "other.example", records: ACME_RECORDS })), env))
      .toEqual({ status: "dropped", reason: "rate_limited" });
    expect((await trusted(googleZip(acme("google.com", "r-5")))).status).toBe("stored");
    expect(raw.prepare("SELECT bucket, n FROM dmarc_rate_counters WHERE bucket LIKE 'global:%' ORDER BY bucket").all())
      .toEqual([{ bucket: "global:unverified", n: DMARC_GLOBAL_HOURLY_CAP.unverified + 1 }, { bucket: "global:verified", n: 2 }]);
  });

  it("M1: a counter that can't be written DENIES (fail closed)", async () => {
    const failing = faultyDb(env.DB, /dmarc_rate_counters/, { times: 10, message: "SQLITE_ERROR: no such table" });
    expect(await handleDmarcEmail(plainXml(acme("R", "fc-1")), { ...env, DB: failing } as unknown as Env))
      .toEqual({ status: "dropped", reason: "rate_limited" });
    expect(count("SELECT COUNT(*) AS n FROM dmarc_reports")).toBe(0);
  });

  it("B4c: the rollup is atomic and re-runnable — a racing second run changes nothing", async () => {
    await handleDmarcEmail(plainXml(acme("R", "a-1")), env);
    const before = raw.prepare("SELECT * FROM dmarc_source_daily ORDER BY source_ip").all();
    const id = (raw.prepare("SELECT id FROM dmarc_reports").all()[0] as { id: number }).id;
    expect(await rollupStoredDmarcReport(env, id)).toBeNull();
    const records = parseDmarcAggregateXml(acme("R", "a-1"))!.records;
    const r = await runDmarcSourceRollup(env, {
      reportRowId: id, brandId: "b_acme", date: yesterday(), reporterOrg: "R", verified: false,
      firstSeen: new Date().toISOString(), lastSeen: new Date().toISOString(), records,
    }, { geo: false });
    expect(r.applied).toBe(false);
    expect(raw.prepare("SELECT * FROM dmarc_source_daily ORDER BY source_ip").all()).toEqual(before);
  });

  it("B4c/M4: a failed rollup writes nothing; the Navigator catch-up rolls it up from stored records", async () => {
    const e = { ...env, DB: faultyDb(env.DB, /INSERT INTO dmarc_source_daily/, { times: 1, message: "SQLITE_CONSTRAINT: simulated" }) } as unknown as Env;
    expect((await handleDmarcEmail(plainXml(acme("R", "b-1")), e)).status).toBe("stored");
    expect(count("SELECT COUNT(*) AS n FROM dmarc_source_daily")).toBe(0);
    // Too fresh for the catch-up (the inline rollup may still be running).
    expect(await runDmarcRollupCatchUp(env)).toMatchObject({ pending: 0, rolledUp: 0 });
    age(10);
    expect(await runDmarcRollupCatchUp(env)).toMatchObject({ pending: 1, rolledUp: 1, failed: 0, error: null });
    expect(raw.prepare("SELECT source_ip, source_class FROM dmarc_source_daily ORDER BY source_ip").all()).toEqual([
      { source_ip: "203.0.113.5", source_class: "spoof_candidate" },
      { source_ip: GEO_IP, source_class: "spoof_candidate" },
    ]);
    expect(await runDmarcRollupCatchUp(env)).toMatchObject({ pending: 0 });
  });

  it("M4: a dead worker's processed=2 row is reset, then rolled up from its partial records; resend can recover it too", async () => {
    await handleDmarcEmail(plainXml(acme("R", "dead-1")), env);
    // Simulate death after the claim: back to processed=2, records partly written, no rollup.
    raw.prepare("UPDATE dmarc_reports SET processed = 2, processing_at = datetime('now', '-20 minutes'), rolled_up_at = NULL").run();
    raw.prepare("DELETE FROM dmarc_source_daily").run();
    raw.prepare("DELETE FROM dmarc_report_records WHERE source_ip <> '203.0.113.5'").run();
    age(20);
    const r = await runDmarcRollupCatchUp(env);
    expect(r).toMatchObject({ staleReset: 1, pending: 1, rolledUp: 1 });
    expect(raw.prepare("SELECT processed, rolled_up_at IS NOT NULL AS rolled FROM dmarc_reports").all()).toEqual([{ processed: 0, rolled: 1 }]);
    expect(raw.prepare("SELECT source_ip FROM dmarc_source_daily").all()).toEqual([{ source_ip: "203.0.113.5" }]);
    // Stats were counted once at claim time and are untouched.
    expect(raw.prepare("SELECT total_messages FROM dmarc_daily_stats").all()).toEqual([{ total_messages: 150 }]);

    // A stale processed=2 row can also be finished by a resend.
    await handleDmarcEmail(plainXml(acme("R", "dead-2")), env);
    raw.prepare("UPDATE dmarc_reports SET processed = 2, processing_at = datetime('now', '-20 minutes') WHERE report_id = 'dead-2'").run();
    expect(await handleDmarcEmail(plainXml(acme("R", "dead-2")), env)).toMatchObject({ status: "stored", recovered: true, complete: true });
  });

  it("M4: attempt cap — a poison report is abandoned after 5 tries and doesn't block others", async () => {
    await handleDmarcEmail(plainXml(acme("R", "p-1")), env);
    await handleDmarcEmail(plainXml(acme("R", "p-2")), env);
    raw.prepare("UPDATE dmarc_reports SET rolled_up_at = NULL").run();
    raw.prepare("DELETE FROM dmarc_source_daily").run();
    age(10);
    const [poison] = (raw.prepare("SELECT id FROM dmarc_reports ORDER BY id").all() as Array<{ id: number }>);
    raw.prepare("UPDATE dmarc_reports SET received_at = datetime('now', '-20 minutes') WHERE id = ?").run(poison!.id);
    // Every rollup batch touching the poison report fails; the other succeeds.
    const poisonDb = {
      prepare: (sql: string) => env.DB.prepare(sql),
      batch: async (stmts: D1PreparedStatement[]) => {
        const binds = stmts.flatMap((s) => (s as unknown as { __bound?: unknown[] }).__bound ?? []);
        if (stmts.some((s) => /rolled_up_at = datetime/.test((s as unknown as { __sql?: string }).__sql ?? "")) && binds.at(-1) === poison!.id) {
          throw new Error("SQLITE_TOOBIG: poison");
        }
        return env.DB.batch(stmts);
      },
    } as unknown as D1Database;
    const e = { ...env, DB: poisonDb } as unknown as Env;
    const first = await runDmarcRollupCatchUp(e);
    expect(first).toMatchObject({ pending: 2, rolledUp: 1, failed: 1 });
    for (let i = 1; i < DMARC_ROLLUP_MAX_ATTEMPTS; i++) await runDmarcRollupCatchUp(e);
    expect(await runDmarcRollupCatchUp(e)).toMatchObject({ abandoned: 1 });
    expect(raw.prepare("SELECT rolled_up_at IS NOT NULL AS rolled, process_error FROM dmarc_reports WHERE id = ?").all(poison!.id))
      .toEqual([{ rolled: 1, process_error: "rollup_abandoned" }]);
    expect(await runDmarcRollupCatchUp(e)).toMatchObject({ pending: 0 });
  });

  it("B4a/e: the claim batch retries a transient error without double-counting, even when the first attempt committed", async () => {
    const e = { ...env, DB: faultyDb(env.DB, /INSERT INTO dmarc_report_seen/, { times: 1, message: "Network connection lost.", after: true }) } as unknown as Env;
    expect(await handleDmarcEmail(googleZip(acme("google.com", "t-1")), e)).toMatchObject({ status: "stored", pass: 80, fail: 70 });
    expect(count("SELECT COUNT(*) AS n FROM dmarc_reports")).toBe(1);
    expect(raw.prepare("SELECT total_messages FROM dmarc_daily_stats").all()).toEqual([{ total_messages: 150 }]);
    expect(count("SELECT COUNT(*) AS n FROM dmarc_report_records")).toBe(4);
  });

  it("B4b/M3: failed records → honest outcome; a matching resend completes it once; it can't inherit verification", async () => {
    const failing = faultyDb(env.DB, /INSERT INTO dmarc_report_records/, { times: 1, message: "SQLITE_TOOBIG: simulated" });
    const first = await trusted(googleZip(acme("google.com", "rec-1")), { ...env, DB: failing } as unknown as Env);
    expect(first).toMatchObject({ status: "stored", complete: false, storedRecords: 0, verified: true });
    expect(raw.prepare("SELECT processed, rolled_up_at FROM dmarc_reports").all()).toEqual([{ processed: 0, rolled_up_at: null }]);
    expect(notify).not.toHaveBeenCalled();

    // M3: a resend with different totals is a different document.
    const other = ACME_RECORDS.map((r) => ({ ...r, count: r.count + 1 }));
    expect(await trusted(googleZip(reportXml({ org: "google.com", reportId: "rec-1", domain: "acme.example", records: other }))))
      .toEqual({ status: "dropped", reason: "duplicate" });
    // M3: an UNVERIFIED resend recovers the data but not the verification.
    const again = await handleDmarcEmail(plainXml(acme("google.com", "rec-1")), env);
    expect(again).toMatchObject({ status: "stored", complete: true, recovered: true, storedRecords: 4, verified: false });
    expect(notify).not.toHaveBeenCalled();
    expect(count("SELECT COUNT(*) AS n FROM dmarc_reports")).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM dmarc_report_records")).toBe(4);
    expect(raw.prepare("SELECT total_messages, failed FROM dmarc_daily_stats").all()).toEqual([{ total_messages: 150, failed: 70 }]);
    expect(raw.prepare("SELECT SUM(verified_fail_messages) AS v FROM dmarc_source_daily").all()).toEqual([{ v: 0 }]);
    expect(await trusted(googleZip(acme("google.com", "rec-1")))).toEqual({ status: "dropped", reason: "duplicate" });
  });

  it("B4b: a records retry after an ambiguous commit does not duplicate rows", async () => {
    const e = { ...env, DB: faultyDb(env.DB, /INSERT INTO dmarc_report_records/, { times: 1, message: "Network connection lost.", after: true }) } as unknown as Env;
    expect(await handleDmarcEmail(googleZip(acme("google.com", "amb-1")), e)).toMatchObject({ status: "stored", complete: true, storedRecords: 4 });
    expect(count("SELECT COUNT(*) AS n FROM dmarc_report_records")).toBe(4);
  });

  it("B4d: undecodable mail is `unparseable`; a thrown error is counted as `error`", async () => {
    const bad = emailMessage(GOOGLE, mimeEmail(GOOGLE, "application/zip", "x.zip", Buffer.alloc(0), "", "@@@@not-base64@@@@"));
    expect(await handleDmarcEmail(bad, env)).toEqual({ status: "dropped", reason: "unparseable" });
    const boomEnv = { ...env, DB: { prepare: () => { throw new Error("SQLITE_ERROR: boom"); } } } as unknown as Env;
    expect((await handleDmarcEmail(googleZip(acme("google.com", "e-1")), boomEnv)).status).toBe("error");
    expect(await readDmarcDrops24h(env)).toMatchObject({ unparseable: 1, error: 1 });
  });

  it("unverified reports store at most 250 records (failing first)", async () => {
    const many: FixtureRecord[] = Array.from({ length: 300 }, (_, i) => ({
      ip: `45.155.${Math.floor(i / 250)}.${i % 250}`, count: 1, dkim: i < 260 ? "fail" : "pass", spf: "fail",
    }));
    expect(await handleDmarcEmail(plainXml(reportXml({ org: "R", reportId: "big", domain: "acme.example", records: many })), env))
      .toMatchObject({ status: "stored", storedRecords: 250 });
    expect(count("SELECT COUNT(*) AS n FROM dmarc_report_records WHERE dmarc_result = 'pass'")).toBe(0);
  });

  it("subdomain report rolls into the parent brand; RFC 9990 namespaced shape parses", async () => {
    const xml = reportXml({
      org: "Bis Receiver", reportId: "sub-1", domain: "mail.acme.example", prefix: "d", dmarcbis: true,
      records: [{ ip: "203.0.113.5", count: 12, dkim: "fail", spf: "fail", headerFrom: "mail.acme.example", reasons: ["mailing_list"],
        dkimAuth: [{ d: "acme.example", r: "fail" }], spfAuth: { d: "lists.example", r: "pass" } }],
    });
    expect(await handleDmarcEmail(plainXml(xml), env)).toMatchObject({ status: "stored", brandId: "b_acme", pass: 0, fail: 12 });
    expect(raw.prepare("SELECT domain, brand_id FROM dmarc_reports").all()).toEqual([{ domain: "mail.acme.example", brand_id: "b_acme" }]);
    expect(raw.prepare("SELECT domain FROM dmarc_daily_stats").all()).toEqual([{ domain: "acme.example" }]);
    expect(raw.prepare("SELECT source_class, source_rule FROM dmarc_source_daily").all())
      .toEqual([{ source_class: "forwarder_likely", source_rule: "R2_receiver_forwarding_override" }]);
  });

  it("the rollup's class merge keeps the most suspicious class across reports", async () => {
    const one = (id: string, n: number, reasons: string[]) => handleDmarcEmail(plainXml(reportXml({
      org: id, reportId: id, domain: "acme.example", records: [{ ip: "203.0.113.5", count: n, dkim: "fail", spf: "fail", reasons }],
    })), env);
    await one("m-1", 5, ["forwarded"]);
    await one("m-2", 7, []);
    await one("m-3", 1, ["trusted_forwarder"]);
    expect(raw.prepare("SELECT messages, fail_messages, source_class, source_rule FROM dmarc_source_daily").all())
      .toEqual([{ messages: 13, fail_messages: 13, source_class: "spoof_candidate", source_rule: "R7_no_legitimacy_evidence" }]);
  });

  it("threats lookup: one deterministic row per IP, one index seek, no sort", async () => {
    await handleDmarcEmail(plainXml(acme("R", "q-1")), env);
    const q = log.find((l) => /FROM v JOIN threats t/.test(l.sql))!;
    const plan = (raw.prepare(`EXPLAIN QUERY PLAN ${q.sql}`).all(...(q.binds ?? [])) as Array<{ detail: string }>).map((p) => p.detail).join(" | ");
    expect(plan).toMatch(/SEARCH t2 USING (COVERING )?INDEX idx_threats_ip_source_feed \(ip_address=\?\)/);
    expect(plan).not.toMatch(/TEMP B-TREE|SCAN t2\b|SCAN threats/);
  });

  it("L1 retention: reports + records in id chunks (FK order), sources, seen, counters; bounded per tick", async () => {
    await handleDmarcEmail(plainXml(acme("R", "fresh")), env);
    const rep = raw.prepare(`INSERT INTO dmarc_reports (id, brand_id, domain, report_id, received_at, processed) VALUES (?, 'b_acme', 'acme.example', ?, datetime('now', '-200 days'), 1)`);
    const rec = raw.prepare("INSERT INTO dmarc_report_records (report_id, source_ip, count) VALUES (?, ?, 1)");
    for (let id = 900; id < 905; id++) {
      rep.run(id, `old-${id}`);
      for (let i = 0; i < 3; i++) rec.run(id, `192.0.2.${i}`);
    }
    raw.prepare(
      `INSERT INTO dmarc_source_daily (brand_id, date, source_ip, source_class, first_seen, last_seen)
       VALUES ('b_acme', date('now', '-200 days'), '192.0.2.1', 'spoof_candidate', 'x', 'x')`,
    ).run();
    raw.prepare("INSERT INTO dmarc_report_seen (domain, reporter_org, report_id, claim_id, first_seen_at) VALUES ('a', 'b', 'c', 'd', datetime('now', '-64 days'))").run();
    raw.prepare("INSERT INTO dmarc_rate_counters (bucket, period, n) VALUES ('global:verified', '2020-01-01T00', 3)").run();

    const r1 = await purgeExpiredDmarcData(env, { limits: { reportChunk: 2, reportBatchesPerTick: 2 } });
    expect(r1).toMatchObject({
      reports_deleted: 4, records_deleted: 12, sources_deleted: 1, seen_deleted: 1, counters_deleted: 1, more_remaining: true, error: null,
    });
    const r2 = await purgeExpiredDmarcData(env, { limits: { reportChunk: 2 } });
    expect(r2).toMatchObject({ reports_deleted: 1, records_deleted: 3, more_remaining: false, error: null });
    expect(count("SELECT COUNT(*) AS n FROM dmarc_reports")).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM dmarc_report_records")).toBe(4);
    expect(count("SELECT COUNT(*) AS n FROM dmarc_report_records rr WHERE NOT EXISTS (SELECT 1 FROM dmarc_reports r WHERE r.id = rr.report_id)")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM dmarc_rate_counters")).toBe(2); // today's brand-day + global-hour
    // Nothing due: four cheap statements (one indexed seek per phase).
    expect(await purgeExpiredDmarcData(env)).toMatchObject({ statements: 4, reports_deleted: 0, more_remaining: false });
  });

  it("M5: Cartographer Phase 4 empties its queue — resolved, 'PRIV' for reserved ranges, 'XX' for failed lookups", async () => {
    const rec = raw.prepare("INSERT INTO dmarc_report_records (report_id, source_ip, count) VALUES (1, ?, 1)");
    for (const ip of ["10.0.0.1", "203.0.113.9", "198.18.0.1", "2001:db8::1", GEO_IP, "45.155.205.99"]) rec.run(ip);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      fetchCalls.push(url);
      if (url.includes("45.155.205.99")) return new Response("nope", { status: 404 });
      return Response.json({ ip: GEO_IP, country: "NL", org: "AS13335 Cloudflare, Inc." });
    });
    const r = await geoEnrichDmarcRecords(env);
    expect(r).toEqual({ enriched: 1, reserved: 4, failed: 1 });
    expect(ipinfoCalls().map((u) => u.split("/")[3])).toEqual([GEO_IP, "45.155.205.99"].sort());
    expect(raw.prepare("SELECT source_ip, country_code FROM dmarc_report_records ORDER BY source_ip").all()).toEqual([
      { source_ip: "10.0.0.1", country_code: "PRIV" },
      { source_ip: "198.18.0.1", country_code: "PRIV" },
      { source_ip: "2001:db8::1", country_code: "PRIV" },
      { source_ip: "203.0.113.9", country_code: "PRIV" },
      { source_ip: GEO_IP, country_code: "NL" },
      { source_ip: "45.155.205.99", country_code: "XX" },
    ]);
    expect((raw.prepare(DMARC_GEO_QUEUE_SQL).all())).toEqual([]);
  });

  it("staff endpoints: setup reflects current validity; spoof-sources exposes provenance", async () => {
    await trusted(googleZip(acme("google.com", "g-1")));
    await handleDmarcEmail(plainXml(reportXml({
      org: "Forger", reportId: "u-9", domain: "acme.example", records: [{ ip: "198.51.100.77", count: 9, dkim: "fail", spf: "fail" }],
    })), env);
    const session = Object.assign(Object.create(env.DB) as object, { getBookmark: () => null });
    const sessionEnv = { ...env, DB: Object.assign(env.DB, { withSession: () => session }) } as unknown as Env;
    dnsTxt["acme.example._report._dmarc.averrow.ca"] = ["v=DMARC1;"];

    const setup = (await (await handleGetDmarcSetup(new Request("https://x.test/s"), sessionEnv, "b_acme")).json()) as {
      data: Record<string, unknown>; error?: string;
    };
    expect(setup.error).toBeUndefined();
    expect(setup.data).toMatchObject({
      state: "receiving", rua_value: "rua=mailto:dmarc_rua@averrow.ca", rua_includes_averrow: true,
      authorization_required: true, authorization_record_ok: true,
      authorization_record_name: "acme.example._report._dmarc.averrow.ca", enrolled: true, eligible: true,
      verified_via: "scan", reverify_after_days: 30,
    });
    const phish = (await (await handleGetDmarcSetup(new Request("https://x.test/s"), sessionEnv, "b_phish")).json()) as { data: Record<string, unknown> };
    expect(phish.data.eligible).toBe(false);
    raw.prepare("UPDATE dmarc_enrollment SET rua_verified_at = datetime('now', '-31 days')").run();
    const lapsed = (await (await handleGetDmarcSetup(new Request("https://x.test/s"), sessionEnv, "b_acme")).json()) as { data: Record<string, unknown> };
    expect(lapsed.data.enrolled).toBe(false);

    expect((await handleGetDmarcSpoofSources(new Request("https://x.test/x?days=9"), sessionEnv, "b_acme")).status).toBe(400);
    const res = await handleGetDmarcSpoofSources(new Request("https://x.test/x?days="), sessionEnv, "b_acme");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { days: number; sources: Array<Record<string, unknown>>; daily: unknown[]; summary: Record<string, unknown> } };
    expect(body.data.days).toBe(7);
    expect(body.data.sources[0]).toMatchObject({
      source_ip: "203.0.113.5", source_class: "spoof_candidate", fail_messages: 40, verified_fail_messages: 40, unverified_only: false,
      provider: { id: "hp_AS64500", name: "Bad Host LLC" }, asn_drop_listed: true,
    });
    expect(body.data.sources.find((s) => s.source_ip === "198.51.100.77")).toMatchObject({ verified_fail_messages: 0, unverified_only: true });
    expect(body.data.daily).toEqual([{ date: yesterday(), total: 159, passed: 80, failed: 79 }]);
    expect(body.data.summary).toMatchObject({ sources: 3, unverified_only_sources: 1 });
    expect(kv.store.has("dmarc:spoof_sources:v2:b_acme:7")).toBe(true);
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

describe("Navigator wiring (cron-audit rule)", () => {
  const nav = readFileSync(resolve(__dirname, "..", "src", "cron", "navigator.ts"), "utf8");
  it("retention and catch-up run every tick under the soft cap; no hour or minute gate on either", () => {
    expect(nav).toMatch(/if \(!isOverCap\(\)\) \{\s*dmarcPurgeResult = await purgeExpiredDmarcData\(/);
    expect(nav).toMatch(/if \(!isOverCap\(\)\) \{\s*dmarcRollupCatchUpResult = await runDmarcRollupCatchUp\(env\);/);
    const block = nav.slice(nav.indexOf("2g. DMARC"), nav.indexOf("dmarcRollupCatchUpResult = await"));
    expect(block).not.toMatch(/getUTCMinutes|getUTCHours|minute\s*===/);
  });
});
