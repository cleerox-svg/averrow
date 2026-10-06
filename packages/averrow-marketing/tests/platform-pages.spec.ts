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
];
/** Pages moved or renamed in phase 1 (content is rewritten in phase 2). */
const MOVED_PAGES = ["/platform/impersonation", "/platform/abuse-mailbox"];

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

  for (const p of ["/platform", "/platform/lookalike-domains"]) {
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
      const real = text.match(/\b[a-z0-9-]+\.(?:com|net|org|io|co|ca|app|dev|ai|info)\b/gi) ?? [];
      expect(real, `${pg.path} shows real-looking domains`).toEqual([]);
    });
  }
});

/** Kit selectors for the type-size and contrast checks (excludes the reused Coverage / TakedownFlow). */
const KIT_SCOPE = ".ph, .sf, .sl, .st, .pst, .rs, .pc, .ps-sec, .pv-stages, .pv-rate, .pv-int, .td-modes, .td-points, .td-flow, .td-end, .pp-crumb";

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
