import { describe, it, expect } from "vitest";
import {
  canonicalActorName,
  extractActorFromPulse,
  originCountryFor,
  actorIdFor,
  upsertActorFromPulse,
  upsertActorByName,
} from "../src/lib/otx-attribution";

// Minimal D1 stub that records the SQL + binds of each statement.
function recordingDb() {
  const calls: Array<{ sql: string; binds: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          calls.push({ sql, binds });
          return { run: async () => ({ success: true }) };
        },
      };
    },
  } as unknown as D1Database;
  return { db, calls };
}

describe("canonicalActorName — Star Blizzard aliases", () => {
  it.each([
    "Star Blizzard", "COLDRIVER", "SEABORGIUM", "Callisto", "Callisto Group",
    "UNC4057", "TAG-53", "Blue Charlie", "Gossamer Bear",
  ])("%s → Star Blizzard", (alias) => {
    expect(canonicalActorName(alias)).toBe("Star Blizzard");
  });

  it("keeps the existing ta_star_blizzard id stable", () => {
    expect(actorIdFor("Star Blizzard")).toBe("ta_star_blizzard");
  });

  it("resolves a pulse tagged only by alias", () => {
    expect(extractActorFromPulse({ id: "p", name: "x", tags: ["phishing", "coldriver"] }))
      .toBe("Star Blizzard");
  });
});

describe("originCountryFor", () => {
  it("returns ISO-2 origin for state actors", () => {
    expect(originCountryFor("Star Blizzard")).toBe("RU");
    expect(originCountryFor("APT28")).toBe("RU");
    expect(originCountryFor("Lazarus Group")).toBe("KP");
    expect(originCountryFor("APT41")).toBe("CN");
    expect(originCountryFor("MuddyWater")).toBe("IR");
  });

  it("returns null for criminal groups and unknown names", () => {
    expect(originCountryFor("FIN7")).toBeNull();
    expect(originCountryFor("Some New Actor")).toBeNull();
  });

  it("has an origin for every state-attributed canonical name", () => {
    for (const name of ["APT29", "Turla", "Sandworm", "Kimsuky", "Andariel", "APT1",
      "APT10", "APT40", "Mustang Panda", "Charming Kitten", "APT33", "OilRig",
      "Agrius", "CyberAv3ngers", "Handala", "Hydro Kitten", "Cotton Sandstorm"]) {
      expect(originCountryFor(name), name).toMatch(/^[A-Z]{2}$/);
    }
  });
});

describe("upsertActorFromPulse — never stores the victim country", () => {
  it("binds the actor's origin, not targeted_countries[0]", async () => {
    const { db, calls } = recordingDb();
    const id = await upsertActorFromPulse(db, {
      id: "6abd5b434cf09d69f0ee2e48",
      name: "Star Blizzard refines phishing and malware delivery with the RedFlick technique",
      adversary: "Star Blizzard",
      targeted_countries: ["Ukraine"],
    });
    expect(id).toBe("ta_star_blizzard");
    expect(calls[0].binds).toEqual(["ta_star_blizzard", "Star Blizzard", "RU", "RU"]);
    expect(calls[0].binds).not.toContain("Ukraine");
  });

  it("binds null for an unknown actor even when targets are present", async () => {
    const { db, calls } = recordingDb();
    await upsertActorFromPulse(db, {
      id: "p", name: "x", adversary: "Brand New Group",
      targeted_countries: ["United States of America"],
    });
    expect(calls[0].binds).toEqual(["ta_brand_new_group", "Brand New Group", null, null]);
  });

  it("only fills a missing country on conflict (COALESCE)", async () => {
    const { db, calls } = recordingDb();
    await upsertActorFromPulse(db, { id: "p", name: "x", adversary: "APT28" });
    expect(calls[0].sql).toMatch(/country_code\s*=\s*COALESCE\(threat_actors\.country_code,\s*\?\)/);
  });
});

describe("upsertActorByName", () => {
  it("prefers the registry origin over a caller-supplied country", async () => {
    const { db, calls } = recordingDb();
    await upsertActorByName(db, "coldriver", "news", "GB");
    expect(calls[0].binds).toEqual(["ta_star_blizzard", "Star Blizzard", "news", "RU", "RU"]);
  });

  it("falls back to the caller country on insert only for unknown actors", async () => {
    const { db, calls } = recordingDb();
    await upsertActorByName(db, "Unmapped Cluster", "nexus", "RU");
    expect(calls[0].binds).toEqual(["ta_unmapped_cluster", "Unmapped Cluster", "nexus", "RU", null]);
  });

  it("returns null for a blank name without touching the DB", async () => {
    const { db, calls } = recordingDb();
    expect(await upsertActorByName(db, "   ", "news")).toBeNull();
    expect(calls).toHaveLength(0);
  });
});
