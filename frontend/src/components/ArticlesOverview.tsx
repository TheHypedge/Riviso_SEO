"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ArticlesOverviewChart } from "@/components/ArticlesOverviewChart";
import { OverviewReadinessGate } from "@/components/OverviewReadinessGate";
import { OverviewPageSkeleton } from "@/components/skeleton";
import type { ArticlePublic, GscAnalyticsTotals, ScheduledJobPublic } from "@/lib/api";
import { articleEditorPath } from "@/lib/articlePaths";
import { evaluateProjectOverviewReadiness } from "@/lib/overviewReadiness";
import {
  buildArticleActivityBarSeries,
  computeInsights,
  computeOverviewStats,
  formatOverviewDate,
  pendingItems,
  recentPublishedItems,
  upcomingScheduledItems,
  type ArticlesOverviewRange,
  type OverviewListItem,
} from "@/lib/articlesOverview";

const RANGE_OPTIONS: { days: ArticlesOverviewRange; label: string; ariaLabel: string }[] = [
  { days: 1, label: "24H", ariaLabel: "Last 24 hours" },
  { days: 7, label: "7D", ariaLabel: "Last 7 days" },
  { days: 28, label: "28D", ariaLabel: "Last 28 days" },
  { days: 90, label: "3M", ariaLabel: "Last 3 months" },
];

