/**
 * Minimal outline icons for the dashboard sidebar (matches project sidebar stroke style).
 */

import type { ReactNode } from "react";

export type DashboardNavKey =
  | "overview"
  | "projects"
  | "users"
  | "limits"
  | "profile"
  | "logout"
  | "tutorial";

const S = {
  fill: "none" as const,
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

function Svg({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className}>
      {children}
    </svg>
  );
}

export function DashboardNavIcon({ nav, className }: { nav: DashboardNavKey; className?: string }) {
  switch (nav) {
    case "overview":
      return (
        <Svg className={className}>
          <rect x="3" y="3" width="8" height="8" rx="1.5" {...S} />
          <rect x="13" y="3" width="8" height="5" rx="1.5" {...S} />
          <rect x="13" y="11" width="8" height="10" rx="1.5" {...S} />
          <rect x="3" y="14" width="8" height="7" rx="1.5" {...S} />
        </Svg>
      );
    case "projects":
      return (
        <Svg className={className}>
          <rect x="3" y="3" width="7" height="7" rx="1.5" {...S} />
          <rect x="14" y="3" width="7" height="7" rx="1.5" {...S} />
          <rect x="3" y="14" width="7" height="7" rx="1.5" {...S} />
          <rect x="14" y="14" width="7" height="7" rx="1.5" {...S} />
        </Svg>
      );
    case "users":
      return (
        <Svg className={className}>
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" {...S} />
          <circle cx="9" cy="7" r="4" {...S} />
          <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" {...S} />
        </Svg>
      );
    case "limits":
      return (
        <Svg className={className}>
          <path d="M12 3v3M12 18v3M3 12h3M18 12h3" {...S} />
          <circle cx="12" cy="12" r="4" {...S} />
          <path d="M12 8v4l2.5 1.5" {...S} />
        </Svg>
      );
    case "profile":
      return (
        <Svg className={className}>
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" {...S} />
          <circle cx="12" cy="7" r="4" {...S} />
        </Svg>
      );
    case "logout":
      return (
        <Svg className={className}>
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" {...S} />
          <path d="M16 17l5-5-5-5M21 12H9" {...S} />
        </Svg>
      );
    case "tutorial":
      return (
        <Svg className={className}>
          <circle cx="12" cy="12" r="9" {...S} />
          <path d="M10 8.5v7l5.5-3.5L10 8.5z" {...S} />
        </Svg>
      );
    default:
      return null;
  }
}
