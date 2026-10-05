// Free / consumer email providers blocked from business-email gates.
//
// Server-side business-email gate for POST /api/leads. If the free-scan page
// (packages/averrow-marketing, /scan) checks free-mail client-side, keep
// its list in sync with this one so the visitor sees the same verdict —
// this check is the authority either way.

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
