"use client";

import styles from "@/app/page.module.css";
import { InlineListSkeleton } from "@/components/skeleton";
import {
  isPageMapped,
  siteMapEntryToMapped,
  toggleMappedPage,
  type MappedWordPressPage,
  type SiteMapEntry,
} from "@/lib/wordpressPageMapping";

type Props = {
  entries: SiteMapEntry[];
  value: MappedWordPressPage[];
  onChange: (next: MappedWordPressPage[]) => void;
  maxItems?: number;
  loading?: boolean;
  internalLinkAwareEnabled?: boolean;
  compact?: boolean;
};

export function WordPressPageMapPicker({
  entries,
  value,
  onChange,
  maxItems = 3,
  loading = false,
  internalLinkAwareEnabled = true,
  compact = false,
}: Props) {
  const rows = entries.filter((e) => (e.post_url || "").trim() && (e.post_title || "").trim());

  if (!internalLinkAwareEnabled) {
    return (
      <p className={styles.muted} style={{ fontSize: 12, lineHeight: 1.5, margin: "12px 0 0" }}>
        Turn on <strong>Internal-link aware articles</strong> in Project Settings to weave synced WordPress post
        links and optional featured-image references into generated content.
      </p>
    );
  }

  return (
    <div style={{ marginTop: compact ? 8 : 14, display: "grid", gap: 10 }}>
      <div>
        <div style={{ fontWeight: 800, fontSize: 13, color: "rgba(255,255,255,0.92)" }}>Map site pages</div>
        <p className={styles.muted} style={{ margin: "6px 0 0", fontSize: 12, lineHeight: 1.5 }}>
          Select up to {maxItems} published posts from your synced site map. Riviso adds natural internal links and
          uses the first page&apos;s featured image as a style reference for the hero image when available.
        </p>
      </div>

      {loading ? (
        <InlineListSkeleton rows={5} />
      ) : rows.length === 0 ? (
        <p className={styles.muted} style={{ fontSize: 12, lineHeight: 1.5 }}>
          No site map entries yet. Sync from WordPress in Project Settings, then try again.
        </p>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8, maxHeight: 280, overflow: "auto" }}>
          {rows.map((entry) => {
            const mapped = siteMapEntryToMapped(entry);
            if (!mapped) return null;
            const checked = isPageMapped(value, mapped.post_url);
            return (
              <li key={mapped.post_url}>
                <label
                  style={{
                    display: "flex",
                    gap: 10,
                    alignItems: "flex-start",
                    padding: "10px 12px",
                    borderRadius: 10,
                    border: checked
                      ? "1px solid color-mix(in oklab, var(--aa-accent, #d97757), transparent 35%)"
                      : "1px solid rgba(255,255,255,0.10)",
                    background: checked ? "color-mix(in oklab, var(--aa-accent, #d97757) 8%, transparent)" : "transparent",
                    cursor: "pointer",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => onChange(toggleMappedPage(value, mapped, maxItems))}
                    style={{ marginTop: 3 }}
                  />
                  <span style={{ display: "grid", gap: 4, minWidth: 0 }}>
                    <span style={{ fontWeight: 700, fontSize: 13, color: "rgba(255,255,255,0.92)" }}>{mapped.title}</span>
                    <span className={styles.muted} style={{ fontSize: 11, wordBreak: "break-all" }}>
                      {mapped.post_url}
                    </span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
