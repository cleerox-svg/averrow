/**
 * Brand keyword utilities — single canonical implementation.
 *
 * Consolidates generateKeywords from handlers/brandProfiles.ts and
 * generateBrandKeywords from handlers/brands.ts (identical logic).
 */

/**
 * Generate a de-duplicated set of search keywords from a brand's domain and name.
 * Produces: domain base, brand name, no-space variant, hyphenated variant.
 */
export function generateBrandKeywords(domain: string, brandName: string): string[] {
  const keywords = new Set<string>();
  const domainBase = domain.split('.')[0]!.toLowerCase();
  keywords.add(domainBase);
  keywords.add(brandName.toLowerCase());
  const noSpace = brandName.toLowerCase().replace(/\s+/g, '');
  if (noSpace !== domainBase) keywords.add(noSpace);
  const hyphenated = brandName.toLowerCase().replace(/\s+/g, '-');
  if (hyphenated !== domainBase) keywords.add(hyphenated);
  return [...keywords];
}
