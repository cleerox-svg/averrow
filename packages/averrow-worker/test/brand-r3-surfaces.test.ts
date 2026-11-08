/**
 * Facelift Phase 4 — the R3 mark goes live on the Worker's server-rendered
 * pages and emails (docs/brand/BRAND_BRIEF.md §9–§11).
 *
 * Pins:
 *   - templates/brand.ts geometry is byte-identical to docs/brand/logo/
 *     and to the shared kit's paths.ts (the Worker can't import the kit);
 *   - every changed page renders the R3 logo, no legacy "Deep Arrow" mark,
 *     no Google Fonts, and no amber (#E5A832) outside the status token;
 *   - every changed email uses the hosted R3 PNG, an indigo CTA with white
 *     text, and no amber CTA;
 *   - the CTA / link colour pairs clear WCAG AA (4.5:1).
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  R3_MARK_PATH, R3_WORDMARK_PATH, R3_MARK_RED, R3_TILE_FILL, EMAIL_LOGO_URL, FACELIFT, R3_FAVICON_DATA_URI,
  r3MarkSvg, r3WordmarkSvg,
} from "../src/templates/brand";
import { wrapPage } from "../src/templates/shared";
import { renderPrivacyPage } from "../src/templates/privacy";
import { renderTermsPage } from "../src/templates/terms";
import { renderHomepage } from "../src/templates/homepage";
import { renderNotFoundPage } from "../src/templates/not-found";
import { renderInviteAcceptPage, renderInviteErrorPage } from "../src/templates/invite-accept";
import { emailShell, headerStatusBadge, EMAIL_COLORS, EMAIL_CTA_STYLE } from "../src/lib/email-layout";
import { buildTenantDigestEmail } from "../src/lib/tenant-digest-email";
import { renderBriefingHtmlForPreview } from "../src/lib/briefing-email";
import { sendInviteEmail } from "../src/lib/invite-email";
import { sendMagicLinkEmail } from "../src/lib/magic-link-email";
import { sendLeadOutreachEmail } from "../src/lib/lead-outreach-email";
import { DEFAULT_ABUSE_BRANDING } from "../src/lib/abuse-mailbox-branding";
import { sendAck, sendDetermination } from "../src/lib/abuse-mailbox-responder";
import { buildContactEmail } from "../src/lib/contact-notify";
import { buildContentSecurityPolicy } from "../src/middleware/security";
import type { ComprehensiveBriefing } from "../src/handlers/briefing";

const REPO = resolve(__dirname, "../../..");
const LEGACY_MARK = "M16 5L26 26H18L16 21L14 26H6Z";
const LEGACY_EMAIL_LOGO = "logo-email-mark.png";

// ─── WCAG contrast ─────────────────────────────────────────────
function lum(hex: string): number {
  const n = hex.replace("#", "");
  const c = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}
function contrast(a: string, b: string): number {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

/** Every #E5A832 must sit on the `--amber:` status-token line. */
function amberOnlyAsStatusToken(html: string): string[] {
  return html.split("\n").filter((l) => /#E5A832/i.test(l) && !/--amber:\s*#E5A832/i.test(l));
}

describe("R3 geometry matches docs/brand/logo", () => {
  it("mark and wordmark paths are byte-identical to the SVG sources and the shared kit", () => {
    const markSvg = readFileSync(resolve(REPO, "docs/brand/logo/mark-red.svg"), "utf8");
    const wordSvg = readFileSync(resolve(REPO, "docs/brand/logo/wordmark-dark.svg"), "utf8");
    const appIcon = readFileSync(resolve(REPO, "docs/brand/logo/app-icon.svg"), "utf8");
    const kit = readFileSync(resolve(REPO, "packages/shared/src/ui/brand/paths.ts"), "utf8");
    expect(markSvg).toContain(`d="${R3_MARK_PATH}"`);
    expect(markSvg).toContain(`fill="${R3_MARK_RED}"`);
    expect(wordSvg).toContain(`d="${R3_WORDMARK_PATH}"`);
    expect(appIcon).toContain(`fill="${R3_TILE_FILL}"`);
    expect(kit).toContain(`'${R3_MARK_PATH}'`);
    expect(kit).toContain(`'${R3_WORDMARK_PATH}'`);
  });

  it("the inline favicon is byte-identical to docs/brand/logo/favicon.svg", () => {
    const src = readFileSync(resolve(REPO, "docs/brand/logo/favicon.svg"), "utf8").trim();
    expect(R3_FAVICON_DATA_URI.startsWith("data:image/svg+xml,")).toBe(true);
    expect(decodeURIComponent(R3_FAVICON_DATA_URI.slice("data:image/svg+xml,".length))).toBe(src);
  });

  it("renders tile and bare marks with the R3 marker", () => {
    expect(r3MarkSvg({ size: 32 })).toContain(`rx="7" fill="${R3_TILE_FILL}"`);
    expect(r3MarkSvg({ size: 32, tile: false })).toContain('viewBox="3.5 2 25 27.5"');
    expect(r3MarkSvg({ size: 8 })).toContain('width="16"'); // 16px minimum
    expect(r3WordmarkSvg(16)).toContain('fill="currentColor"');
  });
});

describe("server-rendered pages", () => {
  const pages: Array<[string, () => string]> = [
    ["wrapPage (status / incidents chrome)", () => wrapPage("T — Averrow", "d", "<main></main>")],
    ["privacy", renderPrivacyPage],
    ["terms", renderTermsPage],
    ["legacy homepage", () => renderHomepage()],
    ["404", renderNotFoundPage],
    ["invite accept", () => renderInviteAcceptPage({
      email: "a@b.example", role: "analyst", orgName: "Acme", authUrl: "https://averrow.com/auth", expiresAt: "2026-12-01T00:00:00Z",
    })],
    ["invite error", () => renderInviteErrorPage("Expired")],
  ];

  for (const [name, render] of pages) {
    it(`${name}: R3 logo, no legacy mark, no Google Fonts, no amber CTA`, () => {
      const html = render();
      expect(html).toContain('data-logo="r3"');
      expect(html).toContain(R3_MARK_PATH);
      expect(html).not.toContain(LEGACY_MARK);
      expect(html).not.toContain("fonts.googleapis.com");
      expect(html).not.toContain("fonts.gstatic.com");
      expect(html).not.toMatch(/rgba\(229, ?168, ?50/);
      expect(amberOnlyAsStatusToken(html)).toEqual([]);
    });
  }

  it("shared chrome uses indigo for the primary and graphite for the dark page", () => {
    const html = wrapPage("T", "d", "");
    expect(html).toContain("--accent: #4c5cf8;");
    expect(html).toContain("--primary-text: #96acff;");
    expect(html).toContain("--accent: #3250f0;");     // light
    expect(html).toContain("--bg-primary: #0a0b0e;"); // graphite
    expect(html).not.toContain("/favicon.svg?v=2");    // frozen legacy favicon
    expect(html).toContain('rel="icon" href="data:image/svg+xml,');
    // Amber is only the status token, never painted as a primary.
    expect(html).not.toMatch(/(?<![-\w])var\(--amber\)/);
  });

  it("404 opens dark and resolves the shared 'averrow-theme' key before paint", () => {
    const html = renderNotFoundPage();
    expect(html).toContain('<html lang="en" data-theme="dark">');
    const head = html.slice(0, html.indexOf("</head>"));
    expect(head).toContain("localStorage.getItem('averrow-theme')");
    expect(head.indexOf("averrow-theme")).toBeLessThan(head.indexOf("<style>"));
    expect(html).not.toContain("av-theme'");
    // Same script as the wrapPage pages.
    const shared = wrapPage("T", "d", "");
    const script = (h: string) => h.slice(h.indexOf("<script>"), h.indexOf("</script>"));
    expect(script(head)).toBe(script(shared));
  });

  it("shared chrome links the R3 apple-touch icon and has one footer mark", () => {
    const html = wrapPage("T", "d", "");
    expect(html).toContain('<link rel="apple-touch-icon" href="/v2/apple-touch-icon.png">');
    expect(html).not.toContain("footer-orbital-mark");
    expect(existsSync(resolve(REPO, "packages/averrow-ops/public/apple-touch-icon.png"))).toBe(true);
  });

  it("invite accept CTA is indigo with white text", () => {
    const html = renderInviteAcceptPage({
      email: "a@b.example", role: "analyst", authUrl: "https://averrow.com/auth", expiresAt: "2026-12-01T00:00:00Z",
    });
    expect(html).toMatch(/background: #4c5cf8;\s*color: #ffffff;/);
  });
});

describe("emails", () => {
  afterEach(() => vi.restoreAllMocks());

  function captureResend(): Array<{ html: string; subject: string }> {
    const sent: Array<{ html: string; subject: string }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      sent.push(JSON.parse(String((init as RequestInit).body)) as { html: string; subject: string });
      return new Response(JSON.stringify({ id: "re_1" }), { status: 200 });
    });
    return sent;
  }

  function expectR3Email(html: string): void {
    expect(html).toContain(EMAIL_LOGO_URL);
    expect(html).not.toContain(LEGACY_EMAIL_LOGO);
    expect(html).not.toMatch(/linear-gradient\(180deg,\s*#E5A832/i);
    // No CTA (a link styled as a button) is filled amber. Amber status
    // dots / badges are allowed.
    for (const a of html.match(/<a\b[^>]*>/g) ?? []) {
      expect(a).not.toMatch(/background(-color)?:\s*#E5A832/i);
    }
  }

  it("the hosted logo is a 144x144 PNG shipped in the ops public dir (built to /v2/email/, served via /email/)", () => {
    const file = resolve(REPO, "packages/averrow-ops/public/email/averrow-mark-r3.png");
    expect(existsSync(file)).toBe(true);
    const buf = readFileSync(file);
    expect(buf.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(buf.readUInt32BE(16)).toBe(144);
    expect(buf.readUInt32BE(20)).toBe(144);
    expect(EMAIL_LOGO_URL).toBe("https://averrow.com/email/averrow-mark-r3.png");
  });

  it("emailShell: R3 logo, indigo accent by default, graphite surfaces", () => {
    const html = emailShell({ title: "t", preheader: "p", body: "<tr><td>x</td></tr>" });
    expectR3Email(html);
    expect(html).toContain(`background:${EMAIL_COLORS.primary}`);
    expect(html).toContain("#151619");
    expect(html).not.toContain("#E5A832");
  });

  it("the warn status badge keeps amber (status colour)", () => {
    expect(headerStatusBadge("DEGRADED", "warn")).toContain("#E5A832");
  });

  it("invite + magic-link: indigo CTA with white text, R3 logo", async () => {
    const sent = captureResend();
    await sendInviteEmail("re_test", {
      recipientEmail: "a@b.example", orgName: "Acme", role: "analyst", invitedByName: "Averrow SOC",
      acceptUrl: "https://averrow.com/invite?token=x", expiresAt: "2026-12-01T00:00:00Z",
    });
    await sendMagicLinkEmail("re_test", {
      recipientEmail: "a@b.example", signInUrl: "https://averrow.com/m?t=x", ipAddress: null, userAgent: null,
    });
    expect(sent).toHaveLength(2);
    for (const { html } of sent) {
      expectR3Email(html);
      expect(html).toContain("background-color:#4c5cf8;background:#4c5cf8;color:#FFFFFF;");
      expect(html).not.toContain("#E5A832");
    }
    // Subjects unchanged.
    expect(sent[0]!.subject).toBe("You've been invited to join Acme on Averrow");
    expect(sent[1]!.subject).toBe("Your Averrow sign-in link");
  });

  it("lead outreach (light email): R3 logo, indigo CTA, no amber", async () => {
    const sent = captureResend();
    await sendLeadOutreachEmail("re_test", {
      recipientEmail: "a@b.example", recipientName: null, senderName: null, brandName: "Acme",
      brandDomain: "acme.example", riskGrade: "HIGH", keyFindings: ["x"],
      qualifiedReportUrl: "https://averrow.com/r/x", unsubscribeUrl: "https://averrow.com/u/x",
    } as unknown as Parameters<typeof sendLeadOutreachEmail>[1]);
    expectR3Email(sent[0]!.html);
    expect(sent[0]!.html).toContain("background-color:#3250f0;background:#3250f0;color:#FFFFFF;");
    expect(sent[0]!.html).not.toContain("#E5A832");
  });

  it("tenant digest + briefing go through the R3 shell with no amber CTA", () => {
    const digest = buildTenantDigestEmail({
      orgName: "Acme", weekStartIso: "2026-11-01", weekEndIso: "2026-11-07",
      brands: [], takedowns: { submitted: 0, completed: 0, pending: 0 },
    } as unknown as Parameters<typeof buildTenantDigestEmail>[0]);
    expectR3Email(digest.html);
    expect(digest.html).not.toContain("#E5A832");

    const html = renderBriefingHtmlForPreview(emptyBriefing(), "Daily Operations Briefing");
    expectR3Email(html);
    expect(html).toContain("background-color:#4c5cf8;background:#4c5cf8;color:#FFFFFF;");
  });

  it("contact notification eyebrow is indigo; the unverified warning stays amber-toned", () => {
    const { html } = buildContactEmail(
      { id: "c1", name: "N", email: "n@b.example", company: null, interest: null, domain: null, message: "hi" } as unknown as Parameters<typeof buildContactEmail>[0],
      { links: [], scanned: 0 } as unknown as Parameters<typeof buildContactEmail>[1],
    );
    expect(html).not.toContain("#E5A832");
    expect(html).toContain("color:#2a44d3");
  });

  it("abuse ack + determination honour an org accent override (echo border, inbox alias, strip)", async () => {
    const sent = captureResend();
    const env = {
      RESEND_API_KEY: "re_test",
      DB: { prepare: () => ({ bind: () => ({ first: async () => null }) }) },
    } as unknown as import("../src/types").Env;
    const branding = { ...DEFAULT_ABUSE_BRANDING, accent: "#12AB34", headerBg: "#202122" };
    const ack = await sendAck(env, "reporter@example.org", {
      messageId: "11111111-2222-3333-4444-555555555555", originalSubject: "Your account is locked", inboundAlias: "phishing@averrow.ca",
    }, branding);
    expect(ack.ok).toBe(true);
    const html = sent[0]!.html;
    expect(html).toContain("border-left:3px solid #12AB34;");
    expect(html).toMatch(/color:#12AB34;">phishing@averrow\.ca</);
    expect(html).toContain(".av-accent-line  { background:#12AB34 !important; }");
    expect(html).toContain("background:#202122");
    expect(html).not.toContain("#E5A832");
    expectR3Email(html);

    await sendDetermination(env, "reporter@example.org", {
      messageId: "11111111-2222-3333-4444-555555555555", inboundAlias: "phishing@averrow.ca",
      originalSubject: "Your account is locked", classification: "phishing", confidence: 66,
      action: "escalate", classifiedBy: "rules", rulesRule: "H1",
    } as unknown as Parameters<typeof sendDetermination>[2], branding);
    const det = sent[1]!.html;
    expectR3Email(det);
    expect(det).toContain("background:#202122");

    // Default branding: indigo strip + AA tagline tint.
    await sendAck(env, "reporter@example.org", {
      messageId: "22222222-2222-3333-4444-555555555555", originalSubject: null, inboundAlias: "abuse@averrow.ca",
    });
    expect(sent[2]!.html).toContain(".av-accent-line  { background:#4c5cf8 !important; }");
    expect(sent[2]!.html).toMatch(/color:#96acff;font-weight:700;[^"]*">Abuse Triage</);
  });

  it("abuse responder default branding is R3 + indigo on graphite", () => {
    expect(DEFAULT_ABUSE_BRANDING.logoUrl).toBe(EMAIL_LOGO_URL);
    expect(DEFAULT_ABUSE_BRANDING.accent).toBe("#4c5cf8");
    expect(DEFAULT_ABUSE_BRANDING.headerBg).toBe("#151619");
  });

  it("CTA style constant is indigo + white", () => {
    expect(EMAIL_CTA_STYLE).toContain(`background:${FACELIFT.primary}`);
    expect(EMAIL_CTA_STYLE).toContain("color:#FFFFFF");
  });
});

describe("contrast (WCAG AA 4.5:1)", () => {
  it.each([
    ["white on dark primary #4c5cf8", "#ffffff", FACELIFT.primary],
    ["white on light primary #3250f0", "#ffffff", FACELIFT.primaryLight],
    ["primary text #96acff on graphite card", FACELIFT.primaryText, FACELIFT.bgCard],
    ["primary text #96acff on graphite page", FACELIFT.primaryText, FACELIFT.bgPage],
    ["light primary text #2a44d3 on white", FACELIFT.primaryTextLight, "#ffffff"],
    ["light primary text #2a44d3 on light page", FACELIFT.primaryTextLight, FACELIFT.bgPageLight],
    ["#4c5cf8 link on the white abuse-email body", FACELIFT.primary, "#ffffff"],
  ])("%s", (_label, fg, bg) => {
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("CSP", () => {
  // Google Fonts stay allowed: the honeypot pages (src/honeypot.ts) still
  // load them by design, and the FACELIFT=false revert path of the ops
  // index.html (served through the Worker on /v2 deep links) does too.
  it("still allows Google Fonts for the pages that need them", () => {
    const csp = buildContentSecurityPolicy("/status");
    expect(csp).toContain("https://fonts.googleapis.com");
    expect(csp).toContain("https://fonts.gstatic.com");
  });
});

function emptyBriefing(): ComprehensiveBriefing {
  return {
    platformOverview: { totalThreats: 0, last24h: 0, last12h: 0, avgPerHour: 0, brandsMonitored: 0, brandsClassified: 0, todayCount: 0, yesterdayCount: 0 },
    newThreats: { bySeverity: [], bySource: [], notable: [] },
    feedProduction: [],
    feedHealth: { feeds: [], summary: [], staleFeeds: [], degradedFeeds: [] },
    enrichment: { surbl_checked: 0, surbl_hits: 0, vt_checked: 0, vt_hits: 0, gsb_checked: 0, gsb_hits: 0, dbl_checked: 0, dbl_hits: 0, abuse_checked: 0, abuse_hits: 0, gn_checked: 0, sec_checked: 0 },
    flightController: { summary: null, created_at: null },
    agentActivity: [],
    newCapabilities: { typosquat_total: 0, typosquat_new: 0, social_total: 0, social_new: 0, certstream: 0, appstore_total: 0, appstore_new: 0, darkweb_total: 0, darkweb_new: 0 },
    spamTrap: { totalSeeds: 0, totalCaptures: 0, captures12h: 0, latestCaptures: [], seedingSources: [] },
    honeypot: { totalVisits: 0, botVisits: 0, humanVisits: 0, visits12h: 0, pageBreakdown: [], pageBreakdownTotal: 0, recentBots: [], suspiciousHumans: [] },
    marketingVisibility: { windowHours: 24, humanViews: 0, aiCrawlerViews: 0, otherBotViews: 0, aiReferralSessions: 0, ctaClicks: 0, contactSubs: 0, topPages: [], aiCrawlerBreakdown: [], aiReferralBySource: [] },
    topTargetedBrands: [],
    brandCoverage: [],
    geopoliticalCampaigns: [],
    generatedAt: "2026-11-08T13:13:00Z",
    statusBadge: "OPERATIONAL",
  };
}
