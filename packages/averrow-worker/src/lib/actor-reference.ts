/**
 * Threat-actor REFERENCE data: the MISP Galaxy `threat-actor` cluster
 * (feeds/actorReference.ts, migration 0334), and the one name → reference
 * resolver.
 *
 * Reference data ONLY. Nothing here writes `threat_actors`,
 * `threat_attributions`, `infrastructure_clusters.actor_id` or any other
 * customer-visible attribution, and no write path calls the resolver. Its
 * single reader today is the staff-only threat-actor detail
 * (`GET /api/threat-actors/:id` → `reference`). Wiring it into Attributor
 * or OTX inheritance is an owner decision (it would rename/merge actors
 * customers see) — do not do it here.
 *
 * Ambiguity is a first-class answer: the MISP galaxy lists the same alias
 * under several actors (vendor naming schemes collide — "Cobalt", "Mercury"
 * etc.). An alias that maps to more than one live reference resolves to
 * NOTHING; we never pick one.
 *
 * Licence: MISP Galaxy JSON is dual-licensed CC0 1.0 or BSD-2-Clause; we
 * use it under CC0 (no obligations). We still show the source credit
 * (`ACTOR_REFERENCE_CREDIT`) wherever the data is displayed, as a courtesy
 * and so analysts know where a name came from. Snapshot:
 * docs/licences/misp_galaxy.md.
 */

export const ACTOR_REFERENCE_SOURCE = "misp_galaxy";
export const ACTOR_REFERENCE_CREDIT =
  "Source: MISP Galaxy threat-actor cluster (MISP Project, CC0 1.0), https://github.com/MISP/misp-galaxy";

/** The galaxy file's own uuid / type — a wrong file must fail the pull. */
export const MISP_THREAT_ACTOR_GALAXY_UUID = "7cdff317-a673-4474-84ec-4f1754947823";
export const MISP_THREAT_ACTOR_GALAXY_TYPE = "threat-actor";

/** Stored description cap (characters). The longest upstream entry is ~2.7K. */
export const ACTOR_DESCRIPTION_MAX_CHARS = 1000;
/** Aliases kept per actor (upstream max is well under this). */
export const ACTOR_MAX_ALIASES = 200;
/** A single alias longer than this is dropped (garbage, not a name). */
export const ACTOR_ALIAS_MAX_CHARS = 120;

/**
 * Normalise an actor name or alias to its lookup key.
 *
 * NFKC, lowercase, diacritics dropped, a leading "the " dropped, then every
 * character that is not a letter or digit removed — so "APT-28", "APT 28",
 * "apt_28" and "APT28" all become `apt28`, and "TA-505" → `ta505`. Letters
 * of any script are kept (some upstream names are Chinese / Cyrillic).
 * Words such as "group" or "team" are NOT stripped: "Equation Group" and
 * "Equation" are different keys, because stripping them creates false
 * merges. Returns null when fewer than 2 characters remain (a 1-char key
 * would match far too much).
 */
export function normalizeActorName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let s = raw.normalize("NFKC").toLowerCase().trim();
  s = s.normalize("NFD").replace(/\p{M}+/gu, "");
  s = s.replace(/^the\s+/u, "");
  s = s.replace(/[^\p{L}\p{N}]+/gu, "");
  return s.length >= 2 ? s : null;
}

export interface ActorReferenceRecord {
  /** Stable id: `misp:<upstream uuid>` (lowercase). */
  id: string;
  sourceUuid: string;
  name: string;
  countryCode: string | null;
  stateSponsor: string | null;
  description: string | null;
  /** Distinct aliases (original spelling), canonical name first. */
  aliases: Array<{ original: string; norm: string }>;
  /** sha256 hex over every stored field — the change guard. */
  contentHash: string;
}

