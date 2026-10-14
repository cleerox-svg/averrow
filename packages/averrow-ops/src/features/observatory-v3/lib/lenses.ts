/**
 * Lens + layer model for the Observatory console.
 *
 * A LENS is a question the map answers (who / where / where next …). A LAYER is
 * one drawable thing. Each lens switches on its own layer (plus any the analyst
 * adds from the rail), so lenses compose: "Threats" with the Operations layer on
 * is the mock-up's console view. Pure data — shared by URL state, the rail, the
 * switcher, data gating and tests.
 */

export const LENS_IDS = ['threats', 'operations', 'movement', 'hosting', 'baseline', 'campaigns', 'actors'] as const;
export type LensId = (typeof LENS_IDS)[number];

export const LAYER_IDS = [
  'nodes', 'particles', 'beams',
  'operations', 'movement', 'hosting', 'baseline', 'campaigns', 'actors',
] as const;
export type LayerId = (typeof LAYER_IDS)[number];
export type LayerToggles = Record<LayerId, boolean>;

export interface LensDef {
  id: LensId;
  label: string;
  /** The question this lens answers (tooltip + empty states). */
  question: string;
  /** Layers switched on by default when the lens is chosen. */
  layers: readonly LayerId[];
}

export const LENS_DEFS: Record<LensId, LensDef> = {
  threats: { id: 'threats', label: 'Threats', question: 'Where are threats coming from and who do they hit?', layers: ['nodes', 'particles'] },
  operations: { id: 'operations', label: 'Operations', question: 'Which countries does one operator span?', layers: ['operations'] },
  movement: { id: 'movement', label: 'Movement', question: 'Where is infrastructure moving to?', layers: ['movement'] },
  hosting: { id: 'hosting', label: 'Hosting', question: 'Where do operators choose to host?', layers: ['hosting'] },
  baseline: { id: 'baseline', label: 'Baseline', question: 'Where do we see more than normal attack traffic?', layers: ['baseline'] },
  campaigns: { id: 'campaigns', label: 'Campaigns', question: 'Which curated campaigns link adversary and target countries?', layers: ['campaigns'] },
  actors: { id: 'actors', label: 'Actors', question: 'Where does a known actor operate?', layers: ['actors'] },
};

export function isLensId(v: string | null | undefined): v is LensId {
  return v != null && (LENS_IDS as readonly string[]).includes(v);
}

export function noLayers(): LayerToggles {
  return Object.fromEntries(LAYER_IDS.map(id => [id, false])) as LayerToggles;
}

/** The layer set a lens turns on by default. */
export function lensPreset(lens: LensId): LayerToggles {
  const out = noLayers();
  for (const id of LENS_DEFS[lens].layers) out[id] = true;
  return out;
}

export function sameLayers(a: LayerToggles, b: LayerToggles): boolean {
  return LAYER_IDS.every(id => a[id] === b[id]);
}

export interface LayerDef {
  id: LayerId;
  label: string;
  /** Swatch colour in the rail (fixed: the basemap is always dark). */
  swatch: string;
  group: 'threats' | 'lens';
  /** Number-key shortcut while focus is on the map / rail. */
  key: string;
  description: string;
}

export const LAYER_DEFS: readonly LayerDef[] = [
  { id: 'nodes', label: 'Nodes', swatch: '#f87171', group: 'threats', key: '1', description: 'Threat origins, sized by count' },
  { id: 'particles', label: 'Particles', swatch: '#E5A832', group: 'threats', key: '2', description: 'Attacks in flight, with impact rings' },
  { id: 'beams', label: 'Beams', swatch: '#fb923c', group: 'threats', key: '3', description: 'Static attack corridors' },
  { id: 'operations', label: 'Operations', swatch: '#7aeaff', group: 'lens', key: '4', description: 'NEXUS operations across countries' },
  { id: 'movement', label: 'Movement', swatch: '#a78bfa', group: 'lens', key: '5', description: 'Infrastructure migrating between hosts' },
  { id: 'hosting', label: 'Hosting', swatch: '#3CB878', group: 'lens', key: '6', description: 'Providers by active threats' },
  { id: 'baseline', label: 'Baseline', swatch: '#60a5fa', group: 'lens', key: '7', description: 'Our share vs Cloudflare Radar' },
  { id: 'campaigns', label: 'Campaigns', swatch: '#f472b6', group: 'lens', key: '8', description: 'Curated adversary to target links' },
  { id: 'actors', label: 'Actors', swatch: '#f0abfc', group: 'lens', key: '9', description: 'A known actor\'s infrastructure' },
];

export const LAYER_BY_ID: Record<LayerId, LayerDef> = Object.fromEntries(
  LAYER_DEFS.map(d => [d.id, d]),
) as Record<LayerId, LayerDef>;
