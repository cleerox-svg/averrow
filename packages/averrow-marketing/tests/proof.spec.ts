import { test, expect, type Page } from "@playwright/test";
import { buildBars, parseLive, roundLabel, utcStamp } from "../src/lib/proof";
import { buildStats } from "../scripts/fetch-stats.mjs";

/*
 * "By the numbers" (homepage), the sample operation report and the
 * methodology page. Pure-function tests run without a browser; the page
 * tests use the preview build, and the live-refresh tests mock
 * /api/v1/public/stats through Playwright routes.
 */

const STATS_URL = "**/api/v1/public/stats";

const livePayload = {
  success: true,
  data: {
    total_threats: 2_000_001,
    threats_today: 4321,
    providers_mapped: 13_456,
    countries: 199,
    active_feeds: 52,
    threat_types: [
      { threat_type: "phishing", count: 900_000 },
      { threat_type: "malware_distribution", count: 700_000 },
      { threat_type: "scanning", count: 300_000 },
      { threat_type: "brand_new_type", count: 100_000 },
    ],
    proof: { operations_tracked: 777, lookalikes_found_30d: 2_481, monitored_brands: 1_900, generated_at: "2031-03-04T05:06:07.000Z" },
  },
};

// ── pure functions ──────────────────────────────────────────────────────

test("buildBars groups, orders, drops tiny types and folds small unknowns", () => {
  const bars = buildBars([
    { threat_type: "scanning", count: 342_172 },
    { threat_type: "malicious_ip", count: 64_459 },
    { threat_type: "c2", count: 53_580 },
    { threat_type: "malware_distribution", count: 388_367 },
    { threat_type: "phishing", count: 235_237 },
    { threat_type: "malicious_ssl", count: 13 },
    { threat_type: "credential_harvesting", count: 4_552 },
    { threat_type: "typosquatting", count: 88_329 },
    { threat_type: "weird_new_kind", count: 2_000 },
  ]);
  expect(bars.map((b) => b.label)).toEqual([
    "Malware distribution",
    "Phishing",
    "Typosquatting",
    "Command & control",
    "Credential harvesting",
    "Infrastructure signals",
    "Other",
  ]);
  expect(bars.find((b) => b.label === "Infrastructure signals")).toMatchObject({ count: 406_631, group: true });
  expect(bars.some((b) => /ssl/i.test(b.label))).toBe(false);
});

test("buildBars title-cases an unknown id that is big enough to keep", () => {
  const bars = buildBars([
    { threat_type: "phishing", count: 1_000_000 },
    { threat_type: "brand_new_type", count: 500_000 },
  ]);
  expect(bars.map((b) => b.label)).toContain("Brand New Type");
});

test("parseLive keeps nulls per field and treats a 0 lookalike count as unmeasured", () => {
  const parsed = parseLive({ data: { total_threats: 5, threats_today: "x", proof: { lookalikes_found_30d: 0, operations_tracked: 9 } } });
  expect(parsed?.numbers).toMatchObject({
    total_threats: 5,
    threats_today: null,
    lookalikes_found_30d: null,
    operations_tracked: 9,
    providers_mapped: null,
    threat_types: null,
  });
  expect(parseLive("nonsense")).toBeNull();
});

test("labels and timestamps are deterministic", () => {
  expect(roundLabel(2347)).toBe("2,300+");
  expect(roundLabel(12154)).toBe("12,000+");
  expect(utcStamp("2026-10-05T11:38:41.888Z")).toBe("5 Oct 2026, 11:38 UTC");
  expect(utcStamp("not a date")).toBeNull();
});

test("buildStats captures the raw numbers and never publishes a 0 lookalike count", () => {
  const s = buildStats(
    {
      total_threats: 1_274_830,
      threats_detected: "1.2M+",
      providers_mapped: 12_154,
      threat_campaigns: 6097,
      countries: 215,
      active_feeds: 46,
      threats_today: 10_752,
      threat_types: [{ threat_type: "phishing", count: 235_237 }, { bad: true }],
      proof: { lookalikes_found_30d: 0, operations_tracked: 3067, monitored_brands: 1867, generated_at: "2026-10-05T11:38:41.888Z" },
    },
    "t",
    "src",
  );
  expect(s.live).toMatchObject({
    total_threats: 1_274_830,
    threats_today: 10_752,
    operations_tracked: 3067,
    lookalikes_found_30d: null,
    monitored_brands: 1867,
    threat_types: [{ threat_type: "phishing", count: 235_237 }],
  });
  expect(s.proof?.lookalikes_found_30d).toBeUndefined();
  expect(s.fallbacks?.lookalikes_found_30d).toBe("2,300+");
});

// ── homepage section ────────────────────────────────────────────────────

async function stub404(page: Page) {
  // The preview server has no API; make the "fetch fails" path explicit.
  await page.route(STATS_URL, (route) => route.abort());
}

