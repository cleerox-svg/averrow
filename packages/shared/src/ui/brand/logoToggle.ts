// Legacy <-> R3 logo toggle (facelift P3-5). Since the P3-6 flip every page
// carries `data-accent` (indigo by default), so users see the R3 logo; with
// FACELIFT reverted (theme/appearanceDefaults.ts) no accent is set and the
// legacy logo shows, pixel-identical to before. Swap sites render BOTH: the legacy element(s) get
// LOGO_LEGACY_CLASS, the R3 element gets LOGO_R3_CLASS (shown inline-flex) or
// LOGO_R3_BLOCK_CLASS (shown as a block). The rules live at the end of
// theme/tokens.css:
//   .av-logo-r3, .av-logo-r3-block       { display: none }   (no accent)
//   :root[data-accent] .av-logo-legacy   { display: none }
//   :root[data-accent] .av-logo-r3       { display: inline-flex }
//   :root[data-accent] .av-logo-r3-block { display: block }
// display:none also drops the hidden variant from the accessibility tree.

export const LOGO_LEGACY_CLASS = 'av-logo-legacy';
export const LOGO_R3_CLASS = 'av-logo-r3';
export const LOGO_R3_BLOCK_CLASS = 'av-logo-r3-block';
