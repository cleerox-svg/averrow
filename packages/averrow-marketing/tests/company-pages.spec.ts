import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/*
 * Section 9B (Company pages): /company, /about, /why-averrow, /contact, /demo
 * and the shared ContactForm.
 *
 * Guarded here:
 *  - the CTA pair (Scan your domain -> /scan, Book a demo -> /demo) on the
 *    product-kit pages (the /demo hero omits it, since it would link to itself);
 *  - no horizontal scroll at 390px, a 12px text floor and AA contrast in both themes;
 *  - the founder is named, with no gendered pronoun and no biography;
 *  - no response-time promise anywhere, and the private owner address is absent
 *    from every built page (only the four monitored averrow.com mailboxes appear);
 *  - the form: visible labels, sr-only required text, per-field errors with
 *    aria-invalid + aria-describedby, a role="alert" summary, focus on the first
 *    invalid field, 3:1 borders, a 2px focus outline, 16px inputs, autocomplete;
 *  - the demo variant posts `domain` and has no Interest select;
 *  - SampleFrame samples use `.example` domains only.
 *
 * Each test pins its own viewport, so it works under both Playwright projects.
 */

const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// DIST_DIR lets a run point at a private build when another build is writing ./dist.
const DIST = process.env.DIST_DIR ?? path.join(ROOT, "dist");

const PAGES = ["/company", "/about", "/why-averrow", "/contact", "/demo"];
/** Pages that carry the kit CTA pair in the hero and the closing block. */
const PAIR_PAGES = ["/company", "/about", "/why-averrow"];

const ALLOWED_MAILBOXES = ["hello@averrow.com", "sales@averrow.com", "security@averrow.com", "privacy@averrow.com"];

async function open(page: Page, p: string, theme: "dark" | "light" = "dark") {
  await page.addInitScript((t) => {
    try {
      localStorage.setItem("averrow-theme", t);
    } catch {
      /* private mode */
    }
  }, theme);
  await page.route("**/api/v1/public/stats", (route) => route.abort());
  const res = await page.goto(p);
  expect(res?.status(), `${p} status`).toBeLessThan(400);
}

const mainText = (page: Page) => page.locator("#content").innerText();

// ── render + CTA pair ───────────────────────────────────────────────────

test.describe("company pages render", () => {
  test.use({ viewport: DESKTOP });

  const H1: Record<string, RegExp> = {
    "/company": /the company behind averrow/i,
    "/about": /built to get ahead of threat actors/i,
    "/why-averrow": /check us before you trust us/i,
    "/contact": /get in touch/i,
    "/demo": /see averrow on your own domain/i,
  };

  for (const p of PAGES) {
    test(`${p}: title, one h1`, async ({ page }) => {
      await open(page, p);
      await expect(page).toHaveTitle(/— Averrow$/);
      await expect(page.locator("h1")).toHaveCount(1);
      await expect(page.locator("h1")).toHaveText(H1[p]!);
    });
  }

  for (const p of PAIR_PAGES) {
    test(`${p}: CTA pair in the hero and the closing block`, async ({ page }) => {
      await open(page, p);
      await expect(page.locator(".ph [data-cta-pair]")).toHaveCount(1);
      await expect(page.locator(".pc [data-cta-pair]")).toHaveCount(1);
      const pairs = page.locator("#content [data-cta-pair]");
      for (let i = 0; i < (await pairs.count()); i++) {
        const scan = pairs.nth(i).getByRole("link", { name: "Scan your domain" });
        const demo = pairs.nth(i).getByRole("link", { name: "Book a demo" });
        await expect(scan).toHaveAttribute("href", /\/scan$/);
        await expect(scan).toHaveClass(/btn-primary/);
        await expect(demo).toHaveAttribute("href", /\/demo$/);
        await expect(demo).toHaveClass(/btn-outline/);
      }
    });
  }

  test("/contact: hero carries the pair; /demo hero omits it but offers the free scan", async ({ page }) => {
    await open(page, "/contact");
    await expect(page.locator(".ph [data-cta-pair]")).toHaveCount(1);
    await open(page, "/demo");
    await expect(page.locator(".ph [data-cta-pair]")).toHaveCount(0);
    await expect(page.locator("#content").getByRole("link", { name: "Scan your domain" })).toHaveAttribute("href", /\/scan$/);
  });
});

// ── /company ────────────────────────────────────────────────────────────

