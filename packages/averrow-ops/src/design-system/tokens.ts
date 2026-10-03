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
  /**
   * Neutral accent — used for stat-card "zero state" so a count of 0
   * doesn't render in alert red. Calm slate. The zero-state rule itself now
   * lives in the shared kit (`resolveStatAccent` in packages/shared/src/ui/lib/stat-accent.ts, used by StatTile).
   */
  NEUTRAL:   '#5a6a85',
} as const;

export type AccentColorKey = keyof typeof M;
