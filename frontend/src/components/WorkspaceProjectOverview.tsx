"use client";

import Link from "next/link";
import { useMemo } from "react";

import { ArticlesOverviewChart } from "@/components/ArticlesOverviewChart";
import { OverviewStatCarousel } from "@/components/OverviewStatCarousel";
import { OverviewReadinessGate } from "@/components/OverviewReadinessGate";
import { articleEditorPath, isValidArticleRef } from "@/lib/articlePaths";
import { formatOverviewDateTime } from "@/lib/articlesOverview";
import { evaluateWorkspaceOverviewReadiness } from "@/lib/overviewReadiness";
import type { WorkspaceFeedItem, WorkspaceOverviewResponse, WorkspaceOverviewStats } from "@/lib/api";

const DISPLAY_LIMIT = 6;

const PIPELINE_META = [
  { key: "published" as const, label: "Recently posted", color: "var(--aa-primary, #d97757)" },
  { key: "pending" as const, label: "Pending", color: "#c8ccd4" },
  { key: "upcoming_scheduled" as const, label: "Upcoming scheduled", color: "#f5c842" },
  { key: "draft" as const, label: "Drafts", color: "#8ba4ff" },
] as const;

function buildChartStyleMap(styles: Record<string, string>): Record<string, string> {
  return {
    articlesOverviewChartWrap: styles.wsChartWrap,
    articlesOverviewChartLegend: styles.wsChartLegend,
    articlesOverviewChartLegendSwatch: styles.wsChartLegendSwatch,
    articlesOverviewChartSvg: styles.wsChartSvg,
    articlesOverviewChartTooltip: styles.wsChartTooltip,
    articlesOverviewChartTooltipPanel: styles.wsChartTooltipPanel,
    articlesOverviewChartTooltipHead: styles.wsChartTooltipHead,
    articlesOverviewChartTooltipDate: styles.wsChartTooltipDate,
    articlesOverviewChartTooltipCaption: styles.wsChartTooltipCaption,
    articlesOverviewChartTooltipTable: styles.wsChartTooltipTable,
    articlesOverviewChartTooltipMetric: styles.wsChartTooltipMetric,
    articlesOverviewChartTooltipValue: styles.wsChartTooltipValue,
    articlesOverviewChartTooltipFooter: styles.wsChartTooltipFooter,
    articlesOverviewChartTooltipFooterLabel: styles.wsChartTooltipFooterLabel,
    articlesOverviewChartTooltipFooterValue: styles.wsChartTooltipFooterValue,
    articlesOverviewChartTooltipCaret: styles.wsChartTooltipCaret,
    articlesOverviewChartTooltipSwatch: styles.wsChartTooltipSwatch,
    articlesOverviewChartTooltipSwatchPublished: styles.wsChartTooltipSwatchPublished,
    articlesOverviewChartTooltipSwatchPending: styles.wsChartTooltipSwatchPending,
    articlesOverviewChartTooltipSwatchScheduled: styles.wsChartTooltipSwatchScheduled,
    articlesOverviewChartEmpty: styles.wsChartEmpty,
  };
}