test.describe("/company hub", () => {
  test.use({ viewport: DESKTOP });

  test("legal entity, dated facts, four mailboxes, trust links", async ({ page }) => {
    await open(page, "/company");
    const text = await mainText(page);
    expect(text).toContain("LRX Enterprises Inc.");
    expect(text).toMatch(/SOC 2 Type I/i);
    expect(text).toMatch(/in preparation/i);

    const grid = page.locator("[data-fact-grid]");
    await expect(grid).toHaveCount(1);
    await expect(grid.locator("time")).toHaveAttribute("datetime", /^\d{4}-\d{2}-\d{2}$/);
    await expect(grid.locator("time")).toContainText(/Facts as of \d{1,2} \w{3} \d{4}/);

    const mails = await page.locator("#contact a[href^='mailto:']").evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).getAttribute("href")));
    expect(mails.sort()).toEqual(ALLOWED_MAILBOXES.map((m) => `mailto:${m}`).sort());
    for (const label of ["Sales", "Support and general", "Security", "Privacy"]) {
      await expect(page.locator("#contact").getByRole("heading", { name: label })).toBeVisible();
    }

    const hrefs = await page.locator("#trust a").evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).getAttribute("href")));
    for (const h of ["/security", "/status", "/legal/dpa", "/privacy", "/terms"]) expect(hrefs).toContain(h);
    // The DPA route is a real page in this build.
    expect((await page.request.get("/legal/dpa")).status()).toBe(200);
    expect((await page.request.get("/security")).status()).toBe(200);
  });

  test("#press: boilerplate with a working copy button, fast facts, real brand assets, no 'as seen in'", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
    await open(page, "/company");
    const press = page.locator("#press");
    await expect(press).toBeVisible();
    const boiler = (await press.locator("#boilerplate-text").innerText()).trim();
    expect(boiler).toMatch(/LRX Enterprises Inc\./);
    expect(boiler).not.toMatch(/shut down|AI-powered|40\+/i);

    const copy = press.getByRole("button", { name: "Copy boilerplate" });
    await expect(copy).toBeVisible();
    await copy.click();
    await expect(press.locator("[data-copy-status]")).toHaveText(/copied/i);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(boiler);

    const assets = await press.locator("a[download]").evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).getAttribute("href")));
    expect(assets.length).toBe(7);
    for (const h of assets) {
      expect(h, "asset path").toMatch(/^\/(brand\/averrow-[\w-]+\.png|favicon\.svg)$/);
      expect(fs.existsSync(path.join(ROOT, "..", "averrow-worker", "public", h!)), `${h} exists in the Worker's public/`).toBe(true);
    }
    expect((await mainText(page)).toLowerCase()).not.toContain("as seen in");
  });

  test("#careers: no open roles, how to get in touch", async ({ page }) => {
    await open(page, "/company");
    const careers = page.locator("#careers");
    await expect(careers.getByRole("heading", { name: "No open roles right now." })).toBeVisible();
    await expect(careers.getByRole("link", { name: "hello@averrow.com" })).toHaveAttribute("href", "mailto:hello@averrow.com");
  });
});

// ── /about and /why-averrow ─────────────────────────────────────────────

test.describe("/about", () => {
  test.use({ viewport: DESKTOP });

  test("names the founder with role only, no gendered pronoun, SOC 2 in preparation", async ({ page }) => {
    await open(page, "/about");
    const founder = page.locator("#founder");
    await expect(founder).toContainText("Claude Leroux");
    await expect(founder).toContainText(/founder of Averrow/i);
    const ftext = await founder.innerText();
    expect(ftext).not.toMatch(/\b(he|she|his|her|hers|him)\b/i);
    // No quote marks around a "statement" and nothing that reads as a biography.
    expect(ftext).not.toMatch(/[“”"]/);
    expect(ftext).not.toMatch(/\b(formerly|previously|worked|years|graduated|born|studied)\b/i);
    await expect(founder.locator("img")).toHaveCount(0);

    const text = await mainText(page);
    expect(text).toMatch(/SOC 2 Type I is in preparation/i);
    expect(text).not.toMatch(/shut down/i);
    expect(text).toContain("LRX Enterprises Inc.");
  });

  test("principles are stated once across the company pages", async ({ page }) => {
    const counts: Record<string, number> = {};
    for (const p of PAGES) {
      await open(page, p);
      counts[p] = (await mainText(page)).split("Evidence you can trace").length - 1;
    }
    expect(counts["/about"]).toBe(1);
    for (const p of PAGES.filter((x) => x !== "/about")) expect(counts[p], p).toBe(0);
    // The old "how we work" blocks are gone.
    await open(page, "/about");
    expect((await mainText(page)).toLowerCase()).not.toContain("how we work");
    await open(page, "/company");
    expect((await mainText(page)).toLowerCase()).not.toContain("how we work");
  });
});

test.describe("/why-averrow", () => {
  test.use({ viewport: DESKTOP });

  test("leads with four things a visitor can check, and the old pseudo-stats are gone", async ({ page }) => {
    await open(page, "/why-averrow");
    const verify = page.locator("#verify");
    const hrefs = await verify.locator("a").evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).getAttribute("href")));
    expect(hrefs).toEqual(["/scan", "/status", "/resources/methodology", "/platform/takedowns"]);
    // First section after the hero, and the hero does not lead with an absence.
    await expect(page.locator("h1")).not.toHaveText(/case stud|no logos/i);
    const text = await mainText(page);
    expect(text).not.toMatch(/Analyst-heavy/);
    expect(text).not.toMatch(/Exposure Score/i);
    expect(text).not.toMatch(/case stud/i);
    expect(text).not.toMatch(/shut down/i);
    await expect(page.locator(".why-gap-figure, .why-sample-score, .why-score-fill")).toHaveCount(0);
    // Takedowns stay in the customer's control; providers decide.
    expect(text).toMatch(/Nothing is filed without your approval or your signed rules/);
    expect(text).toMatch(/Providers decide/);
  });

  test("numbers come from ProofStrip and are dated, never hard-coded", async ({ page }) => {
    await open(page, "/why-averrow");
    const strip = page.locator("[data-proof-strip]");
    // The strip omits itself when stats.json has no valid date; when it shows, it is dated.
    if (await strip.count()) await expect(strip.locator("time")).toHaveAttribute("datetime", /\d{4}-\d{2}-\d{2}/);
    const text = await mainText(page);
    expect(text).not.toMatch(/\b40\+/);
    expect(text).not.toMatch(/24\/7/);
  });
});

