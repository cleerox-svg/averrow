// IdP-first enrichment slices (lib/idp-enrichment-priority.ts, migration
// 0291): VT / SecLookup / Pulsedive read a reserved slice of IdP-family
// threats (any severity) before their severity-ordered batch.
//
// Plans are pinned against the migration-derived threats schema with every
// live index replayed from migrations/ — the index set prod can pick from.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  IDP_PULSEDIVE_SLICE_SQL,
  IDP_SECLOOKUP_SLICE_SQL,
  IDP_SLICE_PULSEDIVE,
  IDP_SLICE_SECLOOKUP,
  IDP_SLICE_VIRUSTOTAL,
  IDP_VT_SLICE_SQL,
  mergeIdpFirst,
  readIdpSlice,
} from "../src/lib/idp-enrichment-priority";
import { IDP_FAMILY_TECHNIQUES } from "../src/lib/idp-impersonation";
import { d1FromSqlite, hasSqlite, openDerivedDb, type SqliteDb } from "./sqlite-d1-harness";
import { liveIndexDdl } from "./migration-indexes";

const noSqlite = !hasSqlite();
const IDP = IDP_FAMILY_TECHNIQUES[0]!;
const SLICES = [
  { name: "virustotal", sql: IDP_VT_SLICE_SQL, index: "idx_threats_idp_vt_pending", flag: "vt_checked" },
  { name: "seclookup", sql: IDP_SECLOOKUP_SLICE_SQL, index: "idx_threats_idp_seclookup_pending", flag: "seclookup_checked" },
  { name: "pulsedive", sql: IDP_PULSEDIVE_SLICE_SQL, index: "idx_threats_idp_pulsedive_pending", flag: "pulsedive_checked" },
] as const;

function openThreats(): SqliteDb {
  const raw = openDerivedDb(["threats"]);
  for (const ddl of liveIndexDdl("threats").values()) raw.exec(ddl);
  return raw;
}

afterEach(() => vi.restoreAllMocks());

describe.skipIf(noSqlite)("slice plans (EXPLAIN on real SQLite)", () => {
  for (const s of SLICES) {
    it(`${s.name}: range-seeks its partial index on created_at — no table scan, no ORDER BY sort`, () => {
      const raw = openThreats();
      const p = (raw.prepare(`EXPLAIN QUERY PLAN ${s.sql}`).all(...IDP_FAMILY_TECHNIQUES, 10) as Array<{ detail: string }>)
        .map((r) => r.detail).join("\n");
      expect(p).toMatch(new RegExp(`SEARCH threats USING INDEX ${s.index} \\(created_at>\\?\\)`));
      expect(p).not.toMatch(/SCAN threats/);
      expect(p).not.toMatch(/TEMP B-TREE FOR ORDER BY/);
    });

    it(`${s.name}: bind arity = family + limit`, () => {
      expect((s.sql.match(/\?/g) ?? []).length).toBe(IDP_FAMILY_TECHNIQUES.length + 1);
    });
  }

  it("the partial indexes exist in the migration-replayed index set", () => {
    const live = liveIndexDdl("threats");
    for (const s of SLICES) {
      const ddl = live.get(s.index);
      expect(ddl, s.index).toBeDefined();
      expect(ddl).toMatch(new RegExp(`${s.flag} = 0`));
      expect(ddl).toMatch(/technique IS NOT NULL/);
    }
  });
});

