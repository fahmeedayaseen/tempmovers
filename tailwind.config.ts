import type { Config } from "tailwindcss";

/**
 * Tailwind configuration — VASRUE Digital Media, 24 Oct 2026.
 *
 * Added to resolve the styling gap recorded in the consolidation handoff:
 * the seven newer portals were written with Tailwind utility classes, but
 * Tailwind was never installed, so those screens rendered unstyled.
 *
 * PREFLIGHT IS DISABLED ON PURPOSE. Preflight is Tailwind's global CSS reset.
 * This project already has a hand-written design system in app/globals.css
 * (tokens --navy/--blue/--teal, semantic classes .shell/.sidebar/.card/.hero)
 * which the original platform pages depend on, and which sets its own
 * `* { box-sizing: border-box }`. Letting preflight run would restyle those
 * pages underneath us. Disabling it means Tailwind contributes utilities and
 * nothing else — the newer portals get their classes, the existing pages are
 * untouched.
 *
 * The `base` and `components` directives are still emitted in globals.css.
 * With preflight off, `base` carries only Tailwind's custom-property defaults
 * (--tw-ring-*, --tw-shadow-*, transform vars), which shadow, ring and
 * transform utilities need in order to resolve. Dropping it would leave those
 * utilities silently broken.
 *
 * This is the pragmatic fix, not the full normalisation the handoff's Phase 2
 * describes. Two styling systems now coexist. Converting the portals onto the
 * existing design system remains a separate, larger piece of work.
 */
const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
  ],
  corePlugins: {
    preflight: false,
  },
  theme: {
    extend: {},
  },
  plugins: [],
};

export default config;
