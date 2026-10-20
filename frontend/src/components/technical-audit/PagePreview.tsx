"use client";

import { useState } from "react";
import type { TechnicalAuditStrategyResult } from "@/lib/api";
import { type Strategy, isSafeHttpsUrl } from "@/lib/technicalAuditView";
import { AuditDialog, type CssModule } from "./parts";

/** Block H: Lighthouse's final screenshot (stored in image storage, never as base64). */
export function PagePreview({
  result,
  strategy,
  onStrategyChange,
  pageUrl,
  styles,
}: {
  result: TechnicalAuditStrategyResult;
  strategy: Strategy;
  onStrategyChange: (s: Strategy) => void;
  pageUrl: string | null;
  styles: CssModule;
}) {
  const [enlarged, setEnlarged] = useState(false);
  const src = isSafeHttpsUrl(result.screenshot_url) ? (result.screenshot_url as string) : null;
  const device = strategy === "mobile" ? "mobile" : "desktop";
  const alt = `Screenshot of ${pageUrl || "the page"} as rendered during the ${device} audit`;
  const missing =
    result.screenshot_status === "unavailable"
      ? "Preview unavailable — image storage is not configured or the upload failed."
      : "Preview unavailable — no screenshot was stored for this run. Re-run the audit to capture one.";

  return (
    <section id="ta-preview" aria-labelledby="ta-preview-title" className={`${styles.card} ${styles.siteAuditPanel}`}>
      <div className={styles.siteAuditPanelHead}>
        <h3 id="ta-preview-title" className={styles.siteAuditPanelTitle}>
          Page Preview
        </h3>
        <div className={styles.segmentGroup} role="group" aria-label="Preview device">
          {(["mobile", "desktop"] as const).map((s) => (
            <button key={s} type="button" className={styles.miniBtn} onClick={() => onStrategyChange(s)} aria-pressed={strategy === s}>
              {s === "mobile" ? "Mobile" : "Desktop"}
            </button>
          ))}
        </div>
      </div>
      {src ? (
        <>
          <button type="button" className={styles.siteAuditPreviewFrame} data-device={device} onClick={() => setEnlarged(true)} aria-haspopup="dialog" aria-label="Enlarge page preview">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={src} alt={alt} loading="lazy" referrerPolicy="no-referrer" />
          </button>
          <p className={styles.siteAuditSourceTag}>Screenshot taken by Lighthouse during the lab test</p>
          <AuditDialog open={enlarged} onClose={() => setEnlarged(false)} title={`Page preview (${strategy === "mobile" ? "Mobile" : "Desktop"})`} size="lg" styles={styles}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={src} alt={alt} referrerPolicy="no-referrer" className={styles.siteAuditPreviewLarge} />
            <p className={styles.siteAuditSourceTag}>Screenshot taken by Lighthouse during the lab test{result.fetch_time ? ` · ${new Date(result.fetch_time).toLocaleString()}` : ""}</p>
          </AuditDialog>
        </>
      ) : (
        <div className={styles.siteAuditPreviewFrame} data-device={device} data-empty="true">
          <p className={styles.muted} style={{ margin: 0, fontSize: 13, padding: 16, textAlign: "center" }}>
            {missing}
          </p>
        </div>
      )}
    </section>
  );
}
