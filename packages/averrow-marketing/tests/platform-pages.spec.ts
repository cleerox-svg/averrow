import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/*
 * Section 8 (Platform pages), phase 1: the product-page kit
 * (src/components/product/), /platform, /platform/lookalike-domains,
 * /platform/takedowns, the three retired-URL redirects, and the moved pages.
 *
 * What is guarded here:
 *  - the new pages render with the CTA pair ("Scan your domain" -> /scan,
 *    "Book a demo" -> /demo) in the hero and the closing block;
 *  - retired URLs redirect (the Cloudflare rules in public/_redirects, and the
 *    meta-refresh stub that keeps working under astro preview), keeping the
 *    tenant app's #setup fragment;
 *  - no horizontal scroll at 390px, both themes, with every <details> open;
 *  - steps and scope collapse to <details> below 640px and are a grid/table above;
 *  - ProofStrip never shows an undated or static number;
 *  - disclosure guard words, fictional-domains-only, minimum text size and AA
 *    contrast on the kit's text in both themes.
 *
 * Each test pins its own viewport (the kit renders a desktop and a mobile
 * layout and hides one with CSS), so it works under both Playwright projects.
 */

const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stats = JSON.parse(fs.readFileSync(path.join(ROOT, "src/data/stats.json"), "utf8")) as {
  threats_detected: string;
  providers_mapped: string;
  generated_at: string;
  proof: { operations_tracked?: string; monitored_brands?: string };
  fallbacks: { lookalikes_found_30d: string };
};

/** Pages built from the kit in phase 1. */
const KIT_PAGES = [
  { path: "/platform", h1: /every place your brand is impersonated/i, crumb: false, plan: null as string | null },
  { path: "/platform/lookalike-domains", h1: /know when someone registers your name/i, crumb: true, plan: "Professional+" },
  { path: "/platform/takedowns", h1: /you set the rules\. we do the filing\./i, crumb: true, plan: "Professional+" },
  { path: "/platform/email-security", h1: /know your email grade before an attacker does/i, crumb: true, plan: "Professional+" },
  { path: "/platform/abuse-mailbox", h1: /one address to report suspicious email/i, crumb: true, plan: "Enterprise" },
  // Phase 2A.
  { path: "/platform/impersonation", h1: /find the accounts pretending to be you/i, crumb: true, plan: "Professional+" },
  { path: "/platform/threat-detection", h1: /hear it from us before your customers do/i, crumb: true, plan: null as string | null },
  { path: "/platform/campaign-intelligence", h1: /see the operation, not just the symptom/i, crumb: true, plan: "Enterprise" },
];
/** Pages moved or renamed in phase 1 (content is rewritten in phase 2). */
const MOVED_PAGES: string[] = [];

async function setTheme(page: Page, theme: "dark" | "light") {
  await page.addInitScript((t) => {
    try {
      localStorage.setItem("averrow-theme", t);
    } catch {
      /* private mode */
    }
  }, theme);
}

async function open(page: Page, p: string, theme: "dark" | "light" = "dark") {
  await setTheme(page, theme);
  await page.route("**/api/v1/public/stats", (route) => route.abort());
  const res = await page.goto(p);
  expect(res?.status(), `${p} status`).toBeLessThan(400);
}

// ── render + CTA pair ───────────────────────────────────────────────────

