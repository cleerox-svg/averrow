import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getGoogleAccessToken, hasServiceAccount } from "../src/lib/google-service-account";
import type { Env } from "../src/types";

// Build a real service-account JSON with a freshly generated RSA key so the
// RS256 signing path runs for real (WebCrypto is available in the test env).
async function makeServiceAccountJson(): Promise<string> {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  const b64 = btoa(String.fromCharCode(...new Uint8Array(pkcs8)));
  const pem = `-----BEGIN PRIVATE KEY-----\n${b64.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`;
  return JSON.stringify({
    client_email: "svc@proj-123.iam.gserviceaccount.com",
    private_key: pem,
    token_uri: "https://oauth2.googleapis.com/token",
    project_id: "proj-123",
  });
}

function makeEnv(saJson?: string): { env: Env; store: Map<string, string> } {
  const store = new Map<string, string>();
  const env = {
    GOOGLE_SERVICE_ACCOUNT_JSON: saJson,
    CACHE: {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => { store.set(k, v); },
    },
  } as unknown as Env;
  return { env, store };
}

const SCOPE = "https://www.googleapis.com/auth/cloud-platform";

afterEach(() => vi.restoreAllMocks());

describe("hasServiceAccount", () => {
  it("is false with no secret", () => {
    const { env } = makeEnv(undefined);
    expect(hasServiceAccount(env)).toBe(false);
  });

  it("is false with malformed JSON", () => {
    const { env } = makeEnv("{not json");
    expect(hasServiceAccount(env)).toBe(false);
  });

  it("is true with a complete credential", async () => {
    const { env } = makeEnv(await makeServiceAccountJson());
    expect(hasServiceAccount(env)).toBe(true);
  });
});

describe("getGoogleAccessToken", () => {
  it("returns null when no service account is configured", async () => {
    const { env } = makeEnv(undefined);
    expect(await getGoogleAccessToken(env, SCOPE)).toBeNull();
  });

  it("signs a JWT, exchanges it, returns the token, and caches it", async () => {
    const { env, store } = makeEnv(await makeServiceAccountJson());
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ access_token: "ya29.minted", expires_in: 3600 }), { status: 200 }),
    );

    const tok = await getGoogleAccessToken(env, SCOPE);
    expect(tok).toEqual({ access_token: "ya29.minted", project_id: "proj-123" });

    // Assert the assertion is a well-formed 3-segment JWT carrying our claims.
    const [, init] = fetchSpy.mock.calls[0]!;
    const body = String((init as RequestInit).body);
    const assertion = new URLSearchParams(body).get("assertion")!;
    const segments = assertion.split(".");
    expect(segments).toHaveLength(3);
    const claims = JSON.parse(atob(segments[1]!.replace(/-/g, "+").replace(/_/g, "/")));
    expect(claims.iss).toBe("svc@proj-123.iam.gserviceaccount.com");
    expect(claims.scope).toBe(SCOPE);
    expect(claims.aud).toBe("https://oauth2.googleapis.com/token");
    expect(new URLSearchParams(body).get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");

    // Token was cached.
    expect([...store.values()]).toContain("ya29.minted");
  });

  it("serves a cached token without a second exchange", async () => {
    const { env } = makeEnv(await makeServiceAccountJson());
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ access_token: "ya29.first", expires_in: 3600 }), { status: 200 }),
    );
    await getGoogleAccessToken(env, SCOPE);
    await getGoogleAccessToken(env, SCOPE);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("returns null when the token exchange fails", async () => {
    const { env } = makeEnv(await makeServiceAccountJson());
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 401 }));
    expect(await getGoogleAccessToken(env, SCOPE)).toBeNull();
  });
});
