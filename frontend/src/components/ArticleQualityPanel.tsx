"use client";

import { useEffect, useState } from "react";

import styles from "@/app/page.module.css";
import { api, type ArticleQualityReport } from "@/lib/api";

const hostOf = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return u;
  }
};

/** Editor sidebar: SEO/AEO/GEO score, failed checks and the verified sources behind the last generation. */
export default function ArticleQualityPanel({ projectId, articleId, refreshKey, className }: { projectId: string; articleId: string; refreshKey?: string | null; className?: string }) {
  const [qr, setQr] = useState<ArticleQualityReport | null>(null);

  useEffect(() => {
    let live = true;
    api
      .getArticleQuality(projectId, articleId)
      .then((r) => live && setQr(r.quality_report || {}))
      .catch(() => live && setQr(null));
    return () => {
      live = false;
    };
  }, [projectId, articleId, refreshKey]);

  const score = qr?.seo_aeo_geo;
  const research = qr?.research;
  if (!score && !research) return null;
  const failed = (score?.checks || []).filter((c) => c.ok === false);
  const facts = research?.facts || [];

  return (
    <div className={className}>
    <details>
      <summary style={{ cursor: "pointer", fontWeight: 600 }}>
        Quality{score ? `: ${score.score}/100` : ""}
        {research ? ` · ${research.status === "ok" ? `${(research.sources_cited || []).length} sources` : `research ${research.status}`}` : ""}
      </summary>
      <div style={{ display: "grid", gap: 8, marginTop: 8, fontSize: 12, lineHeight: 1.5 }}>
        {score?.compliance_issues?.length ? (
          <p className={styles.error} role="alert" style={{ margin: 0 }}>{score.compliance_issues.join(" · ")}</p>
        ) : null}
        {failed.length ? (
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {failed.map((c) => (
              <li key={c.id}>{c.label}{c.detail ? ` (${c.detail})` : ""}</li>
            ))}
          </ul>
        ) : score ? (
          <span className={styles.muted}>All checks passed.</span>
        ) : null}
        {research?.status === "failed" ? (
          <span className={styles.muted}>Live research was unavailable, so this article was written without a verified source pack.</span>
        ) : null}
        {facts.length ? (
          <ol style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 4 }}>
            {facts.map((f) => (
              <li key={f.id} style={{ overflowWrap: "anywhere" }}>
                {f.claim}{" "}
                <a href={f.source_url} target="_blank" rel="noopener noreferrer">{hostOf(f.source_url)}</a>
                {f.verification === "verified" ? " ✓" : ""}
              </li>
            ))}
          </ol>
        ) : null}
      </div>
    </details>
    </div>
  );
}
