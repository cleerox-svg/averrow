/**
 * Infoblox Threat Intel reference data (feeds/infobloxReference.ts,
 * lib/infoblox-reference.ts, migration 0336).
 *
 * Fixtures mirror the live `indicators/csv/*.csv` shape checked on
 * 2026-11-15: header `type,indicator,classification,detected_date`; types
 * domain / ip / ipv4 / url / sha256 / email; indicators sometimes defanged
 * (`evil[.]com`, `5[.]252[.]176[.]63`); a stray UTF-8 BOM rendered as
 * `ï»¿` at the start of some rows (usps_cta_20231219.csv) and a real BOM on
 * the header of others (olympics_20240729_iocs.csv); classifications such as
 * malicious / suspicious / phishing / vextrio / legitimate / other.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
  parseInfobloxCsv,
  normalizeInfobloxDomain,
  normalizeInfobloxIp,
  infobloxDomainCandidates,
  unlistedInfobloxFiles,
  lookupInfobloxReference,
  INFOBLOX_FILES,
  INFOBLOX_EXCLUDED_FILES,
  INFOBLOX_CREDIT,
  INFOBLOX_LABEL_NOTE,
  INFOBLOX_MAX_FILE_BYTES,
  type InfobloxFile,
} from "../src/lib/infoblox-reference";
import { infoblox_reference, runInfobloxReference, infobloxFileRemovalAllowed } from "../src/feeds/infobloxReference";
import { feedModules } from "../src/feeds";
import { hasSqlite, openMigratedDb, d1FromSqlite, type StatementLogEntry, type SqliteDb } from "./sqlite-d1-harness";
import type { Env } from "../src/types";

const HEADER = "type,indicator,classification,detected_date";

function csv(rows: string[], header = HEADER): string {
  return [header, ...rows].join("\r\n") + "\r\n";
}

const VEXTRIO_ROWS = [
  "domain,toptrendsnews[.]com,vextrio,2025-06-21",
  "domain,EXAMPLE-TDS.net.,vextrio,2025-06-20",
  "domain,ï»¿abnormalk.top,malicious,2023-08-14",
  "ipv4,5[.]252[.]176[.]63,malicious,2025-06-19",
  "ip,146.103.91.133,malicious,2025-06-18",
  "url,hxxps://evil[.]com/x,malicious,2025-06-18",
  "sha256,0f5a7e2c9b1d4e6f8a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f,malware,2025-06-18",
  "domain,google.com,legitimate,2025-06-18",
  "domain,parked.example,other,2025-06-18",
  "domain,not a domain,malicious,2025-06-18",
  "domain,toptrendsnews.com,vextrio,2025-06-01", // older duplicate
];

// ─── Pure parser + normalisation ──────────────────────────────────

describe("normalisation", () => {
  it("refangs, lowercases and strips the trailing dot / BOM", () => {
    expect(normalizeInfobloxDomain("Evil[.]Com.")).toBe("evil.com");
    expect(normalizeInfobloxDomain("ï»¿abnormalk.top")).toBe("abnormalk.top");
    expect(normalizeInfobloxDomain("﻿usps-global.com")).toBe("usps-global.com");
    expect(normalizeInfobloxDomain("5.2.1.6.ip6.arpa")).toBe("5.2.1.6.ip6.arpa");
    expect(normalizeInfobloxDomain("localhost")).toBeNull();
    expect(normalizeInfobloxDomain("bad domain.com")).toBeNull();
    expect(normalizeInfobloxIp("5[.]252[.]176[.]63")).toBe("5.252.176.63");
    expect(normalizeInfobloxIp("999.1.1.1")).toBeNull();
    expect(normalizeInfobloxIp("2001:DB8::1")).toBe("2001:db8::1");
  });
});

describe("parseInfobloxCsv", () => {
  it("keeps domain + IP rows, skips other types and non-malicious classifications, dedupes newest-first", () => {
    const p = parseInfobloxCsv(csv(VEXTRIO_ROWS));
    expect(p.rows.map((r) => r.indicator)).toEqual([
      "toptrendsnews.com", "example-tds.net", "5.252.176.63", "146.103.91.133", "abnormalk.top",
    ]);
    expect(p.rows[0]).toEqual({ indicator: "toptrendsnews.com", type: "domain", classification: "vextrio", detectedDate: "2025-06-21" });
    expect(p.rows.find((r) => r.indicator === "5.252.176.63")?.type).toBe("ip");
    expect(p.otherTypes).toBe(2);
    expect(p.skippedClass).toBe(2);
    expect(p.malformed).toBe(1);
    expect(p.capped).toBe(0);
  });

  it("accepts a BOM on the header (olympics file) and rejects a different schema", () => {
    expect(parseInfobloxCsv(csv(["domain,a.example,malicious,2024-07-29"], `﻿${HEADER}`)).rows).toHaveLength(1);
    expect(() => parseInfobloxCsv(csv(["x"], "indicator,type,date"))).toThrow(/unexpected header/);
  });

  it("caps per file, keeping the newest detections", () => {
    const rows = Array.from({ length: 30 }, (_, i) => `domain,d${i}.example,malicious,2026-01-${String(i + 1).padStart(2, "0")}`);
    const p = parseInfobloxCsv(csv(rows), 10);
    expect(p.rows).toHaveLength(10);
    expect(p.capped).toBe(20);
    expect(p.rows[0]!.indicator).toBe("d29.example");
    expect(p.rows[9]!.indicator).toBe("d20.example");
  });
});

describe("catalogue", () => {
  it("loads no legitimate-domain file and lists every file once", () => {
    const names = INFOBLOX_FILES.map((f) => f.file);
    expect(new Set(names).size).toBe(names.length);
    for (const x of INFOBLOX_EXCLUDED_FILES) expect(names).not.toContain(x);
    expect(names.some((n) => n.includes("legitimate"))).toBe(false);
  });

  it("reports README files that are neither loaded nor excluded (tolerates the README's inexact links)", () => {
    const readme = [
      "| 2024-07-17 | RDGAs | https://x | https://github.com/infobloxopen/threat-intelligence/tree/main/indicators/csv/rdga_20240717.csv |",
      "| 2024-07-25 | LET'S | https://x | https://github.com/infobloxopen/threat-intelligence/tree/main/indicators/csv/crowdstrike_lookalike_20240726_iocs.csv |",
      "| 2026-12-01 | New | https://x | https://github.com/infobloxopen/threat-intelligence/tree/main/indicators/csv/brand_new_actor_20261201.csv |",
    ].join("\n");
    expect(unlistedInfobloxFiles(readme)).toEqual(["brand_new_actor_20261201.csv"]);
  });
});

describe("infobloxDomainCandidates", () => {
  it("adds parents but stops at shared hosting", () => {
    expect(infobloxDomainCandidates("login.Evil.com").map((c) => c.value)).toEqual(["login.evil.com", "evil.com"]);
    expect(infobloxDomainCandidates("a.b.pages.dev").map((c) => c.value)).toEqual(["a.b.pages.dev"]);
    expect(infobloxDomainCandidates("evil.com")).toEqual([{ value: "evil.com", match: "exact" }]);
  });

  it("never walks above the registrable domain (public suffixes are not keys)", () => {
    expect(infobloxDomainCandidates("a.b.evil.co.uk").map((c) => c.value)).toEqual(["a.b.evil.co.uk", "b.evil.co.uk", "evil.co.uk"]);
    expect(infobloxDomainCandidates("login.banco.com.br").map((c) => c.value)).toEqual(["login.banco.com.br", "banco.com.br"]);
    expect(infobloxDomainCandidates("shop.evil.com.au").map((c) => c.value)).toEqual(["shop.evil.com.au", "evil.com.au"]);
    for (const d of ["x.evil.co.uk", "x.banco.com.br", "x.evil.com.au"]) {
      const values = infobloxDomainCandidates(d).map((c) => c.value);
      expect(values).not.toContain("co.uk");
      expect(values).not.toContain("com.br");
      expect(values).not.toContain("com.au");
    }
  });

  it("reports www.<x> hitting <x> as an exact match", () => {
    expect(infobloxDomainCandidates("www.evil.com")).toEqual([
      { value: "www.evil.com", match: "exact" },
      { value: "evil.com", match: "exact" },
    ]);
    expect(infobloxDomainCandidates("a.www.evil.com").map((c) => c.match)).toEqual(["exact", "parent_domain", "parent_domain"]);
  });
});

describe("infobloxFileRemovalAllowed", () => {
  it("needs a whole body that keeps half the live rows", () => {
    expect(infobloxFileRemovalAllowed({ inFile: 10, liveBefore: 12, lineCapped: false })).toBe(true);
    expect(infobloxFileRemovalAllowed({ inFile: 5, liveBefore: 12, lineCapped: false })).toBe(false);
    expect(infobloxFileRemovalAllowed({ inFile: 10, liveBefore: 12, lineCapped: true })).toBe(false);
  });

  it("accepts a blocked shrink once the same body was seen on 3 consecutive runs", () => {
    expect(infobloxFileRemovalAllowed({ inFile: 1, liveBefore: 40, lineCapped: false, sameBodyRuns: 2 })).toBe(false);
    expect(infobloxFileRemovalAllowed({ inFile: 1, liveBefore: 40, lineCapped: false, sameBodyRuns: 3 })).toBe(true);
    expect(infobloxFileRemovalAllowed({ inFile: 10, liveBefore: 12, lineCapped: true, sameBodyRuns: 3 })).toBe(true);
  });
});

// ─── Feed against the migrated schema ─────────────────────────────

interface Rig { raw: SqliteDb; env: Env; log: StatementLogEntry[] }
function rig(): Rig {
  const raw = openMigratedDb();
  const log: StatementLogEntry[] = [];
  const env = { DB: d1FromSqlite(raw, { log }) } as unknown as Env;
  return { raw, env, log };
}

const FILES: InfobloxFile[] = [
  { file: "vextrio_unveiled_20250806.csv", label: "VexTrio", kind: "actor", publication: "https://example.invalid/vextrio" },
  { file: "prolific_puma_20231031.csv", label: "Prolific Puma", kind: "actor", publication: null },
];

type Body = string | { status: number; etag?: string; body?: string };
/** Stub fetch by file name; records request headers. */
function stub(map: Record<string, Body>) {
  const calls: Array<{ url: string; ifNoneMatch: string | null; redirect: RequestRedirect | undefined }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    calls.push({ url, ifNoneMatch: h.get("If-None-Match"), redirect: init?.redirect });
    const name = url.split("/").pop() ?? "";
    const b = map[name];
    if (b === undefined) return new Response("Not Found", { status: 404 });
    if (typeof b === "string") return new Response(b, { status: 200 });
    if (b.status === 304 || b.status === 404) return new Response(null, { status: b.status });
    if (b.status >= 300 && b.status < 400) return new Response(null, { status: b.status, headers: { Location: "https://elsewhere.invalid/x.csv" } });
    return new Response(b.body ?? "", { status: b.status, headers: b.etag ? { ETag: b.etag } : {} });
  }));
  return calls;
}