// ── samples: .example domains only ──────────────────────────────────────

test.describe("SampleFrame samples", () => {
  test.use({ viewport: DESKTOP });

  const SAMPLE_PAGES = ["/why-averrow", "/platform/takedowns", "/platform/lookalike-domains"];
  const REAL_TLD = /\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|co|ca|app|dev|info|biz)\b/gi;

  for (const p of SAMPLE_PAGES) {
    test(`${p}: no .com/.net (or other real-TLD) domains inside a SampleFrame`, async ({ page }) => {
      await open(page, p);
      const frames = page.locator(".sf");
      expect(await frames.count()).toBeGreaterThan(0);
      for (let i = 0; i < (await frames.count()); i++) {
        const t = await frames.nth(i).innerText();
        expect(t.match(REAL_TLD) ?? [], `real-TLD domain in ${p} sample ${i}`).toEqual([]);
      }
    });
  }

  test("/why-averrow sample uses .example domains and names no scoring signal", async ({ page }) => {
    await open(page, "/why-averrow");
    const t = await page.locator(".sf").first().innerText();
    expect(t).toMatch(/\.example/);
    expect(t).toMatch(/Illustrative/i);
    expect(t).not.toMatch(/\d+\s?%|registered \d+ days|similarity|suffix|score/i);
  });
});

// ── layout: 390px, 12px floor, contrast ─────────────────────────────────

test.describe("phone layout", () => {
  test.use({ viewport: PHONE });

  for (const p of PAGES) {
    test(`${p}: no horizontal scroll at 390px`, async ({ page }) => {
      await open(page, p);
      await page.waitForLoadState("networkidle").catch(() => {});
      // Open every <details> so folded content is measured too.
      await page.evaluate(() => document.querySelectorAll("details").forEach((d) => ((d as HTMLDetailsElement).open = true)));
      const sw = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth));
      expect(sw, `scrollWidth on ${p}`).toBeLessThanOrEqual(PHONE.width + 1);
    });
  }
});

