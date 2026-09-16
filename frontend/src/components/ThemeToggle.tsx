"use client";

import { useTheme } from "@/components/ThemeProvider";

const ICON_STROKE = { fill: "none" as const, stroke: "currentColor", strokeWidth: 1.75, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" width={18} height={18}>
      <circle cx="12" cy="12" r="4.5" {...ICON_STROKE} />
      <path d="M12 2.5v2.5M12 19v2.5M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M2.5 12H5M19 12h2.5M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8" {...ICON_STROKE} />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" width={18} height={18}>
      <path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a6.8 6.8 0 0 0 10.5 10.5z" {...ICON_STROKE} />
    </svg>
  );
}

/** Icon-only toggle, sized to sit inline with the sidebar logo -- className is
 * passed through so each of the three sidebar call sites can size/space it
 * with the same CSS module classes their icons already use. */
export function ThemeToggle({ className }: { className?: string }) {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === "dark";
  return (
    <button
      type="button"
      className={className}
      onClick={toggleTheme}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      aria-pressed={isDark}
      title={isDark ? "Switch to light mode" : "Switch to dark mode"}
    >
      {isDark ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}
