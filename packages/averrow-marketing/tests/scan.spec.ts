import { test, expect, type Page } from "@playwright/test";

/*
 * Free domain scan page (/scan/). The scan API is mocked with page.route,
 * so these tests never touch the Worker.
 */

const SCAN = {
  id: "scan_abc123",
  domain: "acme.example",
  checked_at: "2026-10-05T12:00:00Z",
  email: {
    grade: "C",
    spf: { status: "pass" },
    dkim: { found: true },
    dmarc: { policy: "none" },
    mx: { present: true },
    bimi: { present: false },
  },
  lookalikes: { checked: 38, registered: 6 },
};

function ok(data: unknown) {
  return { status: 200, contentType: "application/json", body: JSON.stringify({ success: true, data }) };
}
function fail(status: number, error: string) {
  return { status, contentType: "application/json", body: JSON.stringify({ success: false, error }) };
}

async function mockScan(page: Page, data: unknown = SCAN) {
  await page.route("**/api/brand-scan/public", (r) => r.fulfill(ok(data)));
}

test.describe("scan page: input and results", () => {
  test("input state, scan, results", async ({ page }) => {
    let posted: Record<string, unknown> | null = null;
    await page.route("**/api/brand-scan/public", (r) => {
      posted = r.request().postDataJSON();
      return r.fulfill(ok(SCAN));
    });
    await page.goto("/scan/");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("How exposed is your domain?");
    await expect(page.getByText("email authentication graded A+ to F")).toBeVisible();

    await page.getByLabel("Domain to scan").fill("https://www.Acme.example/path");
    await page.getByRole("button", { name: /^Scan/ }).click();

    const h1 = page.getByRole("heading", { level: 1 });
    await expect(h1).toHaveText("acme.example");
    expect(posted).toMatchObject({ domain: "www.acme.example" });
    expect(posted).not.toHaveProperty("turnstileToken");
    await expect(h1).toBeFocused();
    await expect(page).toHaveURL(/\?id=scan_abc123/);

    await expect(page.locator("#gradeLetter")).toHaveText("C");
    await expect(page.locator("#gradeSr")).toHaveText("Email authentication grade: C");
    await expect(page.locator('[data-check="dmarc"]')).toContainText("none");
    await expect(page.locator('[data-check="dkim"]')).toContainText("found");
    await expect(page.locator('[data-check="bimi"]')).toContainText("not set");
    await expect(page.locator("#emailSentence")).toContainText("DMARC isn't enforcing");
    await expect(page.locator("#lookRegistered")).toHaveText("6");
    await expect(page.locator("#lookSentence")).toContainText("Of 38 likely misspellings");
    await expect(page.getByRole("link", { name: /How to fix this/ })).toHaveAttribute("href", /\/platform\/email-security$/);
    await expect(page.getByText("They don't include any threat intelligence about your domain.")).toBeVisible();
    await expect(page.getByRole("link", { name: /See plans/ })).toBeVisible();
    await expect(page.locator("#scanLive")).toContainText("Scan complete");
  });

  test("results are escaped, never parsed as HTML", async ({ page }) => {
    await mockScan(page, { ...SCAN, domain: "<img src=x onerror=window.__pwn=1>.example" });
    await page.goto("/scan/?domain=acme.example");
    await expect(page.locator("#scanResults")).toBeVisible();
    await expect(page.locator("#scanTitle img")).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __pwn?: number }).__pwn)).toBeUndefined();
  });

  test("?domain= prefills and auto-runs", async ({ page }) => {
    await mockScan(page);
    await page.goto("/scan/?domain=acme.example");
    await expect(page.locator("#gradeLetter")).toHaveText("C");
  });

  test("?id= loads an existing result via GET", async ({ page }) => {
    let method = "";
    await page.route("**/api/brand-scan/public/scan_abc123", (r) => {
      method = r.request().method();
      return r.fulfill(ok(SCAN));
    });
    await page.goto("/scan/?id=scan_abc123");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("acme.example");
    expect(method).toBe("GET");
  });

  test("?id= not found falls back to the input with the error", async ({ page }) => {
    await page.route("**/api/brand-scan/public/nope", (r) => r.fulfill(fail(404, "Scan not found")));
    await page.goto("/scan/?id=nope");
    await expect(page.locator("#scanError")).toHaveText("Scan not found");
    await expect(page.getByLabel("Domain to scan")).toBeVisible();
  });

  test("grade colour tokens by band, grade letter always shown", async ({ page }) => {
    for (const [grade, tone] of [["A+", "ok"], ["B", "mid"], ["F", "bad"]] as const) {
      await mockScan(page, { ...SCAN, email: { ...SCAN.email, grade } });
      await page.goto("/scan/?domain=acme.example");
      await expect(page.locator("#gradeLetter")).toHaveText(grade);
      await expect(page.locator("#gradeLetter")).toHaveAttribute("data-tone", tone);
      await page.unroute("**/api/brand-scan/public");
    }
  });

  test("invalid domain is rejected client-side", async ({ page }) => {
    await page.goto("/scan/");
    await page.getByLabel("Domain to scan").fill("not a domain");
    await page.getByRole("button", { name: /^Scan/ }).click();
    await expect(page.locator("#scanError")).toContainText("valid domain");
  });

  for (const [status, msg] of [[400, "Invalid domain"], [403, "Verification failed"], [429, "Rate limit hit"], [503, "Verification unavailable"]] as const) {
    test(`API ${status} shows the server error and keeps the form`, async ({ page }) => {
      await page.route("**/api/brand-scan/public", (r) => r.fulfill(fail(status, msg)));
      await page.goto("/scan/");
      await page.getByLabel("Domain to scan").fill("acme.example");
      await page.getByRole("button", { name: /^Scan/ }).click();
      await expect(page.locator("#scanError")).toHaveText(msg);
      await expect(page.getByLabel("Domain to scan")).toHaveValue("acme.example");
      await expect(page.locator("#scanResults")).toBeHidden();
    });
  }

  test("shows loading state with no time promise beyond under a minute", async ({ page }) => {
    await page.route("**/api/brand-scan/public", async (r) => {
      await new Promise((res) => setTimeout(res, 700));
      await r.fulfill(ok(SCAN));
    });
    await page.goto("/scan/");
    await page.getByLabel("Domain to scan").fill("acme.example");
    await page.getByRole("button", { name: /^Scan/ }).click();
    await expect(page.locator("#scanLoading")).toBeVisible();
    await expect(page.locator("#scanLoading")).toContainText("Usually under a minute");
    await expect(page.locator("#scanResults")).toBeVisible();
  });
});

