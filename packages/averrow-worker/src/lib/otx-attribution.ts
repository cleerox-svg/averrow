// OTX → threat_actor attribution.
//
// AlienVault OTX pulses carry two attribution signals we map into our
// threat_actors table:
//   1. `adversary` field — the strongest signal when the pulse author
//      explicitly named the responsible actor.
//   2. tags — many pulses tag the actor by alias instead of using the
//      adversary field (e.g. tag "apt28" or "fancy-bear").
//
// We canonicalize either signal against ALIAS_TO_CANONICAL below so
// that the Threat Actors page doesn't render "Fancy Bear", "APT28",
// and "Sofacy" as three separate entries — they all collapse to APT28.
//
// Auto-creates new threat_actors rows for first-seen names; subsequent
// pulses bump the actor's last_seen + updated_at so the Threat Actors
// page reflects real recent activity instead of seed data.

export interface OtxPulse {
  id: string;
  name: string;
  description?: string;
  adversary?: string;
  tags?: string[];
  targeted_countries?: string[];
  industries?: string[];
  attack_ids?: string[];
}

// ─── Canonical name registry ───────────────────────────────────────────────
//
// Lowercase alias → canonical name. Add aliases here as they show up in
// real OTX data; the app code stays unchanged because canonicalization
// runs through this map.
//
// Keep canonical names matching what reference threat-intel orgs (MITRE
// ATT&CK, Mandiant, Microsoft) use most consistently — usually the APT
// number for state-sponsored, the cluster name for commodity crime.
const ALIAS_TO_CANONICAL: Record<string, string> = {
  // ── Russian-attributed
  'apt28':           'APT28',
  'fancy bear':      'APT28',
  'fancy-bear':      'APT28',
  'fancybear':       'APT28',
  'sofacy':          'APT28',
  'strontium':       'APT28',
  'forest blizzard': 'APT28',
  'apt29':           'APT29',
  'cozy bear':       'APT29',
  'cozy-bear':       'APT29',
  'cozybear':        'APT29',
  'nobelium':        'APT29',
  'midnight blizzard': 'APT29',
  'turla':           'Turla',
  'snake':           'Turla',
  'venomous bear':   'Turla',
  'sandworm':        'Sandworm',
  'apt44':           'Sandworm',
  'voodoo bear':     'Sandworm',

  // ── North Korean
  'lazarus':         'Lazarus Group',
  'lazarus group':   'Lazarus Group',
  'apt38':           'Lazarus Group',
  'hidden cobra':    'Lazarus Group',
  'kimsuky':         'Kimsuky',
  'velvet chollima': 'Kimsuky',
  'andariel':        'Andariel',
  'apt45':           'Andariel',

  // ── Chinese
  'apt1':            'APT1',
  'comment crew':    'APT1',
  'apt10':           'APT10',
  'menupass':        'APT10',
  'stone panda':     'APT10',
  'apt40':           'APT40',
  'leviathan':       'APT40',
  'kryptonite panda':'APT40',
  'apt41':           'APT41',
  'barium':          'APT41',
  'wicked panda':    'APT41',
  'mustang panda':   'Mustang Panda',
  'redfoxtrot':      'Mustang Panda',

  // ── Iranian (already in our reference table after migration 0093)
  'apt35':           'Charming Kitten',
  'charming kitten': 'Charming Kitten',
  'charming-kitten': 'Charming Kitten',
  'phosphorus':      'Charming Kitten',
  'mint sandstorm':  'Charming Kitten',
  'newsbeef':        'Charming Kitten',
  'muddywater':      'MuddyWater',
  'mercury':         'MuddyWater',
  'static kitten':   'MuddyWater',
  'mango sandstorm': 'MuddyWater',
  'apt33':           'APT33',
  'elfin':           'APT33',
  'peach sandstorm': 'APT33',
  'oilrig':          'OilRig',
  'apt34':           'OilRig',
  'helix kitten':    'OilRig',
  'hazel sandstorm': 'OilRig',
  'agrius':          'Agrius',
  'blackshadow':     'Agrius',
  'sharpboys':       'Agrius',
  'cyberav3ngers':   'CyberAv3ngers',
  'cyberavengers':   'CyberAv3ngers',
  'cyber avengers':  'CyberAv3ngers',
  'handala':         'Handala',
  'handala hack team':'Handala',
  'hydro kitten':    'Hydro Kitten',
  'cotton sandstorm':'Cotton Sandstorm',
  'neptunium':       'Cotton Sandstorm',
  'emennet pasargad':'Cotton Sandstorm',

  // ── Cybercriminal / commodity
  'fin7':            'FIN7',
  'carbanak':        'FIN7',
  'fin12':           'FIN12',
  'wizard spider':   'Wizard Spider',
  'trickbot group':  'Wizard Spider',
  'conti':           'Conti',
  'lockbit':         'LockBit',
  'alphv':           'ALPHV',
  'blackcat':        'ALPHV',
};

/**
 * Canonicalize a free-form actor name or alias against the registry.
 * Returns the canonical name (e.g. "APT28") or null if unrecognized.
 * Exported so other attribution paths (NEXUS, news/RSS) share the same
 * alias table.
 */
export function canonicalActorName(s: string): string | null {
  const key = s.toLowerCase().trim();
  if (!key) return null;
  if (ALIAS_TO_CANONICAL[key]) return ALIAS_TO_CANONICAL[key];
  // Direct match against canonical values (case-insensitive)
  for (const v of new Set(Object.values(ALIAS_TO_CANONICAL))) {
    if (v.toLowerCase() === key) return v;
  }
  return null;
}

/**
 * Pulls the actor name out of a pulse. Prefers `adversary`, falls back
 * to scanning tags. Returns the canonical form if recognized; otherwise
 * returns the raw adversary string (so first-seen actors don't get
 * silently dropped — the Threat Actors page will show them by their
 * raw OTX name until we add an alias mapping).
 */
