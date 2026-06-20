"use client";

import LinkExt from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import { EditorContent, useEditor } from "@tiptap/react";
import type { Editor } from "@tiptap/react";
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

export type BlockFormat = "paragraph" | "heading-1" | "heading-2" | "heading-3" | "heading-4" | "heading-5" | "heading-6";

export const BLOCK_FORMAT_OPTIONS: { value: BlockFormat; label: string }[] = [
  { value: "paragraph", label: "Paragraph" },
  { value: "heading-1", label: "Heading 1" },
  { value: "heading-2", label: "Heading 2" },
  { value: "heading-3", label: "Heading 3" },
  { value: "heading-4", label: "Heading 4" },
  { value: "heading-5", label: "Heading 5" },
  { value: "heading-6", label: "Heading 6" },
];

export function activeBlockFormat(editor: { isActive: (name: string, attrs?: Record<string, unknown>) => boolean }): BlockFormat {
  for (let level = 1; level <= 6; level += 1) {
    if (editor.isActive("heading", { level })) return `heading-${level}` as BlockFormat;
  }
  return "paragraph";
}

export type ArticleRichEditorProps = {
  value: string;
  onChange: (markdown: string) => void;
  placeholder?: string;
  contentRevision?: number;
  onEditorReady?: (editor: Editor) => void;
};

export function ArticleRichEditor({ value, onChange, placeholder, contentRevision = 0, onEditorReady }: ArticleRichEditorProps) {
  const syncingFromParent = useRef(false);
  const lastSentMd = useRef<string>((value || "").trim());
  const [, setBlockFormat] = useState<BlockFormat>("paragraph");
  const editorReadyFired = useRef(false);

  const extensions = useMemo(
    () => [
      StarterKit.configure({
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
        lastSentMd.current = md;
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
    if (editor && onEditorReady && !editorReadyFired.current) {
      editorReadyFired.current = true;
      onEditorReady(editor);
    }
  }, [editor, onEditorReady]);

  useEffect(() => {
    if (!editor) return;
    const incomingMd = (value || "").trim();
    if (incomingMd === lastSentMd.current.trim()) return;
    syncingFromParent.current = true;
    editor.commands.setContent(markdownToArticleHtml(value), { emitUpdate: false });
    lastSentMd.current = incomingMd;
    queueMicrotask(() => {
      syncingFromParent.current = false;
      setBlockFormat(activeBlockFormat(editor));
    });
  }, [value, editor, contentRevision]);

  if (!editor) {
    return <EditorLinesSkeleton lines={6} />;
  }

  return (
    <div className={styles.articleRichEditorWrap}>
      <EditorContent editor={editor} className={styles.articleRichEditorInner} />
    </div>
  );
}

export { type Editor } from "@tiptap/react";
