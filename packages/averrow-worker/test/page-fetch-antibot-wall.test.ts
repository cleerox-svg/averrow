/**
 * REC 4 — cloaking-as-signal, fetcher-side marker extraction
 * (`lib/page-fetch.ts` `parseSuspectHtml` + the `cf-mitigated` header
 * reconciliation in `fetchSuspectPage`).
 *
 * `parseSuspectHtml` streams HTML through the real Workers-runtime global
 * `HTMLRewriter`, which is NOT present in this package's plain-node vitest
 * environment (no `@cloudflare/vitest-pool-workers` / miniflare pool wired
 * up here — confirmed via package.json, same class of gap noted in
 * test/phishing-pattern-writer.test.ts and test/velocity-writer.test.ts for
 * the missing D1 harness). `test/page-fetch-ssrf.test.ts` already works
 * around this by never calling `parseSuspectHtml` directly.
 *
 * To exercise the actual marker-extraction + precedence logic against real
 * fixture HTML (rather than skip it), this file installs a MINIMAL,
 * test-only `HTMLRewriter` polyfill scoped to exactly the selectors
 * `parseSuspectHtml` registers (`input`, `[class]`, `form`, `img`,
 * `script`, `link`, `meta`, `title`, `body`). It is a plain tag/attribute
 * tokenizer over CONTROLLED fixture strings — not a general HTML parser,
 * and not subject to the SSRF-attacker-input regex constraints that govern
 * the real fetcher (this never runs on live/attacker HTML). It is
 * installed only for the duration of this file (afterAll restores the
 * prior global) so it cannot leak into other test files.
 *
 * If a real workers pool is ever wired into this package, this shim can be
 * deleted in favor of running these same fixtures against the genuine
 * HTMLRewriter — the assertions below describe the real contract either way.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  parseSuspectHtml,
  fetchSuspectPage,
  type FetchDeps,
} from "../src/lib/page-fetch";

// ─── Minimal HTMLRewriter test double ─────────────────────────────────────

type ElementHandler = { getAttribute(name: string): string | null };
type Handler = { element?: (el: ElementHandler) => void; text?: (t: { text: string }) => void };

const VOID_TAGS = new Set(["input", "img", "link", "meta", "br", "hr"]);

function runFakeRewrite(html: string, regs: Array<{ selector: string; handler: Handler }>): void {
  const stack: string[] = [];

  const fireElement = (tagName: string, attrs: Record<string, string>) => {
    const el: ElementHandler = {
      getAttribute: (name: string) => {
        const key = name.toLowerCase();
        return Object.prototype.hasOwnProperty.call(attrs, key) ? attrs[key] : null;
      },
    };
    for (const { selector, handler } of regs) {
      const matches = selector === tagName || (selector === "[class]" && "class" in attrs);
      if (matches && handler.element) handler.element(el);
    }
  };

  const fireText = (text: string) => {
    if (!text) return;
    const active = new Set(stack);
    for (const { selector, handler } of regs) {
      if (handler.text && active.has(selector)) handler.text({ text });
    }
  };

  let i = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      fireText(html.slice(i));
      break;
    }
    if (lt > i) fireText(html.slice(i, lt));

    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    const gt = html.indexOf(">", lt);
    if (gt === -1) break;
    const raw = html.slice(lt + 1, gt);
    i = gt + 1;
    if (!raw || raw.startsWith("!") || raw.startsWith("?")) continue;

    if (raw.startsWith("/")) {
      const name = raw.slice(1).trim().toLowerCase();
      const idx = stack.lastIndexOf(name);
      if (idx !== -1) stack.splice(idx, stack.length - idx);
      continue;
    }

    let body = raw.trim();
    let selfClosing = false;
    if (body.endsWith("/")) {
      selfClosing = true;
      body = body.slice(0, -1).trim();
    }
    const nameMatch = /^([a-zA-Z][a-zA-Z0-9]*)/.exec(body);
    if (!nameMatch) continue;
    const name = nameMatch[1].toLowerCase();
    const attrsStr = body.slice(nameMatch[1].length);
    const attrs: Record<string, string> = {};
    const attrRe = /([a-zA-Z0-9_:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    let am: RegExpExecArray | null;
    while ((am = attrRe.exec(attrsStr))) {
      const key = am[1].toLowerCase();
      attrs[key] = am[2] ?? am[3] ?? am[4] ?? "";
    }

    fireElement(name, attrs);
    if (!selfClosing && !VOID_TAGS.has(name)) stack.push(name);
  }
}

class FakeHTMLRewriter {
  private regs: Array<{ selector: string; handler: Handler }> = [];
  on(selector: string, handler: Handler): this {
    this.regs.push({ selector, handler });
    return this;
  }
  transform(response: Response): { arrayBuffer(): Promise<ArrayBuffer> } {
    const regs = this.regs;
    return {
      async arrayBuffer(): Promise<ArrayBuffer> {
        const buf = await response.arrayBuffer();
        const html = new TextDecoder().decode(buf);
        runFakeRewrite(html, regs);
        return new ArrayBuffer(0);
      },
    };
  }
}

let priorHTMLRewriter: unknown;

beforeAll(() => {
  priorHTMLRewriter = (globalThis as Record<string, unknown>).HTMLRewriter;
  (globalThis as Record<string, unknown>).HTMLRewriter = FakeHTMLRewriter;
});

afterAll(() => {
  (globalThis as Record<string, unknown>).HTMLRewriter = priorHTMLRewriter;
});

function bytes(html: string): Uint8Array {
  return new TextEncoder().encode(html);
}

// ─── Per-family marker extraction ─────────────────────────────────────────

describe("parseSuspectHtml — antiBotWall marker extraction per fetcher family", () => {
  it("turnstile: detected via cf-turnstile class", async () => {
    const html = `<html><body><div class="cf-turnstile" data-sitekey="x"></div></body></html>`;
    const s = await parseSuspectHtml(bytes(html));
    expect(s.antiBotWall).toBe("turnstile");
  });

  it("turnstile: detected via challenges.cloudflare.com script src", async () => {
    const html = `<html><head><script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script></head><body></body></html>`;
    const s = await parseSuspectHtml(bytes(html));
    expect(s.antiBotWall).toBe("turnstile");
  });

  it("class matching is whole-token: a widget class among other classes still matches", async () => {
    const html = `<html><body><div class="row g-recaptcha mt-2"></div></body></html>`;
    const s = await parseSuspectHtml(bytes(html));
    expect(s.antiBotWall).toBe("recaptcha");
  });

  it("class matching is whole-token: benign fragments do NOT collide (search-captcha, flag-recaptcha)", async () => {
    // Bare substring matching would falsely fire here — the vendor token must
    // be a whole class token delimited by whitespace/ends.
    const html = `<html><body>
      <div class="search-captcha-widget"></div>
      <div class="flag-recaptcha-badge"></div>
      <div class="xcf-turnstile-thing"></div>
    </body></html>`;
    const s = await parseSuspectHtml(bytes(html));
    expect(s.antiBotWall).toBeNull();
  });

  it("recaptcha: detected via g-recaptcha class", async () => {
    const html = `<html><body><div class="g-recaptcha" data-sitekey="y"></div></body></html>`;
    const s = await parseSuspectHtml(bytes(html));
    expect(s.antiBotWall).toBe("recaptcha");
  });

  it("recaptcha: detected via recaptcha script src", async () => {
    const html = `<html><head><script src="https://www.google.com/recaptcha/api.js"></script></head><body></body></html>`;
    const s = await parseSuspectHtml(bytes(html));
    expect(s.antiBotWall).toBe("recaptcha");
  });

  it("hcaptcha: detected via h-captcha class", async () => {
    const html = `<html><body><div class="h-captcha" data-sitekey="z"></div></body></html>`;
    const s = await parseSuspectHtml(bytes(html));
    expect(s.antiBotWall).toBe("hcaptcha");
  });

  it("hcaptcha: detected via hcaptcha.com script src", async () => {
    const html = `<html><head><script src="https://hcaptcha.com/1/api.js"></script></head><body></body></html>`;
    const s = await parseSuspectHtml(bytes(html));
    expect(s.antiBotWall).toBe("hcaptcha");
  });

  it("cf_challenge: detected via /cdn-cgi/challenge-platform/ script src", async () => {
    const html = `<html><head><script src="/cdn-cgi/challenge-platform/h/g/orchestrate/jsch/v1"></script></head><body></body></html>`;
    const s = await parseSuspectHtml(bytes(html));
    expect(s.antiBotWall).toBe("cf_challenge");
  });

  it("cf_challenge: detected via a title interstitial phrase (\"Just a moment\") with no widget markers", async () => {
    const html = `<html><head><title>Just a moment...</title></head><body>Please wait</body></html>`;
    const s = await parseSuspectHtml(bytes(html));
    expect(s.antiBotWall).toBe("cf_challenge");
  });

  it("cf_challenge: detected via a body interstitial phrase (\"checking your browser\")", async () => {
    const html = `<html><head><title>Redirecting</title></head><body>Checking your browser before continuing.</body></html>`;
    const s = await parseSuspectHtml(bytes(html));
    expect(s.antiBotWall).toBe("cf_challenge");
  });

  it("clean page: no widget, no challenge script, no interstitial phrase -> antiBotWall is null", async () => {
    const html = `<html><head><title>Acme — Sign in</title></head><body><form action="/login"><input type="password" /></form></body></html>`;
    const s = await parseSuspectHtml(bytes(html));
    expect(s.antiBotWall).toBeNull();
  });
});

// ─── Precedence: widget families outrank cf_challenge ─────────────────────

describe("parseSuspectHtml — antiBotWall family precedence", () => {
  it("a widget (turnstile class) appearing BEFORE a generic cf_challenge script wins", async () => {
    const html = `
      <html><body>
        <div class="cf-turnstile"></div>
        <script src="/cdn-cgi/challenge-platform/h/g/orchestrate/jsch/v1"></script>
      </body></html>`;
    const s = await parseSuspectHtml(bytes(html));
    expect(s.antiBotWall).toBe("turnstile");
  });

  it("a widget (recaptcha script) appearing AFTER a generic cf_challenge script still wins (rank, not document order)", async () => {
    const html = `
      <html><body>
        <script src="/cdn-cgi/challenge-platform/h/g/orchestrate/jsch/v1"></script>
        <script src="https://www.google.com/recaptcha/api.js"></script>
      </body></html>`;
    const s = await parseSuspectHtml(bytes(html));
    expect(s.antiBotWall).toBe("recaptcha");
  });

  it("hcaptcha class beats a cf_challenge interstitial phrase present in the same page", async () => {
    const html = `<html><head><title>Just a moment...</title></head><body><div class="h-captcha"></div></body></html>`;
    const s = await parseSuspectHtml(bytes(html));
    expect(s.antiBotWall).toBe("hcaptcha");
  });

  // Rank precedence is now order-independent on BOTH hooks: the `[class]`
  // hook was given the same `wallRank(candidate) < wallRank(antiBotWall)`
  // upgrade check the `script` hook already had, so a widget class marker
  // upgrades a cf_challenge recorded earlier in document order. (Previously
  // the `[class]` hook's blunt "if (antiBotWall) return;" made this
  // order-dependent — a cf_challenge script seen first would incorrectly
  // stick. Fixed alongside these tests.)
  it("a cf_challenge script encountered BEFORE a turnstile class IS upgraded by the later widget marker (rank, not document order)", async () => {
    const html = `
      <html><body>
        <script src="/cdn-cgi/challenge-platform/h/g/orchestrate/jsch/v1"></script>
        <div class="cf-turnstile"></div>
      </body></html>`;
    const s = await parseSuspectHtml(bytes(html));
    expect(s.antiBotWall).toBe("turnstile");
  });
});

// ─── cf-mitigated response header (fetchSuspectPage orchestration) ────────

function htmlResponse(body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", ...headers },
  });
}

function makeDeps(fetchImpl: (url: string) => Response): FetchDeps {
  return {
    resolve: async () => ["93.184.216.34"],
    fetchImpl: async (url: string) => fetchImpl(url),
  };
}

describe("fetchSuspectPage — cf-mitigated header only fills an empty slot", () => {
  it("a cf-mitigated: challenge header sets cf_challenge on an otherwise-clean page", async () => {
    const deps = makeDeps(() =>
      htmlResponse(`<html><body>hello</body></html>`, { "cf-mitigated": "challenge" }),
    );
    const r = await fetchSuspectPage("acme-secure-login.com", { deps });
    expect(r.ok).toBe(true);
    expect(r.signals?.antiBotWall).toBe("cf_challenge");
    expect(r.cfMitigated).toBe("challenge");
  });

  it("a cf-mitigated header does NOT override a widget family already found in the HTML", async () => {
    const deps = makeDeps(() =>
      htmlResponse(`<html><body><div class="cf-turnstile"></div></body></html>`, {
        "cf-mitigated": "challenge",
      }),
    );
    const r = await fetchSuspectPage("acme-secure-login.com", { deps });
    expect(r.ok).toBe(true);
    expect(r.signals?.antiBotWall).toBe("turnstile");
  });

  it("no cf-mitigated header and no in-HTML marker leaves antiBotWall null", async () => {
    const deps = makeDeps(() => htmlResponse(`<html><body>hello</body></html>`));
    const r = await fetchSuspectPage("acme-secure-login.com", { deps });
    expect(r.ok).toBe(true);
    expect(r.signals?.antiBotWall).toBeNull();
  });
});
