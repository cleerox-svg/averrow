/**
 * Spider Trap Injector — Generates hidden HTML containing trap email addresses.
 *
 * Produces HTML snippets with hidden mailto links and meta tags that
 * email-harvesting bots will scrape. Addresses contain encoded metadata
 * for tracking which trap caught which spammer.
 */

export function generateSpiderTraps(domain: string = "averrow.com", page: string = "page"): string {
  const date = (new Date().toISOString().split("T")[0] ?? "").replace(/-/g, "");
  return `
    <div style="position:absolute;left:-9999px;top:-9999px;height:0;overflow:hidden" aria-hidden="true">
      <a href="mailto:spider-${page}-footer-${date}@${domain}">contact</a>
      <a href="mailto:spider-${page}-meta-${date}@${domain}">support</a>
      <a href="mailto:spider-${page}-link-${date}@${domain}">info</a>
    </div>
    <meta name="reply-to" content="spider-${page}-reply-${date}@${domain}">
    <link rel="author" href="mailto:spider-${page}-author-${date}@${domain}">
    <!-- Last updated by webmaster-${page}@${domain} -->
  `.trim();
}
