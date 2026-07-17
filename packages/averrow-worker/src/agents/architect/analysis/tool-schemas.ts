/**
 * ARCHITECT Phase 2 — Anthropic tool_use schemas.
 *
 * Each of the three section analyzers constrains Haiku to call a
 * single tool whose `input_schema` mirrors the corresponding TS
 * interface in `./types.ts`. This replaces the old "ask for JSON in
 * prose, then parse the text block" approach: the API guarantees that
 * `content[0].input` is a parsed object matching the schema, so we
 * don't need fence-stripping, brace-hunting, or retry-with-stricter-
 * prompt workarounds.
 *
 * The `maxLength` constraints scattered through these schemas are a
 * deliberate fix for token bloat — they force Haiku to be terse
 * instead of writing prose essays per field, which is what was
 * tripping the max_tokens stop_reason in production.
 *
 * additionalProperties: false everywhere so the model can't sneak in
 * extra keys that the hand-rolled validator will reject later.
 */

const SEVERITY_ENUM = ["green", "amber", "red"] as const;
const RECOMMENDATION_ENUM = [
  "keep",
  "split",
  "merge",
  "kill",
  "refactor",
] as const;
const SCALE_RISK_ENUM = ["low", "medium", "high"] as const;

const SCORECARD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["green", "amber", "red"],
  properties: {
    green: { type: "integer", minimum: 0 },
    amber: { type: "integer", minimum: 0 },
    red: { type: "integer", minimum: 0 },
  },
} as const;

export const REPORT_AGENTS_ANALYSIS_TOOL = {
  name: "report_agents_analysis",
  description:
    "Submit the structured agent analysis for the Averrow platform audit.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: [
      "section",
      "summary",
      "scorecard",
      "assessments",
      "cross_cutting_concerns",
    ],
    properties: {
      section: { type: "string", enum: ["agents"] },
      summary: { type: "string", maxLength: 600 },
      scorecard: SCORECARD_SCHEMA,
      assessments: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "name",
            "severity",
            "recommendation",
            "rationale",
            "evidence",
            "concerns",
            "suggested_actions",
          ],
          properties: {
            name: { type: "string", maxLength: 120 },
            severity: { type: "string", enum: SEVERITY_ENUM },
            recommendation: { type: "string", enum: RECOMMENDATION_ENUM },
            rationale: { type: "string", maxLength: 400 },
            evidence: {
              type: "array",
              items: { type: "string", maxLength: 200 },
            },
            concerns: {
              type: "array",
              items: { type: "string", maxLength: 200 },
            },
            suggested_actions: {
              type: "array",
              items: { type: "string", maxLength: 200 },
            },
            merge_with: { type: "string", maxLength: 120 },
            split_into: {
              type: "array",
              items: { type: "string", maxLength: 120 },
            },
          },
        },
      },
      cross_cutting_concerns: {
        type: "array",
        items: { type: "string", maxLength: 300 },
      },
    },
  },
} as const;

export const REPORT_FEEDS_ANALYSIS_TOOL = {
  name: "report_feeds_analysis",
  description:
    "Submit the structured feed analysis for the Averrow platform audit.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: [
      "section",
      "summary",
      "scorecard",
      "assessments",
      "cross_cutting_concerns",
    ],
    properties: {
      section: { type: "string", enum: ["feeds"] },
      summary: { type: "string", maxLength: 600 },
      scorecard: SCORECARD_SCHEMA,
      assessments: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "name",
            "severity",
            "recommendation",
            "rationale",
            "evidence",
            "concerns",
            "suggested_actions",
          ],
          properties: {
            name: { type: "string", maxLength: 120 },
            severity: { type: "string", enum: SEVERITY_ENUM },
            recommendation: { type: "string", enum: RECOMMENDATION_ENUM },
            rationale: { type: "string", maxLength: 400 },
            evidence: {
              type: "array",
              items: { type: "string", maxLength: 200 },
            },
            concerns: {
              type: "array",
              items: { type: "string", maxLength: 200 },
            },
            suggested_actions: {
              type: "array",
              items: { type: "string", maxLength: 200 },
            },
          },
        },
      },
      cross_cutting_concerns: {
        type: "array",
        items: { type: "string", maxLength: 300 },
      },
    },
  },
} as const;

export const REPORT_DATA_LAYER_ANALYSIS_TOOL = {
  name: "report_data_layer_analysis",
  description:
    "Submit the structured data layer analysis for the Averrow platform audit.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: [
      "section",
      "summary",
      "scorecard",
      "assessments",
      "hot_tables",
      "scale_bottlenecks",
      "cross_cutting_concerns",
    ],
    properties: {
      section: { type: "string", enum: ["data_layer"] },
      summary: { type: "string", maxLength: 600 },
      scorecard: SCORECARD_SCHEMA,
      assessments: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "name",
            "severity",
            "recommendation",
            "rationale",
            "evidence",
            "concerns",
            "suggested_actions",
            "scale_risk",
          ],
          properties: {
            name: { type: "string", maxLength: 120 },
            severity: { type: "string", enum: SEVERITY_ENUM },
            recommendation: { type: "string", enum: RECOMMENDATION_ENUM },
            rationale: { type: "string", maxLength: 400 },
            evidence: {
              type: "array",
              items: { type: "string", maxLength: 200 },
            },
            concerns: {
              type: "array",
              items: { type: "string", maxLength: 200 },
            },
            suggested_actions: {
              type: "array",
              items: { type: "string", maxLength: 200 },
            },
            scale_risk: { type: "string", enum: SCALE_RISK_ENUM },
          },
        },
      },
      hot_tables: {
        type: "array",
        items: { type: "string", maxLength: 120 },
      },
      scale_bottlenecks: {
        type: "array",
        items: { type: "string", maxLength: 120 },
      },
      cross_cutting_concerns: {
        type: "array",
        items: { type: "string", maxLength: 300 },
      },
    },
  },
} as const;
