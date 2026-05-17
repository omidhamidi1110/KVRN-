import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      // ─── KVRN COLOR SYSTEM ───────────────────────────────────────
      colors: {
        kvrn: {
          bg:          '#FAFAF8',  // Warm off-white — primary background
          'bg-raised': '#F3F0EB',  // Slightly deeper — cards, hover states
          'bg-dark':   '#111111',  // Near-black — dark sections
          text:        '#1A1A1A',  // Near-black — primary text
          'text-on-dark': '#F5F0E8', // Off-white on dark backgrounds
          muted:       '#6B6B6B',  // Secondary text
          subtle:      '#9B9B9B',  // Placeholder, disabled
          border:      '#E8E5E0',  // Subtle borders
          'border-strong': '#C8C4BF', // Focused, selected states
          error:       '#B91C1C',  // Error state
          success:     '#15803D',  // Success state
        },
        // Product colorways
        colorway: {
          stone:       '#C8B89A',
          slate:       '#6B7280',
          'off-white': '#F5F0E8',
          'washed-black': '#2D2D2D',
        },
      },

      // ─── TYPOGRAPHY ───────────────────────────────────────────────
      fontFamily: {
        display: ['var(--font-display)', 'Helvetica Neue', 'sans-serif'],
        body:    ['var(--font-body)', 'Helvetica Neue', 'sans-serif'],
      },
      fontSize: {
        '11':  ['11px', { lineHeight: '1.4', letterSpacing: '0.08em' }],
        '13':  ['13px', { lineHeight: '1.5' }],
        '15':  ['15px', { lineHeight: '1.6' }],
        '16':  ['16px', { lineHeight: '1.5' }],
        '20':  ['20px', { lineHeight: '1.4' }],
        '24':  ['24px', { lineHeight: '1.3' }],
        '32':  ['32px', { lineHeight: '1.2' }],
        '40':  ['40px', { lineHeight: '1.1' }],
        '48':  ['48px', { lineHeight: '1.05' }],
        '64':  ['64px', { lineHeight: '1.0' }],
        '80':  ['80px', { lineHeight: '0.95' }],
      },
      letterSpacing: {
        tightest: '-0.03em',
        tighter:  '-0.02em',
        tight:    '-0.01em',
        normal:   '0em',
        wide:     '0.06em',
        wider:    '0.10em',
        widest:   '0.15em',
      },

      // ─── SPACING ─────────────────────────────────────────────────
      spacing: {
        '18':  '72px',
        '22':  '88px',
        '26':  '104px',
        '30':  '120px',
        '34':  '136px',
        '38':  '152px',
        '42':  '168px',
        '46':  '184px',
        '50':  '200px',
        // Section padding tokens
        'section-mobile': '80px',
        'section-desktop': '160px',
      },

      // ─── TRANSITIONS ─────────────────────────────────────────────
      transitionDuration: {
        '400': '400ms',
        '600': '600ms',
        '800': '800ms',
      },
      transitionTimingFunction: {
        'luxury': 'cubic-bezier(0.25, 0.46, 0.45, 0.94)',
        'out-cubic': 'cubic-bezier(0.33, 1, 0.68, 1)',
      },

      // ─── ANIMATION ───────────────────────────────────────────────
      keyframes: {
        'fade-up': {
          from: { opacity: '0', transform: 'translateY(24px)' },
          to:   { opacity: '1', transform: 'translateY(0)' },
        },
        'fade-in': {
          from: { opacity: '0' },
          to:   { opacity: '1' },
        },
        'slide-in-right': {
          from: { transform: 'translateX(100%)' },
          to:   { transform: 'translateX(0)' },
        },
        'slide-out-right': {
          from: { transform: 'translateX(0)' },
          to:   { transform: 'translateX(100%)' },
        },
        'skeleton': {
          '0%, 100%': { opacity: '1' },
          '50%':      { opacity: '0.4' },
        },
        'spin': {
          to: { transform: 'rotate(360deg)' },
        },
        'attention-pulse': {
          '0%, 100%': { boxShadow: 'none' },
          '50%':      { boxShadow: '0 0 0 3px rgba(26,26,26,0.2)' },
        },
      },
      animation: {
        'fade-up':          'fade-up 0.6s cubic-bezier(0.25, 0.46, 0.45, 0.94) forwards',
        'fade-in':          'fade-in 0.5s ease-out forwards',
        'slide-in-right':   'slide-in-right 0.4s cubic-bezier(0.25, 0.46, 0.45, 0.94) forwards',
        'slide-out-right':  'slide-out-right 0.4s cubic-bezier(0.25, 0.46, 0.45, 0.94) forwards',
        'skeleton':         'skeleton 1.5s ease-in-out infinite',
        'spin':             'spin 0.7s linear infinite',
        'attention-pulse':  'attention-pulse 0.4s ease 2',
      },

      // ─── ASPECT RATIOS ────────────────────────────────────────────
      aspectRatio: {
        '3/4':  '3 / 4',
        '4/5':  '4 / 5',
        '9/16': '9 / 16',
      },

      // ─── MAX WIDTH ────────────────────────────────────────────────
      maxWidth: {
        'content': '1440px',
        'copy':    '65ch',
      },
    },
  },
  plugins: [],
}

export default config
