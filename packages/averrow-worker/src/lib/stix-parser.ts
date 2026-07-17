// STIX 2.1 → Averrow threat row mapping.
//
// We don't try to parse the full STIX pattern grammar (which is
// a Lark-style PEG with Boolean composition and qualifiers). The
// 95% of indicators we'll see from public TAXII feeds use a
// single-comparison pattern of the form:
//
//     [ <object-type> : <property> = '<value>' ]
//
// Anything more complex (OR/AND patterns, FOLLOWED-BY qualifiers,
// regex matches) we deliberately skip + count as parse errors so
// downstream operators can spot a feed that needs richer parsing.
//
// Tested under test/stix-parser.test.ts.

import type { ThreatRow } from "../feeds/types";

/** STIX 2.1 indicator object — only the fields we care about. */
export interface StixIndicator {
  type: "indicator";
  id: string;
  pattern: string;
  pattern_type?: string;
  pattern_version?: string;
  indicator_types?: string[];
  labels?: string[];
  name?: string;
  description?: string;
  valid_from?: string;
  valid_until?: string;
  confidence?: number;                // STIX 0-100
  created?: string;
  modified?: string;
  kill_chain_phases?: Array<{ kill_chain_name: string; phase_name: string }>;
}

/** Discriminated subset of a STIX 2.1 bundle — relaxed to allow extra fields. */
export interface StixBundle {
  type: "bundle";
  id?: string;
  objects?: Array<{ type: string; [k: string]: unknown }>;
}

export interface ParsedIndicator {
  /** Which IOC field on `threats` this maps to. */
  iocField: "ip_address" | "malicious_domain" | "malicious_url" | "ioc_value";
  iocValue: string;
  /** Maps to threats.threat_type — kept loose to avoid hard-coding the enum here. */
  threatType: ThreatRow["threat_type"];
  /** 0-100. Derived from STIX confidence or defaulted by indicator_types. */
  confidence: number;
  /** info | low | medium | high | critical. */
  severity: ThreatRow["severity"];
}

/**
 * Parse a STIX pattern string into a single IOC. Returns null when the
 * pattern is too complex (Boolean / multi-term) or uses an
 * unsupported object type. Callers should treat null as "skip this
 * indicator" and tally it as an unparsed row.
 *
 * Supported shapes (whitespace is permissive):
 *
 *   [ipv4-addr:value = '1.2.3.4']
 *   [ipv6-addr:value = '2001:db8::1']
 *   [domain-name:value = 'evil.example']
 *   [url:value = 'http://evil.example/path']
 *   [email-addr:value = 'phish@evil.example']
 *   [file:hashes.MD5 = '...']
 *   [file:hashes.'SHA-1' = '...']
 *   [file:hashes.'SHA-256' = '...']
 */
export function parseStixPattern(
  pattern: string,
): { objectType: string; property: string; value: string } | null {
  // Reject anything with a Boolean operator or qualifier — keeps the
  // grammar from sneaking up on us. STIX uses uppercase AND/OR/NOT
  // and the qualifiers START, STOP, WITHIN, REPEATS, FOLLOWEDBY.
  if (/\b(AND|OR|NOT|START|STOP|WITHIN|REPEATS|FOLLOWEDBY)\b/i.test(pattern)) {
    return null;
  }

  // [object-type:property = 'value'] — single-quoted value.
  // The property capture allows dots + 'quoted-with-dashes' (hashes.MD5
  // and hashes.'SHA-256' are both valid STIX).
  const re = /^\s*\[\s*([a-z0-9-]+)\s*:\s*([a-z0-9_]+(?:\.(?:[a-z0-9_]+|'[a-z0-9-]+'))*)\s*=\s*'((?:[^'\\]|\\.)*)'\s*\]\s*$/i;
  const match = pattern.match(re);
  if (!match) return null;

  return {
    objectType: match[1]!.toLowerCase(),
    property: match[2]!.toLowerCase().replace(/'/g, ""),
    // Unescape the STIX string literal — \\ → \, \' → '.
    value: match[3]!.replace(/\\(.)/g, "$1"),
  };
}

/**
 * Combine a parsed-pattern fragment + the indicator's labels/types
 * into the shape `threats` actually stores.
 *
 * STIX `indicator_types` is a controlled vocabulary (malicious-activity,
 * compromised, attribution, etc.) but real-world feeds tag inconsistently,
 * so we also consider `labels` and `kill_chain_phases` as fall-backs.
 */
