import { describe, it, expect } from "vitest";
import {
  describeDetermination, RULES_EMAIL_NOTE, RULES_REVIEW_FIRST_STEP, AI_EMAIL_NOTE,
} from "../src/lib/abuse-mailbox-responder";

const row = (over: Partial<Parameters<typeof describeDetermination>[0]>) => ({
  classification: "ambiguous", classified_by: "rules", classification_reason: "no_intel_match", ai_action: "review", ...over,
});

describe("describeDetermination — mirrors the determination email", () => {
  it("is null while the report is pending or a follow-up", () => {
    expect(describeDetermination(row({ classification: "pending" }))).toBeNull();
    expect(describeDetermination(row({ classification: "follow_up" }))).toBeNull();
  });

  it("rules review → 'Needs human review' leading with the analyst step", () => {
    const d = describeDetermination(row({}))!;
    expect(d).toMatchObject({ label: "Needs human review", tone: "review", analyst_note: RULES_EMAIL_NOTE.review });
    expect(d.next_steps[0]).toBe(RULES_REVIEW_FIRST_STEP);
    expect(d.action_label).toBe("Queued for analyst review");
  });

  it("rules H1 and Workers AI phishing → 'Likely phishing', never 'confirmed'", () => {
    const h1 = describeDetermination(row({ classification: "phishing", classification_reason: "h1_likely_phishing:7,lure_account_locked", ai_action: "escalate" }))!;
    expect(h1).toMatchObject({ label: "Likely phishing", tone: "threat", analyst_note: RULES_EMAIL_NOTE.H1, action_label: "Reported to our threat team" });
    const wai = describeDetermination(row({ classification: "malware", classified_by: "workers_ai", classification_reason: "x", ai_action: "escalate" }))!;
    expect(wai.label).toBe("Likely malware");
  });

  it("an evidence rule says confirmed; an AI verdict uses the fixed AI note", () => {
    expect(describeDetermination(row({ classification: "phishing", classification_reason: "m1_intel_correlation:1", ai_action: "takedown" }))!.label).toBe("Phishing confirmed");
    const ai = describeDetermination(row({ classification: "phishing", classified_by: "ai", classification_reason: "model text", ai_action: "escalate" }))!;
    expect(ai.analyst_note).toBe(AI_EMAIL_NOTE.phishing);
    expect(JSON.stringify(ai)).not.toContain("model text");
  });
});
