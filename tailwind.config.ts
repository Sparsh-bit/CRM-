import type { Config } from 'tailwindcss';
export default {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#0f1115', panel: '#161a21', line: '#262c37',
        muted: '#8b95a7', accent: '#4f7cff', good: '#2fbf71',
        warn: '#e2b33c', bad: '#e2564a',
      },
    },
  },
  plugins: [],
} satisfies Config;
