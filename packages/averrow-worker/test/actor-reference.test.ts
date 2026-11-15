/**
 * MISP Galaxy threat-actor reference (feeds/actorReference.ts,
 * lib/actor-reference.ts, migration 0334).
 *
 * Fixtures mirror the live `clusters/threat-actor.json` shape checked on
 * 2026-11-15 (top-level authors/category/description/name/source/type/uuid/
 * values/version; each value {description, meta{country, synonyms,
 * cfr-suspected-state-sponsor, refs, name-attribution, …}, uuid, value}).
 * Bulk entries are synthetic so the plausibility floor (500) is met.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
  normalizeActorName,
  parseMispThreatActorGalaxy,
  resolveFromCandidates,
  lookupActorReference,
  MISP_THREAT_ACTOR_GALAXY_UUID,
  ACTOR_DESCRIPTION_MAX_CHARS,
  ACTOR_REFERENCE_CREDIT,
} from "../src/lib/actor-reference";
import {
  actor_reference,
  actorRemovalSweepAllowed,
  ACTOR_REFERENCE_MAX_BODY_BYTES,
} from "../src/feeds/actorReference";
import { feedModules } from "../src/feeds";
import { hasSqlite, openMigratedDb, d1FromSqlite, type StatementLogEntry, type SqliteDb } from "./sqlite-d1-harness";
import type { Env } from "../src/types";

// ─── Fixture builder ──────────────────────────────────────────────

interface FixtureValue {
  description?: string;
  meta?: Record<string, unknown>;
  uuid?: string;
  value?: string;
}

function uuidFor(n: number): string {
  const h = n.toString(16).padStart(12, "0");
  return `00000000-0000-4000-8000-${h}`;
}

const APT28_UUID = "5b4ee3ea-eee3-4c8e-8323-85ae32658754";
const APT1_UUID = "1cb7e1cc-d695-42b1-92f4-fd0112a3c9be";
const CHARMING_UUID = "3dcc0a26-0f1e-4d5d-9d1c-1e5c4a2a6e01";
const APT35_UUID = "3dcc0a26-0f1e-4d5d-9d1c-1e5c4a2a6e02";

function realishValues(): FixtureValue[] {
  return [
    {
      description: "PLA Unit 61398 (Chinese: 61398部队) is the Military Unit Cover Designator of a People's Liberation Army advanced persistent threat unit",
      meta: {
        "attribution-confidence": "50",
        "cfr-suspected-state-sponsor": "China",
        country: "CN",
        "name-attribution": ["APT1:da5cdcd1-7b15-4371-b7eb-ca32916d2052", "G0006:a1ad5090-2487-46d2-8237-6151a2dd5063"],
        refs: ["https://en.wikipedia.org/wiki/PLA_Unit_61398"],
        synonyms: ["APT 1", "Comment Panda", "PLA Unit 61398", "Comment Crew", "Byzantine Candor"],
      },
      uuid: APT1_UUID,
      value: "Comment Crew",
    },
    {
      description: "The Sofacy Group (also known as APT28, Pawn Storm, Fancy Bear and Sednit) is a cyber espionage group",
      meta: {
        country: "RU",
        "cfr-suspected-state-sponsor": "Russian Federation",
        synonyms: ["APT 28", "Fancy Bear", "Sofacy", "Sednit", "Pawn Storm", "Mercury"],
      },
      uuid: APT28_UUID,
      value: "APT28",
    },
    {
      // "Mercury" also listed here → ambiguous alias.
      description: "MuddyWater is an Iranian threat actor",
      meta: { country: "IR", synonyms: ["Mercury", "Static Kitten", "TEMP.Zagros"] },
      uuid: "b2b6fc3a-9c4c-4c3d-b2f9-3d5d1e8c1a10",
      value: "MuddyWater",
    },
    { description: "Charming Kitten", meta: { country: "IR", synonyms: ["Phosphorus", "Mint Sandstorm"] }, uuid: CHARMING_UUID, value: "Charming Kitten" },
    { description: "APT35", meta: { country: "IR", synonyms: ["Newscaster", "Mint Sandstorm"] }, uuid: APT35_UUID, value: "APT35" },
  ];
}

function bulkValues(n: number, offset = 0): FixtureValue[] {
  return Array.from({ length: n }, (_, i) => ({
    description: `Synthetic actor ${i + offset}`,
    meta: { synonyms: [`SYN-${i + offset}`] },
    uuid: uuidFor(i + offset + 1),
    value: `Synthetic Actor ${i + offset}`,
  }));
}

function galaxy(values: FixtureValue[], version = 359): string {
  return JSON.stringify({
    authors: ["Alexandre Dulaunoy", "Florian Roth"],
    category: "actor",
    description: "Known or estimated adversary groups targeting organizations and employees.",
    name: "Threat Actor",
    source: "MISP Project",
    type: "threat-actor",
    uuid: MISP_THREAT_ACTOR_GALAXY_UUID,
    values,
    version,
  });
}

const FULL = (): FixtureValue[] => [...realishValues(), ...bulkValues(600)];

// ─── Normaliser ───────────────────────────────────────────────────

describe("normalizeActorName", () => {
  it.each([
    ["APT28", "apt28"],
    ["APT-28", "apt28"],
    ["apt 28", "apt28"],
    ["APT_28", "apt28"],
    ["  TA-505 ", "ta505"],
    ["TEMP.Zagros", "tempzagros"],
    ["The Lazarus Group", "lazarusgroup"],
    ["Sofacy™", "sofacytm"],
    ["Žirafa", "zirafa"],
    ["ＡＰＴ２８", "apt28"], // full-width (NFKC)
    ["61398部队", "61398部队"],
  ])("%j → %j", (input, out) => {
    expect(normalizeActorName(input)).toBe(out);
  });

  it.each([[""], ["-"], ["A"], [" . "], [null], [42], [undefined]])("%j → null", (input) => {
    expect(normalizeActorName(input)).toBeNull();
  });

  it("does not strip group/team words (no false merges)", () => {
    expect(normalizeActorName("Equation Group")).not.toBe(normalizeActorName("Equation"));
  });
});

// ─── Parser ───────────────────────────────────────────────────────

describe("parseMispThreatActorGalaxy", () => {
  it("parses the real shape: id, aliases (name + synonyms, deduped by key), country, sponsor", async () => {
    const p = await parseMispThreatActorGalaxy(galaxy(realishValues()));
    expect(p.version).toBe("359");
    expect(p.declared).toBe(5);
    expect(p.malformed).toBe(0);
    const apt1 = p.records.find((r) => r.sourceUuid === APT1_UUID)!;
    expect(apt1.id).toBe(`misp:${APT1_UUID}`);
    expect(apt1.name).toBe("Comment Crew");
    expect(apt1.countryCode).toBe("CN");
    expect(apt1.stateSponsor).toBe("China");
    // "Comment Crew" synonym duplicates the canonical name → kept once.
    expect(apt1.aliases.map((a) => a.original)).toEqual(["Comment Crew", "APT 1", "Comment Panda", "PLA Unit 61398", "Byzantine Candor"]);
    // name-attribution is NOT read (it carries ATT&CK ids like G0006).
    expect(apt1.aliases.some((a) => a.norm === "g0006")).toBe(false);
    expect(apt1.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("caps the description", async () => {
    const v = realishValues();
    v[0]!.description = "x".repeat(5000);
    const p = await parseMispThreatActorGalaxy(galaxy(v));
    expect(p.records[0]!.description!.length).toBe(ACTOR_DESCRIPTION_MAX_CHARS);
  });

  it("drops a non-ISO country and counts malformed entries (no uuid, bad uuid, no name, duplicate uuid)", async () => {
    const v: FixtureValue[] = [
      { meta: { country: "Russia" }, uuid: uuidFor(1), value: "Good" },
      { value: "No uuid" },
      { uuid: "not-a-uuid", value: "Bad uuid" },
      { uuid: uuidFor(2) },
      { uuid: uuidFor(1), value: "Dup" },
    ];
    const p = await parseMispThreatActorGalaxy(galaxy(v));
    expect(p.records).toHaveLength(1);
    expect(p.records[0]!.countryCode).toBeNull();
    expect(p.malformed).toBe(4);
  });

  it("hash changes when an alias changes, not otherwise", async () => {
    const a = await parseMispThreatActorGalaxy(galaxy(realishValues()));
    const b = await parseMispThreatActorGalaxy(galaxy(realishValues(), 360));
    expect(b.records.map((r) => r.contentHash)).toEqual(a.records.map((r) => r.contentHash));
    const v = realishValues();
    (v[1]!.meta!.synonyms as string[]).push("Strontium");
    const c = await parseMispThreatActorGalaxy(galaxy(v));
    expect(c.records[1]!.contentHash).not.toBe(a.records[1]!.contentHash);
    expect(c.records[0]!.contentHash).toBe(a.records[0]!.contentHash);
  });

  it.each([
    ["not JSON", "<html>rate limited</html>"],
    ["a JSON array", "[]"],
    ["another galaxy", JSON.stringify({ uuid: "59f20cce-5420-4084-afd5-0884c0a83832", type: "ransomware", values: [] })],
    ["no values", JSON.stringify({ uuid: MISP_THREAT_ACTOR_GALAXY_UUID, type: "threat-actor" })],
  ])("throws on %s", async (_label, body) => {
    await expect(parseMispThreatActorGalaxy(body)).rejects.toThrow(/actor_reference/);
  });
});

// ─── Resolver (pure) ──────────────────────────────────────────────

describe("resolveFromCandidates", () => {
  const cands = new Map<string, Set<string>>([
    ["apt28", new Set(["misp:a"])],
    ["fancybear", new Set(["misp:a"])],
    ["mercury", new Set(["misp:a", "misp:b"])],
    ["muddywater", new Set(["misp:b"])],
  ]);

  it("resolves an unambiguous key", () => {
    expect(resolveFromCandidates(["apt28"], cands)).toEqual({ referenceId: "misp:a", matchedKey: "apt28" });
  });
  it("an ambiguous alias alone resolves to nothing", () => {
    expect(resolveFromCandidates(["mercury"], cands)).toBeNull();
  });
  it("an ambiguous alias contributes nothing; an unambiguous name still resolves", () => {
    expect(resolveFromCandidates(["muddywater", "mercury"], cands)).toEqual({ referenceId: "misp:b", matchedKey: "muddywater" });
  });
  it("unambiguous keys that disagree resolve to nothing", () => {
    expect(resolveFromCandidates(["apt28", "muddywater"], cands)).toBeNull();
  });
  it("agreeing keys resolve; unknown keys are ignored", () => {
    expect(resolveFromCandidates(["nope", "fancybear", "apt28"], cands)).toEqual({ referenceId: "misp:a", matchedKey: "fancybear" });
  });
  it("nothing matches → null", () => {
    expect(resolveFromCandidates(["nope"], cands)).toBeNull();
  });
});

describe("actorRemovalSweepAllowed", () => {
  it("needs a clean, complete, non-shrunken pull", () => {
    expect(actorRemovalSweepAllowed({ malformed: 0, batchFailures: 0, parsed: 1000, liveBefore: 1100 })).toBe(true);
    expect(actorRemovalSweepAllowed({ malformed: 1, batchFailures: 0, parsed: 1000, liveBefore: 1000 })).toBe(false);
    expect(actorRemovalSweepAllowed({ malformed: 0, batchFailures: 1, parsed: 1000, liveBefore: 1000 })).toBe(false);
    expect(actorRemovalSweepAllowed({ malformed: 0, batchFailures: 0, parsed: 700, liveBefore: 1000 })).toBe(false);
    expect(actorRemovalSweepAllowed({ malformed: 0, batchFailures: 0, parsed: 499, liveBefore: 0 })).toBe(false);
  });
});

// ─── Feed module against the migrated schema ──────────────────────

interface Rig { raw: SqliteDb; env: Env; log: StatementLogEntry[] }

function rig(): Rig {
  const raw = openMigratedDb();
  const log: StatementLogEntry[] = [];
  const env = { DB: d1FromSqlite(raw, { log }) } as unknown as Env;
  return { raw, env, log };
}

function stubFetch(body: string, status = 200) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status })));
}

const writes = (log: StatementLogEntry[]) => log.filter((e) => !/^\s*SELECT/i.test(e.sql));
const ctxFor = (env: Env) => ({ env, feedName: "actor_reference", feedUrl: "" });
const count = (raw: SqliteDb, sql: string) => (raw.prepare(sql).all()[0] as { n: number }).n;

describe.skipIf(!hasSqlite())("actor_reference feed", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("is registered and is a context feed (itemsNew 0)", async () => {
    expect(feedModules.actor_reference).toBe(actor_reference);
    const { env, raw } = rig();
    stubFetch(galaxy(FULL()));
    const r = await actor_reference.ingest(ctxFor(env));
    expect(r.itemsNew).toBe(0);
    expect(r.itemsFetched).toBe(605);
    expect(r.itemsError).toBe(0);
    expect(r.warning).toBeUndefined();
    expect(count(raw, "SELECT COUNT(*) AS n FROM actor_reference WHERE removed_at IS NULL")).toBe(605);
    expect(count(raw, "SELECT COUNT(*) AS n FROM threats")).toBe(0);
    const row = raw.prepare("SELECT * FROM actor_reference WHERE id = ?").all(`misp:${APT28_UUID}`)[0] as Record<string, unknown>;
    expect(row).toMatchObject({ name: "APT28", country_code: "RU", source: "misp_galaxy", source_version: "359", state_sponsor: "Russian Federation" });
    const aliases = raw.prepare("SELECT alias_norm FROM actor_reference_aliases WHERE reference_id = ? ORDER BY position").all(`misp:${APT28_UUID}`) as Array<{ alias_norm: string }>;
    expect(aliases.map((a) => a.alias_norm)).toEqual(["apt28", "fancybear", "sofacy", "sednit", "pawnstorm", "mercury"]);
  });

  it("a second identical pull writes nothing", async () => {
    const { env, log } = rig();
    stubFetch(galaxy(FULL()));
    await actor_reference.ingest(ctxFor(env));
    log.length = 0;
    stubFetch(galaxy(FULL(), 360)); // version bump alone is not a change
    const r = await actor_reference.ingest(ctxFor(env));
    expect(writes(log)).toEqual([]);
    expect(log.filter((e) => /^\s*SELECT/i.test(e.sql))).toHaveLength(1);
    expect(r.itemsDuplicate).toBe(605);
  });

  it("rewrites only the changed actor and replaces its aliases", async () => {
    const { env, log, raw } = rig();
    stubFetch(galaxy(FULL()));
    await actor_reference.ingest(ctxFor(env));
    log.length = 0;
    const v = FULL();
    v[1]!.meta!.synonyms = ["Fancy Bear", "Strontium"];
    stubFetch(galaxy(v));
    await actor_reference.ingest(ctxFor(env));
    const w = writes(log);
    expect(w.length).toBe(3); // upsert + alias delete + one alias insert
    const aliases = raw.prepare("SELECT alias_original FROM actor_reference_aliases WHERE reference_id = ? ORDER BY position").all(`misp:${APT28_UUID}`) as Array<{ alias_original: string }>;
    expect(aliases.map((a) => a.alias_original)).toEqual(["APT28", "Fancy Bear", "Strontium"]);
    const first = raw.prepare("SELECT first_seen, updated_at FROM actor_reference WHERE id = ?").all(`misp:${APT28_UUID}`)[0] as { first_seen: string; updated_at: string };
    expect(first.first_seen <= first.updated_at).toBe(true);
  });

  it("stamps removed_at on a complete pull, and clears it when the actor returns", async () => {
    const { env, raw } = rig();
    stubFetch(galaxy(FULL()));
    await actor_reference.ingest(ctxFor(env));
    const without = FULL().filter((v) => v.uuid !== APT28_UUID);
    stubFetch(galaxy(without));
    await actor_reference.ingest(ctxFor(env));
    const removed = raw.prepare("SELECT removed_at FROM actor_reference WHERE id = ?").all(`misp:${APT28_UUID}`)[0] as { removed_at: string | null };
    expect(removed.removed_at).not.toBeNull();
    expect(await lookupActorReference(env.DB, ["APT28"])).toBeNull();

    stubFetch(galaxy(FULL()));
    await actor_reference.ingest(ctxFor(env));
    const back = raw.prepare("SELECT removed_at FROM actor_reference WHERE id = ?").all(`misp:${APT28_UUID}`)[0] as { removed_at: string | null };
    expect(back.removed_at).toBeNull();
  });

  it("skips the removal sweep when the pull shrinks below 80% of the live rows", async () => {
    const { env, raw } = rig();
    stubFetch(galaxy([...realishValues(), ...bulkValues(900)]));
    await actor_reference.ingest(ctxFor(env));
    stubFetch(galaxy([...realishValues(), ...bulkValues(600)]));
    const r = await actor_reference.ingest(ctxFor(env));
    expect(r.warning).toMatch(/removal sweep skipped/);
    expect(count(raw, "SELECT COUNT(*) AS n FROM actor_reference WHERE removed_at IS NOT NULL")).toBe(0);
  });

  it("skips the removal sweep when any entry was malformed", async () => {
    const { env, raw } = rig();
    stubFetch(galaxy(FULL()));
    await actor_reference.ingest(ctxFor(env));
    const v = FULL().filter((x) => x.uuid !== APT28_UUID);
    v.push({ value: "no uuid" });
    stubFetch(galaxy(v));
    const r = await actor_reference.ingest(ctxFor(env));
    expect(r.warning).toMatch(/1 malformed/);
    expect(r.warning).toMatch(/removal sweep skipped/);
    expect(count(raw, "SELECT COUNT(*) AS n FROM actor_reference WHERE removed_at IS NOT NULL")).toBe(0);
  });

  it.each([
    ["an implausibly small galaxy", () => galaxy(realishValues()), 200, /implausibly small/],
    ["an empty body", () => "", 200, /not JSON/],
    ["a garbled body", () => galaxy(FULL()).slice(0, 5000), 200, /not JSON/],
    ["an HTTP error", () => "nope", 503, /HTTP 503/],
  ])("fails the pull on %s and writes nothing", async (_l, body, status, err) => {
    const { env, log } = rig();
    stubFetch(body(), status);
    await expect(actor_reference.ingest(ctxFor(env))).rejects.toThrow(err);
    expect(writes(log)).toEqual([]);
  });

  it("fails the pull on a body over the cap", async () => {
    const { env } = rig();
    const big = new Uint8Array(ACTOR_REFERENCE_MAX_BODY_BYTES + 10).fill(32);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(big)));
    await expect(actor_reference.ingest(ctxFor(env))).rejects.toThrow(/larger than/);
  });

  it("keeps every statement within D1's 100-bind cap", async () => {
    const { env, log } = rig();
    const v = FULL();
    v[0]!.meta!.synonyms = Array.from({ length: 150 }, (_, i) => `Alias ${i}`);
    stubFetch(galaxy(v));
    await actor_reference.ingest(ctxFor(env));
    for (const e of log) expect((e.sql.match(/\?/g) ?? []).length).toBeLessThanOrEqual(100);
  });
});

// ─── Lookup against the migrated schema ───────────────────────────

describe.skipIf(!hasSqlite())("lookupActorReference", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  async function loaded() {
    const r = rig();
    stubFetch(galaxy(FULL()));
    await actor_reference.ingest(ctxFor(r.env));
    return r;
  }

  it("resolves a name variant to the reference with aliases and credit", async () => {
    const { env } = await loaded();
    const ref = await lookupActorReference(env.DB, ["Fancy-Bear"]);
    expect(ref).toMatchObject({
      id: `misp:${APT28_UUID}`, name: "APT28", country_code: "RU",
      state_sponsor: "Russian Federation", source: "misp_galaxy", matched_on: "Fancy-Bear",
      credit: ACTOR_REFERENCE_CREDIT,
    });
    expect(ref!.aliases).toContain("Fancy Bear");
    expect(ref!.aliases).not.toContain("APT28");
  });

  it("an ambiguous alias resolves to nothing", async () => {
    const { env } = await loaded();
    expect(await lookupActorReference(env.DB, ["Mercury"])).toBeNull();
    expect(await lookupActorReference(env.DB, ["Mint Sandstorm"])).toBeNull();
  });

  it("ignores an ambiguous alias when the actor's name is unambiguous", async () => {
    const { env } = await loaded();
    expect((await lookupActorReference(env.DB, ["MuddyWater", "Mercury"]))?.name).toBe("MuddyWater");
  });

  it("name and alias pointing at different references → null", async () => {
    const { env } = await loaded();
    expect(await lookupActorReference(env.DB, ["Charming Kitten", "APT35"])).toBeNull();
  });

  it("no match, no usable names, or no table → null", async () => {
    const { env } = await loaded();
    expect(await lookupActorReference(env.DB, ["Nobody Here"])).toBeNull();
    expect(await lookupActorReference(env.DB, ["", "-"])).toBeNull();
    const bare = openMigratedDb({ exclude: ["0334_actor_reference.sql"] });
    expect(await lookupActorReference(d1FromSqlite(bare), ["APT28"])).toBeNull();
  });
});

// ─── Exposure: staff-only source graph ────────────────────────────

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
const FILES = walk(SRC)
  .map((abs) => ({ rel: relative(SRC, abs).split(sep).join("/"), text: readFileSync(abs, "utf8") }))
  .filter((f) => f.rel !== "agents/architect/manifest.generated.ts");
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}
const filesMatching = (re: RegExp) => FILES.filter((f) => re.test(code(f.text))).map((f) => f.rel).sort();

describe("actor reference: reference-only, staff-only source graph", () => {
  it("only the feed and the lib touch the reference tables", () => {
    expect(filesMatching(/\b(FROM|INTO|UPDATE|JOIN)\s+actor_reference(_aliases)?\b/i)).toEqual([
      "feeds/actorReference.ts",
      "lib/actor-reference.ts",
    ]);
  });

  it("only the staff threat-actor handler (and the feed) use the reference lib", () => {
    expect(filesMatching(/from\s+["'][./]*lib\/actor-reference["']/)).toEqual([
      "feeds/actorReference.ts",
      "handlers/threatActors.ts",
    ]);
    expect(filesMatching(/\blookupActorReference\b/)).toEqual([
      "handlers/threatActors.ts",
      "lib/actor-reference.ts",
    ]);
  });

  it("no write path: Attributor, OTX inheritance and tenant files never use it", () => {
    const forbidden = FILES.filter((f) =>
      /(agents\/attributor|lib\/otx-attribution|lib\/cluster-attribution-inherit|(^|\/)tenant[^/]*\.ts$|routes\/tenant\.ts|(^|\/)public[^/]*\.ts$)/.test(f.rel)
      && /actor-reference|actor_reference|lookupActorReference|normalizeActorName/.test(code(f.text)),
    ).map((f) => f.rel);
    expect(forbidden).toEqual([]);
  });

  it("the reader never writes: the lib's SQL outside the feed is SELECT-only", () => {
    const lib = code(readFileSync(join(SRC, "lib/actor-reference.ts"), "utf8"));
    expect(lib).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
  });

  it("handleGetThreatActor is only routed behind requireStaff", () => {
    expect(filesMatching(/\bhandleGetThreatActor\b/)).toEqual(["handlers/threatActors.ts", "routes/threatActors.ts"]);
    const text = readFileSync(join(SRC, "routes/threatActors.ts"), "utf8");
    const at = text.indexOf('router.get("/api/threat-actors/:id"');
    expect(at).toBeGreaterThan(-1);
    expect(text.slice(at, at + 400)).toMatch(/=>\s*\{\s*const ctx = await requireStaff\(request, env\);\s*if \(!isAuthContext\(ctx\)\) return ctx;\s*return handleGetThreatActor\(/);
  });
});