const PUMA = csv(Array.from({ length: 40 }, (_, i) => `domain,puma${i}[.]link,malicious,2023-06-${String((i % 28) + 1).padStart(2, "0")}`));
const writes = (log: StatementLogEntry[]) => log.filter((e) => !/^\s*SELECT/i.test(e.sql));
const count = (raw: SqliteDb, sql: string, ...args: unknown[]) => (raw.prepare(sql).all(...args)[0] as { n: number }).n;

describe.skipIf(!hasSqlite())("infoblox_reference feed", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("is registered and is a context feed (itemsNew 0, no threats)", async () => {
    expect(feedModules.infoblox_reference).toBe(infoblox_reference);
    const { env, raw } = rig();
    stub({ [FILES[0]!.file]: csv(VEXTRIO_ROWS), [FILES[1]!.file]: PUMA });
    const r = await runInfobloxReference(env, { files: FILES });
    expect(r.itemsNew).toBe(0);
    expect(r.complete).toBe(true);
    expect(r.filesLoaded).toBe(2);
    expect(count(raw, "SELECT COUNT(*) AS n FROM infoblox_reference WHERE removed_at IS NULL")).toBe(45);
    expect(count(raw, "SELECT COUNT(*) AS n FROM threats")).toBe(0);
    const f = raw.prepare("SELECT * FROM infoblox_reference_files WHERE source_file = ?").all(FILES[0]!.file)[0] as Record<string, unknown>;
    expect(f).toMatchObject({ label: "VexTrio", label_kind: "actor", rows_loaded: 5, status: "loaded" });
    expect(f.content_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a second identical pull writes nothing (sha guard), and a 304 writes nothing either", async () => {
    const { env, log } = rig();
    stub({ [FILES[0]!.file]: { status: 200, etag: '"e1"', body: csv(VEXTRIO_ROWS) }, [FILES[1]!.file]: PUMA });
    await runInfobloxReference(env, { files: FILES });
    log.length = 0;
    const calls = stub({ [FILES[0]!.file]: { status: 304 }, [FILES[1]!.file]: PUMA });
    const r = await runInfobloxReference(env, { files: FILES });
    expect(writes(log)).toEqual([]);
    expect(calls[0]!.ifNoneMatch).toBe('"e1"');
    expect(r.filesUnchanged).toBe(2);
    expect(r.itemsDuplicate).toBe(45);
    // Reads: the file-state table only.
    expect(log.filter((e) => /^\s*SELECT/i.test(e.sql))).toHaveLength(1);
  });

  it("a changed file rewrites only changed rows and removes rows that left it", async () => {
    const { env, raw, log } = rig();
    stub({ [FILES[0]!.file]: csv(VEXTRIO_ROWS), [FILES[1]!.file]: PUMA });
    await runInfobloxReference(env, { files: FILES });
    log.length = 0;
    const next = VEXTRIO_ROWS.filter((r) => !r.includes("146.103.91.133")).map((r) => r.replace("EXAMPLE-TDS.net.,vextrio", "EXAMPLE-TDS.net.,suspicious"));
    stub({ [FILES[0]!.file]: csv(next), [FILES[1]!.file]: PUMA });
    const r = await runInfobloxReference(env, { files: FILES });
    expect(r.rowsWritten).toBe(2); // 1 upsert (classification change) + 1 removal
    expect(r.rowsRemoved).toBe(1);
    const gone = raw.prepare("SELECT removed_at FROM infoblox_reference WHERE indicator = ?").all("146.103.91.133")[0] as { removed_at: string | null };
    expect(gone.removed_at).not.toBeNull();
    const changed = raw.prepare("SELECT classification FROM infoblox_reference WHERE indicator = ?").all("example-tds.net")[0] as { classification: string };
    expect(changed.classification).toBe("suspicious");
    // A row that comes back is revived.
    stub({ [FILES[0]!.file]: csv(VEXTRIO_ROWS), [FILES[1]!.file]: PUMA });
    await runInfobloxReference(env, { files: FILES });
    expect(count(raw, "SELECT COUNT(*) AS n FROM infoblox_reference WHERE indicator = '146.103.91.133' AND removed_at IS NULL")).toBe(1);
  });

  it("skips the per-file removal when the file shrinks below half its live rows, without stamping, and accepts it on the 3rd same body", async () => {
    const { env, raw } = rig();
    stub({ [FILES[0]!.file]: csv(VEXTRIO_ROWS), [FILES[1]!.file]: { status: 200, etag: '"p1"', body: PUMA } });
    await runInfobloxReference(env, { files: FILES });
    const fileRow = () => raw.prepare("SELECT etag, content_sha256, rows_loaded, pending_sha256, pending_seen FROM infoblox_reference_files WHERE source_file = ?")
      .all(FILES[1]!.file)[0] as { etag: string | null; content_sha256: string | null; rows_loaded: number; pending_sha256: string | null; pending_seen: number };
    expect(fileRow().etag).toBe('"p1"');
    const shrunk = { status: 200, etag: '"p2"', body: csv(["domain,puma0[.]link,malicious,2023-06-01"]) };
    const liveCount = () => count(raw, "SELECT COUNT(*) AS n FROM infoblox_reference WHERE source_file = ? AND removed_at IS NULL", FILES[1]!.file);

    const calls1 = stub({ [FILES[0]!.file]: csv(VEXTRIO_ROWS), [FILES[1]!.file]: shrunk });
    const r1 = await runInfobloxReference(env, { files: FILES });
    expect(calls1[1]!.ifNoneMatch).toBe('"p1"');
    expect(r1.warning).toMatch(/removal skipped .*same body 1\/3/);
    expect(liveCount()).toBe(40);
    // No stamp: the next run cannot answer 304 / same-sha and skip the re-check.
    expect(fileRow()).toMatchObject({ etag: null, content_sha256: null, rows_loaded: 40, pending_seen: 1 });
    expect(fileRow().pending_sha256).toMatch(/^[0-9a-f]{64}$/);

    const calls2 = stub({ [FILES[0]!.file]: csv(VEXTRIO_ROWS), [FILES[1]!.file]: shrunk });
    const r2 = await runInfobloxReference(env, { files: FILES });
    expect(calls2[1]!.ifNoneMatch).toBeNull();
    expect(r2.warning).toMatch(/same body 2\/3/);
    expect(liveCount()).toBe(40);

    stub({ [FILES[0]!.file]: csv(VEXTRIO_ROWS), [FILES[1]!.file]: shrunk });
    const r3 = await runInfobloxReference(env, { files: FILES });
    expect(r3.warning).toMatch(/shrink accepted after 3 runs/);
    expect(r3.rowsRemoved).toBe(39);
    expect(liveCount()).toBe(1);
    expect(fileRow()).toMatchObject({ etag: '"p2"', rows_loaded: 1, pending_sha256: null, pending_seen: 0 });
    expect(fileRow().content_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a different body resets the same-body count", async () => {
    const { env, raw } = rig();
    stub({ [FILES[0]!.file]: csv(VEXTRIO_ROWS), [FILES[1]!.file]: PUMA });
    await runInfobloxReference(env, { files: FILES });
    const a = csv(["domain,puma0[.]link,malicious,2023-06-01"]);
    const b = csv(["domain,puma1[.]link,malicious,2023-06-02"]);
    for (const body of [a, a, b]) {
      stub({ [FILES[0]!.file]: csv(VEXTRIO_ROWS), [FILES[1]!.file]: body });
      await runInfobloxReference(env, { files: FILES });
    }
    const f = raw.prepare("SELECT pending_seen FROM infoblox_reference_files WHERE source_file = ?").all(FILES[1]!.file)[0] as { pending_seen: number };
    expect(f.pending_seen).toBe(1);
    expect(count(raw, "SELECT COUNT(*) AS n FROM infoblox_reference WHERE source_file = ? AND removed_at IS NULL", FILES[1]!.file)).toBe(40);
  });

  it("a file the total cap squeezes to 0 rows has its old rows removed, with a warning", async () => {
    const { env, raw } = rig();
    stub({ [FILES[0]!.file]: csv(VEXTRIO_ROWS), [FILES[1]!.file]: PUMA });
    await runInfobloxReference(env, { files: FILES });
    // Change Puma's body so it is re-read, under a total cap Vextrio uses up.
    stub({ [FILES[0]!.file]: csv(VEXTRIO_ROWS), [FILES[1]!.file]: PUMA + "domain,puma99[.]link,malicious,2023-07-01\r\n" });
    const r = await runInfobloxReference(env, { files: FILES, maxRowsTotal: 5 });
    expect(r.warning).toMatch(/prolific_puma_20231031\.csv: total row cap reached \(kept 0, 41 not kept\)/);
    expect(count(raw, "SELECT COUNT(*) AS n FROM infoblox_reference WHERE source_file = ? AND removed_at IS NULL", FILES[1]!.file)).toBe(0);
    const f = raw.prepare("SELECT rows_loaded, content_sha256 FROM infoblox_reference_files WHERE source_file = ?").all(FILES[1]!.file)[0] as { rows_loaded: number; content_sha256: string | null };
    expect(f.rows_loaded).toBe(0);
    expect(f.content_sha256).not.toBeNull();
  });

  it("does not follow redirects: a 3xx fails the file", async () => {
    const { env } = rig();
    const calls = stub({ [FILES[0]!.file]: { status: 302 }, [FILES[1]!.file]: PUMA });
    await expect(runInfobloxReference(env, { files: FILES })).rejects.toThrow(/HTTP 302 \(redirect not followed\)/);
    expect(calls.every((c) => c.redirect === "manual")).toBe(true);
  });

  it("skips the README check when the run is out of budget", async () => {
    const { env } = rig();
    const calls = stub({});
    const r = await runInfobloxReference(env, { timeBudgetMs: 0 });
    expect(calls).toHaveLength(0);
    expect(r.complete).toBe(false);
  });

  it("a permanently failing file is a warning, not a pull failure, and blocks whole-file removal", async () => {
    const three: InfobloxFile[] = [...FILES, { file: "hazy_hawk_20250520_iocs.csv", label: "Hazy Hawk", kind: "actor", publication: null }];
    const { env, raw } = rig();
    stub({ [three[0]!.file]: csv(VEXTRIO_ROWS), [three[1]!.file]: PUMA, [three[2]!.file]: csv(["domain,hawk.example,malicious,2025-05-20"]) });
    await runInfobloxReference(env, { files: three });
    // Puma's header changed, Hazy Hawk 404s.
    stub({ [three[0]!.file]: csv(VEXTRIO_ROWS), [three[1]!.file]: "a,b,c\n1,2,3\n" });
    const r = await runInfobloxReference(env, { files: three });
    expect(r.filesSkipped).toHaveLength(1);
    expect(r.filesSkipped[0]).toMatch(/prolific_puma.*unexpected header/);
    expect(r.filesFailed).toEqual([]);
    expect(r.complete).toBe(false);
    expect(r.warning).toMatch(/file\(s\) skipped: prolific_puma/);
    expect(count(raw, "SELECT COUNT(*) AS n FROM infoblox_reference WHERE source_file = ? AND removed_at IS NULL", three[2]!.file)).toBe(1);
    expect(count(raw, "SELECT COUNT(*) AS n FROM infoblox_reference WHERE source_file = ? AND removed_at IS NULL", three[1]!.file)).toBe(40);
  });

  it("resumes across runs under a row budget, then becomes complete", async () => {
    const { env, raw } = rig();
    const big = csv(Array.from({ length: 1500 }, (_, i) => `domain,v${i}.example,vextrio,2025-06-01`));
    stub({ [FILES[0]!.file]: big, [FILES[1]!.file]: PUMA });
    const r1 = await runInfobloxReference(env, { files: FILES, rowWriteBudget: 500 });
    expect(r1.complete).toBe(false);
    expect(r1.filesDeferred).toBe(2); // first file cut short, second not started
    expect(r1.rowsWritten).toBe(560); // one batch of 40×14 (budget is checked before each batch)
    expect(count(raw, "SELECT COUNT(*) AS n FROM infoblox_reference_files")).toBe(0); // no stamp → re-read next run
    const r2 = await runInfobloxReference(env, { files: FILES, rowWriteBudget: 500 });
    expect(r2.rowsWritten).toBe(560);
    const r3 = await runInfobloxReference(env, { files: FILES, rowWriteBudget: 500 });
    expect(r3.complete).toBe(true);
    expect(count(raw, "SELECT COUNT(*) AS n FROM infoblox_reference WHERE removed_at IS NULL")).toBe(1540);
  });

  it("a time budget defers files without fetching them", async () => {
    const { env } = rig();
    let t = 0;
    const calls = stub({ [FILES[0]!.file]: PUMA, [FILES[1]!.file]: PUMA });
    const r = await runInfobloxReference(env, { files: FILES, timeBudgetMs: 10, now: () => (t += 6) });
    expect(r.filesDeferred).toBeGreaterThanOrEqual(1);
    expect(calls.length).toBeLessThan(2);
  });

  it("applies the total row cap in catalogue order", async () => {
    const { env, raw } = rig();
    stub({ [FILES[0]!.file]: csv(VEXTRIO_ROWS), [FILES[1]!.file]: PUMA });
    await runInfobloxReference(env, { files: FILES, maxRowsTotal: 15 });
    expect(count(raw, "SELECT COUNT(*) AS n FROM infoblox_reference WHERE source_file = ?", FILES[1]!.file)).toBe(10);
  });

  it("a failed file fails the pull but keeps the others; nothing is removed", async () => {
    const { env, raw } = rig();
    stub({ [FILES[0]!.file]: csv(VEXTRIO_ROWS), [FILES[1]!.file]: PUMA });
    await runInfobloxReference(env, { files: FILES });
    stub({ [FILES[0]!.file]: { status: 500 }, [FILES[1]!.file]: PUMA });
    await expect(runInfobloxReference(env, { files: FILES })).rejects.toThrow(/1 file\(s\) failed/);
    expect(count(raw, "SELECT COUNT(*) AS n FROM infoblox_reference WHERE removed_at IS NULL")).toBe(45);
  });

  it("fails the pull when more than half the files fail permanently (body over the cap, header changed)", async () => {
    const { env } = rig();
    const big = new Uint8Array(INFOBLOX_MAX_FILE_BYTES + 10).fill(32);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(big)));
    await expect(runInfobloxReference(env, { files: [FILES[0]!] })).rejects.toThrow(/larger than/);
    stub({ [FILES[0]!.file]: "a,b,c\n1,2,3\n" });
    await expect(runInfobloxReference(env, { files: [FILES[0]!] })).rejects.toThrow(/unexpected header/);
  });

  it("a 404 file's rows are removed only on a complete pull; a file dropped from the list is retired", async () => {
    const three: InfobloxFile[] = [...FILES, { file: "hazy_hawk_20250520_iocs.csv", label: "Hazy Hawk", kind: "actor", publication: null }];
    const { env, raw } = rig();
    stub({ [three[0]!.file]: csv(VEXTRIO_ROWS), [three[1]!.file]: PUMA, [three[2]!.file]: csv(["domain,hawk.example,malicious,2025-05-20"]) });
    await runInfobloxReference(env, { files: three });
    // Hazy Hawk 404s while Puma fails → incomplete → nothing removed.
    stub({ [three[0]!.file]: csv(VEXTRIO_ROWS), [three[1]!.file]: { status: 503 } });
    await expect(runInfobloxReference(env, { files: three })).rejects.toThrow();
    expect(count(raw, "SELECT COUNT(*) AS n FROM infoblox_reference WHERE source_file = ? AND removed_at IS NULL", three[2]!.file)).toBe(1);
    // Complete pull with the 404 → removed, file marked absent.
    stub({ [three[0]!.file]: csv(VEXTRIO_ROWS), [three[1]!.file]: PUMA });
    const r = await runInfobloxReference(env, { files: three });
    expect(r.filesAbsent).toEqual([three[2]!.file]);
    expect(count(raw, "SELECT COUNT(*) AS n FROM infoblox_reference WHERE source_file = ? AND removed_at IS NULL", three[2]!.file)).toBe(0);
    expect((raw.prepare("SELECT status FROM infoblox_reference_files WHERE source_file = ?").all(three[2]!.file)[0] as { status: string }).status).toBe("absent");
    // Dropped from the catalogue → retired on the next complete pull.
    stub({ [three[0]!.file]: csv(VEXTRIO_ROWS) });
    await runInfobloxReference(env, { files: [three[0]!, three[2]!] }).catch(() => undefined);
    await runInfobloxReference(env, { files: [three[0]!] });
    expect(count(raw, "SELECT COUNT(*) AS n FROM infoblox_reference WHERE source_file = ? AND removed_at IS NULL", three[1]!.file)).toBe(0);
  });

  it("refuses to remove anything when most files 404 (repository moved)", async () => {
    const { env, raw } = rig();
    stub({ [FILES[0]!.file]: csv(VEXTRIO_ROWS), [FILES[1]!.file]: PUMA });
    await runInfobloxReference(env, { files: FILES });
    stub({});
    await expect(runInfobloxReference(env, { files: FILES })).rejects.toThrow(/repository moved/);
    expect(count(raw, "SELECT COUNT(*) AS n FROM infoblox_reference WHERE removed_at IS NULL")).toBe(45);
  });

  it("keeps every statement within D1's 100-bind cap", async () => {
    const { env, log } = rig();
    const big = csv(Array.from({ length: 300 }, (_, i) => `domain,b${i}.example,malicious,2025-01-01`));
    stub({ [FILES[0]!.file]: big, [FILES[1]!.file]: PUMA });
    await runInfobloxReference(env, { files: FILES });
    stub({ [FILES[0]!.file]: csv(["domain,b0.example,malicious,2025-01-01"].concat(Array.from({ length: 200 }, (_, i) => `domain,b${i}.example,malicious,2025-01-01`))), [FILES[1]!.file]: PUMA });
    await runInfobloxReference(env, { files: FILES });
    for (const e of log) expect((e.sql.match(/\?/g) ?? []).length).toBeLessThanOrEqual(100);
  });
});