test.describe("type size and contrast", () => {
  test.use({ viewport: DESKTOP });

  for (const theme of ["dark", "light"] as const) {
    for (const p of PAGES) {
      test(`${theme}: ${p}: text >= 12px and AA`, async ({ page }) => {
        await open(page, p, theme);
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        const result = await page.evaluate(() => {
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
          const root = document.querySelector("#content")!;
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
          for (let t = walker.nextNode(); t; t = walker.nextNode()) {
            const el = t.parentElement;
            if (!el || seen.has(el) || !t.textContent?.trim()) continue;
            seen.add(el);
            const r = el.getBoundingClientRect();
            const cs = getComputedStyle(el);
            if (r.width === 0 || r.height === 0 || cs.visibility === "hidden" || el.closest("[hidden], .cf-hp, .cf-sr, .st-sr")) continue;
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
          return { small, low, checked };
        });
        expect(result.checked, "contrast sample size").toBeGreaterThan(15);
        expect(result.small, "text below 12px").toEqual([]);
        expect(result.low, "AA contrast failures").toEqual([]);
      });
    }
  }
});

// ── copy rules, across the built site ───────────────────────────────────

test.describe("copy rules", () => {
  test.use({ viewport: DESKTOP });

  const PROMISE = /(within|in under|inside)\s+(1|one|2|two|24|48|\d+)\s*(business\s+)?(day|hour|minute)s?|same[- ]day|next[- ]day|respond(s|ed)?\s+(within|quickly|fast)|typically respond|usually (reply|respond)|get back to you (shortly|soon|quickly)/i;

  for (const p of PAGES) {
    test(`${p}: no response-time promise, no banned claims`, async ({ page }) => {
      await open(page, p);
      const text = await mainText(page);
      expect(text).not.toMatch(PROMISE);
      expect(text).not.toMatch(/shut down|AI-powered|powered by AI|\$\s?\d|per month|\/mo\b|SLA|99\.\d+%/i);
      expect(text).not.toMatch(/aviation|avro arrow|military/i);
      expect(text).not.toMatch(/testimonial|trusted by|as seen in/i);
    });
  }

  test("/contact and /demo say 'We'll reply by email.'", async ({ page }) => {
    for (const p of ["/contact", "/demo"]) {
      await open(page, p);
      expect(await mainText(page)).toContain("We'll reply by email.");
    }
  });

  test("/contact has no Security Report option and points security to the mailbox", async ({ page }) => {
    await open(page, "/contact");
    await expect(page.locator("#cf-interest option")).toHaveText(["General question", "Product demo", "Plans and enterprise", "Partnership"]);
    await expect(page.locator("#content").getByRole("link", { name: "security@averrow.com" })).toHaveAttribute("href", "mailto:security@averrow.com");
  });

  test("built HTML: no private owner address, only the four mailboxes", async () => {
    test.skip(!fs.existsSync(DIST), "dist/ not built");
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const f = path.join(d, e.name);
        if (e.isDirectory()) walk(f);
        else if (/\.(html|xml|txt|json)$/.test(e.name)) files.push(f);
      }
    };
    walk(DIST);
    expect(files.length).toBeGreaterThan(10);

    // Addresses that are examples or placeholders, not mailboxes (form hints, sample text).
    const PLACEHOLDERS = new Set(["name@company.com", "you@yourcompany.com"]);
    const bad: string[] = [];
    for (const f of files) {
      const raw = fs.readFileSync(f, "utf8");
      const rel = path.relative(DIST, f);
      // The founder's name is the one permitted use of "leroux", and only as "Claude Leroux".
      if (/leroux/i.test(raw.replace(/Claude Leroux/g, ""))) bad.push(`${rel}: "leroux" outside the founder's name`);
      if (/leroux/i.test(raw) && !/^(about|company)\//.test(rel) && !rel.startsWith("_astro")) bad.push(`${rel}: founder name outside /about and /company`);
      if (/cleerox|@gmail\.|@googlemail\.|@outlook\.|@hotmail\.|@yahoo\.|@proton/i.test(raw)) bad.push(`${rel}: personal mail domain`);
      for (const m of raw.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g) ?? []) {
        const addr = m.toLowerCase();
        if (/\.(png|jpg|jpeg|svg|webp|gif|css|js)$/.test(addr)) continue;
        if (PLACEHOLDERS.has(addr)) continue;
        if (!addr.endsWith("@averrow.com")) bad.push(`${rel}: ${m}`);
      }
    }
    expect(bad).toEqual([]);

    // The four monitored mailboxes appear on /company.
    const hub = fs.readFileSync(path.join(DIST, "company", "index.html"), "utf8");
    for (const m of ALLOWED_MAILBOXES) expect(hub).toContain(m);
  });
});

// ── ContactForm: accessibility ──────────────────────────────────────────

const FORMS = [
  { path: "/contact", variant: "contact", required: ["name", "email", "message"] },
  { path: "/demo", variant: "demo", required: ["name", "email", "domain", "message"] },
] as const;

