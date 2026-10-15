// GET /api/observatory/events — the Observatory event rail.
//
// Handlers run against real SQLite built from EVERY migration (tables AND
// indexes — openMigratedDb), so a phantom column fails as "no such column"
// and the plan pins at the bottom see the production index set, including
// the competing ones. What this pins:
//   1. Params: period / kinds allow-lists (400, no KV key), limit clamping,
//      kinds canonicalisation.
//   2. Cache key: period + kinds + limit + role class; a second call is
//      served from KV with no SQL.
//   3. Each source on seeded rows — inclusion, exclusion, grouping, the
//      exact title copy, place and Observatory target.
//   4. Retired clusters never surface (operation + actor kinds).
//   5. takedown is manage_takedowns data: dropped for every other staff role
//      before any read, and keyed separately.
//   6. Ordering, limit, counts_by_kind, source isolation.
//   7. EXPLAIN QUERY PLAN of every read the handler issues, at scale, with
//      and without sqlite_stat1.

import { describe, it, expect, beforeAll } from "vitest";
import {
  handleObservatoryEvents,
  parseEventsParams,
  eventsCacheKey,
  CRITICAL_BRANDS_SQL,
  eventsRoleSegment,
  eventsWindowStart,
  permittedGatedKinds,
  GATED_KINDS,
  EVENTS_FAILED_TTL_S,
  fitTitle,
  durationPhrase,
  countrySuffix,
  threatNoun,
  operationLabel,
  displayHost,
  toIsoUtc,
  dominantClusterCountry,
  buildSpikeEvents,
  EVENT_KINDS,
  EVENTS_TTL_S,
  EVENTS_DEFAULT_LIMIT,
  EVENTS_MAX_LIMIT,
  TITLE_MAX,
  SPIKE_MIN_COUNT,
  type ObservatoryEvent,
  type EventKind,
  type EventsEnvelope,
} from "../src/handlers/observatoryEvents";
import { hasSqlite, openMigratedDb, d1FromSqlite, type SqliteDb, type StatementLogEntry } from "./sqlite-d1-harness";
import type { Env, UserRole } from "../src/types";

// ─── Harness ──────────────────────────────────────────────────────────

interface KvEntry { value: string; ttl?: number }
function kvStore() {
  const store = new Map<string, KvEntry>();
  return {
    store,
    get: async (k: string) => store.get(k)?.value ?? null,
    put: async (k: string, value: string, opts?: { expirationTtl?: number }) => {
      store.set(k, { value, ttl: opts?.expirationTtl });
    },
    delete: async (k: string) => { store.delete(k); },
  };
}

function makeEnv(raw: SqliteDb) {
  const log: StatementLogEntry[] = [];
  const db = d1FromSqlite(raw, { log });
  const withSession = () => ({ prepare: db.prepare.bind(db), getBookmark: () => null });
  const kv = kvStore();
  const env = { DB: { ...db, prepare: db.prepare, batch: db.batch, withSession }, CACHE: kv } as unknown as Env;
  return { env, kv, log };
}

const req = (path: string) => new Request(`https://averrow.com${path}`);
const as = (role: UserRole) => ({ role });

async function call(env: Env, path: string, role: UserRole = "analyst") {
  const res = await handleObservatoryEvents(req(path), env, as(role));
  return { res, body: (await res.json()) as EventsEnvelope & { error?: string } };
}

const eventKeys = (kv: ReturnType<typeof kvStore>) => [...kv.store.keys()].filter((k) => k.startsWith("cv:observatory_events."));

/** 'YYYY-MM-DD HH:MM:SS', `min` minutes ago. */
function ts(minAgo: number): string {
  return new Date(Date.now() - minAgo * 60_000).toISOString().replace("T", " ").slice(0, 19);
}
/** Top of the hour `h` hours ago, cube form. */
function hourBucket(h: number): string {
  const d = new Date(Date.now() - h * 3_600_000);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString().replace("T", " ").slice(0, 19);
}

// ─── Seed helpers ─────────────────────────────────────────────────────

