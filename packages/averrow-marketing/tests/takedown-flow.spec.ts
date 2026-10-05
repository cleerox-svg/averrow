import { test, expect, type Page } from "@playwright/test";

/*
 * Homepage "From finding to takedown" (Section 5, TakedownFlow.astro): five
 * stages, an automation switch that is progressive enhancement (server HTML is
 * the "Approve first" state), a vertical timeline on phones, and a disclosure
 * guard (docs/DISCLOSURE_REGISTER.md).
 *
 * Both the five-column flow and the mobile list are rendered and one is hidden
 * by CSS, so each test pins an explicit viewport instead of inheriting the
 * project's device size (works under the chromium and mobile projects).
 */

const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };

const STAGES = ["Found", "Evidence", "Your rules", "Filed", "Watched"];
const MODES = ["Manual", "Approve first", "Automatic"];

// Words/claims that must never appear in the section (speed, cadence, success
// rates, vendor-ish marketing). Case-insensitive substring match.
const FORBIDDEN_IN_SECTION = ["blocklist", "real-time", "one-click", "%", "minutes", "hours"];

// Pages checked site-wide for the retired "blocklist" wording.
const SITE_PAGES = ["/", "/platform", "/platform/campaign-intelligence", "/pricing", "/why-averrow"];

async function openHome(page: Page) {
  await page.route("**/api/v1/public/stats", (route) => route.abort());
  await page.goto("/");
}

const flow = (page: Page) => page.locator("#takedown-flow");
const stage3 = (page: Page) => page.locator("#takedown-flow .tf-flow > li.tf-st").nth(2);

/** Which data-m values are currently visible inside stage 3, for cards and captions. */
async function visibleModes(page: Page) {
  const s3 = stage3(page);
  const out: Record<"card" | "caption", string[]> = { card: [], caption: [] };
  for (const m of ["manual", "approve", "auto"]) {
    if (await s3.locator(`.tf-card[data-m="${m}"]`).isVisible()) out.card.push(m);
    if (await s3.locator(`p[data-m="${m}"]`).isVisible()) out.caption.push(m);
  }
  return out;
}

async function expectMode(page: Page, mode: "manual" | "approve" | "auto", label: string) {
  // Exactly one radio checked, and it is the expected one.
  const radios = page.locator('#takedown-flow [role="radio"]');
  await expect(radios).toHaveCount(3);
  await expect(page.locator('#takedown-flow [role="radio"][aria-checked="true"]')).toHaveCount(1);
  await expect(page.getByRole("radio", { name: label })).toHaveAttribute("aria-checked", "true");
  // Visibility is real (display:none), and exactly one card + one caption show.
  const v = await visibleModes(page);
  expect(v.card).toEqual([mode]);
  expect(v.caption).toEqual([mode]);
  // The others carry the hidden attribute and compute to display:none.
  for (const m of ["manual", "approve", "auto"].filter((x) => x !== mode)) {
    for (const sel of [`.tf-card[data-m="${m}"]`, `p[data-m="${m}"]`]) {
      const el = stage3(page).locator(sel);
      await expect(el).toBeHidden();
      await expect(el).toHaveAttribute("hidden", "");
      expect(await el.evaluate((e) => getComputedStyle(e).display)).toBe("none");
    }
  }
}

// ── desktop ─────────────────────────────────────────────────────────────

