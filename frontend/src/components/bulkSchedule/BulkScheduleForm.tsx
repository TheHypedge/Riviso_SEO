"use client";

import { startTransition } from "react";
import styles from "@/app/page.module.css";
import { ScheduleModalIcons as Icon } from "@/components/bulkSchedule/scheduleModalIcons";
import {
  useBulkScheduleForm,
  type BulkScheduleDefaults,
  type BulkScheduleFormValues,
  type BulkScheduleSeedRow,
} from "@/components/bulkSchedule/useBulkScheduleForm";
import type { PromptListResponse, WordpressPostType } from "@/lib/api";

export type { BulkScheduleFormValues, BulkScheduleSeedRow };

type BulkScheduleFormProps = {
  seedRows: BulkScheduleSeedRow[];
  active: boolean;
  profileTz: string;
  defaults?: BulkScheduleDefaults | null;
  wpTypesForSchedule?: WordpressPostType[];
  scheduleWritingPrompts?: PromptListResponse | null;
  scheduleImagePrompts?: PromptListResponse | null;
  submitting: boolean;
  error?: string | null;
  onCancel: () => void;
  onSubmit: (values: BulkScheduleFormValues) => void | Promise<void>;
  onValidationError?: (message: string) => void;
  cancelLabel?: string;
};

