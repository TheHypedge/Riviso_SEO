import type { ArticlePublic, GscAnalyticsSeriesPoint, ScheduledJobPublic } from "@/lib/api";

export type ArticlesOverviewRange = 1 | 7 | 28 | 90;

export type ArticlesOverviewStats = {
  publishedInRange: number;
  pending: number;
  draft: number;
  scheduledArticles: number;
  scheduledJobs: number;
  total: number;
  totalPublished: number;
};

export type OverviewInsights = {
  velocityPct: number | null;
  publishedCurrent: number;
  publishedPrev: number;
  bestDayOfWeek: string | null;
  bestDayCount: number;
  contentOpportunity: number;
};

export type OverviewListItem = {
  id: string;
  /** Article id for navigation (scheduled rows use job id as ``id``). */
  articleId: string;
  title: string;
  dateLabel: string;
  sortMs: number;
  status?: string;
  imageUrl?: string | null;
};

function parseMs(raw?: string | null): number {
  if (!raw) return 0;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : 0;
}

export function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export function daysAgoUtc(days: number, from = new Date()): Date {
  const base = startOfUtcDay(from);
  base.setUTCDate(base.getUTCDate() - days);
  return base;
}

export function formatOverviewDate(raw?: string | null): string {
  const ms = parseMs(raw);
  if (!ms) return "—";
  const d = new Date(ms);
  const day = d.getUTCDate();
  const suffix =
    day % 10 === 1 && day !== 11
      ? "st"
      : day % 10 === 2 && day !== 12
        ? "nd"
        : day % 10 === 3 && day !== 13
          ? "rd"
          : "th";
  const month = d.toLocaleString("en-GB", { month: "long", timeZone: "UTC" });
  return `${day}${suffix} ${month} ${d.getUTCFullYear()}`;
}

/** Date + time for tables (user-local timezone). */
export function formatOverviewDateTime(raw?: string | null): { date: string; time: string } {
  const ms = parseMs(raw);
  if (!ms) return { date: "—", time: "" };
  const d = new Date(ms);
  return {
    date: d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }),
    time: d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }),
  };
}

export function computeOverviewStats(
  articles: ArticlePublic[],
  scheduledJobs: ScheduledJobPublic[],
  rangeDays: ArticlesOverviewRange,
): ArticlesOverviewStats {
  const since = daysAgoUtc(rangeDays - 1).getTime();
  let publishedInRange = 0;
  let pending = 0;
  let draft = 0;
  let scheduledArticles = 0;

  for (const a of articles) {
    const st = (a.status || "pending").toLowerCase();
    if (st === "pending") pending += 1;
    if (st === "draft") draft += 1;
    if (st === "scheduled") scheduledArticles += 1;
    if (st === "published") {
      const when = parseMs(a.posted_at || a.updated_at || a.created_at);
      if (when >= since) publishedInRange += 1;
    }
  }

  const now = Date.now();
  const scheduledJobsUpcoming = scheduledJobs.filter((j) => {
    const st = (j.state || "").toLowerCase();
    if (st === "cancelled" || st === "completed" || st === "failed") return false;
    return parseMs(j.run_at) >= now - 86_400_000;
  });

  const totalPublished = articles.filter((a) => (a.status || "").toLowerCase() === "published").length;

  return {
    publishedInRange,
    pending,
    draft,
    scheduledArticles,
    scheduledJobs: scheduledJobsUpcoming.length,
    total: articles.length,
    totalPublished,
  };
}

const DOW_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

export function computeInsights(
  articles: ArticlePublic[],
  rangeDays: ArticlesOverviewRange,
): OverviewInsights {
  const rangeMs = rangeDays * 86_400_000;
  const now = Date.now();
  const currentStart = now - rangeMs;
  const prevStart = now - 2 * rangeMs;

  let publishedCurrent = 0;
  let publishedPrev = 0;
  const dowCounts: Record<number, number> = {};

  for (const a of articles) {
    if ((a.status || "").toLowerCase() !== "published") continue;
    const ms = parseMs(a.posted_at || a.updated_at || a.created_at);
    if (!ms) continue;
    if (ms >= currentStart) publishedCurrent++;
    else if (ms >= prevStart) publishedPrev++;
    const dow = new Date(ms).getUTCDay();
    dowCounts[dow] = (dowCounts[dow] || 0) + 1;
  }

  const velocityPct =
    publishedPrev > 0
      ? Math.round(((publishedCurrent - publishedPrev) / publishedPrev) * 100)
      : publishedCurrent > 0
        ? null
        : null;

  let bestDayOfWeek: string | null = null;
  let bestDayCount = 0;
  for (const [dow, count] of Object.entries(dowCounts)) {
    if (count > bestDayCount) {
      bestDayCount = count;
      bestDayOfWeek = DOW_NAMES[Number(dow)] ?? null;
    }
  }

  const contentOpportunity = articles.filter((a) => (a.status || "").toLowerCase() === "draft").length;

  return { velocityPct, publishedCurrent, publishedPrev, bestDayOfWeek, bestDayCount, contentOpportunity };
}

export type ArticlesOverviewDayPoint = {
  date: string;
  published: number;
  pending: number;
  scheduled: number;
};

