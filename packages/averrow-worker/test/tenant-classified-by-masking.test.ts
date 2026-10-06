// A staff classifier's user id is never shown to a customer: tenant module
// reads mask `classified_by` to "Averrow SOC" when it holds a staff user id.
import { describe, it, expect } from "vitest";
import { hasSqlite, openDerivedDb } from "./sqlite-d1-harness";
import { maskedClassifiedBySql } from "../src/handlers/tenantUserMasking";

describe.skipIf(!hasSqlite())("maskedClassifiedBySql", () => {
  it("masks staff ids, keeps machine values and customer ids", () => {
    const db = openDerivedDb(["users", "social_profiles"]);
    db.exec(`INSERT INTO users (id, email, name, role) VALUES
      ('usr_staff', 'analyst@averrow.example', 'Staff', 'analyst'),
      ('usr_cust', 'owner@acme.example', 'Owner', 'client')`);
    const rows: Array<[string, string | null]> = [
      ["p1", "usr_staff"], ["p2", "usr_cust"], ["p3", "ai"], ["p4", "auto_discovery"], ["p5", null],
    ];
    for (const [id, by] of rows) {
      db.prepare(
        `INSERT INTO social_profiles (id, brand_id, platform, handle, classified_by)
         VALUES (?, 'brand_1', 'twitter', ?, ?)`,
      ).run(id, `h_${id}`, by);
    }
    const out = db.prepare(
      `SELECT id, ${maskedClassifiedBySql("classified_by")} FROM social_profiles ORDER BY id`,
    ).all() as Array<{ id: string; classified_by: string | null }>;
    expect(out.map((r) => r.classified_by)).toEqual([
      "Averrow SOC", "usr_cust", "ai", "auto_discovery", null,
    ]);
  });
});
