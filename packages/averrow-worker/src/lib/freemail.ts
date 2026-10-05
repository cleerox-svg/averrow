// Mail providers and SaaS-tenant domains.
//
// Two uses:
//   1. isFreemailEmail — the business-email gate on POST /api/leads.
//      If the free-scan page (packages/averrow-marketing, /scan) checks
//      free-mail client-side, keep its list in sync with this one so the
//      visitor sees the same verdict — this check is the authority.
//   2. isMailOrSaasProviderDomain — lead report AUTO-DELIVERY refuses a
//      scanned domain that is a mailbox provider or a multi-tenant SaaS
//      host: owning an address there proves nothing about the domain
//      (x@evil.zendesk.com, anyone@yandex.ru). Those leads fall back to
//      a team follow-up. The SaaS list does NOT block the lead itself —
//      pat@salesforce.com is a real business address.
//
// Matching is on the REGISTRABLE domain (lib/registrable-domain.ts), so
// mail.yandex.ru, yahoo.co.uk and outlook.com.br are all covered.

import { registrableDomain, TENANT_HOST_SUFFIXES } from "./registrable-domain";

/** Exact registrable mail-provider domains. */
export const FREEMAIL_DOMAINS: ReadonlySet<string> = new Set([
  // Global
  "gmail.com", "googlemail.com", "aol.com", "aim.com", "icloud.com", "me.com", "mac.com",
  "msn.com", "passport.com", "mail.com", "email.com", "usa.com", "post.com", "inbox.com",
  "protonmail.com", "protonmail.ch", "proton.me", "pm.me", "zoho.com", "zohomail.com", "zohomail.eu",
  "fastmail.com", "fastmail.fm", "hey.com", "tuta.io", "tuta.com", "keemail.me",
  "mailfence.com", "runbox.com", "posteo.de", "posteo.net", "mailbox.org", "hushmail.com",
  "lycos.com", "rediffmail.com", "inbox.lv", "rambler.ru", "bk.ru", "list.ru", "inbox.ru",
  "duck.com", "skiff.com", "startmail.com", "ctemplar.com", "guerrillamail.com", "mailinator.com",
  "yopmail.com", "10minutemail.com", "temp-mail.org",
  // Russia / CIS
  "mail.ru", "ya.ru",
  // Germany / Austria / Switzerland
  "web.de", "t-online.de", "freenet.de", "arcor.de", "gmx.net", "bluewin.ch", "aon.at",
  // France / Belgium
  "orange.fr", "wanadoo.fr", "free.fr", "laposte.net", "sfr.fr", "neuf.fr", "bbox.fr", "skynet.be", "telenet.be",
  // Italy / Spain / Portugal
  "libero.it", "virgilio.it", "tiscali.it", "alice.it", "tim.it", "fastwebnet.it", "telefonica.net", "terra.es", "sapo.pt",
  // Central / Northern Europe
  "seznam.cz", "centrum.cz", "email.cz", "wp.pl", "o2.pl", "onet.pl", "interia.pl", "op.pl",
  "ziggo.nl", "kpnmail.nl", "home.nl", "planet.nl", "telia.com", "online.no", "bredband.net",
  // UK / Ireland
  "btinternet.com", "sky.com", "virginmedia.com", "ntlworld.com", "talktalk.net", "blueyonder.co.uk", "eircom.net",
  // North America
  "comcast.net", "att.net", "sbcglobal.net", "bellsouth.net", "verizon.net", "cox.net", "charter.net",
  "earthlink.net", "optonline.net", "frontier.com", "windstream.net", "juno.com", "netzero.net",
  "shaw.ca", "rogers.com", "sympatico.ca", "telus.net", "videotron.ca",
  // Asia / Pacific / LatAm
  "qq.com", "foxmail.com", "163.com", "126.com", "yeah.net", "sina.com", "sina.cn", "sohu.com", "aliyun.com", "139.com",
  "naver.com", "daum.net", "hanmail.net", "kakao.com", "nate.com",
  "bigpond.com", "bigpond.net.au", "optusnet.com.au", "iinet.net.au", "xtra.co.nz",
  "uol.com.br", "bol.com.br", "terra.com.br", "ig.com.br", "prodigy.net.mx",
]);

