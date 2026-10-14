/**
 * Observatory map colour tables — the single source of truth for both the
 * WebGL layers (RGBA tuples) and the legends (CSS strings derived from the
 * same tuples, so they cannot drift). The basemap is always dark, so these are
 * fixed, not theme tokens; legend *text* uses theme tokens.
 */

export type Rgba = [number, number, number, number];
export type ColorBy = 'severity' | 'type';

export const SEVERITY_COLORS: Record<string, Rgba> = {
  critical: [200, 60,  60,  255],
  high:     [251, 146, 60,  220],
  medium:   [250, 204, 21,  180],
  low:      [120, 160, 200, 160],
  info:     [90,  128, 168, 140],
};

export const THREAT_TYPE_COLORS: Record<string, Rgba> = {
  phishing:               [200, 60,  60,  220],
  credential_harvesting:  [251, 146, 60,  220],
  malware_distribution:   [167, 139, 250, 220],
  c2:                     [239, 68,  68,  255],
  malicious_ip:           [120, 160, 200, 180],
  web_attack:             [251, 113, 133, 200],
  brute_force:            [250, 204, 21,  200],
  spam_botnet_c2:         [34,  211, 238, 220],
  typosquatting:          [220, 170, 50,  200],
  scanning:               [120, 160, 200, 180],
  impersonation:          [232, 146, 60,  220],
};

const TYPE_FALLBACK: Rgba = [120, 160, 200, 180];

/** Legend order. */
export const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'] as const;
export const TYPE_ORDER = Object.keys(THREAT_TYPE_COLORS);

/** Heatmap ramp (low -> high density). */
export const HEATMAP_COLOR_RANGE: Rgba[] = [
  [0, 212, 255, 0], [0, 212, 255, 80], [0, 212, 255, 160],
  [251, 146, 60, 180], [200, 60, 60, 220], [255, 50, 50, 255],
];

/** Fallback per-point heatmap weight when the server sends none. */
export const HEATMAP_SEVERITY_WEIGHT: Record<string, number> = { critical: 5, high: 3, medium: 2, low: 1 };

export function heatmapWeight(p: { weight?: number; severity?: string | null }): number {
  if (typeof p.weight === 'number' && Number.isFinite(p.weight) && p.weight > 0) return p.weight;
  return HEATMAP_SEVERITY_WEIGHT[(p.severity ?? '').toLowerCase()] ?? 1;
}

export function getSeverityColor(severity: string | null | undefined, alpha?: number): Rgba {
  const c = SEVERITY_COLORS[(severity ?? '').toLowerCase()] ?? SEVERITY_COLORS.info;
  return alpha != null ? [c[0], c[1], c[2], alpha] : c;
}

export function getTypeColor(type: string | null | undefined, alpha?: number): Rgba {
  const c = THREAT_TYPE_COLORS[type ?? ''] ?? TYPE_FALLBACK;
  return alpha != null ? [c[0], c[1], c[2], alpha] : c;
}

export function getArcColor(
  d: { severity?: string | null; threat_type?: string | null },
  colorMode: ColorBy,
  alpha?: number,
): Rgba {
  if (colorMode === 'severity') return getSeverityColor(d.severity ?? 'medium', alpha);
  return getTypeColor(d.threat_type ?? 'phishing', alpha);
}

/** Opaque CSS colour for a tuple (legend swatches). */
export function rgbCss(c: Rgba): string {
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

/** Theme-aware severity TEXT colours (labels only; layers keep the fixed tuples above). */
export const SEV_TEXT: Record<string, string> = {
  critical: 'var(--sev-critical-text)',
  high: 'var(--sev-high-text)',
  medium: 'var(--sev-medium-text)',
  low: 'var(--sev-low-text)',
  info: 'var(--sev-info-text)',
};

export function sevText(severity: string | null | undefined): string {
  return SEV_TEXT[(severity ?? '').toLowerCase()] ?? 'var(--sev-low-text)';
}

export function typeLabel(type: string | null | undefined): string {
  return (type ?? '').replace(/_/g, ' ');
}