function brand(db: SqliteDb, id: string, name: string, tier: "tracked" | "monitored" | "customer" = "monitored") {
  db.prepare("INSERT INTO brands (id, name, canonical_domain, tier) VALUES (?, ?, ?, ?)").run(id, name, `${id}.example`, tier);
}
function brandCube(db: SqliteDb, hour: string, brandId: string, type: string, sev: string, n: number, feed = "feed_a") {
  db.prepare(`INSERT INTO threat_cube_brand (hour_bucket, target_brand_id, threat_type, severity, source_feed, threat_count)
    VALUES (?, ?, ?, ?, ?, ?)`).run(hour, brandId, type, sev, feed, n);
}
function arcsCube(db: SqliteDb, hour: string, brandId: string, cc: string, type: string, sev: string, n: number,
  lat: number | null, lng: number | null, lastSeen: string, feed = "feed_a") {
  db.prepare(`INSERT INTO threat_cube_arcs (hour_bucket, country_code, target_brand_id, threat_type, severity, source_feed,
    threat_count, source_lat, source_lng, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(hour, cc, brandId, type, sev, feed, n, lat, lng, lastSeen, lastSeen);
}
function cluster(db: SqliteDb, c: { id: string; name: string | null; retired?: string | null; actor?: string | null;
  countryCounts?: string | null; countries?: string | null }) {
  db.prepare(`INSERT INTO infrastructure_clusters (id, cluster_name, status, retired_reason, actor_id, country_counts, countries, threat_count)
    VALUES (?, ?, 'active', ?, ?, ?, ?, 10)`).run(c.id, c.name, c.retired ?? null, c.actor ?? null, c.countryCounts ?? null, c.countries ?? null);
}
function pivot(db: SqliteDb, id: string, at: string, payload: Record<string, unknown>) {
  db.prepare(`INSERT INTO agent_events (id, event_type, source_agent, target_agent, payload_json, created_at, status)
    VALUES (?, 'pivot_detected', 'nexus', 'observer', ?, ?, 'done')`).run(id, JSON.stringify(payload), at);
}
function threat(db: SqliteDb, t: { id: string; domain: string | null; brand?: string | null; cc?: string | null; lat?: number | null;
  lng?: number | null; flag?: string | null; hours?: number | null; created: string; status?: string; severity?: string; provider?: string | null }) {
  db.prepare(`INSERT INTO threats (id, source_feed, threat_type, malicious_domain, target_brand_id, country_code, lat, lng,
    weaponization_flag, weaponization_hours, created_at, first_seen, last_seen, status, severity, hosting_provider_id)
    VALUES (?, 'feed_a', 'phishing', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(t.id, t.domain, t.brand ?? null, t.cc ?? null, t.lat ?? null, t.lng ?? null, t.flag ?? null, t.hours ?? null,
      t.created, t.created, t.created, t.status ?? "active", t.severity ?? "high", t.provider ?? null);
}
function lookalike(db: SqliteDb, l: { id: string; brand: string; domain: string; firstSeen: string | null;
  evidence?: string | null; status?: string; level?: string | null }) {
  db.prepare(`INSERT INTO lookalike_domains (id, brand_id, domain, permutation_type, first_seen, registration_evidence, status, threat_level, registered)
    VALUES (?, ?, ?, 'homoglyph', ?, ?, ?, ?, 1)`)
    .run(l.id, l.brand, l.domain, l.firstSeen, l.evidence === undefined ? "observed" : l.evidence, l.status ?? "monitoring", l.level ?? null);
}
function takedown(db: SqliteDb, t: { id: string; brand: string; target: string; status?: string; submitted: string | null;
  resolved: string | null; sourceType?: string; sourceId?: string | null }) {
  db.prepare(`INSERT INTO takedown_requests (id, brand_id, target_type, target_value, evidence_summary, status, submitted_at,
    resolved_at, source_type, source_id, created_at) VALUES (?, ?, 'domain', ?, 'evidence', ?, ?, ?, ?, ?, ?)`)
    .run(t.id, t.brand, t.target, t.status ?? "taken_down", t.submitted, t.resolved, t.sourceType ?? "lookalike", t.sourceId ?? null, t.submitted ?? ts(600));
}
function actor(db: SqliteDb, id: string, name: string) {
  db.prepare("INSERT INTO threat_actors (id, name, status) VALUES (?, ?, 'active')").run(id, name);
}
function attribution(db: SqliteDb, id: string, clusterId: string, actorId: string, source: string, observed: string) {
  db.prepare(`INSERT INTO threat_attributions (id, threat_id, actor_id, source, source_pulse_id, confidence, observed_at)
    VALUES (?, ?, ?, ?, ?, 'low', ?)`).run(id, `t_${id}`, actorId, source, clusterId, observed);
}
function geoCube(db: SqliteDb, hour: string, cc: string, n: number, latB = 1) {
  db.prepare(`INSERT INTO threat_cube_geo (hour_bucket, lat_bucket, lng_bucket, country_code, threat_type, severity, source_feed, threat_count)
    VALUES (?, ?, 1, ?, 'phishing', 'high', 'feed_a', ?)`).run(hour, latB, cc, n);
}
function radar(db: SqliteDb, day: string, cc: string, pct: number) {
  db.prepare(`INSERT INTO radar_country_snapshots (snapshot_date, metric, country_code, value_pct) VALUES (?, 'attack_origin', ?, ?)`).run(day, cc, pct);
}

const only = (body: EventsEnvelope, kind: string) => body.data.filter((e) => e.kind === kind);

// ─── 1. Pure helpers ──────────────────────────────────────────────────

describe("copy helpers", () => {
  it("fitTitle keeps short titles, cuts long ones at a word boundary with an ellipsis, never mid-word", () => {
    expect(fitTitle("  Acme   Bank targeted ")).toBe("Acme Bank targeted");
    const long = `${"word ".repeat(30)}end`;
    const t = fitTitle(long);
    expect(t.length).toBeLessThanOrEqual(TITLE_MAX);
    expect(t.endsWith("…")).toBe(true);
    expect(t.slice(0, -1).split(" ").every((w) => w === "word")).toBe(true);
    // An optional tail clause is dropped whole, never cut mid-clause and never left as a bare separator.
    expect(fitTitle(`${"a".repeat(80)} · ${"b".repeat(20)}`)).toBe("a".repeat(80));
    const head = "Acme Bank targeted by 12 new credential-harvesting pages in the last few hours";
    expect(fitTitle(`${head} · mostly the Netherlands and Germany`)).toBe(head);
    expect(fitTitle(`${head.slice(0, 50)} has 9 new lookalikes registered, incl. a-very-long-lookalike-domain-name.example.com`))
      .toBe(head.slice(0, 50) + " has 9 new lookalikes registered");
    // A hard cut never ends on a connecting word or a half-written clause (`incl.…`, `· mostly…`, `and…`).
    for (const raw of [
      `${"word ".repeat(17)}incl. someverylonglookalike.example.com`,
      `${"word ".repeat(17)}and 3 new certificates`,
      `${"word ".repeat(16)}word mostly Netherlands`,
    ]) {
      const t = fitTitle(raw);
      expect(t.length).toBeLessThanOrEqual(TITLE_MAX);
      expect(t, raw).not.toMatch(/(incl\.|mostly|and|·|,)…?$/);
    }
    // One giant token is kept whole rather than cut.
    const giant = "x".repeat(120);
    expect(fitTitle(giant)).toBe(giant);
  });

  it("durationPhrase", () => {
    expect(durationPhrase(0.3)).toBe("within an hour");
    expect(durationPhrase(1)).toBe("1 hour");
    expect(durationPhrase(11.2)).toBe("11 hours");
    expect(durationPhrase(72)).toBe("3 days");
  });

  it("threatNoun names the dominant type; a mix or unknown type reads 'critical threats'", () => {
    expect(threatNoun(1, "phishing")).toBe("a new phishing page");
    expect(threatNoun(12, "phishing")).toBe("12 new phishing pages");
    expect(threatNoun(3, null)).toBe("3 new critical threats");
    expect(threatNoun(2, "something_new")).toBe("2 new critical threats");
  });

  it("countrySuffix spells the country out", () => {
    expect(countrySuffix(new Map([["NL", 5]]))).toBe(" · Netherlands");
    expect(countrySuffix(new Map([["NL", 9], ["DE", 3]]))).toBe(" · mostly Netherlands");
    expect(countrySuffix(new Map([["NL", 3], ["DE", 3], ["US", 3]]))).toBe(" · 3 countries");
    expect(countrySuffix(new Map())).toBe("");
  });

  it("operationLabel never exposes an id and prefixes 'Operation' once", () => {
    expect(operationLabel("AS4837 · malware distribution")).toBe("Operation AS4837 · malware distribution");
    expect(operationLabel("Operation Nightfall")).toBe("Operation Nightfall");
    expect(operationLabel(null)).toBe("An unnamed operation");
  });

  it("displayHost, toIsoUtc, dominantClusterCountry", () => {
    expect(displayHost("https://contoso-pay.net/login?x=1")).toBe("contoso-pay.net");
    expect(displayHost("contoso-pay.net")).toBe("contoso-pay.net");
    expect(displayHost("  ")).toBeNull();
    expect(toIsoUtc("2026-10-15 10:05:00")).toBe("2026-10-15T10:05:00.000Z");
    expect(toIsoUtc("2026-10-15")).toBe("2026-10-15T00:00:00.000Z");
    expect(toIsoUtc("nope")).toBeNull();
    expect(dominantClusterCountry('{"US": 3, "NL": 9}', null)).toBe("NL");
    expect(dominantClusterCountry("garbage", '["xx", "de"]')).toBe("DE");
    expect(dominantClusterCountry(null, null)).toBeNull();
  });

  it("eventsWindowStart is hour-snapped", () => {
    const now = new Date("2026-10-15T10:37:12Z");
    expect(eventsWindowStart("1h", now)).toBe("2026-10-15 09:00:00");
    expect(eventsWindowStart("24h", now)).toBe("2026-10-14 10:00:00");
    expect(eventsWindowStart("7d", now)).toBe("2026-10-08 10:00:00");
  });

  it("spike gate: ratio ≥ 3× AND volume floor", () => {
    const at = "2026-10-15T10:00:00.000Z";
    const ev = buildSpikeEvents([
      { country_code: "NL", our_count: 40, our_share: 0.4, radar_share: 0.1, ratio: 4 },
      { country_code: "DE", our_count: SPIKE_MIN_COUNT - 1, our_share: 0.3, radar_share: 0.05, ratio: 6 },
      { country_code: "US", our_count: 500, our_share: 0.2, radar_share: 0.1, ratio: 2 },
      { country_code: "BR", our_count: 80, our_share: 0.1, radar_share: null, ratio: null },
      { country_code: "RU", our_count: 90, our_share: 0.3, radar_share: 0.05, ratio: 6 },
    ], at);
    expect(ev.map((e) => e.id)).toEqual(["spike:NL", "spike:RU"]);
    expect(ev[0]).toMatchObject({
      kind: "spike", severity: "medium", title: "Netherlands at 4.0× its usual share of attack traffic",
      entity: { type: "country", id: "NL", name: "Netherlands" }, count: 1, occurred_at: at,
      target: { lens: "baseline", select: "country:NL" },
    });
    expect(ev[1]!.severity).toBe("high");
  });
});

// ─── 2. Params + cache key ────────────────────────────────────────────

describe("params", () => {
  const p = (q: string) => parseEventsParams(new URL(`https://averrow.com/api/observatory/events${q}`));

  it("defaults: period 1h, every kind, limit 40", () => {
    expect(p("")).toEqual({ ok: true, period: "1h", kinds: [...EVENT_KINDS], allKinds: true, limit: EVENTS_DEFAULT_LIMIT });
    expect(p("?period=&kinds=")).toMatchObject({ ok: true, period: "1h", allKinds: true });
  });

  it("period is allow-listed", () => {
    for (const good of ["1h", "24h", "7d"]) expect(p(`?period=${good}`)).toMatchObject({ ok: true, period: good });
    for (const bad of ["30d", "90d", "1H", "7d ", "all", "1h;DROP"]) expect(p(`?period=${encodeURIComponent(bad)}`)).toMatchObject({ ok: false });
  });

  it("kinds is allow-listed, canonicalised (order + duplicates) and never empty", () => {
    expect(p("?kinds=spike,critical,spike")).toMatchObject({ ok: true, kinds: ["critical", "spike"], allKinds: false });
    expect(p("?kinds= operation , fast")).toMatchObject({ ok: true, kinds: ["operation", "fast"] });
    expect(p(`?kinds=${EVENT_KINDS.slice().reverse().join(",")}`)).toMatchObject({ ok: true, allKinds: true });
    for (const bad of ["critical,nope", "CRITICAL", ",,", "critical;spike"]) expect(p(`?kinds=${encodeURIComponent(bad)}`)).toMatchObject({ ok: false });
  });

  it("limit is clamped to 1..100, garbage → default", () => {
    expect(p("?limit=0")).toMatchObject({ limit: 1 });
    expect(p("?limit=-5")).toMatchObject({ limit: 1 });
    expect(p("?limit=500")).toMatchObject({ limit: EVENTS_MAX_LIMIT });
    expect(p("?limit=abc")).toMatchObject({ limit: EVENTS_DEFAULT_LIMIT });
    expect(p("?limit=12.9")).toMatchObject({ limit: 12 });
  });

  it("cache key: period, canonical kinds and — only when a permission-gated kind is requested — the role class; never the limit", () => {
    const all = [...EVENT_KINDS];
    const td = permittedGatedKinds("analyst");
    const noTd = permittedGatedKinds("sales");
    expect(td).toEqual(["takedown"]);
    expect(noTd).toEqual([]);
    expect(permittedGatedKinds(undefined)).toEqual([]);
    expect(eventsCacheKey("1h", all, td)).toBe("observatory_events.1h:all:g-takedown");
    expect(eventsCacheKey("1h", all, noTd)).toBe("observatory_events.1h:all:g-none");
    expect(eventsCacheKey("7d", ["spike", "critical"], td)).toBe("observatory_events.7d:critical,spike:any");
    expect(eventsCacheKey("7d", ["critical", "spike"], noTd)).toBe("observatory_events.7d:critical,spike:any");
    expect(eventsCacheKey("24h", ["takedown"], noTd)).toBe("observatory_events.24h:takedown:g-none");
  });

  it("the role segment is derived from GATED_KINDS: every gated kind, and only those, shapes it", () => {
    for (const k of EVENT_KINDS) {
      const seg = eventsRoleSegment([k], []);
      expect(seg === "any", `${k} -> ${seg}`).toBe(!(k in GATED_KINDS));
    }
    // Same requested set + a different permitted set can never collide.
    expect(eventsRoleSegment([...EVENT_KINDS], [])).not.toBe(eventsRoleSegment([...EVENT_KINDS], Object.keys(GATED_KINDS) as EventKind[]));
    // A permitted kind that was not requested is irrelevant to the key.
    expect(eventsRoleSegment(["critical"], ["takedown"])).toBe("any");
  });

  it("freshness: 1h outlives the 600s Navigator warm interval; 24h 300s, 7d 900s", () => {
    expect(EVENTS_TTL_S).toEqual({ "1h": 600, "24h": 300, "7d": 900 });
    expect(EVENTS_TTL_S["1h"]).toBeGreaterThanOrEqual(600);
  });
});

describe.skipIf(!hasSqlite())("handler — params, 400s and caching", () => {
  it("an invalid period / kinds is a 400 that mints no KV key and runs no SQL", async () => {
    const { env, kv, log } = makeEnv(openMigratedDb());
    for (const q of ["?period=30d", "?kinds=critical,bogus", "?kinds=,"]) {
      const { res, body } = await call(env, `/api/observatory/events${q}`);
      expect(res.status).toBe(400);
      expect(body.success).toBe(false);
    }
    expect(eventKeys(kv)).toEqual([]);
    expect(log).toEqual([]);
  });

  it("caches under the canonical key with the configured TTL; a repeat is served from KV with no SQL", async () => {
    const { env, kv, log } = makeEnv(openMigratedDb());
    const first = await call(env, "/api/observatory/events?period=1h&limit=40");
    expect(first.res.status).toBe(200);
    expect(eventKeys(kv)).toEqual(["cv:observatory_events.1h:all:g-takedown"]);
    expect(kv.store.get("cv:observatory_events.1h:all:g-takedown")!.ttl).toBe(Math.max(EVENTS_TTL_S["1h"] * 2, 60));
    const n = log.length;
    expect(n).toBeGreaterThan(0);
    // Absent params and a reordered explicit full kinds list are the same key.
    await call(env, "/api/observatory/events");
    await call(env, `/api/observatory/events?kinds=${[...EVENT_KINDS].reverse().join(",")}&limit=40`);
    expect(log.length).toBe(n);
    expect(eventKeys(kv)).toEqual(["cv:observatory_events.1h:all:g-takedown"]);
  });

  it("one entry serves every limit: computed at the max, sliced per request, meta.limit echoes the request", async () => {
    const db = openMigratedDb();
    const rows = 7;
    for (let i = 0; i < rows; i++) {
      brand(db, `bl${i}`, `Brand ${i}`);
      lookalike(db, { id: `ld${i}`, brand: `bl${i}`, domain: `lookalike${i}.example`, firstSeen: ts(5 + i) });
    }
    const { env, kv, log } = makeEnv(db);
    const big = await call(env, "/api/observatory/events?kinds=lookalike&limit=100");
    expect(big.body.data.length).toBe(rows);
    const n = log.length;
    const small = await call(env, "/api/observatory/events?kinds=lookalike&limit=3");
    expect(log.length).toBe(n); // no SQL: the same entry
    expect(small.body.data.map((e) => e.id)).toEqual(big.body.data.slice(0, 3).map((e) => e.id));
    expect(small.body.meta.limit).toBe(3);
    expect(big.body.meta.limit).toBe(100);
    expect(eventKeys(kv)).toEqual(["cv:observatory_events.1h:lookalike:any"]);
    expect(small.body.counts_by_kind).toEqual(big.body.counts_by_kind); // counts stay pre-limit
  });

  it("a response with a failed source is cached for the short failed TTL, not the full one", async () => {
    const db = openMigratedDb();
    db.exec("DROP TABLE lookalike_domains");
    const { env, kv, log } = makeEnv(db);
    const first = await call(env, "/api/observatory/events?kinds=lookalike");
    expect(first.body.meta.failed_kinds).toEqual(["lookalike"]);
    const entry = kv.store.get("cv:observatory_events.1h:lookalike:any")!;
    expect(entry.ttl).toBe(Math.max(EVENTS_FAILED_TTL_S * 2, 60));
    // Fresh within the failed TTL ...
    const n = log.length;
    await call(env, "/api/observatory/events?kinds=lookalike");
    expect(log.length).toBe(n);
    // ... and treated as expired once that has passed (the entry is stamped as if written TTL - FAILED_TTL ago).
    const t = (JSON.parse(entry.value) as { t: number }).t;
    const ageS = (Date.now() - t) / 1000;
    expect(ageS).toBeGreaterThanOrEqual(EVENTS_TTL_S["1h"] - EVENTS_FAILED_TTL_S - 1);
    expect(ageS).toBeLessThan(EVENTS_TTL_S["1h"]);
  });

  it("empty platform → empty rail, zero counts for every requested kind, envelope meta", async () => {
    const { env } = makeEnv(openMigratedDb());
    const { body } = await call(env, "/api/observatory/events?period=24h&limit=10");
    expect(body.success).toBe(true);
    expect(body.data).toEqual([]);
    expect(body.counts_by_kind).toEqual(Object.fromEntries(EVENT_KINDS.map((k) => [k, 0])));
    expect(body.meta).toMatchObject({ period: "24h", limit: 10, kinds: [...EVENT_KINDS], omitted_kinds: [], capped_kinds: [], failed_kinds: [] });
    expect(body.meta.window_start).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/);
  });
});

// ─── 3. Sources on seeded rows ────────────────────────────────────────

describe.skipIf(!hasSqlite())("critical — capped read keeps the NEWEST groups", () => {
  it("CRITICAL_BRANDS_SQL orders latest-hour first before its LIMIT", () => {
    const db = openMigratedDb();
    for (const [i, h] of [[0, 30], [1, 2], [2, 10], [3, 0]] as const) {
      brand(db, `bo${i}`, `Brand ${i}`);
      brandCube(db, hourBucket(h), `bo${i}`, "phishing", "critical", 5 + i);
    }
    const rows = db.prepare(CRITICAL_BRANDS_SQL).all(eventsWindowStart("7d"), 3) as Array<{ brand_id: string }>;
    // bo0 is the oldest of four: the cap of 3 drops it, not a newer brand.
    expect(rows.map((r) => r.brand_id)).toEqual(["bo3", "bo1", "bo2"]);
  });
});

describe.skipIf(!hasSqlite())("critical", () => {
  let body: EventsEnvelope;
  beforeAll(async () => {
    const db = openMigratedDb();
    brand(db, "b_acme", "Acme Bank");
    brand(db, "b_cust", "Contoso", "customer");
    brand(db, "b_tracked", "Catalog Co", "tracked");
    // Acme: 12 critical phishing — 9 NL + 3 DE — over two hours.
    brandCube(db, hourBucket(1), "b_acme", "phishing", "critical", 5);
    brandCube(db, hourBucket(0), "b_acme", "phishing", "critical", 7, "feed_b");
    brandCube(db, hourBucket(0), "b_acme", "phishing", "high", 50); // not critical
    brandCube(db, hourBucket(5), "b_acme", "phishing", "critical", 99); // outside 1h
    arcsCube(db, hourBucket(1), "b_acme", "NL", "phishing", "critical", 5, 52.3, 4.9, ts(70));
    arcsCube(db, hourBucket(0), "b_acme", "NL", "phishing", "critical", 4, 52.1, 5.1, ts(4));
    arcsCube(db, hourBucket(0), "b_acme", "DE", "phishing", "critical", 3, 51.0, 10.0, ts(20));
    // Contoso (customer tier): one critical of mixed type, no geo.
    brandCube(db, hourBucket(0), "b_cust", "c2", "critical", 1);
    // A tracked brand is never a critical event.
    brandCube(db, hourBucket(0), "b_tracked", "phishing", "critical", 40);
    arcsCube(db, hourBucket(0), "b_tracked", "US", "phishing", "critical", 40, 40, -100, ts(1));
    body = (await call(makeEnv(db).env, "/api/observatory/events?kinds=critical")).body;
  });

  it("groups by monitored/customer brand, in-window critical only", () => {
    const ev = only(body, "critical");
    expect(ev.map((e) => e.id).sort()).toEqual(["critical:b_acme", "critical:b_cust"]);
    expect(body.counts_by_kind).toEqual({ critical: 13 });
  });

  it("title, entity, place (dominant country, weighted point), occurred_at (newest last_seen), target", () => {
    const acme = body.data.find((e) => e.id === "critical:b_acme")!;
    expect(acme).toMatchObject({
      kind: "critical", severity: "critical", count: 12, source: "sentinel",
      title: "Acme Bank targeted by 12 new phishing pages · mostly Netherlands",
      entity: { type: "brand", id: "b_acme", name: "Acme Bank" },
      target: { lens: "threats", select: "country:NL" },
      occurred_at: toIsoUtc(ts(4)),
    });
    expect(acme.place.country_code).toBe("NL");
    expect(acme.place.country_name).toBe("Netherlands");
    expect(acme.place.lat).toBeCloseTo((52.3 * 5 + 52.1 * 4) / 9, 5);
    expect(acme.place.lng).toBeCloseTo((4.9 * 5 + 5.1 * 4) / 9, 5);
  });

  it("a brand with no geolocated rows still lands, with no place and the hour bucket as its time", () => {
    const c = body.data.find((e) => e.id === "critical:b_cust")!;
    expect(c.title).toBe("Contoso targeted by a new command-and-control server");
    expect(c.place).toEqual({ country_code: null, country_name: null, lat: null, lng: null });
    expect(c.occurred_at).toBe(toIsoUtc(hourBucket(0)));
    expect(c.target).toEqual({ lens: "threats" });
  });
});

describe.skipIf(!hasSqlite())("operation", () => {
  let body: EventsEnvelope;
  beforeAll(async () => {
    const db = openMigratedDb();
    cluster(db, { id: "cluster_asn_as4837_malware", name: "AS4837 · malware distribution", countryCounts: '{"CN": 30, "HK": 2}' });
    cluster(db, { id: "cluster_ip_1", name: "Nightfall", countries: '["RU"]' });
    cluster(db, { id: "cluster_retired", name: "Legacy copy", retired: "superseded", countryCounts: '{"US": 9}' });
    // Two infra_movement bursts on one cluster → one grouped item.
    pivot(db, "ev_a", ts(50), { kind: "infra_movement", payload_v: 2, cluster_id: "cluster_asn_as4837_malware", new_ips: 4, new_asns: 0, new_serials: 0 });
    pivot(db, "ev_b", ts(10), { kind: "infra_movement", payload_v: 2, cluster_id: "cluster_asn_as4837_malware", new_ips: 2, new_asns: 1, new_serials: 0 });
    pivot(db, "ev_c", ts(30), { kind: "dormancy", payload_v: 2, cluster_id: "cluster_ip_1", asn: "AS9009" });
    pivot(db, "ev_ret", ts(5), { kind: "infra_movement", payload_v: 2, cluster_id: "cluster_retired", new_ips: 50 });
    pivot(db, "ev_gone", ts(5), { kind: "infra_movement", payload_v: 2, cluster_id: "cluster_missing", new_ips: 50 });
    pivot(db, "ev_old", ts(300), { kind: "infra_movement", payload_v: 2, cluster_id: "cluster_ip_1", new_ips: 9 });
    body = (await call(makeEnv(db).env, "/api/observatory/events?kinds=operation")).body;
  });

  it("groups a cluster's bursts, summing what moved; names the operation, never its id", () => {
    const mv = body.data.find((e) => e.id === "operation:cluster_asn_as4837_malware:infra_movement")!;
    expect(mv).toMatchObject({
      kind: "operation", severity: "high", count: 2, source: "nexus",
      title: "Operation AS4837 · malware distribution moved to 6 new IPs and 1 new network",
      entity: { type: "operation", id: "cluster_asn_as4837_malware", name: "AS4837 · malware distribution" },
      occurred_at: toIsoUtc(ts(10)),
      target: { lens: "movement", select: "move:ev_b" },
    });
    expect(mv.place).toMatchObject({ country_code: "CN", country_name: "China" });
    expect(mv.title).not.toContain("cluster_");
  });

  it("dormancy reads as going quiet", () => {
    const d = body.data.find((e) => e.id === "operation:cluster_ip_1:dormancy")!;
    expect(d).toMatchObject({ severity: "medium", count: 1, title: "Operation Nightfall went quiet · activity down over 80%" });
    expect(d.place.country_code).toBe("RU");
  });

  it("retired, missing and out-of-window clusters never surface", () => {
    expect(body.data.map((e) => e.id).sort()).toEqual([
      "operation:cluster_asn_as4837_malware:infra_movement",
      "operation:cluster_ip_1:dormancy",
    ]);
    expect(JSON.stringify(body)).not.toContain("Legacy copy");
    expect(body.counts_by_kind).toEqual({ operation: 3 });
  });
});

describe.skipIf(!hasSqlite())("fast", () => {
  let body: EventsEnvelope;
  beforeAll(async () => {
    const db = openMigratedDb();
    brand(db, "b_north", "Northwind");
    brand(db, "b_acme", "Acme Bank");
    threat(db, { id: "t1", domain: "northwind-login.co", brand: "b_north", cc: "US", lat: 37.7, lng: -122.4, flag: "very_fast", hours: 3, created: ts(15) });
    threat(db, { id: "t2", domain: "acme-verify.top", brand: "b_acme", cc: "NL", flag: "very_fast", hours: 5, created: ts(40) });
    threat(db, { id: "t3", domain: "acme-secure.top", brand: "b_acme", cc: "NL", flag: "very_fast", hours: 0, created: ts(20) });
    threat(db, { id: "t4", domain: "fast-not-very.com", flag: "fast", hours: 30, created: ts(10) });
    threat(db, { id: "t5", domain: "inactive.com", flag: "very_fast", hours: 1, created: ts(10), status: "down" });
    threat(db, { id: "t6", domain: "old.com", flag: "very_fast", hours: 1, created: ts(400) });
    threat(db, { id: "t7", domain: "unbranded.io", flag: "very_fast", hours: 0, created: ts(5) });
    body = (await call(makeEnv(db).env, "/api/observatory/events?kinds=fast")).body;
  });

  it("only active, very_fast, in-window threats; a brand burst is grouped", () => {
    expect(body.data.map((e) => e.id).sort()).toEqual(["fast:brand:b_acme", "fast:t1", "fast:t7"]);
    expect(body.counts_by_kind).toEqual({ fast: 4 });
  });

  it("single: domain first, hours after registration, the threat's own point", () => {
    expect(body.data.find((e) => e.id === "fast:t1")).toMatchObject({
      severity: "high", count: 1, title: "northwind-login.co went live 3 hours after registration",
      entity: { type: "domain", id: "t1", name: "northwind-login.co" },
      place: { country_code: "US", country_name: "United States", lat: 37.7, lng: -122.4 },
      target: { lens: "threats", select: "country:US" },
    });
    expect(body.data.find((e) => e.id === "fast:t7")!.title).toBe("unbranded.io went live within an hour of registration");
  });

  it("burst: who is affected first", () => {
    expect(body.data.find((e) => e.id === "fast:brand:b_acme")).toMatchObject({
      count: 2, title: "Acme Bank targeted by 2 domains that went live within 5 hours of registration",
      entity: { type: "brand", id: "b_acme", name: "Acme Bank" }, occurred_at: toIsoUtc(ts(20)),
      place: { country_code: "NL" },
    });
  });
});

describe.skipIf(!hasSqlite())("lookalike", () => {
  let body: EventsEnvelope;
  beforeAll(async () => {
    const db = openMigratedDb();
    brand(db, "b_fab", "Fabrikam");
    brand(db, "b_woo", "Woodgrove");
    lookalike(db, { id: "l1", brand: "b_fab", domain: "fabrikarn.com", firstSeen: ts(25), level: "high" });
    lookalike(db, { id: "l2", brand: "b_woo", domain: "woodgr0ve.com", firstSeen: ts(30), evidence: "nrd" });
    lookalike(db, { id: "l3", brand: "b_woo", domain: "wood-grove.net", firstSeen: ts(12) });
    lookalike(db, { id: "l4", brand: "b_fab", domain: "benign-fab.com", firstSeen: ts(5), status: "benign" });
    lookalike(db, { id: "l5", brand: "b_fab", domain: "baseline-only.com", firstSeen: ts(5), evidence: null });
    lookalike(db, { id: "l6", brand: "b_fab", domain: "old-fab.com", firstSeen: ts(500) });
    lookalike(db, { id: "l7", brand: "b_fab", domain: "never-seen.com", firstSeen: null });
    body = (await call(makeEnv(db).env, "/api/observatory/events?kinds=lookalike")).body;
  });

  it("confirmed registrations in the window only; benign / unevidenced / old excluded", () => {
    expect(body.data.map((e) => e.id).sort()).toEqual(["lookalike:brand:b_woo", "lookalike:l1"]);
    expect(body.counts_by_kind).toEqual({ lookalike: 3 });
  });

  it("titles lead with the brand", () => {
    expect(body.data.find((e) => e.id === "lookalike:l1")).toMatchObject({
      severity: "high", title: "Fabrikam has a new lookalike registered: fabrikarn.com",
      entity: { type: "domain", id: "l1", name: "fabrikarn.com" }, source: "lookalike_scanner",
      place: { country_code: null }, target: { lens: "threats" },
    });
    expect(body.data.find((e) => e.id === "lookalike:brand:b_woo")).toMatchObject({
      count: 2, severity: "medium", title: "Woodgrove has 2 new lookalikes registered, incl. wood-grove.net",
      occurred_at: toIsoUtc(ts(12)),
    });
  });
});

describe.skipIf(!hasSqlite())("takedown + role gating", () => {
  let db: SqliteDb;
  beforeAll(() => {
    db = openMigratedDb();
    brand(db, "b_con", "Contoso");
    brand(db, "b_tail", "Tailspin");
    threat(db, { id: "t_src", domain: "contoso-pay.net", brand: "b_con", cc: "DE", lat: 50.1, lng: 8.6, created: ts(2000), provider: "hp_9" });
    takedown(db, { id: "td1", brand: "b_con", target: "https://contoso-pay.net/login", submitted: ts(11 * 60 + 20), resolved: ts(20), sourceType: "threat", sourceId: "t_src" });
    takedown(db, { id: "td2", brand: "b_tail", target: "tailspin-a.com", submitted: ts(600), resolved: ts(40) });
    takedown(db, { id: "td3", brand: "b_tail", target: "tailspin-b.com", submitted: ts(200), resolved: ts(30) });
    takedown(db, { id: "td4", brand: "b_tail", target: "pending.com", status: "submitted", submitted: ts(100), resolved: null });
    takedown(db, { id: "td5", brand: "b_tail", target: "old.com", submitted: ts(5000), resolved: ts(4000) });
    takedown(db, { id: "td6", brand: "b_tail", target: "refused.com", status: "failed", submitted: ts(100), resolved: ts(10) });
  });

  it("taken_down in the window, submit → takedown hours, the source threat's place and provider", async () => {
    const { body } = await call(makeEnv(db).env, "/api/observatory/events?kinds=takedown", "analyst");
    expect(body.data.map((e) => e.id).sort()).toEqual(["takedown:brand:b_tail", "takedown:td1"]);
    expect(body.data.find((e) => e.id === "takedown:td1")).toMatchObject({
      severity: "info", count: 1, source: "sparrow",
      title: "contoso-pay.net taken down after 11 hours",
      entity: { type: "domain", id: "td1", name: "contoso-pay.net" },
      place: { country_code: "DE", lat: 50.1, lng: 8.6 },
      target: { lens: "hosting", select: "provider:hp_9" },
    });
    expect(body.data.find((e) => e.id === "takedown:brand:b_tail")).toMatchObject({
      count: 2, title: "Tailspin had 2 takedowns completed · median 6 hours", target: { lens: "hosting" },
    });
    expect(body.counts_by_kind).toEqual({ takedown: 3 });
    expect(body.meta.omitted_kinds).toEqual([]);
  });

  for (const role of ["analyst", "admin", "super_admin"] as UserRole[]) {
    it(`'${role}' (manage_takedowns) sees takedowns under the td key`, async () => {
      const { env, kv } = makeEnv(db);
      const { body } = await call(env, "/api/observatory/events", role);
      expect(only(body, "takedown").length).toBe(2);
      expect(body.counts_by_kind.takedown).toBe(3);
      expect(eventKeys(kv)).toEqual(["cv:observatory_events.1h:all:g-takedown"]);
    });
  }

  for (const role of ["sales", "support", "billing", "auditor"] as UserRole[]) {
    it(`'${role}' (no manage_takedowns) never sees takedowns and never reads takedown_requests`, async () => {
      const { env, kv, log } = makeEnv(db);
      const { res, body } = await call(env, "/api/observatory/events", role);
      expect(res.status).toBe(200);
      expect(only(body, "takedown")).toEqual([]);
      expect(body.counts_by_kind).not.toHaveProperty("takedown");
      expect(body.meta.omitted_kinds).toEqual(["takedown"]);
      expect(body.meta.kinds).not.toContain("takedown");
      expect(JSON.stringify(body)).not.toContain("contoso-pay.net");
      expect(log.some((e) => /takedown_requests/.test(e.sql))).toBe(false);
      expect(eventKeys(kv)).toEqual(["cv:observatory_events.1h:all:g-none"]);
      // Explicitly asking for takedowns doesn't help.
      const solo = await call(env, "/api/observatory/events?kinds=takedown", role);
      expect(solo.body.data).toEqual([]);
      expect(solo.body.counts_by_kind).toEqual({});
    });
  }

  it("no auth context at all fails closed (no takedowns)", async () => {
    const { env, log } = makeEnv(db);
    const res = await handleObservatoryEvents(req("/api/observatory/events?kinds=takedown"), env);
    const body = (await res.json()) as EventsEnvelope;
    expect(body.meta.omitted_kinds).toEqual(["takedown"]);
    expect(log.some((e) => /takedown_requests/.test(e.sql))).toBe(false);
  });

  it("the role classes never share a key; requests without takedown share one", async () => {
    const { env, kv } = makeEnv(db);
    await call(env, "/api/observatory/events", "analyst");
    await call(env, "/api/observatory/events", "auditor");
    await call(env, "/api/observatory/events?kinds=critical,spike", "analyst");
    await call(env, "/api/observatory/events?kinds=critical,spike", "auditor");
    expect(eventKeys(kv).sort()).toEqual([
      "cv:observatory_events.1h:all:g-none",
      "cv:observatory_events.1h:all:g-takedown",
      "cv:observatory_events.1h:critical,spike:any",
    ]);
  });
});

describe.skipIf(!hasSqlite())("actor", () => {
  let body: EventsEnvelope;
  beforeAll(async () => {
    const db = openMigratedDb();
    actor(db, "ta_4903", "TA4903");
    actor(db, "ta_other", "FIN7");
    cluster(db, { id: "cluster_cert_a", name: "Invoice kit", actor: "ta_4903", countryCounts: '{"US": 4}' });
    cluster(db, { id: "cluster_cert_old", name: "Old link", actor: "ta_4903" });
    cluster(db, { id: "cluster_cert_ret", name: "Retired link", actor: "ta_4903", retired: "shared_infra" });
    cluster(db, { id: "cluster_cert_moved", name: "Moved link", actor: "ta_other" });
    // First link in the window (inherited, several members).
    attribution(db, "a1", "cluster_cert_a", "ta_4903", "nexus", ts(20));
    attribution(db, "a2", "cluster_cert_a", "ta_4903", "nexus", ts(15));
    // Linked long ago; new members today are NOT a new link.
    attribution(db, "a3", "cluster_cert_old", "ta_4903", "manual", ts(3000));
    attribution(db, "a4", "cluster_cert_old", "ta_4903", "manual", ts(10));
    // Retired cluster.
    attribution(db, "a5", "cluster_cert_ret", "ta_4903", "nexus", ts(10));
    // Cluster now carries another actor (re-attributed / dismissed).
    attribution(db, "a6", "cluster_cert_moved", "ta_4903", "manual", ts(10));
    // OTX per-threat rows are never cluster links.
    attribution(db, "a7", "pulse_123", "ta_4903", "otx", ts(10));
    body = (await call(makeEnv(db).env, "/api/observatory/events?kinds=actor")).body;
  });

  it("only first links of live clusters that still carry the actor", () => {
    expect(body.data.map((e) => e.id)).toEqual(["actor:cluster_cert_a:ta_4903"]);
    expect(body.counts_by_kind).toEqual({ actor: 1 });
  });

  it("copy + entity + target", () => {
    expect(body.data[0]).toMatchObject({
      kind: "actor", severity: "high", count: 1, source: "attributor",
      title: "Operation Invoice kit linked to TA4903",
      entity: { type: "actor", id: "ta_4903", name: "TA4903" },
      place: { country_code: "US" },
      occurred_at: toIsoUtc(ts(20)), // the FIRST link, not the newest member row
      target: { lens: "actors", select: "actor:ta_4903" },
    });
  });
});

describe.skipIf(!hasSqlite())("spike", () => {
  it("1h / 24h: geo cube over the window vs the latest Radar snapshot; ratio and volume gates", async () => {
    const db = openMigratedDb();
    // Ours (window): NL 60, US 30, DE 10 → shares .6 / .3 / .1.
    geoCube(db, hourBucket(0), "NL", 60);
    geoCube(db, hourBucket(0), "US", 30);
    geoCube(db, hourBucket(1), "DE", 10);
    geoCube(db, hourBucket(9), "NL", 5000); // outside 1h
    // Radar: NL 10% → 6×; US 20% → 1.5×; DE 2% → 5× but below the volume floor.
    radar(db, "2026-10-01", "NL", 50); // stale snapshot — ignored
    radar(db, "2026-10-14", "NL", 10);
    radar(db, "2026-10-14", "US", 20);
    radar(db, "2026-10-14", "DE", 2);
    const { body } = await call(makeEnv(db).env, "/api/observatory/events?kinds=spike");
    expect(body.data.map((e) => e.id)).toEqual(["spike:NL"]);
    expect(body.data[0]).toMatchObject({ title: "Netherlands at 6.0× its usual share of attack traffic", severity: "high", count: 1 }); // events, not the country's threat volume
    expect(body.counts_by_kind).toEqual({ spike: 1 });
  });

  it("7d reuses the /overindex lens (its own cache key), not a second geo-cube read", async () => {
    const db = openMigratedDb();
    geoCube(db, hourBucket(30), "NL", 60);
    geoCube(db, hourBucket(30), "US", 40);
    radar(db, "2026-10-14", "NL", 10);
    const { env, kv } = makeEnv(db);
    const { body } = await call(env, "/api/observatory/events?period=7d&kinds=spike");
    expect(body.data.map((e) => e.id)).toEqual(["spike:NL"]);
    expect([...kv.store.keys()]).toContain("cv:observatory_lens.overindex:7d");
  });
});

// ─── 4. Mixed rail: ordering, limit, counts, isolation ────────────────

describe.skipIf(!hasSqlite())("mixed rail", () => {
  function seedMixed(): SqliteDb {
    const db = openMigratedDb();
    brand(db, "b_acme", "Acme Bank");
    brandCube(db, hourBucket(0), "b_acme", "phishing", "critical", 3);
    arcsCube(db, hourBucket(0), "b_acme", "NL", "phishing", "critical", 3, 52, 5, ts(30));
    cluster(db, { id: "cluster_ip_9", name: "Nightfall" });
    pivot(db, "ev_1", ts(5), { kind: "infra_movement", payload_v: 2, cluster_id: "cluster_ip_9", new_ips: 1 });
    threat(db, { id: "t1", domain: "a.com", flag: "very_fast", hours: 2, created: ts(50) });
    threat(db, { id: "t2", domain: "b.com", flag: "very_fast", hours: 2, created: ts(45) });
    lookalike(db, { id: "l1", brand: "b_acme", domain: "acrne.com", firstSeen: ts(1) });
    return db;
  }

  it("newest first across kinds; limit cuts the list, counts stay pre-limit", async () => {
    const { body } = await call(makeEnv(seedMixed()).env, "/api/observatory/events?limit=3");
    expect(body.data.map((e) => e.id)).toEqual(["lookalike:l1", "operation:cluster_ip_9:infra_movement", "critical:b_acme"]);
    expect(body.counts_by_kind).toMatchObject({ critical: 3, operation: 1, fast: 2, lookalike: 1, takedown: 0, actor: 0, spike: 0 });
    const times = body.data.map((e) => e.occurred_at);
    expect([...times].sort().reverse()).toEqual(times);
  });

  it("every item satisfies the contract", async () => {
    const { body } = await call(makeEnv(seedMixed()).env, "/api/observatory/events?limit=100");
    const ids = new Set<string>();
    for (const e of body.data as ObservatoryEvent[]) {
      expect(EVENT_KINDS).toContain(e.kind);
      expect(["critical", "high", "medium", "low", "info"]).toContain(e.severity);
      expect(e.title.length).toBeLessThanOrEqual(TITLE_MAX);
      expect(e.title).not.toMatch(/cluster_|ev_\d|\bta_\w/);
      expect(e.id.startsWith(`${e.kind}:`)).toBe(true);
      expect(ids.has(e.id)).toBe(false);
      ids.add(e.id);
      expect(Number.isNaN(Date.parse(e.occurred_at))).toBe(false);
      expect(e.count).toBeGreaterThanOrEqual(1);
      expect(typeof e.target.lens).toBe("string");
    }
  });

  it("a failing source is isolated: its kind is reported, the rest still render", async () => {
    const db = seedMixed();
    db.exec("DROP TABLE lookalike_domains");
    const { res, body } = await call(makeEnv(db).env, "/api/observatory/events");
    expect(res.status).toBe(200);
    expect(body.meta.failed_kinds).toEqual(["lookalike"]);
    expect(body.counts_by_kind).not.toHaveProperty("lookalike");
    expect(only(body, "critical").length).toBe(1);
  });
});

// ─── 5. Query plans at scale ──────────────────────────────────────────

const SCALE = { threats: 30_000, brands: 3_000, cubeHours: 24 * 10, takedowns: 6_000, lookalikes: 20_000, attributions: 40_000, events: 20_000, clusters: 5_000 };

function prng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
}

