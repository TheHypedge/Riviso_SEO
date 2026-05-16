/**
 * Compute per-article schedule times for bulk scheduling (manual / weekly / monthly).
 * Datetime-local strings are wall-clock times in the user's profile timezone.
 */

import { SCHEDULE_BUFFER_MINUTES } from "@/lib/scheduleTiming";

export type BulkScheduleMode = "manual" | "weekly" | "monthly";

export type BulkScheduleRow = { id: string; title: string; when: string };

export type WeekdayIso = 1 | 2 | 3 | 4 | 5 | 6 | 7; // Mon=1 … Sun=7

export const BULK_SCHEDULE_WEEKDAYS: { iso: WeekdayIso; label: string }[] = [
  { iso: 1, label: "Mon" },
  { iso: 2, label: "Tue" },
  { iso: 3, label: "Wed" },
  { iso: 4, label: "Thu" },
  { iso: 5, label: "Fri" },
  { iso: 6, label: "Sat" },
  { iso: 7, label: "Sun" },
];

type LocalParts = { y: number; m: number; d: number; h: number; min: number };

export function parseDatetimeLocal(value: string): LocalParts | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec((value || "").trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const h = Number(m[4]);
  const min = Number(m[5]);
  if (![y, mo, d, h, min].every(Number.isFinite)) return null;
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || min > 59) return null;
  return { y, m: mo, d, h, min };
}

