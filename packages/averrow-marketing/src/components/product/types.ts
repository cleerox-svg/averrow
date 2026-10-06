/*
 * Shared prop types for the Platform product-page kit (src/components/product/).
 * Phase 2 pages import these so every sample / step / scope row has one shape.
 */

/** Pill tone. Every pill carries text, so severity is never colour alone. */
export type Tone = "high" | "med" | "low" | "new" | "ok" | "hold";

/** One row of an illustrative sample (fictional brand Acme, `.example` domains only). */
export interface SampleRow {
  /** Primary text: a domain, handle or short title. */
  text: string;
  /** Render `text` in the monospace face (domains, handles). */
  mono?: boolean;
  /** Secondary line under the text, e.g. "registered yesterday". */
  status?: string;
  /** Pill text, e.g. "High", "Likely fake", "Copycat". */
  pill: string;
  tone: Tone;
}

/** The product-UI fragment shown under a step. */
export interface StepOutput {
  /** Accessible name for the fragment, e.g. "Sample generated lookalikes". */
  label: string;
  rows: SampleRow[];
  note?: string;
}

export interface Step {
  title: string;
  text: string;
  output: StepOutput;
}

/** One row of the covered / not-covered table. */
export interface ScopeRow {
  area: string;
  covered: string;
  notCovered: string;
}

/** Keys the ProofStrip can show; each resolves from src/data/stats.json or is omitted. */
export type ProofKey = "threats" | "operations" | "brands" | "lookalikes" | "providers";
