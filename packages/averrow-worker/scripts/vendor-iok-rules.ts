#!/usr/bin/env tsx
/**
 * Vendor the open IOK phishing-kit ruleset into the Worker.
 *
 * Reads a LOCAL checkout of https://github.com/phish-report/IOK (this script
 * never fetches anything), compiles every `indicators/*.yml` with
 * scripts/iok-compile.ts, and writes:
 *   src/data/iok/rules.json  — compact compiled ruleset (format 1)
 *   src/data/iok/LICENSE     — the ruleset's licence text (ODbL 1.0), copied
 *   src/data/iok/SOURCE.md   — origin, commit, licence, attribution, counts,
 *                              drop reasons, refresh procedure
 *
 * Usage (from packages/averrow-worker):
 *   git clone --depth 1 https://github.com/phish-report/IOK /tmp/iok
 *   pnpm vendor:iok --src /tmp/iok [--vendored-at YYYY-MM-DD]
 *
 * The source checkout must be a git working tree (commit + commit date are
 * read with `git -C <src>`), or pass --commit / --commit-date explicitly.
 */

import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve, basename } from "node:path";
import { parse as parseYaml } from "yaml";

import { compileIokRule, reasonBucket } from "./iok-compile";
import { IOK_FIELD_FIDELITY, IOK_UNSTORED_FIELDS, type IokRule, type IokRuleSet } from "../src/lib/iok-engine";
import { IOK_REGEX_ALLOWLIST } from "../src/lib/iok-regex-allowlist";

export const IOK_REPOSITORY = "https://github.com/phish-report/IOK";
export const IOK_ATTRIBUTION = "Rules: IOK by phish.report (ODbL)";
export const IOK_LICENCE = "ODbL-1.0";

interface Args {
  src: string;
  out: string;
  commit?: string;
  commitDate?: string;
  vendoredAt: string;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const src = get("src");
  if (!src) throw new Error("usage: vendor-iok-rules --src <IOK checkout> [--out dir] [--vendored-at YYYY-MM-DD]");
  return {
    src: resolve(src),
    out: resolve(get("out") ?? resolve(__dirname, "..", "src", "data", "iok")),
    commit: get("commit"),
    commitDate: get("commit-date"),
    vendoredAt: get("vendored-at") ?? new Date().toISOString().slice(0, 10),
  };
}

function git(src: string, ...args: string[]): string {
  return execFileSync("git", ["-C", src, ...args], { encoding: "utf8" }).trim();
}

/** Serialize compactly but one rule per line, so refresh diffs stay readable. */
export function serializeRuleSet(rs: IokRuleSet): string {
  const head = JSON.stringify({ ...rs, rules: [] });
  const body = rs.rules.map((r) => JSON.stringify(r)).join(",\n");
  // head ends with `"rules":[]}` — reopen the array and write one rule per line.
  return `${head.slice(0, -2)}\n${body}\n]}\n`;
}

export interface VendorResult {
  ruleset: IokRuleSet;
  dropped: Array<{ id: string; reason: string }>;
}

/** Compile a set of `{ file, text }` indicator sources. Pure apart from YAML parsing. */
export function compileIndicators(
  files: Array<{ file: string; text: string }>,
  source: IokRuleSet["source"],
): VendorResult {
  const rules: IokRule[] = [];
  const dropped: Array<{ id: string; reason: string }> = [];
  const byReason: Record<string, number> = {};
  const seen = new Set<string>();
  for (const { file, text } of [...files].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))) {
    const id = basename(file).replace(/\.ya?ml$/i, "");
    let doc: unknown;
    try {
      doc = parseYaml(text);
    } catch {
      dropped.push({ id, reason: "yaml parse error" });
      byReason["yaml parse error"] = (byReason["yaml parse error"] ?? 0) + 1;
      continue;
    }
    const res = seen.has(id) ? { ok: false as const, reason: "duplicate id" } : compileIokRule(id, doc);
    seen.add(id);
    if (res.ok) {
      rules.push(res.rule);
    } else {
      dropped.push({ id, reason: res.reason });
      const b = reasonBucket(res.reason);
      byReason[b] = (byReason[b] ?? 0) + 1;
    }
  }
  const ruleset: IokRuleSet = {
    format: 1,
    source,
    stats: { total: files.length, kept: rules.length, dropped: dropped.length, dropped_by_reason: byReason },
    rules,
  };
  return { ruleset, dropped };
}