export interface ParsedActorGalaxy {
  version: string | null;
  /** `values.length` as published (before dropping malformed entries). */
  declared: number;
  records: ActorReferenceRecord[];
  malformed: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function cleanText(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+/g, " ").trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function countryCode(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(t) ? t : null;
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Parse the MISP `clusters/threat-actor.json` body. Throws on anything that
 * is not that file (bad JSON, wrong galaxy uuid/type, no `values` array);
 * individual bad entries are counted in `malformed` and skipped. A duplicate
 * upstream uuid keeps the first entry and counts the rest as malformed.
 *
 * Aliases = canonical `value` + `meta.synonyms`. `meta.name-attribution`
 * (vendor names suffixed with other clusters' uuids, incl. ATT&CK group ids)
 * is deliberately NOT read.
 */
export async function parseMispThreatActorGalaxy(body: string): Promise<ParsedActorGalaxy> {
  let doc: unknown;
  try {
    doc = JSON.parse(body);
  } catch {
    throw new Error("actor_reference: body is not JSON");
  }
  if (!isObject(doc)) throw new Error("actor_reference: body is not a JSON object");
  if (doc.uuid !== MISP_THREAT_ACTOR_GALAXY_UUID || doc.type !== MISP_THREAT_ACTOR_GALAXY_TYPE) {
    throw new Error(`actor_reference: not the MISP threat-actor galaxy (uuid=${String(doc.uuid).slice(0, 40)}, type=${String(doc.type).slice(0, 40)})`);
  }
  if (!Array.isArray(doc.values)) throw new Error("actor_reference: galaxy has no values array");

  const version = typeof doc.version === "number" || typeof doc.version === "string" ? String(doc.version) : null;
  const records: ActorReferenceRecord[] = [];
  const seen = new Set<string>();
  let malformed = 0;

  for (const v of doc.values as unknown[]) {
    if (!isObject(v)) { malformed++; continue; }
    const uuid = typeof v.uuid === "string" ? v.uuid.trim().toLowerCase() : "";
    const name = cleanText(v.value, ACTOR_ALIAS_MAX_CHARS);
    const nameNorm = normalizeActorName(name);
    if (!UUID_RE.test(uuid) || !name || !nameNorm || seen.has(uuid)) { malformed++; continue; }
    seen.add(uuid);

    const meta = isObject(v.meta) ? v.meta : {};
    const aliases: Array<{ original: string; norm: string }> = [{ original: name, norm: nameNorm }];
    const norms = new Set<string>([nameNorm]);
    const synonyms = Array.isArray(meta.synonyms) ? meta.synonyms : [];
    for (const syn of synonyms) {
      if (aliases.length >= ACTOR_MAX_ALIASES) break;
      const original = cleanText(syn, ACTOR_ALIAS_MAX_CHARS);
      const norm = normalizeActorName(original);
      if (!original || !norm || norms.has(norm)) continue;
      norms.add(norm);
      aliases.push({ original, norm });
    }

    const countryCodeVal = countryCode(meta.country);
    const stateSponsor = cleanText(meta["cfr-suspected-state-sponsor"], 120);
    const description = cleanText(v.description, ACTOR_DESCRIPTION_MAX_CHARS);
    const contentHash = await sha256Hex(JSON.stringify([name, countryCodeVal, stateSponsor, description, aliases]));
    records.push({
      id: `misp:${uuid}`,
      sourceUuid: uuid,
      name,
      countryCode: countryCodeVal,
      stateSponsor,
      description,
      aliases,
      contentHash,
    });
  }
  return { version, declared: (doc.values as unknown[]).length, records, malformed };
}

/** The `reference` block on the staff threat-actor detail. */
export interface ActorReferenceView {
  id: string;
  name: string;
  aliases: string[];
  country_code: string | null;
  state_sponsor: string | null;
  description: string | null;
  source: string;
  source_version: string | null;
  updated_at: string;
  /** The platform name/alias that resolved to this entry. */
  matched_on: string;
  credit: string;
}

/**
 * Pure resolution step: given the live reference ids each normalised key
 * maps to, return the single reference the keys agree on, or null.
 *
 * A key that maps to more than one reference (an ambiguous alias) resolves
 * to nothing and contributes nothing; keys that match nothing are ignored.
 * Only keys that map to exactly one reference count, and they must all
 * agree: if the platform actor's name and one of its aliases point at
 * DIFFERENT references, the answer is null — guessing is worse than no
 * answer.
 */
export function resolveFromCandidates(
  keys: string[],
  candidates: Map<string, Set<string>>,
): { referenceId: string; matchedKey: string } | null {
  let chosen: { referenceId: string; matchedKey: string } | null = null;
  for (const k of keys) {
    const ids = candidates.get(k);
    if (!ids || ids.size !== 1) continue;
    const [id] = [...ids];
    if (!id) continue;
    if (chosen && chosen.referenceId !== id) return null;
    if (!chosen) chosen = { referenceId: id, matchedKey: k };
  }
  return chosen;
}

/** D1 binds per lookup statement (D1 caps a statement at 100). */
const LOOKUP_CHUNK = 90;

/**
 * Resolve a platform actor (its name + aliases) to one live reference entry,
 * or null when nothing matches, any key is ambiguous, or the keys disagree.
 * Read-only. Fails soft: a missing table (migration not yet applied) or any
 * D1 error returns null.
 */
export async function lookupActorReference(
  db: D1Database,
  names: string[],
): Promise<ActorReferenceView | null> {
  const keyToOriginal = new Map<string, string>();
  for (const n of names) {
    const k = normalizeActorName(n);
    // Keys of 3 characters or fewer (SEA, UPS, RTM…) or with no letter collide
    // with unrelated names too easily to show as a match.
    if (k && k.length > 3 && /\p{L}/u.test(k) && !keyToOriginal.has(k)) keyToOriginal.set(k, n);
  }
  const keys = [...keyToOriginal.keys()];
  if (keys.length === 0) return null;
  try {
    const candidates = new Map<string, Set<string>>();
    for (let i = 0; i < keys.length; i += LOOKUP_CHUNK) {
      const chunk = keys.slice(i, i + LOOKUP_CHUNK);
      const rows = await db.prepare(
        `SELECT DISTINCT a.alias_norm, a.reference_id
           FROM actor_reference_aliases a
           JOIN actor_reference r ON r.id = a.reference_id
          WHERE a.alias_norm IN (${chunk.map(() => "?").join(",")})
            AND r.removed_at IS NULL`,
      ).bind(...chunk).all<{ alias_norm: string; reference_id: string }>();
      for (const r of rows.results ?? []) {
        const set = candidates.get(r.alias_norm) ?? new Set<string>();
        set.add(r.reference_id);
        candidates.set(r.alias_norm, set);
      }
    }
    const hit = resolveFromCandidates(keys, candidates);
    if (!hit) return null;

    const ref = await db.prepare(
      `SELECT id, name, country_code, state_sponsor, description, source, source_version, updated_at
         FROM actor_reference WHERE id = ? AND removed_at IS NULL`,
    ).bind(hit.referenceId).first<{
      id: string; name: string; country_code: string | null; state_sponsor: string | null;
      description: string | null; source: string; source_version: string | null; updated_at: string;
    }>();
    if (!ref) return null;
    const aliasRows = await db.prepare(
      `SELECT alias_original FROM actor_reference_aliases WHERE reference_id = ? ORDER BY position LIMIT 200`,
    ).bind(hit.referenceId).all<{ alias_original: string }>();
    return {
      id: ref.id,
      name: ref.name,
      aliases: (aliasRows.results ?? []).map((r) => r.alias_original).filter((a) => a !== ref.name),
      country_code: ref.country_code,
      state_sponsor: ref.state_sponsor,
      description: ref.description,
      source: ref.source,
      source_version: ref.source_version,
      updated_at: ref.updated_at,
      matched_on: keyToOriginal.get(hit.matchedKey) ?? hit.matchedKey,
      credit: ACTOR_REFERENCE_CREDIT,
    };
  } catch {
    return null;
  }
}