test.describe("scan page: report form", () => {
  async function toResults(page: Page) {
    await mockScan(page);
    await page.goto("/scan/?domain=acme.example");
    await expect(page.locator("#scanResults")).toBeVisible();
  }

  test("emailed delivery", async ({ page }) => {
    let body: Record<string, unknown> | null = null;
    await page.route("**/api/leads", (r) => { body = r.request().postDataJSON(); return r.fulfill(ok({ delivery: "emailed" })); });
    await toResults(page);
    await page.getByLabel("Work email for the full report").fill("jo@acme.example");
    await page.getByLabel(/Email me the report/).check();
    await page.getByRole("button", { name: "Send me the report" }).click();
    await expect(page.locator("#leadDone")).toHaveText("Report sent to jo@acme.example.");
    expect(body).toEqual({ email: "jo@acme.example", domain: "acme.example", scan_id: "scan_abc123", consent: true });
  });

  test("team follow-up delivery", async ({ page }) => {
    await page.route("**/api/leads", (r) => r.fulfill(ok({ delivery: "team_follow_up" })));
    await toResults(page);
    await page.getByLabel("Work email for the full report").fill("jo@other.example");
    await page.getByLabel(/Email me the report/).check();
    await page.getByRole("button", { name: "Send me the report" }).click();
    await expect(page.locator("#leadDone")).toHaveText("Our team will follow up with your report.");
  });

  test("consent is required, free mail is blocked, no request is sent", async ({ page }) => {
    let calls = 0;
    await page.route("**/api/leads", (r) => { calls++; return r.fulfill(ok({ delivery: "emailed" })); });
    await toResults(page);
    await page.getByLabel("Work email for the full report").fill("jo@acme.example");
    await page.getByRole("button", { name: "Send me the report" }).click();
    await expect(page.locator("#leadError")).toContainText("tick the box");
    await page.getByLabel(/Email me the report/).check();
    await page.getByLabel("Work email for the full report").fill("jo@gmail.com");
    await page.getByRole("button", { name: "Send me the report" }).click();
    await expect(page.locator("#leadError")).toContainText("business email");
    expect(calls).toBe(0);
    await expect(page.locator("#leadDone")).toBeHidden();
  });

  test("server error is shown and success is never claimed", async ({ page }) => {
    await page.route("**/api/leads", (r) => r.fulfill(fail(500, "Mail service down")));
    await toResults(page);
    await page.getByLabel("Work email for the full report").fill("jo@acme.example");
    await page.getByLabel(/Email me the report/).check();
    await page.getByRole("button", { name: "Send me the report" }).click();
    await expect(page.locator("#leadError")).toHaveText("Mail service down");
    await expect(page.locator("#leadDone")).toBeHidden();
    await expect(page.getByLabel("Work email for the full report")).toBeVisible();
  });

  test("HTTP 200 with success:false is an error", async ({ page }) => {
    await page.route("**/api/leads", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: false, error: "Nope" }) }));
    await toResults(page);
    await page.getByLabel("Work email for the full report").fill("jo@acme.example");
    await page.getByLabel(/Email me the report/).check();
    await page.getByRole("button", { name: "Send me the report" }).click();
    await expect(page.locator("#leadError")).toHaveText("Nope");
    await expect(page.locator("#leadDone")).toBeHidden();
  });

  test("privacy link in the consent line", async ({ page }) => {
    await toResults(page);
    await expect(page.locator(".scan-consent").getByRole("link", { name: "Privacy" })).toHaveAttribute("href", /\/privacy$/);
  });
});

