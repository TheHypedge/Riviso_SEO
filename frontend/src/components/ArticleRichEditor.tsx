"use client";

import LinkExt from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import Highlight from "@tiptap/extension-highlight";
import { TableKit } from "@tiptap/extension-table";
import TextAlign from "@tiptap/extension-text-align";
import { EditorContent, useEditor } from "@tiptap/react";
import type { Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useMemo, useRef, useState } from "react";
import TurndownService from "turndown";

import styles from "@/app/page.module.css";
import { EditorLinesSkeleton } from "@/components/skeleton";
import { markdownToArticleHtml } from "@/lib/articleMarkdown";
import { ArticleImage } from "@/components/ArticleImageExtension";

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});

// Inline article images (Insert Media) carry width/alignment that plain
// `![alt](src)` markdown can't represent — always emit a raw <img> tag
// instead (both Turndown's caller and `marked`/CommonMark on the way back in
// pass inline raw HTML through untouched, so this round-trips losslessly).
// getAttribute() returns decoded values, so re-escape them: an AI alt text with a
// quote in it would otherwise close the attribute early and break the tag.
const attr = (v: string) => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
turndown.addRule("articleImage", {
  filter: "img",
  replacement: (_content, node) => {
    const el = node as HTMLImageElement;
    const src = el.getAttribute("src") || "";
    if (!src) return "";
    const alt = el.getAttribute("alt") || "";
    const style = el.getAttribute("style");
    const className = el.getAttribute("class");
    let tag = `<img src="${attr(src)}" alt="${attr(alt)}"`;
    if (style) tag += ` style="${attr(style)}"`;
    if (className) tag += ` class="${attr(className)}"`;
    tag += ">";
    return tag;
  },
});

// Tables: emit GFM pipe tables (what generation writes and what the WordPress publish
// path's Python-Markdown "extra" renders). Without this rule Turndown flattened every
// table into one run-on paragraph and the next save destroyed it.
const cellText = (cell: Element) =>
  turndown
    .turndown((cell as HTMLElement).innerHTML || "")
    .replace(/\n+/g, " ")
    .replace(/\|/g, "\\|")
    .trim();
turndown.addRule("gfmTable", {
  filter: "table",
  replacement: (_content, node) => {
    const rows = Array.from((node as HTMLTableElement).querySelectorAll("tr")).map((tr) =>
      Array.from(tr.children).map(cellText),
    );
    if (!rows.length) return "";
    const cols = Math.max(...rows.map((r) => r.length));
    const line = (r: string[]) => `| ${Array.from({ length: cols }, (_, i) => r[i] ?? "").join(" | ")} |`;
    const [head, ...body] = rows;
    return `\n\n${[line(head), `|${" --- |".repeat(cols)}`, ...body.map(line)].join("\n")}\n\n`;
  },
});

// Formatting markdown has no syntax for (and Python-Markdown on the WordPress publish
// path doesn't support ~~strike~~ either) is kept as raw inline HTML, which both
// `marked` (editor) and Python-Markdown (WordPress) pass through untouched.
turndown.keep(["u", "s", "del", "mark", "sub", "sup"]);

// Shift+Enter line break as a raw <br>: Markdown's two-trailing-spaces break is
// stripped by the backend's body sanitizer, so WordPress joined the lines.
turndown.addRule("lineBreak", { filter: "br", replacement: () => "<br>" });

// Centered/right/justified paragraphs and headings: keep the whole block as raw HTML
// so the text-align style reaches WordPress (left = default, renders no style).
turndown.addRule("alignedBlock", {
  filter: (node) =>
    /^(P|H[1-6])$/.test(node.nodeName) &&
    node.parentNode?.nodeName !== "LI" &&
    /text-align/i.test(node.getAttribute("style") || ""),
  replacement: (_content, node) => `\n\n${(node as HTMLElement).outerHTML}\n\n`,
});

// tiptap wraps every list item's text in <p>; without this Turndown emits a "loose"
// list (blank line between items) that WordPress renders with paragraph gaps.
turndown.addRule("listItemParagraph", {
  filter: (node) => node.nodeName === "P" && node.parentNode?.nodeName === "LI",
  replacement: (content, node) => (node.nextSibling ? `${content}\n` : content),
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
  onEditorReady?: (editor: Editor, normalizedBody: string) => void;
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
      ArticleImage,
      TableKit.configure({ table: { resizable: false } }),
      TextAlign.configure({ types: ["heading", "paragraph"] }),
      Highlight,
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
      const normalizedMd = htmlToMarkdown(editor.getHTML());
      lastSentMd.current = normalizedMd;
      onEditorReady(editor, normalizedMd);
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
