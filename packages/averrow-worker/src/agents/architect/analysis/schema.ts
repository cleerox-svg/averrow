/**
 * Hand-rolled schema validators for the three section analyses.
 *
 * We intentionally avoid Zod here to keep the Worker bundle lean
 * and the validation logic transparent — each function walks an
 * `unknown` and either returns the typed analysis or throws with
 * a path-prefixed error message that tells us exactly which field
 * the model got wrong. The orchestrator treats any throw as a
 * "failed" analysis.
 */

import type {
  AgentAssessment,
  AgentsAnalysis,
  DataLayerAnalysis,
  FeedAssessment,
  FeedsAnalysis,
  Recommendation,
  ScaleRisk,
  Scorecard,
  Severity,
  TableAssessment,
} from "./types";

const SEVERITIES: readonly Severity[] = ["green", "amber", "red"] as const;
const RECOMMENDATIONS: readonly Recommendation[] = [
  "keep",
  "split",
  "merge",
  "kill",
  "refactor",
] as const;
const SCALE_RISKS: readonly ScaleRisk[] = ["low", "medium", "high"] as const;

class SchemaError extends Error {
  constructor(path: string, message: string) {
    super(`[${path}] ${message}`);
    this.name = "SchemaError";
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function requireString(obj: Record<string, unknown>, key: string, path: string): string {
  const v = obj[key];
  if (typeof v !== "string") {
    throw new SchemaError(`${path}.${key}`, `expected string, got ${typeof v}`);
  }
  return v;
}

function requireStringArray(
  obj: Record<string, unknown>,
  key: string,
  path: string,
): string[] {
  const v = obj[key];
  if (!Array.isArray(v)) {
    throw new SchemaError(`${path}.${key}`, `expected array, got ${typeof v}`);
  }
  return v.map((item, i) => {
    if (typeof item !== "string") {
      throw new SchemaError(`${path}.${key}[${i}]`, `expected string, got ${typeof item}`);
    }
    return item;
  });
}

function optionalString(
  obj: Record<string, unknown>,
  key: string,
  path: string,
): string | undefined {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") {
    throw new SchemaError(`${path}.${key}`, `expected string | null | undefined, got ${typeof v}`);
  }
  return v;
}

function optionalStringArray(
  obj: Record<string, unknown>,
  key: string,
  path: string,
): string[] | undefined {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) {
    throw new SchemaError(
      `${path}.${key}`,
      `expected array | null | undefined, got ${typeof v}`,
    );
  }
  return v.map((item, i) => {
    if (typeof item !== "string") {
      throw new SchemaError(`${path}.${key}[${i}]`, `expected string, got ${typeof item}`);
    }
    return item;
  });
}

function requireEnum<T extends string>(
  obj: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  path: string,
): T {
  const v = obj[key];
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) {
    throw new SchemaError(
      `${path}.${key}`,
      `expected one of ${allowed.join(" | ")}, got ${JSON.stringify(v)}`,
    );
  }
  return v as T;
}

function requireNumber(
  obj: Record<string, unknown>,
  key: string,
  path: string,
): number {
  const v = obj[key];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new SchemaError(`${path}.${key}`, `expected finite number, got ${typeof v}`);
  }
  return v;
}

function requireRecord(
  v: unknown,
  path: string,
): Record<string, unknown> {
  if (!isRecord(v)) {
    throw new SchemaError(path, `expected object, got ${Array.isArray(v) ? "array" : typeof v}`);
  }
  return v;
}

function requireArray(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) {
    throw new SchemaError(path, `expected array, got ${typeof v}`);
  }
  return v;
}

// ─── Scorecard ─────────────────────────────────────────────────────

function parseScorecard(v: unknown, path: string): Scorecard {
  const obj = requireRecord(v, path);
  return {
    green: requireNumber(obj, "green", path),
    amber: requireNumber(obj, "amber", path),
    red: requireNumber(obj, "red", path),
  };
}

// ─── Agent assessment ──────────────────────────────────────────────