test.describe("ContactForm accessibility", () => {
  test.use({ viewport: DESKTOP });

  for (const f of FORMS) {
    test(`${f.path}: every field has a visible label; required ones add sr-only text; autocomplete set`, async ({ page }) => {
      await open(page, f.path);
      const fields = page.locator("#contactForm").locator("input[name], select[name], textarea[name]");
      const n = await fields.count();
      expect(n).toBeGreaterThanOrEqual(5);
      for (let i = 0; i < n; i++) {
        const el = fields.nth(i);
        const name = (await el.getAttribute("name"))!;
        if (name === "company_website") continue;
        const id = (await el.getAttribute("id"))!;
        const label = page.locator(`label[for="${id}"]`);
        await expect(label, `${name} label`).toBeVisible();
        expect((await label.innerText()).trim().length).toBeGreaterThan(1);
        const isRequired = (f.required as readonly string[]).includes(name);
        expect(await el.evaluate((e) => (e as HTMLInputElement).required), `${name} required`).toBe(isRequired);
        // sr-only "(required)" text only on required fields; the visible asterisk is aria-hidden.
        await expect(label.locator(".cf-sr"), `${name} sr-only text`).toHaveCount(isRequired ? 1 : 0);
        if (isRequired) {
          await expect(label.locator(".cf-sr")).toHaveText(/required/i);
          await expect(label.locator('.cf-req[aria-hidden="true"]')).toHaveCount(1);
        }
        // Accessible name never includes the decorative asterisk.
        const ac = await el.getAttribute("autocomplete");
        expect(ac, `${name} autocomplete`).toBeTruthy();
      }
      await expect(page.locator("#cf-name")).toHaveAttribute("autocomplete", "name");
      await expect(page.locator("#cf-email")).toHaveAttribute("autocomplete", "email");
      await expect(page.locator("#cf-company")).toHaveAttribute("autocomplete", "organization");
      await expect(page.locator("#cf-email")).toHaveAttribute("type", "email");
      // The honeypot is inert and hidden from assistive tech.
      await expect(page.locator(".cf-hp")).toHaveAttribute("aria-hidden", "true");
    });

    test(`${f.path}: empty submit shows per-field errors, an alert summary, and focuses the first invalid field`, async ({ page }) => {
      await open(page, f.path);
      let posted = false;
      await page.route("**/api/contact", (r) => {
        posted = true;
        return r.fulfill({ status: 200, contentType: "application/json", body: '{"success":true}' });
      });
      const alert = page.locator("#content [role='alert']");
      await expect(alert).toHaveCount(1);
      await expect(alert).toHaveText("");

      await page.getByRole("button", { name: /send message|request a demo/i }).click();
      expect(posted, "invalid form must not POST").toBe(false);

      await expect(alert).toContainText(`${f.required.length} fields need attention`);
      expect(await alert.locator("li").count()).toBe(f.required.length);
      await expect(page.locator("#cf-name")).toBeFocused();

      for (const name of f.required) {
        const el = page.locator(`#cf-${name}`);
        await expect(el, `${name} aria-invalid`).toHaveAttribute("aria-invalid", "true");
        const describedby = (await el.getAttribute("aria-describedby"))!;
        expect(describedby).toContain(`cf-${name}-err`);
        const err = page.locator(`#cf-${name}-err`);
        await expect(err).toBeVisible();
        expect((await err.innerText()).trim().length).toBeGreaterThan(5);
      }
      // Optional fields are not flagged.
      await expect(page.locator("#cf-company")).not.toHaveAttribute("aria-invalid", "true");

      // Fixing a field clears its error; the others stay.
      await page.locator("#cf-name").fill("Ada Example");
      await expect(page.locator("#cf-name")).not.toHaveAttribute("aria-invalid", "true");
      await expect(page.locator("#cf-name-err")).toBeHidden();
      await expect(page.locator("#cf-email")).toHaveAttribute("aria-invalid", "true");
    });

    test(`${f.path}: a malformed email is flagged and focus lands on it`, async ({ page }) => {
      await open(page, f.path);
      await page.locator("#cf-name").fill("Ada Example");
      await page.locator("#cf-email").fill("not-an-email");
      if (f.variant === "demo") await page.locator("#cf-domain").fill("acme.example");
      await page.locator("#cf-message").fill("Hello");
      await page.getByRole("button", { name: /send message|request a demo/i }).click();
      await expect(page.locator("#cf-email")).toBeFocused();
      await expect(page.locator("#cf-email")).toHaveAttribute("aria-invalid", "true");
      await expect(page.locator("#cf-email-err")).toContainText(/email/i);
      await expect(page.locator("#content [role='alert']")).toContainText("One field needs attention");
    });

    test(`${f.path}: message is required (the server requires it)`, async ({ page }) => {
      await open(page, f.path);
      await page.locator("#cf-name").fill("Ada Example");
      await page.locator("#cf-email").fill("ada@acme.example");
      if (f.variant === "demo") await page.locator("#cf-domain").fill("acme.example");
      await page.getByRole("button", { name: /send message|request a demo/i }).click();
      await expect(page.locator("#cf-message")).toBeFocused();
      await expect(page.locator("#cf-message")).toHaveAttribute("aria-invalid", "true");
    });
  }

  for (const theme of ["dark", "light"] as const) {
    test(`${theme}: borders >= 3:1, 2px focus outline, 16px controls, one error style`, async ({ page }) => {
      await open(page, "/demo", theme);
      await page.getByRole("button", { name: /request a demo/i }).click(); // reveal errors
      const r = await page.evaluate(() => {
        const parse = (c: string) => {
          const m = c.match(/rgba?\(([^)]+)\)/);
          if (!m) return null;
          const p = m[1]!.split(/[,\s/]+/).filter(Boolean).map(Number);
          return { r: p[0]!, g: p[1]!, b: p[2]!, a: p[3] ?? 1 };
        };
        const over = (t: { r: number; g: number; b: number; a: number }, b: { r: number; g: number; b: number; a: number }) => ({
          r: t.r * t.a + b.r * (1 - t.a),
          g: t.g * t.a + b.g * (1 - t.a),
          b: t.b * t.a + b.b * (1 - t.a),
          a: 1,
        });
        const lum = (c: { r: number; g: number; b: number }) => {
          const f = (v: number) => {
            const s = v / 255;
            return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
          };
          return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
        };
        const ratio = (a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }) => {
          const x = lum(a);
          const y = lum(b);
          return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
        };
        const cardBg = parse(getComputedStyle(document.querySelector(".cf")!).backgroundColor)!;
        const out: Record<string, unknown> = {};
        const sizes: string[] = [];
        const lows: string[] = [];
        for (const el of Array.from(document.querySelectorAll<HTMLElement>("#contactForm input:not([name=company_website]), #contactForm select, #contactForm textarea"))) {
          const cs = getComputedStyle(el);
          if (parseFloat(cs.fontSize) < 16) sizes.push(`${el.id} ${cs.fontSize}`);
          if (el.getAttribute("aria-invalid") === "true") continue;
          const fieldBg = parse(cs.backgroundColor)!;
          const border = over(parse(cs.borderTopColor)!, over(fieldBg, cardBg));
          const rr = Math.min(ratio(border, cardBg), ratio(border, over(fieldBg, cardBg)));
          if (rr < 3) lows.push(`${el.id} ${rr.toFixed(2)}`);
        }
        out.sizes = sizes;
        out.lows = lows;
        // One error style: field message and summary share colour, weight and rule.
        const err = getComputedStyle(document.querySelector<HTMLElement>("#cf-name-err")!);
        const sum = getComputedStyle(document.querySelector<HTMLElement>(".cf-alert")!);
        out.sameStyle = err.color === sum.color && err.fontWeight === sum.fontWeight && err.borderLeftColor === sum.borderLeftColor && err.borderLeftWidth === sum.borderLeftWidth;
        const errRatio = ratio(parse(err.color)!, cardBg);
        out.errRatio = errRatio;
        const inv = getComputedStyle(document.querySelector<HTMLElement>("#cf-name")!);
        out.invalidBorder = ratio(parse(inv.borderTopColor)!, cardBg);
        return out;
      });
      expect(r.sizes, "controls under 16px").toEqual([]);
      expect(r.lows, "field borders under 3:1").toEqual([]);
      expect(r.sameStyle, "one error style").toBe(true);
      expect(r.errRatio as number, "error text AA").toBeGreaterThanOrEqual(4.5);
      expect(r.invalidBorder as number, "invalid border 3:1").toBeGreaterThanOrEqual(3);

      // 2px focus-visible outline on every control type.
      for (const sel of ["#cf-name", "#cf-companySize", "#cf-message"]) {
        await page.locator(sel).focus();
        const o = await page.locator(sel).evaluate((e) => {
          const cs = getComputedStyle(e);
          return { w: cs.outlineWidth, s: cs.outlineStyle };
        });
        expect(o, `${sel} focus outline`).toEqual({ w: "2px", s: "solid" });
      }
    });
  }
});

