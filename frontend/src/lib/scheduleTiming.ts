/**
 * Schedule timing rules (aligned with backend).
 * - 7 minutes: typical article prep window before publish
 * - 10 minutes: minimum selectable / API buffer (exactly now+10min is allowed)
 */

export const SCHEDULE_PREP_MINUTES = 7;
export const SCHEDULE_BUFFER_MINUTES = 10;

export function scheduleMinFromNowMs(nowMs = Date.now()): Date {
  const d = new Date(nowMs + SCHEDULE_BUFFER_MINUTES * 60 * 1000);
  d.setSeconds(0, 0);
  d.setMilliseconds(0);
  return d;
}
