"use client";

import type { TechnicalAuditLatestResponse, TechnicalAuditRun } from "@/lib/api";
import { formatSiteAuditTimestamp } from "@/lib/technicalAuditFormat";
import { type CssModule } from "./parts";

/** Blocks A (header) and B (website bar) of the Technical Audit screen. */
export function TechnicalAuditHeader({
  latest,
  viewing,
  displayed,
  busy,
  running,
  justCompleted,
  error,
  faviconUrl,
  onRun,
  onBackToLatest,
  onGoToSettings,
  onLearn,
  styles,
}: {
  latest: TechnicalAuditLatestResponse | null;
  /** Historical run being viewed, if any. */
  viewing: TechnicalAuditRun | null;
  /** The run on screen (historical or latest). */
  displayed: TechnicalAuditRun | null;
  busy: boolean;
  running: boolean;
  justCompleted: boolean;
  error: string | null;
  faviconUrl: string | null;
  onRun: () => void;
  onBackToLatest: () => void;
  onGoToSettings: () => void;
  onLearn: () => void;
  styles: CssModule;
}) {
  const url = latest?.website?.url || null;
  const mobile = displayed?.mobile;
  const finalUrl = mobile?.final_url || null;
  const requested = mobile?.requested_url || displayed?.website_url || null;
  const redirected = finalUrl && requested && finalUrl.replace(/\/$/, "") !== requested.replace(/\/$/, "") ? finalUrl : null;
  const openTarget = finalUrl || url;
  const notConfigured = latest !== null && !latest.pagespeed_configured;

  return (
    <>
      <div className={styles.siteAuditPageHeader}>
        <div>
          <h2 className={styles.sectionTitle}>Technical Audit</h2>
          <p className={styles.muted} style={{ margin: "4px 0 0", fontSize: 14 }}>
            Detailed PageSpeed Insights data and actionable recommendations to improve your site.
          </p>
        </div>
        <div className={styles.analyticsHeaderActions}>
          <button type="button" className={styles.btnSecondary} onClick={onLearn} aria-haspopup="dialog">
            <span aria-hidden="true">? </span>Learn about this audit
          </button>
          {!latest && busy ? (
            <button type="button" className={styles.btnSecondary} disabled>
              Loading…
            </button>
          ) : latest?.website?.connected ? (
            <button
              type="button"
              className={styles.button}
              onClick={onRun}
              disabled={running || notConfigured}
              title={notConfigured ? "Google PageSpeed Insights is not configured on the backend" : undefined}
            >
              {running ? (
                <>
                  <span className={styles.siteAuditBtnSpinner} aria-hidden="true" />
                  Running audit…
                </>
              ) : justCompleted ? (
                "Audit complete"
              ) : error ? (
                "Retry audit"
              ) : latest?.audit ? (
                "Re-run audit"
              ) : (
                "Run technical audit"
              )}
            </button>
          ) : latest ? (
            <button type="button" className={styles.btnSecondary} onClick={onGoToSettings}>
              Go to Project Settings
            </button>
          ) : null}
        </div>
      </div>
      <p className={styles.srOnly} aria-live="polite">
        {justCompleted ? "Audit complete" : ""}
      </p>

      <div className={`${styles.card} ${styles.cardWide} ${styles.siteAuditWebsiteBar}`}>
        <div className={styles.siteAuditWebsiteMain}>
          {url ? (
            <>
              {faviconUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={faviconUrl} alt="" className={styles.siteAuditWebsiteFavicon} width={20} height={20} />
              ) : null}
              <div className={styles.siteAuditWebsiteText}>
                <a href={url} target="_blank" rel="noopener noreferrer" className={styles.siteAuditWebsiteUrl}>
                  {url}
                  <span className={styles.srOnly}> (opens in a new tab)</span>
                </a>
                <span className={styles.muted} style={{ fontSize: 12 }}>
                  {latest?.audit ? `Last audited: ${formatSiteAuditTimestamp(latest.audit.created_at)}` : "Not audited yet"}
                </span>
                {redirected ? (
                  <span className={styles.muted} style={{ fontSize: 12 }}>
                    Redirected to{" "}
                    <a href={redirected} target="_blank" rel="noopener noreferrer" className={styles.siteAuditTextLink}>
                      {redirected}
                    </a>
                  </span>
                ) : null}
              </div>
            </>
          ) : (
            <p className={styles.muted} style={{ margin: 0, fontSize: 14 }}>
              {latest ? "Website not connected. Connect a website in Project Settings to run a Technical Audit." : "Loading…"}
            </p>
          )}
        </div>
        <div className={styles.siteAuditWebsiteActions}>
          {viewing ? (
            <span className={styles.siteAuditViewingChip} role="status">
              Viewing audit from {formatSiteAuditTimestamp(viewing.created_at)}
              <button type="button" className={styles.btnSecondary} onClick={onBackToLatest}>
                Back to latest
              </button>
            </span>
          ) : null}
          {openTarget ? (
            <a href={openTarget} target="_blank" rel="noopener noreferrer" className={styles.siteAuditIconButton} aria-label="Open the audited page in a new tab">
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </a>
          ) : null}
        </div>
      </div>
    </>
  );
}