test.describe("kit pages render with the CTA pair", () => {
  test.use({ viewport: DESKTOP });

  for (const pg of KIT_PAGES) {
    test(pg.path, async ({ page }) => {
      await open(page, pg.path);
      await expect(page).toHaveTitle(/— Averrow$/);
      await expect(page.locator("h1")).toHaveCount(1);
      await expect(page.locator("h1")).toHaveText(pg.h1);

      // Hero + closing block each carry the pair; labels and targets are fixed.
      const pairs = page.locator("#content [data-cta-pair]");
      expect(await pairs.count()).toBeGreaterThanOrEqual(2);
      for (let i = 0; i < (await pairs.count()); i++) {
        const scan = pairs.nth(i).getByRole("link", { name: "Scan your domain" });
        const demo = pairs.nth(i).getByRole("link", { name: "Book a demo" });
        await expect(scan).toHaveAttribute("href", /\/scan$/);
        await expect(scan).toHaveClass(/btn-primary/);
        await expect(demo).toHaveAttribute("href", /\/demo$/);
        await expect(demo).toHaveClass(/btn-outline/);
      }
      await expect(page.locator(".ph [data-cta-pair]")).toHaveCount(1);
      await expect(page.locator(".pc [data-cta-pair]")).toHaveCount(1);

      // Breadcrumb on deep dives only; plan tag from coverage.ts.
      await expect(page.locator(".pp-crumb")).toHaveCount(pg.crumb ? 1 : 0);
      if (pg.plan) await expect(page.locator(".ph-plan")).toHaveText(pg.plan);
      else await expect(page.locator(".ph-plan")).toHaveCount(0);
    });
  }

  for (const p of MOVED_PAGES) {
    test(`${p} still loads (content is phase 2)`, async ({ page }) => {
      await open(page, p);
      await expect(page).toHaveTitle(/— Averrow$/);
      await expect(page.locator("h1").first()).toBeVisible();
    });
  }

  test("/platform shows all eight surfaces with plan labels, each linking somewhere real", async ({ page }) => {
    await open(page, "/platform");
    const tiles = page.locator("#coverage .cv-grid > li");
    await expect(tiles).toHaveCount(8);
    const hrefs = await tiles.locator(".cv-tn a").evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).getAttribute("href")));
    expect(hrefs.length).toBeGreaterThanOrEqual(7);
    for (const h of hrefs) {
      const res = await page.request.get((h ?? "").split("#")[0]);
      expect(res.status(), `tile link ${h}`).toBe(200);
    }
    await expect(page.locator("#coverage .cv-t").first().locator(".cv-pl")).toHaveText("Professional+");
    // The lookalike count is carried by the dated ProofStrip, not the tile.
    await expect(page.locator("#coverage .cv-proof")).toHaveCount(0);
  });

  test("/platform#how-it-works carries the six stages and the situation rating", async ({ page }) => {
    await open(page, "/platform");
    const how = page.locator("#how-it-works");
    await expect(how.locator(".pv-stage")).toHaveCount(6);
    await expect(how).toContainText(/rated .* as one/i);
    await expect(how).toContainText(/rule-based|deterministic rules/i);
    // Operations are labelled as an Enterprise capability.
    await expect(how.locator(".pv-stage", { hasText: "Infrastructure correlation" }).locator(".pv-plan")).toHaveText("Enterprise");
  });

  test("/platform integrations: one status vocabulary, no customer email delivery claim", async ({ page }) => {
    await open(page, "/platform");
    const int = page.locator("#integrations");
    const statuses = await int.locator("li em").allTextContents();
    expect(statuses.length).toBeGreaterThanOrEqual(6);
    for (const s of statuses) expect(["Business and Enterprise", "On request", "Roadmap"]).toContain(s.trim());
    await expect(int.locator("li", { hasText: "STIX 2.1" }).locator("em")).toHaveText("On request");
    await expect(int).not.toContainText(/\blive\b/i);
    await expect(int).not.toContainText(/email/i);
    await expect(int).not.toContainText(/real-time|self-serve|streamed/i);
  });

  test("/platform/takedowns: policy modes, statuses and the shared flow", async ({ page }) => {
    await open(page, "/platform/takedowns");
    await expect(page.locator("#automation .td-mode")).toHaveCount(3);
    await expect(page.locator("#automation")).toContainText("Takedowns outside your rules wait until someone on your team approves them.");
    await expect(page.locator("#authorization")).toContainText(/can't file without it/i);
    const names = await page.locator("#statuses .td-flow li b, #statuses .td-end li b").allTextContents();
    expect(names.map((n) => n.trim())).toEqual(["Draft", "Requested", "Submitted", "Pending response", "Taken down", "Failed", "Expired", "Withdrawn"]);
    // TakedownFlow reused, with this page's mode names and no self-link.
    await expect(page.locator("#takedown-flow")).toHaveCount(1);
    await expect(page.getByRole("radio", { name: "Semi-auto" })).toHaveAttribute("aria-checked", "true");
    await expect(page.locator('#takedown-flow a[data-cta="takedownflow-how"]')).toHaveCount(0);
  });

  test("/platform/lookalike-domains: approved sample, three steps, scope with a not-covered column", async ({ page }) => {
    await open(page, "/platform/lookalike-domains");
    const sample = page.locator(".ph .sf");
    await expect(sample.locator(".sf-tag")).toHaveText("Illustrative");
    const rows = await sample.locator(".sr-r").allInnerTexts();
    expect(rows.join("\n")).toMatch(/acme-secure-login\.example[\s\S]*High[\s\S]*Registered yesterday, serving a login page/);
    expect(rows.join("\n")).toMatch(/acrne\.example[\s\S]*Medium[\s\S]*Mail server added/);
    expect(rows.join("\n")).toMatch(/acme-pay\.example[\s\S]*Low[\s\S]*Parked/);
    await expect(sample.locator(".sf-f")).toHaveText("Takedown drafted, waiting for your approval");
    await expect(page.locator(".sl-grid > li")).toHaveCount(3);
    await expect(page.locator(".sl-grid h3")).toHaveText(["Generate", "Watch", "Act"]);
    await expect(page.locator("#certificates")).toContainText("every hour");
    await expect(page.locator(".st-table thead th")).toHaveText([/^Area$/, /^\+Covered$/, /^.Not covered$/]);
    // Honest limit: never promise every variant within a day.
    await expect(page.locator(".st-table")).toContainText("A promise that every generated variant is checked within a day.");
  });
});

// ── phase 2A pages: impersonation, threat detection, campaign intelligence ──