export function formatDatetimeLocal(p: LocalParts): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.y}-${pad(p.m)}-${pad(p.d)}T${pad(p.h)}:${pad(p.min)}`;
}

function wallClockPartsInTimeZone(ms: number, timeZone: string): LocalParts | null {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date(ms));
    const get = (type: string) => parts.find((p) => p.type === type)?.value || "";
    const y = Number(get("year"));
    const mo = Number(get("month"));
    const d = Number(get("day"));
    const h = Number(get("hour"));
    const min = Number(get("minute"));
    if (![y, mo, d, h, min].every(Number.isFinite)) return null;
    return { y, m: mo, d, h, min };
  } catch {
    return null;
  }
}

/** Map a profile-TZ wall-clock datetime-local string to UTC epoch ms. */
export function wallClockToInstantMs(value: string, timeZone: string): number | null {
  const target = parseDatetimeLocal(value);
  if (!target) return null;
  const tz = (timeZone || "UTC").trim() || "UTC";
  const lo = Date.UTC(target.y, target.m - 1, target.d, 0, 0) - 36 * 60 * 60 * 1000;
  const hi = Date.UTC(target.y, target.m - 1, target.d, 23, 59) + 36 * 60 * 60 * 1000;
  for (let ms = lo; ms <= hi; ms += 60 * 1000) {
    const p = wallClockPartsInTimeZone(ms, tz);
    if (
      p &&
      p.y === target.y &&
      p.m === target.m &&
      p.d === target.d &&
      p.h === target.h &&
      p.min === target.min
    ) {
      return ms;
    }
  }
  return null;
}

/** Compare two datetime-local strings in a profile timezone (minute granularity). */
export function compareDatetimeLocalInTz(a: string, b: string, timeZone: string): number {
  const ta = wallClockToInstantMs(a, timeZone);
  const tb = wallClockToInstantMs(b, timeZone);
  if (ta == null || tb == null) return 0;
  return Math.floor(ta / 60_000) - Math.floor(tb / 60_000);
}

export function isScheduleWhenAllowed(when: string, minWhen: string, timeZone: string): boolean {
  if (!parseDatetimeLocal(when) || !parseDatetimeLocal(minWhen)) return false;
  return compareDatetimeLocalInTz(when, minWhen, timeZone) >= 0;
}

function daysInMonth(y: number, m: number): number {
  return new Date(y, m, 0).getDate();
}

function isoWeekday(p: LocalParts): WeekdayIso {
  const dow = new Date(p.y, p.m - 1, p.d).getDay();
  return (dow === 0 ? 7 : dow) as WeekdayIso;
}

function addDays(p: LocalParts, days: number): LocalParts {
  const dt = new Date(p.y, p.m - 1, p.d + days, p.h, p.min, 0, 0);
  return {
    y: dt.getFullYear(),
    m: dt.getMonth() + 1,
    d: dt.getDate(),
    h: p.h,
    min: p.min,
  };
}

function addMinutes(p: LocalParts, minutes: number): LocalParts {
  const dt = new Date(p.y, p.m - 1, p.d, p.h, p.min + minutes, 0, 0);
  return {
    y: dt.getFullYear(),
    m: dt.getMonth() + 1,
    d: dt.getDate(),
    h: dt.getHours(),
    min: dt.getMinutes(),
  };
}

function addMonths(p: LocalParts, months: number): LocalParts {
  const dt = new Date(p.y, p.m - 1 + months, p.d, p.h, p.min, 0, 0);
  return {
    y: dt.getFullYear(),
    m: dt.getMonth() + 1,
    d: Math.min(p.d, daysInMonth(dt.getFullYear(), dt.getMonth() + 1)),
    h: p.h,
    min: p.min,
  };
}

function compareLocal(a: LocalParts, b: LocalParts): number {
  const ta = new Date(a.y, a.m - 1, a.d, a.h, a.min).getTime();
  const tb = new Date(b.y, b.m - 1, b.d, b.h, b.min).getTime();
  return ta - tb;
}

function mondayOfWeekContaining(anchor: LocalParts): LocalParts {
  const iso = isoWeekday(anchor);
  return addDays(anchor, -(iso - 1));
}

function dateOnIsoWeekdayInWeek(
  weekMonday: LocalParts,
  isoDow: WeekdayIso,
  time: Pick<LocalParts, "h" | "min">,
): LocalParts {
  return { ...addDays(weekMonday, isoDow - 1), h: time.h, min: time.min };
}

function effectiveStart(start: LocalParts, min: LocalParts, timeZone: string): LocalParts {
  const startStr = formatDatetimeLocal(start);
  const minStr = formatDatetimeLocal(min);
  if (compareDatetimeLocalInTz(startStr, minStr, timeZone) < 0) return { ...min };
  return start;
}

function bumpForwardUntilMin(p: LocalParts, minWhen: string, timeZone: string): LocalParts {
  const minP = parseDatetimeLocal(minWhen);
  if (!minP) return p;
  let cur = p;
  for (let guard = 0; guard < 800; guard++) {
    if (compareDatetimeLocalInTz(formatDatetimeLocal(cur), minWhen, timeZone) >= 0) return cur;
    cur = addDays(cur, 1);
  }
  return minP;
}

function finalizeScheduleDates(dates: LocalParts[], minWhen: string, timeZone: string): LocalParts[] {
  const minP = parseDatetimeLocal(minWhen);
  if (!minP || !dates.length) return dates;

  const out: LocalParts[] = [];
  for (let i = 0; i < dates.length; i++) {
    let p = bumpForwardUntilMin(dates[i], minWhen, timeZone);
    if (out.length > 0) {
      const prev = out[out.length - 1];
      if (compareLocal(p, prev) <= 0) {
        p = addMinutes(prev, 1);
        p = bumpForwardUntilMin(p, minWhen, timeZone);
      }
    }
    out.push(p);
  }
  return out;
}

function computeWeeklyDates(
  count: number,
  start: LocalParts,
  minWhen: string,
  timeZone: string,
  articlesPerWeek: number,
  weekdays: WeekdayIso[],
): LocalParts[] {
  const apw = Math.max(1, Math.min(7, Math.floor(articlesPerWeek) || 1));
  const days = weekdays.length ? ([...weekdays].sort((a, b) => a - b) as WeekdayIso[]) : [isoWeekday(start)];
  const time = { h: start.h, min: start.min };
  const out: LocalParts[] = [];

  for (let i = 0; i < count; i++) {
    const weekIndex = Math.floor(i / apw);
    const slotInWeek = i % apw;
    const isoDow = days[slotInWeek % days.length];
    const weekMonday = addDays(mondayOfWeekContaining(start), weekIndex * 7);
    let candidate = dateOnIsoWeekdayInWeek(weekMonday, isoDow, time);
    candidate = bumpForwardUntilMin(candidate, minWhen, timeZone);
    out.push(candidate);
  }
  return out;
}

function dayOfMonthForSlot(slot: number, postsPerMonth: number, anchorDay: number, y: number, m: number): number {
  const last = daysInMonth(y, m);
  const ppm = Math.max(1, Math.min(12, Math.floor(postsPerMonth) || 1));
  if (ppm === 1) return Math.min(Math.max(anchorDay, 1), last);
  const k = slot + 1;
  const day = Math.round((k * last) / (ppm + 1));
  return Math.min(Math.max(day, 1), last);
}

function computeMonthlyDates(
  count: number,
  start: LocalParts,
  minWhen: string,
  timeZone: string,
  postsPerMonth: number,
): LocalParts[] {
  const ppm = Math.max(1, Math.min(12, Math.floor(postsPerMonth) || 1));
  const out: LocalParts[] = [];
  for (let i = 0; i < count; i++) {
    const monthIndex = Math.floor(i / ppm);
    const slotInMonth = i % ppm;
    const monthBase = addMonths({ ...start, d: 1 }, monthIndex);
    const d = dayOfMonthForSlot(slotInMonth, ppm, start.d, monthBase.y, monthBase.m);
    let candidate: LocalParts = {
      y: monthBase.y,
      m: monthBase.m,
      d,
      h: start.h,
      min: start.min,
    };
    candidate = bumpForwardUntilMin(candidate, minWhen, timeZone);
    out.push(candidate);
  }
  return out;
}

export function clampScheduleWhens(whens: string[], minWhen: string, timeZone?: string): string[] {
  const tz = timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const minP = parseDatetimeLocal(minWhen);
  if (!minP) return whens;
  const dates = whens.map((w) => parseDatetimeLocal(w) || minP);
  const finalized = finalizeScheduleDates(dates, minWhen, tz);
  return finalized.map(formatDatetimeLocal);
}

export type ApplyBulkScheduleParams = {
  mode: BulkScheduleMode;
  rows: BulkScheduleRow[];
  startWhen: string;
  minWhen: string;
  timeZone?: string;
  articlesPerWeek?: number;
  weekdays?: WeekdayIso[];
  postsPerMonth?: number;
};

export function applyBulkScheduleDates(params: ApplyBulkScheduleParams): BulkScheduleRow[] {
  const { mode, rows, startWhen, minWhen } = params;
  if (!rows.length || mode === "manual") return rows;

  const tz = (params.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC").trim();
  const minP = parseDatetimeLocal(minWhen);
  const startRaw = parseDatetimeLocal(startWhen);
  if (!minP || !startRaw) return rows;

  const start = effectiveStart(startRaw, minP, tz);

  let dates: LocalParts[];
  if (mode === "weekly") {
    const weekdays = (params.weekdays?.length ? params.weekdays : [isoWeekday(start)]) as WeekdayIso[];
    dates = computeWeeklyDates(
      rows.length,
      start,
      minWhen,
      tz,
      params.articlesPerWeek ?? 1,
      weekdays,
    );
  } else {
    dates = computeMonthlyDates(rows.length, start, minWhen, tz, params.postsPerMonth ?? 1);
  }

  dates = finalizeScheduleDates(dates, minWhen, tz);
  const whens = dates.map(formatDatetimeLocal);

  return rows.map((r, i) => ({ ...r, when: whens[i] || minWhen }));
}

export function describeBulkScheduleSummary(params: {
  mode: BulkScheduleMode;
  count: number;
  articlesPerWeek?: number;
  weekdays?: WeekdayIso[];
  postsPerMonth?: number;
  whens?: string[];
}): string {
  const { mode, count } = params;
  if (mode === "manual" || count === 0) return "";
  if (mode === "weekly") {
    const apw = Math.max(1, params.articlesPerWeek ?? 1);
    const weeks = Math.ceil(count / apw);
    const labels =
      params.weekdays?.map((iso) => BULK_SCHEDULE_WEEKDAYS.find((w) => w.iso === iso)?.label).filter(Boolean).join(", ") ||
      "";
    return `${count} article${count === 1 ? "" : "s"} · ${apw}/week${labels ? ` on ${labels}` : ""} · over ${weeks} week${weeks === 1 ? "" : "s"}`;
  }
  const ppm = Math.max(1, params.postsPerMonth ?? 1);
  const months = Math.ceil(count / ppm);
  return `${count} article${count === 1 ? "" : "s"} · ${ppm}/month · over ${months} month${months === 1 ? "" : "s"}`;
}

export function defaultWeekdaysForArticlesPerWeek(
  articlesPerWeek: number,
  startWhen: string,
): WeekdayIso[] {
  const start = parseDatetimeLocal(startWhen);
  if (!start) return [1];
  const startDow = isoWeekday(start);
  const apw = Math.max(1, Math.min(7, articlesPerWeek));
  if (apw === 1) return [startDow];
  if (apw === 2) return [1, 4];
  const out: WeekdayIso[] = [];
  for (let i = 0; i < apw; i++) {
    let d = ((startDow - 1 + i * Math.floor(7 / apw)) % 7) + 1;
    if (d < 1) d = 1;
    out.push(d as WeekdayIso);
  }
  return Array.from(new Set(out)).sort((a, b) => a - b) as WeekdayIso[];
}

export function validateBulkScheduleCadence(params: {
  mode: BulkScheduleMode;
  articlesPerWeek?: number;
  weekdays?: WeekdayIso[];
  postsPerMonth?: number;
}): string | null {
  if (params.mode === "weekly") {
    const apw = Math.max(1, Math.min(7, Math.floor(params.articlesPerWeek ?? 1) || 1));
    const wd = params.weekdays ?? [];
    if (wd.length < apw) {
      return `Select at least ${apw} publish day${apw === 1 ? "" : "s"} for ${apw} article${apw === 1 ? "" : "s"} per week.`;
    }
  }
  if (params.mode === "monthly") {
    const ppm = Math.floor(params.postsPerMonth ?? 1) || 1;
    if (ppm < 1 || ppm > 12) return "Posts per month must be between 1 and 12.";
  }
  return null;
}

export { SCHEDULE_BUFFER_MINUTES };
