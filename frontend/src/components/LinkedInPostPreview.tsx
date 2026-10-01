"use client";

import { useLayoutEffect, useRef } from "react";

// Real-look mock of how a post will actually render on LinkedIn -- lets the user judge
// (and, when `onCaptionChange` is given, directly edit) the generated caption + link
// card in place, rather than editing in a separate plain textarea above a second,
// disconnected preview. Nothing else here is functional (no real like/comment).

const LINKEDIN_BLUE = "#0a66c2";

function renderCaptionWithHashtags(text: string) {
  const parts = text.split(/(#[\p{L}\p{N}_]+)/gu);
  return parts.map((part, i) =>
    part.startsWith("#") ? (
      <span key={i} style={{ color: LINKEDIN_BLUE, fontWeight: 600 }}>
        {part}
      </span>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

function FooterIcon({ label, path }: { label: string; path: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--text-secondary)", fontSize: 13, fontWeight: 600 }}>
      <svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
        <path d={path} strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {label}
    </div>
  );
}

/** Auto-growing textarea sized to its content, styled to sit invisibly inside the
 * preview card (no border/background of its own) so editing feels like typing
 * directly into the post rather than into a separate form control. */
function EditableCaption({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const ref = useRef<HTMLTextAreaElement | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  return (
    <textarea
      ref={ref}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder="Write your LinkedIn post…"
      rows={1}
      style={{
        display: "block",
        width: "100%",
        border: "none",
        outline: "none",
        resize: "none",
        overflow: "hidden",
        background: "transparent",
        color: "var(--text-primary)",
        fontFamily: "inherit",
        fontSize: 14,
        lineHeight: 1.5,
        padding: 0,
      }}
    />
  );
}

export function LinkedInPostPreview({
  authorName,
  captionText,
  onCaptionChange,
  articleTitle,
  articleImageUrl,
  articleDomain,
}: {
  authorName: string;
  captionText: string;
  /** When given, the caption renders as an editable field in place of the static,
   * hashtag-highlighted preview text -- the preview IS the editor, not a second view
   * next to one. Omit for a pure read-only preview (e.g. the Social tab's post cards). */
  onCaptionChange?: (text: string) => void;
  articleTitle?: string | null;
  articleImageUrl?: string | null;
  articleDomain?: string | null;
}) {
  const name = (authorName || "You").trim() || "You";
  const initial = name.charAt(0).toUpperCase();
  const showLinkCard = Boolean((articleTitle || "").trim() || (articleImageUrl || "").trim());

  return (
    <div
      style={{
        border: "1px solid var(--aa-hairline)",
        borderRadius: "var(--aa-r-md)",
        // Solid, not --aa-surface-card -- that token is semi-transparent in dark theme
        // (a deliberate frosted-glass look for in-page cards), which would let the
        // modal/page behind this preview bleed through it.
        background: "var(--aa-void-elevated)",
        overflow: "hidden",
        fontFamily: "system-ui, -apple-system, sans-serif",
      }}
    >
      <div style={{ display: "flex", gap: 10, padding: "12px 14px 8px" }}>
        <div
          aria-hidden="true"
          style={{
            width: 40,
            height: 40,
            borderRadius: "50%",
            background: LINKEDIN_BLUE,
            color: "#fff",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontWeight: 700,
            fontSize: 16,
            flexShrink: 0,
          }}
        >
          {initial}
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: "var(--text-primary)", lineHeight: 1.3 }}>
            {name} <span style={{ fontWeight: 400, color: "var(--text-secondary)" }}>· 1st</span>
          </div>
          <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>Just now · 🌐</div>
        </div>
      </div>

      <div
        style={{
          padding: "0 14px 12px",
          fontSize: 14,
          lineHeight: 1.5,
          color: "var(--text-primary)",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {onCaptionChange ? (
          <EditableCaption value={captionText} onChange={onCaptionChange} />
        ) : captionText.trim() ? (
          renderCaptionWithHashtags(captionText)
        ) : (
          <span style={{ color: "var(--text-secondary)" }}>Your caption preview will appear here…</span>
        )}
      </div>

      {showLinkCard ? (
        <div style={{ borderTop: "1px solid var(--aa-hairline)" }}>
          {articleImageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- external/user-generated image URL, not a local asset
            <img
              src={articleImageUrl}
              alt=""
              style={{ width: "100%", maxHeight: 260, objectFit: "cover", display: "block", background: "var(--aa-surface-soft)" }}
            />
          ) : null}
          <div style={{ padding: "10px 14px", background: "var(--aa-surface-soft)" }}>
            {articleTitle ? (
              <div
                style={{
                  fontWeight: 600,
                  fontSize: 14,
                  color: "var(--text-primary)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  display: "-webkit-box",
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: "vertical",
                }}
              >
                {articleTitle}
              </div>
            ) : null}
            {articleDomain ? (
              <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>{articleDomain}</div>
            ) : null}
          </div>
        </div>
      ) : null}

      <div
        style={{
          display: "flex",
          justifyContent: "space-around",
          padding: "8px 6px",
          borderTop: "1px solid var(--aa-hairline)",
        }}
      >
        <FooterIcon label="Like" path="M7 10v11M2 10h4v11H2zM7 10l4.5-8a2 2 0 0 1 3.7 1.2L14 10h6a2 2 0 0 1 2 2.3l-1.5 7A2 2 0 0 1 18.5 21H7" />
        <FooterIcon label="Comment" path="M21 11.5a8.5 8.5 0 1 1-4-7.2L21 3l-1.4 4.2c.3.7.4 1.5.4 2.3z" />
        <FooterIcon label="Repost" path="M17 2l4 4-4 4M3 12V9a4 4 0 0 1 4-4h14M7 22l-4-4 4-4M21 12v3a4 4 0 0 1-4 4H3" />
        <FooterIcon label="Send" path="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z" />
      </div>
    </div>
  );
}
