// Appearance constants, split out of useAppearance.ts so tests can mock the
// defaults to simulate the P3-6 flip (vi.doMock on this module).

export const ACCENTS = ['indigo', 'violet', 'mono', 'lime'] as const;
export const BASES = ['graphite', 'navy'] as const;

export type Accent = (typeof ACCENTS)[number];
export type Base = (typeof BASES)[number];

/** `null` = legacy look (no data-accent attribute) - TODAY ONLY. At P3-6 this
 *  flips to 'indigo' and `null` then means "the default (indigo)" rather than
 *  legacy: the legacy amber look will NOT be user-selectable after the flip
 *  (owner decision: indigo default for everyone). Keep the inline bootstrap
 *  literals in each app's index.html in sync (a test enforces it). */
export const DEFAULT_ACCENT: Accent | null = null;
/** `null` = no data-base attribute (graphite is the CSS default once an accent is set). */
export const DEFAULT_BASE: Base | null = null;

/** Settings -> Appearance (accent + background picker) and the account-synced
 *  hydration of accent/base from the server. `false` until the P3-6 flip:
 *  while false the section is hidden (its route redirects to the profile page)
 *  and the server's accent/base are NOT applied, so nothing changes for users.
 *  Flip together with DEFAULT_ACCENT / DEFAULT_BASE. Tests mock this module
 *  (vi.mock / vi.doMock) to exercise the enabled state. */
export const APPEARANCE_PICKER_ENABLED: boolean = false;
