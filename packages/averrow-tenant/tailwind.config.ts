import type { Config } from 'tailwindcss';

// averrow-tenant inherits the Averrow design language but does NOT
// share averrow-ui's frozen widgets (ThreatMap, ExposureGauge, etc.).
// Eventually the design-system primitives port into this package via
// a workspace import; for now we redeclare the minimum.
//
// Theme tokens (bg-page / bg-card / bg-sidebar / text-* / border-*)
// reference CSS custom properties so they flip with [data-theme="light"]
// from src/index.css. Accents (amber, severity) stay constant across
// themes — no var() wrapping needed.
const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
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
        // Severity — constant across themes
        'sev-critical': '#f87171',
        'sev-high':     '#fb923c',
        'sev-medium':   '#fbbf24',
        'sev-low':      '#60a5fa',
      },
      fontFamily: {
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
};

export default config;
