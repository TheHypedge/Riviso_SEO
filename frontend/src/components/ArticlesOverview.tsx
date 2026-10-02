"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { AiCitationSummary, AiCitationTrendChart } from "@/components/AiCitationResults";
import { ContentVsSearchChart, type ContentVsSearchPoint } from "@/components/ContentVsSearchChart";
import { GoogleSearchConsoleChart } from "@/components/GoogleSearchConsoleChart";
import { OverviewReadinessGate } from "@/components/OverviewReadinessGate";
import { ProjectActivityChart } from "@/components/ProjectActivityChart";
import { OverviewPageSkeleton } from "@/components/skeleton";
import { BreakdownDonut, DataTable, DataTableBody, DataTableCell, DataTableHead, DataTableHeaderCell, DataTableRow } from "@/components/ui";
import type {
  AiCitationCheck,
  AiCitationEngine,
  AiCitationTrendPoint,
  ArticlePublic,
  GscAnalyticsResponse,
  GscInsightsResponse,
  ScheduledJobPublic,
} from "@/lib/api";
import { articleEditorPath } from "@/lib/articlePaths";
import { evaluateProjectOverviewReadiness } from "@/lib/overviewReadiness";
import {
  buildArticleActivityBarSeriesInWindow,
  computeArticleStatusBreakdown,
  computeInsightsInWindow,
  computeOverviewStatsInWindow,
  formatOverviewDate,
  recentPublishedItems,
  resolveOverviewWindow,
  upcomingScheduledItems,
  windowSpanDays,
  type OverviewListItem,
  type OverviewRangeSelection,
} from "@/lib/articlesOverview";

const PRESET_LABELS: Record<number, string> = {
  1: "Last 24 hours",
  7: "Last 7 days",
  28: "Last 28 days",
  90: "Last 3 months",
};

function formatRangeLabel(range: OverviewRangeSelection): string {
  if (range.kind === "custom") {
    return `${formatOverviewDate(range.start)} – ${formatOverviewDate(range.end)}`;
  }
  return PRESET_LABELS[range.days] ?? `Last ${range.days} days`;
}

// Data-viz palette for the country donut -- not semantic status colors, so plain
// hex rather than the --aa-success/error tokens used elsewhere in this file.
const COUNTRY_PALETTE = ["#e15a2c", "#4a90d9", "#5db872", "#d4a017", "#8a6fd1", "#a09d96"];

const DEVICE_SEGMENTS: { key: string; label: string; color: string }[] = [
  { key: "DESKTOP", label: "Desktop", color: "#4a90d9" },
  { key: "MOBILE", label: "Mobile", color: "#e15a2c" },
  { key: "TABLET", label: "Tablet", color: "#5db872" },
];

function formatCtr(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

function formatPosition(v: number): string {
  return v.toFixed(1);
}

/** Shortens a GSC page URL to its path for compact display in a ranked list. */
function formatPageLabel(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname === "/" ? "/ (homepage)" : u.pathname;
  } catch {
    return url;
  }
}

/** Sortable-column header button -- same pattern already used in SeoAuditResults.tsx
 * (not shared from `ui/` since it's a tiny local function, not worth extracting). */