export function extractActorFromPulse(pulse: OtxPulse): string | null {
  if (pulse.adversary) {
    const c = canonicalActorName(pulse.adversary);
    if (c) return c;
    return pulse.adversary.trim() || null;
  }
  for (const tag of pulse.tags ?? []) {
    const c = canonicalActorName(tag);
    if (c) return c;
  }
  return null;
}

/** Stable id derived from the canonical actor name. */
export function actorIdFor(canonicalName: string): string {
  const slug = canonicalName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  return `ta_${slug || 'unknown'}`;
}

export type AttributionSource = 'otx' | 'nexus' | 'manual' | 'news';

/**
 * Generic actor upsert by raw name. Used by both OTX (pulse adversary)
 * and NEXUS (Haiku-classified cluster). Canonicalizes the input name,
 * falls back to the raw string if unknown so first-seen actors don't
 * get silently dropped. Returns the actor id, or null if the name is
 * blank.
 */
export async function upsertActorByName(
  db: D1Database,
  rawName: string,
  source: AttributionSource,
  countryCode: string | null = null,
): Promise<string | null> {
  const trimmed = (rawName || '').trim();
  if (!trimmed) return null;
  const actorName = canonicalActorName(trimmed) ?? trimmed;
  const id = actorIdFor(actorName);

  // INSERT new actors with the calling source as provenance. On conflict
  // bump only the freshness columns — never overwrite country/status/
  // description/source on existing rows since the reference taxonomy or
  // a higher-confidence source may have populated them.
  await db
    .prepare(`
      INSERT INTO threat_actors
        (id, name, status, source, country_code, first_seen, last_seen, updated_at)
      VALUES (?, ?, 'active', ?, ?, datetime('now'), datetime('now'), datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        last_seen  = datetime('now'),
        updated_at = datetime('now')
    `)
    .bind(id, actorName, source, countryCode)
    .run();

  return id;
}

/**
 * Generic threat → actor attribution record. Used by NEXUS (cluster
 * attribution) and any future writer. OTX has its own helper
 * (recordOtxAttribution) that carries the pulse-specific metadata.
 *
 * Idempotent on the deterministic `id` parameter — pass a stable id
 * derived from your source's record (e.g. `tat_nexus_${clusterId}_${threatId}`)
 * so repeated runs don't duplicate rows.
 */
export async function recordAttribution(
  db: D1Database,
  args: {
    id: string;
    threatId: string;
    actorId: string;
    source: AttributionSource;
    sourcePulseId?: string | null;
    sourcePulseName?: string | null;
    actorNameRaw?: string | null;
    confidence?: 'confirmed' | 'high' | 'medium' | 'low';
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await db
    .prepare(`
      INSERT OR IGNORE INTO threat_attributions
        (id, threat_id, actor_id, source, source_pulse_id, source_pulse_name,
         actor_name_raw, confidence, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .bind(
      args.id.slice(0, 100),
      args.threatId,
      args.actorId,
      args.source,
      args.sourcePulseId ?? null,
      args.sourcePulseName ?? null,
      args.actorNameRaw ?? null,
      args.confidence ?? 'medium',
      args.metadata ? JSON.stringify(args.metadata) : null,
    )
    .run();
}

/**
 * Upsert a threat_actor row from a pulse. Returns the actor id, or null
 * if the pulse carried no usable attribution. Idempotent: subsequent
 * calls bump last_seen + updated_at on existing rows.
 */
export async function upsertActorFromPulse(
  db: D1Database,
  pulse: OtxPulse,
): Promise<string | null> {
  const actorName = extractActorFromPulse(pulse);
  if (!actorName) return null;

  const id = actorIdFor(actorName);
  const country = pulse.targeted_countries?.[0] ?? null;

  // INSERT new actors with full provenance; on conflict, just bump the
  // freshness columns. We deliberately don't overwrite country, status,
  // or description on conflict — those may have richer values from the
  // reference taxonomy or from later news/Mandiant attribution.
  await db
    .prepare(`
      INSERT INTO threat_actors
        (id, name, status, source, country_code, first_seen, last_seen, updated_at)
      VALUES (?, ?, 'active', 'otx', ?, datetime('now'), datetime('now'), datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        last_seen  = datetime('now'),
        updated_at = datetime('now')
    `)
    .bind(id, actorName, country)
    .run();

  return id;
}

/**
 * Record a threat → actor attribution via OTX. Idempotent across reruns
 * for the same (pulse, threat) tuple — INSERT OR IGNORE on the deterministic id.
 */
export async function recordOtxAttribution(
  db: D1Database,
  threatId: string,
  actorId: string,
  pulse: OtxPulse,
): Promise<void> {
  // Deterministic id keeps reruns idempotent and lets the unique constraint
  // (PK) absorb dup writes from feed retries.
  const id = `tat_otx_${pulse.id}_${threatId}`.slice(0, 100);

  const metadata = JSON.stringify({
    tags: pulse.tags ?? [],
    targeted_countries: pulse.targeted_countries ?? [],
    industries: pulse.industries ?? [],
    attack_ids: pulse.attack_ids ?? [],
  });

  await db
    .prepare(`
      INSERT OR IGNORE INTO threat_attributions
        (id, threat_id, actor_id, source, source_pulse_id, source_pulse_name,
         actor_name_raw, confidence, metadata)
      VALUES (?, ?, ?, 'otx', ?, ?, ?, 'medium', ?)
    `)
    .bind(
      id,
      threatId,
      actorId,
      pulse.id,
      pulse.name,
      pulse.adversary ?? null,
      metadata,
    )
    .run();
}
