// Free / consumer email providers blocked from business-email gates.
//
// Mirrors the client-side list the public scan pages enforce
// (templates/homepage.ts + templates/scan.ts) so the server reaches the
// same verdict the visitor was shown — a direct POST to /api/leads can't
// slip a personal address past the in-page check. Keep this list in sync
// with those two templates if either changes.

export const FREEMAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "aol.com",
  "icloud.com", "mail.com", "protonmail.com", "proton.me", "yandex.com",
  "zoho.com", "gmx.com", "fastmail.com", "tutanota.com", "hey.com",
  "live.com", "msn.com", "me.com", "qq.com", "163.com",
]);

/** True when `email`'s domain is a known free/consumer provider. */
export function isFreemailEmail(email: string): boolean {
  const domain = email.split("@")[1]?.toLowerCase().trim();
  return domain != null && FREEMAIL_DOMAINS.has(domain);
}
