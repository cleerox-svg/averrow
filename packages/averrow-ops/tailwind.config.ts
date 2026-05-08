import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        cockpit: '#080E18',
        instrument: '#0C1525',
        console: '#142236',
        bulkhead: '#1A2E48',
        fuselage: '#243A54',
        parchment: '#F0EDE8',
        contrail: '#78A0C8',
        accent: {
          DEFAULT: '#C83C3C',
          hover: '#B03232',
        },
        warning: '#E87040',
        positive: '#3CB878',
        severity: {
          critical: '#C83C3C',
          high: '#E8923C',
          medium: '#DCAA32',
          low: '#78A0C8',
          clear: '#28A050',
        },
        // Orbital Lock logo-extracted colors (reserved for Observatory map beams + logo glow)
        'orbital-teal': '#00d4ff',
        'thrust': '#7aeaff',
        'ring-glow': '#00b8d9',

        // --- New Design System Tokens ---

        // Backgrounds
        'deep-space': '#080C14',
        'instrument-panel': '#111827',
        'panel-highlight': '#1A2234',
        'instrument-edge': '#2A3548',

        // Text
        'instrument-white': '#E8ECF1',
        'gauge-gray': '#8896AB',

        // Primary accent — Afterburner Amber
        'afterburner': {
          DEFAULT: '#E5A832',
          hover: '#D49A28',
          muted: 'rgba(229,168,50,0.12)',
          border: 'rgba(229,168,50,0.3)',
        },

        // Secondary — Wing Blue
        'wing-blue': {
          DEFAULT: '#0A8AB5',
          muted: 'rgba(10,138,181,0.12)',
          border: 'rgba(10,138,181,0.3)',
        },

        // Alert — Signal Red
        'signal-red': {
          DEFAULT: '#C83C3C',
          deep: '#6B1010',
          muted: 'rgba(200,60,60,0.12)',
          border: 'rgba(200,60,60,0.3)',
        },

        // Status
        'clearance': '#34D399',
        'caution': '#FBBF24',

        // Light theme
        'cloud': '#F8F7F5',
        'warm-cream': '#F0EDE8',
        'warm-border': '#E2DDD5',
        'ink': '#1A1F2E',
        'slate': '#5A6170',
        'amber-deep': '#C88B1E',
        'blue-deep': '#0878A0',
        'red-deep': '#B53030',
      },
      fontFamily: {
        display: ['"Plus Jakarta Sans"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'monospace'],
      },
      animation: {
        'fade-in': 'fadeIn 0.3s ease-out',
        'slide-up': 'slideUp 0.3s ease-out',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0', transform: 'translateY(6px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(12px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