function seedAtScale(db: SqliteDb): void {
  const rnd = prng(7);
  const sev = ["critical", "high", "medium", "low"];
  db.exec("BEGIN");
  let s = db.prepare("INSERT INTO brands (id, name, canonical_domain, tier) VALUES (?, ?, ?, ?)");
  for (let i = 0; i < SCALE.brands; i++) s.run(`b_${i}`, `Brand ${i}`, `brand${i}.example`, i % 10 === 0 ? "monitored" : "tracked");
  s = db.prepare(`INSERT OR IGNORE INTO threat_cube_brand (hour_bucket, target_brand_id, threat_type, severity, source_feed, threat_count) VALUES (?, ?, 'phishing', ?, ?, 2)`);
  const a = db.prepare(`INSERT OR IGNORE INTO threat_cube_arcs (hour_bucket, country_code, target_brand_id, threat_type, severity, source_feed, threat_count, source_lat, source_lng, first_seen, last_seen)
    VALUES (?, ?, ?, 'phishing', ?, 'feed_a', 2, 1, 1, ?, ?)`);
  const g = db.prepare(`INSERT OR IGNORE INTO threat_cube_geo (hour_bucket, lat_bucket, lng_bucket, country_code, threat_type, severity, source_feed, threat_count) VALUES (?, ?, 1, ?, 'phishing', ?, 'feed_a', 2)`);
  for (let h = 0; h < SCALE.cubeHours; h++) {
    const hb = hourBucket(h);
    for (let k = 0; k < 40; k++) {
      const b = `b_${Math.floor(rnd() * SCALE.brands)}`;
      s.run(hb, b, sev[k % 4]!, `feed_${k % 3}`);
      a.run(hb, ["US", "NL", "DE", "RU"][k % 4]!, b, sev[k % 4]!, hb, hb);
      g.run(hb, k, ["US", "NL", "DE", "RU", "CN"][k % 5]!, sev[k % 4]!);
    }
  }
  s = db.prepare(`INSERT INTO threats (id, source_feed, threat_type, malicious_domain, target_brand_id, country_code, weaponization_flag, weaponization_hours, created_at, first_seen, last_seen, status, severity)
    VALUES (?, 'feed_a', 'phishing', ?, ?, 'US', ?, 3, ?, ?, ?, ?, 'high')`);
  for (let i = 0; i < SCALE.threats; i++) {
    const at = ts(rnd() * 60 * 24 * 60);
    const f = rnd();
    s.run(`t_${i}`, `d${i}.com`, `b_${i % SCALE.brands}`, f < 0.05 ? "very_fast" : f < 0.1 ? "fast" : f < 0.6 ? "normal" : null, at, at, at, rnd() < 0.8 ? "active" : "down");
  }
  s = db.prepare(`INSERT INTO takedown_requests (id, brand_id, target_type, target_value, evidence_summary, status, submitted_at, resolved_at, source_type, source_id, created_at)
    VALUES (?, ?, 'domain', ?, 'e', ?, ?, ?, 'threat', ?, ?)`);
  for (let i = 0; i < SCALE.takedowns; i++) {
    const done = rnd() < 0.6;
    const at = ts(rnd() * 60 * 24 * 120);
    s.run(`td_${i}`, `b_${i % SCALE.brands}`, `x${i}.com`, done ? "taken_down" : ["draft", "submitted", "failed"][i % 3]!, at, done ? at : null, `t_${i}`, at);
  }
  s = db.prepare(`INSERT INTO lookalike_domains (id, brand_id, domain, permutation_type, first_seen, registration_evidence, status, registered) VALUES (?, ?, ?, 'p', ?, ?, ?, 1)`);
  for (let i = 0; i < SCALE.lookalikes; i++) {
    s.run(`l_${i}`, `b_${i % SCALE.brands}`, `l${i}.com`, rnd() < 0.3 ? ts(rnd() * 60 * 24 * 90) : null, rnd() < 0.2 ? "nrd" : rnd() < 0.3 ? "observed" : null, rnd() < 0.1 ? "benign" : "monitoring");
  }
  s = db.prepare(`INSERT INTO infrastructure_clusters (id, cluster_name, status, retired_reason, actor_id, threat_count) VALUES (?, ?, 'active', ?, ?, 5)`);
  for (let i = 0; i < SCALE.clusters; i++) s.run(`cluster_ip_${i}`, `op ${i}`, i % 9 === 0 ? "superseded" : null, i % 4 === 0 ? `ta_${i % 50}` : null);
  s = db.prepare("INSERT INTO threat_actors (id, name, status) VALUES (?, ?, 'active')");
  for (let i = 0; i < 50; i++) s.run(`ta_${i}`, `Actor ${i}`);
  s = db.prepare(`INSERT INTO threat_attributions (id, threat_id, actor_id, source, source_pulse_id, confidence, observed_at) VALUES (?, ?, ?, ?, ?, 'low', ?)`);
  for (let i = 0; i < SCALE.attributions; i++) {
    const src = ["otx", "otx", "otx", "nexus", "manual"][i % 5]!;
    s.run(`ta_row_${i}`, `t_${i}`, `ta_${i % 50}`, src, src === "otx" ? `pulse_${i % 300}` : `cluster_ip_${i % SCALE.clusters}`, ts(rnd() * 60 * 24 * 90));
  }
  s = db.prepare(`INSERT INTO agent_events (id, event_type, source_agent, payload_json, created_at, status) VALUES (?, ?, 'nexus', ?, ?, 'done')`);
  for (let i = 0; i < SCALE.events; i++) {
    const p = rnd() < 0.05;
    s.run(`ev_${i}`, p ? "pivot_detected" : "feed_pulled", p ? JSON.stringify({ kind: "infra_movement", payload_v: 2, cluster_id: `cluster_ip_${i % SCALE.clusters}`, new_ips: 2 }) : "{}", ts(rnd() * 60 * 24 * 120));
  }
  s = db.prepare(`INSERT INTO radar_country_snapshots (snapshot_date, metric, country_code, value_pct) VALUES (?, ?, ?, 5)`);
  for (let d = 0; d < 30; d++) for (const m of ["attack_origin", "attack_target", "bot_density"]) for (const cc of ["US", "NL", "DE", "RU"]) s.run(hourBucket(d * 24).slice(0, 10), m, cc);
  db.exec("COMMIT");
}

