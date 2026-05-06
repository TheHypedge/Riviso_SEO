"use client";

import LinkExt from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { marked } from "marked";
import { useEffect, useMemo, useRef } from "react";
import TurndownService from "turndown";

import styles from "@/app/page.module.css";

marked.setOptions({ gfm: true, breaks: true });

function markdownToHtml(src: string): string {
  const t = (src || "").trim();
  if (!t) return "<p></p>";
  const html = marked.parse(t, { async: false });
  return typeof html === "string" ? html : "<p></p>";
}

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});

function htmlToMarkdown(html: string): string {
  const md = turndown.turndown(html || "").trim();
  return md;
}

export type ArticleRichEditorProps = {
  value: string;
  onChange: (markdown: string) => void;
  disabled?: boolean;
  placeholder?: string;
};

export function ArticleRichEditor({ value, onChange, disabled, placeholder }: ArticleRichEditorProps) {
  const skipExternalSync = useRef(false);

  const extensions = useMemo(
    () => [
      StarterKit.configure({
        heading: { levels: [2, 3, 4] },
      }),
      Placeholder.configure({
        placeholder: placeholder || "Write your article… Headings, lists, and bold styling match what WordPress will receive as formatted HTML after publish.",
      }),
      LinkExt.configure({
        openOnClick: false,
        autolink: true,
        HTMLAttributes: { rel: "noopener noreferrer", target: "_blank", class: "article-editor-link" },
      }),
    ],
    [placeholder],
  );

  const editor = useEditor(
    {
      immediatelyRender: false,
      extensions,
      editable: !disabled,
      content: markdownToHtml(value),
      editorProps: {
        attributes: {
          class: styles.articleProseMirror,
          spellCheck: "true",
        },
      },
      onUpdate: ({ editor: ed }) => {
        const md = htmlToMarkdown(ed.getHTML());
        skipExternalSync.current = true;
        onChange(md);
      },
    },
    [extensions],
  );

  useEffect(() => {
    if (!editor) return;
    editor.setEditable(!disabled);
  }, [editor, disabled]);

  useEffect(() => {
    if (!editor) return;
    if (skipExternalSync.current) {
      skipExternalSync.current = false;
      return;
    }
    const html = markdownToHtml(value);
    const cur = editor.getHTML();
    if (cur.trim() === html.trim()) return;
    editor.commands.setContent(html, { emitUpdate: false });
  }, [value, editor]);

  if (!editor) {
    return <div className={styles.muted} style={{ padding: 12 }}>Loading editor…</div>;
  }

  return (
    <div className={`${styles.articleRichEditorWrap} ${disabled ? styles.articleRichEditorReadonly : ""}`}>
      {!disabled ? (
        <div className={styles.articleRichToolbar} role="toolbar" aria-label="Formatting">
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
            onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
            aria-pressed={editor.isActive("heading", { level: 2 })}
            title="Heading 2"
          >
            H2
          </button>
          <button
            type="button"
            className={styles.articleRichToolBtn}
            onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
            aria-pressed={editor.isActive("heading", { level: 3 })}
            title="Heading 3"
          >
            H3
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
      ) : null}
      <EditorContent editor={editor} className={styles.articleRichEditorInner} />
      {disabled ? (
        <div className={styles.muted} style={{ fontSize: 11, padding: "6px 10px", borderTop: "1px solid var(--aa-hairline-soft)" }}>
          Published — read only. WordPress received this content as formatted HTML converted from the same markdown.
        </div>
      ) : (
        <div className={styles.muted} style={{ fontSize: 11, padding: "6px 10px", borderTop: "1px solid var(--aa-hairline-soft)" }}>
          Stored as markdown; on publish the app converts to HTML for WordPress (same structure you see here).
        </div>
      )}
    </div>
  );
}