/** Phrases that must never appear on these pages (docs/DISCLOSURE_REGISTER.md L24-L34). */
const PHASE_2A_BANNED: RegExp[] = [
  /notices? when|know when it moves|alert you when an operation/i,
  /evidence package/i,
  /display name/i,
  /\blogos?\b/i,
  /registrar|registration (?:pattern|detail)/i,
  /open phishing-feed|community feed/i,
  /24\/7/,
  /capability 0\d/i,
  /de-?duplicat/i,
  /infrastructure rows/i,
  /homoglyph|tld swap/i,
  /watch(?:ing)? the stream/i,
  /\bregistered \d+ (?:hours?|days?) ago/i,
];

test.describe("phase 2A pages: structure and banned claims", () => {
  test.use({ viewport: DESKTOP });

  for (const p of ["/platform/impersonation", "/platform/threat-detection", "/platform/campaign-intelligence"]) {
    test(`${p}: CTA pair, one hero sample, scope table, no banned phrases`, async ({ page }) => {
      await open(page, p);
      await expect(page.locator(".ph [data-cta-pair]")).toHaveCount(1);
      await expect(page.locator(".pc [data-cta-pair]")).toHaveCount(1);
      await expect(page.locator(".ph .sf")).toHaveCount(1);
      await expect(page.locator(".ph .sf .sf-tag")).toHaveText("Illustrative");
      await expect(page.locator(".st-table thead th")).toHaveText([/^Area$/, /^\+Covered$/, /^.Not covered$/]);
      const text = (await page.locator(".pp").textContent()) ?? "";
      for (const re of PHASE_2A_BANNED) expect(text, `${p} matched ${re}`).not.toMatch(re);
      // "40+ sources" is allowed once, and nowhere on the proof strip.
      expect((text.match(/40\+/g) ?? []).length).toBeLessThanOrEqual(1);
      // No pricing.
      expect(text).not.toMatch(/\$\s?\d|per month|\/mo\b/i);
    });
  }

  test("/platform/impersonation: six networks, four anchored sections, executive limits", async ({ page }) => {
    await open(page, "/platform/impersonation");
    await expect(page.locator("#fake-profiles .imp-nets li")).toHaveText(["X", "LinkedIn", "Instagram", "TikTok", "GitHub", "YouTube"]);
    for (const id of ["fake-profiles", "executives", "app-stores", "trademark", "scope"]) {
      await expect(page.locator(`section#${id}`), `#${id}`).toHaveCount(1);
    }
    const exec = page.locator("#executives");
    for (const n of ["X", "Instagram", "TikTok", "GitHub", "YouTube"]) await expect(exec).toContainText(n);
    await expect(exec).not.toContainText(/linkedin/i);
    await expect(exec).not.toContainText(/paste|leak/i);
    await expect(exec).toContainText(/no photo or biometric data/i);
    await expect(page.locator("#fake-profiles")).toContainText(/no photo, bio or follower analysis/i);
    await expect(page.locator("#app-stores")).toContainText(/Apple App Store only/);
    await expect(page.locator("#app-stores")).not.toContainText(/google play[^.]*\b(?:covered|monitored)\b(?!\.)/i);
    await expect(page.locator("#trademark")).toContainText(/no new detection source/i);
    // No ✓ tick table survives.
    await expect(page.locator(".pp table:not(.st-table)")).toHaveCount(0);
    expect(((await page.locator(".pp").textContent()) ?? "")).not.toMatch(/[\u2713\u2714]/);
  });

  test("/platform/threat-detection: about five sections, no feed table, links to lookalikes, hourly certificates", async ({ page }) => {
    await open(page, "/platform/threat-detection");
    expect(await page.locator(".pp .ps-sec").count()).toBeLessThanOrEqual(6);
    await expect(page.locator(".pp table:not(.st-table)")).toHaveCount(0);
    await expect(page.locator("#feeds")).toContainText("40+");
    await expect(page.locator("#certificates")).toContainText("every hour");
    await expect(page.locator("#certificates a[href$='/platform/lookalike-domains']")).toHaveCount(1);
    await expect(page.locator("#dark-web")).toContainText(/paste sites and ransomware victim lists/i);
    // Sample sits in the hero and shows a certificate time, not a registration age.
    const hero = page.locator(".ph .sf");
    await expect(hero).toContainText("Certificate");
    await expect(hero).toContainText("Issued 36 hours ago");
    await expect(hero).not.toContainText(/registered/i);
    // No static stats: the numbers come from the dated strip only.
    await expect(page.locator(".ph")).not.toContainText(/\b40\+|24\/7/);
  });

  test("/platform/campaign-intelligence: accessible cluster graph, takedown consent line", async ({ page }) => {
    await open(page, "/platform/campaign-intelligence");
    const svg = page.locator(".ph svg[role='img']");
    await expect(svg).toHaveCount(1);
    const labelled = (await svg.getAttribute("aria-labelledby")) ?? "";
    expect(labelled.split(" ").length).toBe(2);
    for (const id of labelled.split(" ")) expect(await svg.locator(`#${id}`).textContent(), `#${id}`).toMatch(/\S/);
    await expect(page.locator(".ph .cmp-fig figcaption")).toContainText(/shared certificate and shared hosting/i);
    await expect(svg).toContainText("Shared");
    await expect(page.locator(".ph .sf")).toContainText("One operation");
    await expect(page.locator("#takedowns")).toContainText("Nothing is filed without your approval or your signed rules");
    await expect(page.locator("#takedowns")).toContainText(/revoke the authorization/i);
    // Only domain and IP threats are linked; the page says so.
    await expect(page.locator("#scope")).toContainText(/social accounts, apps, leak-site mentions and executive findings/i);
  });

  test("anchors named in coverage.ts exist", async ({ page }) => {
    for (const [p, ids] of [
      ["/platform/impersonation", ["fake-profiles", "executives", "app-stores", "trademark"]],
      ["/platform/threat-detection", ["dark-web", "certificates"]],
    ] as const) {
      await open(page, p);
      for (const id of ids) await expect(page.locator(`#${id}`), `${p}#${id}`).toHaveCount(1);
    }
  });
});

