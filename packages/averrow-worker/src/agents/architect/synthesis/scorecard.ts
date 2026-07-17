/**
 * ARCHITECT Phase 3 — server-side scorecard computation.
 *
 * The three Phase 2 analyses each carry a `scorecard` field that Haiku
 * filled in itself. Those numbers are not trustworthy: Haiku
 * occasionally miscounts its own assessments, or drifts from the
 * severity tags attached to the individual rows. Phase 3 drops those
 * self-reported counts entirely and derives the scorecard from the
 * assessments arrays themselves, which ARE trustworthy — each row's
 * severity + recommendation went through the tool_use schema and the
 * hand-rolled validator.
 *
 * This is deterministic, fast (microseconds), and observable: the
 * result is persisted alongside the Sonnet markdown inside the
 * architect agent's `agent_outputs.details` payload so UIs and later
 * audits can render counts without re-parsing the narrative.
 */

import type {
  Recommendation,
  SectionAnalysis,
  SectionName,
  Severity,
} from "../analysis/types";

/** Per-section severity tally — matches the shape the report renders. */
export interface SectionScorecard {
  green: number;
  amber: number;
  red: number;
  total: number;
}

/**
 * Fully computed scorecard for a synthesis run.
 *
 * `agents`, `feeds`, and `data_layer` are per-section tallies.
 * `overall` sums them column-wise.
 * `kill_count`, `refactor_count`, and `split_count` are cross-section
 * recommendation counts — the headline numbers the executive summary
 * and the Top-5 priorities block lean on.
 */
export interface ComputedScorecard {
  agents: SectionScorecard;
  feeds: SectionScorecard;
  data_layer: SectionScorecard;
  overall: SectionScorecard;
  kill_count: number;
  refactor_count: number;
  split_count: number;
}

const EMPTY_SECTION: SectionScorecard = {
  green: 0,
  amber: 0,
  red: 0,
  total: 0,
};

interface AssessmentLike {
  severity: Severity;
  recommendation: Recommendation;
}

/**
 * Pull validated severity + recommendation pairs out of one
 * SectionAnalysis. Defensive — anything that doesn't match the enum
 * contract is dropped silently so unit fixtures with partial shapes
 * still flow through.
 */
function extractAssessments(analysis: SectionAnalysis): AssessmentLike[] {
  const assessments = (analysis as { assessments?: unknown }).assessments;
  if (!Array.isArray(assessments)) return [];

  const out: AssessmentLike[] = [];
  for (const raw of assessments) {
    if (raw === null || typeof raw !== "object") continue;
    const obj = raw as Record<string, unknown>;
    const severity = obj["severity"];
    const recommendation = obj["recommendation"];
    if (
      (severity === "green" || severity === "amber" || severity === "red") &&
      (recommendation === "keep" ||
        recommendation === "split" ||
        recommendation === "merge" ||
        recommendation === "kill" ||
        recommendation === "refactor")
    ) {
      out.push({
        severity,
        recommendation,
      });
    }
  }
  return out;
}

function tallySection(assessments: AssessmentLike[]): SectionScorecard {
  const out: SectionScorecard = { green: 0, amber: 0, red: 0, total: 0 };
  for (const a of assessments) {
    out[a.severity] += 1;
    out.total += 1;
  }
  return out;
}

/**
 * Count assessments matching a specific recommendation across every
 * section. These are the "this week" headline numbers the narrative
 * pulls on — e.g. "5 kill, 3 refactor, 1 split".
 */
function countRecommendation(
  perSection: Record<SectionName, AssessmentLike[]>,
  target: Recommendation,
): number {
  let n = 0;
  for (const section of Object.keys(perSection) as SectionName[]) {
    for (const a of perSection[section]) {
      if (a.recommendation === target) n += 1;
    }
  }
  return n;
}

/**
 * Compute the ground-truth scorecard from in-memory SectionAnalysis
 * payloads. Iterates the assessments array in each of the three
 * sections and tallies severities + recommendations. Missing
 * sections contribute zeros rather than throwing.
 *
 * Overall counts are the column-wise sum of the three sections. If a
 * caller passes in multiple analyses for the same section (shouldn't
 * happen) we fold them all into that section's tally; no dedup.
 */
export function computeScorecardFromAnalyses(
  analyses: SectionAnalysis[],
): ComputedScorecard {
  const perSection: Record<SectionName, AssessmentLike[]> = {
    agents: [],
    feeds: [],
    data_layer: [],
  };

  for (const analysis of analyses) {
    if (
      analysis.section !== "agents" &&
      analysis.section !== "feeds" &&
      analysis.section !== "data_layer"
    ) {
      // Ignore unknown sections — keeps us forward-compatible if a
      // new section is added before this counter catches up.
      continue;
    }
    perSection[analysis.section].push(...extractAssessments(analysis));
  }

  const agents = tallySection(perSection.agents);
  const feeds = tallySection(perSection.feeds);
  const dataLayer = tallySection(perSection.data_layer);

  const overall: SectionScorecard = {
    green: agents.green + feeds.green + dataLayer.green,
    amber: agents.amber + feeds.amber + dataLayer.amber,
    red: agents.red + feeds.red + dataLayer.red,
    total: agents.total + feeds.total + dataLayer.total,
  };

  return {
    agents,
    feeds,
    data_layer: dataLayer,
    overall,
    kill_count: countRecommendation(perSection, "kill"),
    refactor_count: countRecommendation(perSection, "refactor"),
    split_count: countRecommendation(perSection, "split"),
  };
}

export { EMPTY_SECTION };
