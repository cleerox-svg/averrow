// Accent colours (raw hexes / --amber, --green, …) are chosen for fills,
// borders and glows and fail WCAG AA (4.5:1) as TEXT — on light cards, and
// red/blue/purple on dark ones too. `accentText` maps a known accent to its
// theme-aware text token so a single `accent` prop can drive both the fill
// and a readable text colour. Unknown values pass through unchanged.
const ACCENT_TEXT: Record<string, string> = {
  '#e5a832': 'var(--amber-text)',
  'var(--amber)': 'var(--amber-text)',
  '#3cb878': 'var(--green-text)',
  'var(--green)': 'var(--green-text)',
  '#28a050': 'var(--green-text)',
  '#c83c3c': 'var(--red-text)',
  'var(--red)': 'var(--red-text)',
  '#0a8ab5': 'var(--blue-text)',
  'var(--blue)': 'var(--blue-text)',
  '#9b59b6': 'var(--violet-text)',
  '#e8923c': 'var(--sev-high-text)',
  '#fb923c': 'var(--sev-high-text)',
  'var(--sev-high)': 'var(--sev-high-text)',
  '#dcaa32': 'var(--sev-medium-text)',
  '#fbbf24': 'var(--sev-medium-text)',
  'var(--sev-medium)': 'var(--sev-medium-text)',
  '#f87171': 'var(--sev-critical-text)',
  'var(--sev-critical)': 'var(--sev-critical-text)',
  '#78a0c8': 'var(--sev-low-text)',
  '#60a5fa': 'var(--sev-low-text)',
  'var(--sev-low)': 'var(--sev-low-text)',
  '#4ade80': 'var(--sev-info-text)',
  'var(--sev-info)': 'var(--sev-info-text)',
};

export function accentText(accent: string): string {
  return ACCENT_TEXT[accent.trim().toLowerCase()] ?? accent;
}
