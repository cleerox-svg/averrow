// Appearance constants, split out of useAppearance.ts so tests can mock the
// defaults to simulate either side of the facelift flip (vi.doMock on this
// module).

export const ACCENTS = ['indigo', 'violet', 'mono', 'lime'] as const;
export const BASES = ['graphite', 'navy'] as const;

export type Accent = (typeof ACCENTS)[number];
export type Base = (typeof BASES)[number];

/** THE facelift switch (P3-6). Everything below derives from it, and both
 *  apps' index.html are generated from it at build time
 *  (packages/shared/scripts/appearance-html.ts): the no-flash bootstrap
 *  defaults, the theme-color meta, the Geist font preloads and dropping the
 *  Google Fonts link. Reverting the facelift = setting this to false. */
export const FACELIFT: boolean = false;

/** Default page colour per side of the flip: the indigo/graphite dark
 *  --bg-page (appearance.css) when on, the legacy navy (tokens.css) when off.
 *  Used for <meta name="theme-color"> and the PWA manifest. */
export const LEGACY_THEME_COLOR = '#060A14';
export const FACELIFT_THEME_COLOR = '#0a0b0e';

export interface AppearanceFlags {
  defaultAccent: Accent | null;
  defaultBase: Base | null;
  pickerEnabled: boolean;
  themeColor: string;
}

/** The derived defaults for one value of the switch (pure, for the build
 *  plugin and tests). */
export function appearanceFlags(facelift: boolean): AppearanceFlags {
  return facelift
    ? { defaultAccent: 'indigo', defaultBase: 'graphite', pickerEnabled: true, themeColor: FACELIFT_THEME_COLOR }
    : { defaultAccent: null, defaultBase: null, pickerEnabled: false, themeColor: LEGACY_THEME_COLOR };
}

const FLAGS = appearanceFlags(FACELIFT);

/** Facelift on: 'indigo', and a stored null/absent accent means "the default
 *  (indigo)". The legacy amber look is NOT user-selectable (owner decision).
 *  Facelift off: `null` = legacy look, no data-accent attribute. */
export const DEFAULT_ACCENT: Accent | null = FLAGS.defaultAccent;
/** Facelift on: 'graphite'. Off: `null` = no data-base attribute. */
export const DEFAULT_BASE: Base | null = FLAGS.defaultBase;

/** Settings -> Appearance (accent + background picker) and the account-synced
 *  hydration of accent/base from the server. While false the section is
 *  hidden (its route redirects to the profile page) and the server's
 *  accent/base are NOT applied. Tests mock this module (vi.mock / vi.doMock)
 *  to exercise either state. */
export const APPEARANCE_PICKER_ENABLED: boolean = FLAGS.pickerEnabled;
