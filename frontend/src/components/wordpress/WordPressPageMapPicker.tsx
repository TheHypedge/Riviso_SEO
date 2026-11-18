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
  /** Project Settings deep link (opens in a new tab so an open editor keeps its unsaved work). */
  settingsHref?: string;
  compact?: boolean;
};

export function WordPressPageMapPicker({
  entries,
  value,
  onChange,
  maxItems = 3,
  loading = false,
  internalLinkAwareEnabled = true,
  settingsHref,
  compact = false,
}: Props) {
  const settingsLink = (label: string) =>
    settingsHref ? (
      <a href={settingsHref} target="_blank" rel="noopener noreferrer" style={{ color: "var(--aa-accent, inherit)", fontWeight: 700, textDecoration: "underline" }}>
        {label}
      </a>
    ) : (
      label
    );
  const rows = entries.filter((e) => (e.post_url || "").trim() && (e.post_title || "").trim());

  // Pages picked here are always honoured by the backend (explicit mapped_pages); the
  // project's "Internal-link aware" switch only controls *automatic* selection when
  // nothing is picked -- so it must never hide or disable this list.
  return (
    <div style={{ marginTop: compact ? 8 : 14, display: "grid", gap: 10 }}>
      <div>
        <div style={{ fontWeight: 800, fontSize: 13, color: "var(--aa-ink)" }}>Map site pages</div>
        <p className={styles.muted} style={{ margin: "6px 0 0", fontSize: 12, lineHeight: 1.5 }}>
          Select up to {maxItems} published posts from your synced site map. Riviso adds natural internal links and
          uses the first page&apos;s featured image as a style reference for the hero image when available.
          {!internalLinkAwareEnabled ? (
            <>
              {" "}Pick pages here, or turn on <strong>Internal-link aware articles</strong> in{" "}
              {settingsLink("Project Settings → Integrations")} to have Riviso pick them automatically and skip this step.
            </>
          ) : null}
        </p>
      </div>

      {loading ? (
        <InlineListSkeleton rows={5} />
      ) : rows.length === 0 ? (
        <p className={styles.muted} style={{ fontSize: 12, lineHeight: 1.5 }}>
          No site map entries yet. Sync from WordPress in {settingsLink("Project Settings → Integrations")}, then try again.
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
                      : "1px solid var(--aa-hairline)",
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
                    <span style={{ fontWeight: 700, fontSize: 13, color: "var(--aa-ink)" }}>{mapped.title}</span>
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
