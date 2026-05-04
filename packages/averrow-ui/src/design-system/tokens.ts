// Averrow Design System — Runtime tokens
//
// JS objects for design tokens that need string values at runtime
// (e.g. computing accent gradients dynamically). The same values
// also exist as CSS custom properties in tokens.css — that's the
// preferred form when authoring CSS. Use these objects when:
//   - You need to compose a hex value into a string template literal
//   - You need to pass a color to a component prop typed as string
//
// Keep this file in sync with tokens.css.

export const M = {
  AMBER:     '#E5A832',
  AMBER_DIM: '#B8821F',
  RED:       '#C83C3C',
  RED_DIM:   '#8B1A1A',
  BLUE:      '#0A8AB5',
  BLUE_DIM:  '#065A78',
  GREEN:     '#3CB878',
  GREEN_DIM: '#1A6B3C',
} as const;

export type AccentColorKey = keyof typeof M;

export const SEV: Record<string, {
  dot: string;
  bg: string;
  border: string;
  text: string;
}> = {
  critical: { dot: '#f87171', bg: 'rgba(239,68,68,0.10)',  border: 'rgba(239,68,68,0.30)',  text: '#fca5a5' },
  high:     { dot: '#fb923c', bg: 'rgba(249,115,22,0.08)', border: 'rgba(249,115,22,0.25)', text: '#fdba74' },
  medium:   { dot: '#fbbf24', bg: 'rgba(229,168,50,0.08)', border: 'rgba(229,168,50,0.22)', text: '#fcd34d' },
  low:      { dot: '#60a5fa', bg: 'rgba(59,130,246,0.07)', border: 'rgba(59,130,246,0.20)', text: '#93c5fd' },
  info:     { dot: '#4ade80', bg: 'rgba(74,222,128,0.07)', border: 'rgba(74,222,128,0.15)', text: '#86efac' },
};
