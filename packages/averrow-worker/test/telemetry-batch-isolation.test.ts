/**
 * No D1 batch mixes an agent-runs family table with any other table
 * (Track B1c).
 *
 * agent_runs / agent_configs / agent_events / agent_activity_log /
 * agent_approvals are served from TELEMETRY_DB once `db_route:telemetry`
 * flips; every other table stays on core (feed_* and budget_* move in a
 * later family). A D1 batch runs on ONE database, so a batch holding both
 * would send one half to the wrong DB — after the flip it fails ("no such
 * table") or writes a row the reads never see.
 *
 * Static and heuristic, by design: for every `.batch(` call in src/ it
 * collects the SQL the batch can contain — the call's own argument text,
 * plus, when the argument is an identifier, every snippet that builds it in
 * the same file (`X.push(…)`, `X = […]`, `X = ….map(…)`), plus the bodies of
 * local helper functions those snippets call (e.g. FC's logActivityStmt) —
 * and fails when the tables named there include a family table AND a
 * non-family table.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const FAMILY = new Set(["agent_runs", "agent_configs", "agent_events", "agent_activity_log", "agent_approvals"]);
const SRC = resolve(__dirname, "..", "src");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.ts$/.test(name)) out.push(p);
  }
  return out;
}

/** Text between the `(` at `open` and its matching `)`. */
function balanced(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return text.slice(open + 1);
}

const TABLE_RE = /\b(?:FROM|INTO|UPDATE|JOIN)\s+([a-z_][a-z0-9_]*)/gi;
const SQL_NOISE = new Set(["select", "json_each", "pragma_table_info", "sqlite_master", "set", "values"]);

function tablesIn(snippet: string): Set<string> {
  const out = new Set<string>();
  for (const m of snippet.matchAll(TABLE_RE)) {
    const t = m[1]!.toLowerCase();
    if (!SQL_NOISE.has(t)) out.add(t);
  }
  return out;
}

/** The snippet plus the bodies of same-file functions it calls (one level). */
function withLocalHelpers(file: string, snippet: string): string {
  let text = snippet;
  for (const call of snippet.matchAll(/\b([a-zA-Z_]\w*)\s*\(/g)) {
    const name = call[1]!;
    const def = file.search(new RegExp(`function\\s+${name}\\s*\\(`));
    if (def < 0) continue;
    const bodyStart = file.indexOf("{", file.indexOf(")", def));
    if (bodyStart >= 0) text += "\n" + balanced(file, bodyStart - 0).slice(0, 4000);
  }
  return text;
}

/** Everything a `.batch(<ident>)` can contain, from its builders in the same file. */
function buildersOf(file: string, ident: string): string {
  const parts: string[] = [];
  const esc = ident.replace(/[.$]/g, "\\$&");
  for (const m of file.matchAll(new RegExp(`\\b${esc}\\.push\\(`, "g"))) {
    parts.push(balanced(file, m.index! + m[0].length - 1));
  }
  for (const m of file.matchAll(new RegExp(`\\b${esc}\\s*(?::[^=]+)?=\\s*`, "g"))) {
    const from = m.index! + m[0].length;
    parts.push(file.slice(from, file.indexOf(";", from) + 1 || from + 600));
  }
  return parts.join("\n");
}

function scanBatches(list: Array<{ rel: string; text: string }>): { offenders: string[]; familyBatches: string[] } {
  const offenders: string[] = [];
  const familyBatches: string[] = [];
  for (const f of list) {
    for (const m of f.text.matchAll(/\.batch(?:<[^>]*>)?\(/g)) {
      const arg = balanced(f.text, m.index! + m[0].length - 1);
      let snippet = arg;
      const ident = arg.trim().match(/^([a-zA-Z_][\w.]*)$/)?.[1];
      if (ident) snippet += "\n" + buildersOf(f.text, ident.split(".").pop()!);
      const tables = tablesIn(withLocalHelpers(f.text, snippet));
      const fam = [...tables].filter((t) => FAMILY.has(t));
      if (fam.length === 0) continue;
      const line = f.text.slice(0, m.index!).split("\n").length;
      familyBatches.push(`${f.rel}:${line}`);
      const other = [...tables].filter((t) => !FAMILY.has(t));
      if (other.length > 0) offenders.push(`${f.rel}:${line} batches ${fam.join(", ")} with ${other.join(", ")}`);
    }
  }
  return { offenders, familyBatches };
}

const files = sourceFiles(SRC).map((p) => ({ rel: relative(SRC, p).split("\\").join("/"), text: readFileSync(p, "utf8") }));

describe("telemetry batch isolation", () => {
  it("no .batch( mixes an agent-runs family table with another table", () => {
    const { offenders, familyBatches } = scanBatches(files);
    expect(offenders, "split the batch per database: agent-runs family tables go to the routed telemetry store (lib/db-route.ts)").toEqual([]);
    // The scan must actually see family batches: FC's activity-log flush and
    // the agent_configs reset are written so the heuristic can trace them.
    expect(familyBatches.some((l) => l.startsWith("agents/flightControl.ts:"))).toBe(true);
    expect(familyBatches.some((l) => l.startsWith("handlers/agents.ts:"))).toBe(true);
  });

  it("flags a batch that mixes the two (self-test of the heuristic)", () => {
    const text = [
      "async function f(db: D1Database) {",
      "  const stmts: D1PreparedStatement[] = [];",
      "  stmts.push(db.prepare(`UPDATE agent_runs SET status = 'failed' WHERE id = ?`).bind(1));",
      "  stmts.push(logStmt(db));",
      "  await db.batch(stmts);",
      "  await db.batch([db.prepare(`INSERT INTO agent_events (id) VALUES (?)`), db.prepare(`UPDATE threats SET x = 1`)]);",
      "}",
      "function logStmt(db: D1Database) { return db.prepare(`INSERT INTO brands (id) VALUES (1)`); }",
    ].join("\n");
    const { offenders } = scanBatches([{ rel: "x.ts", text }]);
    expect(offenders).toHaveLength(2);
    expect(offenders[0]).toMatch(/agent_runs with brands/);
    expect(offenders[1]).toMatch(/agent_events with threats/);
  });
});
