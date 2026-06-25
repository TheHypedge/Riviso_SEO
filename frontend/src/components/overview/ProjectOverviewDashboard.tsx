"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { ArticlesOverviewChart } from "@/components/ArticlesOverviewChart";
import { api } from "@/lib/api";
import type {
  ProjectSummary,
  WorkspaceActivityDay,
  WorkspaceFeedItem,
  WorkspaceOverviewResponse,
  WorkspaceOverviewStats,
} from "@/lib/api";
import { articleEditorPath } from "@/lib/articlePaths";

import s from "./ProjectOverviewDashboard.module.css";

// ── helpers ───────────────────────────────────────────────────────────────────
function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    const ms = Date.parse(iso.includes("T") ? iso : `${iso}T00:00:00Z`);
    if (!ms) return "—";
    const diff = (Date.now() - ms) / 1000;
    if (diff < 60) return "Just now";
    if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
    if (diff < 86400 * 30) return `${Math.round(diff / 86400)}d ago`;
    return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  } catch { return "—"; }
}

function fmtScheduleTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso.includes("T") ? iso : `${iso}T00:00:00Z`);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch { return "—"; }
}

// ── Donut chart (SVG) ─────────────────────────────────────────────────────────
const DONUT_COLORS: Record<string, string> = {
  published: "#5db872",
  scheduled: "#d4a017",
  draft: "#7090c8",
  pending: "#d97757",
};

const DONUT_LABELS: Record<string, string> = {
  published: "Published",
  scheduled: "Scheduled",
  draft: "Drafts",
  pending: "Pending",
};

