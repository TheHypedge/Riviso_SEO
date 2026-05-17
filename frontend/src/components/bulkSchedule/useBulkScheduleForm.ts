"use client";

import { useCallback, useDeferredValue, useEffect, useMemo, useState, startTransition } from "react";
import {
  applyBulkScheduleDates,
  BULK_SCHEDULE_WEEKDAYS_SUN_FIRST,
  defaultPostingDaysFromMin,
  describeBulkScheduleSummary,
  preferredTimeFromDatetimeLocal,
  validateBulkScheduleCadence,
  isScheduleWhenAllowed,
  type BulkScheduleMode,
  type BulkScheduleRow,
  type WeekdayIso,
} from "@/lib/bulkScheduleDates";
import { buildScheduleMinDatetimeLocal, formatBulkScheduleWhenDisplay } from "@/lib/scheduleDatetime";
import { SCHEDULE_BUFFER_MINUTES, SCHEDULE_PREP_MINUTES } from "@/lib/scheduleTiming";
import type { PromptListResponse } from "@/lib/api";
import type { WordpressPostType } from "@/lib/api";

export type BulkScheduleSeedRow = { id: string; title: string };

export type BulkScheduleDefaults = {
  wp_status?: "draft" | "publish";
  post_type?: string;
  writing_prompt_id?: string;
  image_prompt_id?: string;
};

export type BulkScheduleFormValues = {
  rows: BulkScheduleRow[];
  scheduleMode: BulkScheduleMode;
  wpStatus: "draft" | "publish";
  postType: string;
  writingPromptId: string;
  imagePromptId: string;
  generateImage: boolean;
};

type UseBulkScheduleFormArgs = {
  seedRows: BulkScheduleSeedRow[];
  profileTz: string;
  defaults?: BulkScheduleDefaults | null;
  wpTypesForSchedule?: WordpressPostType[];
  scheduleWritingPrompts?: PromptListResponse | null;
  scheduleImagePrompts?: PromptListResponse | null;
  active: boolean;
};