function SortHeaderButton({
  label,
  active,
  dir,
  onClick,
}: {
  label: string;
  active: boolean;
  dir: "asc" | "desc" | null;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1 border-0 bg-transparent p-0 font-sans text-xs font-semibold uppercase tracking-wide ${active ? "text-ink" : "text-ink-secondary"}`}
    >
      {label}
      <span aria-hidden="true" className={active ? "opacity-100" : "opacity-30"}>
        {dir === "asc" ? "▲" : "▼"}
      </span>
    </button>
  );
}

/** 10-rows-per-page pager shared by both GSC tables -- renders nothing for a single page. */
function TablePagination({
  page,
  totalPages,
  onPageChange,
}: {
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
}) {
  if (totalPages <= 1) return null;
  return (
    <div className="mt-3 flex items-center justify-end gap-3 font-sans text-xs">
      <button
        type="button"
        onClick={() => onPageChange(page - 1)}
        disabled={page <= 1}
        className="border-0 bg-transparent p-0 font-semibold text-ink-secondary hover:text-ink disabled:cursor-not-allowed disabled:opacity-30"
      >
        ‹ Prev
      </button>
      <span className="text-ink-secondary">Page {page} of {totalPages}</span>
      <button
        type="button"
        onClick={() => onPageChange(page + 1)}
        disabled={page >= totalPages}
        className="border-0 bg-transparent p-0 font-semibold text-ink-secondary hover:text-ink disabled:cursor-not-allowed disabled:opacity-30"
      >
        Next ›
      </button>
    </div>
  );
}

/** clicks/impressions/ctr: higher is better. position: lower is better -- callers
 * pass `invert: true` so a decrease still renders as the "up"/good arrow. */
function trendDirection(changePct: number | null, invert = false): "up" | "down" | "flat" {
  if (changePct === null || changePct === 0) return "flat";
  const positive = changePct > 0;
  return (invert ? !positive : positive) ? "up" : "down";
}

function TrendChip({ styles, changePct, invert }: { styles: Record<string, string>; changePct: number | null; invert?: boolean }) {
  if (changePct === null) return null;
  const dir = trendDirection(changePct, invert);
  return (
    <span className={styles.articlesOverviewStatDelta} data-trend={dir}>
      {dir === "up" ? "▲" : dir === "down" ? "▼" : "—"} {Math.abs(changePct)}%
    </span>
  );
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
  gscConnected?: boolean;
  gscInsights?: GscInsightsResponse | null;
  analytics?: GscAnalyticsResponse | null;
  aiCitationChecks?: AiCitationCheck[];
  aiCitationEnginesConfigured?: AiCitationEngine[];
  aiCitationTrend?: AiCitationTrendPoint[];
  aiCitationRunning?: boolean;
  onRunAiCitationCheck?: () => void;
  loading?: boolean;
  range: OverviewRangeSelection;
  onViewList: (status?: string) => void;
};

export function ArticlesOverview(props: ArticlesOverviewProps) {
  const {
    projectId,
    styles,
    articles,
    scheduledJobs,
    titleByArticleId,
    loading,
    gscConnected,
    gscInsights,
    analytics,
    aiCitationChecks = [],
    aiCitationEnginesConfigured = [],
    aiCitationTrend = [],
    aiCitationRunning,
    onRunAiCitationCheck,
    range,
    onViewList,
  } = props;

  const dateWindow = useMemo(() => resolveOverviewWindow(range), [range]);

  const stats = useMemo(
    () => computeOverviewStatsInWindow(articles, scheduledJobs, dateWindow),
    [articles, scheduledJobs, dateWindow],
  );

  const chartSeries = useMemo(
    () => buildArticleActivityBarSeriesInWindow(articles, scheduledJobs, dateWindow),
    [articles, scheduledJobs, dateWindow],
  );

  const readiness = useMemo(
    () => evaluateProjectOverviewReadiness(articles, scheduledJobs),
    [articles, scheduledJobs],
  );

  const insights = useMemo(() => computeInsightsInWindow(articles, dateWindow), [articles, dateWindow]);

  const countryBreakdown = useMemo(() => {
    const countries = gscInsights?.countries || [];
    const top = countries.slice(0, 5);
    const other = countries.slice(5).reduce((sum, c) => sum + c.clicks, 0);
    const segments = top.map((c, i) => ({
      key: c.country_code,
      label: `${c.flag ? `${c.flag} ` : ""}${c.country_name}`,
      color: COUNTRY_PALETTE[i % COUNTRY_PALETTE.length],
    }));
    const values: Record<string, number> = Object.fromEntries(top.map((c) => [c.country_code, c.clicks]));
    if (other > 0) {
      segments.push({ key: "other", label: "Other", color: COUNTRY_PALETTE[COUNTRY_PALETTE.length - 1] });
      values.other = other;
    }
    return { segments, values };
  }, [gscInsights]);

  const deviceValues = useMemo(() => {
    const values: Record<string, number> = {};
    for (const d of gscInsights?.devices || []) values[d.device] = d.clicks;
    return values;
  }, [gscInsights]);

  const upcoming = useMemo(
    () => upcomingScheduledItems(scheduledJobs, titleByArticleId, 5),
    [scheduledJobs, titleByArticleId],
  );
  const published = useMemo(() => recentPublishedItems(articles, 5), [articles]);

  const statusBreakdown = useMemo(() => computeArticleStatusBreakdown(articles), [articles]);

  // Google Search Console trend chart -- the raw clicks+impressions series, trimmed to
  // the selected range. Also reused below as the "search" half of the Content vs Search
  // Performance chart's merged dataset.
  const gscSeriesForChart = useMemo(() => {
    const series = analytics?.series || [];
    return series.slice(-windowSpanDays(dateWindow));
  }, [analytics, dateWindow]);

  // Content vs Search Performance chart -- merges `chartSeries` (Published/Pending/Draft
  // per day, already computed above for the Publishing Activity chart) with
  // `gscSeriesForChart` (Impressions/Clicks per day) by date into one toggleable-series
  // chart dataset. Both source series already exist; this is just the merge.
  const contentVsSearchSeries = useMemo((): ContentVsSearchPoint[] => {
    const gscByDate = new Map(gscSeriesForChart.map((p) => [p.date, p]));
    return chartSeries.map((p) => {
      const gsc = gscByDate.get(p.date);
      return {
        date: p.date,
        published: p.published,
        pending: p.pending,
        draft: p.draft,
        impressions: gsc?.impressions || 0,
        clicks: gsc?.clicks || 0,
      };
    });
  }, [chartSeries, gscSeriesForChart]);

  // "SEO Improvement Opportunities" -- 3 quick-win cards, each a straight re-filter of
  // data already in scope (no new backend work). A 4th card ("Create content for
  // trending queries") needs real query-vs-coverage gap analysis and is deferred.
  const ctrOpportunityPages = useMemo(() => {
    if (!gscInsights) return [];
    const avgCtr = gscInsights.headline.ctr.value;
    return gscInsights.pages.filter((p) => p.position <= 10 && p.ctr < avgCtr);
  }, [gscInsights]);

  const underperformingPages = useMemo(() => {
    if (!gscInsights) return [];
    return gscInsights.pages.filter((p) => p.position > 10 && p.position <= 20);
  }, [gscInsights]);

  const noInternalLinksCount = useMemo(
    () =>
      articles.filter(
        (a) => (a.status || "").toLowerCase() === "published" && !a.internal_links_count,
      ).length,
    [articles],
  );

  const [pageSort, setPageSort] = useState<{ key: "clicks" | "impressions" | "ctr" | "position"; dir: "asc" | "desc" }>({
    key: "clicks",
    dir: "desc",
  });
  const [querySort, setQuerySort] = useState<{ key: "clicks" | "impressions" | "position"; dir: "asc" | "desc" }>({
    key: "clicks",
    dir: "desc",
  });

  const sortedPages = useMemo(() => {
    const rows = [...(gscInsights?.pages || [])];
    const sign = pageSort.dir === "asc" ? 1 : -1;
    rows.sort((a, b) => sign * (a[pageSort.key] - b[pageSort.key]));
    return rows;
  }, [gscInsights, pageSort]);

  const sortedQueries = useMemo(() => {
    const rows = [...(gscInsights?.queries || [])];
    const sign = querySort.dir === "asc" ? 1 : -1;
    rows.sort((a, b) => sign * (a[querySort.key] - b[querySort.key]));
    return rows;
  }, [gscInsights, querySort]);

  function togglePageSort(key: typeof pageSort.key) {
    setPageSort((prev) => (prev.key === key ? { key, dir: prev.dir === "desc" ? "asc" : "desc" } : { key, dir: "desc" }));
    setPagePage(1);
  }
  function toggleQuerySort(key: typeof querySort.key) {
    setQuerySort((prev) => (prev.key === key ? { key, dir: prev.dir === "desc" ? "asc" : "desc" } : { key, dir: "desc" }));
    setQueryPage(1);
  }

  // 10 rows per page for both GSC tables -- reset to page 1 whenever the underlying
  // data changes (range switch, refresh) so the page index can never land out of range.
  const TABLE_PAGE_SIZE = 10;
  const [pagePage, setPagePage] = useState(1);
  const [queryPage, setQueryPage] = useState(1);
  useEffect(() => setPagePage(1), [gscInsights, range]);
  useEffect(() => setQueryPage(1), [gscInsights, range]);

  const pageTotalPages = Math.max(1, Math.ceil(sortedPages.length / TABLE_PAGE_SIZE));
  const queryTotalPages = Math.max(1, Math.ceil(sortedQueries.length / TABLE_PAGE_SIZE));
  const pagedPages = useMemo(
    () => sortedPages.slice((pagePage - 1) * TABLE_PAGE_SIZE, pagePage * TABLE_PAGE_SIZE),
    [sortedPages, pagePage],
  );
  const pagedQueries = useMemo(
    () => sortedQueries.slice((queryPage - 1) * TABLE_PAGE_SIZE, queryPage * TABLE_PAGE_SIZE),
    [sortedQueries, queryPage],
  );

  const rangeLabel = formatRangeLabel(range);

  // Single contextual line under the chart, derived entirely from stats/insights
  // already computed above -- no new data source, nothing fabricated. Content
  // opportunity is deliberately excluded here since it already has its own
  // card in the insights row below; repeating it here would just say the same
  // thing twice.
  const chartInsight = useMemo(() => {
    const lower = rangeLabel.charAt(0).toLowerCase() + rangeLabel.slice(1);
    if (stats.scheduledJobs > 0) {
      return {
        message: `Publishing is consistent. ${stats.scheduledJobs.toLocaleString()} article${stats.scheduledJobs === 1 ? "" : "s"} scheduled in the ${lower}.`,
        ctaLabel: "View scheduled articles",
        status: "scheduled" as const,
      };
    }
    if (insights.velocityPct !== null && insights.velocityPct >= 15) {
      return {
        message: `Publishing is accelerating. ${insights.publishedCurrent.toLocaleString()} published, up ${insights.velocityPct}% from the prior period.`,
        ctaLabel: "View published articles",
        status: "published" as const,
      };
    }
    if (insights.velocityPct !== null && insights.velocityPct <= -15) {
      return {
        message: `Publishing has slowed. ${insights.publishedCurrent.toLocaleString()} published, down ${Math.abs(insights.velocityPct)}% from the prior period.`,
        ctaLabel: "View published articles",
        status: "published" as const,
      };
    }
    if (stats.publishedInRange > 0) {
      return {
        message: `${stats.publishedInRange.toLocaleString()} article${stats.publishedInRange === 1 ? "" : "s"} published in the ${lower}.`,
        ctaLabel: "View published articles",
        status: "published" as const,
      };
    }
    return {
      message: `No publishing activity in the ${lower} yet.`,
      ctaLabel: "View all articles",
      status: "" as const,
    };
  }, [stats.scheduledJobs, stats.publishedInRange, insights.velocityPct, insights.publishedCurrent, rangeLabel]);

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

  return (
    <div className={styles.articlesOverviewShell}>
      <div className={styles.articlesOverview}>

        {/* ── KPI summary (range-filtered) ── */}
        <section className={styles.articlesOverviewSection} aria-labelledby="overview-kpi-label">
          <div id="overview-kpi-label" className={styles.articlesOverviewSectionLabel} aria-hidden="true">{rangeLabel}</div>
          <div
            className={styles.articlesOverviewStatGrid}
            role="list"
            aria-label={`Project statistics for ${rangeLabel}`}
          >
            <button
              type="button"
              className={`${styles.articlesOverviewStatCard} ${styles.articlesOverviewStatCardPublished}`}
              style={{ ["--stat-i" as string]: 0 }}
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
              style={{ ["--stat-i" as string]: 1 }}
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
              style={{ ["--stat-i" as string]: 2 }}
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
              style={{ ["--stat-i" as string]: 3 }}
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
              style={{ ["--stat-i" as string]: 4 }}
              onClick={() => onViewList("")}
              role="listitem"
            >
              <span className={styles.articlesOverviewStatValue}>{stats.total.toLocaleString()}</span>
              <span className={styles.articlesOverviewStatLabel}>Total articles</span>
              <span className={styles.articlesOverviewStatSub}>All time</span>
            </button>
          </div>
        </section>

        {/* ── Two side-by-side charts: GSC trend (left) + Content vs Search Performance (right) ── */}
        <section className={styles.articlesOverviewSection} aria-labelledby="overview-charts-label">
          <div id="overview-charts-label" className={styles.articlesOverviewSectionLabel} aria-hidden="true">Performance Charts</div>
          <div className={styles.articlesOverviewChartsGrid}>
            <div className={styles.articlesOverviewChartCard}>
              <div className={styles.articlesOverviewChartHead}>
                <div>
                  <h3 className={styles.articlesOverviewChartTitle}>Google Search Console</h3>
                  <p className={styles.articlesOverviewChartSub}>Clicks and impressions by day</p>
                </div>
              </div>
              {!gscConnected ? (
                <div className={styles.articlesOverviewGscPrompt}>
                  <div className={styles.articlesOverviewGscPromptText}>
                    <span className={styles.articlesOverviewGscPromptTitle}>Search Console not connected</span>
                    <p className={styles.articlesOverviewGscPromptBody}>
                      Connect Google Search Console to see clicks and impressions trends here.
                    </p>
                  </div>
                  <Link href={`/projects/${projectId}?tab=project_settings`} className={styles.articlesOverviewGscPromptLink}>
                    Connect Search Console
                  </Link>
                </div>
              ) : gscSeriesForChart.length === 0 ? (
                <p className={styles.articlesOverviewListEmpty}>No Search Console data in this period.</p>
              ) : (
                <GoogleSearchConsoleChart series={gscSeriesForChart} />
              )}
            </div>
            <div className={styles.articlesOverviewChartCard}>
              <div className={styles.articlesOverviewChartHead}>
                <div>
                  <h3 className={styles.articlesOverviewChartTitle}>Content vs Search Performance</h3>
                  <p className={styles.articlesOverviewChartSub}>Articles published vs. organic clicks by day</p>
                </div>
              </div>
              {contentVsSearchSeries.length === 0 ? (
                <p className={styles.articlesOverviewListEmpty}>No activity in this period.</p>
              ) : (
                <ContentVsSearchChart series={contentVsSearchSeries} styles={styles} />
              )}
            </div>
          </div>
        </section>

        {/* ── 3 donuts in one row: Clicks by Country, Clicks by Device, Article
             Distribution by Status. The first two render nothing (BreakdownDonut
             returns null on an all-zero total) when GSC isn't connected -- the status
             donut always shows since it's derived from `articles` only. ── */}
        <section className={styles.articlesOverviewSection} aria-labelledby="overview-donuts-label">
          <div id="overview-donuts-label" className={styles.articlesOverviewSectionLabel} aria-hidden="true">Breakdown</div>
          <div className={styles.articlesOverviewDonutRow}>
            <BreakdownDonut
              title="Clicks by Country"
              centerUnitLabel="Clicks"
              segments={countryBreakdown.segments}
              values={countryBreakdown.values}
              styles={styles}
            />
            <BreakdownDonut
              title="Clicks by Device"
              centerUnitLabel="Clicks"
              segments={DEVICE_SEGMENTS}
              values={deviceValues}
              styles={styles}
            />
            <BreakdownDonut
              title="Article Distribution by Status"
              centerUnitLabel="Articles"
              segments={statusBreakdown.segments}
              values={statusBreakdown.values}
              styles={styles}
            />
          </div>
        </section>

        {/* ── Search Performance (Google Search Console) ── */}
        <section className={styles.articlesOverviewSection} aria-labelledby="overview-gsc-label">
          <div id="overview-gsc-label" className={styles.articlesOverviewSectionLabel} aria-hidden="true">Search Performance</div>
          {!gscConnected ? (
            <div className={styles.articlesOverviewGscPrompt}>
              <div className={styles.articlesOverviewGscPromptText}>
                <span className={styles.articlesOverviewGscPromptTitle}>Search Console not connected</span>
                <p className={styles.articlesOverviewGscPromptBody}>
                  Connect Google Search Console to see clicks, impressions, and average position for this project.
                </p>
              </div>
              <Link href={`/projects/${projectId}?tab=project_settings`} className={styles.articlesOverviewGscPromptLink}>
                Connect Search Console
              </Link>
            </div>
          ) : gscInsights ? (
            <>
              <div className={styles.articlesOverviewStatGrid} role="list" aria-label="Search performance, last 28 days">
                <div className={styles.articlesOverviewStatCard} style={{ ["--stat-i" as string]: 0 }} role="listitem">
                  <span className={styles.articlesOverviewStatValue}>{gscInsights.headline.clicks.value.toLocaleString()}</span>
                  <span className={styles.articlesOverviewStatLabel}>Total clicks</span>
                  <TrendChip styles={styles} changePct={gscInsights.headline.clicks.change_pct} />
                </div>
                <div className={styles.articlesOverviewStatCard} style={{ ["--stat-i" as string]: 1 }} role="listitem">
                  <span className={styles.articlesOverviewStatValue}>{gscInsights.headline.impressions.value.toLocaleString()}</span>
                  <span className={styles.articlesOverviewStatLabel}>Impressions</span>
                  <TrendChip styles={styles} changePct={gscInsights.headline.impressions.change_pct} />
                </div>
                <div className={styles.articlesOverviewStatCard} style={{ ["--stat-i" as string]: 2 }} role="listitem">
                  <span className={styles.articlesOverviewStatValue}>{formatCtr(gscInsights.headline.ctr.value)}</span>
                  <span className={styles.articlesOverviewStatLabel}>Avg CTR</span>
                  <TrendChip styles={styles} changePct={gscInsights.headline.ctr.change_pct} />
                </div>
                <div className={styles.articlesOverviewStatCard} style={{ ["--stat-i" as string]: 3 }} role="listitem">
                  <span className={styles.articlesOverviewStatValue}>{formatPosition(gscInsights.headline.position.value)}</span>
                  <span className={styles.articlesOverviewStatLabel}>Avg position</span>
                  <TrendChip styles={styles} changePct={gscInsights.headline.position.change_pct} invert />
                </div>
                {gscInsights.submitted_pages != null ? (
                  <div className={styles.articlesOverviewStatCard} style={{ ["--stat-i" as string]: 4 }} role="listitem">
                    <span className={styles.articlesOverviewStatValue}>{gscInsights.submitted_pages.toLocaleString()}</span>
                    <span className={styles.articlesOverviewStatLabel}>Pages submitted</span>
                    <span className={styles.articlesOverviewStatSub}>Via sitemap</span>
                  </div>
                ) : null}
              </div>

              <div className={styles.articlesOverviewChartsGrid}>
              <div className={styles.articlesOverviewPanel}>
                <header className={styles.articlesOverviewPanelHead}>
                  <h3 className={styles.articlesOverviewPanelTitle}>Search Performance by Page</h3>
                </header>
                {sortedPages.length === 0 ? (
                  <p className={styles.articlesOverviewListEmpty}>No page clicks in this period.</p>
                ) : (
                  <DataTable>
                    <DataTableHead>
                      <DataTableRow>
                        <DataTableHeaderCell>Page</DataTableHeaderCell>
                        <DataTableHeaderCell className="text-right">
                          <SortHeaderButton label="Clicks" active={pageSort.key === "clicks"} dir={pageSort.key === "clicks" ? pageSort.dir : null} onClick={() => togglePageSort("clicks")} />
                        </DataTableHeaderCell>
                        <DataTableHeaderCell className="text-right">
                          <SortHeaderButton label="Impressions" active={pageSort.key === "impressions"} dir={pageSort.key === "impressions" ? pageSort.dir : null} onClick={() => togglePageSort("impressions")} />
                        </DataTableHeaderCell>
                        <DataTableHeaderCell className="text-right">
                          <SortHeaderButton label="CTR" active={pageSort.key === "ctr"} dir={pageSort.key === "ctr" ? pageSort.dir : null} onClick={() => togglePageSort("ctr")} />
                        </DataTableHeaderCell>
                        <DataTableHeaderCell className="text-right">
                          <SortHeaderButton label="Position" active={pageSort.key === "position"} dir={pageSort.key === "position" ? pageSort.dir : null} onClick={() => togglePageSort("position")} />
                        </DataTableHeaderCell>
                        <DataTableHeaderCell className="text-center">Trend</DataTableHeaderCell>
                      </DataTableRow>
                    </DataTableHead>
                    <DataTableBody>
                      {pagedPages.map((p) => (
                        <DataTableRow key={p.page}>
                          <DataTableCell title={p.page}>{formatPageLabel(p.page)}</DataTableCell>
                          <DataTableCell className="text-right tabular-nums">{p.clicks.toLocaleString()}</DataTableCell>
                          <DataTableCell className="text-right tabular-nums">{p.impressions.toLocaleString()}</DataTableCell>
                          <DataTableCell className="text-right tabular-nums">{formatCtr(p.ctr)}</DataTableCell>
                          <DataTableCell className="text-right tabular-nums">{formatPosition(p.position)}</DataTableCell>
                          <DataTableCell className="text-center"><TrendChip styles={styles} changePct={p.change_pct} /></DataTableCell>
                        </DataTableRow>
                      ))}
                    </DataTableBody>
                  </DataTable>
                )}
                <TablePagination page={pagePage} totalPages={pageTotalPages} onPageChange={setPagePage} />
              </div>

              <div className={styles.articlesOverviewPanel}>
                <header className={styles.articlesOverviewPanelHead}>
                  <h3 className={styles.articlesOverviewPanelTitle}>Top Search Queries</h3>
                </header>
                {sortedQueries.length === 0 ? (
                  <p className={styles.articlesOverviewListEmpty}>No query clicks in this period.</p>
                ) : (
                  <DataTable>
                    <DataTableHead>
                      <DataTableRow>
                        <DataTableHeaderCell>Query</DataTableHeaderCell>
                        <DataTableHeaderCell className="text-right">
                          <SortHeaderButton label="Clicks" active={querySort.key === "clicks"} dir={querySort.key === "clicks" ? querySort.dir : null} onClick={() => toggleQuerySort("clicks")} />
                        </DataTableHeaderCell>
                        <DataTableHeaderCell className="text-right">
                          <SortHeaderButton label="Impressions" active={querySort.key === "impressions"} dir={querySort.key === "impressions" ? querySort.dir : null} onClick={() => toggleQuerySort("impressions")} />
                        </DataTableHeaderCell>
                        <DataTableHeaderCell className="text-right">
                          <SortHeaderButton label="Position" active={querySort.key === "position"} dir={querySort.key === "position" ? querySort.dir : null} onClick={() => toggleQuerySort("position")} />
                        </DataTableHeaderCell>
                      </DataTableRow>
                    </DataTableHead>
                    <DataTableBody>
                      {pagedQueries.map((q) => (
                        <DataTableRow key={q.query}>
                          <DataTableCell title={q.query}>{q.query}</DataTableCell>
                          <DataTableCell className="text-right tabular-nums">{q.clicks.toLocaleString()}</DataTableCell>
                          <DataTableCell className="text-right tabular-nums">{q.impressions.toLocaleString()}</DataTableCell>
                          <DataTableCell className="text-right tabular-nums">{formatPosition(q.position)}</DataTableCell>
                        </DataTableRow>
                      ))}
                    </DataTableBody>
                  </DataTable>
                )}
                <TablePagination page={queryPage} totalPages={queryTotalPages} onPageChange={setQueryPage} />
              </div>
              </div>
            </>
          ) : null}
        </section>

        {/* ── AI Generative Visibility (AI Citation tracking) — disabled for now per
             explicit request. Left in place (render-guarded, not deleted) so it's a
             one-line flip to bring back rather than a rebuild. ── */}
        {false && (
        <section className={styles.articlesOverviewSection} aria-labelledby="overview-ai-citation-label">
          <div id="overview-ai-citation-label" className={styles.articlesOverviewSectionLabel} aria-hidden="true">AI Generative Visibility</div>
          {aiCitationEnginesConfigured.length === 0 ? (
            <p className={styles.muted} style={{ fontSize: 13 }}>
              AI citation checking isn&apos;t configured for this deployment yet.
            </p>
          ) : aiCitationChecks.length === 0 ? (
            <div className={styles.articlesOverviewGscPrompt}>
              <div className={styles.articlesOverviewGscPromptText}>
                <span className={styles.articlesOverviewGscPromptTitle}>No AI citation checks yet</span>
                <p className={styles.articlesOverviewGscPromptBody}>
                  Check whether your brand gets cited by ChatGPT, Perplexity, Gemini, and Google AI Overview for your topics.
                </p>
              </div>
              <button type="button" className={styles.button} onClick={onRunAiCitationCheck} disabled={aiCitationRunning}>
                {aiCitationRunning ? "Checking…" : "Run AI Citation Check"}
              </button>
            </div>
          ) : (
            <>
              <AiCitationSummary checks={aiCitationChecks} styles={styles} />
              <AiCitationTrendChart points={aiCitationTrend} styles={styles} />
              <div className={styles.row} style={{ marginTop: 12 }}>
                <button type="button" className={styles.btnSecondary} onClick={onRunAiCitationCheck} disabled={aiCitationRunning}>
                  {aiCitationRunning ? "Checking…" : "Run check again"}
                </button>
                <Link href={`/projects/${projectId}?tab=site_audit`} className={styles.articlesOverviewGscPromptLink}>
                  View full AI Citation history →
                </Link>
              </div>
            </>
          )}
        </section>
        )}

        {/* ── SEO Improvement Opportunities — 3 quick-win cards, each a re-filter of
             data already in scope. A 4th ("Create content for trending queries") needs
             real query-vs-coverage gap analysis and is deferred (Phase 2). ── */}
        {gscConnected && gscInsights ? (
          <section className={styles.articlesOverviewSection} aria-labelledby="overview-opportunities-label">
            <div id="overview-opportunities-label" className={styles.articlesOverviewSectionLabel} aria-hidden="true">SEO Improvement Opportunities</div>
            <div className={styles.articlesOverviewInsightsRow}>
              <div className={styles.articlesOverviewOpportunityCard}>
                <span className={styles.articlesOverviewOpportunityIcon} aria-hidden="true">◎</span>
                <div className={styles.articlesOverviewOpportunityText}>
                  <span className={styles.articlesOverviewOpportunityValue}>{ctrOpportunityPages.length}</span>
                  <span className={styles.articlesOverviewOpportunityLabel}>
                    Page{ctrOpportunityPages.length !== 1 ? "s" : ""} ranking top 10 with below-average CTR
                  </span>
                </div>
              </div>
              <div className={styles.articlesOverviewOpportunityCard}>
                <span className={styles.articlesOverviewOpportunityIcon} aria-hidden="true">◎</span>
                <div className={styles.articlesOverviewOpportunityText}>
                  <span className={styles.articlesOverviewOpportunityValue}>{noInternalLinksCount}</span>
                  <span className={styles.articlesOverviewOpportunityLabel}>
                    Published article{noInternalLinksCount !== 1 ? "s" : ""} with no internal links
                  </span>
                </div>
              </div>
              <div className={styles.articlesOverviewOpportunityCard}>
                <span className={styles.articlesOverviewOpportunityIcon} aria-hidden="true">◎</span>
                <div className={styles.articlesOverviewOpportunityText}>
                  <span className={styles.articlesOverviewOpportunityValue}>{underperformingPages.length}</span>
                  <span className={styles.articlesOverviewOpportunityLabel}>
                    Page{underperformingPages.length !== 1 ? "s" : ""} ranking position 11-20 (page-2 band)
                  </span>
                </div>
              </div>
            </div>
          </section>
        ) : null}

        {/* ── Publishing activity — removed from the bottom section per explicit request.
             Left in place (render-guarded, not deleted) so it's a one-line flip to bring
             back rather than a rebuild, same pattern as AI Generative Visibility above. ── */}
        {false && (
        <section className={styles.articlesOverviewChartCard} aria-labelledby="overview-chart-label">
          <div className={styles.articlesOverviewChartHead}>
            <div>
              <h3 id="overview-chart-label" className={styles.articlesOverviewChartTitle}>Publishing Activity</h3>
              <p className={styles.articlesOverviewChartSub}>Published, pending, scheduled, and draft articles by day</p>
            </div>
          </div>
          <ProjectActivityChart
            series={chartSeries}
            label="Article activity by day"
            styles={styles}
          />
          <div className={styles.articlesOverviewChartInsight} data-status={chartInsight.status || undefined}>
            <span className={styles.articlesOverviewChartInsightIcon} aria-hidden="true">💡</span>
            <p className={styles.articlesOverviewChartInsightText}>{chartInsight.message}</p>
            <button
              type="button"
              className={styles.articlesOverviewChartInsightLink}
              onClick={() => onViewList(chartInsight.status)}
            >
              {chartInsight.ctaLabel} →
            </button>
          </div>
        </section>
        )}

        {/* ── Insights, incl. content opportunity ── */}
        {(insights.velocityPct !== null || insights.bestDayOfWeek || insights.contentOpportunity > 0) ? (
          <div className={styles.articlesOverviewInsightsRow} aria-label="Publishing insights">
            {insights.contentOpportunity > 0 ? (
              <div className={styles.articlesOverviewOpportunityCard}>
                <span className={styles.articlesOverviewOpportunityIcon} aria-hidden="true">◎</span>
                <div className={styles.articlesOverviewOpportunityText}>
                  <span className={styles.articlesOverviewOpportunityValue}>{insights.contentOpportunity}</span>
                  <span className={styles.articlesOverviewOpportunityLabel}>
                    Content opportunity — draft{insights.contentOpportunity !== 1 ? "s" : ""} ready to publish
                  </span>
                </div>
                <button
                  type="button"
                  className={styles.articlesOverviewOpportunityAction}
                  onClick={() => onViewList("draft")}
                >
                  Review drafts
                </button>
              </div>
            ) : null}

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
          </div>
        ) : null}

        {/* ── Content operations ── */}
        <section className={styles.articlesOverviewSection} aria-labelledby="overview-ops-label">
          <div id="overview-ops-label" className={styles.articlesOverviewSectionLabel} aria-hidden="true">Content Operations</div>
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
          </div>
        </section>
      </div>
    </div>
  );
}
