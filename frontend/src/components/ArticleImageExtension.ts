import Image from "@tiptap/extension-image";
import { ReactNodeViewRenderer } from "@tiptap/react";

import { ArticleImageNodeView } from "./ArticleImageNodeView";

export type ArticleImageAlign = "left" | "center" | "right" | null;

const ALIGN_CLASSES: Record<Exclude<ArticleImageAlign, null>, string> = {
  left: "alignleft",
  center: "aligncenter",
  right: "alignright",
};

function alignFromClassList(classList: string | null | undefined): ArticleImageAlign {
  const classes = (classList || "").split(/\s+/);
  if (classes.includes("alignleft")) return "left";
  if (classes.includes("aligncenter")) return "center";
  if (classes.includes("alignright")) return "right";
  return null;
}

function widthFromStyle(style: string | null | undefined): number | null {
  const m = /width\s*:\s*(\d+(?:\.\d+)?)px/i.exec(style || "");
  return m ? Math.round(parseFloat(m[1])) : null;
}

/**
 * Block-level image node — inserted between paragraphs like Google Docs, not
 * an inline glyph. Extends the base extension (reuse its schema/commands)
 * rather than building a node from scratch.
 *
 * `width`/`align` are the only custom attrs. They render as `style`/`class`
 * on the `<img>` tag using WordPress's own standard alignment class names
 * (alignleft/aligncenter/alignright) so a connected WP theme's existing CSS
 * already knows how to style them — no bespoke class scheme to invent.
 */
export const ArticleImage = Image.extend({
  name: "articleImage",
  inline: false,
  group: "block",

  addAttributes() {
    return {
      ...this.parent?.(),
      width: {
        default: null as number | null,
        parseHTML: (element: HTMLElement) => widthFromStyle(element.getAttribute("style")),
        renderHTML: (attributes: { width: number | null }) => {
          if (!attributes.width) return {};
          return { style: `width:${attributes.width}px;height:auto;` };
        },
      },
      align: {
        default: null as ArticleImageAlign,
        parseHTML: (element: HTMLElement) => alignFromClassList(element.getAttribute("class")),
        renderHTML: (attributes: { align: ArticleImageAlign }) => {
          if (!attributes.align) return {};
          return { class: ALIGN_CLASSES[attributes.align] };
        },
      },
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(ArticleImageNodeView);
  },
});
