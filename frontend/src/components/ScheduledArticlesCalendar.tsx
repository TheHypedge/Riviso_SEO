"use client";

import { useMemo, useState } from "react";
import type { ScheduledJobPublic } from "@/lib/api";

type CssModule = { [key: string]: string };

const WEEKDAYS = Array.from({ length: 7 }, (_, i) =>
  new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(new Date(2024, 8, 1 + i)), // Sep 1 2024 was a Sunday
);

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function localDayKey(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Which calendar day a UTC-like run_at string falls on, in the given IANA timezone --
 * naive UTC-day bucketing would put late-evening local jobs on the wrong day for
 * anyone west of UTC, exactly the kind of off-by-one a scheduling calendar can't have. */
function dayKeyInTz(utcLike: string | null | undefined, tz: string): string {
  const v = (utcLike || "").trim();
  if (!v) return "";
  const iso = v.includes("T") ? v : v.replace(" ", "T") + "Z";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
    const y = parts.find((p) => p.type === "year")?.value;
    const m = parts.find((p) => p.type === "month")?.value;
    const day = parts.find((p) => p.type === "day")?.value;
    if (y && m && day) return `${y}-${m}-${day}`;
  } catch {
    // fall through to UTC fallback below
  }
  return d.toISOString().slice(0, 10);
}

function timeInTz(utcLike: string | null | undefined, tz: string): string {
  const v = (utcLike || "").trim();
  if (!v) return "";
  const iso = v.includes("T") ? v : v.replace(" ", "T") + "Z";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  try {
    return new Intl.DateTimeFormat(undefined, { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(d);
  } catch {
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
}

function tsInTz(utcLike: string | null | undefined): number {
  const v = (utcLike || "").trim();
  if (!v) return 0;
  const iso = v.includes("T") ? v : v.replace(" ", "T") + "Z";
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

function buildMonthGrid(monthStart: Date): Date[] {
  const year = monthStart.getFullYear();
  const month = monthStart.getMonth();
  const firstWeekday = new Date(year, month, 1).getDay(); // 0 = Sunday
  const gridStart = new Date(year, month, 1 - firstWeekday);
  return Array.from({ length: 42 }, (_, i) => new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i));
}

function blockStatusClass(styles: CssModule, state: string): string {
  const v = (state || "").toLowerCase();
  if (v === "ready_to_post") return styles.scheduledCalendarBlockReady;
  if (v === "posted") return styles.scheduledCalendarBlockPosted;
  if (v === "failed") return styles.scheduledCalendarBlockFailed;
  if (v === "posting" || v === "content_generating" || v === "image_generating") return styles.scheduledCalendarBlockActive;
  if (v === "scheduled") return styles.scheduledCalendarBlockScheduled;
  return styles.scheduledCalendarBlockNeutral;
}

const MAX_VISIBLE_PER_DAY = 3;

export function ScheduledArticlesCalendar({
  jobs,
  profileTz,
  articleTitleFor,
  jobStateLabel,
  onSelectJob,
  styles,
}: {
  jobs: ScheduledJobPublic[];
  profileTz: string | null;
  articleTitleFor: (articleId: string) => string;
  jobStateLabel: (s: string) => string;
  onSelectJob: (job: ScheduledJobPublic) => void;
  styles: CssModule;
}) {
  const tz = profileTz || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = new Date();
  const [monthCursor, setMonthCursor] = useState(() => new Date(today.getFullYear(), today.getMonth(), 1));
  const [expandedDay, setExpandedDay] = useState<string | null>(null);

  const byDay = useMemo(() => {
    const map = new Map<string, ScheduledJobPublic[]>();
    for (const j of jobs) {
      const key = dayKeyInTz(j.run_at, tz);
      if (!key) continue;
      const list = map.get(key) || [];
      list.push(j);
      map.set(key, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => tsInTz(a.run_at) - tsInTz(b.run_at));
    }
    return map;
  }, [jobs, tz]);

  const gridDays = useMemo(() => buildMonthGrid(monthCursor), [monthCursor]);
  const todayKey = localDayKey(today);
  const monthLabel = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(monthCursor);

  return (
    <div className={styles.scheduledCalendarWrap}>
      <div className={styles.scheduledCalendarHeader}>
        <h3 className={styles.scheduledCalendarTitle}>{monthLabel}</h3>
        <div className={styles.scheduledCalendarNav}>
          <button
            type="button"
            className={styles.scheduledCalendarNavBtn}
            aria-label="Previous month"
            onClick={() => setMonthCursor((d) => new Date(d.getFullYear(), d.getMonth() - 1, 1))}
          >
            ‹
          </button>
          <button
            type="button"
            className={styles.btnSecondary}
            onClick={() => setMonthCursor(new Date(today.getFullYear(), today.getMonth(), 1))}
          >
            Today
          </button>
          <button
            type="button"
            className={styles.scheduledCalendarNavBtn}
            aria-label="Next month"
            onClick={() => setMonthCursor((d) => new Date(d.getFullYear(), d.getMonth() + 1, 1))}
          >
            ›
          </button>
        </div>
      </div>

      <div className={styles.scheduledCalendarGrid} role="grid" aria-label={`Scheduled articles for ${monthLabel}`}>
        {WEEKDAYS.map((wd) => (
          <div key={wd} className={styles.scheduledCalendarWeekday}>
            {wd}
          </div>
        ))}
        {gridDays.map((date) => {
          const key = localDayKey(date);
          const isOtherMonth = date.getMonth() !== monthCursor.getMonth();
          const isToday = key === todayKey;
          const dayJobs = byDay.get(key) || [];
          const expanded = expandedDay === key;
          const visibleJobs = expanded ? dayJobs : dayJobs.slice(0, MAX_VISIBLE_PER_DAY);
          const hiddenCount = dayJobs.length - visibleJobs.length;
          return (
            <div
              key={key}
              role="gridcell"
              className={`${styles.scheduledCalendarDay} ${isOtherMonth ? styles.scheduledCalendarDayOtherMonth : ""} ${isToday ? styles.scheduledCalendarDayToday : ""}`}
            >
              <span className={styles.scheduledCalendarDayNum}>{date.getDate()}</span>
              {dayJobs.length > 0 ? (
                <div className={styles.scheduledCalendarBlocks}>
                  {visibleJobs.map((j) => {
                    const title = articleTitleFor(j.article_id);
                    const time = timeInTz(j.run_at, tz);
                    return (
                      <button
                        key={j.id}
                        type="button"
                        className={`${styles.scheduledCalendarBlock} ${blockStatusClass(styles, j.state)}`}
                        title={`${time} · ${title} · ${jobStateLabel(j.state)}`}
                        onClick={() => onSelectJob(j)}
                      >
                        <span className={styles.scheduledCalendarBlockTime}>{time}</span>
                        <span className={styles.scheduledCalendarBlockTitle}>{title}</span>
                      </button>
                    );
                  })}
                  {hiddenCount > 0 ? (
                    <button type="button" className={styles.scheduledCalendarMoreBtn} onClick={() => setExpandedDay(key)}>
                      +{hiddenCount} more
                    </button>
                  ) : expanded && dayJobs.length > MAX_VISIBLE_PER_DAY ? (
                    <button type="button" className={styles.scheduledCalendarMoreBtn} onClick={() => setExpandedDay(null)}>
                      Show less
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
