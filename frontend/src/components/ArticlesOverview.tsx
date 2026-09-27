"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AiCitationSummary, AiCitationTrendChart } from "@/components/AiCitationResults";
import { OverviewReadinessGate } from "@/components/OverviewReadinessGate";
import { ProjectActivityChart } from "@/components/ProjectActivityChart";
import { OverviewPageSkeleton } from "@/components/skeleton";
import { BreakdownDonut } from "@/components/ui";
import type {
  AiCitationCheck,
  AiCitationEngine,
  AiCitationTrendPoint,
  ArticlePublic,
  GscInsightsResponse,
  ScheduledJobPublic,
} from "@/lib/api";
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
  gscConnected?: boolean;
  gscInsights?: GscInsightsResponse | null;
  aiCitationChecks?: AiCitationCheck[];
  aiCitationEnginesConfigured?: AiCitationEngine[];
  aiCitationTrend?: AiCitationTrendPoint[];
  aiCitationRunning?: boolean;
  onRunAiCitationCheck?: () => void;
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
    gscConnected,
    gscInsights,
    aiCitationChecks = [],
    aiCitationEnginesConfigured = [],
    aiCitationTrend = [],
    aiCitationRunning,
    onRunAiCitationCheck,
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

        {/* ── Header ── */}
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

        {/* ── Time range controls ── */}
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

              <div className={styles.articlesOverviewTrendingGrid}>
                <div className={styles.articlesOverviewPanel}>
                  <header className={styles.articlesOverviewPanelHead}>
                    <h3 className={styles.articlesOverviewPanelTitle}>Trending pages</h3>
                  </header>
                  <ul className={styles.articlesOverviewTrendingList}>
                    {gscInsights.pages.length === 0 ? (
                      <li className={styles.articlesOverviewListEmpty}>No page clicks in this period.</li>
                    ) : (
                      gscInsights.pages.slice(0, 5).map((p) => (
                        <li key={p.page} className={styles.articlesOverviewTrendingItem}>
                          <span className={styles.articlesOverviewTrendingLabel} title={p.page}>{formatPageLabel(p.page)}</span>
                          <span className={styles.articlesOverviewTrendingValue}>{p.clicks.toLocaleString()}</span>
                          <TrendChip styles={styles} changePct={p.change_pct} />
                        </li>
                      ))
                    )}
                  </ul>
                </div>
                <div className={styles.articlesOverviewPanel}>
                  <header className={styles.articlesOverviewPanelHead}>
                    <h3 className={styles.articlesOverviewPanelTitle}>Trending queries</h3>
                  </header>
                  <ul className={styles.articlesOverviewTrendingList}>
                    {gscInsights.queries.length === 0 ? (
                      <li className={styles.articlesOverviewListEmpty}>No query clicks in this period.</li>
                    ) : (
                      gscInsights.queries.slice(0, 5).map((q) => (
                        <li key={q.query} className={styles.articlesOverviewTrendingItem}>
                          <span className={styles.articlesOverviewTrendingLabel} title={q.query}>{q.query}</span>
                          <span className={styles.articlesOverviewTrendingValue}>{q.clicks.toLocaleString()}</span>
                          <TrendChip styles={styles} changePct={q.change_pct} />
                        </li>
                      ))
                    )}
                  </ul>
                </div>
              </div>

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
              </div>
            </>
          ) : null}
        </section>

        {/* ── AI Generative Visibility (AI Citation tracking) ── */}
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

        {/* ── Publishing activity ── */}
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
        </section>
      </div>
    </div>
  );
}