// ── redirects ───────────────────────────────────────────────────────────

const REDIRECTS: Array<[string, string]> = [
  ["/platform/ai-agents", "/platform#how-it-works"],
  ["/platform/social-monitoring", "/platform/impersonation"],
  ["/abuse-mailbox", "/platform/abuse-mailbox"],
];

test.describe("redirects", () => {
  test("public/_redirects maps each retired URL with a 301 (what Cloudflare serves)", () => {
    const rules = fs
      .readFileSync(path.join(ROOT, "public/_redirects"), "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => l.split(/\s+/));
    for (const [from, to] of REDIRECTS) {
      for (const f of [from, `${from}/`]) {
        const rule = rules.find((r) => r[0] === f);
        expect(rule, `rule for ${f}`).toBeTruthy();
        expect(rule?.[1]).toBe(to);
        expect(rule?.[2]).toBe("301");
      }
    }
  });

  for (const [from, to] of REDIRECTS) {
    test(`${from} lands on ${to}`, async ({ page }) => {
      await page.goto(from);
      await page.waitForURL((u) => `${u.pathname}${u.hash}` === to || `${u.pathname}${u.hash}` === `${to}/`.replace("#", "/#"));
      expect(new URL(page.url()).pathname + new URL(page.url()).hash).toBe(to);
    });
  }

  test("/abuse-mailbox#setup keeps the fragment (tenant app deep link) and lands on the setup section", async ({ page }) => {
    await page.goto("/abuse-mailbox#setup");
    await page.waitForURL(/\/platform\/abuse-mailbox#setup$/);
    await expect(page.locator("#setup")).toHaveCount(1);
  });

  test("the stubs are noindex, canonical to the destination, and not in the sitemap", async ({ request }) => {
    for (const [from, to] of REDIRECTS) {
      const html = await (await request.get(from)).text();
      expect(html).toContain('name="robots" content="noindex"');
      expect(html).toContain(`url=${to}`);
      expect(html).toMatch(new RegExp(`rel="canonical" href="https://averrow\\.com${to.split("#")[0]}"`));
    }
    const map = await (await request.get("/sitemap.xml")).text();
    expect(map).not.toContain("/platform/ai-agents<");
    expect(map).not.toContain("/platform/social-monitoring<");
    expect(map).not.toContain("https://averrow.com/abuse-mailbox<");
  });

  test("no internal link on the built pages points at a retired URL", async ({ page, request }) => {
    for (const p of ["/", "/platform", "/platform/lookalike-domains", "/platform/takedowns", "/platform/impersonation", "/platform/abuse-mailbox", "/pricing", "/docs"]) {
      const html = await (await request.get(p)).text();
      for (const old of ['href="/platform/ai-agents', 'href="/platform/social-monitoring', 'href="/abuse-mailbox']) {
        expect(html, `${p} links to ${old}`).not.toContain(old);
      }
    }
    void page;
  });
});

// ── nav + footer ────────────────────────────────────────────────────────

test.describe("nav and footer list the eight platform pages", () => {
  test.use({ viewport: DESKTOP });
  const EXPECTED = [
    "/platform",
    "/platform/lookalike-domains",
    "/platform/impersonation",
    "/platform/threat-detection",
    "/platform/email-security",
    "/platform/takedowns",
    "/platform/abuse-mailbox",
    "/platform/campaign-intelligence",
  ];

  test("Platform dropdown", async ({ page }) => {
    await open(page, "/");
    const hrefs = await page.locator(".nav-item:has(> .nav-link[data-path='/platform']) .nav-menu a").evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).getAttribute("href")));
    expect(hrefs).toEqual(EXPECTED);
  });

  test("footer Platform column", async ({ page }) => {
    await open(page, "/");
    const col = page.locator(".footer-col", { has: page.locator(".footer-col-title", { hasText: /^Platform$/ }) });
    const hrefs = await col.locator("a").evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).getAttribute("href")));
    expect(hrefs).toEqual(EXPECTED);
  });

  test("Platform hub lights up on every platform page", async ({ page }) => {
    for (const p of EXPECTED) {
      await open(page, p);
      await expect(page.locator(".nav-link.is-active")).toHaveAttribute("data-path", "/platform");
    }
  });
});

