import { describe, it, expect } from "vitest";
import { matchNamedThreat, type NamedThreatEntry } from "../src/lib/named-threat-matcher";

// Mirror of the Kali365 seed in migration 0204, with its regex + keyword
// signatures compiled the way loadNamedThreatCatalog() would.
const KALI365: NamedThreatEntry = {
  id: "nt_kali365",
  name: "Kali365",
  aliases: ["Kali 365"],
  category: "phaas",
  technique: "device_code_phishing",
  severity: "high",
  keyword_signatures: ["device code", "devicelogin", "microsoft 365", "enter the code", "outlook"],
  regex_signatures: [
    /microsoft\.com\/devicelogin/i,
    /aka\.ms\/devicelogin/i,
  ],
  ioc_domains: [],
  ioc_urls: [],
  ioc_ips: [],
};

const EVILPROXY: NamedThreatEntry = {
  id: "nt_evilproxy",
  name: "EvilProxy",
  aliases: ["Storm-1167"],
  category: "phaas",
  technique: "aitm_phishing",
  severity: "high",
  keyword_signatures: ["evilproxy"],
  regex_signatures: [],
  ioc_domains: ["evil-proxy-c2.example"],
  ioc_urls: [],
  ioc_ips: [],
};

const CATALOG = [KALI365, EVILPROXY];

describe("matchNamedThreat", () => {
  it("names Kali365 from a device-login regex signature hit", () => {
    const m = matchNamedThreat(CATALOG, {
      subject: "Verify your device",
      body: "Go to https://microsoft.com/devicelogin and enter the code.",
      urls: [{ url: "https://microsoft.com/devicelogin", domain: "microsoft.com" }],
      technique: "device_code_phishing",
    });
    expect(m).not.toBeNull();
    expect(m?.name).toBe("Kali365");
    expect(m?.reasons.some((r) => r.startsWith("regex"))).toBe(true);
  });

  it("names a threat from an IOC domain match (strongest signal)", () => {
    const m = matchNamedThreat(CATALOG, {
      subject: "hi",
      body: "login here",
      urls: [{ url: "https://evil-proxy-c2.example/login", domain: "evil-proxy-c2.example" }],
    });
    expect(m?.name).toBe("EvilProxy");
    expect(m?.score).toBe(1);
  });

  it("names from technique match corroborated by >=2 keywords", () => {
    const m = matchNamedThreat(CATALOG, {
      subject: "Microsoft 365 sign-in",
      body: "Please enter the code — your device code is required for Outlook.",
      urls: [],
      technique: "device_code_phishing",
    });
    expect(m?.name).toBe("Kali365");
  });

  it("does NOT name on a single keyword hit with no strong signal", () => {
    const m = matchNamedThreat(CATALOG, {
      subject: "Your Outlook calendar",
      body: "Here is your weekly Outlook summary.",
      urls: [],
    });
    // 'outlook' is a single keyword, no technique, no regex/IOC → no name.
    expect(m).toBeNull();
  });

  it("does NOT name on technique match with only one keyword", () => {
    const m = matchNamedThreat(CATALOG, {
      subject: "Sign in",
      body: "Enter the code to continue.", // one keyword: 'enter the code'
      urls: [],
      technique: "device_code_phishing",
    });
    expect(m).toBeNull();
  });

  it("returns the highest-scoring match when multiple qualify", () => {
    // EvilProxy matches on a strong IOC domain; Kali365 only grazes a
    // single weak keyword ('outlook'). The IOC-backed match must win.
    const m = matchNamedThreat(CATALOG, {
      subject: "Your Outlook session",
      body: "Sign in at https://evil-proxy-c2.example/login to restore your Outlook session.",
      urls: [{ url: "https://evil-proxy-c2.example/login", domain: "evil-proxy-c2.example" }],
    });
    expect(m?.name).toBe("EvilProxy");
    expect(m?.score).toBe(1);
  });

  it("returns null for an empty catalog", () => {
    const m = matchNamedThreat([], { subject: "x", body: "y", urls: [] });
    expect(m).toBeNull();
  });
});