// ── ContactForm: POST contract ──────────────────────────────────────────

test.describe("ContactForm POST contract", () => {
  test.use({ viewport: DESKTOP });

  test("/demo posts `domain` (normalised) and no Interest select exists", async ({ page }) => {
    await open(page, "/demo");
    await expect(page.locator("#cf-interest")).toHaveCount(0);
    await expect(page.locator("#cf-domain")).toHaveAttribute("required", "");
    await expect(page.locator("label[for=cf-domain]")).toContainText("Domain");

    let body: Record<string, unknown> | null = null;
    await page.route("**/api/contact", async (r) => {
      body = r.request().postDataJSON() as Record<string, unknown>;
      await r.fulfill({ status: 200, contentType: "application/json", body: '{"success":true,"data":{"id":"x"}}' });
    });
    await page.locator("#cf-name").fill("Ada Example");
    await page.locator("#cf-email").fill("ada@acme.example");
    await page.locator("#cf-company").fill("Acme");
    await page.locator("#cf-domain").fill("https://Acme.example/login");
    await page.locator("#cf-companySize").selectOption("51-200");
    await page.locator("#cf-message").fill("Show me look-alikes.");
    await page.getByRole("button", { name: "Request a demo" }).click();

    await expect(page.locator("[data-cf-success]")).toBeVisible();
    await expect(page.locator("[data-cf-success]")).toContainText("We'll reply by email");
    await expect(page.locator("[data-cf-success]")).toBeFocused();
    expect(body).toMatchObject({
      name: "Ada Example",
      email: "ada@acme.example",
      company: "Acme",
      companySize: "51-200",
      message: "Show me look-alikes.",
      domain: "acme.example",
      company_website: "",
    });
  });

  test("/demo rejects a value that is not a domain", async ({ page }) => {
    await open(page, "/demo");
    await page.locator("#cf-name").fill("Ada Example");
    await page.locator("#cf-email").fill("ada@acme.example");
    await page.locator("#cf-domain").fill("not a domain");
    await page.locator("#cf-message").fill("Hi");
    await page.getByRole("button", { name: "Request a demo" }).click();
    await expect(page.locator("#cf-domain")).toBeFocused();
    await expect(page.locator("#cf-domain")).toHaveAttribute("aria-describedby", /cf-domain-hint.*cf-domain-err/);
  });

  test("/contact posts the existing contract: interest, no domain", async ({ page }) => {
    await open(page, "/contact");
    await expect(page.locator("#cf-domain")).toHaveCount(0);
    let body: Record<string, unknown> | null = null;
    await page.route("**/api/contact", async (r) => {
      body = r.request().postDataJSON() as Record<string, unknown>;
      await r.fulfill({ status: 200, contentType: "application/json", body: '{"success":true}' });
    });
    await page.locator("#cf-name").fill("Ada Example");
    await page.locator("#cf-email").fill("ada@acme.example");
    await page.locator("#cf-interest").selectOption("enterprise");
    await page.locator("#cf-message").fill("Question about plans.");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.locator("[data-cf-success]")).toBeVisible();
    expect(body).toMatchObject({ name: "Ada Example", email: "ada@acme.example", interest: "enterprise", message: "Question about plans.", company_website: "" });
    expect(Object.keys(body!)).not.toContain("domain");
  });

  test("a server error is announced in the alert region and focused", async ({ page }) => {
    await open(page, "/contact");
    await page.route("**/api/contact", (r) =>
      r.fulfill({ status: 429, contentType: "application/json", body: '{"success":false,"error":"Too many submissions from this network. Please try again later."}' }),
    );
    await page.locator("#cf-name").fill("Ada Example");
    await page.locator("#cf-email").fill("ada@acme.example");
    await page.locator("#cf-message").fill("Hello");
    await page.getByRole("button", { name: "Send message" }).click();
    const alert = page.locator("#content [role='alert']");
    await expect(alert).toContainText("Too many submissions");
    await expect(alert).toBeFocused();
    // The form is still there and the button is usable again.
    await expect(page.getByRole("button", { name: "Send message" })).toBeEnabled();
  });
});

