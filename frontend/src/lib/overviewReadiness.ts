import type { ArticlePublic, ScheduledJobPublic, WorkspaceOverviewResponse } from "@/lib/api";

import {
  buildArticleActivityBarSeries,
  type ArticlesOverviewDayPoint,
  type ArticlesOverviewRange,
} from "@/lib/articlesOverview";

/** Minimum articles before workspace/project overview metrics are shown. */
export const OVERVIEW_MIN_ARTICLES = 5;

/** Minimum articles for a single project before overview unlocks. */
export const OVERVIEW_MIN_ARTICLES_PROJECT = 3;

/** Days with any activity needed before trend charts are considered meaningful. */
export const OVERVIEW_MIN_ACTIVE_DAYS = 3;

/** Calendar span (days) we recommend before day-over-day trends are reliable. */
export const OVERVIEW_RECOMMENDED_TRACKING_DAYS = 7;

export type OverviewChecklistItem = {
  id: string;
  label: string;
  done: boolean;
  detail?: string;
};

export type OverviewReadinessResult = {
  isReady: boolean;
  progressPercent: number;
  headline: string;
  body: string;
  checklist: OverviewChecklistItem[];
  activeDays: number;
  totalArticles: number;
};

export function countActiveDaysInSeries(series: ArticlesOverviewDayPoint[]): number {
  return series.filter((p) => p.published + p.pending + p.scheduled > 0).length;
}

function parseMs(raw?: string | null): number {
  if (!raw) return 0;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : 0;
}

function daysSinceMs(ms: number): number {
  if (!ms) return 0;
  return Math.floor((Date.now() - ms) / 86_400_000);
}

function earliestArticleMs(articles: ArticlePublic[]): number {
  let min = 0;
  for (const a of articles) {
    const ms = parseMs(a.created_at || a.updated_at);
    if (!ms) continue;
    if (!min || ms < min) min = ms;
  }
  return min;
}

function buildChecklist(
  items: Array<{ id: string; label: string; done: boolean; detail?: string }>,
): OverviewChecklistItem[] {
  return items.map((item) => ({
    id: item.id,
    label: item.label,
    done: item.done,
    detail: item.detail,
  }));
}

function finalizeReadiness(
  checklist: OverviewChecklistItem[],
  headline: string,
  body: string,
  totalArticles: number,
  activeDays: number,
): OverviewReadinessResult {
  const doneCount = checklist.filter((c) => c.done).length;
  const progressPercent =
    checklist.length === 0 ? 0 : Math.round((doneCount / checklist.length) * 100);
  const isReady = checklist.length > 0 && checklist.every((c) => c.done);

  return {
    isReady,
    progressPercent,
    headline,
    body,
    checklist,
    activeDays,
    totalArticles,
  };
}

export function evaluateProjectOverviewReadiness(
  articles: ArticlePublic[],
  scheduledJobs: ScheduledJobPublic[],
  chartRange: ArticlesOverviewRange = 28,
): OverviewReadinessResult {
  const totalArticles = articles.length;
  const series = buildArticleActivityBarSeries(articles, scheduledJobs, chartRange);
  const activeDays = countActiveDaysInSeries(series);

  const published = articles.filter((a) => (a.status || "").toLowerCase() === "published").length;
  const pending = articles.filter((a) => (a.status || "").toLowerCase() === "pending").length;
  const scheduledArticles = articles.filter((a) => (a.status || "").toLowerCase() === "scheduled").length;
  const upcomingJobs = scheduledJobs.filter((j) => {
    const st = (j.state || "").toLowerCase();
    return st !== "cancelled" && st !== "completed" && st !== "failed";
  }).length;

  const hasArticles = totalArticles >= OVERVIEW_MIN_ARTICLES_PROJECT;
  const hasPipeline =
    published >= 1 || pending >= 1 || scheduledArticles >= 1 || upcomingJobs >= 1;
  const hasTrendData =
    activeDays >= OVERVIEW_MIN_ACTIVE_DAYS ||
    totalArticles >= OVERVIEW_MIN_ARTICLES * 2 ||
    daysSinceMs(earliestArticleMs(articles)) >= OVERVIEW_RECOMMENDED_TRACKING_DAYS;

  const checklist = buildChecklist([
    {
      id: "articles",
      label: `Add at least ${OVERVIEW_MIN_ARTICLES_PROJECT} articles to this project`,
      done: hasArticles,
      detail: hasArticles
        ? `${totalArticles.toLocaleString()} articles in this project`
        : `${totalArticles.toLocaleString()} of ${OVERVIEW_MIN_ARTICLES_PROJECT} added`,
    },
    {
      id: "pipeline",
      label: "Publish, schedule, or queue at least one article",
      done: hasPipeline,
      detail: hasPipeline
        ? "Pipeline activity detected"
        : "Generate content and move articles out of draft-only state",
    },
    {
      id: "trends",
      label: `Build ${OVERVIEW_MIN_ACTIVE_DAYS} days of activity or ${OVERVIEW_RECOMMENDED_TRACKING_DAYS} days of history`,
      done: hasTrendData,
      detail: hasTrendData
        ? `${activeDays} active day${activeDays === 1 ? "" : "s"} in the selected range`
        : `${activeDays} of ${OVERVIEW_MIN_ACTIVE_DAYS} active days · charts need a little more history`,
    },
  ]);

  const headline = hasArticles
    ? "Overview metrics unlock as your project collects activity"
    : "Your project overview will appear here soon";

  const body = hasArticles
    ? `Trend charts and pipeline snapshots need enough articles and day-over-day activity. Once you have activity on ${OVERVIEW_MIN_ACTIVE_DAYS} separate days (or ${OVERVIEW_RECOMMENDED_TRACKING_DAYS}+ days since your first article), this dashboard will show full metrics.`
    : `Create a few articles, publish or schedule them, then check back. We recommend at least ${OVERVIEW_MIN_ARTICLES_PROJECT} articles before reading trends.`;

  return finalizeReadiness(checklist, headline, body, totalArticles, activeDays);
}