function parseAgentAssessment(v: unknown, path: string): AgentAssessment {
  const obj = requireRecord(v, path);
  const rec = requireEnum(obj, "recommendation", RECOMMENDATIONS, path);
  const result: AgentAssessment = {
    name: requireString(obj, "name", path),
    severity: requireEnum(obj, "severity", SEVERITIES, path),
    recommendation: rec,
    rationale: requireString(obj, "rationale", path),
    evidence: requireStringArray(obj, "evidence", path),
    concerns: requireStringArray(obj, "concerns", path),
    suggested_actions: requireStringArray(obj, "suggested_actions", path),
  };
  const mergeWith = optionalString(obj, "merge_with", path);
  if (mergeWith !== undefined) result.merge_with = mergeWith;
  const splitInto = optionalStringArray(obj, "split_into", path);
  if (splitInto !== undefined) result.split_into = splitInto;
  return result;
}

// ─── Feed assessment ───────────────────────────────────────────────

function parseFeedAssessment(v: unknown, path: string): FeedAssessment {
  const obj = requireRecord(v, path);
  return {
    name: requireString(obj, "name", path),
    severity: requireEnum(obj, "severity", SEVERITIES, path),
    recommendation: requireEnum(obj, "recommendation", RECOMMENDATIONS, path),
    rationale: requireString(obj, "rationale", path),
    evidence: requireStringArray(obj, "evidence", path),
    concerns: requireStringArray(obj, "concerns", path),
    suggested_actions: requireStringArray(obj, "suggested_actions", path),
  };
}

// ─── Table assessment ──────────────────────────────────────────────

function parseTableAssessment(v: unknown, path: string): TableAssessment {
  const obj = requireRecord(v, path);
  return {
    name: requireString(obj, "name", path),
    severity: requireEnum(obj, "severity", SEVERITIES, path),
    recommendation: requireEnum(obj, "recommendation", RECOMMENDATIONS, path),
    rationale: requireString(obj, "rationale", path),
    evidence: requireStringArray(obj, "evidence", path),
    concerns: requireStringArray(obj, "concerns", path),
    suggested_actions: requireStringArray(obj, "suggested_actions", path),
    scale_risk: requireEnum(obj, "scale_risk", SCALE_RISKS, path),
  };
}

// ─── Top-level parsers ─────────────────────────────────────────────

export function parseAgentsAnalysis(v: unknown): AgentsAnalysis {
  const obj = requireRecord(v, "AgentsAnalysis");
  const assessmentsRaw = requireArray(obj["assessments"], "AgentsAnalysis.assessments");
  return {
    section: "agents",
    summary: requireString(obj, "summary", "AgentsAnalysis"),
    scorecard: parseScorecard(obj["scorecard"], "AgentsAnalysis.scorecard"),
    assessments: assessmentsRaw.map((a, i) =>
      parseAgentAssessment(a, `AgentsAnalysis.assessments[${i}]`),
    ),
    cross_cutting_concerns: requireStringArray(
      obj,
      "cross_cutting_concerns",
      "AgentsAnalysis",
    ),
  };
}

export function parseFeedsAnalysis(v: unknown): FeedsAnalysis {
  const obj = requireRecord(v, "FeedsAnalysis");
  const assessmentsRaw = requireArray(obj["assessments"], "FeedsAnalysis.assessments");
  return {
    section: "feeds",
    summary: requireString(obj, "summary", "FeedsAnalysis"),
    scorecard: parseScorecard(obj["scorecard"], "FeedsAnalysis.scorecard"),
    assessments: assessmentsRaw.map((a, i) =>
      parseFeedAssessment(a, `FeedsAnalysis.assessments[${i}]`),
    ),
    cross_cutting_concerns: requireStringArray(
      obj,
      "cross_cutting_concerns",
      "FeedsAnalysis",
    ),
  };
}

export function parseDataLayerAnalysis(v: unknown): DataLayerAnalysis {
  const obj = requireRecord(v, "DataLayerAnalysis");
  const assessmentsRaw = requireArray(obj["assessments"], "DataLayerAnalysis.assessments");
  return {
    section: "data_layer",
    summary: requireString(obj, "summary", "DataLayerAnalysis"),
    scorecard: parseScorecard(obj["scorecard"], "DataLayerAnalysis.scorecard"),
    assessments: assessmentsRaw.map((a, i) =>
      parseTableAssessment(a, `DataLayerAnalysis.assessments[${i}]`),
    ),
    hot_tables: requireStringArray(obj, "hot_tables", "DataLayerAnalysis"),
    scale_bottlenecks: requireStringArray(
      obj,
      "scale_bottlenecks",
      "DataLayerAnalysis",
    ),
    cross_cutting_concerns: requireStringArray(
      obj,
      "cross_cutting_concerns",
      "DataLayerAnalysis",
    ),
  };
}

export { SchemaError };