// ── PR #1808 review fixes ───────────────────────────────────────────────

test.describe("form: sticky nav never covers the focused field or the alert", () => {
  for (const vp of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    for (const p of ["/contact", "/demo"]) {
      test(`${p} at ${vp.width}: after an empty submit the focused field and the summary sit below the nav`, async ({ page }) => {
        await page.setViewportSize(vp);
        await open(page, p);
        await page.getByRole("button", { name: /send message|request a demo/i }).scrollIntoViewIfNeeded();
        await page.getByRole("button", { name: /send message|request a demo/i }).click();
        await expect(page.locator("#cf-name")).toBeFocused();
        // Let any scroll settle.
        await page.waitForTimeout(150);
        const geo = await page.evaluate(() => {
          const nav = document.querySelector("nav.nav")!.getBoundingClientRect();
          const f = document.querySelector("#cf-name")!.getBoundingClientRect();
          const a = document.querySelector("[data-cf-alert]")!.getBoundingClientRect();
          return { navBottom: nav.bottom, fTop: f.top, fBottom: f.bottom, aTop: a.top, vh: window.innerHeight };
        });
        expect(geo.fTop, "field below the nav").toBeGreaterThanOrEqual(geo.navBottom);
        expect(geo.fBottom, "field inside the viewport").toBeLessThanOrEqual(geo.vh);
        expect(geo.aTop, "alert summary below the nav").toBeGreaterThanOrEqual(geo.navBottom);
      });
    }
  }

  test("controls and the alert carry a scroll-margin for the sticky nav", async ({ page }) => {
    await open(page, "/contact");
    for (const sel of ["#cf-name", "#cf-interest", "#cf-message", "[data-cf-alert]"]) {
      const m = await page.locator(sel).evaluate((el) => parseFloat(getComputedStyle(el).scrollMarginTop));
      expect(m, sel).toBeGreaterThanOrEqual(90);
    }
  });
});

test.describe("form: interest, prefill, hint wiring and layout", () => {
  test.use({ viewport: DESKTOP });

  test("?interest=partnership pre-selects Partnership and posts it", async ({ page }) => {
    await open(page, "/contact?interest=partnership");
    await expect(page.locator("#cf-interest")).toHaveValue("partnership");
    let body: Record<string, unknown> | null = null;
    await page.route("**/api/contact", async (r) => {
      body = r.request().postDataJSON() as Record<string, unknown>;
      await r.fulfill({ status: 200, contentType: "application/json", body: '{"success":true}' });
    });
    await page.locator("#cf-name").fill("Ada Example");
    await page.locator("#cf-email").fill("ada@msp.example");
    await page.locator("#cf-message").fill("Partnering.");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.locator("[data-cf-success]")).toBeVisible();
    expect(body).toMatchObject({ interest: "partnership" });
  });

  test("an unknown ?interest value is ignored", async ({ page }) => {
    await open(page, "/contact?interest=bogus");
    await expect(page.locator("#cf-interest")).toHaveValue("general");
  });

  test("the MSSP page links to the prefilled form", async ({ page }) => {
    await open(page, "/solutions/mssp");
    await page.locator("a[data-cta='mssp-partner']").click();
    await expect(page).toHaveURL(/\/contact\?interest=partnership/);
    await expect(page.locator("#cf-interest")).toHaveValue("partnership");
  });

  test("/demo: the domain hint is wired with aria-describedby before any error", async ({ page }) => {
    await open(page, "/demo");
    await expect(page.locator("#cf-domain")).toHaveAttribute("aria-describedby", "cf-domain-hint");
    await expect(page.locator("#cf-domain-hint")).toBeVisible();
  });

  test("the select chevron is a currentColor mask, not a hard-coded colour", async ({ page }) => {
    await open(page, "/contact");
    const info = await page.locator("#cf-interest").evaluate((el) => {
      const s = getComputedStyle(el.parentElement!, "::after");
      return { bg: getComputedStyle(el).backgroundImage, mask: s.maskImage, color: s.backgroundColor };
    });
    expect(info.bg).toBe("none");
    expect(info.mask).toContain("svg");
    expect(info.color).not.toBe("rgba(0, 0, 0, 0)");
  });

  test("the empty alert adds no gap above the form", async ({ page }) => {
    await open(page, "/contact");
    const gap = await page.evaluate(() => {
      const root = document.querySelector("[data-contact-form]")!.getBoundingClientRect();
      const note = document.querySelector(".cf-note")!.getBoundingClientRect();
      const pad = parseFloat(getComputedStyle(document.querySelector("[data-contact-form]")!).paddingTop);
      return note.top - root.top - pad;
    });
    expect(gap).toBeLessThanOrEqual(1);
  });

  test("/contact: both column headings share a top edge and a size", async ({ page }) => {
    await open(page, "/contact");
    const h = await page.evaluate(() => ["#ct-form-h", "#ct-side-h"].map((s) => {
      const el = document.querySelector(s)!;
      return { top: Math.round(el.getBoundingClientRect().top), size: getComputedStyle(el).fontSize };
    }));
    expect(h[0]!.top).toBe(h[1]!.top);
    expect(h[0]!.size).toBe(h[1]!.size);
  });
});

