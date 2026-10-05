// One focus convention for the account kit (ACCOUNT_DESIGN_SPEC §7).
// Tailwind scans these literals, so keep them as full class strings.

/** Text-entry controls (Input, TimeInput, Select, TimezoneSelect trigger): border + 3px glow. */
export const FOCUS_FIELD =
  'focus:border-[var(--focus-ring,var(--amber))] focus:shadow-[0_0_0_3px_var(--amber-glow,rgba(229,168,50,0.40))]';

/** Buttons, switches, segments: 2px outline, 2px outside. */
export const FOCUS_RING =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring,var(--amber))]';

/** Rows / menu items that sit flush in a container: outline drawn inside. */
export const FOCUS_RING_INSET =
  'focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--focus-ring,var(--amber))]';
