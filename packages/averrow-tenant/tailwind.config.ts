import type { Config } from 'tailwindcss';

// averrow-tenant inherits the Averrow design language but does NOT
// share averrow-ops's frozen widgets (ThreatMap, ExposureGauge, etc.).
// Eventually the design-system primitives port into this package via
// a workspace import; for now we redeclare the minimum.
//
// Theme tokens (bg-page / bg-card / bg-sidebar / text-* / border-*)
// reference CSS custom properties so they flip with [data-theme="light"].
// Those overrides live in `packages/shared/src/theme/tokens.css`, NOT in
// this package's src/index.css — index.css carries no light-theme block
// of its own, and the shared file says so explicitly. (This comment
// previously named index.css and was wrong.)
//
// Accent hues (amber, and the raw severity colors) stay constant across
// themes by design — see CLAUDE.md §5.
//
// READ THIS BEFORE "FIXING" `text-sev-*` OR `text-white/NN` HERE.
// Taken at face value these look like light-theme contrast bugs: raw
// `#f87171` scores only 2.77:1 on the light theme's white `--bg-card`,
// and `text-white/NN` is a hard-coded white that no var() can flip. Both
// readings are wrong, because neither class resolves to its literal
// value under light. `packages/shared/src/theme/tokens.css` carries two
// parity shims that remap them:
//
//   [data-theme="light"] .text-sev-critical { color: var(--sev-critical-text); }
//   [data-theme="light"] .text-white\/40    { color: rgba(15,20,35,0.48); }
//
// So `text-sev-critical` already renders `#b91c1c` (6.47:1) under light,
// and every one of the 17 `text-white/NN` opacities this package uses has
// a matching override there. A sweep replacing them is not a fix — it
// would change the DARK appearance (the theme all users see today) for no
// contrast gain. This has been mis-filed as a finding twice; verify
// against the generated CSS, not the literal, before acting.
//
// The `sev-*-text` entries below exist for NEW code, following that
// shim block's own stated direction: prefer a semantic var that flips on
// its own over a raw utility needing a bespoke parity rule. Existing
// `text-sev-*` call sites are correct as they are — leave them.
const config: Config = {
  // Include @averrow/shared source so utility classes used only in shared
  // components (ProfilePage, LoginPage, …) aren't purged. See login audit.
  content: ['./index.html', './src/**/*.{ts,tsx}', '../shared/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Backgrounds — theme-flippable
        'bg-page':     'var(--bg-page)',
        'bg-card':     'var(--bg-card)',
        'bg-sidebar':  'var(--bg-sidebar)',
        // Borders — theme-flippable
        'border-base':   'var(--border-base)',
        'border-strong': 'var(--border-strong)',
        // Accents — constant across themes
        'amber':      '#E5A832',
        'amber-dim':  '#B8821F',
        'red':        '#C83C3C',
        'red-dim':    '#8B1A1A',
        'green':      '#3CB878',
        'blue':       '#0A8AB5',
        // Severity HUES — constant across themes. Correct for tints
        // (bg-sev-*/[0.06], border-sev-*/[0.25]) and, thanks to the
        // tokens.css shim noted above, correct for existing text call
        // sites too.
        'sev-critical': '#f87171',
        'sev-high':     '#fb923c',
        'sev-medium':   '#fbbf24',
        'sev-low':      '#60a5fa',
        // Severity TEXT — theme-aware, mirroring averrow-ops. NEW code
        // should reach for these rather than a raw hue, so it flips on
        // its own instead of needing another shim rule. They resolve to
        // an AA-contrast dark variant under light and the lighter one
        // under dark; both are defined in
        // packages/shared/src/theme/tokens.css. Not a migration target
        // for the existing `text-sev-*` sites — see the note above.
        'sev-critical-text': 'var(--sev-critical-text)',
        'sev-high-text':     'var(--sev-high-text)',
        'sev-medium-text':   'var(--sev-medium-text)',
        'sev-low-text':      'var(--sev-low-text)',
        'sev-info-text':     'var(--sev-info-text)',
      },
      // Averrow scale tokens (shared/src/theme/tokens.css). Radius keys are
      // `ds-*` so they don't shadow Tailwind's built-in rounded-sm/md/lg/xl.
      borderRadius: {
        'ds-xs':   'var(--radius-xs)',
        'ds-sm':   'var(--radius-sm)',
        'ds-md':   'var(--radius-md)',
        'ds-lg':   'var(--radius-lg)',
        'ds-xl':   'var(--radius-xl)',
        'ds-pill': 'var(--radius-pill)',
      },
      transitionDuration: {
        instant: 'var(--dur-instant)',
        fast:    'var(--dur-fast)',
        base:    'var(--dur-base)',
        slow:    'var(--dur-slow)',
        slower:  'var(--dur-slower)',
      },
      transitionTimingFunction: {
        'ds-standard':   'var(--ease-standard)',
        'ds-out':        'var(--ease-out)',
        'ds-emphasized': 'var(--ease-emphasized)',
      },
      fontFamily: {
        sans: ['var(--font-sans)'],
        display: ['var(--font-display)'],
        mono: ['var(--font-mono)'],
      },
    },
  },
  plugins: [],
};

export default config;
