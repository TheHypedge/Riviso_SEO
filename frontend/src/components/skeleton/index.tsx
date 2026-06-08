"use client";

import sk from "./skeleton.module.css";

type SkelProps = {
  label?: string;
};

export function OverviewPageSkeleton({ label = "Loading overview" }: SkelProps) {
  return (
    <div className={sk.overviewShell} aria-busy="true" aria-label={label}>
      <div className={sk.statGrid}>
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className={sk.statCard}>
            <span className={sk.boneLg} />
            <span className={sk.boneSm} />
            <span className={sk.boneXs} />
          </div>
        ))}
      </div>

      <div className={sk.heroGrid}>
        <div className={sk.panelCard}>
          <div className={sk.panelHead}>
            <span className={sk.boneMd} />
            <span className={sk.boneSm} />
          </div>
          <div className={sk.chartArea}>
            {Array.from({ length: 8 }).map((_, i) => (
              <span key={i} className={sk.chartBar} />
            ))}
          </div>
        </div>
        <div className={sk.panelCard}>
          <div className={sk.panelHead}>
            <span className={sk.boneMd} />
            <span className={sk.boneSm} />
          </div>
          <div className={sk.pipelineRows}>
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className={sk.pipelineRow}>
                <span className={sk.boneSm} />
                <span className={sk.boneTrack} />
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className={sk.boardGrid}>
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className={sk.feedPanel}>
            <div className={sk.panelHead}>
              <span className={sk.boneMd} />
              <span className={sk.boneSm} />
            </div>
            <div className={sk.feedList}>
              {Array.from({ length: 4 }).map((_, j) => (
                <div key={j} className={sk.feedRow}>
                  <span className={sk.boneThumb} />
                  <div className={sk.feedText}>
                    <span className={sk.boneSm} />
                    <span className={sk.boneXs} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function DashboardProjectsSkeleton() {
  return (
    <div className={sk.projectsGrid} aria-busy="true" aria-label="Loading projects">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className={sk.projectCard}>
          <span className={sk.boneLg} />
          <span className={sk.boneSm} />
          <span className={sk.boneXs} />
        </div>
      ))}
    </div>
  );
}

export function ArticlesTableSkeleton({ variant = "both" }: { variant?: "desktop" | "mobile" | "both" }) {
  const showDesktop = variant === "desktop" || variant === "both";
  const showMobile = variant === "mobile" || variant === "both";
  return (
    <div className={sk.tableShell} aria-busy="true" aria-label="Loading articles">
      {showDesktop ? (
        <>
          <div className={sk.tableHead}>
            {Array.from({ length: 6 }).map((_, i) => (
              <span key={i} className={sk.boneSm} />
            ))}
          </div>
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className={sk.tableRow}>
              <span className={sk.checkboxBone} />
              <span className={sk.boneFull} />
              <span className={sk.boneFull} />
              <span className={sk.boneFull} />
              <span className={sk.boneSm} />
              <span className={sk.boneSm} />
            </div>
          ))}
        </>
      ) : null}
      {showMobile ? (
        <div className={variant === "mobile" ? sk.mobileListForced : sk.mobileList}>
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className={sk.mobileCard}>
              <span className={sk.boneMd} />
              <span className={sk.boneSm} />
              <span className={sk.boneXs} />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function FormFieldsSkeleton({ fields = 3 }: { fields?: number }) {
  return (
    <div className={sk.formStack} aria-busy="true" aria-label="Loading form">
      {Array.from({ length: fields }).map((_, i) => (
        <div key={i} className={sk.formField}>
          <span className={sk.boneSm} />
          <span className={sk.inputBone} />
        </div>
      ))}
    </div>
  );
}

export function DetailPanelSkeleton() {
  return (
    <div className={sk.detailStack} aria-busy="true" aria-label="Loading details">
      {Array.from({ length: 2 }).map((_, i) => (
        <div key={i} className={sk.detailCard}>
          <span className={sk.boneSm} />
          <span className={sk.boneFull} />
          <span className={sk.boneFull} />
          <span className={sk.boneMd} />
        </div>
      ))}
    </div>
  );
}

export function EditorLinesSkeleton({ lines = 5 }: { lines?: number }) {
  const lineClass = [sk.editorLineWide, sk.editorLineMid, sk.editorLineMid, sk.editorLineMid, sk.editorLineShort];
  return (
    <div className={sk.editorBlock} aria-busy="true" aria-label="Loading editor">
      {Array.from({ length: lines }).map((_, i) => (
        <span key={i} className={lineClass[i] ?? sk.editorLineMid} />
      ))}
    </div>
  );
}

export function TextLinesSkeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className={sk.textLines} aria-busy="true" aria-label="Loading">
      {Array.from({ length: lines }).map((_, i) => (
        <span key={i} className={sk.textLine} />
      ))}
    </div>
  );
}

export function InlineListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className={sk.feedList} aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className={sk.feedRow}>
          <span className={sk.thumbSm} />
          <div className={sk.feedText}>
            <span className={sk.boneSm} />
            <span className={sk.boneXs} />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Performance & Analysis loading state — KPI tiles plus either a chart
 * (Overview) or ranked rows (Insights), so the panel keeps its shape while
 * Search Console data streams in instead of swapping to a bare spinner.
 */
export function AnalyticsPanelSkeleton({ variant = "overview" }: { variant?: "overview" | "insights" }) {
  const tiles = variant === "overview" ? 4 : 2;
  return (
    <div className={sk.overviewShell} aria-busy="true" aria-label="Loading performance data">
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
        {Array.from({ length: tiles }).map((_, i) => (
          <div key={i} className={sk.statCard}>
            <span className={sk.boneXs} />
            <span className={sk.boneLg} />
          </div>
        ))}
      </div>
      {variant === "overview" ? (
        <div className={sk.panelCard}>
          <div className={sk.chartArea}>
            {Array.from({ length: 8 }).map((_, i) => (
              <span key={i} className={sk.chartBar} />
            ))}
          </div>
        </div>
      ) : (
        <div className={sk.feedList}>
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className={sk.feedRow}>
              <div className={sk.feedText}>
                <span className={sk.boneSm} />
                <span className={sk.boneXs} />
              </div>
              <span className={sk.boneXs} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