export function useBulkScheduleForm({
  seedRows,
  profileTz,
  defaults,
  wpTypesForSchedule = [],
  scheduleWritingPrompts,
  scheduleImagePrompts,
  active,
}: UseBulkScheduleFormArgs) {
  const scheduleTimeZone = profileTz || Intl.DateTimeFormat().resolvedOptions().timeZone;

  const buildMinStr = useCallback(() => buildScheduleMinDatetimeLocal(profileTz), [profileTz]);

  const [bulkScheduleMin, setBulkScheduleMin] = useState("");
  const [manualWhen, setManualWhen] = useState<Record<string, string>>({});
  const [mode, setMode] = useState<BulkScheduleMode>("manual");
  const [startWhen, setStartWhen] = useState("");
  const [preferredTime, setPreferredTime] = useState("09:00");
  const [articlesPerWeek, setArticlesPerWeek] = useState(1);
  const [weekdays, setWeekdays] = useState<WeekdayIso[]>([1]);
  const [postsPerMonth, setPostsPerMonth] = useState(1);
  const [wpStatus, setWpStatus] = useState<"draft" | "publish">("draft");
  const [postType, setPostType] = useState("posts");
  const [writingPromptId, setWritingPromptId] = useState("");
  const [imagePromptId, setImagePromptId] = useState("");

  const initFromSeeds = useCallback(
    (rows: BulkScheduleSeedRow[]) => {
      const minStr = buildMinStr();
      setBulkScheduleMin(minStr);
      setStartWhen(minStr);
      setPreferredTime(preferredTimeFromDatetimeLocal(minStr));
      setMode("manual");
      setArticlesPerWeek(1);
      setWeekdays(defaultPostingDaysFromMin(minStr));
      setPostsPerMonth(1);
      setWpStatus(defaults?.wp_status || "draft");
      setPostType(defaults?.post_type || "posts");
      setWritingPromptId(
        defaults?.writing_prompt_id || scheduleWritingPrompts?.default_id || "",
      );
      setImagePromptId(defaults?.image_prompt_id || scheduleImagePrompts?.default_id || "");
      const whenInit: Record<string, string> = {};
      for (const r of rows) {
        whenInit[r.id] = minStr;
      }
      setManualWhen(whenInit);
    },
    [buildMinStr, defaults, scheduleWritingPrompts, scheduleImagePrompts],
  );

  useEffect(() => {
    if (!active || !seedRows.length) return;
    initFromSeeds(seedRows);
  }, [active, seedRows, initFromSeeds]);

  useEffect(() => {
    if (!active) return;
    const refreshMin = () => {
      const minStr = buildMinStr();
      setBulkScheduleMin((prev) => (prev === minStr ? prev : minStr));
    };
    refreshMin();
    const id = window.setInterval(refreshMin, 30_000);
    return () => window.clearInterval(id);
  }, [active, buildMinStr]);

  const cadenceInputs = useMemo(
    () => ({
      mode,
      startWhen,
      preferredTime,
      articlesPerWeek,
      weekdays,
      postsPerMonth,
      min: bulkScheduleMin,
    }),
    [mode, startWhen, preferredTime, articlesPerWeek, weekdays, postsPerMonth, bulkScheduleMin],
  );
  const deferredCadence = useDeferredValue(cadenceInputs);

  const rows = useMemo(() => {
    const min = deferredCadence.min || buildMinStr();
    const base = seedRows.map((r) => ({
      id: r.id,
      title: r.title,
      when: manualWhen[r.id] || min,
    }));
    if (deferredCadence.mode === "manual" || base.length < 2) return base;
    return applyBulkScheduleDates({
      mode: deferredCadence.mode,
      rows: base,
      startWhen: deferredCadence.startWhen || min,
      minWhen: min,
      timeZone: scheduleTimeZone,
      articlesPerWeek: deferredCadence.articlesPerWeek,
      weekdays: deferredCadence.weekdays,
      postsPerMonth: deferredCadence.postsPerMonth,
      preferredTime:
        deferredCadence.mode === "weekly" || deferredCadence.mode === "monthly"
          ? deferredCadence.preferredTime
          : undefined,
    });
  }, [seedRows, manualWhen, deferredCadence, scheduleTimeZone, buildMinStr]);

  const whenDisplay = useMemo(() => {
    const out: Record<string, { date: string; time: string; tz: string }> = {};
    for (const r of rows) {
      out[r.id] = formatBulkScheduleWhenDisplay(r.when, profileTz);
    }
    return out;
  }, [rows, profileTz]);

  const cadenceSummary = useMemo(() => {
    if (deferredCadence.mode === "manual" || rows.length < 2) return "";
    return describeBulkScheduleSummary({
      mode: deferredCadence.mode,
      count: rows.length,
      articlesPerWeek: deferredCadence.articlesPerWeek,
      weekdays: deferredCadence.weekdays,
      postsPerMonth: deferredCadence.postsPerMonth,
      whens: rows.map((r) => r.when),
    });
  }, [deferredCadence, rows]);

  const setModeAndApply = useCallback(
    (next: BulkScheduleMode) => {
      startTransition(() => {
        setMode(next);
        const n = Math.max(1, seedRows.length);
        if (next === "weekly") {
          setArticlesPerWeek(Math.min(n, Math.max(1, weekdays.length)));
        }
        if (next === "monthly") {
          setPostsPerMonth(Math.min(n, Math.max(1, weekdays.length)));
        }
      });
    },
    [seedRows.length, weekdays.length],
  );

  const validate = useCallback((): string | null => {
    if (!rows.length) return "No articles to schedule.";
    const cadenceErr = validateBulkScheduleCadence({
      mode,
      articleCount: rows.length,
      articlesPerWeek,
      weekdays,
      postsPerMonth,
      whens: rows.map((r) => r.when),
      timeZone: scheduleTimeZone,
    });
    if (cadenceErr) return cadenceErr;
    const minStr = buildMinStr();
    for (const r of rows) {
      const when = (r.when || "").trim();
      if (!when) return "Please set date/time for every item.";
      if (!isScheduleWhenAllowed(when, minStr, scheduleTimeZone)) {
        return `Each scheduled time must be at least ${SCHEDULE_BUFFER_MINUTES} minutes from now (articles need ~${SCHEDULE_PREP_MINUTES} minutes to prepare).`;
      }
    }
    return null;
  }, [rows, mode, articlesPerWeek, weekdays, postsPerMonth, buildMinStr, scheduleTimeZone]);

  const getValues = useCallback((): BulkScheduleFormValues => {
    return {
      rows,
      scheduleMode: mode,
      wpStatus,
      postType,
      writingPromptId,
      imagePromptId,
      generateImage: true,
    };
  }, [rows, mode, wpStatus, postType, writingPromptId, imagePromptId]);

  return {
    rows,
    whenDisplay,
    cadenceSummary,
    bulkScheduleMin,
    mode,
    setModeAndApply,
    articlesPerWeek,
    setArticlesPerWeek,
    weekdays,
    setWeekdays,
    postsPerMonth,
    setPostsPerMonth,
    preferredTime,
    setPreferredTime,
    wpStatus,
    setWpStatus,
    postType,
    setPostType,
    writingPromptId,
    setWritingPromptId,
    imagePromptId,
    setImagePromptId,
    setManualWhen,
    wpTypesForSchedule,
    scheduleWritingPrompts,
    scheduleImagePrompts,
    validate,
    getValues,
    profileTz,
    seedCount: seedRows.length,
    BULK_SCHEDULE_WEEKDAYS_SUN_FIRST,
  };
}
