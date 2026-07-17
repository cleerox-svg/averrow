/**
 * ARCHITECT Phase 2 — Haiku inventory analysis output types.
 *
 * Each of the three analyzers emits a strongly-typed assessment built
 * from a slice of a Phase 1 ContextBundle. The shapes here are the
 * contract the model is asked to fill in (as JSON) and the contract
 * downstream synthesis + the UI read out of agent_outputs.details.
 */

export type Recommendation = "keep" | "split" | "merge" | "kill" | "refactor";
export type Severity = "green" | "amber" | "red";
export type ScaleRisk = "low" | "medium" | "high";

export interface Scorecard {
  green: number;
  amber: number;
  red: number;
}

export interface AgentAssessment {
  name: string;
  severity: Severity;
  recommendation: Recommendation;
  /** 1-3 sentences, specific, evidence-based. */
  rationale: string;
  /** Concrete signals pulled from the bundle. */
  evidence: string[];
  concerns: string[];
  /** Actionable, not vague. */
  suggested_actions: string[];
  /** Present when recommendation === 'merge'. */
  merge_with?: string;
  /** Present when recommendation === 'split'. */
  split_into?: string[];
}

export interface FeedAssessment {
  name: string;
  severity: Severity;
  recommendation: Recommendation;
  rationale: string;
  evidence: string[];
  concerns: string[];
  suggested_actions: string[];
}

export interface TableAssessment {
  name: string;
  severity: Severity;
  recommendation: Recommendation;
  rationale: string;
  evidence: string[];
  concerns: string[];
  suggested_actions: string[];
  /** Projected pain at 10x current scale. */
  scale_risk: ScaleRisk;
}

export interface AgentsAnalysis {
  section: "agents";
  /** 2-3 sentence executive summary. */
  summary: string;
  scorecard: Scorecard;
  assessments: AgentAssessment[];
  /** Patterns spanning multiple agents. */
  cross_cutting_concerns: string[];
}

export interface FeedsAnalysis {
  section: "feeds";
  summary: string;
  scorecard: Scorecard;
  assessments: FeedAssessment[];
  cross_cutting_concerns: string[];
}

export interface DataLayerAnalysis {
  section: "data_layer";
  summary: string;
  scorecard: Scorecard;
  assessments: TableAssessment[];
  /** Top 5 by bytes or growth. */
  hot_tables: string[];
  /** Tables that break at 10x. */
  scale_bottlenecks: string[];
  cross_cutting_concerns: string[];
}

export type SectionName = "agents" | "feeds" | "data_layer";
export type SectionAnalysis = AgentsAnalysis | FeedsAnalysis | DataLayerAnalysis;

/**
 * Per-call result returned by the analyzer functions. The architect
 * AgentModule aggregates these into a single agent_outputs row;
 * nothing outside of the analysis/ + synthesis/ directories should
 * need to touch this shape directly.
 */
export interface AnalyzerResult<T extends SectionAnalysis> {
  analysis: T;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  duration_ms: number;
}
