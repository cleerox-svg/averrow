/** Words that stay upper-case when a caps-authored heading is rendered in sentence case. */
const ACRONYMS: ReadonlySet<string> = new Set(['SOC', 'AI', 'DNS', 'CT', 'IP', 'ASN', 'URL', 'NEXUS', 'SSL', 'C2']);

/** "THREAT ACTORS" -> "Threat actors"; acronyms ("SOC", "ASN", ...) keep their case. */
export function sentenceCase(label: string): string {
  const words = label.split(/(\s+)/).map((w) => (ACRONYMS.has(w.toUpperCase()) ? w.toUpperCase() : w.toLowerCase()));
  const out = words.join('');
  return out.charAt(0).toUpperCase() + out.slice(1);
}