// ─── Lookup ───────────────────────────────────────────────────────

describe.skipIf(!hasSqlite())("lookupInfobloxReference", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  async function loaded() {
    const r = rig();
    stub({ [FILES[0]!.file]: csv(VEXTRIO_ROWS), [FILES[1]!.file]: PUMA });
    await runInfobloxReference(r.env, { files: FILES });
    return r;
  }

  it("matches the exact domain, a parent domain, a URL host and an IP, with label + credit", async () => {
    const { env } = await loaded();
    const exact = await lookupInfobloxReference(env.DB, { domain: "TopTrendsNews.com" });
    expect(exact).toMatchObject({ credit: INFOBLOX_CREDIT, label_note: INFOBLOX_LABEL_NOTE });
    expect(exact!.matches[0]).toMatchObject({
      indicator: "toptrendsnews.com", match: "exact", infoblox_label: "VexTrio", label_kind: "actor",
      classification: "vextrio", publication_url: "https://example.invalid/vextrio", source_file: FILES[0]!.file,
    });
    const parent = await lookupInfobloxReference(env.DB, { domain: "login.example-tds.net" });
    expect(parent!.matches[0]).toMatchObject({ indicator: "example-tds.net", match: "parent_domain" });
    const viaUrl = await lookupInfobloxReference(env.DB, { url: "https://puma3.link/abc" });
    expect(viaUrl!.matches[0]!.infoblox_label).toBe("Prolific Puma");
    const ip = await lookupInfobloxReference(env.DB, { ip: "5.252.176.63" });
    expect(ip!.matches[0]).toMatchObject({ indicator_type: "ip", match: "exact" });
  });

  it("no match, removed rows, nothing usable or no table → null", async () => {
    const { env, raw } = await loaded();
    expect(await lookupInfobloxReference(env.DB, { domain: "unlisted.example" })).toBeNull();
    expect(await lookupInfobloxReference(env.DB, {})).toBeNull();
    raw.prepare("UPDATE infoblox_reference SET removed_at = '2026-01-01 00:00:00'").run();
    expect(await lookupInfobloxReference(env.DB, { domain: "toptrendsnews.com" })).toBeNull();
    const broken = { prepare: () => { throw new Error("no such table: infoblox_reference"); } } as unknown as D1Database;
    expect(await lookupInfobloxReference(broken, { domain: "toptrendsnews.com" })).toBeNull();
  });
});

