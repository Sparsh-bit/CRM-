import type { Config } from 'tailwindcss';
export default {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        // Public Sans is the base (`font-sans`, applied to <body>) — headings
        // opt into `font-display` (Outfit) via the .page-title/.section-heading/
        // .card-heading utilities in globals.css, plus a global h1-h4 rule so
        // every existing raw heading picks it up automatically.
        sans: ['var(--font-body)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        display: ['var(--font-display)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      colors: {
        ink: '#0c0e12', panel: '#14171d', line: '#242832',
        muted: '#8b95a7',
        // Two shades of one accent, not one color doing every job: `accent`
        // is the readable-on-dark shade for text/links/pills/focus rings
        // (4.5:1+ against ink/panel — verified, not guessed); `accent-strong`
        // is the deeper shade solid buttons use as a fill with white text
        // (7.3:1 white-on-it). A single shade can't clear AA contrast in
        // both directions at once — this is why button fills and inline
        // text conventionally use different shades of the same hue.
        accent: '#5A78CC', 'accent-strong': '#3452A0',
        good: '#2fbf71', warn: '#e2b33c', bad: '#e2564a',
      },
    },
  },
  plugins: [],
} satisfies Config;
