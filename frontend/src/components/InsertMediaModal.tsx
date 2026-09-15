"use client";

import { useState } from "react";
import type { Editor as TipTapEditor } from "@tiptap/react";

import { api } from "@/lib/api";
import styles from "@/app/page.module.css";
import editorStyles from "@/app/projects/[projectId]/articles/[articleId]/articleEditor.module.css";

type Tab = "url" | "upload" | "ai";
const PROMPT_MAX = 200;

type Props = {
  editor: TipTapEditor | null;
  projectId: string;
  articleId: string;
  open: boolean;
  onClose: () => void;
};

export function InsertMediaModal({ editor, projectId, articleId, open, onClose }: Props) {
  const [tab, setTab] = useState<Tab>("url");
  const [url, setUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  function reset() {
    setTab("url");
    setUrl("");
    setFile(null);
    setPrompt("");
    setError(null);
    setBusy(false);
  }

  function handleClose() {
    reset();
    onClose();
  }

  function insertImage(src: string) {
    if (!editor) return;
    editor.chain().focus().insertContent({ type: "articleImage", attrs: { src, alt: "" } }).run();
    handleClose();
  }

  async function handleInsert() {
    if (!editor || busy) return;
    setError(null);
    setBusy(true);
    try {
      if (tab === "url") {
        if (!url.trim()) return;
        const res = await api.insertArticleMediaFromUrl(projectId, articleId, url.trim());
        insertImage(res.url);
      } else if (tab === "upload") {
        if (!file) return;
        const res = await api.insertArticleMediaUpload(projectId, articleId, file);
        insertImage(res.url);
      } else {
        if (!prompt.trim()) return;
        const res = await api.generateArticleMediaAi(projectId, articleId, prompt.trim());
        insertImage(res.url);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't insert that media. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const canInsert = !busy && (tab === "url" ? url.trim().length > 0 : tab === "upload" ? !!file : prompt.trim().length > 0);

  return (
    <>
      <button type="button" className={styles.modalBackdrop} aria-label="Close" onClick={handleClose} />
      <div className={styles.modalPanel} role="dialog" aria-modal="true" aria-label="Insert media">
        <div className={styles.modalHead}>
          <h3 className={styles.modalTitle}>Insert media</h3>
          <button type="button" className={styles.iconButton} aria-label="Close" onClick={handleClose}>
            ×
          </button>
        </div>

        <div className={styles.researchSubTabs} role="tablist" aria-label="Media source" style={{ margin: "0 20px 12px" }}>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "url"}
            className={`${styles.researchSubTab} ${tab === "url" ? styles.researchSubTabActive : ""}`}
            onClick={() => setTab("url")}
          >
            URL
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "upload"}
            className={`${styles.researchSubTab} ${tab === "upload" ? styles.researchSubTabActive : ""}`}
            onClick={() => setTab("upload")}
          >
            Upload
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "ai"}
            className={`${styles.researchSubTab} ${tab === "ai" ? styles.researchSubTabActive : ""}`}
            onClick={() => setTab("ai")}
          >
            AI Generate
          </button>
        </div>

        <div className={styles.modalBody}>
          {tab === "url" ? (
            <label className={styles.label}>
              Image URL
              <input
                type="url"
                className={styles.input}
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com/image.jpg"
              />
            </label>
          ) : null}

          {tab === "upload" ? (
            <label className={styles.label}>
              Choose a file
              <input
                type="file"
                accept="image/*"
                className={styles.input}
                onChange={(e) => setFile(e.target.files?.[0] || null)}
              />
            </label>
          ) : null}

          {tab === "ai" ? (
            <label className={styles.label}>
              Describe the image
              <textarea
                className={styles.input}
                rows={3}
                maxLength={PROMPT_MAX}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value.slice(0, PROMPT_MAX))}
                placeholder="e.g. a red bicycle leaning against a brick wall"
              />
              <span className={styles.muted} style={{ fontSize: 12 }}>
                {prompt.length}/{PROMPT_MAX}
              </span>
            </label>
          ) : null}

          {busy && tab === "ai" ? (
            <div className={editorStyles.insertMediaShimmer} aria-hidden="true" />
          ) : null}

          {error ? <p className={styles.error}>{error}</p> : null}
        </div>

        <div className={styles.modalFooter}>
          <button type="button" className={styles.btnSecondary} onClick={handleClose}>
            Cancel
          </button>
          <button type="button" className={styles.button} onClick={handleInsert} disabled={!canInsert}>
            {busy ? "Inserting…" : "Insert"}
          </button>
        </div>
      </div>
    </>
  );
}
