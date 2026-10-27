"use client";

import { useState } from "react";

import styles from "@/app/page.module.css";
import { useFocusTrap } from "@/lib/useFocusTrap";

type Props = {
  projectName: string;
  deleting: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
};

/** GitHub-style delete guard: the user must type "delete <project name>" exactly. Mount only while open. */
export function DeleteProjectDialog({ projectName, deleting, error, onCancel, onConfirm }: Props) {
  const [text, setText] = useState("");
  const trapRef = useFocusTrap(true);
  const label = projectName.trim() || "this project";
  const phrase = `delete ${label}`;
  const matches = text.trim() === phrase;

  return (
    <div className={styles.modalBackdrop} role="dialog" aria-modal="true" aria-labelledby="delete-project-title">
      <div ref={trapRef} className={`${styles.modalPanel} ${styles.deleteModal}`}>
        <div className={styles.modalHead}>
          <h3 id="delete-project-title" className={styles.modalTitle}>
            Delete “{label}”?
          </h3>
        </div>
        <form
          className={styles.modalBody}
          onSubmit={(e) => {
            e.preventDefault();
            if (matches && !deleting) onConfirm();
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape" && !deleting) onCancel();
          }}
        >
          <div className={styles.deleteWarning} role="note">
            <strong>This permanently deletes the project. It cannot be undone.</strong>
            <span>Everything below is removed for good:</span>
            <ul className={styles.deleteList}>
              <li>All articles</li>
              <li>Scheduled jobs</li>
              <li>Writing &amp; image prompts</li>
              <li>Context links</li>
              <li>Settings &amp; website connections</li>
            </ul>
          </div>
          <label className={styles.deleteConfirmLabel} htmlFor="delete-project-confirm">
            To confirm, type <code className={styles.deletePhrase}>{phrase}</code> below
          </label>
          <input
            id="delete-project-confirm"
            className={styles.input}
            value={text}
            onChange={(e) => setText(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            autoFocus
            required
            aria-invalid={text.length > 0 && !matches}
            disabled={deleting}
          />
          {error ? (
            <p className={styles.error} style={{ margin: 0 }} role="alert">
              {error}
            </p>
          ) : null}
          <div className={styles.deleteActions}>
            <button type="button" className={styles.btnSecondary} onClick={onCancel} disabled={deleting}>
              Cancel
            </button>
            <button type="submit" className={styles.btnDanger} disabled={!matches || deleting}>
              {deleting ? "Deleting…" : "Delete this project"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
