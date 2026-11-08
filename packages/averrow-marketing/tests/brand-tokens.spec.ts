import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/*
 * Facelift Phase 5 guard: the marketing site is indigo on graphite with
 * self-hosted Geist and the R3 logo (docs/brand/BRAND_BRIEF.md §9). Static
 * source checks, no browser needed.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(p);
    return /\.(astro|css|ts|tsx|mjs|mdx|md)$/.test(e.name) ? [p] : [];
  });
}
const files = sourceFiles(SRC).map((f) => ({ rel: path.relative(ROOT, f), text: fs.readFileSync(f, "utf8") }));

// Amber is a status colour only; its one definition lives in tokens.css.
const AMBER_ALLOWLIST = new Set(["src/styles/tokens.css"]);

test.describe("brand tokens, fonts and logo", () => {
  test("no Google Fonts and no legacy families anywhere in src", () => {
    for (const f of files) {
      expect(f.text, `${f.rel} loads Google Fonts`).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
      expect(f.text, `${f.rel} names Plus Jakarta Sans`).not.toMatch(/Plus Jakarta/i);
      expect(f.text, `${f.rel} names IBM Plex`).not.toMatch(/IBM Plex/i);
    }
  });

  test("amber hex / rgba appears only as the status token definition", () => {
    for (const f of files) {
      if (AMBER_ALLOWLIST.has(f.rel)) continue;
      expect(f.text, `${f.rel} hardcodes #E5A832`).not.toMatch(/E5A832/i);
      expect(f.text, `${f.rel} hardcodes rgba(229,168,50,…)`).not.toMatch(/rgba\(\s*229\s*,\s*168\s*,\s*50/);
    }
  });

  test("var(--amber) / var(--amber-text) only on allowlisted status sites", () => {
    // Status-only amber: pending / scheduled / "new" / "on request" / mid grade /
    // notice. Each entry is a selector (CSS rules) or markup pattern per file.
    const STATUS_SITES: Record<string, RegExp[]> = {
      "src/components/Coverage.astro": [/\.cv-pill\.new$/],
      "src/components/OperationStory.astro": [/\.pending$/, /track\.pending/],
      "src/components/TakedownFlow.astro": [/\.tf-bar i$/, /\.tf-pill\.amber$/],
      "src/components/product/IntegrationList.astro": [/em\.request$/],
      "src/components/product/SampleRows.astro": [/\.sr-pill\.(new|hold)$/],
      "src/pages/index.astro": [/width:29%;background:var\(--amber\)/], // hero takedown bar: pending share
      "src/pages/legal/dpa.astro": [/\.dpa-notice-card( svg)?$/, /\.dn-eyebrow$/, /\.dpa-pill-scheduled$/],
      "src/pages/platform.astro": [/em\.request$/],
      "src/pages/resources/sample-operation-report.astro": [/\.rep-pending$/],
      "src/pages/scan.astro": [/\[data-tone="mid"\]$/],
      "src/pages/security.astro": [/\.sec-status-pill\.scheduled(::before)?$/],
    };
    const amber = /var\(--amber(-text)?\)/;
    const offenders: string[] = [];
    for (const f of files) {
      if (AMBER_ALLOWLIST.has(f.rel)) continue;
      const allowed = STATUS_SITES[f.rel] ?? [];
      const ok = (s: string) => allowed.some((re) => re.test(s));
      const styles = f.rel.endsWith(".css")
        ? [f.text]
        : [...f.text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
      for (const css of styles) {
        for (const r of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
          if (!amber.test(r[2])) continue;
          // A selector list passes when every selector in it is a status site.
          const sels = r[1].replace(/\/\*[\s\S]*?\*\//g, "").split(",").map((s) => s.trim().replace(/\s+/g, " "));
          for (const s of sels) if (!ok(s)) offenders.push(`${f.rel}: ${s}`);
        }
      }
      const markup = f.rel.endsWith(".css") ? "" : f.text.replace(/<style[^>]*>[\s\S]*?<\/style>/g, "");
      for (const line of markup.split("\n")) {
        if (amber.test(line) && !ok(line)) offenders.push(`${f.rel}: ${line.trim()}`);
      }
    }
    expect(offenders, "amber is a status colour only (BRAND_BRIEF §8/§9)").toEqual([]);
  });

  test("tokens: indigo primary on graphite (dark) and indigo light", () => {
    const tokens = fs.readFileSync(path.join(SRC, "styles/tokens.css"), "utf8");
    expect(tokens).toMatch(/--primary:\s*#4c5cf8;/);
    expect(tokens).toMatch(/--bg-primary:\s*#0a0b0e;/);
    expect(tokens).toMatch(/--primary:\s*#3250f0;/);
    expect(tokens).toMatch(/--btn-primary-bg:\s*var\(--primary\);/);
    expect(tokens).toMatch(/--accent:\s*var\(--primary-text\);/);
  });

  test("self-hosted Geist, favicon, apple-touch and OG files exist", () => {
    for (const f of [
      "public/fonts/averrow-geist-sans-var.woff2",
      "public/fonts/averrow-geist-mono-var.woff2",
      "public/fonts/OFL.txt",
      "public/favicon-r3.svg",
      "public/favicon-r3.ico",
      "public/apple-touch-icon-r3.png",
      "public/brand/og-r3-2026.png",
      "public/brand/averrow-r3-512.png",
    ]) {
      expect(fs.existsSync(path.join(ROOT, f)), `${f} exists`).toBe(true);
    }
    const layout = fs.readFileSync(path.join(SRC, "layouts/Layout.astro"), "utf8");
    expect(layout).toContain('"/brand/og-r3-2026.png"');
    expect(layout).toContain("/favicon-r3.svg");
    expect(layout).toContain("/apple-touch-icon-r3.png");
    expect(layout).toContain("/brand/averrow-r3-512.png");
  });

  test("the OG image is 1200 x 630", () => {
    const png = fs.readFileSync(path.join(ROOT, "public/brand/og-r3-2026.png"));
    expect(png.readUInt32BE(16)).toBe(1200);
    expect(png.readUInt32BE(20)).toBe(630);
  });
});
