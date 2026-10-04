"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Editor as TipTapEditor } from "@tiptap/react";

import { api } from "@/lib/api";
import editorStyles from "@/app/projects/[projectId]/articles/[articleId]/articleEditor.module.css";

type Props = {
  editor: TipTapEditor | null;
  projectId: string;
  articleId: string;
  focusKeyphrase: string;
  keywords: string[];
  disabled?: boolean;
  onError: (message: string) => void;
};

type Anchor = { top: number; left: number; from: number; to: number };
type Rect = { top: number; left: number; width: number; height: number };
type Tab = "auto" | "custom";

const MIN_SELECTION_CHARS = 12;
const CONTEXT_CHARS = 600;
const MAX_CUSTOM_PROMPT_CHARS = 100;

function SparkleIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" width={14} height={14}>
      <path d="M12 2l1.8 5.6L19 9l-5.2 1.4L12 16l-1.8-5.6L5 9l5.2-1.4L12 2z" />
      <path d="M19 16l.9 2.4L22 19l-2.1.6-.9 2.4-.9-2.4L16 19l2.1-.6.9-2.4z" opacity={0.7} />
    </svg>
  );
}

export function SelectionAiRegenerate({
  editor,
  projectId,
  articleId,
  focusKeyphrase,
  keywords,
  disabled,
  onError,
}: Props) {
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const busyRef = useRef(false);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [busy, setBusy] = useState(false);
  const [shimmerRects, setShimmerRects] = useState<Rect[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>("auto");
  const [customPrompt, setCustomPrompt] = useState("");

  const recomputeAnchor = useCallback(() => {
    // Frozen while the dialog is open -- otherwise focus moving into the
    // textarea (or any selection change the dialog itself doesn't cause)
    // would reposition or clear the anchor out from under the open dialog.
    if (!editor || busyRef.current || dialogOpen) return;
    const { from, to, empty } = editor.state.selection;
    if (empty) {
      setAnchor(null);
      return;
    }
    const text = editor.state.doc.textBetween(from, to, "\n\n");
    if (text.trim().length < MIN_SELECTION_CHARS) {
      setAnchor(null);
      return;
    }
    const containerRect = overlayRef.current?.getBoundingClientRect();
    if (!containerRect) return;
    const coords = editor.view.coordsAtPos(to);
    setAnchor({
      top: coords.top - containerRect.top,
      left: coords.right - containerRect.left,
      from,
      to,
    });
  }, [editor, dialogOpen]);

  useEffect(() => {
    // Nothing to subscribe to when locked/unready — the component itself
    // renders null in that case (see the disabled/!editor check below), so
    // there's no stale anchor to clear here.
    if (!editor || disabled) return;
    editor.on("selectionUpdate", recomputeAnchor);
    window.addEventListener("scroll", recomputeAnchor, true);
    window.addEventListener("resize", recomputeAnchor);
    return () => {
      editor.off("selectionUpdate", recomputeAnchor);
      window.removeEventListener("scroll", recomputeAnchor, true);
      window.removeEventListener("resize", recomputeAnchor);
    };
  }, [editor, disabled, recomputeAnchor]);

  function openDialog() {
    if (!anchor) return;
    setActiveTab("auto");
    setCustomPrompt("");
    setDialogOpen(true);
  }

  function closeDialog() {
    setDialogOpen(false);
  }

  async function runRegenerate(customInstruction?: string) {
    if (!editor || !anchor || busy) return;
    const { from, to } = anchor;

    busyRef.current = true;
    setBusy(true);

    try {
      const startDom = editor.view.domAtPos(from);
      const endDom = editor.view.domAtPos(to);
      const range = document.createRange();
      range.setStart(startDom.node, startDom.offset);
      range.setEnd(endDom.node, endDom.offset);
      const containerRect = overlayRef.current?.getBoundingClientRect();
      if (containerRect) {
        const rects = Array.from(range.getClientRects()).map((r) => ({
          top: r.top - containerRect.top,
          left: r.left - containerRect.left,
          width: r.width,
          height: r.height,
        }));
        setShimmerRects(rects);
      }
    } catch {
      setShimmerRects([]);
    }

    const docSize = editor.state.doc.content.size;
    const selectedText = editor.state.doc.textBetween(from, to, "\n\n");
    const contextBefore = editor.state.doc.textBetween(Math.max(0, from - CONTEXT_CHARS), from, "\n\n");
    const contextAfter = editor.state.doc.textBetween(to, Math.min(docSize, to + CONTEXT_CHARS), "\n\n");

    try {
      const res = await api.regenerateArticleSelection(projectId, articleId, {
        selected_text: selectedText,
        context_before: contextBefore,
        context_after: contextAfter,
        focus_keyphrase: focusKeyphrase,
        keywords,
        ...(customInstruction ? { custom_instruction: customInstruction } : {}),
      });
      editor.chain().focus().insertContentAt({ from, to }, res.rewritten).run();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Couldn't regenerate that selection.");
    } finally {
      busyRef.current = false;
      setBusy(false);
      setShimmerRects([]);
      setAnchor(null);
      setDialogOpen(false);
    }
  }

  if (disabled || !editor) return null;

  const customPromptTrimmed = customPrompt.trim();

  return (
    <div ref={overlayRef} className={editorStyles.selectionAiLayer} aria-hidden={!anchor && shimmerRects.length === 0}>
      {shimmerRects.map((r, i) => (
        <div
          key={i}
          className={editorStyles.selectionRegenOverlay}
          style={{ top: r.top, left: r.left, width: r.width, height: r.height }}
        />
      ))}
      {anchor && !busy && !dialogOpen ? (
        <button
          type="button"
          className={editorStyles.selectionAiPill}
          style={{ top: anchor.top - 34, left: anchor.left }}
          onClick={openDialog}
          title="AI regenerate"
        >
          <SparkleIcon />
          <span className={editorStyles.selectionAiPillLabel}>AI regenerate</span>
        </button>
      ) : null}
      {anchor && dialogOpen ? (
        <div
          className={editorStyles.selectionAiDialog}
          style={{ top: anchor.top - 34, left: anchor.left }}
          role="dialog"
          aria-label="Regenerate selection"
        >
          <div className={editorStyles.selectionAiDialogTabs} role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "auto"}
              className={`${editorStyles.selectionAiDialogTab} ${activeTab === "auto" ? editorStyles.selectionAiDialogTabActive : ""}`}
              onClick={() => setActiveTab("auto")}
            >
              Automatic regenerate
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "custom"}
              className={`${editorStyles.selectionAiDialogTab} ${activeTab === "custom" ? editorStyles.selectionAiDialogTabActive : ""}`}
              onClick={() => setActiveTab("custom")}
            >
              Custom
            </button>
          </div>

          {activeTab === "auto" ? (
            <div className={editorStyles.selectionAiDialogPanel}>
              <p className={editorStyles.selectionAiDialogHint}>
                Automatically regenerates the content using the context of the paragraph you selected.
              </p>
              <div className={editorStyles.selectionAiDialogFooter}>
                <button type="button" className={editorStyles.selectionAiDialogBtn} onClick={closeDialog} disabled={busy}>
                  Cancel
                </button>
                <button
                  type="button"
                  className={`${editorStyles.selectionAiDialogBtn} ${editorStyles.selectionAiDialogBtnPrimary}`}
                  onClick={() => void runRegenerate()}
                  disabled={busy}
                >
                  Regenerate
                </button>
              </div>
            </div>
          ) : (
            <div className={editorStyles.selectionAiDialogPanel}>
              <p className={editorStyles.selectionAiDialogHint}>
                Write a custom prompt to regenerate with custom instructions.
              </p>
              <textarea
                className={editorStyles.selectionAiDialogTextarea}
                value={customPrompt}
                onChange={(e) => setCustomPrompt(e.target.value.slice(0, MAX_CUSTOM_PROMPT_CHARS))}
                maxLength={MAX_CUSTOM_PROMPT_CHARS}
                placeholder="e.g. Make this more concise"
                disabled={busy}
                rows={3}
              />
              <div className={editorStyles.selectionAiDialogCharCount}>
                {customPrompt.length} / {MAX_CUSTOM_PROMPT_CHARS}
              </div>
              <div className={editorStyles.selectionAiDialogFooter}>
                <button type="button" className={editorStyles.selectionAiDialogBtn} onClick={closeDialog} disabled={busy}>
                  Cancel
                </button>
                <button
                  type="button"
                  className={`${editorStyles.selectionAiDialogBtn} ${editorStyles.selectionAiDialogBtnPrimary}`}
                  onClick={() => void runRegenerate(customPromptTrimmed)}
                  disabled={busy || !customPromptTrimmed}
                >
                  Regenerate
                </button>
              </div>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
