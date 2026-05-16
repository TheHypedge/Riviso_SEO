/**
 * Minimal outline icons for project sidebar sections (Claude-style thin strokes).
 */

import type { ReactNode } from "react";

export type ProjectTabKey =
  | "articles"
  | "research"
  | "scheduled_articles"
  | "prompts"
  | "context_links"
  | "tools"
  | "performance"
  | "project_settings";

type IconProps = { className?: string };

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

export function ProjectTabIcon({ tab, className }: { tab: ProjectTabKey; className?: string }) {
  switch (tab) {
    case "articles":
      return (
        <Svg className={className}>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" {...S} />
          <path d="M14 2v6h6M9 13h6M9 17h4" {...S} />
        </Svg>
      );
    case "research":
      return (
        <Svg className={className}>
          <circle cx="11" cy="11" r="7" {...S} />
          <path d="M16.5 16.5L21 21" {...S} />
        </Svg>
      );
    case "scheduled_articles":
      return (
        <Svg className={className}>
          <rect x="3" y="4" width="18" height="18" rx="2" {...S} />
          <path d="M16 2v4M8 2v4M3 10h18M12 14v3" {...S} />
        </Svg>
      );
    case "prompts":
      return (
        <Svg className={className}>
          <path d="M21 15a2 2 0 0 1-2 2H8l-5 3V6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" {...S} />
          <path d="M9 10h6M9 14h4" {...S} />
        </Svg>
      );
    case "context_links":
      return (
        <Svg className={className}>
          <path d="M10 13a5 5 0 0 0 7.07 0l2.12-2.12a5 5 0 0 0-7.07-7.07L11 5" {...S} />
          <path d="M14 11a5 5 0 0 0-7.07 0L4.81 13.12a5 5 0 1 0 7.07 7.07L13 19" {...S} />
        </Svg>
      );
    case "tools":
      return (
        <Svg className={className}>
          <path
            d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"
            {...S}
          />
        </Svg>
      );
    case "performance":
      return (
        <Svg className={className}>
          <path d="M3 3v18h18" {...S} />
          <path d="M7 16l4-5 4 3 5-7" {...S} />
        </Svg>
      );
    case "project_settings":
      return (
        <Svg className={className}>
          <circle cx="12" cy="12" r="3" {...S} />
          <path
            d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"
            {...S}
          />
        </Svg>
      );
    default:
      return null;
  }
}

export function SidebarBackIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M19 12H5M12 19l-7-7 7-7" {...S} />
    </Svg>
  );
}
