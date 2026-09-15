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
        bg: "#FAFAF8",
        surface: "#FFFFFF",
        "surface-sunken": "#F4F3F0",
        border: {
          DEFAULT: "#E8E6E1",
          strong: "#D8D5CE",
        },
        ink: {
          DEFAULT: "#1B1A17",
          secondary: "#6E6B64",
          tertiary: "#A6A29A",
        },
        accent: {
          DEFAULT: "#E15A2C",
          hover: "#C74C22",
          tint: "#FDECE4",
          "tint-border": "#F6C9B4",
        },
        success: {
          DEFAULT: "#2E8B57",
          strong: "#1F7A44",
          tint: "#E7F4EC",
        },
        warning: {
          DEFAULT: "#B8770B",
          tint: "#FBF1DE",
        },
        info: {
          DEFAULT: "#3B6FE0",
          strong: "#2451B8",
          tint: "#EAF0FE",
        },
        danger: {
          DEFAULT: "#C13B2D",
          tint: "#FDECEA",
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