function useLastUpdatedLabel(ts: number | null | undefined): string {
  const [label, setLabel] = useState("—");

  useEffect(() => {
    if (!ts) { setLabel("—"); return; }
    const tick = () => {
      const diff = Math.floor((Date.now() - ts) / 1000);
      if (diff < 10) setLabel("Just now");
      else if (diff < 60) setLabel(`${diff}s ago`);
      else if (diff < 3600) setLabel(`${Math.floor(diff / 60)}m ago`);
      else setLabel(`${Math.floor(diff / 3600)}h ago`);
    };
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, [ts]);

  return label;
}

function FeaturedThumb(props: {
  imageUrl: string | null | undefined;
  title: string;
  styles: Record<string, string>;
}) {
  const { imageUrl, title, styles } = props;
  const [failed, setFailed] = useState(false);
  const url = (imageUrl || "").trim();

  if (!url || failed) {
    return (
      <span className={styles.articlesOverviewFeaturedFallback} aria-hidden="true">
        {(title || "?").trim().charAt(0).toUpperCase() || "?"}
      </span>
    );
  }

  return (
    <span className={styles.articlesOverviewFeaturedWrap}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt=""
        className={styles.articlesOverviewFeaturedImg}
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
      />
    </span>
  );
}

function OverviewPanel(props: {
  styles: Record<string, string>;
  title: string;
  items: OverviewListItem[];
  empty: string;
  projectId: string;
  showFeaturedImage?: boolean;
  onViewAll?: () => void;
}) {
  const { styles, title, items, empty, projectId, showFeaturedImage, onViewAll } = props;
  const rowClass = showFeaturedImage
    ? styles.articlesOverviewListRowFeatured
    : styles.articlesOverviewListRowPlain;

  return (
    <section className={styles.articlesOverviewPanel}>
      <header className={styles.articlesOverviewPanelHead}>
        <h3 className={styles.articlesOverviewPanelTitle}>{title}</h3>
        {onViewAll ? (
          <button type="button" className={styles.articlesOverviewPanelLink} onClick={onViewAll}>
            View all
          </button>
        ) : null}
      </header>
      <ul className={styles.articlesOverviewList}>
        {items.length === 0 ? (
          <li className={styles.articlesOverviewListEmpty}>{empty}</li>
        ) : (
          items.map((item) => (
            <li key={item.id} className={rowClass}>
              {showFeaturedImage ? (
                <FeaturedThumb imageUrl={item.imageUrl} title={item.title} styles={styles} />
              ) : null}
              {(() => {
                const href = articleEditorPath(projectId, item.articleId);
                if (!href) {
                  return (
                    <span className={styles.articlesOverviewListTitleMuted} title={item.title}>
                      {item.title}
                    </span>
                  );
                }
                return (
                  <Link href={href} className={styles.articlesOverviewListTitle} title={item.title}>
                    {item.title}
                  </Link>
                );
              })()}
              <span className={styles.articlesOverviewListDate}>{item.dateLabel}</span>
            </li>
          ))
        )}
      </ul>
    </section>
  );
}

type ArticlesOverviewProps = {
  projectId: string;
  styles: Record<string, string>;
  articles: ArticlePublic[];
  scheduledJobs: ScheduledJobPublic[];
  titleByArticleId: Record<string, string>;
  selectedIds: string[];
  gscTotals?: GscAnalyticsTotals | null;
  loading?: boolean;
  lastRefreshedAt?: number | null;
  onViewList: (status?: string) => void;
  onRefresh?: () => void;
};

export function ArticlesOverview(props: ArticlesOverviewProps) {
  const {
    projectId,
    styles,
    articles,
    scheduledJobs,
    titleByArticleId,
    loading,
    gscTotals,
    lastRefreshedAt,
    onViewList,
    onRefresh,
  } = props;

  const [chartRange, setChartRange] = useState<ArticlesOverviewRange>(28);
  const refreshingRef = useRef(false);
  const [refreshing, setRefreshing] = useState(false);
  const lastUpdatedLabel = useLastUpdatedLabel(lastRefreshedAt);

  const handleRefresh = useCallback(() => {
    if (refreshingRef.current || !onRefresh) return;
    refreshingRef.current = true;
    setRefreshing(true);
    onRefresh();
    setTimeout(() => {
      refreshingRef.current = false;
      setRefreshing(false);
    }, 1500);
  }, [onRefresh]);

  const stats = useMemo(
    () => computeOverviewStats(articles, scheduledJobs, chartRange),
    [articles, scheduledJobs, chartRange],
  );

  const chartSeries = useMemo(
    () => buildArticleActivityBarSeries(articles, scheduledJobs, chartRange),
    [articles, scheduledJobs, chartRange],
  );

  const readiness = useMemo(
    () => evaluateProjectOverviewReadiness(articles, scheduledJobs, chartRange),
    [articles, scheduledJobs, chartRange],
  );

  const insights = useMemo(() => computeInsights(articles, chartRange), [articles, chartRange]);

  const upcoming = useMemo(
    () => upcomingScheduledItems(scheduledJobs, titleByArticleId, 5),
    [scheduledJobs, titleByArticleId],
  );
  const published = useMemo(() => recentPublishedItems(articles, 5), [articles]);
  const pending = useMemo(() => pendingItems(articles, 5), [articles]);
  const draftItems = useMemo(
    () =>
      articles
        .filter((a) => (a.status || "").toLowerCase() === "draft")
        .map((a) => ({
          id: a.id,
          articleId: a.id,
          title: a.title || "(Untitled)",
          dateLabel: formatOverviewDate(a.updated_at || a.created_at),
          sortMs: 0,
        }))
        .slice(0, 5),
    [articles],
  );

  const rangeLabel = RANGE_OPTIONS.find((r) => r.days === chartRange)?.ariaLabel ?? `Last ${chartRange} days`;

  if (loading) {
    return (
      <div className={styles.articlesOverviewShell}>
        <OverviewPageSkeleton label="Loading project overview" />
      </div>
    );
  }

  if (!readiness.isReady) {
    return (
      <OverviewReadinessGate
        readiness={readiness}
        styles={styles}
        primaryAction={{ label: "Open articles", onClick: () => onViewList("") }}
        secondaryAction={{ label: "View pending", onClick: () => onViewList("pending") }}
      />
    );
  }

  const hasGsc = gscTotals && (gscTotals.clicks > 0 || gscTotals.impressions > 0);

  return (
    <div className={styles.articlesOverviewShell}>
      <div className={styles.articlesOverview}>

        {/* ── Header row ── */}
        <div className={styles.articlesOverviewHeader}>
          <div className={styles.articlesOverviewHeaderLeft}>
            <h2 className={styles.articlesOverviewTitle}>Overview</h2>
            <span className={styles.articlesOverviewLastUpdated} aria-live="polite">
              Updated {lastUpdatedLabel}
            </span>
          </div>
          <div className={styles.articlesOverviewHeaderRight}>
            {onRefresh ? (
              <button
                type="button"
                className={styles.articlesOverviewRefreshBtn}
                onClick={handleRefresh}
                disabled={refreshing}
                aria-label="Refresh overview data"
              >
                <span className={refreshing ? styles.articlesOverviewRefreshIconSpin : styles.articlesOverviewRefreshIcon} aria-hidden="true">↻</span>
                {refreshing ? "Refreshing…" : "Refresh"}
              </button>
            ) : null}
          </div>
        </div>

        {/* ── Range selector ── */}
        <div className={styles.articlesOverviewRangeBar} role="group" aria-label="Date range">
          {RANGE_OPTIONS.map(({ days, label, ariaLabel }) => (
            <button
              key={days}
              type="button"
              aria-pressed={chartRange === days}
              aria-label={ariaLabel}
              className={`${styles.articlesOverviewRangeBtn} ${chartRange === days ? styles.articlesOverviewRangeBtnActive : ""}`}
              onClick={() => setChartRange(days)}
            >
              {label}
            </button>
          ))}
        </div>

        {/* ── KPI row (range-filtered) ── */}
        <div className={styles.articlesOverviewSectionLabel} aria-hidden="true">{rangeLabel}</div>
        <div
          className={styles.articlesOverviewStatGrid}
          role="list"
          aria-label={`Project statistics for ${rangeLabel}`}
        >
          <button
            type="button"
            className={`${styles.articlesOverviewStatCard} ${styles.articlesOverviewStatCardPublished}`}
            onClick={() => onViewList("published")}
            role="listitem"
          >
            <span className={styles.articlesOverviewStatValue}>{stats.publishedInRange.toLocaleString()}</span>
            <span className={styles.articlesOverviewStatLabel}>Published</span>
            {insights.velocityPct !== null ? (
              <span
                className={styles.articlesOverviewStatDelta}
                data-trend={insights.velocityPct > 0 ? "up" : insights.velocityPct < 0 ? "down" : "flat"}
              >
                {insights.velocityPct > 0 ? "▲" : insights.velocityPct < 0 ? "▼" : "—"}{" "}
                {Math.abs(insights.velocityPct)}%
              </span>
            ) : null}
          </button>

          <button
            type="button"
            className={styles.articlesOverviewStatCard}
            onClick={() => onViewList("pending")}
            role="listitem"
          >
            <span className={styles.articlesOverviewStatValue}>{stats.pending.toLocaleString()}</span>
            <span className={styles.articlesOverviewStatLabel}>Pending</span>
            <span className={styles.articlesOverviewStatSub}>Awaiting publish</span>
          </button>

          <button
            type="button"
            className={styles.articlesOverviewStatCard}
            onClick={() => onViewList("scheduled")}
            role="listitem"
          >
            <span className={styles.articlesOverviewStatValue}>{stats.scheduledJobs.toLocaleString()}</span>
            <span className={styles.articlesOverviewStatLabel}>Scheduled</span>
            <span className={styles.articlesOverviewStatSub}>Upcoming jobs</span>
          </button>

          <button
            type="button"
            className={styles.articlesOverviewStatCard}
            onClick={() => onViewList("draft")}
            role="listitem"
          >
            <span className={styles.articlesOverviewStatValue}>{stats.draft.toLocaleString()}</span>
            <span className={styles.articlesOverviewStatLabel}>Drafts</span>
            <span className={styles.articlesOverviewStatSub}>In progress</span>
          </button>

          <button
            type="button"
            className={styles.articlesOverviewStatCard}
            onClick={() => onViewList("")}
            role="listitem"
          >
            <span className={styles.articlesOverviewStatValue}>{stats.total.toLocaleString()}</span>
            <span className={styles.articlesOverviewStatLabel}>Total articles</span>
            <span className={styles.articlesOverviewStatSub}>All time</span>
          </button>
        </div>

        {/* ── All-time row ── */}
        <div className={styles.articlesOverviewSectionLabel} aria-hidden="true">All time</div>
        <div className={styles.articlesOverviewAllTimeRow} role="list" aria-label="All-time project totals">
          <div className={styles.articlesOverviewAllTimeCard} role="listitem">
            <span className={styles.articlesOverviewAllTimeValue}>{stats.totalPublished.toLocaleString()}</span>
            <span className={styles.articlesOverviewAllTimeLabel}>Published</span>
          </div>
          <div className={styles.articlesOverviewAllTimeCard} role="listitem">
            <span className={styles.articlesOverviewAllTimeValue}>{stats.total.toLocaleString()}</span>
            <span className={styles.articlesOverviewAllTimeLabel}>Articles</span>
          </div>
          {hasGsc ? (
            <>
              <div className={styles.articlesOverviewAllTimeCard} role="listitem">
                <span className={styles.articlesOverviewAllTimeValue}>{(gscTotals.clicks ?? 0).toLocaleString()}</span>
                <span className={styles.articlesOverviewAllTimeLabel}>Clicks (28d)</span>
              </div>
              <div className={styles.articlesOverviewAllTimeCard} role="listitem">
                <span className={styles.articlesOverviewAllTimeValue}>{(gscTotals.impressions ?? 0).toLocaleString()}</span>
                <span className={styles.articlesOverviewAllTimeLabel}>Impressions (28d)</span>
              </div>
              <div className={styles.articlesOverviewAllTimeCard} role="listitem">
                <span className={styles.articlesOverviewAllTimeValue}>
                  {gscTotals.ctr != null ? `${(gscTotals.ctr * 100).toFixed(1)}%` : "—"}
                </span>
                <span className={styles.articlesOverviewAllTimeLabel}>Avg CTR (28d)</span>
              </div>
            </>
          ) : (
            <div className={styles.articlesOverviewAllTimeCard} style={{ opacity: 0.45 }} role="listitem">
              <span className={styles.articlesOverviewAllTimeValue}>—</span>
              <span className={styles.articlesOverviewAllTimeLabel}>GSC not connected</span>
            </div>
          )}
        </div>

        {/* ── Activity chart ── */}
        <section className={styles.articlesOverviewChartCard}>
          <div className={styles.articlesOverviewChartHead}>
            <div>
              <h3 className={styles.articlesOverviewChartTitle}>Publishing Activity</h3>
              <p className={styles.articlesOverviewChartSub}>Published, pending, and scheduled articles by day</p>
            </div>
          </div>
          <ArticlesOverviewChart
            series={chartSeries}
            label="Article activity by day"
            styles={styles}
          />
        </section>

        {/* ── Insights row ── */}
        {(insights.velocityPct !== null || insights.bestDayOfWeek || insights.contentOpportunity > 0) ? (
          <div className={styles.articlesOverviewInsightsRow} aria-label="Publishing insights">
            {insights.velocityPct !== null ? (
              <div
                className={styles.articlesOverviewInsightCard}
                data-trend={insights.velocityPct >= 0 ? "up" : "down"}
              >
                <span className={styles.articlesOverviewInsightIcon} aria-hidden="true">
                  {insights.velocityPct >= 0 ? "▲" : "▼"}
                </span>
                <span className={styles.articlesOverviewInsightValue}>
                  {insights.velocityPct >= 0 ? "+" : ""}{insights.velocityPct}%
                </span>
                <span className={styles.articlesOverviewInsightLabel}>Publishing velocity</span>
                <span className={styles.articlesOverviewInsightSub}>
                  {insights.publishedCurrent} published vs {insights.publishedPrev} prior period
                </span>
              </div>
            ) : null}

            {insights.bestDayOfWeek ? (
              <div className={styles.articlesOverviewInsightCard}>
                <span className={styles.articlesOverviewInsightIcon} aria-hidden="true">★</span>
                <span className={styles.articlesOverviewInsightValue}>{insights.bestDayOfWeek}</span>
                <span className={styles.articlesOverviewInsightLabel}>Best publishing day</span>
                <span className={styles.articlesOverviewInsightSub}>
                  {insights.bestDayCount} article{insights.bestDayCount !== 1 ? "s" : ""} published
                </span>
              </div>
            ) : null}

            {insights.contentOpportunity > 0 ? (
              <div className={styles.articlesOverviewInsightCard}>
                <span className={styles.articlesOverviewInsightIcon} aria-hidden="true">◎</span>
                <span className={styles.articlesOverviewInsightValue}>{insights.contentOpportunity}</span>
                <span className={styles.articlesOverviewInsightLabel}>Content opportunity</span>
                <span className={styles.articlesOverviewInsightSub}>
                  Draft{insights.contentOpportunity !== 1 ? "s" : ""} ready to publish
                </span>
              </div>
            ) : null}
          </div>
        ) : null}

        {/* ── Bottom panels ── */}
        <div className={styles.articlesOverviewPanelsGrid}>
          <OverviewPanel
            styles={styles}
            title="Recently published"
            items={published}
            empty="No published articles yet."
            projectId={projectId}
            showFeaturedImage
            onViewAll={() => onViewList("published")}
          />
          <OverviewPanel
            styles={styles}
            title="Upcoming scheduled"
            items={upcoming}
            empty="No upcoming schedules."
            projectId={projectId}
            onViewAll={() => onViewList("scheduled")}
          />
          <OverviewPanel
            styles={styles}
            title="Pending review"
            items={pending}
            empty="No pending articles."
            projectId={projectId}
            onViewAll={() => onViewList("pending")}
          />
          <OverviewPanel
            styles={styles}
            title="Draft queue"
            items={draftItems}
            empty="No drafts in this project."
            projectId={projectId}
            onViewAll={() => onViewList("draft")}
          />
        </div>
      </div>
    </div>
  );
}
