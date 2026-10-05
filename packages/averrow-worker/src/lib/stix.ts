/**
 * STIX 2.1 serializer for Averrow threat data.
 *
 * Converts internal brand/threat records into standards-compliant
 * STIX 2.1 bundles suitable for SIEM ingestion.
 */

// ─── STIX 2.1 Object Types ──────────────────────────────────

export interface STIXBundle {
  type: 'bundle';
  id: string; // "bundle--<uuid>"
  objects: STIXObject[];
}

export type STIXObject =
  | STIXIndicator
  | STIXThreatActor
  | STIXMalware
  | STIXRelationship
  | STIXIdentity
  | STIXObservedData;

export interface STIXIndicator {
  type: 'indicator';
  spec_version: '2.1';
  id: string;
  created: string;
  modified: string;
  name: string;
  description: string;
  pattern: string;
  pattern_type: 'stix';
  valid_from: string;
  labels: string[];
  confidence: number;
}

export interface STIXThreatActor {
  type: 'threat-actor';
  spec_version: '2.1';
  id: string;
  created: string;
  modified: string;
  name: string;
  description: string;
  threat_actor_types: string[];
  aliases?: string[];
}

export interface STIXMalware {
  type: 'malware';
  spec_version: '2.1';
  id: string;
  created: string;
  modified: string;
  name: string;
  description: string;
  malware_types: string[];
  is_family: boolean;
}

export interface STIXRelationship {
  type: 'relationship';
  spec_version: '2.1';
  id: string;
  created: string;
  modified: string;
  relationship_type: string;
  source_ref: string;
  target_ref: string;
}

export interface STIXIdentity {
  type: 'identity';
  spec_version: '2.1';
  id: string;
  created: string;
  modified: string;
  name: string;
  identity_class: string;
  sectors?: string[];
}

export interface STIXObservedData {
  type: 'observed-data';
  spec_version: '2.1';
  id: string;
  created: string;
  modified: string;
  first_observed: string;
  last_observed: string;
  number_observed: number;
  object_refs: string[];
}

// ─── Internal input shapes ──────────────────────────────────

export interface ThreatInput {
  id: string;
  malicious_url?: string | null;
  malicious_domain?: string | null;
  threat_type: string;
  confidence_score?: number | null;
  created_at: string;
  status: string;
  severity?: string | null;
  first_seen?: string | null;
  last_seen?: string | null;
}

export interface BrandInput {
  id: string;
  brand_name?: string;
  name?: string;
  domain?: string;
  canonical_domain?: string;
  created_at?: string;
  first_seen?: string;
  sector?: string | null;
}

// ─── Helpers ────────────────────────────────────────────────

/**
 * Fixed namespace for Averrow's deterministic STIX identifiers (UUIDv5).
 * Never change it: STIX ids derived from it must stay stable across
 * exports so a consumer's SIEM de-duplicates the same object.
 */
export const AVERROW_STIX_NAMESPACE = "6f4c1d2e-8a3b-5c7d-9e0f-a1b2c3d4e5f6";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, "");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToUuid(b: Uint8Array): string {
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** RFC 4122 UUIDv5 (SHA-1, name-based). Deterministic: same name → same UUID. */
export async function uuidV5(name: string, namespace: string = AVERROW_STIX_NAMESPACE): Promise<string> {
  const ns = uuidToBytes(namespace);
  const nameBytes = new TextEncoder().encode(name);
  const input = new Uint8Array(ns.length + nameBytes.length);
  input.set(ns, 0);
  input.set(nameBytes, ns.length);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-1", input));
  const bytes = hash.slice(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
  return bytesToUuid(bytes);
}

/**
 * STIX 2.1 identifier `<type>--<UUID>`. A source id that already is a UUID
 * is used as-is (lower-cased); anything else (e.g. `brand_acme_com`,
 * feed-derived threat ids) is mapped to a deterministic UUIDv5 of
 * `<type>:<rawId>`, so re-exporting the same record yields the same id.
 */
export async function stixIdFor(type: string, rawId: string): Promise<string> {
  if (UUID_RE.test(rawId)) return `${type}--${rawId.toLowerCase()}`;
  return `${type}--${await uuidV5(`${type}:${rawId}`)}`;
}

/**
 * RFC 3339 UTC timestamp with `Z`, as STIX 2.1 requires. Accepts SQLite's
 * `YYYY-MM-DD HH:MM:SS` (UTC, no zone), ISO strings with or without a
 * zone, or a date. Unparseable/empty input → `fallback`.
 */
export function toStixTimestamp(value: string | null | undefined, fallback: string): string {
  if (!value) return fallback;
  let v = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) v = `${v}T00:00:00Z`;
  else if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(v)) v = `${v.replace(" ", "T")}Z`;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? fallback : new Date(ms).toISOString();
}

