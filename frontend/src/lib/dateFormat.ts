/**
 * Shared server-timestamp parsing/formatting.
 *
 * Backend timestamps arrive in a few different shapes, but all of them mean UTC:
 *   - "YYYY-MM-DD"                                date only
 *   - "YYYY-MM-DD HH:MM:SS"                        naive, space-separated (storage.py's _now_iso_seconds())
 *   - "YYYY-MM-DDTHH:MM:SS[.ffffff][Z|+HH:MM]"     full ISO, with or without an explicit offset
 *
 * A string with no explicit offset (no trailing Z / +HH:MM) is always treated as UTC,
 * matching how the backend actually generates it (datetime.utcnow()). Naively appending
 * "T00:00:00Z" to a string that already has a time component (the old per-component bug)
 * corrupts it into something Date.parse can't read, which is what produced the literal
 * "Invalid Date" text in the UI.
 */

const HAS_TZ_OFFSET = /(Z|[+-]\d{2}:?\d{2})$/;

export function parseServerTimestamp(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;

  let iso = trimmed.includes("T") ? trimmed : trimmed.replace(" ", "T");
  if (!iso.includes("T")) {
    iso = `${iso}T00:00:00`;
  }
  if (!HAS_TZ_OFFSET.test(iso)) {
    iso = `${iso}Z`;
  }

  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

const DATE_ONLY_FMT: Intl.DateTimeFormatOptions = { day: "2-digit", month: "short", year: "numeric" };
const TIME_ONLY_FMT: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", hour12: true };

/** "24 Jul 2026" */
export function formatDateOnly(raw: string | null | undefined, fallback = "No date"): string {
  const d = parseServerTimestamp(raw);
  if (!d) return fallback;
  return d.toLocaleDateString("en-GB", DATE_ONLY_FMT);
}

/** "24 Jul 2026 • 10:45 AM" */
export function formatDateTime(raw: string | null | undefined, fallback = "No date"): string {
  const d = parseServerTimestamp(raw);
  if (!d) return fallback;
  const datePart = d.toLocaleDateString("en-GB", DATE_ONLY_FMT);
  const timePart = d.toLocaleTimeString("en-US", TIME_ONLY_FMT);
  return `${datePart} • ${timePart}`;
}