function DonutChart({ stats }: { stats: WorkspaceOverviewStats }) {
  const segments = useMemo(() => {
    const items = [
      { key: "published", value: stats.published },
      { key: "scheduled", value: stats.upcoming_scheduled },
      { key: "draft", value: stats.draft },
      { key: "pending", value: stats.pending },
    ];
    const total = Math.max(1, items.reduce((s, i) => s + i.value, 0));
    let offset = 0;
    return items.map((item) => {
      const pct = item.value / total;
      const seg = { ...item, pct, offset };
      offset += pct;
      return seg;
    });
  }, [stats]);

  const total = stats.published + stats.upcoming_scheduled + stats.draft + stats.pending;
  const r = 54;
  const circ = 2 * Math.PI * r;
  const cx = 70;
  const cy = 70;
  const gap = 0.01;

  return (
    <div className={s.donutWrap}>
      <div className={s.donutSvgWrap}>
        <svg width="140" height="140" viewBox="0 0 140 140" aria-hidden="true">
          {total === 0 ? (
            <circle cx={cx} cy={cy} r={r} fill="none" strokeWidth="14" stroke="rgba(255,255,255,0.08)" />
          ) : (
            segments.map((seg) => {
              const dashLen = Math.max(0, seg.pct * circ - gap * circ);
              const dashOff = -seg.offset * circ;
              return (
                <circle
                  key={seg.key}
                  cx={cx} cy={cy} r={r}
                  fill="none"
                  strokeWidth="14"
                  stroke={DONUT_COLORS[seg.key]}
                  strokeDasharray={`${dashLen} ${circ}`}
                  strokeDashoffset={dashOff}
                  strokeLinecap="butt"
                  transform={`rotate(-90 ${cx} ${cy})`}
                />
              );
            })
          )}
        </svg>
        <div className={s.donutCenter}>
          <span className={s.donutCenterNum}>{total.toLocaleString()}</span>
          <span className={s.donutCenterLabel}>Total</span>
        </div>
      </div>

      <div className={s.donutLegend}>
        {[
          { key: "published", value: stats.published },
          { key: "scheduled", value: stats.upcoming_scheduled },
          { key: "draft", value: stats.draft },
          { key: "pending", value: stats.pending },
        ].map((item) => (
          <div key={item.key} className={s.donutLegendRow}>
            <span className={s.donutLegendLeft}>
              <span className={s.donutLegendDot} style={{ background: DONUT_COLORS[item.key] }} />
              {DONUT_LABELS[item.key]}
            </span>
            <span className={s.donutLegendCount}>{item.value.toLocaleString()}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Feed item ─────────────────────────────────────────────────────────────────
function FeedRow({ item }: { item: WorkspaceFeedItem }) {
  const href = articleEditorPath(item.project_id, item.article_id);
  const dotCls =
    item.status_tag === "published" ? s.feedStatusPublished
    : item.status_tag === "scheduled" ? s.feedStatusScheduled
    : item.status_tag === "draft" ? s.feedStatusDraft
    : s.feedStatusPending;

  const when = item.status_tag === "scheduled"
    ? fmtScheduleTime(item.sort_at)
    : relativeTime(item.sort_at);

  return (
    <div className={s.feedItem}>
      <span className={`${s.feedStatusDot} ${dotCls}`} />
      <div className={s.feedItemBody}>
        {href ? (
          <Link href={href} className={s.feedItemTitle} title={item.title}>{item.title}</Link>
        ) : (
          <span className={s.feedItemTitle} title={item.title}>{item.title}</span>
        )}
        <div className={s.feedItemMeta}>
          <span className={s.feedItemProject} title={item.project_name}>{item.project_name}</span>
          <span>{when}</span>
        </div>
      </div>
      {href && (
        <Link href={href} className={s.feedItemAction} aria-label="Open article">↗</Link>
      )}
    </div>
  );
}

// ── Project card ──────────────────────────────────────────────────────────────
function ProjectCard({ proj }: { proj: ProjectSummary }) {
  const domain = useMemo(() => {
    try {
      const u = new URL(proj.website_url?.startsWith("http") ? proj.website_url : `https://${proj.website_url || ""}`);
      return u.hostname.replace(/^www\./, "");
    } catch { return proj.website_url || ""; }
  }, [proj.website_url]);

  return (
    <Link href={`/projects/${proj.project_id}`} className={s.projectCard}>
      <div className={s.projectCardTop}>
        <div style={{ minWidth: 0 }}>
          <div className={s.projectCardName} title={proj.name}>{proj.name}</div>
          {domain && <div className={s.projectCardUrl} title={domain}>{domain}</div>}
        </div>
        {proj.platform && (
          <span className={s.projectCardPlatformBadge}>
            {proj.platform === "shopify" ? "Shopify" : "WP"}
          </span>
        )}
      </div>

      <div className={s.projectCardStats}>
        <div className={`${s.projectStat} ${s.projectStatPub}`}>
          <span className={s.projectStatNum}>{proj.published}</span>
          <span className={s.projectStatLabel}>Published</span>
        </div>
        <div className={`${s.projectStat} ${s.projectStatSched}`}>
          <span className={s.projectStatNum}>{proj.upcoming_scheduled}</span>
          <span className={s.projectStatLabel}>Scheduled</span>
        </div>
        <div className={`${s.projectStat} ${s.projectStatPend}`}>
          <span className={s.projectStatNum}>{proj.pending}</span>
          <span className={s.projectStatLabel}>Pending</span>
        </div>
        <div className={`${s.projectStat} ${s.projectStatDraft}`}>
          <span className={s.projectStatNum}>{proj.draft}</span>
          <span className={s.projectStatLabel}>Drafts</span>
        </div>
      </div>

      <div className={s.projectCardFooter}>
        <span className={s.projectCardActivity}>
          Last activity: {relativeTime(proj.last_activity_at)}
        </span>
        <span className={s.projectCardArrow}>→</span>
      </div>
    </Link>
  );
}

// ── Insights ──────────────────────────────────────────────────────────────────
function buildInsights(data: WorkspaceOverviewResponse): string[] {
  const { stats, project_summaries = [] } = data;
  const insights: string[] = [];

  if (stats.pending > 0) {
    insights.push(`${stats.pending} article${stats.pending === 1 ? "" : "s"} awaiting generation or publishing.`);
  }
  if (stats.upcoming_scheduled > 0) {
    insights.push(`${stats.upcoming_scheduled} article${stats.upcoming_scheduled === 1 ? " is" : "s are"} scheduled for upcoming publication.`);
  }
  if (stats.draft > 0) {
    insights.push(`${stats.draft} draft${stats.draft === 1 ? "" : "s"} saved but not yet scheduled.`);
  }

  const mostActive = [...project_summaries].sort((a, b) => b.published - a.published)[0];
  if (mostActive && mostActive.published > 0) {
    insights.push(`Your most active project is ${mostActive.name} with ${mostActive.published} published article${mostActive.published === 1 ? "" : "s"}.`);
  }

  const noSchedule = project_summaries.filter((p) => p.upcoming_scheduled === 0 && p.total_articles > 0);
  if (noSchedule.length > 0) {
    insights.push(`${noSchedule.length} project${noSchedule.length === 1 ? " has" : "s have"} no upcoming scheduled content.`);
  }

  if (stats.total_articles > 0 && stats.published > 0) {
    const publishRate = Math.round((stats.published / stats.total_articles) * 100);
    insights.push(`${publishRate}% of your total content library is published.`);
  }

  if (insights.length === 0) {
    insights.push("Your workspace is set up. Start by creating articles in your projects.");
  }

  return insights;
}

// ── Chart style map ───────────────────────────────────────────────────────────
function buildChartStyles(): Record<string, string> {
  return {
    articlesOverviewChartWrap: s.articlesOverviewChartWrap,
    articlesOverviewChartLegend: s.articlesOverviewChartLegend,
    articlesOverviewChartLegendSwatch: s.articlesOverviewChartLegendSwatch,
    articlesOverviewChartSvg: s.articlesOverviewChartSvg,
    articlesOverviewChartTooltip: s.articlesOverviewChartTooltip,
    articlesOverviewChartTooltipPanel: s.articlesOverviewChartTooltipPanel,
    articlesOverviewChartTooltipHead: s.articlesOverviewChartTooltipHead,
    articlesOverviewChartTooltipDate: s.articlesOverviewChartTooltipDate,
    articlesOverviewChartTooltipCaption: s.articlesOverviewChartTooltipCaption,
    articlesOverviewChartTooltipTable: s.articlesOverviewChartTooltipTable,
    articlesOverviewChartTooltipMetric: s.articlesOverviewChartTooltipMetric,
    articlesOverviewChartTooltipValue: s.articlesOverviewChartTooltipValue,
    articlesOverviewChartTooltipFooter: s.articlesOverviewChartTooltipFooter,
    articlesOverviewChartTooltipFooterLabel: s.articlesOverviewChartTooltipFooterLabel,
    articlesOverviewChartTooltipFooterValue: s.articlesOverviewChartTooltipFooterValue,
    articlesOverviewChartTooltipCaret: s.articlesOverviewChartTooltipCaret,
    articlesOverviewChartTooltipSwatch: s.articlesOverviewChartTooltipSwatch,
    articlesOverviewChartTooltipSwatchPublished: s.articlesOverviewChartTooltipSwatchPublished,
    articlesOverviewChartTooltipSwatchPending: s.articlesOverviewChartTooltipSwatchPending,
    articlesOverviewChartTooltipSwatchScheduled: s.articlesOverviewChartTooltipSwatchScheduled,
    articlesOverviewChartEmpty: s.articlesOverviewChartEmpty,
  };
}

const CHART_STYLES = buildChartStyles();

// ── Skeleton ──────────────────────────────────────────────────────────────────
function DashboardSkeleton() {
  return (
    <div className={s.shell}>
      <div className={s.skeletonRow}>
        {[...Array(6)].map((_, i) => <div key={i} className={s.skeletonCard} />)}
      </div>
      <div className={s.skeletonChartRow}>
        <div className={s.skeletonChartBig} />
        <div className={s.skeletonChartSmall} />
      </div>
      <div className={s.skeletonProjects}>
        {[...Array(4)].map((_, i) => <div key={i} className={s.skeletonProjectCard} />)}
      </div>
    </div>
  );
}

// ── KPI card ──────────────────────────────────────────────────────────────────
function KpiCard({ icon, label, value, hint, accentCls }: {
  icon: string;
  label: string;
  value: number;
  hint: string;
  accentCls: string;
}) {
  return (
    <div className={`${s.kpiCard} ${accentCls}`}>
      <div className={s.kpiIcon}>{icon}</div>
      <div className={s.kpiValue}>{value.toLocaleString()}</div>
      <div className={s.kpiLabel}>{label}</div>
      <div className={s.kpiHint}>{hint}</div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export function ProjectOverviewDashboard({
  onGoProjects,
}: {
  onGoProjects?: () => void;
}) {
  const [data, setData] = useState<WorkspaceOverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (fresh = false) => {
    if (fresh) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const d = await api.workspaceOverview({ fresh, skipGlobalLoading: true });
      setData(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load workspace overview.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { void load(false); }, [load]);

  const chartSeries: WorkspaceActivityDay[] = useMemo(
    () => (data?.activity_series || []).map((p) => ({
      date: p.date, published: p.published, pending: p.pending, scheduled: p.scheduled,
    })),
    [data],
  );

  // Unified activity feed: merge published + pending + draft in one list, sort by sort_at desc
  const activityFeed: WorkspaceFeedItem[] = useMemo(() => {
    if (!data) return [];
    const all = [
      ...(data.recently_published || []),
      ...(data.pending || []),
      ...(data.drafts || []),
    ];
    all.sort((a, b) => {
      const ta = a.sort_at ? Date.parse(a.sort_at) : 0;
      const tb = b.sort_at ? Date.parse(b.sort_at) : 0;
      return tb - ta;
    });
    return all.slice(0, 10);
  }, [data]);

  const insights = useMemo(() => data ? buildInsights(data) : [], [data]);

  if (loading) return <DashboardSkeleton />;

  if (error || !data) {
    return (
      <div className={s.errorState}>
        <p className={s.errorTitle}>Overview unavailable</p>
        <p className={s.errorMsg}>{error || "Unable to load workspace overview."}</p>
        <button
          type="button"
          className={s.refreshBtn}
          onClick={() => void load(true)}
          style={{ margin: "0 auto" }}
        >
          Try again
        </button>
      </div>
    );
  }

  const { stats, project_summaries = [], upcoming_scheduled } = data;

  const hasNoProjects = stats.project_count === 0;
  if (hasNoProjects && onGoProjects) {
    return (
      <div className={s.errorState}>
        <p className={s.errorTitle}>No projects yet</p>
        <p className={s.errorMsg}>Create your first project to see the overview dashboard come to life.</p>
        <button type="button" className={s.refreshBtn} onClick={onGoProjects} style={{ margin: "0 auto" }}>
          Go to Projects
        </button>
      </div>
    );
  }

  return (
    <div className={s.shell}>
      {/* ── Header ── */}
      <div className={s.header}>
        <div className={s.headerLeft}>
          <h1 className={s.title}>Project Overview</h1>
          <p className={s.subtitle}>
            Monitor content operations, publishing activity, and project performance across all workspaces.
          </p>
        </div>
        <div className={s.headerRight}>
          <div className={s.dateChip}>📅 Last 14 days</div>
          <button
            type="button"
            className={s.refreshBtn}
            onClick={() => void load(true)}
            disabled={refreshing}
          >
            {refreshing ? "Refreshing…" : "↻ Refresh"}
          </button>
        </div>
      </div>

      {/* ── KPI Cards ── */}
      <div className={s.kpiRow}>
        <KpiCard icon="📁" label="Active Projects" value={stats.project_count} hint="Connected workspaces" accentCls={s.kpiCardProjects} />
        <KpiCard icon="✅" label="Published" value={stats.published} hint="Live articles" accentCls={s.kpiCardPublished} />
        <KpiCard icon="🗓" label="Scheduled" value={stats.upcoming_scheduled} hint="Upcoming posts" accentCls={s.kpiCardScheduled} />
        <KpiCard icon="📝" label="Drafts" value={stats.draft} hint="Saved, not scheduled" accentCls={s.kpiCardDraft} />
        <KpiCard icon="⏳" label="Pending" value={stats.pending} hint="Awaiting action" accentCls={s.kpiCardPending} />
        <KpiCard icon="📊" label="Total Content" value={stats.total_articles} hint="All articles" accentCls={s.kpiCardTotal} />
      </div>

      {/* ── Charts row: Activity + Distribution ── */}
      <div className={s.chartsRow}>
        <div className={s.chartCard}>
          <div className={s.cardHead}>
            <div>
              <h2 className={s.cardTitle}><span className={s.cardTitleIcon}>📈</span>Workspace Activity</h2>
              <p className={s.cardSub}>Published, pending, and scheduled · last 14 days</p>
            </div>
          </div>
          <ArticlesOverviewChart
            series={chartSeries}
            label="Workspace article activity"
            styles={CHART_STYLES}
          />
        </div>

        <div className={s.donutCard}>
          <div className={s.cardHead}>
            <div>
              <h2 className={s.cardTitle}><span className={s.cardTitleIcon}>🍩</span>Content Distribution</h2>
              <p className={s.cardSub}>Current workload breakdown</p>
            </div>
          </div>
          <DonutChart stats={stats} />
        </div>
      </div>

      {/* ── Project performance cards ── */}
      {project_summaries.length > 0 && (
        <div>
          <div className={s.cardHead} style={{ marginBottom: 12 }}>
            <h2 className={s.cardTitle}><span className={s.cardTitleIcon}>🏆</span>Project Performance</h2>
            <span style={{ fontSize: 11, color: "rgba(160,157,150,0.5)" }}>Sorted by published articles</span>
          </div>
          <div className={s.projectGrid}>
            {project_summaries.map((proj) => (
              <ProjectCard key={proj.project_id} proj={proj} />
            ))}
          </div>
        </div>
      )}

      {/* ── Activity + Schedule feed ── */}
      <div className={s.feedRow}>
        {/* Recent Activity */}
        <div className={s.feedPanel}>
          <div className={s.feedHead}>
            <h2 className={s.feedTitle}><span>⚡</span>Recent Activity</h2>
            <span className={s.feedCount}>{activityFeed.length}</span>
          </div>
          {activityFeed.length === 0 ? (
            <p className={s.feedEmpty}>No recent activity across your projects.</p>
          ) : (
            activityFeed.map((item) => <FeedRow key={`${item.status_tag}-${item.id}`} item={item} />)
          )}
          {stats.total_articles > activityFeed.length && (
            <p className={s.feedMore}>
              +{(stats.total_articles - activityFeed.length).toLocaleString()} more articles across your workspace
            </p>
          )}
        </div>

        {/* Upcoming Schedule */}
        <div className={s.feedPanel}>
          <div className={s.feedHead}>
            <h2 className={s.feedTitle}><span>🗓</span>Upcoming Schedule</h2>
            <span className={s.feedCount}>{upcoming_scheduled.length}</span>
          </div>
          {upcoming_scheduled.length === 0 ? (
            <p className={s.feedEmpty}>
              No articles scheduled. Schedule content to keep your publishing calendar active.
            </p>
          ) : (
            upcoming_scheduled.map((item) => <FeedRow key={`sched-${item.id}`} item={item} />)
          )}
          {stats.upcoming_scheduled > upcoming_scheduled.length && (
            <p className={s.feedMore}>
              +{(stats.upcoming_scheduled - upcoming_scheduled.length).toLocaleString()} more scheduled
            </p>
          )}
        </div>
      </div>

      {/* ── Insights ── */}
      {insights.length > 0 && (
        <div className={s.insightsPanel}>
          <h2 className={s.cardTitle} style={{ margin: 0 }}>
            <span className={s.cardTitleIcon}>💡</span>Workspace Insights
          </h2>
          <div className={s.insightsList}>
            {insights.map((text, i) => (
              <div key={i} className={s.insightItem}>
                <span className={s.insightDot} />
                <span>{text}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