test("homepage: By the numbers renders chart, table, tiles and check cards", async ({ page }) => {
  await stub404(page);
  await page.goto("/");
  const sec = page.locator("#by-the-numbers");
  await expect(sec.getByRole("heading", { level: 2 })).toContainText("What the platform sees");

  expect(await sec.locator(".num-bar").count()).toBeGreaterThanOrEqual(5);
  await expect(sec.locator(".num-bar").first()).toHaveAttribute("aria-label", /Malware distribution: [\d,]+ threats, [\d.]+% of classified/);
  await expect(sec.locator(".num-bar", { hasText: "Infrastructure signals" })).toHaveClass(/grp/);
  await expect(sec.locator(".num-bar", { hasText: /ssl/i })).toHaveCount(0);

  const rows = sec.locator(".num-sr tbody tr");
  expect(await rows.count()).toBeGreaterThanOrEqual(5);
  expect(await rows.count()).toBe(await sec.locator(".num-bar").count());

  await expect(sec.locator(".num-tile")).toHaveCount(6);
  await expect(sec.locator('[data-stat="sources"]')).toHaveText("40+");
  await expect(sec.locator('[data-stat="lookalikes"]')).not.toHaveText("0");
  await expect(sec.locator('[data-stat="lookalikes"]')).toHaveText(/\+$/);
  await expect(sec.getByText("new today")).toBeVisible();

  const hrefs = await sec.locator("[data-check]").evaluateAll((els) => els.map((e) => e.getAttribute("href")));
  expect(hrefs).toEqual(["/scan", "/changelog", "/status", "/resources/sample-operation-report"]);
  await expect(sec.locator("[data-check]").nth(1)).toContainText(/\d+ public releases, latest v\d+\.\d+\.\d+/);
  await expect(sec.getByRole("link", { name: /How we count each number/ })).toHaveAttribute("href", "/resources/methodology");

  // Honest trust line, no unverified compliance claims.
  await expect(sec.locator(".trust-line")).toContainText("SOC 2 Type I in preparation");
  await expect(sec.getByRole("link", { name: /Sub-processors listed in our DPA/ })).toHaveAttribute("href", "/legal/dpa");
});

test("homepage: old showcase and compliance claims are gone (home and pricing)", async ({ page }) => {
  await stub404(page);
  for (const path of ["/", "/pricing"]) {
    await page.goto(path);
    const text = await page.locator("main").innerText();
    expect(text, path).not.toMatch(/PIPEDA|GDPR-aligned|Built to protect brands across|Inside the platform/i);
    await expect(page.locator(".trust-sector")).toHaveCount(0);
  }
  await page.goto("/pricing");
  await expect(page.locator(".trust-line")).toContainText("Customer data is never used in public numbers");
});

test("homepage: hero operation card links to the sample report", async ({ page }) => {
  await stub404(page);
  await page.goto("/");
  await expect(page.getByRole("link", { name: /View sample report/ })).toHaveAttribute("href", "/resources/sample-operation-report");
});

test("tooltip shows exact count and share on focus", async ({ page }) => {
  await stub404(page);
  await page.goto("/");
  const bar = page.locator("#by-the-numbers .num-bar").nth(1);
  await bar.focus();
  const tip = page.locator("#by-the-numbers [data-tip]");
  await expect(tip).toBeVisible();
  await expect(tip).toContainText(/Phishing/);
  await expect(tip).toContainText(/\d{3},\d{3}/);
  await expect(tip).toContainText(/\d+\.\d%/);
});

// ── live refresh ────────────────────────────────────────────────────────

test("live refresh: values, chart and timestamp update from /api/v1/public/stats", async ({ page }) => {
  await page.route(STATS_URL, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(livePayload) }));
  await page.goto("/");
  const sec = page.locator("#by-the-numbers");
  await expect(sec.locator('[data-stat="today"]')).toHaveText("4,321");
  await expect(sec.locator('[data-stat="ops"]')).toHaveText("777");
  await expect(sec.locator('[data-stat="lookalikes"]')).toHaveText("2,400+");
  await expect(sec.locator('[data-stat="brands"]')).toHaveText("1,900");
  await expect(sec.locator('[data-stat="providers"]')).toHaveText("13,000+");
  await expect(sec.locator('[data-stat="countries"]')).toHaveText("199");
  await expect(sec.locator('[data-stat="sources"]')).toHaveText("40+");
  await expect(sec.locator('[data-stat="total_threats"]')).toHaveText("2,000,001");
  await expect(sec.locator("[data-stamp]")).toHaveText("Refreshed 4 Mar 2031, 05:06 UTC");
  await expect(sec).toHaveAttribute("data-state", "live");
  // Chart re-rendered from the mocked types: unknown id title-cased, scanning grouped.
  await expect(sec.locator(".num-bar", { hasText: "Brand New Type" })).toHaveCount(1);
  await expect(sec.locator(".num-bar", { hasText: "Infrastructure signals" })).toHaveCount(1);
  expect(await sec.locator(".num-sr tbody tr").count()).toBe(await sec.locator(".num-bar").count());
});