/** Per-day grouped bar data: published posts, pending updates, and scheduled runs. */
export function buildArticleActivityBarSeries(
  articles: ArticlePublic[],
  scheduledJobs: ScheduledJobPublic[],
  rangeDays: ArticlesOverviewRange,
): ArticlesOverviewDayPoint[] {
  const end = startOfUtcDay(new Date());
  const start = daysAgoUtc(rangeDays - 1, end);
  const buckets = new Map<string, ArticlesOverviewDayPoint>();

  for (let i = 0; i < rangeDays; i++) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    const key = d.toISOString().slice(0, 10);
    buckets.set(key, { date: key, published: 0, pending: 0, scheduled: 0 });
  }

  const bump = (key: string, field: keyof Omit<ArticlesOverviewDayPoint, "date">) => {
    const row = buckets.get(key);
    if (row) row[field] += 1;
  };

  for (const a of articles) {
    const st = (a.status || "").toLowerCase();
    if (st === "published") {
      const ms = parseMs(a.posted_at || a.updated_at || a.created_at);
      if (!ms) continue;
      const key = new Date(ms).toISOString().slice(0, 10);
      if (buckets.has(key)) bump(key, "published");
    } else if (st === "pending") {
      const ms = parseMs(a.updated_at || a.created_at);
      if (!ms) continue;
      const key = new Date(ms).toISOString().slice(0, 10);
      if (buckets.has(key)) bump(key, "pending");
    } else if (st === "scheduled") {
      const ms = parseMs(a.wp_scheduled_at || a.updated_at || a.created_at);
      if (!ms) continue;
      const key = new Date(ms).toISOString().slice(0, 10);
      if (buckets.has(key)) bump(key, "scheduled");
    }
  }

  for (const j of scheduledJobs) {
    const st = (j.state || "").toLowerCase();
    if (st === "cancelled" || st === "completed" || st === "failed") continue;
    const ms = parseMs(j.run_at);
    if (!ms) continue;
    const key = new Date(ms).toISOString().slice(0, 10);
    if (buckets.has(key)) bump(key, "scheduled");
  }

  return Array.from(buckets.values());
}

export function formatChartAxisDate(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  if (!y || !m || !d) return isoDate;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

export function formatChartTooltipDate(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  if (!y || !m || !d) return isoDate;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function buildPublishActivitySeries(
  articles: ArticlePublic[],
  rangeDays: ArticlesOverviewRange,
): { date: string; count: number }[] {
  const end = startOfUtcDay(new Date());
  const start = daysAgoUtc(rangeDays - 1, end);
  const buckets = new Map<string, number>();

  for (let i = 0; i < rangeDays; i++) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    buckets.set(d.toISOString().slice(0, 10), 0);
  }

  for (const a of articles) {
    if ((a.status || "").toLowerCase() !== "published") continue;
    const ms = parseMs(a.posted_at || a.updated_at || a.created_at);
    if (!ms) continue;
    const key = new Date(ms).toISOString().slice(0, 10);
    if (buckets.has(key)) buckets.set(key, (buckets.get(key) || 0) + 1);
  }

  return Array.from(buckets.entries()).map(([date, count]) => ({ date, count }));
}

export function buildGscActivitySeries(
  series: GscAnalyticsSeriesPoint[],
  rangeDays: ArticlesOverviewRange,
): { date: string; count: number }[] {
  if (!series?.length) return [];
  const trimmed = series.slice(-rangeDays);
  return trimmed.map((p) => ({ date: p.date, count: p.clicks || 0 }));
}

export function recentPublishedItems(articles: ArticlePublic[], limit = 5): OverviewListItem[] {
  return articles
    .filter((a) => (a.status || "").toLowerCase() === "published")
    .map((a) => {
      const raw = a.posted_at || a.updated_at || a.created_at;
      return {
        id: a.id,
        articleId: a.id,
        title: a.title || "(Untitled)",
        dateLabel: formatOverviewDate(raw),
        sortMs: parseMs(raw),
        status: a.status,
        imageUrl: (a.image_url || "").trim() || null,
      };
    })
    .sort((a, b) => b.sortMs - a.sortMs)
    .slice(0, limit);
}

export function pendingItems(articles: ArticlePublic[], limit = 5): OverviewListItem[] {
  return articles
    .filter((a) => (a.status || "").toLowerCase() === "pending")
    .map((a) => {
      const raw = a.updated_at || a.created_at;
      return {
        id: a.id,
        articleId: a.id,
        title: a.title || "(Untitled)",
        dateLabel: formatOverviewDate(raw),
        sortMs: parseMs(raw),
        status: a.status,
      };
    })
    .sort((a, b) => b.sortMs - a.sortMs)
    .slice(0, limit);
}

export function upcomingScheduledItems(
  jobs: ScheduledJobPublic[],
  titleByArticleId: Record<string, string>,
  limit = 5,
): OverviewListItem[] {
  const now = Date.now();
  return jobs
    .filter((j) => {
      const st = (j.state || "").toLowerCase();
      if (st === "cancelled" || st === "completed") return false;
      return parseMs(j.run_at) >= now;
    })
    .map((j) => ({
      id: j.id,
      articleId: j.article_id,
      title: titleByArticleId[j.article_id] || "(Scheduled article)",
      dateLabel: formatOverviewDate(j.run_at),
      sortMs: parseMs(j.run_at),
      status: j.state,
    }))
    .sort((a, b) => a.sortMs - b.sortMs)
    .slice(0, limit);
}

export function cartItems(
  articles: ArticlePublic[],
  selectedIds: string[],
  limit = 5,
): OverviewListItem[] {
  const sel = new Set(selectedIds);
  return articles
    .filter((a) => sel.has(a.id))
    .map((a) => {
      const raw = a.updated_at || a.created_at;
      return {
        id: a.id,
        articleId: a.id,
        title: a.title || "(Untitled)",
        dateLabel: formatOverviewDate(raw),
        sortMs: parseMs(raw),
        status: a.status,
      };
    })
    .sort((a, b) => b.sortMs - a.sortMs)
    .slice(0, limit);
}
