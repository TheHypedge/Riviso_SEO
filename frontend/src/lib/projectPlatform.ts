import type { ProjectPublic, ProjectSettings } from "@/lib/api";

export type ProjectPlatformKind = "wordpress" | "shopify";

function normPlatform(v?: string | null): ProjectPlatformKind | null {
  const p = (v || "").trim().toLowerCase();
  if (p === "shopify" || p === "wordpress") return p;
  return null;
}

/** Single source of truth for which connection UI to show. */
export function resolveProjectPlatform(args: {
  settings?: Pick<ProjectSettings, "platform" | "shopify_connected" | "shopify_shop"> | null;
  meta?: Pick<ProjectPublic, "platform" | "shopify_connected"> | null;
  listItem?: Pick<ProjectPublic, "platform" | "shopify_connected"> | null;
  /** From URL: ?platform=shopify (set when creating a Shopify project). */
  urlHint?: string | null;
}): ProjectPlatformKind {
  const hint = normPlatform(args.urlHint);
  if (hint) return hint;
  if (args.settings?.shopify_connected || (args.settings?.shopify_shop || "").trim()) {
    return "shopify";
  }
  if (args.meta?.shopify_connected) return "shopify";

  for (const raw of [args.settings?.platform, args.meta?.platform, args.listItem?.platform]) {
    const p = normPlatform(raw);
    if (p) return p;
  }
  if (args.listItem?.shopify_connected || args.meta?.shopify_connected) return "shopify";

  return "wordpress";
}

/** True when project settings (or meta) resolve to Shopify — not WordPress. */
export function isShopifyPlatformProject(
  settings?: Pick<ProjectSettings, "platform" | "shopify_connected" | "shopify_shop"> | null,
  meta?: Pick<ProjectPublic, "platform" | "shopify_connected"> | null,
): boolean {
  return resolveProjectPlatform({ settings, meta }) === "shopify";
}

/** True when project is explicitly WordPress (default when platform unknown). */
export function isWordPressPlatformProject(
  settings?: Pick<ProjectSettings, "platform" | "shopify_connected" | "shopify_shop"> | null,
  meta?: Pick<ProjectPublic, "platform" | "shopify_connected"> | null,
): boolean {
  return resolveProjectPlatform({ settings, meta }) === "wordpress";
}