test("live refresh: a null field keeps its fallback while others update", async ({ page }) => {
  await page.route(STATS_URL, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ success: true, data: { threats_today: 99, proof: { lookalikes_found_30d: 0, operations_tracked: null } } }),
    }),
  );
  await page.goto("/");
  const sec = page.locator("#by-the-numbers");
  const opsBefore = await sec.locator('[data-stat="ops"]').innerText();
  await expect(sec.locator('[data-stat="today"]')).toHaveText("99");
  await expect(sec.locator('[data-stat="ops"]')).toHaveText(opsBefore);
  await expect(sec.locator('[data-stat="lookalikes"]')).toHaveText(/\+$/);
  expect(await sec.locator(".num-bar").count()).toBeGreaterThanOrEqual(5);
});

test("live refresh: a failed request leaves the build snapshot in place", async ({ page }) => {
  await page.route(STATS_URL, (route) => route.fulfill({ status: 500, body: "boom" }));
  await page.goto("/");
  const sec = page.locator("#by-the-numbers");
  const todayBefore = await sec.locator('[data-stat="today"]').innerText();
  await page.waitForTimeout(500);
  await expect(sec.locator("[data-stamp]")).toHaveText(/^Build snapshot, \d{1,2} \w{3} \d{4}$/);
  await expect(sec.locator('[data-stat="today"]')).toHaveText(todayBefore);
  await expect(sec).not.toHaveAttribute("data-state", "live");
  expect(await sec.locator(".num-bar").count()).toBeGreaterThanOrEqual(5);

  await page.unroute(STATS_URL);
  await page.route(STATS_URL, (route) => route.abort());
  await page.reload();
  await page.waitForTimeout(500);
  await expect(sec.locator("[data-stamp]")).toHaveText(/^Build snapshot/);
});

// ── new pages ───────────────────────────────────────────────────────────

test("/resources/sample-operation-report: illustrative label, 14 indicators, no real-looking domains", async ({ page }) => {
  const res = await page.goto("/resources/sample-operation-report");
  expect(res?.status()).toBe(200);
  await expect(page.locator("h1")).toContainText("OP-2291");
  await expect(page.locator(".rep-illustrative")).toContainText("Illustrative example · names, domains and infrastructure changed");
  await expect(page.locator('table[aria-label], [aria-label="Linked indicators table"] tbody tr')).toHaveCount(14);

  const main = await page.locator("main").innerText();
  // Every hostname on the page must be on the reserved .example TLD.
  const hosts = main.match(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|co|ca|app|ai|xyz|info)\b/gi) ?? [];
  expect(hosts, `real-looking hosts: ${hosts.join(", ")}`).toHaveLength(0);
  // Documentation ranges only: no other IPv4 literal.
  const ips = main.match(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g) ?? [];
  for (const ip of ips) expect(ip).toMatch(/^(192\.0\.2|198\.51\.100|203\.0\.113)\./);
  const asns = main.match(/AS\d+/g) ?? [];
  for (const a of asns) expect(Number(a.slice(2))).toBeGreaterThanOrEqual(64500);
  expect(main).not.toMatch(/\b(sentinel|nexus|cartographer|analyst agent)\b/i);
});

test("/resources/methodology: a section per published number", async ({ page }) => {
  const res = await page.goto("/resources/methodology");
  expect(res?.status()).toBe(200);
  await expect(page.locator("h1")).toHaveText("How we count");
  expect(await page.locator(".meth-item").count()).toBeGreaterThanOrEqual(8);
  await expect(page.locator(".meth-item").first()).toContainText("What it excludes");
  await expect(page.locator("main")).toContainText("cached for up to 5 minutes");
  await expect(page.locator("#brands-monitored")).toContainText("catalog");
});

test("resources hub and sitemap list the new pages", async ({ page, request }) => {
  await page.goto("/resources");
  await expect(page.locator('a[href="/resources/sample-operation-report"]')).toBeVisible();
  await expect(page.locator('a[href="/resources/methodology"]')).toBeVisible();
  const body = await (await request.get("/sitemap.xml")).text();
  expect(body).toContain("/resources/sample-operation-report");
  expect(body).toContain("/resources/methodology");
});

// ── responsive ──────────────────────────────────────────────────────────

test("no horizontal overflow at 390px on the changed pages", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route(STATS_URL, (route) => route.abort());
  for (const path of ["/", "/pricing", "/resources", "/resources/sample-operation-report", "/resources/methodology"]) {
    await page.goto(path);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(over, `${path} overflows by ${over}px`).toBeLessThanOrEqual(0);
  }
});