function PipelineChart(props: { stats: WorkspaceOverviewStats; styles: Record<string, string> }) {
  const { stats, styles } = props;
  const rows = PIPELINE_META.map((m) => ({
    ...m,
    value:
      m.key === "upcoming_scheduled"
        ? stats.upcoming_scheduled
        : m.key === "published"
          ? stats.published
          : m.key === "pending"
            ? stats.pending
            : stats.draft,
  }));
  const max = Math.max(1, ...rows.map((r) => r.value));

  return (
    <div className={styles.wsPipelineChart} role="img" aria-label="Article pipeline by status">
      {rows.map((row) => (
        <div key={row.key} className={styles.wsPipelineRow}>
          <div className={styles.wsPipelineRowHead}>
            <span className={styles.wsPipelineLabel}>
              <span className={styles.wsPipelineDot} style={{ background: row.color }} aria-hidden="true" />
              {row.label}
            </span>
            <span className={styles.wsPipelineValue}>{row.value.toLocaleString()}</span>
          </div>
          <div className={styles.wsPipelineTrack} aria-hidden="true">
            <span
              className={styles.wsPipelineFill}
              style={{ width: `${Math.max(4, (row.value / max) * 100)}%`, background: row.color }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function OverviewModuleFallback(props: {
  title: string;
  message: string;
  styles: Record<string, string>;
}) {
  const { title, message, styles } = props;
  return (
    <div className={styles.wsOverviewModuleFallback} role="status">
      <p className={styles.wsOverviewModuleFallbackTitle}>{title}</p>
      <p className={styles.wsOverviewModuleFallbackMsg}>{message}</p>
    </div>
  );
}

function FeedPanel(props: {
  title: string;
  subtitle: string;
  empty: string;
  items: WorkspaceFeedItem[];
  totalCount?: number;
  styles: Record<string, string>;
  accentClass: string;
}) {
  const { title, subtitle, empty, items, totalCount, styles, accentClass } = props;
  const navigable = items.filter((item) => isValidArticleRef(item.project_id, item.article_id));
  const skipped = items.length - navigable.length;
  const visible = navigable.slice(0, DISPLAY_LIMIT);
  const total = totalCount ?? items.length;
  const more = Math.max(0, total - visible.length);

  return (
    <section className={`${styles.wsOverviewPanel} ${accentClass}`}>
      <header className={styles.wsOverviewPanelHead}>
        <div className={styles.wsOverviewPanelHeadText}>
          <h3 className={styles.wsOverviewPanelTitle}>{title}</h3>
          <p className={styles.wsOverviewPanelSub}>{subtitle}</p>
        </div>
        <span className={styles.wsOverviewPanelCount}>
          {visible.length}
          {total > visible.length ? ` / ${total.toLocaleString()}` : ""}
        </span>
      </header>

      {visible.length === 0 ? (
        <p className={styles.wsOverviewListEmpty}>{empty}</p>
      ) : (
        <div className={styles.wsOverviewTableWrap}>
          <table className={styles.wsOverviewTable}>
            <thead>
              <tr>
                <th className={styles.wsOverviewThProject} scope="col">
                  Project
                </th>
                <th className={styles.wsOverviewThArticle} scope="col">
                  Article
                </th>
                <th className={styles.wsOverviewThDate} scope="col">
                  Date &amp; time
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((item) => {
                const when = formatOverviewDateTime(item.sort_at);
                return (
                  <tr key={`${item.status_tag}-${item.id}`} className={styles.wsOverviewTableRow}>
                    <td className={styles.wsOverviewTdProject}>
                      <span className={styles.wsProjectBadge} title={item.project_name}>
                        {item.project_name}
                      </span>
                    </td>
                    <td className={styles.wsOverviewTdArticle}>
                      {(() => {
                        const href = articleEditorPath(item.project_id, item.article_id);
                        if (!href) {
                          return (
                            <span className={styles.wsOverviewListTitleMuted} title={item.title}>
                              {item.title}
                            </span>
                          );
                        }
                        return (
                          <Link href={href} className={styles.wsOverviewListTitle} title={item.title}>
                            {item.title}
                          </Link>
                        );
                      })()}
                    </td>
                    <td className={styles.wsOverviewTdDate}>
                      <time dateTime={item.sort_at || undefined} className={styles.wsOverviewDateTime}>
                        <span className={styles.wsOverviewDateLine}>{when.date}</span>
                        {when.time ? <span className={styles.wsOverviewTimeLine}>{when.time}</span> : null}
                      </time>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {more > 0 ? (
        <p className={styles.wsOverviewMoreHint}>{more.toLocaleString()} more across your projects</p>
      ) : null}
      {skipped > 0 ? (
        <p className={styles.wsOverviewMoreHint}>
          {skipped.toLocaleString()} row{skipped === 1 ? "" : "s"} hidden (invalid or missing article link)
        </p>
      ) : null}
    </section>
  );
}

export function WorkspaceProjectOverview(props: {
  data: WorkspaceOverviewResponse | null;
  loading: boolean;
  error?: string | null;
  styles: Record<string, string>;
  onGoProjects?: () => void;
  onOpenTutorial?: () => void;
}) {
  const { data, loading, error, styles, onGoProjects, onOpenTutorial } = props;
  const chartStyles = useMemo(() => buildChartStyleMap(styles), [styles]);
  const readiness = useMemo(
    () => (data ? evaluateWorkspaceOverviewReadiness(data) : null),
    [data],
  );

  if (loading) {
    return <div className={styles.wsOverviewLoading}>Loading workspace overview…</div>;
  }

  if (!data) {
    return (
      <OverviewModuleFallback
        title="Overview unavailable"
        message={error || "Unable to load workspace overview. Refresh the page or try again in a moment."}
        styles={styles}
      />
    );
  }

  const { stats } = data;
  const statCards = [
    { label: "Projects", value: stats.project_count, hint: "Active sites" },
    { label: "Recently posted", value: stats.published, hint: "Published" },
    { label: "Pending", value: stats.pending, hint: "In queue" },
    { label: "Scheduled", value: stats.upcoming_scheduled, hint: "Upcoming" },
    { label: "Drafts", value: stats.draft, hint: "Draft" },
    { label: "Total articles", value: stats.total_articles, hint: "All statuses" },
  ];

  const activitySeries = (data.activity_series || []).map((p) => ({
    date: p.date,
    published: p.published,
    pending: p.pending,
    scheduled: p.scheduled,
  }));

  if (readiness && !readiness.isReady) {
    return (
      <OverviewReadinessGate
        readiness={readiness}
        styles={styles}
        primaryAction={
          onGoProjects
            ? { label: "Go to project management", onClick: onGoProjects }
            : undefined
        }
        secondaryAction={
          onOpenTutorial ? { label: "Watch tutorial", onClick: onOpenTutorial } : undefined
        }
      />
    );
  }

  return (
    <div className={styles.wsOverviewShell}>
      <OverviewStatCarousel trackClassName={styles.wsOverviewStatGrid} ariaLabel="Workspace overview statistics">
        {statCards.map((card) => (
          <div key={card.label} className={styles.wsOverviewStatCard} role="listitem">
            <span className={styles.wsOverviewStatValue}>{card.value.toLocaleString()}</span>
            <span className={styles.wsOverviewStatLabel}>{card.label}</span>
            <span className={styles.wsOverviewStatHint}>{card.hint}</span>
          </div>
        ))}
      </OverviewStatCarousel>

      <div className={styles.wsOverviewHero}>
        <section className={styles.wsOverviewChartCard}>
          <header className={styles.wsOverviewChartCardHead}>
            <div>
              <h3 className={styles.wsOverviewChartCardTitle}>Workspace activity</h3>
              <p className={styles.wsOverviewChartCardSub}>Published, pending, and scheduled · last 14 days</p>
            </div>
          </header>
          <ArticlesOverviewChart
            series={activitySeries}
            label="Workspace article activity by day"
            styles={chartStyles}
          />
        </section>

        <section className={styles.wsOverviewPipelineCard}>
          <header className={styles.wsOverviewChartCardHead}>
            <div>
              <h3 className={styles.wsOverviewChartCardTitle}>Pipeline snapshot</h3>
              <p className={styles.wsOverviewChartCardSub}>Volume by status across all projects</p>
            </div>
          </header>
          <PipelineChart stats={stats} styles={styles} />
        </section>
      </div>

      <div className={styles.wsOverviewBoardGrid}>
        <FeedPanel
          title="Upcoming scheduled"
          subtitle="Soonest publish dates first"
          empty="No upcoming schedules across your projects."
          items={data.upcoming_scheduled}
          totalCount={stats.upcoming_scheduled}
          styles={styles}
          accentClass={styles.wsOverviewPanel_scheduled}
        />
        <FeedPanel
          title="Recently posted"
          subtitle="Latest live articles"
          empty="No published articles yet."
          items={data.recently_published}
          totalCount={stats.published}
          styles={styles}
          accentClass={styles.wsOverviewPanel_published}
        />
        <FeedPanel
          title="Pending"
          subtitle="Waiting to generate or publish"
          empty="No pending articles in your workspace."
          items={data.pending}
          totalCount={stats.pending}
          styles={styles}
          accentClass={styles.wsOverviewPanel_pending}
        />
        <FeedPanel
          title="Drafts"
          subtitle="Saved but not scheduled"
          empty="No drafts in your workspace."
          items={data.drafts}
          totalCount={stats.draft}
          styles={styles}
          accentClass={styles.wsOverviewPanel_draft}
        />
      </div>
    </div>
  );
}
