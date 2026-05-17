"use client";

import styles from "@/app/page.module.css";
import {
  BulkScheduleForm,
  type BulkScheduleFormValues,
  type BulkScheduleSeedRow,
} from "@/components/bulkSchedule/BulkScheduleForm";
import { ScheduleModalIcons as Icon } from "@/components/bulkSchedule/scheduleModalIcons";
import type { BulkScheduleDefaults } from "@/components/bulkSchedule/useBulkScheduleForm";
import type { PromptListResponse, WordpressPostType } from "@/lib/api";

export type { BulkScheduleFormValues, BulkScheduleSeedRow };

type BulkScheduleModalProps = {
  open: boolean;
  title: string;
  seedRows: BulkScheduleSeedRow[];
  profileTz: string;
  defaults?: BulkScheduleDefaults | null;
  wpTypesForSchedule?: WordpressPostType[];
  scheduleWritingPrompts?: PromptListResponse | null;
  scheduleImagePrompts?: PromptListResponse | null;
  submitting: boolean;
  error?: string | null;
  onClose: () => void;
  onSubmit: (values: BulkScheduleFormValues) => void | Promise<void>;
  onValidationError?: (message: string) => void;
};

export function BulkScheduleModal({
  open,
  title,
  seedRows,
  profileTz,
  defaults,
  wpTypesForSchedule,
  scheduleWritingPrompts,
  scheduleImagePrompts,
  submitting,
  error,
  onClose,
  onSubmit,
  onValidationError,
}: BulkScheduleModalProps) {
  if (!open) return null;

  return (
    <>
      <div className={styles.bulkBackdrop} onClick={submitting ? undefined : onClose} aria-hidden="true" />
      <div
        className={`${styles.bulkPopup} ${styles.bulkPopupScheduleLayout}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className={styles.bulkPopupHead}>
          <div className={styles.bulkPopupTitle}>
            <strong>{title}</strong>
            <div className={styles.bulkScheduleMetaChips}>
              <span className={styles.bulkScheduleMetaChip}>
                <Icon.Document className={styles.icon16} />
                {seedRows.length} article{seedRows.length === 1 ? "" : "s"}
              </span>
              {profileTz ? (
                <span className={styles.bulkScheduleMetaChip}>
                  <Icon.Clock className={styles.icon16} />
                  {profileTz}
                </span>
              ) : null}
            </div>
          </div>
          <button
            className={styles.iconButton}
            type="button"
            aria-label="Close"
            onClick={onClose}
            disabled={submitting}
          >
            <Icon.X className={styles.icon20} />
          </button>
        </div>

        <BulkScheduleForm
          seedRows={seedRows}
          active={open}
          profileTz={profileTz}
          defaults={defaults}
          wpTypesForSchedule={wpTypesForSchedule}
          scheduleWritingPrompts={scheduleWritingPrompts}
          scheduleImagePrompts={scheduleImagePrompts}
          submitting={submitting}
          error={error}
          onCancel={onClose}
          onSubmit={onSubmit}
          onValidationError={onValidationError}
        />
      </div>
    </>
  );
}