test.describe("/company: grids, press cards, dates and mailbox source", () => {
  test.use({ viewport: DESKTOP });

  test("trust and asset grids leave no orphan row; press cards are equal height", async ({ page }) => {
    await open(page, "/company");
    for (const [sel, expected] of [["#trust li", [3, 2]], ["#press .co-assets li", [4, 3]]] as const) {
      const tops = await page.locator(sel).evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
      const counts = [...new Set(tops)].map((t) => tops.filter((x) => x === t).length);
      expect(counts, sel).toEqual(expected);
      // The last row fills the grid width: no hanging single tile.
      const edges = await page.locator(sel).evaluateAll((els) => {
        const grid = els[0]!.parentElement!.getBoundingClientRect();
        const last = els[els.length - 1]!.getBoundingClientRect();
        return { gridRight: Math.round(grid.right), lastRight: Math.round(last.right) };
      });
      expect(edges.lastRight, sel).toBe(edges.gridRight);
    }
    const h = await page.locator(".co-bp, .co-ff").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
    expect(new Set(h).size, "press cards equal height").toBe(1);
  });

  test("every h3 in the company sections renders at one size", async ({ page }) => {
    await open(page, "/company");
    const sizes = await page.locator("#content h3").evaluateAll((els) => [...new Set(els.map((e) => getComputedStyle(e).fontSize))]);
    expect(sizes).toHaveLength(1);
  });

  test("trust and contact cards: 4 mailboxes in one row at 1280, no orphan", async ({ page }) => {
    await open(page, "/company");
    const tops = await page.locator("#contact .co-card").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
    expect(new Set(tops).size).toBe(1);
  });

  test("phone: grids stay inside the viewport with no orphan tile", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await open(page, "/company");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const w = await page.locator("#press .co-assets li").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().width)));
    expect(w[w.length - 1]).toBeGreaterThanOrEqual(Math.max(...w));
  });

  test("one date source: FactGrid reads the same snapshot date as ProofStrip", async ({ page }) => {
    const stats = JSON.parse(fs.readFileSync(path.join(ROOT, "src/data/stats.json"), "utf8")) as { generated_at: string };
    await open(page, "/company");
    await expect(page.locator("[data-fact-grid] time")).toHaveAttribute("datetime", stats.generated_at.slice(0, 10));
    await open(page, "/solutions");
    await expect(page.locator("[data-proof-strip] time")).toHaveAttribute("datetime", stats.generated_at);
    const day = (s: string) => new Date(s).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
    await expect(page.locator("[data-proof-strip] time")).toContainText(day(stats.generated_at));
    await open(page, "/company");
    await expect(page.locator("[data-fact-grid] time")).toContainText(day(stats.generated_at));
  });

  test("the press and careers mailbox comes from CONTACT_ROUTES (hello@)", async ({ page }) => {
    await open(page, "/company");
    await expect(page.locator("#press .ps-lede, #press p").first()).toBeVisible();
    await expect(page.locator("#press")).toContainText("hello@averrow.com");
    await expect(page.locator("#careers a")).toHaveAttribute("href", "mailto:hello@averrow.com");
    const src = fs.readFileSync(path.join(ROOT, "src/pages/company/index.astro"), "utf8");
    expect(src).not.toContain("hello@averrow.com");
  });
});

test.describe("nav brand sub-line and blog link", () => {
  test("the brand sub-line is at least 12px where it shows", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, "/");
    const sub = page.locator(".nav .nav-brand-sub");
    await expect(sub).toBeVisible();
    expect(await sub.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(12);
    // It never pushes the nav into overflow.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const overflow = await page.locator(".nav-inner").evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test("the MSSP blog post no longer points at /partners", async () => {
    const src = fs.readFileSync(path.join(ROOT, "src/content/blog/brand-threat-intelligence-for-mssps.mdx"), "utf8");
    expect(src).not.toContain("(/partners)");
    expect(src).toContain("(/solutions/mssp)");
  });
});
