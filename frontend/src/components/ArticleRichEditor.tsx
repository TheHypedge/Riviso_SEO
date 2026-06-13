"use client";

import LinkExt from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useMemo, useRef, useState } from "react";
import TurndownService from "turndown";

import styles from "@/app/page.module.css";
import { EditorLinesSkeleton } from "@/components/skeleton";
import { markdownToArticleHtml } from "@/lib/articleMarkdown";

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});

function htmlToMarkdown(html: string): string {
  return turndown.turndown(html || "").trim();
}

type BlockFormat = "paragraph" | "heading-1" | "heading-2" | "heading-3" | "heading-4" | "heading-5" | "heading-6";

const BLOCK_FORMAT_OPTIONS: { value: BlockFormat; label: string }[] = [
  { value: "paragraph", label: "Paragraph" },
  { value: "heading-1", label: "Heading 1" },
  { value: "heading-2", label: "Heading 2" },
  { value: "heading-3", label: "Heading 3" },
  { value: "heading-4", label: "Heading 4" },
  { value: "heading-5", label: "Heading 5" },
  { value: "heading-6", label: "Heading 6" },
];

function activeBlockFormat(editor: { isActive: (name: string, attrs?: Record<string, unknown>) => boolean }): BlockFormat {
  for (let level = 1; level <= 6; level += 1) {
    if (editor.isActive("heading", { level })) return `heading-${level}` as BlockFormat;
  }
  return "paragraph";
}

export type ArticleRichEditorProps = {
  value: string;
  onChange: (markdown: string) => void;
  placeholder?: string;
  /** Bumped when parent applies external markdown (e.g. humanize) to force a clean sync. */
  contentRevision?: number;
};

export function ArticleRichEditor({ value, onChange, placeholder, contentRevision = 0 }: ArticleRichEditorProps) {
  const syncingFromParent = useRef(false);
  // Track the last markdown we sent to the parent so the sync useEffect can skip
  // the expensive htmlToMarkdown(editor.getHTML()) comparison on every keystroke.
  const lastSentMd = useRef<string>((value || "").trim());
  const [blockFormat, setBlockFormat] = useState<BlockFormat>("paragraph");

  const extensions = useMemo(
    () => [
      StarterKit.configure({
        /* Include H1 — markdown often uses `#`; omitting level 1 made TipTap drop content and appear empty */
        heading: { levels: [1, 2, 3, 4, 5, 6] },
        link: false,
      }),
      Placeholder.configure({
        placeholder:
          placeholder ||
          "Write your article… Headings, lists, and bold styling match what WordPress will receive as formatted HTML after publish.",
      }),
      LinkExt.configure({
        openOnClick: false,
        autolink: true,
        HTMLAttributes: {
          rel: "noopener noreferrer",
          target: "_blank",
          class: "article-editor-link",
        },
      }),
    ],
    [placeholder],
  );

  const editor = useEditor(
    {
      immediatelyRender: false,
      extensions,
      editable: true,
      content: markdownToArticleHtml(value),
      editorProps: {
        attributes: {
          class: styles.articleProseMirror,
          spellCheck: "true",
        },
      },
      onUpdate: ({ editor: ed }) => {
        const md = htmlToMarkdown(ed.getHTML());
        lastSentMd.current = md; // record what we told the parent
        syncingFromParent.current = true;
        setBlockFormat(activeBlockFormat(ed));
        onChange(md);
      },
      onSelectionUpdate: ({ editor: ed }) => {
        setBlockFormat(activeBlockFormat(ed));
      },
    },
    [extensions],
  );

  useEffect(() => {
    if (!editor) return;
    const incomingMd = (value || "").trim();
    // Fast path: value is what we just sent from this editor — no need to call
    // setContent or run the expensive htmlToMarkdown(getHTML()) comparison.
    if (incomingMd === lastSentMd.current.trim()) return;
    syncingFromParent.current = true;
    editor.commands.setContent(markdownToArticleHtml(value), { emitUpdate: false });
    lastSentMd.current = incomingMd;
    queueMicrotask(() => {
      syncingFromParent.current = false;
      setBlockFormat(activeBlockFormat(editor));
    });
  }, [value, editor, contentRevision]);

  function applyBlockFormat(next: BlockFormat) {
    if (!editor) return;
    setBlockFormat(next);
    const chain = editor.chain().focus();
    if (next === "paragraph") {
      chain.setParagraph().run();
      return;
    }
    const level = Number(next.replace("heading-", "")) as 1 | 2 | 3 | 4 | 5 | 6;
    chain.setHeading({ level }).run();
  }

  if (!editor) {
    return <EditorLinesSkeleton lines={6} />;
  }

  return (
    <div className={styles.articleRichEditorWrap}>
      <div className={styles.articleRichToolbar} role="toolbar" aria-label="Formatting">
        <label className={styles.articleRichFormatLabel}>
          <span className={styles.srOnly}>Text style</span>
          <select
            className={styles.articleRichFormatSelect}
            value={blockFormat}
            onChange={(e) => applyBlockFormat(e.target.value as BlockFormat)}
            title="Text style"
            aria-label="Text style"
          >
            {BLOCK_FORMAT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className={styles.articleRichToolBtn}
          onClick={() => editor.chain().focus().toggleBold().run()}
          aria-pressed={editor.isActive("bold")}
          title="Bold"
        >
          <strong>B</strong>
        </button>
        <button
          type="button"
          className={styles.articleRichToolBtn}
          onClick={() => editor.chain().focus().toggleItalic().run()}
          aria-pressed={editor.isActive("italic")}
          title="Italic"
        >
          <em>I</em>
        </button>
        <button
          type="button"
          className={styles.articleRichToolBtn}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          aria-pressed={editor.isActive("bulletList")}
          title="Bullet list"
        >
          • List
        </button>
        <button
          type="button"
          className={styles.articleRichToolBtn}
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
          aria-pressed={editor.isActive("orderedList")}
          title="Numbered list"
        >
          1. List
        </button>
        <button
          type="button"
          className={styles.articleRichToolBtn}
          onClick={() => editor.chain().focus().toggleBlockquote().run()}
          aria-pressed={editor.isActive("blockquote")}
          title="Quote"
        >
          “”
        </button>
        <button
          type="button"
          className={styles.articleRichToolBtn}
          onClick={() => {
            const prev = editor.getAttributes("link").href as string | undefined;
            const url = window.prompt("Link URL", prev || "https://");
            if (url === null) return;
            const trimmed = url.trim();
            if (trimmed === "") {
              editor.chain().focus().extendMarkRange("link").unsetLink().run();
              return;
            }
            editor.chain().focus().extendMarkRange("link").setLink({ href: trimmed }).run();
          }}
          aria-pressed={editor.isActive("link")}
          title="Link"
        >
          Link
        </button>
        <button type="button" className={styles.articleRichToolBtn} onClick={() => editor.chain().focus().undo().run()} title="Undo">
          Undo
        </button>
        <button type="button" className={styles.articleRichToolBtn} onClick={() => editor.chain().focus().redo().run()} title="Redo">
          Redo
        </button>
      </div>
      <EditorContent editor={editor} className={styles.articleRichEditorInner} />
      <div className={styles.muted} style={{ fontSize: 11, padding: "6px 10px", borderTop: "1px solid var(--aa-hairline-soft)" }}>
        Stored as markdown; on publish the app converts to HTML for WordPress (same structure you see here).
      </div>
    </div>
  );
}
