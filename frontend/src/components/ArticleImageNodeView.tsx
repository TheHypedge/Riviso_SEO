"use client";

import { useCallback, useRef, useState } from "react";
import { NodeViewWrapper } from "@tiptap/react";
import type { ReactNodeViewProps } from "@tiptap/react";

import editorStyles from "@/app/projects/[projectId]/articles/[articleId]/articleEditor.module.css";
import type { ArticleImageAlign } from "./ArticleImageExtension";

const MIN_WIDTH = 80;
const MIN_HEIGHT = 40;

// Corners resize proportionally; the right/bottom edges change one dimension and crop
// (object-fit: cover) instead of stretching the picture.
type Handle = "nw" | "ne" | "sw" | "se" | "e" | "s";

const HANDLES: { handle: Handle; cursor: string; style: React.CSSProperties }[] = [
  { handle: "nw", cursor: "nwse-resize", style: { top: -5, left: -5 } },
  { handle: "ne", cursor: "nesw-resize", style: { top: -5, right: -5 } },
  { handle: "sw", cursor: "nesw-resize", style: { bottom: -5, left: -5 } },
  { handle: "se", cursor: "nwse-resize", style: { bottom: -5, right: -5 } },
  { handle: "e", cursor: "ew-resize", style: { top: "calc(50% - 6px)", right: -5 } },
  { handle: "s", cursor: "ns-resize", style: { bottom: -5, left: "calc(50% - 6px)" } },
];

type Size = { width: number; height: number | null };

export function ArticleImageNodeView({ node, updateAttributes, selected, deleteNode }: ReactNodeViewProps) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [dragSize, setDragSize] = useState<Size | null>(null);

  const src = node.attrs.src as string;
  const alt = (node.attrs.alt as string) || "";
  const width = node.attrs.width as number | null;
  const height = node.attrs.height as number | null;
  const align = node.attrs.align as ArticleImageAlign;

  const displayWidth = dragSize?.width ?? width ?? undefined;
  const displayHeight = dragSize ? dragSize.height : height;

  const startDrag = useCallback(
    (handle: Handle, startEvent: React.MouseEvent) => {
      startEvent.preventDefault();
      startEvent.stopPropagation();
      const startX = startEvent.clientX;
      const startY = startEvent.clientY;
      const startWidth = width ?? imgRef.current?.offsetWidth ?? 300;
      const startHeight = height ?? imgRef.current?.offsetHeight ?? null;
      const isLeftHandle = handle === "nw" || handle === "sw";
      const containerWidth = wrapperRef.current?.parentElement?.clientWidth ?? Number.POSITIVE_INFINITY;
      let latest: Size | null = null;

      function onMouseMove(e: MouseEvent) {
        const dx = e.clientX - startX;
        if (handle === "s") {
          const h = Math.max(MIN_HEIGHT, Math.round((startHeight ?? 200) + e.clientY - startY));
          latest = { width: Math.round(startWidth), height: h };
        } else {
          const rawWidth = isLeftHandle ? startWidth - dx : startWidth + dx;
          const w = Math.round(Math.min(Math.max(rawWidth, MIN_WIDTH), containerWidth));
          // Edge keeps the current height (crops); corners keep the crop's aspect ratio.
          const h =
            handle === "e"
              ? startHeight
              : height && startHeight
                ? Math.max(MIN_HEIGHT, Math.round((startHeight * w) / startWidth))
                : null;
          latest = { width: w, height: h };
        }
        setDragSize(latest);
      }

      function onMouseUp() {
        window.removeEventListener("mousemove", onMouseMove);
        window.removeEventListener("mouseup", onMouseUp);
        if (latest) updateAttributes({ width: latest.width, height: latest.height });
        setDragSize(null);
      }

      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", onMouseUp);
    },
    [width, height, updateAttributes],
  );

  return (
    <NodeViewWrapper
      ref={wrapperRef}
      className={editorStyles.articleImageNodeView}
      data-drag-handle=""
      draggable="true"
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
          {width || height ? (
            <button
              type="button"
              className={`${editorStyles.articleImageAlignBtn} ${editorStyles.editorTooltip}`}
              onClick={() => updateAttributes({ width: null, height: null })}
              aria-label="Reset size and crop"
              data-tooltip="Reset size and crop"
            >
              ↺
            </button>
          ) : null}
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
        style={{
          width: displayWidth ? `${displayWidth}px` : undefined,
          height: displayHeight ? `${displayHeight}px` : "auto",
          objectFit: displayHeight ? "cover" : undefined,
          display: "block",
        }}
        draggable={false}
      />

      {selected
        ? HANDLES.map((h) => (
            <div
              key={h.handle}
              className={editorStyles.articleImageHandle}
              style={{ ...h.style, cursor: h.cursor }}
              contentEditable={false}
              onMouseDown={(e) => startDrag(h.handle, e)}
            />
          ))
        : null}
    </NodeViewWrapper>
  );
}
