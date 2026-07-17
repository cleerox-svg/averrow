// Averrow — Google OAuth 2.0 (OpenID Connect)

export interface GoogleTokenResponse {
  access_token: string;
  id_token: string;
  token_type: string;
  expires_in: number;
}

export interface GoogleUserInfo {
  sub: string;       // Google subject ID — permanent identity anchor
  email: string;
  name: string;
  picture?: string;
  email_verified: boolean;
}

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";

/**
 * Build the Google OAuth authorization URL for redirect.
 */
export function buildGoogleAuthURL(
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    access_type: "offline",
    state,
    prompt: "select_account",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

/**
 * Exchange authorization code for tokens.
 */
export async function exchangeCodeForTokens(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string,
): Promise<GoogleTokenResponse> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Google token exchange failed: ${err}`);
  }

  return res.json() as Promise<GoogleTokenResponse>;
}

/**
 * Fetch user info from Google using an access token.
 */
export async function fetchGoogleUserInfo(accessToken: string): Promise<GoogleUserInfo> {
  const res = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    throw new Error(`Google userinfo fetch failed: ${res.status}`);
  }

  return res.json() as Promise<GoogleUserInfo>;
}

/** Canonical origin — always redirect to non-www domain */
export const CANONICAL_ORIGIN = "https://averrow.com";

/**
 * Determine the OAuth redirect URI using the canonical origin.
 */
export function getRedirectUri(_request: Request): string {
  return `${CANONICAL_ORIGIN}/api/auth/callback`;
}
