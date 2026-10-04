// PR-E: the public assess / lead / monitor endpoints use the requester IP
// only for their KV rate-limit keys and never persist it to D1. Source pin:
// no INSERT into `assessments` may name the ip_address column.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(resolve(__dirname, "../src/handlers/public.ts"), "utf8");

describe("public assessments never persist the requester IP", () => {
  it("every INSERT INTO assessments omits ip_address", () => {
    const inserts = SRC.match(/INSERT(?:\s+OR\s+IGNORE)?\s+INTO\s+assessments\s*\([^)]*\)/gi) ?? [];
    expect(inserts.length).toBe(3);
    for (const stmt of inserts) expect(stmt).not.toMatch(/ip_address/i);
  });

  it("the IP is still read for rate limiting", () => {
    expect(SRC).toMatch(/pub_assess_\$\{ip\}/);
    expect(SRC).toMatch(/pub_lead_\$\{ip\}/);
    expect(SRC).toMatch(/pub_monitor_\$\{ip\}/);
  });
});
