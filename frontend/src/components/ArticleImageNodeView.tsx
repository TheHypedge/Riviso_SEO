"use client";

import { useCallback, useRef, useState } from "react";
import { NodeViewWrapper } from "@tiptap/react";
import type { ReactNodeViewProps } from "@tiptap/react";

import editorStyles from "@/app/projects/[projectId]/articles/[articleId]/articleEditor.module.css";
import type { ArticleImageAlign } from "./ArticleImageExtension";

const MIN_WIDTH = 80;

type HandleCorner = "nw" | "ne" | "sw" | "se";

const HANDLES: { corner: HandleCorner; cursor: string; style: React.CSSProperties }[] = [
  { corner: "nw", cursor: "nwse-resize", style: { top: -5, left: -5 } },
  { corner: "ne", cursor: "nesw-resize", style: { top: -5, right: -5 } },
  { corner: "sw", cursor: "nesw-resize", style: { bottom: -5, left: -5 } },
  { corner: "se", cursor: "nwse-resize", style: { bottom: -5, right: -5 } },
];

export function ArticleImageNodeView({ node, updateAttributes, selected, deleteNode }: ReactNodeViewProps) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [dragWidth, setDragWidth] = useState<number | null>(null);

  const src = node.attrs.src as string;
  const alt = (node.attrs.alt as string) || "";
  const width = node.attrs.width as number | null;
  const align = node.attrs.align as ArticleImageAlign;

  const displayWidth = dragWidth ?? width ?? undefined;

  const startDrag = useCallback(
    (corner: HandleCorner, startEvent: React.MouseEvent) => {
      startEvent.preventDefault();
      startEvent.stopPropagation();
      const startX = startEvent.clientX;
      const startWidth = width ?? imgRef.current?.offsetWidth ?? 300;
      const isLeftHandle = corner === "nw" || corner === "sw";
      const containerWidth =
        wrapperRef.current?.closest<HTMLElement>(".articleProseMirror")?.clientWidth ??
        wrapperRef.current?.parentElement?.clientWidth ??
        Number.POSITIVE_INFINITY;

      function onMouseMove(e: MouseEvent) {
        const delta = e.clientX - startX;
        const rawWidth = isLeftHandle ? startWidth - delta : startWidth + delta;
        const clamped = Math.min(Math.max(rawWidth, MIN_WIDTH), containerWidth);
        setDragWidth(Math.round(clamped));
      }

      function onMouseUp() {
        window.removeEventListener("mousemove", onMouseMove);
        window.removeEventListener("mouseup", onMouseUp);
        setDragWidth((current) => {
          if (current != null) updateAttributes({ width: current });
          return null;
        });
      }

      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", onMouseUp);
    },
    [width, updateAttributes],
  );

  return (
    <NodeViewWrapper
      ref={wrapperRef}
      className={editorStyles.articleImageNodeView}
      data-align={align || undefined}
      data-selected={selected ? "true" : undefined}
      style={{ width: displayWidth ? `${displayWidth}px` : undefined }}
    >
      {selected ? (
        <div className={editorStyles.articleImageAlignRow} contentEditable={false}>
          {(["left", "center", "right"] as const).map((opt) => (
            <button
              key={opt}
              type="button"
              className={`${editorStyles.articleImageAlignBtn} ${editorStyles.editorTooltip}`}
              aria-pressed={align === opt}
              onClick={() => updateAttributes({ align: align === opt ? null : opt })}
              aria-label={`Align ${opt}`}
              data-tooltip={`Align ${opt}`}
            >
              {opt === "left" ? "⇤" : opt === "center" ? "≡" : "⇥"}
            </button>
          ))}
          <button
            type="button"
            className={`${editorStyles.articleImageDeleteBtn} ${editorStyles.editorTooltip}`}
            onClick={() => deleteNode()}
            aria-label="Remove image"
            data-tooltip="Remove image"
            data-tone="danger"
          >
            ×
          </button>
        </div>
      ) : null}

      <img
        ref={imgRef}
        src={src}
        alt={alt}
        style={{ width: displayWidth ? `${displayWidth}px` : undefined, height: "auto", display: "block" }}
        draggable={false}
      />

      {selected
        ? HANDLES.map((h) => (
            <div
              key={h.corner}
              className={editorStyles.articleImageHandle}
              style={{ ...h.style, cursor: h.cursor }}
              contentEditable={false}
              onMouseDown={(e) => startDrag(h.corner, e)}
            />
          ))
        : null}
    </NodeViewWrapper>
  );
}