test.describe("scan page: homepage hero + a11y + layout", () => {
  test("homepage hero keeps the no-JS POST /assess fallback", async ({ page }) => {
    await page.goto("/");
    const form = page.locator("form#scanForm");
    await expect(form).toHaveAttribute("action", /\/assess$/);
    await expect(form).toHaveAttribute("method", /post/i);
  });

  test("homepage hero with JS navigates to /scan/?domain=", async ({ page }) => {
    await page.route("**/scan/?domain=*", (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<title>x</title>" }));
    await page.goto("/");
    await page.locator("#domainInput").fill("acme.example");
    await Promise.all([
      page.waitForURL(/\/scan\/\?domain=acme\.example$/),
      page.locator("#scanForm button[type=submit]").click(),
    ]);
  });

  test("labelled inputs, live regions, keyboard-only flow", async ({ page }) => {
    await mockScan(page);
    await page.route("**/api/leads", (r) => r.fulfill(ok({ delivery: "emailed" })));
    await page.goto("/scan/");
    await expect(page.locator("#scanLive")).toHaveAttribute("role", "status");
    await expect(page.locator("#scanError")).toHaveAttribute("role", "alert");
    await page.getByLabel("Domain to scan").focus();
    await page.keyboard.type("acme.example");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
    await page.getByLabel("Work email for the full report").focus();
    await page.keyboard.type("jo@acme.example");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Space");
    await expect(page.getByLabel(/Email me the report/)).toBeChecked();
    await page.keyboard.press("Enter");
    await expect(page.locator("#leadDone")).toBeVisible();
  });

  test("exactly one h1 and card headings are h2", async ({ page }) => {
    await mockScan(page);
    await page.goto("/scan/?domain=acme.example");
    await expect(page.locator("#scanResults")).toBeVisible();
    await expect(page.locator("main h1")).toHaveCount(1);
    await expect(page.locator("#scanResults h2")).toHaveCount(3);
  });

  test("390px: cards stack, no horizontal overflow", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await mockScan(page);
    await page.goto("/scan/?domain=acme.example");
    await expect(page.locator("#scanResults")).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    const tops = await page.locator(".scan-card").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().left)));
    expect(new Set(tops).size).toBe(1);
  });

  test("reduced motion: spinner does not animate", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/scan/");
    await page.evaluate(() => { (document.getElementById("scanLoading") as HTMLElement).hidden = false; });
    const anim = await page.locator(".scan-spinner").evaluate((e) => getComputedStyle(e).animationName);
    expect(anim).toBe("none");
  });
});
