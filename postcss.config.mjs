/**
 * PostCSS configuration — VASRUE Digital Media, 24 Oct 2026.
 * Required for Tailwind to process app/globals.css during `next build`.
 * See tailwind.config.ts for why preflight is disabled.
 */
const config = {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};

export default config;
