// Averrow — hand-reviewed allowlist of IOK `re` patterns.
//
// IOK rules are third-party input and the page HTML is attacker input. A
// JavaScript regex cannot be interrupted once `RegExp.test` starts, so no
// budget can save us from a pattern that backtracks badly, and a static
// screen (assessRegexSafety, lib/iok-engine.ts) can always be fooled by a
// shape nobody thought of. So the rule is: a regex runs ONLY if its exact
// source (after RE2 → JS translation) and flags are listed here, added by a
// person who read it and measured it.
//
//   - Vendor time (scripts/iok-compile.ts): a rule whose `re` is not listed
//     is dropped and counted ("regex not on allowlist").
//   - Run time (lib/iok-engine.ts): a pattern not listed is never compiled,
//     so a hand-edited rules.json cannot bring one in.
//   - assessRegexSafety still runs as a second check on listed patterns.
//
// To add a pattern (see src/data/iok/SOURCE.md "Refresh"): read it, run it
// against adversarial input at IOK_REGEX_INPUT_MAX chars (repeat its own
// prefix; near-misses of every quantified part), record the worst time, and
// add the entry with the rule id and the upstream commit you reviewed it at.
// If the worst case is more than a few milliseconds, do not add it.
//
// Reviewed and REFUSED at 142f762a (kept here so nobody re-adds them):
//   class-attribute-obfuscation
//     class="(?:(?: |  )?(?:[A-Za-z0-9]{20})(?: |  )?){8}
//     184 ms on 256K chars of `class="` + 7 double-spaced 20-char blocks
//     (3 ways to split each gap, 3^7 paths per start).
//   data-content-attribute-obfuscation
//     data-content="([0-9]{2,3}).+"
//     `.+"` rescans to end of line from every start: quadratic.

export interface IokAllowedRegex {
  /** Exact JS regex source as stored in rules.json. */
  source: string;
  /** "" or "i". */
  flags: "" | "i";
  /** Rule the pattern belongs to. */
  rule_id: string;
  /** Upstream IOK commit the pattern was reviewed at. */
  reviewed_commit: string;
  /** Worst measured `RegExp.test` time at IOK_REGEX_INPUT_MAX chars. */
  worst_ms: number;
  note: string;
}

export const IOK_REGEX_ALLOWLIST: readonly IokAllowedRegex[] = [
  {
    source: String.raw`(Spox|Crax)\/Files`,
    flags: "",
    rule_id: "spox-chase-8b20b051",
    reviewed_commit: "142f762aa12994cbd26ddf7d40d40c07ac01bd66",
    worst_ms: 0.3,
    note: "Two literal alternatives then a literal; no quantifier. 0.26 ms on 256K chars of 'Spox/FileSpox/FileCrax/File'.",
  },
];

const ALLOWED = new Set(IOK_REGEX_ALLOWLIST.map((e) => `${e.flags}/${e.source}`));

export function isAllowedIokRegex(source: string, flags: string = ""): boolean {
  return ALLOWED.has(`${flags}/${source}`);
}