// ── layout: mobile collapse, no horizontal scroll ───────────────────────

test.describe("mobile (390px)", () => {
  test.use({ viewport: PHONE });

  for (const theme of ["dark", "light"] as const) {
    for (const p of [...KIT_PAGES.map((k) => k.path), ...MOVED_PAGES]) {
      test(`no horizontal scroll, ${theme}: ${p}`, async ({ page }) => {
        await open(page, p, theme);
        await page.waitForLoadState("networkidle").catch(() => {});
        // Open every disclosure: the expanded state is the widest.
        await page.evaluate(() => document.querySelectorAll("details").forEach((d) => d.setAttribute("open", "")));
        const m = await page.evaluate(() => ({
          doc: document.documentElement.scrollWidth,
          body: document.body.scrollWidth,
          vw: window.innerWidth,
        }));
        expect(Math.max(m.doc, m.body), `${p} scrollWidth vs viewport ${m.vw}`).toBeLessThanOrEqual(m.vw);
      });
    }
  }

  test("steps and scope collapse into <details>, the grid and table are hidden", async ({ page }) => {
    await open(page, "/platform/lookalike-domains");
    await expect(page.locator(".sl-grid")).toBeHidden();
    await expect(page.locator(".st-table")).toBeHidden();
    const steps = page.locator(".sl-list details");
    await expect(steps).toHaveCount(3);
    await expect(steps.nth(0)).toHaveAttribute("open", "");
    await expect(steps.nth(1)).not.toHaveAttribute("open", /.*/);
    await expect(steps.nth(1).locator(".sl-db")).toBeHidden();
    await steps.nth(1).locator("summary").click();
    await expect(steps.nth(1).locator(".sl-db")).toBeVisible();
    const scope = page.locator(".st-list details");
    expect(await scope.count()).toBeGreaterThanOrEqual(6);
    await scope.first().locator("summary").click();
    await expect(scope.first().locator("dd").first()).toBeVisible();
  });
});

test("desktop (1280px): steps are a three-column grid and scope is a table", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await open(page, "/platform/lookalike-domains");
  await expect(page.locator(".sl-grid")).toBeVisible();
  await expect(page.locator(".sl-list")).toBeHidden();
  await expect(page.locator(".st-table")).toBeVisible();
  await expect(page.locator(".st-list")).toBeHidden();
  const cols = await page.locator(".sl-grid").evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);
  expect(cols).toBe(3);
});

// ── ProofStrip ──────────────────────────────────────────────────────────

