// Identity colours for the Network view. Each agent keeps the colour it has on
// its icon and grid card (`agent.color`, else the registry colour). Identity
// colours are tuned for a dark canvas, so on a light page they are darkened at
// runtime by mixing toward the theme's text colour until they reach 3:1 against
// the card. No per-theme hex table: the page tokens supply both ends.

import type { Agent } from '@/hooks/useAgents';
import { AGENT_METADATA, type AgentId } from '@/lib/agent-metadata';
import {
  FEED_NRD, GROUP_ENRICHMENT, GROUP_INGEST, GROUP_SOCIAL, HUB_THREATS,
} from './model';

export type RGB = [number, number, number];

/** Minimum contrast of an identity colour against the card (WCAG non-text). */
export const MIN_IDENTITY_CONTRAST = 3;

export function hexToRgb(hex: string): RGB | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1]!;
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export function relativeLuminance([r, g, b]: RGB): number {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrastRatio(a: RGB, b: RGB): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export function mixRgb(a: RGB, b: RGB, t: number): RGB {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

/**
 * `rgb` moved toward `anchor` (the theme's text colour) just far enough to
 * reach `min` contrast against `bg`. Colours that already pass are untouched,
 * so on dark they keep their identity and on light they darken.
 */
export function ensureContrast(rgb: RGB, bg: RGB, anchor: RGB, min: number = MIN_IDENTITY_CONTRAST): RGB {
  if (contrastRatio(rgb, bg) >= min) return rgb;
  for (let i = 1; i <= 20; i++) {
    const mixed = mixRgb(rgb, anchor, i / 20);
    if (contrastRatio(mixed, bg) >= min) return mixed;
  }
  return anchor;
}

/** Text colour for use on a filled identity colour: whichever of the two reads best. */
export function inkFor(fill: RGB, light: RGB, dark: RGB): RGB {
  return contrastRatio(fill, light) >= contrastRatio(fill, dark) ? light : dark;
}

export function rgbCss(rgb: RGB, alpha = 1): string {
  return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`;
}

/** The colour a feed group wears (one per feed type). */
export const FEED_GROUP_TOKEN: Record<string, string> = {
  [GROUP_INGEST]: '--blue',
  [GROUP_ENRICHMENT]: '--green',
  [GROUP_SOCIAL]: '--violet',
  [FEED_NRD]: '--blue',
};

/** Raw identity colour of an agent: the API colour, else the registry colour. */
export function agentIdentityHex(id: string, agent?: Pick<Agent, 'color'>): string | undefined {
  const fromApi = agent?.color && hexToRgb(agent.color) ? agent.color : undefined;
  return fromApi ?? AGENT_METADATA[id as AgentId]?.color;
}

export interface IdentityInput {
  /** Card background and the theme's text colour (resolved tokens). */
  bg: RGB;
  anchor: RGB;
  /** Fallback for an agent with no colour, and the hub colour. */
  primary: RGB;
  /** Resolved feed-group colours keyed by group node id. */
  feeds: Record<string, RGB | undefined>;
  agents: ReadonlyMap<string, Pick<Agent, 'color'>>;
}

export interface Identity {
  /** Contrast-adjusted colour for a node, lane or feed group id. */
  rgb(id: string): RGB;
  /** The same as an rgba() string. */
  css(id: string, alpha?: number): string;
}

/** Resolve (and cache) the identity colour of any node id. */
export function buildIdentity(input: IdentityInput): Identity {
  const cache = new Map<string, RGB>();
  const resolve = (id: string): RGB => {
    const hit = cache.get(id);
    if (hit) return hit;
    let base: RGB | undefined;
    if (id === HUB_THREATS) base = input.primary;
    else if (input.feeds[id]) base = input.feeds[id];
    else {
      const hex = agentIdentityHex(id, input.agents.get(id));
      base = (hex && hexToRgb(hex)) || input.primary;
    }
    const out = ensureContrast(base as RGB, input.bg, input.anchor);
    cache.set(id, out);
    return out;
  };
  return { rgb: resolve, css: (id, alpha = 1) => rgbCss(resolve(id), alpha) };
}
