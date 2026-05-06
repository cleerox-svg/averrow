// Provider name → website domain → favicon URL.
//
// Hosting providers don't carry a `website_url` column on
// hosting_providers, so we map the common name variants the threat
// feeds emit to the canonical company domain. Unknown names return
// null so the call site can fall through to the existing letter-on-
// gradient avatar — every row still reads as something, never as a
// broken image.
//
// Match strategy is single-pass: longest specific patterns first
// (e.g. "google cloud" before "google"), then suffix-stripped name
// against the known map. Add new entries here as the platform's
// feeds surface them — the goal is coverage of the top-N providers
// by threat volume, not exhaustive ASN catalog.

const PROVIDER_DOMAIN_MAP: ReadonlyArray<readonly [RegExp, string]> = [
  // Most-specific multi-word matches first so e.g. "Google Cloud"
  // doesn't get caught by the bare /google/ alias.
  [/google\s*cloud/i,         'cloud.google.com'],
  [/amazon\s*aws|aws\b/i,     'aws.amazon.com'],
  [/microsoft\s*azure/i,      'azure.microsoft.com'],
  [/alibaba\s*cloud/i,        'alibabacloud.com'],
  [/linode|akamai/i,          'akamai.com'],
  [/oracle\s*(corp|cloud)/i,  'oracle.com'],

  // Single-token brands. /\b/ guards keep "Cloudflare, Inc." from
  // matching against random substring noise.
  [/\bcloudflare\b/i,         'cloudflare.com'],
  [/\bamazon\b/i,             'amazon.com'],
  [/\bmicrosoft\b/i,          'microsoft.com'],
  [/\bgoogle\b/i,             'google.com'],
  [/\bfastly\b/i,             'fastly.com'],
  [/\bdigitalocean\b/i,       'digitalocean.com'],
  [/\boracle\b/i,             'oracle.com'],
  [/\bgithub\b/i,             'github.com'],
  [/\bhostinger\b/i,          'hostinger.com'],
  [/\bweebly\b/i,             'weebly.com'],
  [/\bovh(\s*cloud)?\b/i,     'ovhcloud.com'],
  [/\bvercel\b/i,             'vercel.com'],
  [/\bnetlify\b/i,            'netlify.com'],
  [/\bheroku\b/i,             'heroku.com'],
  [/\bwordpress|automattic/i, 'wordpress.com'],
  [/\bnamecheap\b/i,          'namecheap.com'],
  [/\bgodaddy\b/i,            'godaddy.com'],
  [/\bbluehost\b/i,           'bluehost.com'],
  [/\bsiteground\b/i,         'siteground.com'],
  [/\bdreamhost\b/i,          'dreamhost.com'],
  [/\bvultr\b/i,              'vultr.com'],
  [/\bhetzner\b/i,            'hetzner.com'],
  [/\bcontabo\b/i,            'contabo.com'],
  [/\bleaseweb\b/i,           'leaseweb.com'],
  [/\btencent(\s*cloud)?\b/i, 'cloud.tencent.com'],
  [/\bbaidu\b/i,              'baidu.com'],
  [/\bhuawei(\s*cloud)?\b/i,  'huaweicloud.com'],
  [/\bibm(\s*cloud)?\b/i,     'ibm.com'],
  [/\bsalesforce\b/i,         'salesforce.com'],
];

/** Returns the company website domain for a known provider name, or null. */
export function providerDomain(name: string | null | undefined): string | null {
  if (!name) return null;
  for (const [pattern, domain] of PROVIDER_DOMAIN_MAP) {
    if (pattern.test(name)) return domain;
  }
  return null;
}

/**
 * Returns a Google favicon-service URL for a known provider, mirroring
 * the brand favicon fallback used elsewhere on Home. Returns null for
 * unknown providers so the call site falls through to a letter avatar.
 */
export function providerFaviconUrl(name: string | null | undefined): string | null {
  const domain = providerDomain(name);
  if (!domain) return null;
  return `https://www.google.com/s2/favicons?domain=${domain}&sz=64`;
}