export function renderSourceMd(r: VendorResult, rulesBytes: number): string {
  const s = r.ruleset.source;
  const st = r.ruleset.stats;
  const reasons = Object.entries(st.dropped_by_reason).sort((a, b) => b[1] - a[1]);
  const fidelity = Object.entries(IOK_FIELD_FIDELITY).map(([f, v]) => `| \`${f}\` | ${v} |`).join("\n");
  return `# IOK ruleset — vendored copy

${IOK_ATTRIBUTION}. Source: <https://phish.report/IOK>.

| | |
|---|---|
| Origin | ${s.repository} (\`indicators/*.yml\`) |
| Commit | \`${s.commit}\` (${s.commit_date}) |
| Vendored | ${s.vendored_at} by \`scripts/vendor-iok-rules.ts\` |
| Licence | Open Database License (ODbL) 1.0 — full text in \`LICENSE\` (this directory) |
| Attribution | "${IOK_ATTRIBUTION}" |
| \`rules.json\` | ${rulesBytes} bytes, format ${r.ruleset.format} |

## What this directory is

\`rules.json\` is a converted copy of the IOK indicator rules (a Derivative
Database under ODbL §4.4): each rule's detection block compiled into a small
JSON AST evaluated by \`src/lib/iok-engine.ts\`. It is licensed under the
ODbL 1.0, the same as the source. The conversion method — the
"alterations" ODbL §4.6(b) refers to — is \`scripts/vendor-iok-rules.ts\` +
\`scripts/iok-compile.ts\`: rules dropped as listed below; regexes translated
from RE2 to JavaScript; \`1 of …\` / \`all of them\` expanded; descriptions and
references left out; tags beyond 20 per rule or longer than 100 characters
left out. Titles, ids and match values are copied unchanged (a rule whose id,
title or value is out of bounds is dropped, not trimmed), and nothing is
added.

Matches are staff-only context on a page capture (never alerts, never
tenant-facing). If they are ever shown outside Averrow staff, the ODbL §4.3
notice ("Contains information from IOK (phish.report), which is made
available here under the Open Database License (ODbL)") must go with them,
and §4.6 applies: offer this \`rules.json\` (or the conversion scripts).

## Counts

- Indicators in the source: **${st.total}**
- Kept (evaluable on stored capture fields): **${st.kept}**
- Dropped: **${st.dropped}**

| Drop reason | Rules |
|---|---|
${reasons.map(([k, v]) => `| ${k} | ${v} |`).join("\n") || "| — | 0 |"}

Dropped rules: ${r.dropped.map((d) => `\`${d.id}\``).join(", ") || "none"}.

## Fields

Evidence comes only from what a page capture already stores (rendered HTML,
title, final URL, redirect chain). Not stored at all:
${IOK_UNSTORED_FIELDS.map((f) => `\`${f}\``).join(", ")} (rules using them are dropped).

| IOK field | Fidelity |
|---|---|
${fidelity}