export function BulkScheduleForm({
  seedRows,
  active,
  profileTz,
  defaults,
  wpTypesForSchedule,
  scheduleWritingPrompts,
  scheduleImagePrompts,
  submitting,
  error,
  onCancel,
  onSubmit,
  onValidationError,
  cancelLabel = "Cancel",
}: BulkScheduleFormProps) {
  const form = useBulkScheduleForm({
    seedRows,
    profileTz,
    defaults,
    wpTypesForSchedule,
    scheduleWritingPrompts,
    scheduleImagePrompts,
    active,
  });

  const {
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
    validate,
    getValues,
    seedCount,
    BULK_SCHEDULE_WEEKDAYS_SUN_FIRST,
  } = form;

  async function handleSubmit() {
    const err = validate();
    if (err) {
      onValidationError?.(err);
      return;
    }
    await onSubmit(getValues());
  }

  return (
    <>
      <div className={styles.bulkScheduleBody}>
        <section
          className={`${styles.bulkScheduleSection} ${styles.bulkScheduleSectionCompact}`}
          aria-labelledby="bulk-schedule-defaults-heading"
        >
          <div className={styles.bulkScheduleSectionHead} id="bulk-schedule-defaults-heading">
            <span className={styles.bulkScheduleSectionIconWrap} aria-hidden="true">
              <Icon.Globe className={styles.icon18} />
            </span>
            <span className={styles.bulkScheduleSectionTitle}>Publishing defaults</span>
          </div>
          <div className={`${styles.bulkScheduleFieldList} ${styles.bulkScheduleFieldListGrid}`}>
            <div className={styles.bulkScheduleFieldRow}>
              <span className={styles.bulkScheduleFieldIcon} aria-hidden="true">
                <Icon.Layers className={styles.icon18} />
              </span>
              <label className={styles.bulkScheduleFieldControl}>
                <span className={styles.bulkScheduleFieldLabel}>WordPress post type</span>
                <select
                  className={styles.bulkScheduleInput}
                  value={postType}
                  onChange={(e) => setPostType(e.target.value)}
                  disabled={submitting}
                >
                  <option value="posts">Posts</option>
                  <option value="pages">Pages</option>
                  {(wpTypesForSchedule || [])
                    .filter((t) => t.rest_base && !["posts", "pages"].includes(t.rest_base))
                    .map((t) => (
                      <option key={t.rest_base} value={t.rest_base}>
                        {t.name || t.rest_base}
                      </option>
                    ))}
                </select>
              </label>
            </div>
            <div className={styles.bulkScheduleFieldRow}>
              <span className={styles.bulkScheduleFieldIcon} aria-hidden="true">
                <Icon.Status className={styles.icon18} />
              </span>
              <label className={styles.bulkScheduleFieldControl}>
                <span className={styles.bulkScheduleFieldLabel}>WordPress status</span>
                <select
                  className={styles.bulkScheduleInput}
                  value={wpStatus}
                  onChange={(e) => setWpStatus(e.target.value as "draft" | "publish")}
                  disabled={submitting}
                >
                  <option value="draft">Draft</option>
                  <option value="publish">Publish</option>
                </select>
              </label>
            </div>
            <div className={styles.bulkScheduleFieldRow}>
              <span className={styles.bulkScheduleFieldIcon} aria-hidden="true">
                <Icon.Pen className={styles.icon18} />
              </span>
              <label className={styles.bulkScheduleFieldControl}>
                <span className={styles.bulkScheduleFieldLabel}>Writing prompt</span>
                <select
                  className={styles.bulkScheduleInput}
                  value={writingPromptId}
                  onChange={(e) => setWritingPromptId(e.target.value)}
                  disabled={submitting}
                >
                  <option value="">Use project default</option>
                  {(scheduleWritingPrompts?.items || []).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name || p.id}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className={styles.bulkScheduleFieldRow}>
              <span className={styles.bulkScheduleFieldIcon} aria-hidden="true">
                <Icon.Image className={styles.icon18} />
              </span>
              <label className={styles.bulkScheduleFieldControl}>
                <span className={styles.bulkScheduleFieldLabel}>Image prompt</span>
                <select
                  className={styles.bulkScheduleInput}
                  value={imagePromptId}
                  onChange={(e) => setImagePromptId(e.target.value)}
                  disabled={submitting}
                >
                  <option value="">Use project default</option>
                  {(scheduleImagePrompts?.items || []).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name || p.id}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </div>
        </section>

        {rows.length >= 2 ? (
          <section
            className={`${styles.bulkScheduleSection} ${styles.bulkScheduleSectionCompact} ${styles.bulkScheduleModeSection}`}
            aria-labelledby="bulk-schedule-mode-heading"
          >
            <div className={styles.bulkScheduleModeHeaderRow}>
              <div className={styles.bulkScheduleSectionHead} id="bulk-schedule-mode-heading">
                <span className={styles.bulkScheduleSectionIconWrap} aria-hidden="true">
                  <Icon.Calendar className={styles.icon18} />
                </span>
                <span className={styles.bulkScheduleSectionTitle}>Schedule mode</span>
              </div>
              <div className={styles.bulkScheduleModeTabs} role="tablist" aria-label="Schedule mode">
                {(
                  [
                    ["manual", "Manual", Icon.List] as const,
                    ["weekly", "Weekly", Icon.Repeat] as const,
                    ["monthly", "Monthly", Icon.CalendarMonth] as const,
                  ] as const
                ).map(([modeKey, label, ModeIcon]) => (
                  <button
                    key={modeKey}
                    type="button"
                    role="tab"
                    aria-selected={mode === modeKey}
                    className={`${styles.bulkScheduleModeTab} ${mode === modeKey ? styles.bulkScheduleModeTabActive : ""}`}
                    disabled={submitting}
                    onClick={() => setModeAndApply(modeKey)}
                  >
                    <ModeIcon className={styles.bulkScheduleModeTabIcon} />
                    <span>{label}</span>
                  </button>
                ))}
              </div>
            </div>

            {mode === "weekly" ? (
              <div className={styles.bulkScheduleCadencePanel}>
                <div>
                  <span className={styles.bulkScheduleCadenceLabel}>Posting days</span>
                  <div className={styles.bulkScheduleWeekdayRow}>
                    {BULK_SCHEDULE_WEEKDAYS_SUN_FIRST.map(({ iso, label }) => {
                      const on = weekdays.includes(iso);
                      return (
                        <label key={iso} className={styles.bulkScheduleWeekdayChip}>
                          <input
                            type="checkbox"
                            checked={on}
                            disabled={submitting}
                            onChange={() => {
                              startTransition(() => {
                                setWeekdays((prev) => {
                                  const next = on
                                    ? prev.filter((d) => d !== iso)
                                    : [...prev, iso].sort((a, b) => a - b);
                                  return next.length ? next : [iso];
                                });
                              });
                            }}
                          />
                          {label}
                        </label>
                      );
                    })}
                  </div>
                </div>
                <div className={styles.bulkScheduleCadenceFieldsRow}>
                  <label className={styles.label}>
                    Articles per week
                    <input
                      className={styles.input}
                      type="number"
                      min={1}
                      max={Math.max(1, seedCount)}
                      value={articlesPerWeek}
                      disabled={submitting}
                      onChange={(e) => {
                        const maxApw = Math.max(1, seedCount);
                        const n = Math.max(1, Math.min(maxApw, Number(e.target.value) || 1));
                        startTransition(() => setArticlesPerWeek(n));
                      }}
                    />
                  </label>
                  <label className={styles.label}>
                    Preferred time
                    <input
                      className={styles.input}
                      type="time"
                      value={preferredTime}
                      step={60}
                      disabled={submitting}
                      onChange={(e) => startTransition(() => setPreferredTime(e.target.value))}
                    />
                  </label>
                </div>
              </div>
            ) : null}

            {mode === "monthly" ? (
              <div className={styles.bulkScheduleCadencePanel}>
                <div>
                  <span className={styles.bulkScheduleCadenceLabel}>Posting days</span>
                  <div className={styles.bulkScheduleWeekdayRow}>
                    {BULK_SCHEDULE_WEEKDAYS_SUN_FIRST.map(({ iso, label }) => {
                      const on = weekdays.includes(iso);
                      return (
                        <label key={iso} className={styles.bulkScheduleWeekdayChip}>
                          <input
                            type="checkbox"
                            checked={on}
                            disabled={submitting}
                            onChange={() => {
                              startTransition(() => {
                                setWeekdays((prev) => {
                                  const next = on
                                    ? prev.filter((d) => d !== iso)
                                    : [...prev, iso].sort((a, b) => a - b);
                                  return next.length ? next : [iso];
                                });
                              });
                            }}
                          />
                          {label}
                        </label>
                      );
                    })}
                  </div>
                </div>
                <div className={styles.bulkScheduleCadenceFieldsRow}>
                  <label className={styles.label}>
                    Total monthly articles
                    <input
                      className={styles.input}
                      type="number"
                      min={1}
                      max={Math.max(1, seedCount)}
                      value={postsPerMonth}
                      disabled={submitting}
                      onChange={(e) => {
                        const maxApm = Math.max(1, seedCount);
                        const n = Math.max(1, Math.min(maxApm, Number(e.target.value) || 1));
                        startTransition(() => setPostsPerMonth(n));
                      }}
                    />
                  </label>
                  <label className={styles.label}>
                    Preferred time
                    <input
                      className={styles.input}
                      type="time"
                      value={preferredTime}
                      step={60}
                      disabled={submitting}
                      onChange={(e) => startTransition(() => setPreferredTime(e.target.value))}
                    />
                  </label>
                </div>
              </div>
            ) : null}

            {cadenceSummary ? (
              <p className={styles.bulkScheduleCadenceSummary}>
                <Icon.Clock className={styles.icon16} />
                {cadenceSummary}
              </p>
            ) : null}
          </section>
        ) : null}

        <section
          className={`${styles.bulkScheduleSection} ${styles.bulkScheduleTimelineSection}`}
          aria-labelledby="bulk-schedule-timeline-heading"
        >
          <div className={styles.bulkScheduleSectionHead} id="bulk-schedule-timeline-heading">
            <span className={styles.bulkScheduleSectionIconWrap} aria-hidden="true">
              <Icon.Document className={styles.icon18} />
            </span>
            <span className={styles.bulkScheduleSectionTitle}>Publish timeline</span>
          </div>
          <div className={styles.bulkScheduleArticleList}>
            {rows.map((r, idx) => {
              const display = whenDisplay[r.id];
              const readOnly = rows.length >= 2 && mode !== "manual";
              return (
                <div key={r.id} className={styles.bulkScheduleArticleCard}>
                  <div className={styles.bulkScheduleArticleCardMain}>
                    <span className={styles.bulkScheduleArticleIndex} aria-hidden="true">
                      {idx + 1}
                    </span>
                    <p className={styles.bulkScheduleArticleTitle} title={r.title}>
                      {r.title}
                    </p>
                  </div>
                  {readOnly ? (
                    <div className={styles.bulkScheduleWhenReadonly}>
                      <span className={styles.bulkScheduleWhenReadonlyLabel}>
                        <Icon.Clock className={styles.icon16} />
                        Publish at
                      </span>
                      <span className={styles.bulkScheduleWhenReadonlyValue}>
                        {display?.date}
                        {display?.time ? (
                          <>
                            <br />
                            {display.time}
                            {display.tz ? ` · ${display.tz}` : null}
                          </>
                        ) : null}
                      </span>
                    </div>
                  ) : (
                    <label className={styles.bulkScheduleDatetimeWrap}>
                      <span className={styles.bulkScheduleDatetimeLabel}>
                        <Icon.Clock className={styles.icon16} />
                        Date & time
                      </span>
                      <input
                        className={styles.bulkScheduleInput}
                        type="datetime-local"
                        value={r.when}
                        min={bulkScheduleMin || undefined}
                        step={60}
                        disabled={submitting}
                        onChange={(e) => {
                          const v = e.target.value;
                          setManualWhen((prev) => ({ ...prev, [r.id]: v }));
                        }}
                      />
                    </label>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      </div>

      {error ? <p className={styles.error} style={{ marginTop: 12, marginBottom: 0 }}>{error}</p> : null}

      <div className={styles.bulkScheduleFooter}>
        <button
          type="button"
          className={styles.bulkScheduleFooterCancel}
          onClick={onCancel}
          disabled={submitting}
        >
          {cancelLabel}
        </button>
        <button
          type="button"
          className={styles.bulkScheduleFooterPrimary}
          onClick={() => void handleSubmit()}
          disabled={submitting || !rows.length}
        >
          <Icon.Calendar className={styles.icon18} />
          {submitting
            ? `Scheduling ${rows.length}…`
            : `Schedule ${rows.length} article${rows.length === 1 ? "" : "s"}`}
        </button>
      </div>
    </>
  );
}
