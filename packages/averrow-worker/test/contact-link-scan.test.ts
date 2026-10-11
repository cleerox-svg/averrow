import { describe, it, expect, vi, beforeEach } from "vitest";

const rdapLookup = vi.fn();
const checkGoogleSafeBrowsing = vi.fn();
vi.mock("../src/lib/whois", () => ({ rdapLookup: (...a: unknown[]) => rdapLookup(...a) }));
vi.mock("../src/feeds/googleSafeBrowsing", () => ({
  checkGoogleSafeBrowsing: (...a: unknown[]) => checkGoogleSafeBrowsing(...a),
}));

import { defangLink, findLinks, scanContactLinks } from "../src/lib/contact-link-scan";
import { buildContactEmail, buildContactSubject, contactMessageForEmail } from "../src/lib/contact-notify";
import type { Env } from "../src/types";

const NOW = Date.parse("2026-10-11T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

const DAYSIDE_MESSAGE = [
  "Hi,",
  "",
  "Dayside Media publishes independent articles.",
  "",
  "You can check your current visibility at dayside.media/visibility-check.",
  "",
  "Best regards,",
  "Amy Jackson",
  "amy@daysidemedia.com",
].join("\n");

interface Rows { threatDomains?: string[]; threatUrls?: string[]; lookalikes?: string[]; fail?: boolean }

function makeEnv(rows: Rows = {}, gsbKey: string | undefined = "k"): Env {
  const prepare = (sql: string) => ({
    bind: (...args: unknown[]) => ({
      all: async () => {
        if (rows.fail) throw new Error("D1 down");
        const set = new Set(args as string[]);
        if (sql.includes("malicious_domain IN")) {
          return { results: (rows.threatDomains ?? []).filter((d) => set.has(d)).map((d) => ({ d, t: "phishing" })) };
        }
        if (sql.includes("malicious_url IN")) {
          return { results: (rows.threatUrls ?? []).filter((u) => set.has(u)).map((u) => ({ u, t: "phishing" })) };
        }
        return { results: (rows.lookalikes ?? []).filter((d) => set.has(d)).map((d) => ({ d })) };
      },
    }),
  });
  return { DB: { prepare }, GOOGLE_SAFE_BROWSING_KEY: gsbKey } as unknown as Env;
}

beforeEach(() => {
  rdapLookup.mockReset().mockResolvedValue({ registrar: null, registrationDate: daysAgo(3000), expirationDate: null });
  checkGoogleSafeBrowsing.mockReset().mockImplementation(async (urls: string[]) =>
    urls.map(() => ({ flagged: false, threatType: null, checked: true })));
});

describe("findLinks", () => {
  it("finds a bare host+path link and ignores the email address", () => {
    const links = findLinks(DAYSIDE_MESSAGE);
    expect(links.map((l) => l.raw)).toEqual(["dayside.media/visibility-check"]);
    expect(links[0]!.href).toBe("https://dayside.media/visibility-check");
    expect(DAYSIDE_MESSAGE.slice(links[0]!.start, links[0]!.end)).toBe("dayside.media/visibility-check");
  });

  it("finds scheme URLs, strips trailing punctuation, skips file names and dotted local parts", () => {
    const links = findLinks("See (https://example.com/a?b=1). Built with Node.js, see report.pdf, mail first.last@x.com or www.foo.org and paypal-secure.sh/verify");
    expect(links.map((l) => l.raw)).toEqual(["https://example.com/a?b=1", "www.foo.org", "paypal-secure.sh/verify"]);
  });

  it("never matches the ASCII tail of a mixed-script or prefixed token", () => {
    expect(findLinks("visit p\u0430ypal.com today")).toEqual([]);
    expect(findLinks("xhttps://evil.com/login")).toEqual([]);
  });

  it("drops a trailing dot from the host", () => {
    expect(findLinks("https://login.evil.com./x")[0]!.host).toBe("login.evil.com");
  });
});

describe("defangLink", () => {
  it("breaks the scheme and every dot", () => {
    expect(defangLink("https://evil.example/x.html")).toBe("hxxps://evil[.]example/x[.]html");
  });
});

describe("scanContactLinks", () => {
  it("makes no queries or requests when there are no links", async () => {
    const env = makeEnv({ fail: true });
    expect(await scanContactLinks(env, "hello there", "a@b.com", NOW)).toEqual({ links: [], checks: [] });
    expect(rdapLookup).not.toHaveBeenCalled();
  });

  it("marks a long-registered, unlisted link clean and notes the sender-domain mismatch", async () => {
    const r = await scanContactLinks(makeEnv(), DAYSIDE_MESSAGE, "amy@daysidemedia.com", NOW);
    expect(r.links).toHaveLength(1);
    expect(r.links[0]!.verdict).toBe("clean");
    expect(r.links[0]!.notes.join(" ")).toContain("different domain from the sender's email (daysidemedia.com)");
  });

  it("flags a domain in the threats table, including via any parent domain", async () => {
    const env = makeEnv({ threatDomains: ["login.dayside.media"] });
    const r = await scanContactLinks(env, "go to https://x.login.dayside.media/x and https://login.dayside.media./y", null, NOW);
    expect(r.links.map((l) => l.verdict)).toEqual(["flagged", "flagged"]);
    expect(r.links[0]!.reasons[0]).toContain("known active threat");
  });

  it("matches a threat URL stored without the trailing slash", async () => {
    const r = await scanContactLinks(makeEnv({ threatUrls: ["https://old-site.com"] }), "see https://old-site.com", null, NOW);
    expect(r.links[0]!.verdict).toBe("flagged");
  });

  it("leaves a link unchecked when its domain age is unknown (e.g. a hosting-platform subdomain)", async () => {
    rdapLookup.mockResolvedValue(null);
    const r = await scanContactLinks(makeEnv(), "https://paypal-verify.pages.dev/login", null, NOW);
    expect(r.links[0]!.verdict).toBe("unchecked");
  });

  it("leaves links unchecked when Safe Browsing is not configured", async () => {
    const r = await scanContactLinks(makeEnv({}, ""), "https://ok-site.com/", null, NOW);
    expect(r.links[0]!.verdict).toBe("unchecked");
    expect(checkGoogleSafeBrowsing).not.toHaveBeenCalled();
  });

  it("asks Safe Browsing without its cache", async () => {
    await scanContactLinks(makeEnv(), "https://ok-site.com/", null, NOW);
    expect(checkGoogleSafeBrowsing.mock.calls[0]![2]).toEqual({ useCache: false });
  });

  it("flags a registered look-alike", async () => {
    const r = await scanContactLinks(makeEnv({ lookalikes: ["paypa1.com"] }), "https://paypa1.com/", null, NOW);
    expect(r.links[0]!.verdict).toBe("flagged");
  });

  it("flags a newly registered domain", async () => {
    rdapLookup.mockResolvedValue({ registrar: null, registrationDate: daysAgo(5), expirationDate: null });
    const r = await scanContactLinks(makeEnv(), "https://fresh-site.com/", null, NOW);
    expect(r.links[0]!.verdict).toBe("flagged");
    expect(r.links[0]!.reasons.join()).toContain("registered 5 days ago");
  });

  it("flags Safe Browsing hits and fails closed when Safe Browsing does not answer", async () => {
    checkGoogleSafeBrowsing.mockResolvedValueOnce([{ flagged: true, threatType: "SOCIAL_ENGINEERING", checked: true }]);
    let r = await scanContactLinks(makeEnv(), "https://bad-site.com/", null, NOW);
    expect(r.links[0]!.verdict).toBe("flagged");

    checkGoogleSafeBrowsing.mockResolvedValueOnce([{ flagged: false, threatType: null, checked: false }]);
    r = await scanContactLinks(makeEnv(), "https://ok-site.com/", null, NOW);
    expect(r.links[0]!.verdict).toBe("unchecked");
  });

  it("fails closed when the intel query fails", async () => {
    const r = await scanContactLinks(makeEnv({ fail: true }), "https://ok-site.com/", null, NOW);
    expect(r.links[0]!.verdict).toBe("unchecked");
  });

  it("flags deceptive structure without any lookup", async () => {
    const r = await scanContactLinks(makeEnv(), "https://averrow.com@evil.example/ and http://192.168.1.1/x and http://localhost:8787/a and http://metadata.google.internal/", null, NOW);
    expect(r.links.map((l) => l.verdict)).toEqual(["flagged", "flagged", "flagged", "flagged"]);
  });
});

describe("buildContactEmail with a scan", () => {
  const notice = {
    id: "sub-1", name: "Amy", email: "amy@daysidemedia.com", company: "evil.example/promo",
    companySize: null, interest: "general", domain: null, message: DAYSIDE_MESSAGE,
  };

  it("renders a clean link as an anchor whose text is its destination", async () => {
    const scan = await scanContactLinks(makeEnv(), DAYSIDE_MESSAGE, notice.email, NOW);
    const { html, text } = buildContactEmail(notice, scan);
    expect(html).toContain('<a href="https://dayside.media/visibility-check" dir="ltr" target="_blank" rel="noopener noreferrer"');
    expect(html).toContain("different domain from the sender&#39;s email (daysidemedia.com)");
    expect(text).toContain("https://dayside.media/visibility-check");
    // Links typed into other fields are never clickable.
    expect(html).toContain("evil[.]example/promo");
  });

  it("defangs a flagged link and never emits an anchor for it", async () => {
    const scan = await scanContactLinks(makeEnv({ threatDomains: ["dayside.media"] }), DAYSIDE_MESSAGE, notice.email, NOW);
    const { html, text } = buildContactEmail(notice, scan);
    expect(html).not.toContain("<a ");
    expect(html).toContain("dayside[.]media/visibility-check");
    expect(text).toContain("dayside[.]media/visibility-check [flagged:");
  });

  it("strips bidi controls so a clean link's text cannot be visually reversed", async () => {
    const message = "Please review \u202Ehttps://attacker.xyz/moc.lapyap//:sptth";
    const n = { ...notice, message };
    const scan = await scanContactLinks(makeEnv(), contactMessageForEmail(message).text, n.email, NOW);
    const { html, text } = buildContactEmail(n, scan);
    expect(html).not.toContain("\u202E");
    expect(text).not.toContain("\u202E");
    expect(html).toContain('dir="ltr"');
  });

  it("defangs link-like text the scanner did not pick up, in the message, fields and subject", async () => {
    const message = "xhttps://evil.com/login and /evil.org/x and p\u0430ypal.com";
    const n = { ...notice, company: "https://evil.biz", message };
    const scan = await scanContactLinks(makeEnv(), contactMessageForEmail(message).text, n.email, NOW);
    const { html, text, subject } = buildContactEmail(n, scan);
    expect(html).not.toContain("https://evil");
    expect(text).toContain("xhxxps://evil[.]com/login");
    expect(text).toContain("/evil[.]org/x");
    expect(text).toContain("p\u0430ypal[.]com");
    expect(html).toContain("hxxps://evil[.]biz");
    expect(subject).toContain("hxxps://evil[.]biz");
    expect(buildContactSubject(n)).toBe(subject);
  });

  it("cuts a long message back to whitespace so a straddling link is dropped whole", () => {
    const message = `${"a ".repeat(2496)}https://login-microsoft.com/path`;
    const m = contactMessageForEmail(message);
    expect(m.truncated).toBe(true);
    expect(m.text).not.toContain("login-microsoft");
    expect(findLinks(m.text)).toEqual([]);
  });
});