- **exact** — the same data IOK evaluates (\`dom\` is the rendered HTML;
  \`hostname\` is the final URL's host).
- **subset** — part of what IOK sees: \`title\` is the final title only;
  \`js\` / \`css\` are inline \`<script>\` / \`<style>\` bodies only. A subset
  can miss a match. It cannot produce one IOK would not.
- **approximate** — a stand-in that can miss AND over-match. \`html\` is
  evaluated against the rendered DOM (the server response is not stored), so
  a string a script injected matches although it was never in the response.
  \`requests\` is the redirect chain and final URL plus the sub-resource URLs
  the DOM's own start tags reference (\`src=\`, \`<link rel=stylesheet|icon|
  preload|modulepreload|manifest>\`); a referenced URL that was never
  requested matches, and fetch / XHR requests are missed.

Under \`not\` only an exact field is allowed; other rules are dropped (a
missed match under negation would be a false positive). Positive use of an
approximate field is kept: the over-match is bounded to "the kit's literal
string is in the rendered page" or "the page's own markup points at the
kit's file", which is the evidence IOK's \`dom\` field targets. Matches are
staff-only context that never alerts, and each match lists the non-exact
fields its rule reads (\`approximate_fields\`).

## Regexes

A regex runs only if its exact source is on the hand-reviewed allowlist
\`src/lib/iok-regex-allowlist.ts\` (checked at vendor time and again at run
time, so editing \`rules.json\` by hand cannot add one). Currently allowed:

${IOK_REGEX_ALLOWLIST.map((e) => `- \`${e.source}\` (rule \`${e.rule_id}\`, reviewed at \`${e.reviewed_commit.slice(0, 12)}\`, worst ${e.worst_ms} ms on 256K chars)`).join("\n") || "- none"}

## Refresh

\`\`\`bash
git clone --depth 1 https://github.com/phish-report/IOK /tmp/iok
cd packages/averrow-worker
pnpm vendor:iok --src /tmp/iok
git diff -- src/data/iok/rules.json
npx vitest run test/iok-engine.test.ts
\`\`\`

The rules are third-party input. Before committing a refresh:

1. Read the \`rules.json\` diff. Review every new or changed rule by hand:
   what it matches, which fields it reads, whether its strings are specific
   enough to mean a kit.
2. A rule dropped as "token-like value" carries a credential-shaped string
   (a kit's download token or client key) in a match value. It stays
   dropped: third-party tokens are not vendored, and secret scanning would
   flag them.
3. Read the vendor output for dropped rules. A rule dropped as
   "regex not on allowlist" stays dropped unless you add its pattern on
   purpose: read the pattern, time it on adversarial input at 256K chars
   (repeat its own prefix; near-misses of each quantified part), and add an
   entry to \`src/lib/iok-regex-allowlist.ts\` with the rule id, this commit
   and the measured time. More than a few milliseconds: leave it dropped.
   If a listed pattern changed upstream, its old entry no longer applies.
4. Re-read the upstream \`LICENSE\` and README licence section, and update
   \`docs/licences/iok.md\` if the terms changed.
`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const dir = resolve(args.src, "indicators");
  const names = (await readdir(dir)).filter((f) => /\.ya?ml$/i.test(f));
  const files = await Promise.all(names.map(async (file) => ({ file, text: await readFile(resolve(dir, file), "utf8") })));
  const source: IokRuleSet["source"] = {
    repository: IOK_REPOSITORY,
    commit: args.commit ?? git(args.src, "rev-parse", "HEAD"),
    commit_date: args.commitDate ?? git(args.src, "log", "-1", "--format=%cI"),
    vendored_at: args.vendoredAt,
    licence: IOK_LICENCE,
    attribution: IOK_ATTRIBUTION,
  };
  const result = compileIndicators(files, source);
  const json = serializeRuleSet(result.ruleset);
  await mkdir(args.out, { recursive: true });
  await writeFile(resolve(args.out, "rules.json"), json);
  await copyFile(resolve(args.src, "LICENSE"), resolve(args.out, "LICENSE"));
  const bytes = Buffer.byteLength(json, "utf8");
  await writeFile(resolve(args.out, "SOURCE.md"), renderSourceMd(result, bytes));
  process.stdout.write(
    `IOK ${source.commit.slice(0, 12)}: ${result.ruleset.stats.total} rules, ${result.ruleset.stats.kept} kept, ` +
    `${result.ruleset.stats.dropped} dropped; rules.json ${bytes} bytes\n` +
    `${JSON.stringify(result.ruleset.stats.dropped_by_reason)}\n`,
  );
}

if (process.argv[1] && /vendor-iok-rules\.ts$/.test(process.argv[1])) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  });
}
