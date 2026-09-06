/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        // Inter is designed for UI and data-dense screens: tall x-height, clear
        // digits and a tabular-numbers feature that keeps table columns aligned.
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        display: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', 'monospace'],
      },
      fontSize: {
        // Type scale. Line heights are set here so pages stop hand-tuning them.
        'caption': ['0.6875rem', { lineHeight: '1rem', letterSpacing: '0.04em' }],
        'xs':      ['0.75rem',   { lineHeight: '1.125rem' }],
        'sm':      ['0.8125rem', { lineHeight: '1.25rem' }],
        'base':    ['0.875rem',  { lineHeight: '1.375rem' }],
        'md':      ['0.9375rem', { lineHeight: '1.5rem' }],
        'lg':      ['1.0625rem', { lineHeight: '1.625rem' }],
        'h3':      ['1.125rem',  { lineHeight: '1.625rem', letterSpacing: '-0.011em' }],
        'h2':      ['1.375rem',  { lineHeight: '1.875rem', letterSpacing: '-0.014em' }],
        'h1':      ['1.75rem',   { lineHeight: '2.25rem',  letterSpacing: '-0.019em' }],
        'display': ['2.25rem',   { lineHeight: '2.625rem', letterSpacing: '-0.022em' }],
      },
      spacing: {
        // 18px — the icon size that sits between Tailwind's 16px and 20px steps.
        '4.5': '1.125rem',
      },
      borderRadius: {
        // Was 0 across the board, which read as brutalist rather than premium.
        'none': '0',
        'sm': '0.25rem',
        DEFAULT: '0.375rem',
        'md': '0.375rem',
        'lg': '0.5rem',
        'xl': '0.75rem',
        '2xl': '1rem',
        '3xl': '1.25rem',
        'full': '9999px',
      },
      colors: {
        background: 'rgb(var(--color-background) / <alpha-value>)',
        surface: 'rgb(var(--color-surface) / <alpha-value>)',
        surfaceHover: 'rgb(var(--color-surface-hover) / <alpha-value>)',
        // `card` and `input` were used in pages but never defined, so those
        // classes silently did nothing.
        card: 'rgb(var(--color-card) / <alpha-value>)',
        input: 'rgb(var(--color-input) / <alpha-value>)',
        primary: {
          DEFAULT: 'rgb(var(--color-primary) / <alpha-value>)',
          hover: 'rgb(var(--color-primary-hover) / <alpha-value>)',
          foreground: 'rgb(var(--color-primary-foreground) / <alpha-value>)',
        },
        // `accent` is kept as an alias of primary: it is used across every page
        // and renaming it would touch hundreds of call sites for no benefit.
        accent: {
          DEFAULT: 'rgb(var(--color-accent) / <alpha-value>)',
          foreground: 'rgb(var(--color-accent-foreground) / <alpha-value>)',
        },
        foreground: 'rgb(var(--color-foreground) / <alpha-value>)',
        muted: 'rgb(var(--color-muted) / <alpha-value>)',
        border: 'rgb(var(--color-border) / <alpha-value>)',
        ring: 'rgb(var(--color-ring) / <alpha-value>)',
        destructive: 'rgb(var(--color-destructive) / <alpha-value>)',
        success: 'rgb(var(--color-success) / <alpha-value>)',
        warning: 'rgb(var(--color-warning) / <alpha-value>)',
        info: 'rgb(var(--color-info) / <alpha-value>)',
      },
      boxShadow: {
        // A restrained elevation scale. The old `glass` names are kept as
        // aliases so existing usages keep working, but they are now subtle.
        'xs': '0 1px 2px 0 rgb(var(--shadow-rgb) / 0.05)',
        'sm': '0 1px 2px 0 rgb(var(--shadow-rgb) / 0.06), 0 1px 3px 0 rgb(var(--shadow-rgb) / 0.06)',
        DEFAULT: '0 1px 3px 0 rgb(var(--shadow-rgb) / 0.08), 0 1px 2px -1px rgb(var(--shadow-rgb) / 0.06)',
        'md': '0 2px 4px -1px rgb(var(--shadow-rgb) / 0.07), 0 4px 8px -2px rgb(var(--shadow-rgb) / 0.06)',
        'lg': '0 4px 8px -2px rgb(var(--shadow-rgb) / 0.08), 0 12px 20px -4px rgb(var(--shadow-rgb) / 0.08)',
        'xl': '0 8px 16px -4px rgb(var(--shadow-rgb) / 0.10), 0 20px 32px -8px rgb(var(--shadow-rgb) / 0.10)',
        'glass': '0 1px 3px 0 rgb(var(--shadow-rgb) / 0.08), 0 1px 2px -1px rgb(var(--shadow-rgb) / 0.06)',
        'glass-lg': '0 4px 8px -2px rgb(var(--shadow-rgb) / 0.08), 0 12px 20px -4px rgb(var(--shadow-rgb) / 0.08)',
        'glass-dark': '0 4px 8px -2px rgb(var(--shadow-rgb) / 0.20), 0 12px 20px -4px rgb(var(--shadow-rgb) / 0.20)',
      },
      transitionTimingFunction: {
        'out-expo': 'cubic-bezier(0.16, 1, 0.3, 1)',
      },
      transitionDuration: {
        // Named to match the interaction tiers used across the app.
        'micro': '120ms',
        'control': '180ms',
        'surface': '240ms',
      },
      animation: {
        'fade-up': 'fadeUp 0.28s cubic-bezier(0.16, 1, 0.3, 1) forwards',
        'slide-in-right': 'slideInRight 0.24s cubic-bezier(0.16, 1, 0.3, 1) forwards',
        'shimmer': 'shimmer 1.6s linear infinite',
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
      },
      keyframes: {
        fadeUp: {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        slideInRight: {
          '0%': { opacity: '0', transform: 'translateX(8px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
      },
    },
  },
  plugins: [],
}