test.describe("Takedown flow (desktop)", () => {
  test.use({ viewport: DESKTOP });

  test("five stages in order; the old How-It-Works 01-04 strip is gone", async ({ page }) => {
    await openHome(page);
    await flow(page).scrollIntoViewIfNeeded();
    const stages = page.locator("#takedown-flow .tf-flow > li.tf-st");
    await expect(stages).toHaveCount(5);
    const names = (await stages.locator(".tf-sn").allTextContents()).map((t) => t.replace(/^\s*\d+/, "").trim());
    expect(names).toEqual(STAGES);
    for (let i = 0; i < 5; i++) await expect(stages.nth(i)).toBeVisible();
    // Numbered 1..5.
    expect((await stages.locator(".tf-sn > span").allTextContents()).map((t) => t.trim())).toEqual(["1", "2", "3", "4", "5"]);

    // Old strip: no .how-it-works / .steps-row / .step-num, no "01".."04" step numbers.
    await expect(page.locator(".how-it-works, .steps-row, .step-num")).toHaveCount(0);
    await expect(page.getByText("How It Works", { exact: true })).toHaveCount(0);
    await expect(page.getByText("We file the takedowns.")).toHaveCount(0);
  });

  test("automation switch: radiogroup of 3, Approve first checked by default", async ({ page }) => {
    await openHome(page);
    const group = page.getByRole("radiogroup", { name: "Automation level" });
    await expect(group).toBeVisible();
    const radios = group.getByRole("radio");
    await expect(radios).toHaveCount(3);
    expect((await radios.allTextContents()).map((t) => t.trim())).toEqual(MODES);
    await expectMode(page, "approve", "Approve first");
    // Roving tabindex: only the checked radio is in the tab order.
    await expect(page.getByRole("radio", { name: "Approve first" })).toHaveAttribute("tabindex", "0");
    await expect(page.getByRole("radio", { name: "Manual" })).toHaveAttribute("tabindex", "-1");
    await expect(page.getByRole("radio", { name: "Automatic" })).toHaveAttribute("tabindex", "-1");
  });

  test("clicking a radio swaps stage 3 card + caption and truly hides the rest", async ({ page }) => {
    await openHome(page);
    await flow(page).scrollIntoViewIfNeeded();
    await page.getByRole("radio", { name: "Manual" }).click();
    await expectMode(page, "manual", "Manual");
    await expect(stage3(page)).toContainText("Draft ready");
    await expect(stage3(page)).toContainText("You approve each one, and our team files it.");

    await page.getByRole("radio", { name: "Automatic" }).click();
    await expectMode(page, "auto", "Automatic");
    await expect(stage3(page)).toContainText("Within your monthly limit");
    await expect(stage3(page)).toContainText("Filed automatically within your rules and any monthly limit you set.");

    await page.getByRole("radio", { name: "Approve first" }).click();
    await expectMode(page, "approve", "Approve first");
    await expect(stage3(page)).toContainText("Waiting for your approval");
  });

  test("arrow keys move and wrap the selection, focus follows", async ({ page }) => {
    await openHome(page);
    await flow(page).scrollIntoViewIfNeeded();
    const approve = page.getByRole("radio", { name: "Approve first" });
    await approve.focus();

    await page.keyboard.press("ArrowRight");
    await expectMode(page, "auto", "Automatic");
    await expect(page.getByRole("radio", { name: "Automatic" })).toBeFocused();

    await page.keyboard.press("ArrowRight"); // wraps to Manual
    await expectMode(page, "manual", "Manual");
    await expect(page.getByRole("radio", { name: "Manual" })).toBeFocused();

    await page.keyboard.press("ArrowLeft"); // wraps back to Automatic
    await expectMode(page, "auto", "Automatic");

    await page.keyboard.press("ArrowDown"); // Down == Right
    await expectMode(page, "manual", "Manual");
    await page.keyboard.press("ArrowUp"); // Up == Left
    await expectMode(page, "auto", "Automatic");
    // A non-arrow key changes nothing.
    await page.keyboard.press("a");
    await expectMode(page, "auto", "Automatic");
  });

  test("'How takedowns work' resolves to campaign-intelligence#takedowns; Scan CTA targets /scan", async ({ page }) => {
    await openHome(page);
    const how = page.locator('#takedown-flow a[data-cta="takedownflow-how"]');
    await expect(how).toHaveText(/How takedowns work/);
    const howHref = (await how.getAttribute("href")) ?? "";
    expect(howHref).toMatch(/\/platform\/campaign-intelligence#takedowns$/);
    const [howPath, hash] = howHref.split("#");
    const res = await page.request.get(howPath);
    expect(res.status()).toBe(200);
    expect(await res.text()).toMatch(new RegExp(`\\bid=["']${hash}["']`));

    const scan = page.locator('#takedown-flow a[data-cta="takedownflow-scan"]');
    await expect(scan).toHaveText(/Scan your domain/);
    const scanHref = (await scan.getAttribute("href")) ?? "";
    expect(scanHref).toMatch(/\/scan$/);
    // /scan is served by the Worker, not built by Astro, so a static preview
    // 404s it. Assert it matches the site's other scan CTA instead of fetching.
    await expect(page.locator('a[data-cta="nav-scan"]').first()).toHaveAttribute("href", scanHref);

    // Following the link lands on the page with the anchor present.
    await how.scrollIntoViewIfNeeded();
    await how.click();
    await expect(page).toHaveURL(/\/platform\/campaign-intelligence#takedowns$/);
    await expect(page.locator("#takedowns")).toHaveCount(1);
  });

  test("disclosure guard: section text has no forbidden claim words", async ({ page }) => {
    await openHome(page);
    // textContent includes hidden mode variants and the mobile list too.
    const text = ((await flow(page).textContent()) ?? "").toLowerCase();
    expect(text.length).toBeGreaterThan(200); // guard against an empty read
    for (const word of FORBIDDEN_IN_SECTION) {
      expect(text, `section must not contain "${word}"`).not.toContain(word.toLowerCase());
    }
  });
});

// ── no JavaScript ───────────────────────────────────────────────────────

test.describe("Takedown flow (JS disabled)", () => {
  test("server HTML shows Approve first only; switch stays hidden", async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL, javaScriptEnabled: false, viewport: DESKTOP });
    try {
      const page = await context.newPage();
      await page.goto("/");
      await flow(page).scrollIntoViewIfNeeded();
      // A switch that does nothing without JS must not be shown.
      await expect(page.locator("#takedown-flow [data-tf-mode]")).toBeHidden();
      await expect(page.getByRole("radiogroup")).toHaveCount(0);

      const v = await visibleModes(page);
      expect(v.card).toEqual(["approve"]);
      expect(v.caption).toEqual(["approve"]);
      await expect(stage3(page)).toContainText("Waiting for your approval");
      await expect(stage3(page)).toContainText("Takedowns outside your rules wait until someone on your team approves them.");
      for (const m of ["manual", "auto"]) {
        await expect(stage3(page).locator(`.tf-card[data-m="${m}"]`)).toBeHidden();
        await expect(stage3(page).locator(`p[data-m="${m}"]`)).toBeHidden();
      }
      await expect(page.locator("#takedown-flow .tf-flow > li.tf-st")).toHaveCount(5);
    } finally {
      await context.close();
    }
  });
});

