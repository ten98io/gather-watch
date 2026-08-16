import type { Config } from 'tailwindcss';

/**
 * Tailwind bindings for the Playin design tokens (DESIGN.md §2).
 * Colors resolve to CSS custom properties defined in app/globals.css so the
 * dark/light themes switch at runtime via `data-theme` on <html>.
 */
const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}'],
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        void: 'var(--bg-void)',
        deep: 'var(--bg-deep)',
        glass: 'var(--surface-glass)',
        raised: 'var(--surface-raised)',
        'border-glass': 'var(--border-glass)',
        // Elevation ladder (DESIGN.md §4): bg-surface-1/2/3 replace glass on
        // everything that does not float over moving video.
        'surface-0': 'var(--surface-0)',
        'surface-1': 'var(--surface-1)',
        'surface-2': 'var(--surface-2)',
        'surface-3': 'var(--surface-3)',
        hairline: 'var(--hairline)',
        hi: 'var(--text-hi)',
        mid: 'var(--text-mid)',
        low: 'var(--text-low)',
        'aurora-1': 'var(--aurora-1)',
        'aurora-2': 'var(--aurora-2)',
        'aurora-3': 'var(--aurora-3)',
        accent: 'var(--accent)',
        'accent-ink': 'var(--accent-ink)',
        success: 'var(--success)',
        danger: 'var(--danger)',
        warn: 'var(--warn)',
        ring: 'var(--focus-ring)',
      },
      fontFamily: {
        display: ['var(--font-display)', 'system-ui', 'sans-serif'],
        sans: ['var(--font-sans)', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'monospace'],
      },
      // Type ramp (DESIGN.md §3). Size / line-height / tracking / weight in one
      // utility; `font-bold` &co still win because core fontWeight sorts after
      // core fontSize. Use these instead of ad-hoc text-sm/text-xs.
      fontSize: {
        display: ['2rem', { lineHeight: '2.25rem', letterSpacing: '-0.02em', fontWeight: '600' }],
        title: ['1.25rem', { lineHeight: '1.625rem', letterSpacing: '-0.01em', fontWeight: '600' }],
        body: ['0.9375rem', { lineHeight: '1.375rem', fontWeight: '400' }],
        label: ['0.8125rem', { lineHeight: '1.125rem', fontWeight: '500' }],
        caption: ['0.6875rem', { lineHeight: '0.875rem', letterSpacing: '0.04em', fontWeight: '500' }],
        // Marketing/auth heroes only — the one fluid size left in the system.
        hero: [
          'clamp(1.75rem, 1rem + 2.5vw, 3.5rem)',
          { lineHeight: '1.05', letterSpacing: '-0.02em', fontWeight: '700' },
        ],
      },
      // Radius ladder (DESIGN.md §4): tighter corners read as more precise.
      borderRadius: {
        sm: '8px',
        ctl: '12px',
        card: '12px',
        panel: '20px',
      },
      // Layout constants that were previously arbitrary values.
      spacing: {
        edge: '3px', // active-row accent edge
        tap: '44px', // minimum touch target
        row: '56px', // media row height
        rail: '380px', // right rail width
      },
      boxShadow: {
        glow: '0 0 40px -12px color-mix(in oklch, var(--aurora-1) 22%, transparent)',
        'glow-lg': '0 0 80px -20px color-mix(in oklch, var(--aurora-2) 30%, transparent)',
      },
      transitionTimingFunction: {
        spring: 'cubic-bezier(0.34, 1.3, 0.64, 1)',
      },
      // 150ms is the standard; 220ms is reserved for entrances (DESIGN.md §6).
      transitionDuration: {
        220: '220ms',
      },
      keyframes: {
        'fade-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        'aurora-drift': {
          '0%': { transform: 'rotate(0deg) scale(1.4)' },
          '100%': { transform: 'rotate(360deg) scale(1.4)' },
        },
        'pulse-ring': {
          '0%': { opacity: '0.6', transform: 'scale(0.9)' },
          '100%': { opacity: '0', transform: 'scale(1.8)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 220ms ease-out',
        shimmer: 'shimmer 2.4s linear infinite',
        'aurora-drift': 'aurora-drift 60s linear infinite',
        'pulse-ring': 'pulse-ring 1.6s ease-out infinite',
      },
    },
  },
  plugins: [],
};

export default config;
