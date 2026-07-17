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

function stixId(type: string): string {
  return `${type}--${crypto.randomUUID()}`;
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
  return map[severity ?? ''] ?? 50;
}

/** Build a STIX pattern string from a threat record. */
function buildPattern(threat: ThreatInput): string {
  if (threat.malicious_url) {
    return `[url:value = '${threat.malicious_url.replace(/'/g, "\\'")}']`;
  }
  if (threat.malicious_domain) {
    return `[domain-name:value = '${threat.malicious_domain.replace(/'/g, "\\'")}']`;
  }
  return `[domain-name:value = 'unknown']`;
}

// ─── Conversion Functions ───────────────────────────────────

export function threatToSTIXIndicator(threat: ThreatInput): STIXIndicator {
  const now = new Date().toISOString();
  const created = threat.created_at || now;
  const confidence = severityToConfidence(threat.severity, threat.confidence_score);
  const labels = threatTypeToLabels(threat.threat_type);
  const displayName = threat.malicious_url || threat.malicious_domain || threat.id;

  return {
    type: 'indicator',
    spec_version: '2.1',
    id: `indicator--${threat.id}`,
    created,
    modified: now,
    name: `Averrow: ${threat.threat_type} - ${displayName}`,
    description: `Threat detected by Averrow. Type: ${threat.threat_type}, Status: ${threat.status}.`,
    pattern: buildPattern(threat),
    pattern_type: 'stix',
    valid_from: threat.first_seen || created,
    labels,
    confidence,
  };
}

export function brandToSTIXIdentity(brand: BrandInput): STIXIdentity {
  const name = brand.brand_name || brand.name || brand.domain || brand.canonical_domain || 'Unknown';
  const domain = brand.domain || brand.canonical_domain;
  const created = brand.created_at || brand.first_seen || new Date().toISOString();
  const sectors = brand.sector ? [brand.sector] : undefined;

  return {
    type: 'identity',
    spec_version: '2.1',
    id: `identity--${brand.id}`,
    created,
    modified: created,
    name: `${name}${domain ? ` (${domain})` : ''}`,
    identity_class: 'organization',
    ...(sectors && { sectors }),
  };
}

export function buildSTIXBundle(
  threats: ThreatInput[],
  brand: BrandInput,
  includeRelationships = true,
): STIXBundle {
  const objects: STIXObject[] = [];
  const now = new Date().toISOString();

  // 1. Identity for the brand (the targeted organization)
  const identity = brandToSTIXIdentity(brand);
  objects.push(identity);

  // 2. Indicators for each threat
  const indicators: STIXIndicator[] = threats.map(threatToSTIXIndicator);
  objects.push(...indicators);

  // 3. Relationships: each indicator "indicates" activity that "targets" the identity
  if (includeRelationships) {
    for (const indicator of indicators) {
      objects.push({
        type: 'relationship',
        spec_version: '2.1',
        id: stixId('relationship'),
        created: now,
        modified: now,
        relationship_type: 'indicates',
        source_ref: indicator.id,
        target_ref: identity.id,
      });
    }
  }

  // 4. Wrap in a Bundle
  return {
    type: 'bundle',
    id: stixId('bundle'),
    objects,
  };
}