// ── phone ───────────────────────────────────────────────────────────────

test.describe("Takedown flow (390px)", () => {
  test.use({ viewport: PHONE });

  test("vertical timeline with 5 items, switch + flow hidden, no horizontal scroll", async ({ page }) => {
    await openHome(page);
    await flow(page).scrollIntoViewIfNeeded();
    const items = page.locator("#takedown-flow .tf-mlist > li");
    await expect(page.locator("#takedown-flow .tf-mlist")).toBeVisible();
    await expect(items).toHaveCount(5);
    for (let i = 0; i < 5; i++) await expect(items.nth(i)).toBeVisible();
    const titles = await items.locator("b").allTextContents();
    expect(titles.map((t) => t.trim())).toEqual(STAGES);

    await expect(page.locator("#takedown-flow .tf-flow")).toBeHidden();
    await expect(page.locator("#takedown-flow [data-tf-mode]")).toBeHidden();
    await expect(page.getByRole("radiogroup", { name: "Automation level" })).toBeHidden();

    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(scrollWidth, "page wider than viewport").toBeLessThanOrEqual(clientWidth);
    // The section itself stays inside the viewport.
    const box = await flow(page).boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(PHONE.width);
  });
});

// ── site-wide ───────────────────────────────────────────────────────────

test("site-wide: no built page contains 'blocklist'", async ({ page }) => {
  for (const path of SITE_PAGES) {
    const res = await page.request.get(path);
    expect(res.status(), `${path} should resolve`).toBe(200);
    const html = (await res.text()).toLowerCase();
    expect(html.length, `${path} body should not be empty`).toBeGreaterThan(1000);
    expect(html, `${path} must not contain "blocklist"`).not.toContain("blocklist");
  }
});
