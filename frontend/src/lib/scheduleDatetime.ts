import { parseDatetimeLocal } from "@/lib/bulkScheduleDates";
import { scheduleMinFromNowMs } from "@/lib/scheduleTiming";

/** Format a Date as `datetime-local` in the user's profile timezone. */
export function toDatetimeLocalInTimeZone(d: Date, timeZone: string): string {
  if (Number.isNaN(d.getTime())) return "";
  const tz = timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(d);
    const get = (type: string) => parts.find((p) => p.type === type)?.value || "";
    const y = get("year");
    const m = get("month");
    const day = get("day");
    const hh = get("hour");
    const mm = get("minute");
    if (!y || !m || !day || !hh || !mm) return "";
    return `${y}-${m}-${day}T${hh}:${mm}`;
  } catch {
    return "";
  }
}

export function buildScheduleMinDatetimeLocal(profileTz: string): string {
  return toDatetimeLocalInTimeZone(scheduleMinFromNowMs(), profileTz);
}

export function formatBulkScheduleWhenDisplay(
  when: string,
  profileTz: string,
): { date: string; time: string; tz: string } {
  const p = parseDatetimeLocal(when);
  if (!p) return { date: (when || "").trim() || "—", time: "", tz: "" };
  const d = new Date(p.y, p.m - 1, p.d);
  const date = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(d);
  const h12 = p.h % 12 || 12;
  const time = `${h12}:${String(p.min).padStart(2, "0")} ${p.h >= 12 ? "PM" : "AM"}`;
  const tz = profileTz || Intl.DateTimeFormat().resolvedOptions().timeZone;
  return { date, time, tz };
}
