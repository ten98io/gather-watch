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
      borderRadius: {
        ctl: '12px',
        card: '16px',
        panel: '24px',
      },
      boxShadow: {
        glow: '0 0 40px -12px color-mix(in oklch, var(--aurora-1) 22%, transparent)',
        'glow-lg': '0 0 80px -20px color-mix(in oklch, var(--aurora-2) 30%, transparent)',
      },
      transitionTimingFunction: {
        spring: 'cubic-bezier(0.34, 1.3, 0.64, 1)',
      },
      keyframes: {
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
        shimmer: 'shimmer 2.4s linear infinite',
        'aurora-drift': 'aurora-drift 60s linear infinite',
        'pulse-ring': 'pulse-ring 1.6s ease-out infinite',
      },
    },
  },
  plugins: [],
};

export default config;