/**
 * Provider names registered under many TLDs (yahoo.co.uk, hotmail.fr,
 * outlook.com.br, gmx.de, yandex.kz …). Matched against the first label
 * of the registrable domain, only when the rest of it is the kind of
 * suffix the providers actually use (PROVIDER_NAME_SUFFIX_RE) — so real
 * businesses on new gTLDs (outlook.agency, live.events, gmx.consulting)
 * are not refused as free mail.
 */
export const FREEMAIL_PROVIDER_NAMES: ReadonlySet<string> = new Set([
  "yahoo", "ymail", "rocketmail", "hotmail", "outlook", "live", "windowslive",
  "yandex", "gmx", "tutanota", "tutamail", "protonmail", "aol",
]);

/** com / net / org, a two-letter ccTLD, or a co.xx / com.xx / net.xx / org.xx second level. */
const PROVIDER_NAME_SUFFIX_RE = /^(?:com|net|org|[a-z]{2}|(?:co|com|net|org)\.[a-z]{2})$/;

/** Multi-tenant SaaS / hosting domains: a mailbox or subdomain there is not domain ownership. */
export const SAAS_TENANT_DOMAINS: ReadonlySet<string> = new Set([
  // Helpdesk / CRM
  "zendesk.com", "freshdesk.com", "freshservice.com", "helpscoutdocs.com", "intercom.io", "kayako.com",
  "salesforce.com", "force.com", "my.salesforce.com", "hubspot.com", "hs-sites.com", "zohodesk.com",
  // Microsoft / Google / Atlassian tenants
  "onmicrosoft.com", "sharepoint.com", "azurewebsites.net", "cloudapp.net", "windows.net",
  "atlassian.net", "googleusercontent.com", "appspot.com", "web.app", "firebaseapp.com",
  // Code / static hosting
  "github.io", "gitlab.io", "bitbucket.io", "herokuapp.com", "netlify.app", "netlify.com", "vercel.app",
  "pages.dev", "workers.dev", "fly.dev", "onrender.com", "glitch.me", "repl.co", "replit.app",
  "amplifyapp.com", "cloudfront.net", "amazonaws.com", "azureedge.net", "surge.sh", "ngrok.io", "ngrok-free.app",
  // Site builders / commerce
  "myshopify.com", "shopify.com", "wixsite.com", "wix.com", "squarespace.com", "weebly.com", "wordpress.com",
  "blogspot.com", "blogger.com", "tumblr.com", "webflow.io", "godaddysites.com", "site123.me", "jimdo.com",
  "bigcartel.com", "square.site", "ecwid.com", "carrd.co", "notion.site", "substack.com", "medium.com",
  // Forms / mail relays
  "typeform.com", "jotform.com", "mailchimpsites.com", "list-manage.com", "sendgrid.net", "mailgun.org",
]);

function emailHost(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at <= 0) return null;
  const host = email.slice(at + 1).toLowerCase().trim().replace(/\.$/, "");
  return host || null;
}

/** True when `domain` (any hostname) belongs to a known mailbox provider. */
export function isFreemailDomain(domain: string): boolean {
  const host = domain.toLowerCase().trim().replace(/\.$/, "");
  if (FREEMAIL_DOMAINS.has(host)) return true;
  const reg = registrableDomain(host);
  if (!reg) return false;
  if (FREEMAIL_DOMAINS.has(reg)) return true;
  const dot = reg.indexOf(".");
  return FREEMAIL_PROVIDER_NAMES.has(reg.slice(0, dot)) && PROVIDER_NAME_SUFFIX_RE.test(reg.slice(dot + 1));
}

/** True when `domain` is a multi-tenant SaaS / hosting domain (or a tenant under one). */
export function isSaasTenantDomain(domain: string): boolean {
  const host = domain.toLowerCase().trim().replace(/\.$/, "");
  // The host and every parent: registrableDomain keeps a tenant host whole
  // (shop.myshopify.com), so the provider is found by walking up.
  const labels = host.split(".");
  for (let i = 0; i < labels.length - 1; i++) {
    const name = labels.slice(i).join(".");
    if (SAAS_TENANT_DOMAINS.has(name) || TENANT_HOST_SUFFIXES.has(name)) return true;
  }
  return false;
}

/** Mailbox provider or SaaS tenant host — never eligible for report auto-delivery. */
export function isMailOrSaasProviderDomain(domain: string): boolean {
  return isFreemailDomain(domain) || isSaasTenantDomain(domain);
}

/** True when `email`'s domain is a known free/consumer provider. */
export function isFreemailEmail(email: string): boolean {
  const host = emailHost(email);
  return host != null && isFreemailDomain(host);
}