// ─── Exposure: staff-only, read-only source graph ─────────────────

const SRC = join(__dirname, "..", "src");
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) out.push(...walk(abs));
    else if (name.endsWith(".ts")) out.push(abs);
  }
  return out;
}
const FILES_SRC = walk(SRC)
  .map((abs) => ({ rel: relative(SRC, abs).split(sep).join("/"), text: readFileSync(abs, "utf8") }))
  .filter((f) => f.rel !== "agents/architect/manifest.generated.ts");
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}
const filesMatching = (re: RegExp) => FILES_SRC.filter((f) => re.test(code(f.text))).map((f) => f.rel).sort();

describe("infoblox reference: reference-only, staff-only source graph", () => {
  it("only the feed and the lib touch the tables", () => {
    expect(filesMatching(/\b(FROM|INTO|UPDATE|JOIN)\s+infoblox_reference(_files)?\b/i)).toEqual([
      "feeds/infobloxReference.ts",
      "lib/infoblox-reference.ts",
    ]);
  });

  it("only the feed and the staff threat handler import the lib", () => {
    expect(filesMatching(/from\s+["'][./]*lib\/infoblox-reference["']/)).toEqual([
      "feeds/infobloxReference.ts",
      "handlers/threats.ts",
    ]);
    expect(filesMatching(/\blookupInfobloxReference\b/)).toEqual(["handlers/threats.ts", "lib/infoblox-reference.ts"]);
  });

  it("no tenant, public, triage, attribution or scoring file uses it", () => {
    const forbidden = FILES_SRC.filter((f) =>
      /((^|\/)tenant[^/]*\.ts$|routes\/tenant\.ts|(^|\/)public[^/]*\.ts$|alert-triage|alert-ai-judge|agents\/attributor|threatScoring|cluster-attribution|otx-attribution|alert-fanout|createAlert)/i.test(f.rel)
      && /infoblox/i.test(code(f.text)),
    ).map((f) => f.rel);
    expect(forbidden).toEqual([]);
  });

  it("the reader never writes: the lib's SQL is SELECT-only", () => {
    const lib = code(readFileSync(join(SRC, "lib/infoblox-reference.ts"), "utf8"));
    expect(lib).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
  });

  it("handleGetThreat is only routed behind requireStaff", () => {
    expect(filesMatching(/\bhandleGetThreat\b/)).toEqual(["handlers/threats.ts", "routes/threats.ts"]);
    const text = readFileSync(join(SRC, "routes/threats.ts"), "utf8");
    const at = text.indexOf('router.get("/api/threats/:id"');
    expect(at).toBeGreaterThan(-1);
    expect(text.slice(at, at + 300)).toMatch(/=>\s*\{\s*const ctx = await requireStaff\(request, env\);\s*if \(!isAuthContext\(ctx\)\) return ctx;\s*return handleGetThreat\(/);
  });
});