describe.skipIf(noSqlite)("slice selection on real SQLite", () => {
  function seed(): D1Database {
    const raw = openThreats();
    const ins = raw.prepare(`
      INSERT INTO threats (id, source_feed, threat_type, malicious_domain, ip_address, severity, technique,
                           vt_checked, seclookup_checked, pulsedive_checked, created_at)
      VALUES (?, 'f', 'phishing', ?, NULL, ?, ?, ?, ?, ?, datetime('now', ?))`);
    ins.run("idp-med", "idp-med.example", "medium", IDP, 0, 0, 0, "-1 hours");     // IdP, medium → picked
    ins.run("idp-low", "idp-low.example", "low", IDP, 0, 0, 0, "-2 hours");        // IdP, low → picked
    ins.run("idp-done", "idp-done.example", "high", IDP, 1, 1, 1, "-1 hours");     // already checked
    ins.run("idp-old", "idp-old.example", "high", IDP, 0, 0, 0, "-10 days");       // outside window
    ins.run("other-tech", "other.example", "high", "credential_harvesting", 0, 0, 0, "-1 hours"); // not IdP
    ins.run("plain", "plain.example", "critical", null, 0, 0, 0, "-1 hours");      // no technique
    return d1FromSqlite(raw);
  }

  it("each slice returns only unchecked, in-window IdP rows — any severity — newest first", async () => {
    const db = seed();
    const vt = await readIdpSlice<{ malicious_domain: string }>(db, IDP_VT_SLICE_SQL, 10);
    expect(vt.map((r) => r.malicious_domain)).toEqual(["idp-med.example", "idp-low.example"]);
    const sl = await readIdpSlice<{ id: string }>(db, IDP_SECLOOKUP_SLICE_SQL, 10);
    expect(sl.map((r) => r.id)).toEqual(["idp-med", "idp-low"]);
    const pd = await readIdpSlice<{ id: string; indicator: string }>(db, IDP_PULSEDIVE_SLICE_SQL, 10);
    expect(pd).toEqual([{ id: "idp-med", indicator: "idp-med.example" }, { id: "idp-low", indicator: "idp-low.example" }]);
  });

  it("the slice limit is honoured", async () => {
    const db = seed();
    expect(await readIdpSlice(db, IDP_SECLOOKUP_SLICE_SQL, 1)).toHaveLength(1);
    expect(await readIdpSlice(db, IDP_SECLOOKUP_SLICE_SQL, 0)).toEqual([]);
  });

  it("a failing slice read returns [] (feed proceeds as before)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const raw = openDerivedDb(["threats"]); // no 0291 indexes → INDEXED BY fails
    expect(await readIdpSlice(d1FromSqlite(raw), IDP_VT_SLICE_SQL, 3)).toEqual([]);
  });
});

describe("mergeIdpFirst — reserved slice within the cap", () => {
  const key = (r: { id: string }) => r.id;
  const rows = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}` }));

  it("IdP rows lead, the regular selector fills the rest up to the cap", () => {
    const out = mergeIdpFirst(rows("idp", IDP_SLICE_VIRUSTOTAL), rows("sev", 10), key, 10);
    expect(out).toHaveLength(10);
    expect(out.slice(0, 3).map(key)).toEqual(["idp0", "idp1", "idp2"]);
    expect(out.slice(3).map(key)).toEqual(["sev0", "sev1", "sev2", "sev3", "sev4", "sev5", "sev6"]);
  });

  it("dedupes a row returned by both selectors", () => {
    const out = mergeIdpFirst([{ id: "x" }], [{ id: "x" }, { id: "y" }], key, 10);
    expect(out.map(key)).toEqual(["x", "y"]);
  });

  it("slices are a minority of each batch", () => {
    expect(IDP_SLICE_VIRUSTOTAL).toBeLessThan(10);
    expect(IDP_SLICE_SECLOOKUP).toBeLessThan(100);
    expect(IDP_SLICE_PULSEDIVE).toBeLessThan(8);
  });
});

describe("feeds wire their slice ahead of the severity selector", () => {
  const SRC = resolve(__dirname, "..", "src", "feeds");
  const cases = [
    { file: "virustotal.ts", sql: "IDP_VT_SLICE_SQL", slice: "IDP_SLICE_VIRUSTOTAL" },
    { file: "seclookup.ts", sql: "IDP_SECLOOKUP_SLICE_SQL", slice: "IDP_SLICE_SECLOOKUP" },
    { file: "pulsedive.ts", sql: "IDP_PULSEDIVE_SLICE_SQL", slice: "IDP_SLICE_PULSEDIVE" },
  ];
  for (const c of cases) {
    it(c.file, () => {
      const src = readFileSync(resolve(SRC, c.file), "utf8");
      const read = src.indexOf(`readIdpSlice`, src.indexOf("ingest("));
      expect(read).toBeGreaterThan(0);
      expect(src.slice(read, read + 200)).toContain(c.sql);
      expect(src).toContain(c.slice);
      expect(src).toMatch(/mergeIdpFirst\(idpSlice, unchecked\.results/);
    });
  }
});
