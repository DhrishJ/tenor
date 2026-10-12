import type { Config } from 'tailwindcss'

// Visual language reused from ChainScore (colors, fonts, radius). The
// application itself is new work.
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // ChainScore's light palette: Tenor is presented as ChainScore's market.
        background: '#F8FAFC',
        subtle: '#F1F5F9',
        card: '#FFFFFF',
        border: '#E2E8F0',
        text: '#0F172A',
        muted: '#64748B',
        accent: '#0052FF',
        success: '#059669',
        warning: '#B45309',
        danger: '#DC2626',
      },
      boxShadow: {
        card: '0 1px 2px rgba(15,23,42,0.04), 0 12px 32px -16px rgba(15,23,42,0.10)',
        lift: '0 1px 2px rgba(15,23,42,0.06), 0 20px 40px -20px rgba(0,82,255,0.25)',
      },
      fontFamily: {
        grotesk: ['var(--font-space-grotesk)', 'sans-serif'],
        sans: ['var(--font-inter)', 'sans-serif'],
        mono: ['var(--font-jetbrains-mono)', 'ui-monospace', 'monospace'],
      },
      borderRadius: { '2xl': '1.25rem', xl: '0.875rem', lg: '0.625rem', md: '0.5rem', sm: '0.25rem' },
    },
  },
  plugins: [],
}
export default config
