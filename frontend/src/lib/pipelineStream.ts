/**
 * Live article pipeline events via Server-Sent Events (fetch + httpOnly auth cookie).
 */

import { getApiBaseUrl } from "@/lib/api";

export type PipelineEvent = {
  time: string;
  message: string;
  stage: string;
};

export const PIPELINE_STAGE_LABELS: Record<string, string> = {
  connected: "Connected",
  queued: "Queued",
  worker_start: "Worker",
  internal_links: "Internal links",
  openai_dispatch: "OpenAI",
  integrity_verify: "Integrity",
  humanization: "Humanization",
  featured_image: "Featured image",
  publish_dispatch: "Publishing",
  complete: "Complete",
  error: "Error",
  init: "Starting",
};

const STAGE_PROGRESS_ORDER = [
  "init",
  "queued",
  "connected",
  "worker_start",
  "internal_links",
  "openai_dispatch",
  "integrity_verify",
  "humanization",
  "featured_image",
  "publish_dispatch",
  "complete",
] as const;

export function pipelineStageProgress(stage: string | undefined): number {
  const s = (stage || "").trim().toLowerCase();
  if (s === "error") return 0;
  if (s === "complete") return 100;
  const idx = STAGE_PROGRESS_ORDER.indexOf(s as (typeof STAGE_PROGRESS_ORDER)[number]);
  if (idx < 0) return 12;
  return Math.round(((idx + 1) / STAGE_PROGRESS_ORDER.length) * 100);
}

function parseSseBlock(block: string): PipelineEvent | null {
  for (const line of block.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const raw = trimmed.slice(5).trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as Partial<PipelineEvent>;
      if (typeof parsed.message === "string") {
        return {
          time: typeof parsed.time === "string" ? parsed.time : new Date().toISOString(),
          message: parsed.message,
          stage: typeof parsed.stage === "string" ? parsed.stage : "",
        };
      }
    } catch {
      return { time: new Date().toISOString(), message: raw, stage: "" };
    }
  }
  return null;
}

export async function subscribeArticlePipelineStream(
  projectId: string,
  articleId: string,
  onEvent: (event: PipelineEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const path = `/api/projects/${encodeURIComponent(projectId)}/articles/${encodeURIComponent(articleId)}/events`;
  const base = getApiBaseUrl();
  const url = `${base}${path.startsWith("/") ? path : `/${path}`}`;
  // S1.3: authenticated via the httpOnly aa_access cookie (credentials: "include").
  const headers: Record<string, string> = { Accept: "text/event-stream" };

  const res = await fetch(url, {
    method: "GET",
    headers,
    credentials: "include",
    signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `Pipeline stream failed (${res.status})`);
  }
  if (!res.body) {
    throw new Error("Pipeline stream returned no body");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() || "";
    for (const block of chunks) {
      if (!block.trim() || block.trim().startsWith(":")) continue;
      const ev = parseSseBlock(block);
      if (ev) onEvent(ev);
    }
  }
}

function emitPipelineProgress(events: PipelineEvent[], active: boolean) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent("aa:pipelineProgress", {
      detail: { events, active },
    }),
  );
}

export type ArticlePipelineMonitor = {
  start: (initialMessage?: string) => void;
  stop: () => void;
};

export function createArticlePipelineMonitor(projectId: string, articleId: string): ArticlePipelineMonitor {
  const abort = new AbortController();
  let started = false;
  let events: PipelineEvent[] = [];

  const push = (ev: PipelineEvent) => {
    const last = events[events.length - 1];
    if (last && last.message === ev.message && last.stage === ev.stage) return;
    events = [...events, ev];
    emitPipelineProgress(events, true);
  };

  return {
    start(initialMessage?: string) {
      if (started) return;
      started = true;
      events = [];
      if (initialMessage) {
        push({
          time: new Date().toISOString(),
          message: initialMessage,
          stage: "init",
        });
      }
      emitPipelineProgress(events, true);
      window.dispatchEvent(new CustomEvent("aa:loading", { detail: { delta: 1 } }));
      void subscribeArticlePipelineStream(
        projectId,
        articleId,
        push,
        abort.signal,
      ).catch(() => {
        /* stream ends on disconnect or Redis offline — overlay still shows polled work */
      });
    },
    stop() {
      if (!started) return;
      started = false;
      abort.abort();
      window.setTimeout(() => {
        window.dispatchEvent(new CustomEvent("aa:loading", { detail: { delta: -1 } }));
        emitPipelineProgress(events, false);
      }, 700);
    },
  };
}

/** Open SSE stream for the duration of an async operation (generate, publish, etc.). */
export async function runWithArticlePipelineMonitor<T>(
  projectId: string,
  articleId: string,
  fn: () => Promise<T>,
  opts?: { initialMessage?: string },
): Promise<T> {
  const monitor = createArticlePipelineMonitor(projectId, articleId);
  monitor.start(opts?.initialMessage ?? "Starting pipeline…");
  try {
    return await fn();
  } finally {
    monitor.stop();
  }
}