export function evaluateWorkspaceOverviewReadiness(
  data: WorkspaceOverviewResponse,
): OverviewReadinessResult {
  const { stats } = data;
  const series = (data.activity_series || []).map((p) => ({
    date: p.date,
    published: p.published,
    pending: p.pending,
    scheduled: p.scheduled,
  }));
  const activeDays = countActiveDaysInSeries(series);
  const totalArticles = stats.total_articles;

  const hasProjects = stats.project_count >= 1;
  const hasArticles = totalArticles >= OVERVIEW_MIN_ARTICLES;
  const hasPipeline =
    stats.published >= 1 ||
    stats.pending >= 1 ||
    stats.upcoming_scheduled >= 1 ||
    stats.draft >= 1;
  const hasTrendData =
    activeDays >= OVERVIEW_MIN_ACTIVE_DAYS ||
    totalArticles >= OVERVIEW_MIN_ARTICLES * 3 ||
    series.length >= OVERVIEW_RECOMMENDED_TRACKING_DAYS;

  const checklist = buildChecklist([
    {
      id: "projects",
      label: "Create at least one project",
      done: hasProjects,
      detail: hasProjects
        ? `${stats.project_count.toLocaleString()} project${stats.project_count === 1 ? "" : "s"}`
        : "Add a site from Project management",
    },
    {
      id: "articles",
      label: `Reach ${OVERVIEW_MIN_ARTICLES}+ articles across your workspace`,
      done: hasArticles,
      detail: hasArticles
        ? `${totalArticles.toLocaleString()} articles total`
        : `${totalArticles.toLocaleString()} of ${OVERVIEW_MIN_ARTICLES}`,
    },
    {
      id: "pipeline",
      label: "Publish, schedule, or queue content in at least one project",
      done: hasPipeline && hasArticles,
      detail:
        hasPipeline && hasArticles
          ? "Workspace pipeline has live or queued work"
          : "Move articles beyond empty drafts-only states",
    },
    {
      id: "trends",
      label: `Activity on ${OVERVIEW_MIN_ACTIVE_DAYS}+ days in the last 14-day window`,
      done: hasTrendData && hasArticles,
      detail: hasTrendData
        ? `${activeDays} active day${activeDays === 1 ? "" : "s"} in the last 14 days`
        : `${activeDays} of ${OVERVIEW_MIN_ACTIVE_DAYS} active days · keep publishing on separate days`,
    },
  ]);

  const headline = !hasProjects
    ? "Create a project to start your workspace overview"
    : hasArticles
      ? "Workspace overview metrics unlock as activity builds"
      : "Your cross-project overview will appear here soon";

  const body = !hasProjects
    ? "Add your first project, create articles, and publish or schedule them. Full charts and pipeline tables appear once the workspace has enough history."
    : `We show trends after you have at least ${OVERVIEW_MIN_ARTICLES} articles and activity on ${OVERVIEW_MIN_ACTIVE_DAYS} separate days within the last 14 days (or a week of steady publishing). Until then, use Project management and each project’s Articles tab to grow your pipeline.`;

  return finalizeReadiness(checklist, headline, body, totalArticles, activeDays);
}
