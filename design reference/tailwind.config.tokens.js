/**
 * RIVISO Design Tokens — Tailwind extension
 * Merge this `theme.extend` block into your existing tailwind.config.js
 * Do not replace your whole config — just add/merge these keys.
 */

module.exports = {
  theme: {
    extend: {
      colors: {
        bg: '#FAFAF8',
        surface: '#FFFFFF',
        'surface-sunken': '#F4F3F0',
        border: {
          DEFAULT: '#E8E6E1',
          strong: '#D8D5CE',
        },
        ink: {
          DEFAULT: '#1B1A17',      // primary text
          secondary: '#6E6B64',
          tertiary: '#A6A29A',
        },
        accent: {
          DEFAULT: '#E15A2C',
          hover: '#C74C22',
          tint: '#FDECE4',
          'tint-border': '#F6C9B4',
        },
        success: {
          DEFAULT: '#2E8B57',
          strong: '#1F7A44',
          tint: '#E7F4EC',
        },
        warning: {
          DEFAULT: '#B8770B',
          tint: '#FBF1DE',
        },
        info: {
          DEFAULT: '#3B6FE0',
          strong: '#2451B8',
          tint: '#EAF0FE',
        },
        danger: {
          DEFAULT: '#C13B2D',
          tint: '#FDECEA',
        },
      },
      borderRadius: {
        sm: '6px',
        md: '10px',
        lg: '14px',
      },
      boxShadow: {
        xs: '0 1px 2px rgba(20,18,14,0.04)',
        sm: '0 1px 3px rgba(20,18,14,0.06), 0 1px 2px rgba(20,18,14,0.04)',
        md: '0 4px 16px rgba(20,18,14,0.07), 0 1px 3px rgba(20,18,14,0.05)',
      },
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'monospace'],
      },
      fontSize: {
        // matches the type scale used across all mockups
        xs: '11px',
        sm: '12.5px',
        base: '14px',
        md: '15px',
        lg: '20px',
        xl: '24px',
        '2xl': '26px',
        '3xl': '32px',
      },
    },
  },
};

/**
 * Usage examples once merged:
 *
 * <div className="bg-surface border border-border rounded-lg shadow-xs">
 * <button className="bg-accent hover:bg-accent-hover text-white rounded-sm px-3.5 py-2 text-sm font-semibold">
 * <span className="bg-success-tint text-success-strong rounded-full px-2.5 py-1 text-xs font-bold">Published</span>
 *
 * Status pill pattern (Published / Scheduled / Draft):
 *   published → bg-success-tint text-success-strong
 *   scheduled → bg-info-tint text-info-strong
 *   draft     → bg-surface-sunken text-ink-secondary
 *   warning   → bg-warning-tint text-warning
 *   danger    → bg-danger-tint text-danger
 */
