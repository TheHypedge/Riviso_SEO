"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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

const FOCUS_PRESETS: { label: string; tip: string; focus: string }[] = [
  { label: "⤒", tip: "Show the top", focus: "50% 0%" },
  { label: "◎", tip: "Show the centre", focus: "50% 50%" },
  { label: "⤓", tip: "Show the bottom", focus: "50% 100%" },
];

function parseFocus(f: string | null | undefined): [number, number] {
  const m = /(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%/.exec(f || "");
  return m ? [Math.min(100, +m[1]), Math.min(100, +m[2])] : [50, 50];
}

const clamp = (v: number) => Math.round(Math.min(100, Math.max(0, v)) * 10) / 10;

export function ArticleImageNodeView({ node, updateAttributes, selected, deleteNode, editor, getPos }: ReactNodeViewProps) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [dragSize, setDragSize] = useState<Size | null>(null);
  // Reposition mode (double-click a cropped image): drag the picture inside its crop frame.
  // Live position stays local while dragging and is committed once, on release.
  const [repositionOn, setRepositionOn] = useState(false);
  const [liveFocus, setLiveFocus] = useState<string | null>(null);

  const src = node.attrs.src as string;
  const alt = (node.attrs.alt as string) || "";
  const width = node.attrs.width as number | null;
  const height = node.attrs.height as number | null;
  const align = node.attrs.align as ArticleImageAlign;
  const focus = (node.attrs.focus as string | null) || null;

  const displayWidth = dragSize?.width ?? width ?? undefined;
  const displayHeight = dragSize ? dragSize.height : height;
  const cropped = Boolean(displayHeight);
  const repositioning = repositionOn && selected && cropped;
  const shownFocus = liveFocus ?? focus ?? "50% 50%";

  const startReposition = useCallback(
    (e: React.PointerEvent<HTMLImageElement>) => {
      const img = imgRef.current;
      if (!repositioning || !img || !img.naturalWidth) return;
      e.preventDefault();
      e.stopPropagation();
      img.setPointerCapture(e.pointerId);
      const boxW = img.clientWidth;
      const boxH = img.clientHeight;
      const scale = Math.max(boxW / img.naturalWidth, boxH / img.naturalHeight);
      const spareX = img.naturalWidth * scale - boxW; // how far the picture can move inside the frame
      const spareY = img.naturalHeight * scale - boxH;
      const [fx, fy] = parseFocus(focus);
      const sx = e.clientX;
      const sy = e.clientY;
      let latest = `${fx}% ${fy}%`;
      const move = (ev: PointerEvent) => {
        const nx = spareX > 0 ? clamp(fx - ((ev.clientX - sx) / spareX) * 100) : fx;
        const ny = spareY > 0 ? clamp(fy - ((ev.clientY - sy) / spareY) * 100) : fy;
        latest = `${nx}% ${ny}%`;
        setLiveFocus(latest);
      };
      const up = () => {
        img.removeEventListener("pointermove", move);
        img.removeEventListener("pointerup", up);
        img.removeEventListener("pointercancel", up);
        updateAttributes({ focus: latest });
        setLiveFocus(null);
      };
      img.addEventListener("pointermove", move);
      img.addEventListener("pointerup", up);
      img.addEventListener("pointercancel", up);
    },
    [repositioning, focus, updateAttributes],
  );

  // Keys reach the editor root, not this node, so listen on window (capture) while repositioning:
  // arrows nudge the picture instead of moving the caret; Enter/Escape finish.
  useEffect(() => {
    if (!repositioning) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setRepositionOn(false);
        return;
      }
      const step = e.shiftKey ? 10 : 2;
      const d = ({ ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] } as Record<string, number[]>)[e.key];
      if (!d) return;
      e.preventDefault();
      e.stopPropagation();
      const [x, y] = parseFocus(focus);
      updateAttributes({ focus: `${clamp(x + d[0])}% ${clamp(y + d[1])}%` });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [repositioning, focus, updateAttributes]);

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
        // A click on a handle jitters a pixel or two; that must not pin an explicit size on the
        // image (which would mark the article as edited). Resizing starts after a 3px drag.
        if (!latest && Math.abs(dx) < 3 && Math.abs(e.clientY - startY) < 3) return;
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
      data-drag-handle={repositioning ? undefined : ""}
      draggable={repositioning ? "false" : "true"}
      data-align={align || undefined}
      data-selected={selected ? "true" : undefined}
      data-repositioning={repositioning ? "true" : undefined}
      style={{ width: displayWidth ? `${displayWidth}px` : cropped ? "100%" : undefined }}
    >
      {selected ? (
        // mousedown default would move focus to the button and drop the image's node selection.
        <div className={editorStyles.articleImageAlignRow} contentEditable={false} onMouseDown={(e) => e.preventDefault()}>
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
          {cropped ? (
            <>
              <span className={editorStyles.articleImageToolbarSep} aria-hidden="true" />
              <button
                type="button"
                className={`${editorStyles.articleImageAlignBtn} ${editorStyles.editorTooltip}`}
                aria-pressed={repositioning}
                onClick={() => setRepositionOn((v) => !v)}
                aria-label={repositioning ? "Done repositioning" : "Reposition image in crop"}
                data-tooltip={repositioning ? "Done (Enter)" : "Reposition (or double-click)"}
              >
                ✥
              </button>
              {FOCUS_PRESETS.map((p) => (
                <button
                  key={p.focus}
                  type="button"
                  className={`${editorStyles.articleImageAlignBtn} ${editorStyles.editorTooltip}`}
                  aria-pressed={(focus || "50% 50%") === p.focus}
                  onClick={() => updateAttributes({ focus: p.focus })}
                  aria-label={p.tip}
                  data-tooltip={p.tip}
                >
                  {p.label}
                </button>
              ))}
            </>
          ) : null}
          {width || height ? (
            <button
              type="button"
              className={`${editorStyles.articleImageAlignBtn} ${editorStyles.editorTooltip}`}
              onClick={() => {
                setRepositionOn(false);
                updateAttributes({ width: null, height: null, focus: null });
              }}
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
          width: displayWidth ? `${displayWidth}px` : cropped ? "100%" : undefined,
          height: displayHeight ? `${displayHeight}px` : "auto",
          objectFit: displayHeight ? "cover" : undefined,
          objectPosition: cropped ? shownFocus : undefined,
          display: "block",
          cursor: repositioning ? "move" : undefined,
          touchAction: repositioning ? "none" : undefined,
        }}
        draggable={false}
        onDoubleClick={() => {
          if (!cropped) return;
          const pos = typeof getPos === "function" ? getPos() : undefined;
          if (typeof pos === "number") editor.commands.setNodeSelection(pos);
          setRepositionOn(true);
        }}
        onPointerDown={startReposition}
      />
      {repositioning ? (
        <div className={editorStyles.articleImageRepositionHint} contentEditable={false} aria-live="polite">
          Drag to choose what shows · arrow keys nudge · Enter when done
        </div>
      ) : null}

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