/** Map Averrow threat_type to STIX indicator labels. */
function threatTypeToLabels(threatType: string): string[] {
  const map: Record<string, string[]> = {
    phishing: ['phishing', 'malicious-activity'],
    typosquatting: ['malicious-activity', 'anomalous-activity'],
    impersonation: ['malicious-activity', 'anomalous-activity'],
    credential_harvesting: ['phishing', 'malicious-activity'],
    malware_distribution: ['malicious-activity', 'malware'],
  };
  return map[threatType] ?? ['malicious-activity'];
}

/** Map Averrow severity to a STIX confidence value (0-100). */
function severityToConfidence(severity?: string | null, score?: number | null): number {
  if (score != null && score >= 0 && score <= 100) return score;
  const map: Record<string, number> = {
    CRITICAL: 95,
    HIGH: 80,
    MEDIUM: 60,
    LOW: 30,
  };
  return map[(severity ?? '').toUpperCase()] ?? 50;
}

/**
 * Escape a value for a STIX patterning string literal. Backslash FIRST,
 * then the single quote — escaping only the quote lets an attacker-
 * controlled URL containing `\'` become `\\'` (escaped
 * backslash + live quote) and break out of the literal.
 */
export function escapeStixPatternValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/** Build a STIX pattern string from a threat record. */
export function buildPattern(threat: ThreatInput): string {
  if (threat.malicious_url) {
    return `[url:value = '${escapeStixPatternValue(threat.malicious_url)}']`;
  }
  if (threat.malicious_domain) {
    return `[domain-name:value = '${escapeStixPatternValue(threat.malicious_domain)}']`;
  }
  return `[domain-name:value = 'unknown']`;
}

/** Content-Disposition filename stem: only [A-Za-z0-9_-] survive (header-safe). */
export function safeFilename(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120) || "averrow-stix";
}

// ─── Conversion Functions ───────────────────────────────────

export async function threatToSTIXIndicator(threat: ThreatInput): Promise<STIXIndicator> {
  const now = new Date().toISOString();
  const created = toStixTimestamp(threat.created_at, now);
  const confidence = severityToConfidence(threat.severity, threat.confidence_score);
  const labels = threatTypeToLabels(threat.threat_type);
  const displayName = threat.malicious_url || threat.malicious_domain || threat.id;

  return {
    type: 'indicator',
    spec_version: '2.1',
    id: await stixIdFor('indicator', threat.id),
    created,
    modified: now > created ? now : created,
    name: `Averrow: ${threat.threat_type} - ${displayName}`,
    description: `Threat detected by Averrow. Type: ${threat.threat_type}, Status: ${threat.status}.`,
    pattern: buildPattern(threat),
    pattern_type: 'stix',
    valid_from: toStixTimestamp(threat.first_seen, created),
    labels,
    confidence,
  };
}

export async function brandToSTIXIdentity(brand: BrandInput): Promise<STIXIdentity> {
  const name = brand.brand_name || brand.name || brand.domain || brand.canonical_domain || 'Unknown';
  const domain = brand.domain || brand.canonical_domain;
  const created = toStixTimestamp(brand.created_at || brand.first_seen, new Date().toISOString());
  const sectors = brand.sector ? [brand.sector] : undefined;

  return {
    type: 'identity',
    spec_version: '2.1',
    id: await stixIdFor('identity', brand.id),
    created,
    modified: created,
    name: `${name}${domain ? ` (${domain})` : ''}`,
    identity_class: 'organization',
    ...(sectors && { sectors }),
  };
}

export async function buildSTIXBundle(
  threats: ThreatInput[],
  brand: BrandInput,
  includeRelationships = true,
): Promise<STIXBundle> {
  const objects: STIXObject[] = [];
  const now = new Date().toISOString();

  // 1. Identity for the brand (the targeted organization)
  const identity = await brandToSTIXIdentity(brand);
  objects.push(identity);

  // 2. Indicators for each threat
  const indicators: STIXIndicator[] = await Promise.all(threats.map(threatToSTIXIndicator));
  objects.push(...indicators);

  // 3. Relationships: each indicator "indicates" activity that "targets" the
  //    identity. Deterministic id per (indicator, identity) pair.
  if (includeRelationships) {
    const relIds = await Promise.all(
      indicators.map((indicator) => uuidV5(`indicates:${indicator.id}:${identity.id}`)),
    );
    indicators.forEach((indicator, i) => {
      objects.push({
        type: 'relationship',
        spec_version: '2.1',
        id: `relationship--${relIds[i]!}`,
        created: now,
        modified: now,
        relationship_type: 'indicates',
        source_ref: indicator.id,
        target_ref: identity.id,
      });
    });
  }

  // 4. Wrap in a Bundle (bundle ids are per-export, random v4 is valid)
  return {
    type: 'bundle',
    id: `bundle--${crypto.randomUUID()}`,
    objects,
  };
}
