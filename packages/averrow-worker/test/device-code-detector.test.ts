import { describe, it, expect } from "vitest";
import { detectDeviceCodePhishing } from "../src/lib/device-code-detector";

// A canonical Kali365-style device-code lure: instructs the victim to
// enter a device code at the REAL Microsoft device-login endpoint.
const KALI365_LURE = {
  subject: "Action required: verify your Microsoft 365 device",
  body:
    "Your Outlook session needs re-verification. Go to https://microsoft.com/devicelogin " +
    "and enter the code ABCD-EFGHJ to continue. This verifies your device for Microsoft 365.",
  urls: [{ url: "https://microsoft.com/devicelogin", domain: "microsoft.com" }],
};

describe("detectDeviceCodePhishing", () => {
  it("detects the canonical device-code lure at high confidence", () => {
    const r = detectDeviceCodePhishing(KALI365_LURE);
    expect(r.detected).toBe(true);
    expect(r.technique).toBe("device_code_phishing");
    expect(r.score).toBeGreaterThanOrEqual(0.8);
    expect(r.signals).toContain("device_login_endpoint");
    expect(r.signals).toContain("enter_code_instruction");
  });

  it("flags the legitimate Microsoft endpoint for exclusion from promotion", () => {
    const r = detectDeviceCodePhishing(KALI365_LURE);
    expect(r.legitEndpointUrls).toContain("https://microsoft.com/devicelogin");
  });

  it("detects aka.ms/devicelogin variant", () => {
    const r = detectDeviceCodePhishing({
      subject: "Verify device",
      body: "Enter this code 7H2K9 at https://aka.ms/devicelogin to sign in to Teams.",
      urls: [{ url: "https://aka.ms/devicelogin", domain: "aka.ms" }],
    });
    expect(r.detected).toBe(true);
    expect(r.technique).toBe("device_code_phishing");
  });

  it("detects the endpoint even when only present in prose, not a parsed URL", () => {
    const r = detectDeviceCodePhishing({
      subject: "Microsoft device verification",
      body: "Visit microsoft.com/devicelogin and type the device code shown below.",
      urls: [],
    });
    expect(r.detected).toBe(true);
  });

  it("falls back to a lower score when endpoint is absent but strong code language + MS context present", () => {
    const r = detectDeviceCodePhishing({
      subject: "Microsoft 365 sign-in",
      body: "Please enter the device code we sent to finish signing in to Outlook.",
      urls: [],
    });
    expect(r.detected).toBe(true);
    expect(r.technique).toBe("device_code_phishing");
    expect(r.score).toBeLessThan(0.8);
  });

  it("detects oauth consent phishing", () => {
    const r = detectDeviceCodePhishing({
      subject: "Approve access to your account",
      body:
        "Please review and grant the requested permissions for your Microsoft 365 account at " +
        "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?prompt=consent&response_type=code",
      urls: [
        {
          url: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?prompt=consent&response_type=code",
          domain: "login.microsoftonline.com",
        },
      ],
    });
    expect(r.detected).toBe(true);
    expect(r.technique).toBe("oauth_consent_phishing");
  });

  it("does NOT fire on a benign Microsoft email with no device-code cue", () => {
    const r = detectDeviceCodePhishing({
      subject: "Your OneDrive storage is almost full",
      body: "You're using 95% of your storage. Visit https://onedrive.live.com to free up space.",
      urls: [{ url: "https://onedrive.live.com", domain: "onedrive.live.com" }],
    });
    expect(r.detected).toBe(false);
    expect(r.technique).toBeNull();
  });

  it("does NOT fire on a generic code email without a device-login endpoint", () => {
    const r = detectDeviceCodePhishing({
      subject: "Your verification code",
      body: "Your one-time login code is 123456. It expires in 10 minutes.",
      urls: [],
    });
    // No MS device endpoint, no 'device code' phrase, no MS context →
    // not enough for even the soft fallback.
    expect(r.detected).toBe(false);
  });

  it("handles null/empty inputs without throwing", () => {
    const r = detectDeviceCodePhishing({ subject: null, body: null, urls: [] });
    expect(r.detected).toBe(false);
    expect(r.legitEndpointUrls).toEqual([]);
  });
});