interface Planned { sql: string; plan: string }

async function planAll(db: SqliteDb): Promise<Planned[]> {
  const { env, log } = makeEnv(db);
  for (const period of ["1h", "24h", "7d"]) {
    const { res, body } = await call(env, `/api/observatory/events?period=${period}&limit=100`, "super_admin");
    expect(res.status).toBe(200);
    expect(body.meta.failed_kinds).toEqual([]);
  }
  return log
    .filter((e) => e.error === undefined && /^\s*SELECT/i.test(e.sql))
    .map((e) => ({
      sql: e.sql.replace(/\s+/g, " "),
      plan: (db.prepare(`EXPLAIN QUERY PLAN ${e.sql}`).all(...(e.binds ?? [])) as Array<{ detail: string }>).map((r) => r.detail).join(" | "),
    }));
}

const find = (planned: Planned[], marker: RegExp): Planned[] => {
  const hits = planned.filter((p) => marker.test(p.sql));
  expect(hits.length, `no statement matched ${marker}`).toBeGreaterThan(0);
  return hits;
};

describe.skipIf(!hasSqlite())("event reads — plans on the fully migrated schema at scale", () => {
  let db: SqliteDb;
  const modes: Record<string, Planned[]> = {};

  beforeAll(async () => {
    db = openMigratedDb();
    seedAtScale(db);
    modes["no stats"] = await planAll(db);
    db.exec("ANALYZE");
    modes["ANALYZE"] = await planAll(db);
  }, 120_000);

  for (const mode of ["no stats", "ANALYZE"]) {
    describe(mode, () => {
      it("critical: brand cube hour range + brands PK; arcs by (brand, hour)", () => {
        // Either join order is bounded: the window's cube hour range + brands
        // PK, or the monitored/customer brands (idx_brands_tier) + each one's
        // (brand, hour) cube range. Never a cube or brands scan.
        for (const p of find(modes[mode]!, /FROM threat_cube_brand c JOIN brands b/)) {
          const hourFirst = /SEARCH c USING INDEX (idx_cube_brand_hour|sqlite_autoindex_threat_cube_brand_1) \(hour_bucket>\?\)/.test(p.plan)
            && /SEARCH b USING INDEX sqlite_autoindex_brands_1 \(id=\?\)/.test(p.plan);
          const brandFirst = p.plan.includes("SEARCH b USING INDEX idx_brands_tier (tier=?)")
            && p.plan.includes("SEARCH c USING INDEX idx_cube_brand_id_hour (target_brand_id=? AND hour_bucket>?)");
          expect(hourFirst || brandFirst, p.plan).toBe(true);
        }
        for (const p of find(modes[mode]!, /FROM threat_cube_arcs WHERE target_brand_id IN/)) {
          expect(p.plan).toContain("idx_cube_arcs_brand_hour (target_brand_id=? AND hour_bucket>?)");
        }
      });

      it("operation: (event_type, created_at) range in order; clusters by PK", () => {
        for (const p of find(modes[mode]!, /FROM agent_events WHERE event_type = 'pivot_detected'/)) {
          expect(p.plan).toContain("idx_agent_events_type_created (event_type=? AND created_at>?)");
          expect(p.plan).not.toContain("TEMP B-TREE");
        }
        for (const p of find(modes[mode]!, /FROM infrastructure_clusters c LEFT JOIN threat_actors a/)) {
          expect(p.plan).toMatch(/SEARCH c USING INDEX sqlite_autoindex_infrastructure_clusters_1 \(id=\?\)/);
        }
      });

      it("fast: the velocity partial index, (status, created_at) range, no sort", () => {
        for (const p of find(modes[mode]!, /FROM threats INDEXED BY idx_threats_velocity_fast_created WHERE created_at >= \? AND status = 'active' AND weaponization_flag IN/)) {
          expect(p.plan).toContain("SEARCH threats USING INDEX idx_threats_velocity_fast_created (status=? AND created_at>?)");
          expect(p.plan).not.toContain("TEMP B-TREE");
        }
      });

      it("lookalike: idx_lookalike_first_seen range in order", () => {
        for (const p of find(modes[mode]!, /FROM lookalike_domains ld LEFT JOIN brands b/)) {
          expect(p.plan).toContain("SEARCH ld USING INDEX idx_lookalike_first_seen (first_seen>?)");
          expect(p.plan).not.toContain("TEMP B-TREE");
        }
      });

      it("takedown: the 0307 partial (resolved_at) index, in order; source threats by PK", () => {
        for (const p of find(modes[mode]!, /FROM takedown_requests tr INDEXED BY idx_takedown_taken_down_resolved LEFT JOIN brands b/)) {
          expect(p.plan).toContain("SEARCH tr USING INDEX idx_takedown_taken_down_resolved (resolved_at>?)");
          expect(p.plan).not.toContain("TEMP B-TREE");
        }
        for (const p of find(modes[mode]!, /FROM threats WHERE id IN/)) {
          expect(p.plan).toMatch(/SEARCH threats USING INDEX sqlite_autoindex_threats_1 \(id=\?\)/);
        }
      });

      it("actor: (source, observed_at) range; the first-link probe is keyed on the cluster", () => {
        for (const p of find(modes[mode]!, /FROM threat_attributions ta WHERE ta.source IN/)) {
          expect(p.plan).toContain("idx_attribution_source (source=? AND observed_at>?)");
          expect(p.plan).toMatch(/SEARCH o USING INDEX idx_attribution_pulse \(source_pulse_id=\?\)/);
        }
      });

      it("spike: geo cube hour range; Radar by (metric, date)", () => {
        for (const p of find(modes[mode]!, /FROM threat_cube_geo WHERE hour_bucket >= \? AND country_code != 'XX'/)) {
          expect(p.plan).toContain("SEARCH threat_cube_geo USING INDEX idx_cube_geo_hour (hour_bucket>?)");
        }
        for (const p of find(modes[mode]!, /FROM radar_country_snapshots WHERE metric = 'attack_origin'/)) {
          expect(p.plan).toContain("idx_radar_country_snapshots_metric_date (metric=? AND snapshot_date=?)");
        }
      });

      it("no read full-scans a table", () => {
        for (const p of modes[mode]!) {
          for (const step of p.plan.split(" | ")) expect(step, p.sql).not.toMatch(/^SCAN /);
        }
      });

      it("no read touches agent_activity_log / agent_runs (no platform-health telemetry)", () => {
        for (const p of modes[mode]!) expect(p.sql).not.toMatch(/agent_activity_log|agent_runs/);
      });
    });
  }
});
