"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { ArticlesOverviewChart } from "@/components/ArticlesOverviewChart";
import { OverviewStatCarousel } from "@/components/OverviewStatCarousel";
import { OverviewReadinessGate } from "@/components/OverviewReadinessGate";
import { OverviewPageSkeleton } from "@/components/skeleton";
import type { ArticlePublic, GscAnalyticsSeriesPoint, ScheduledJobPublic } from "@/lib/api";
import { articleEditorPath } from "@/lib/articlePaths";
import { evaluateProjectOverviewReadiness } from "@/lib/overviewReadiness";
import {
  buildArticleActivityBarSeries,
  cartItems,
  computeOverviewStats,
  formatOverviewDate,
  pendingItems,
  recentPublishedItems,
  upcomingScheduledItems,
  type ArticlesOverviewRange,
  type OverviewListItem,
} from "@/lib/articlesOverview";

type ArticlesOverviewProps = {
  projectId: string;
  styles: Record<string, string>;
  articles: ArticlePublic[];
  scheduledJobs: ScheduledJobPublic[];
  titleByArticleId: Record<string, string>;
  selectedIds: string[];
  gscSeries?: GscAnalyticsSeriesPoint[] | null;
  loading?: boolean;
  onViewList: (status?: string) => void;
};

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
        <h3 className={styles.articlesOverviewPanelTitle}>
          <span className={styles.articlesOverviewPanelIcon} aria-hidden="true">
            ◷
          </span>
          {title}
        </h3>
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

export function ArticlesOverview(props: ArticlesOverviewProps) {
  const {
    projectId,
    styles,
    articles,
    scheduledJobs,
    titleByArticleId,
    selectedIds,
    loading,
    onViewList,
  } = props;

  const [chartRange, setChartRange] = useState<ArticlesOverviewRange>(28);

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

  const statCards = useMemo(
    () => [
      {
        value: stats.publishedInRange,
        label: `Published · last ${chartRange} day${chartRange === 1 ? "" : "s"}`,
        onClick: () => onViewList("published"),
      },
      {
        value: stats.pending,
        label: "Pending",
        onClick: () => onViewList("pending"),
      },
      {
        value: stats.scheduledJobs,
        label: "Scheduled jobs",
        onClick: () => onViewList("scheduled"),
      },
      {
        value: stats.draft,
        label: "Drafts",
        onClick: () => onViewList("draft"),
      },
      {
        value: stats.total,
        label: "Total articles",
        onClick: () => onViewList(""),
      },
    ],
    [stats, chartRange, onViewList],
  );

  const upcoming = useMemo(
    () => upcomingScheduledItems(scheduledJobs, titleByArticleId, 5),
    [scheduledJobs, titleByArticleId],
  );
  const published = useMemo(() => recentPublishedItems(articles, 5), [articles]);
  const pending = useMemo(() => pendingItems(articles, 5), [articles]);
  const cart = useMemo(() => cartItems(articles, selectedIds, 8), [articles, selectedIds]);

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
        <OverviewStatCarousel trackClassName={styles.articlesOverviewStatGrid} ariaLabel="Project overview statistics">
          {statCards.map((card) => (
            <button
              key={card.label}
              type="button"
              className={styles.articlesOverviewStatCard}
              onClick={card.onClick}
              role="listitem"
            >
              <span className={styles.articlesOverviewStatValue}>{card.value.toLocaleString()}</span>
              <span className={styles.articlesOverviewStatLabel}>{card.label}</span>
            </button>
          ))}
        </OverviewStatCarousel>

        <div className={styles.articlesOverviewMainGrid}>
          <section className={styles.articlesOverviewChartCard}>
            <div className={styles.articlesOverviewChartHead}>
              <div>
                <h3 className={styles.articlesOverviewChartTitle}>Activity</h3>
                <p className={styles.articlesOverviewChartSub}>
                  Published, pending, and scheduled activity by day
                </p>
              </div>
              <div className={styles.articlesOverviewRangeTabs} role="tablist" aria-label="Chart range">
                {(
                  [
                    [28, "LAST 28 DAYS"],
                    [7, "LAST 7 DAYS"],
                    [1, "LAST 24 HOURS"],
                  ] as const
                ).map(([days, label]) => (
                  <button
                    key={days}
                    type="button"
                    role="tab"
                    aria-selected={chartRange === days}
                    className={`${styles.articlesOverviewRangeBtn} ${chartRange === days ? styles.articlesOverviewRangeBtnActive : ""}`}
                    onClick={() => setChartRange(days)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <ArticlesOverviewChart
              series={chartSeries}
              label="Article published, pending, and scheduled by day"
              styles={styles}
            />
          </section>

          <OverviewPanel
            styles={styles}
            title="Upcoming scheduled articles"
            items={upcoming}
            empty="No upcoming schedules. Schedule articles from the list or bulk actions."
            projectId={projectId}
            onViewAll={() => onViewList("scheduled")}
          />
        </div>

        <div className={styles.articlesOverviewPanelsGrid}>
          <OverviewPanel
            styles={styles}
            title="Recently published articles"
            items={published}
            empty="No published articles yet."
            projectId={projectId}
            showFeaturedImage
            onViewAll={() => onViewList("published")}
          />
          <OverviewPanel
            styles={styles}
            title="Pending articles"
            items={pending}
            empty="No pending articles — everything is in progress or published."
            projectId={projectId}
            onViewAll={() => onViewList("pending")}
          />
          <OverviewPanel
            styles={styles}
            title="Selection cart"
            items={cart}
            empty={
              selectedIds.length
                ? "Selected articles are not loaded in overview cache."
                : "No articles selected. Select rows in the list to stage bulk actions."
            }
            projectId={projectId}
            onViewAll={() => onViewList("")}
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
