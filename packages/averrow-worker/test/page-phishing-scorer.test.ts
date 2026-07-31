import { describe, it, expect } from "vitest";
import {
  scorePagePhishing,
  escalateThreatLevelForPage,
  SIGNAL_WEIGHTS,
  type ParsedPageSignals,
  type PageScoreContext,
} from "../src/lib/page-phishing-scorer";

// Empty baseline — nothing fires.
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
