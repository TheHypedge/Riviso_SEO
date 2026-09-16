/**
 * RIVISO Tailwind config — new design-system migration.
 *
 * Preflight (Tailwind's base CSS reset) is intentionally OFF. This repo has
 * a large existing CSS-Modules codebase (10k+ line shared stylesheet, 14k+
 * line page files) with no Tailwind classes in it yet and no staging
 * environment. Turning on Preflight globally would reset default margins,
 * box-sizing, and form-element styling across every existing page the
 * moment this file lands, before anything has actually been migrated to
 * Tailwind. Utility classes work fine without it. Revisit once a page no
 * longer depends on un-migrated CSS Modules for its base styling.
 *
 * Token values below are merged from design reference/tailwind.config.tokens.js
 * (the design handoff's source of truth). Font families reference the
 * next/font/google CSS variables already wired in src/app/layout.tsx rather
 * than the literal family-name strings the handoff doc used, so fonts stay
 * on Next.js's optimized self-hosted loading instead of being fetched a
 * second time — same visual fonts, correct loading mechanism.
 *
 * Colors reference the same --aa-* / --aa-tw-* CSS custom properties globals.css
 * defines (light at :root, dark under [data-theme="dark"]) instead of literal
 * hex, so every Tailwind-based `ui/` component (Sidebar, DataTable, ...) reacts
 * to the app's dark-mode toggle automatically -- no per-component `dark:`
 * variant classes needed. None of these colors are used with Tailwind's
 * opacity-modifier syntax (`bg-accent/50` etc.) anywhere in the codebase, so
 * plain var() references are safe here (that syntax needs a special R G B
 * channel format these tokens don't use).
 */

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  corePlugins: {
    preflight: false,
  },
  theme: {
    extend: {
      colors: {
        bg: "var(--aa-canvas)",
        surface: "var(--aa-surface-card)",
        "surface-sunken": "var(--aa-surface-soft)",
        border: {
          DEFAULT: "var(--aa-hairline)",
          strong: "var(--aa-tw-border-strong)",
        },
        ink: {
          DEFAULT: "var(--aa-ink)",
          secondary: "var(--aa-muted)",
          tertiary: "var(--aa-muted-soft)",
        },
        accent: {
          DEFAULT: "var(--aa-primary)",
          hover: "var(--aa-primary-hover)",
          tint: "var(--aa-tw-accent-tint)",
          "tint-border": "var(--aa-tw-accent-tint-border)",
        },
        success: {
          DEFAULT: "var(--aa-success)",
          strong: "var(--aa-tw-success-strong)",
          tint: "var(--aa-tw-success-tint)",
        },
        warning: {
          DEFAULT: "var(--aa-warning)",
          tint: "var(--aa-tw-warning-tint)",
        },
        info: {
          DEFAULT: "var(--aa-info)",
          strong: "var(--aa-tw-info-strong)",
          tint: "var(--aa-tw-info-tint)",
        },
        danger: {
          DEFAULT: "var(--aa-error)",
          tint: "var(--aa-tw-danger-tint)",
        },
      },
      borderRadius: {
        sm: "6px",
        md: "10px",
        lg: "14px",
      },
      boxShadow: {
        xs: "0 1px 2px rgba(20,18,14,0.04)",
        sm: "0 1px 3px rgba(20,18,14,0.06), 0 1px 2px rgba(20,18,14,0.04)",
        md: "0 4px 16px rgba(20,18,14,0.07), 0 1px 3px rgba(20,18,14,0.05)",
      },
      fontFamily: {
        sans: ["var(--font-ui-sans)", "-apple-system", "BlinkMacSystemFont", "sans-serif"],
        mono: ["var(--font-jetbrains-mono)", "ui-monospace", "monospace"],
        heading: ["var(--font-heading-sans)", "var(--font-ui-sans)", "-apple-system", "sans-serif"],
      },
      fontSize: {
        xs: "11px",
        sm: "12.5px",
        base: "14px",
        md: "15px",
        lg: "20px",
        xl: "24px",
        "2xl": "26px",
        "3xl": "32px",
      },
    },
  },
  plugins: [],
};
