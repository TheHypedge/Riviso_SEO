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

/** Sun → Sat display order for the weekly bulk-schedule UI. */
export const BULK_SCHEDULE_WEEKDAYS_SUN_FIRST: { iso: WeekdayIso; label: string }[] = [
  { iso: 7, label: "Sun" },
  { iso: 1, label: "Mon" },
  { iso: 2, label: "Tue" },
  { iso: 3, label: "Wed" },
  { iso: 4, label: "Thu" },
  { iso: 5, label: "Fri" },
  { iso: 6, label: "Sat" },
];

/** Hours added per extra post on the same posting day (afternoon/evening spread). */
const SAME_DAY_SPREAD_HOURS = 2;
const SAME_DAY_EVENING_CAP_H = 21;
const SAME_DAY_EVENING_CAP_MIN = 0;
/** Beyond this many posts on one calendar day, roll to the next week/month instead of 1-minute bumps. */
const MAX_POSTS_PER_CALENDAR_DAY = 2;

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

export function parsePreferredTime(value: string): { h: number; min: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec((value || "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min) || h > 23 || min > 59) return null;
  return { h, min };
}

/** Extract HH:mm from a datetime-local string. */
export function preferredTimeFromDatetimeLocal(when: string): string {
  const p = parseDatetimeLocal(when);
  if (!p) return "09:00";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(p.h)}:${pad(p.min)}`;
}

function timeForSameDaySlot(prefH: number, prefMin: number, sameDayIndex: number): { h: number; min: number } {
  if (sameDayIndex <= 0) return { h: prefH, min: prefMin };
  let h = prefH + sameDayIndex * SAME_DAY_SPREAD_HOURS;
  const min = prefMin;
  if (h > SAME_DAY_EVENING_CAP_H || (h === SAME_DAY_EVENING_CAP_H && min > SAME_DAY_EVENING_CAP_MIN)) {
    return { h: SAME_DAY_EVENING_CAP_H, min: SAME_DAY_EVENING_CAP_MIN };
  }
  return { h, min };
}

/**
 * First selected posting day on or after the schedule minimum, at preferred time (profile TZ).
 */
export function buildWeeklyAnchorDatetime(
  minWhen: string,
  preferredTime: string,
  weekdays: WeekdayIso[],
  timeZone: string,
): string | null {
  const minP = parseDatetimeLocal(minWhen);
  if (!minP) return null;
  const pref = parsePreferredTime(preferredTime) || { h: minP.h, min: minP.min };
  const days = weekdays.length ? ([...weekdays].sort((a, b) => a - b) as WeekdayIso[]) : [isoWeekday(minP)];
  const daySet = new Set<WeekdayIso>(days);

  let cursor: LocalParts = { y: minP.y, m: minP.m, d: minP.d, h: pref.h, min: pref.min };
  for (let guard = 0; guard < 400; guard++) {
    if (daySet.has(isoWeekday(cursor))) {
      const anchorStr = formatDatetimeLocal(cursor);
      if (compareDatetimeLocalInTz(anchorStr, minWhen, timeZone) >= 0) return anchorStr;
    }
    cursor = addDays({ ...cursor, h: pref.h, min: pref.min }, 1);
  }
  return formatDatetimeLocal({ ...minP, h: pref.h, min: pref.min });
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

function compareLocalPartsToTarget(p: LocalParts | null, target: LocalParts): number {
  if (!p) return -2;
  if (p.y !== target.y) return p.y - target.y;
  if (p.m !== target.m) return p.m - target.m;
  if (p.d !== target.d) return p.d - target.d;
  if (p.h !== target.h) return p.h - target.h;
  return p.min - target.min;
}

/** Map a profile-TZ wall-clock datetime-local string to UTC epoch ms (binary search, ~log n). */
export function wallClockToInstantMs(value: string, timeZone: string): number | null {
  const target = parseDatetimeLocal(value);
  if (!target) return null;
  const tz = (timeZone || "UTC").trim() || "UTC";

  let lo = Date.UTC(target.y, target.m - 1, target.d - 1, 0, 0, 0, 0);
  let hi = Date.UTC(target.y, target.m - 1, target.d + 2, 0, 0, 0, 0);

  while (hi - lo > 60_000) {
    const mid = lo + Math.floor((hi - lo) / (2 * 60_000)) * 60_000;
    const p = wallClockPartsInTimeZone(mid, tz);
    const c = compareLocalPartsToTarget(p, target);
    if (c === 0) return mid;
    if (c < 0) lo = mid + 60_000;
    else hi = mid - 60_000;
  }

  for (let ms = lo; ms <= hi; ms += 60_000) {
    const p = wallClockPartsInTimeZone(ms, tz);
    if (compareLocalPartsToTarget(p, target) === 0) return ms;
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

function compareLocalInTz(a: LocalParts, b: LocalParts, timeZone: string): number {
  const sa = formatDatetimeLocal(a);
  const sb = formatDatetimeLocal(b);
  const ta = wallClockToInstantMs(sa, timeZone);
  const tb = wallClockToInstantMs(sb, timeZone);
  if (ta == null || tb == null) return 0;
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

/** Advance month-by-month (same day-of-month when possible) until >= minWhen. */
function bumpForwardUntilMinPreservingMonth(
  p: LocalParts,
  minWhen: string,
  timeZone: string,
  minInstantMs?: number | null,
): LocalParts {
  const minP = parseDatetimeLocal(minWhen);
  if (!minP) return p;
  const minMs = minInstantMs ?? wallClockToInstantMs(minWhen, timeZone);
  if (minMs == null) return p;

  let cur = p;
  for (let guard = 0; guard < 36; guard++) {
    const curMs = wallClockToInstantMs(formatDatetimeLocal(cur), timeZone);
    if (curMs != null && curMs >= minMs) return cur;
    cur = addMonths(cur, 1);
  }
  return minP;
}

/** Advance to the same weekday at preferred time until the instant is >= minWhen. */
function bumpForwardUntilMinPreservingWeekday(
  p: LocalParts,
  minWhen: string,
  timeZone: string,
  minInstantMs?: number | null,
): LocalParts {
  const minP = parseDatetimeLocal(minWhen);
  if (!minP) return p;
  const minMs = minInstantMs ?? wallClockToInstantMs(minWhen, timeZone);
  if (minMs == null) return p;

  let cur = p;
  for (let guard = 0; guard < 104; guard++) {
    const curMs = wallClockToInstantMs(formatDatetimeLocal(cur), timeZone);
    if (curMs != null && curMs >= minMs) return cur;
    cur = addDays(cur, 7);
  }
  return minP;
}

function finalizeScheduleDates(
  dates: LocalParts[],
  minWhen: string,
  timeZone: string,
  mode: BulkScheduleMode = "manual",
): LocalParts[] {
  if (!dates.length) return dates;
  const minMs = wallClockToInstantMs(minWhen, timeZone);
  if (mode === "weekly") {
    return dates.map((p) => bumpForwardUntilMinPreservingWeekday(p, minWhen, timeZone, minMs));
  }
  if (mode === "monthly") {
    return dates.map((p) => bumpForwardUntilMinPreservingMonth(p, minWhen, timeZone, minMs));
  }
  if (minMs == null) return dates;
  const out: LocalParts[] = [];
  for (let i = 0; i < dates.length; i++) {
    let p = dates[i];
    if (out.length > 0) {
      const prev = out[out.length - 1];
      if (compareLocalInTz(p, prev, timeZone) <= 0) {
        p = addMinutes(prev, SAME_DAY_SPREAD_HOURS * 60);
      }
    }
    out.push(bumpForwardUntilMinPreservingWeekday(p, minWhen, timeZone, minMs));
  }
  return out;
}

function computeWeeklyDates(
  count: number,
  anchor: LocalParts,
  minWhen: string,
  timeZone: string,
  articlesPerWeek: number,
  weekdays: WeekdayIso[],
  preferredTime: string,
  minInstantMs?: number | null,
): LocalParts[] {
  const apw = Math.max(1, Math.min(count, Math.floor(articlesPerWeek) || 1));
  const days = weekdays.length ? ([...weekdays].sort((a, b) => a - b) as WeekdayIso[]) : [isoWeekday(anchor)];
  const pref = parsePreferredTime(preferredTime) || { h: anchor.h, min: anchor.min };
  const minMs = minInstantMs ?? wallClockToInstantMs(minWhen, timeZone);
  const sameDayCount = new Map<string, number>();
  const anchorMonday = mondayOfWeekContaining(anchor);
  const out: LocalParts[] = [];

  for (let i = 0; i < count; i++) {
    const slotInWeek = i % apw;
    const daySlot = slotInWeek % days.length;
    const repeatCycle = Math.floor(slotInWeek / days.length);
    let weekIndex = Math.floor(i / apw) + repeatCycle;
    const isoDow = days[daySlot];
    let key = `${weekIndex}-${isoDow}`;
    let sameDayIndex = sameDayCount.get(key) ?? 0;
    while (sameDayIndex >= MAX_POSTS_PER_CALENDAR_DAY) {
      weekIndex += 1;
      key = `${weekIndex}-${isoDow}`;
      sameDayIndex = sameDayCount.get(key) ?? 0;
    }
    sameDayCount.set(key, sameDayIndex + 1);
    const t = timeForSameDaySlot(pref.h, pref.min, sameDayIndex);
    const weekMonday = addDays(anchorMonday, weekIndex * 7);
    let candidate = dateOnIsoWeekdayInWeek(weekMonday, isoDow, t);
    candidate = bumpForwardUntilMinPreservingWeekday(candidate, minWhen, timeZone, minMs);
    out.push(candidate);
  }
  return dedupeScheduleDatesPreservingWeekday(out, minWhen, timeZone);
}

function dedupeScheduleDatesPreservingWeekday(
  dates: LocalParts[],
  minWhen: string,
  timeZone: string,
): LocalParts[] {
  const seen = new Set<string>();
  const minMs = wallClockToInstantMs(minWhen, timeZone);
  return dates.map((p) => {
    let cur = bumpForwardUntilMinPreservingWeekday(p, minWhen, timeZone, minMs);
    let key = formatDatetimeLocal(cur);
    while (seen.has(key)) {
      cur = addDays(cur, 7);
      key = formatDatetimeLocal(cur);
    }
    seen.add(key);
    return cur;
  });
}

function dedupeScheduleDatesPreservingMonth(
  dates: LocalParts[],
  minWhen: string,
  timeZone: string,
): LocalParts[] {
  const seen = new Set<string>();
  const minMs = wallClockToInstantMs(minWhen, timeZone);
  return dates.map((p) => {
    let cur = bumpForwardUntilMinPreservingMonth(p, minWhen, timeZone, minMs);
    let key = formatDatetimeLocal(cur);
    while (seen.has(key)) {
      cur = addMonths(cur, 1);
      key = formatDatetimeLocal(cur);
    }
    seen.add(key);
    return cur;
  });
}

function firstOfMonth(p: LocalParts): LocalParts {
  return { y: p.y, m: p.m, d: 1, h: p.h, min: p.min };
}

/** Nth occurrence (0-based) of iso weekday on or after `notBeforeDay` in the calendar month. */
function nthIsoWeekdayInMonth(
  y: number,
  m: number,
  isoDow: WeekdayIso,
  n: number,
  notBeforeDay = 1,
): number | null {
  const last = daysInMonth(y, m);
  let count = 0;
  for (let d = Math.max(1, notBeforeDay); d <= last; d++) {
    if (isoWeekday({ y, m, d, h: 0, min: 0 }) === isoDow) {
      if (count === n) return d;
      count++;
    }
  }
  return null;
}

function lastIsoWeekdayInMonth(
  y: number,
  m: number,
  isoDow: WeekdayIso,
  notBeforeDay = 1,
): number {
  const last = daysInMonth(y, m);
  for (let d = last; d >= Math.max(1, notBeforeDay); d--) {
    if (isoWeekday({ y, m, d, h: 0, min: 0 }) === isoDow) return d;
  }
  return Math.max(1, notBeforeDay);
}

function computeMonthlyDates(
  count: number,
  anchor: LocalParts,
  minWhen: string,
  timeZone: string,
  articlesPerMonth: number,
  weekdays: WeekdayIso[],
  preferredTime: string,
  minInstantMs?: number | null,
): LocalParts[] {
  const apm = Math.max(1, Math.min(count, Math.floor(articlesPerMonth) || 1));
  const days = weekdays.length ? ([...weekdays].sort((a, b) => a - b) as WeekdayIso[]) : [isoWeekday(anchor)];
  const pref = parsePreferredTime(preferredTime) || { h: anchor.h, min: anchor.min };
  const minMs = minInstantMs ?? wallClockToInstantMs(minWhen, timeZone);
  const sameDayCount = new Map<string, number>();
  const out: LocalParts[] = [];

  for (let i = 0; i < count; i++) {
    const slotInMonth = i % apm;
    const daySlot = slotInMonth % days.length;
    const repeatCycle = Math.floor(slotInMonth / days.length);
    let monthIndex = Math.floor(i / apm) + repeatCycle;
    const isoDow = days[daySlot];
    let key = `${monthIndex}-${isoDow}`;
    let sameDayIndex = sameDayCount.get(key) ?? 0;
    while (sameDayIndex >= MAX_POSTS_PER_CALENDAR_DAY) {
      monthIndex += 1;
      key = `${monthIndex}-${isoDow}`;
      sameDayIndex = sameDayCount.get(key) ?? 0;
    }
    sameDayCount.set(key, sameDayIndex + 1);

    const monthBase = addMonths(firstOfMonth(anchor), monthIndex);
    const sameMonthAsAnchor = monthBase.y === anchor.y && monthBase.m === anchor.m;
    const notBefore = monthIndex === 0 && sameMonthAsAnchor ? anchor.d : 1;

    let d =
      nthIsoWeekdayInMonth(monthBase.y, monthBase.m, isoDow, sameDayIndex, notBefore) ??
      lastIsoWeekdayInMonth(monthBase.y, monthBase.m, isoDow, notBefore);

    const t = timeForSameDaySlot(pref.h, pref.min, sameDayIndex);
    let candidate: LocalParts = {
      y: monthBase.y,
      m: monthBase.m,
      d,
      h: t.h,
      min: t.min,
    };
    while (true) {
      const candMs = wallClockToInstantMs(formatDatetimeLocal(candidate), timeZone);
      if (candMs == null || minMs == null || candMs >= minMs) break;
      monthIndex += 1;
      const monthBase = addMonths(firstOfMonth(anchor), monthIndex);
      const sameMonthAsAnchor = monthBase.y === anchor.y && monthBase.m === anchor.m;
      const notBefore = monthIndex === 0 && sameMonthAsAnchor ? anchor.d : 1;
      d =
        nthIsoWeekdayInMonth(monthBase.y, monthBase.m, isoDow, sameDayIndex, notBefore) ??
        lastIsoWeekdayInMonth(monthBase.y, monthBase.m, isoDow, notBefore);
      candidate = { y: monthBase.y, m: monthBase.m, d, h: t.h, min: t.min };
    }
    out.push(candidate);
  }
  return dedupeScheduleDatesPreservingMonth(out, minWhen, timeZone);
}

export function clampScheduleWhens(
  whens: string[],
  minWhen: string,
  timeZone?: string,
  mode: BulkScheduleMode = "manual",
): string[] {
  const tz = timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const minP = parseDatetimeLocal(minWhen);
  if (!minP) return whens;
  const dates = whens.map((w) => parseDatetimeLocal(w) || minP);
  const finalized = finalizeScheduleDates(dates, minWhen, tz, mode);
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
  /** HH:mm — weekly/monthly modes use this instead of startWhen's clock time. */
  preferredTime?: string;
};

export function applyBulkScheduleDates(params: ApplyBulkScheduleParams): BulkScheduleRow[] {
  const { mode, rows, startWhen, minWhen } = params;
  if (!rows.length || mode === "manual") return rows;

  const tz = (params.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC").trim();
  const minP = parseDatetimeLocal(minWhen);
  if (!minP) return rows;

  const minMs = wallClockToInstantMs(minWhen, tz);

  let dates: LocalParts[];
  if (mode === "weekly") {
    const weekdays = (params.weekdays?.length ? params.weekdays : [isoWeekday(minP)]) as WeekdayIso[];
    const pref =
      (params.preferredTime || "").trim() || preferredTimeFromDatetimeLocal(minWhen);
    const prefParts = parsePreferredTime(pref) || { h: minP.h, min: minP.min };
    const anchorWhen =
      buildWeeklyAnchorDatetime(minWhen, pref, weekdays, tz) ||
      formatDatetimeLocal({ ...minP, ...prefParts });
    const anchorRaw = parseDatetimeLocal(anchorWhen);
    if (!anchorRaw) return rows;
    const anchor = effectiveStart(anchorRaw, minP, tz);
    dates = computeWeeklyDates(
      rows.length,
      anchor,
      minWhen,
      tz,
      params.articlesPerWeek ?? 1,
      weekdays,
      pref,
      minMs,
    );
  } else if (mode === "monthly") {
    const weekdays = (params.weekdays?.length ? params.weekdays : [isoWeekday(minP)]) as WeekdayIso[];
    const pref =
      (params.preferredTime || "").trim() || preferredTimeFromDatetimeLocal(minWhen);
    const prefParts = parsePreferredTime(pref) || { h: minP.h, min: minP.min };
    const anchorWhen =
      buildWeeklyAnchorDatetime(minWhen, pref, weekdays, tz) ||
      formatDatetimeLocal({ ...minP, ...prefParts });
    const anchorRaw = parseDatetimeLocal(anchorWhen);
    if (!anchorRaw) return rows;
    const anchor = effectiveStart(anchorRaw, minP, tz);
    dates = computeMonthlyDates(
      rows.length,
      anchor,
      minWhen,
      tz,
      params.postsPerMonth ?? 1,
      weekdays,
      pref,
      minMs,
    );
  } else {
    return rows;
  }

  dates = finalizeScheduleDates(dates, minWhen, tz, mode);
  const whens = dates.map(formatDatetimeLocal);

  return rows.map((r, i) => ({ ...r, when: whens[i] || minWhen }));
}

/** True when cadence times are squeezed into sub-day gaps (usually wrong articles-per-week). */
export function bulkScheduleTimesLookCompressed(whens: string[], mode: BulkScheduleMode, timeZone: string): boolean {
  if (mode === "manual" || whens.length < 2) return false;
  const tz = (timeZone || "UTC").trim();
  const ms = whens
    .map((w) => wallClockToInstantMs(w, tz))
    .filter((x): x is number => x != null)
    .sort((a, b) => a - b);
  if (ms.length < 2) return false;
  const minGapMs = Math.min(...ms.slice(1).map((t, i) => t - ms[i]));
  if (mode === "weekly") return minGapMs < 12 * 60 * 60 * 1000;
  if (mode === "monthly") return minGapMs < 5 * 24 * 60 * 60 * 1000;
  return false;
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
  const apm = Math.max(1, params.postsPerMonth ?? 1);
  const months = Math.ceil(count / apm);
  const labels =
    params.weekdays?.map((iso) => BULK_SCHEDULE_WEEKDAYS.find((w) => w.iso === iso)?.label).filter(Boolean).join(", ") ||
    "";
  return `${count} article${count === 1 ? "" : "s"} · ${apm}/month${labels ? ` on ${labels}` : ""} · over ${months} month${months === 1 ? "" : "s"}`;
}

/** Default posting days when opening bulk schedule: weekday of the schedule minimum. */
export function defaultPostingDaysFromMin(minWhen: string): WeekdayIso[] {
  const start = parseDatetimeLocal(minWhen);
  if (!start) return [1];
  return [isoWeekday(start)];
}

export function validateBulkScheduleCadence(params: {
  mode: BulkScheduleMode;
  articleCount?: number;
  articlesPerWeek?: number;
  weekdays?: WeekdayIso[];
  postsPerMonth?: number;
  whens?: string[];
  timeZone?: string;
}): string | null {
  if (params.mode === "weekly") {
    const count = Math.max(0, params.articleCount ?? 0);
    const wd = params.weekdays ?? [];
    if (!wd.length) return "Select at least one posting day.";
    const apw = Math.floor(params.articlesPerWeek ?? 1) || 1;
    if (apw < 1 || (count > 0 && apw > count)) {
      return count > 0
        ? `Articles per week must be between 1 and ${count}.`
        : "Articles per week must be at least 1.";
    }
    if (count > 1 && apw > 1 && wd.length === 1 && apw >= count) {
      return (
        "For one posting day, use Articles per week = 1 to spread posts across multiple weeks. " +
        "Higher values schedule multiple posts on the same day."
      );
    }
    if (params.whens?.length && params.timeZone && bulkScheduleTimesLookCompressed(params.whens, "weekly", params.timeZone)) {
      return "Weekly times are too close together. Set Articles per week to 1 or add more posting days.";
    }
  }
  if (params.mode === "monthly") {
    const count = Math.max(0, params.articleCount ?? 0);
    const wd = params.weekdays ?? [];
    if (!wd.length) return "Select at least one posting day.";
    const apm = Math.floor(params.postsPerMonth ?? 1) || 1;
    if (apm < 1 || (count > 0 && apm > count)) {
      return count > 0
        ? `Total monthly articles must be between 1 and ${count}.`
        : "Total monthly articles must be at least 1.";
    }
    if (count > 1 && apm > 1 && wd.length === 1 && apm >= count) {
      return (
        "For one posting day, use Total monthly articles = 1 to spread posts across multiple months. " +
        "Higher values schedule multiple posts in the same month."
      );
    }
    if (params.whens?.length && params.timeZone && bulkScheduleTimesLookCompressed(params.whens, "monthly", params.timeZone)) {
      return "Monthly times are too close together. Set Total monthly articles to 1 or add more posting days.";
    }
  }
  return null;
}

export { SCHEDULE_BUFFER_MINUTES };