test.describe("ProofStrip", () => {
  test.use({ viewport: DESKTOP });

  const expectedLabels = new Set(
    [stats.threats_detected, stats.providers_mapped, stats.proof.operations_tracked, stats.proof.monitored_brands, stats.fallbacks.lookalikes_found_30d].filter(
      (v): v is string => typeof v === "string",
    ),
  );

  for (const p of ["/platform", "/platform/lookalike-domains", "/platform/threat-detection", "/platform/campaign-intelligence"]) {
    test(`${p}: every number is dated and comes from stats.json`, async ({ page }) => {
      await open(page, p);
      const strip = page.locator("[data-proof-strip]");
      await expect(strip).toHaveCount(1);
      const time = strip.locator("time");
      await expect(time).toHaveCount(1);
      const iso = (await time.getAttribute("datetime")) ?? "";
      expect(Number.isNaN(Date.parse(iso)), `datetime ${iso}`).toBe(false);
      expect(iso).toBe(stats.generated_at);
      await expect(time).toHaveText(/^As of \d{1,2} [A-Z][a-z]{2} \d{4}$/);

      const values = (await strip.locator("dd").allTextContents()).map((v) => v.trim());
      expect(values.length).toBeGreaterThan(0);
      for (const v of values) {
        // Either a published snapshot label or a live-rounded lookalike count ("2,400+").
        expect(expectedLabels.has(v) || /^\d{1,3}(,\d{3})*\+$/.test(v), `unexpected figure "${v}"`).toBe(true);
      }
      // Never static marketing numbers.
      const text = (await strip.innerText()).replace(/\s+/g, " ");
      expect(text).not.toMatch(/\b40\+|24\/7|<\s*5\s*min/i);
      // The strip is the only place these page-level figures appear undecorated.
      for (const dt of await strip.locator("dt").allTextContents()) expect(dt).not.toMatch(/newly registered/i);
    });
  }

  test("/platform/takedowns: no strip (no speed or success numbers, owner decision)", async ({ page }) => {
    await open(page, "/platform/takedowns");
    await expect(page.locator("[data-proof-strip]")).toHaveCount(0);
    const text = (await page.locator(".pp").innerText()).toLowerCase();
    expect(text).not.toMatch(/\d\s*%/);
    expect(text).not.toMatch(/\bmedian\b|\bminutes\b|\bhours\b|success rate of|% of takedowns/);
  });

  test("the strip renders nothing when it has no dated value to show", async () => {
    // Source-level guard: ProofStrip must gate on both a value and a date and
    // must not carry literal figures of its own.
    const src = fs.readFileSync(path.join(ROOT, "src/components/product/ProofStrip.astro"), "utf8");
    expect(src).toMatch(/items\.length > 0 && !!stamp/);
    const code = (src.split(/^---$/m)[1] ?? "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code.length).toBeGreaterThan(200);
    expect(code).not.toMatch(/["'`]\s*\d[\d,.]*[KkMm]?\+?\s*["'`]/); // no quoted figures ("40+", "1.2M+") of its own
  });
});

// ── disclosure, fictional data, type size, contrast ─────────────────────

const FORBIDDEN: RegExp[] = [
  /\bAI\b/,
  /\bAI-powered\b/i,
  /homoglyph|punycode|transposition|hyphenation|tld swap/i,
  /hagezi|stamus|\bNRD\b|newly.registered.domain/i,
  /real-time|realtime/i,
  /one-click/i,
  /24\/7/,
  /blocklist|safe browsing|web risk|netbeacon|godaddy/i,
  /\$\s?\d/,
  /every variant is checked/i,
  /notices? when it moves|know when it moves/i,
];

test.describe("disclosure + data guards", () => {
  test.use({ viewport: DESKTOP });

  for (const pg of KIT_PAGES) {
    test(`${pg.path}: no forbidden claim words, no real domains`, async ({ page }) => {
      await open(page, pg.path);
      // textContent also covers the collapsed mobile copies.
      const text = (await page.locator(".pp").textContent()) ?? "";
      expect(text.length).toBeGreaterThan(500);
      for (const re of FORBIDDEN) expect(text, `${pg.path} matched ${re}`).not.toMatch(re);
      // Only the fictional .example world appears in samples.
      // averrow.com is our own: the abuse-mailbox alias is verify-<name>@averrow.com.
      const real = (text.match(/\b[a-z0-9-]+\.(?:com|net|org|io|co|ca|app|dev|ai|info)\b/gi) ?? []).filter((d) => d.toLowerCase() !== "averrow.com");
      expect(real, `${pg.path} shows real-looking domains`).toEqual([]);
    });
  }
});

/** Kit selectors for the type-size and contrast checks (excludes the reused Coverage / TakedownFlow). */
const KIT_SCOPE = ".ph, .sf, .sl, .st, .pst, .rs, .pc, .ps-sec, .pv-stages, .pv-rate, .pv-int, .td-modes, .td-points, .td-flow, .td-end, .pp-crumb, .eg, .ae, .am-setup, .am-cust";

test.describe("type size and contrast", () => {
  test.use({ viewport: DESKTOP });

  for (const theme of ["dark", "light"] as const) {
    for (const pg of KIT_PAGES) {
      test(`${theme}: ${pg.path}: kit text is >= 12px and meets AA`, async ({ page }) => {
        await open(page, pg.path, theme);
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        const result = await page.evaluate((scope) => {
          type RGBA = { r: number; g: number; b: number; a: number };
          const parse = (c: string): RGBA | null => {
            let m = c.match(/^rgba?\(([^)]+)\)$/);
            if (m) {
              const p = m[1]!.split(/[,\s/]+/).filter(Boolean).map(Number);
              return { r: p[0]!, g: p[1]!, b: p[2]!, a: p[3] ?? 1 };
            }
            m = c.match(/^color\(srgb ([^)]+)\)$/);
            if (m) {
              const p = m[1]!.split(/[\s/]+/).filter(Boolean).map(Number);
              return { r: p[0]! * 255, g: p[1]! * 255, b: p[2]! * 255, a: p[3] ?? 1 };
            }
            return null;
          };
          const over = (top: RGBA, bottom: RGBA): RGBA => {
            const a = top.a + bottom.a * (1 - top.a);
            const mix = (t: number, b: number) => (t * top.a + b * bottom.a * (1 - top.a)) / (a || 1);
            return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a };
          };
          const lum = (c: RGBA) => {
            const f = (v: number) => {
              const s = v / 255;
              return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
            };
            return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
          };
          // Effective opaque background: composite ancestors' backgrounds; null when a gradient/image is involved.
          const bgOf = (el: Element): RGBA | null => {
            const layers: RGBA[] = [];
            for (let n: Element | null = el; n; n = n.parentElement) {
              const cs = getComputedStyle(n);
              if (cs.backgroundImage !== "none") return null;
              const c = parse(cs.backgroundColor);
              if (c && c.a > 0) layers.push(c);
              if (c && c.a === 1) break;
            }
            let acc: RGBA = parse(getComputedStyle(document.body).backgroundColor) ?? { r: 255, g: 255, b: 255, a: 1 };
            if (acc.a < 1) acc = { r: 255, g: 255, b: 255, a: 1 };
            for (const l of layers.reverse()) acc = over(l, acc);
            return acc;
          };
          const small: string[] = [];
          const low: string[] = [];
          let checked = 0;
          const seen = new Set<Element>();
          for (const root of Array.from(document.querySelectorAll(scope))) {
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            for (let t = walker.nextNode(); t; t = walker.nextNode()) {
              const el = t.parentElement;
              if (!el || seen.has(el) || !t.textContent?.trim()) continue;
              seen.add(el);
              const r = el.getBoundingClientRect();
              const cs = getComputedStyle(el);
              if (r.width === 0 || r.height === 0 || cs.visibility === "hidden" || el.closest(".st-sr, .cv, .tf, [hidden]")) continue;
              const label = `${el.tagName.toLowerCase()}.${(el.className || "").toString().split(" ")[0]} "${t.textContent.trim().slice(0, 28)}"`;
              const size = parseFloat(cs.fontSize);
              if (size < 11.99) small.push(`${label} ${size}px`);
              const fg = parse(cs.color);
              const bg = bgOf(el);
              if (!fg || !bg) continue;
              const text = fg.a < 1 ? over(fg, bg) : fg;
              const L1 = lum(text);
              const L2 = lum(bg);
              const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
              const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
              checked++;
              if (ratio < (large ? 3 : 4.5)) low.push(`${label} ${ratio.toFixed(2)}:1`);
            }
          }
          return { small, low, checked };
        }, KIT_SCOPE);
        expect(result.checked, "contrast sample size").toBeGreaterThan(20);
        expect(result.small, "text below 12px").toEqual([]);
        expect(result.low, "AA contrast failures").toEqual([]);
      });
    }
  }
});


