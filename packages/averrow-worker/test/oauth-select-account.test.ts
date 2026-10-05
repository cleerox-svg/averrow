import { describe, it, expect } from "vitest";
import { buildGoogleAuthURL } from "../src/lib/oauth";

// The ops "Switch account" action relies on /api/auth/login always
// sending Google prompt=select_account (account chooser).
describe("buildGoogleAuthURL", () => {
  it("always requests the Google account chooser", () => {
    const u = new URL(buildGoogleAuthURL("cid", "https://x/cb", "nonce"));
    expect(u.searchParams.get("prompt")).toBe("select_account");
    expect(u.searchParams.get("state")).toBe("nonce");
  });
});