export function parseIndicator(ind: StixIndicator): ParsedIndicator | null {
  const parsed = parseStixPattern(ind.pattern);
  if (!parsed) return null;

  // Map STIX object-type/property → our threats column.
  let iocField: ParsedIndicator["iocField"];
  let iocValue = parsed.value;

  switch (parsed.objectType) {
    case "ipv4-addr":
    case "ipv6-addr":
      iocField = "ip_address";
      break;
    case "domain-name":
      iocField = "malicious_domain";
      iocValue = iocValue.toLowerCase();
      break;
    case "url":
      iocField = "malicious_url";
      break;
    case "email-addr":
      // Emails don't have a dedicated column on threats; carry as ioc_value.
      iocField = "ioc_value";
      iocValue = `email:${iocValue.toLowerCase()}`;
      break;
    case "file":
      // Only treat hash properties as IOCs — file:name etc. is too noisy.
      if (!parsed.property.startsWith("hashes")) return null;
      iocField = "ioc_value";
      iocValue = `${parsed.property.replace("hashes.", "hash:")}:${iocValue}`;
      break;
    default:
      return null;
  }

  // Derive threat_type. Order matters — most specific tags win.
  const tags = [
    ...(ind.indicator_types ?? []),
    ...(ind.labels ?? []),
    ...(ind.kill_chain_phases ?? []).map((p) => p.phase_name),
  ].map((t) => t.toLowerCase());

  const threatType = mapTagsToThreatType(tags, parsed.objectType);

  // Confidence: STIX is 0-100 if set; default 60 for unattributed.
  const confidence =
    typeof ind.confidence === "number" && ind.confidence >= 0 && ind.confidence <= 100
      ? ind.confidence
      : 60;

  // Severity: STIX doesn't have a first-class severity field. Derive
  // from threat_type + confidence as a coarse proxy.
  const severity = deriveSeverity(threatType, confidence);

  return { iocField, iocValue, threatType, confidence, severity };
}

function mapTagsToThreatType(
  tags: string[],
  objectType: string,
): ThreatRow["threat_type"] {
  const has = (...words: string[]) => words.some((w) => tags.includes(w));

  // Specific TTPs first.
  if (has("c2", "command-and-control", "command-control")) return "c2";
  if (has("botnet")) return "botnet";
  if (has("malware-distribution", "malware", "trojan", "ransomware"))
    return "malware_distribution";
  if (has("credential-harvesting", "credential-theft", "credential-access"))
    return "credential_harvesting";
  if (has("phishing", "phish")) return "phishing";
  if (has("typosquatting", "typosquat", "lookalike")) return "typosquatting";
  if (has("impersonation", "brand-impersonation", "spoofing")) return "impersonation";
  if (has("scanning", "reconnaissance", "scanner")) return "scanning";
  if (
    has("malicious-ssl", "malicious-certificate", "weak-ssl", "self-signed-cert")
  ) {
    return "malicious_ssl";
  }

  // Fallback by object type — better to label coarsely than null.
  if (objectType === "ipv4-addr" || objectType === "ipv6-addr") return "malicious_ip";
  if (objectType === "url" || objectType === "domain-name") return "phishing";
  if (objectType === "file") return "malware_distribution";
  return "malicious_ip";
}

function deriveSeverity(
  threatType: ThreatRow["threat_type"],
  confidence: number,
): ThreatRow["severity"] {
  // Floor the type contribution. C2 / botnet / credential harvesting
  // are inherently higher impact even at moderate confidence.
  const baselineHigh = ["c2", "botnet", "credential_harvesting"] as const;
  const baselineMed = [
    "malware_distribution",
    "phishing",
    "impersonation",
    "typosquatting",
  ] as const;

  if ((baselineHigh as readonly string[]).includes(threatType)) {
    return confidence >= 90 ? "critical" : "high";
  }
  if ((baselineMed as readonly string[]).includes(threatType)) {
    return confidence >= 90 ? "high" : "medium";
  }
  // Scanning, malicious_ip, malicious_ssl: low-noise — calibrate by confidence.
  if (confidence >= 85) return "medium";
  if (confidence >= 60) return "low";
  return "info";
}

/**
 * Iterate the indicators in a STIX bundle, yielding only the ones
 * we can map to a threat row. Non-indicator objects + indicators
 * with unsupported patterns are dropped silently — the caller is
 * expected to count `bundle.objects.length - yielded.count` as
 * the skipped tally for diagnostics.
 */
export function* iterParsedIndicators(
  bundle: StixBundle,
): Generator<{ raw: StixIndicator; parsed: ParsedIndicator }> {
  for (const obj of bundle.objects ?? []) {
    if (obj.type !== "indicator") continue;
    const ind = obj as unknown as StixIndicator;
    if (typeof ind.pattern !== "string") continue;
    // Skip non-STIX pattern dialects (sigma, yara, snort). We only
    // ingest STIX-pattern indicators; the rest are detection rules
    // for downstream tooling, not raw IOCs.
    if (ind.pattern_type && ind.pattern_type !== "stix") continue;
    const parsed = parseIndicator(ind);
    if (!parsed) continue;
    yield { raw: ind, parsed };
  }
}