// ── phase 2B: /platform/email-security and /platform/abuse-mailbox ───────

const ES = "/platform/email-security";
const AM = "/platform/abuse-mailbox";

/** WCAG contrast of an element's text against its effective (composited) background. */
async function contrastOf(page: Page, selector: string) {
  return page.locator(selector).first().evaluate((el) => {
    const parse = (c: string) => {
      const m = c.match(/^(?:rgba?|color)\(([^)]+)\)$/);
      const p = m![1]!.replace("srgb", "").split(/[,\s/]+/).filter(Boolean).map(Number);
      const srgb = c.startsWith("color(");
      return { r: srgb ? p[0]! * 255 : p[0]!, g: srgb ? p[1]! * 255 : p[1]!, b: srgb ? p[2]! * 255 : p[2]!, a: p[3] ?? 1 };
    };
    const lum = (c: { r: number; g: number; b: number }) => {
      const f = (v: number) => ((v / 255) <= 0.03928 ? v / 255 / 12.92 : (((v / 255) + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
    };
    let bg = { r: 255, g: 255, b: 255, a: 1 };
    const layers: Array<ReturnType<typeof parse>> = [];
    for (let n: Element | null = el; n; n = n.parentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c.a > 0) layers.push(c);
      if (c.a === 1) break;
    }
    for (const l of layers.reverse()) bg = { r: l.r * l.a + bg.r * (1 - l.a), g: l.g * l.a + bg.g * (1 - l.a), b: l.b * l.a + bg.b * (1 - l.a), a: 1 };
    const fg = parse(getComputedStyle(el).color);
    const L1 = lum(fg);
    const L2 = lum(bg);
    return { ratio: (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05), size: parseFloat(getComputedStyle(el).fontSize) };
  });
}

test.describe("/platform/email-security", () => {
  test.use({ viewport: DESKTOP });

  test("hero sample is the labelled grade; no 'Capability 02' eyebrow", async ({ page }) => {
    await open(page, ES);
    const sample = page.locator(".ph .sf");
    await expect(sample.locator(".sf-tag")).toHaveText("Illustrative");
    await expect(sample).toContainText("BIMI");
    await expect(sample.getByRole("img", { name: "Sample grade: A+" })).toBeVisible();
    await expect(page.locator(".pp")).not.toContainText(/capability 0\d/i);
  });

  test("method copy matches the engine: BIMI present; no provider cards, 'resolves cleanly' or grade definitions", async ({ page }) => {
    await open(page, ES);
    const text = ((await page.locator(".pp").textContent()) ?? "").replace(/\s+/g, " ");
    expect(text).toMatch(/12\+ (common )?selectors/);
    expect(text).toMatch(/10-lookup limit/);
    expect(text).toMatch(/BIMI/);
    expect(text).toMatch(/certificate is reachable/);
    expect(text).toMatch(/reported separately from the grade/);
    // Retired claims (DISCLOSURE_REGISTER L28, §3.10).
    expect(text).not.toMatch(/resolves cleanly/i);
    expect(text).not.toMatch(/provider-aware|own conventions(?!\. The same)|secondary provider gap(?! in)/i);
    expect(text).not.toMatch(/fully hardened|no effective protection|VMC (is )?validated/i);
    expect(text).not.toMatch(/Google Workspace|Microsoft 365|Proofpoint|Mimecast/);
    await expect(page.locator(".es-provider-card, .es-grade-row")).toHaveCount(0);
  });

  test("closing CTA says the free scan shows this grade", async ({ page }) => {
    await open(page, ES);
    await expect(page.locator(".pc")).toContainText(/free domain scan/i);
    await expect(page.locator(".pc")).toContainText(/shows exactly this grade/i);
    await expect(page.locator(".pc").getByRole("link", { name: "Scan your domain" })).toHaveAttribute("href", /\/scan$/);
  });

  for (const theme of ["dark", "light"] as const) {
    test(`${theme}: the Grade label is >= 12px and meets AA`, async ({ page }) => {
      await open(page, ES, theme);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      const label = page.locator(".eg-sub");
      await expect(label).toHaveText("Grade");
      const { ratio, size } = await contrastOf(page, ".eg-sub");
      expect(size, "Grade label font size").toBeGreaterThanOrEqual(12);
      expect(ratio, "Grade label contrast").toBeGreaterThanOrEqual(4.5);
      const letter = await contrastOf(page, ".eg-letter");
      expect(letter.ratio, "grade letter contrast").toBeGreaterThanOrEqual(3);
    });
  }
});

test.describe("/platform/abuse-mailbox", () => {
  test.use({ viewport: DESKTOP });

  test("determination email is in the hero, labelled Illustrative, with the real alias form", async ({ page }) => {
    await open(page, AM);
    const sample = page.locator(".ph .sf");
    await expect(sample.locator(".sf-tag")).toHaveText("Illustrative");
    await expect(sample).toContainText("Averrow Abuse Triage");
    await expect(sample).toContainText("Phishing confirmed");
    const html = await page.content();
    expect(html).not.toContain("report@yourbrand");
    await expect(page.locator(".pp")).toContainText("verify-yourname@averrow.com");
  });

  test("#setup exists once and holds the three setup steps; customers link to Log in", async ({ page }) => {
    await open(page, AM);
    await expect(page.locator("#setup")).toHaveCount(1);
    await expect(page.locator("#setup .am-setup > li")).toHaveCount(3);
    const login = page.locator("#setup").getByRole("link", { name: "Log in" });
    const nav = await page.locator('a[data-cta="nav-login"]').first().getAttribute("href");
    await expect(login).toHaveAttribute("href", nav ?? "/login");
  });

  test("no lead form and no callback request; one 'what you get' table; no setup checklist", async ({ page }) => {
    await open(page, AM);
    await expect(page.locator(".pp form, .pp input, .pp textarea")).toHaveCount(0);
    await expect(page.locator("#amLeadForm")).toHaveCount(0);
    await expect(page.locator(".pp")).not.toContainText(/request a callback/i);
    await expect(page.locator(".pp [data-scope-table]")).toHaveCount(1);
    await expect(page.locator(".am-card, .am-grid, .am-check")).toHaveCount(0);
    await expect(page.getByText("Setup Checklist")).toHaveCount(0);
  });

  test("true claims are kept; retired ones are gone", async ({ page }) => {
    await open(page, AM);
    const text = ((await page.locator(".pp").textContent()) ?? "").replace(/\s+/g, " ");
    expect(text).toMatch(/instant acknowledg/i);
    expect(text).toMatch(/about two minutes/i);
    expect(text).toMatch(/SPF, DKIM and DMARC from the forwarded headers/i);
    expect(text).toMatch(/takedown (is )?drafted/i);
    expect(text).toMatch(/awaiting approval|your approval/i);
    expect(text).toMatch(/per-sender throttling/i);
    expect(text).toMatch(/rollup/i);
    expect(text).not.toMatch(/second opinion|automated classification|usually within minutes/i);
  });

  test("Enterprise tag and the standard CTA pair (primary: free scan)", async ({ page }) => {
    await open(page, AM);
    await expect(page.locator(".ph-plan")).toHaveText("Enterprise");
    for (const sel of [".ph [data-cta-pair]", ".pc [data-cta-pair]"]) {
      const pair = page.locator(sel);
      await expect(pair.getByRole("link", { name: "Scan your domain" })).toHaveAttribute("href", /\/scan$/);
      await expect(pair.getByRole("link", { name: "Book a demo" })).toHaveAttribute("href", /\/demo$/);
    }
  });
});

test.describe("phase 2B pages at 390px", () => {
  test.use({ viewport: PHONE });

  for (const p of [ES, AM]) {
    test(`${p}: no horizontal scroll, one H1, hero sample inside the viewport`, async ({ page }) => {
      await open(page, p);
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.evaluate(() => document.querySelectorAll("details").forEach((d) => d.setAttribute("open", "")));
      const m = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, body: document.body.scrollWidth, vw: window.innerWidth }));
      expect(Math.max(m.doc, m.body), `${p} scrollWidth vs ${m.vw}`).toBeLessThanOrEqual(m.vw);
      await expect(page.locator("h1")).toHaveCount(1);
      const box = await page.locator(".ph .sf").boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(PHONE.width);
    });
  }
});
