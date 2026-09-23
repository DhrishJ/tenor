import type { Config } from 'tailwindcss'

// Visual language reused from ChainScore (colors, fonts, radius). The
// application itself is new work.
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        background: '#0A0A0F',
        card: '#0D1117',
        border: '#1C2333',
        text: '#ECF0F7',
        muted: '#94A3B8',
        accent: '#0052FF',
        success: '#00C879',
        warning: '#FFB800',
        danger: '#FF3B5C',
      },
      fontFamily: {
        grotesk: ['var(--font-space-grotesk)', 'sans-serif'],
        sans: ['var(--font-inter)', 'sans-serif'],
        mono: ['var(--font-jetbrains-mono)', 'ui-monospace', 'monospace'],
      },
      borderRadius: { lg: '0.5rem', md: '0.375rem', sm: '0.25rem' },
    },
  },
  plugins: [],
}
export default config
