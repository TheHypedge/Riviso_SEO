/**
 * Weighted progress/ETA estimate for a running article-generation pipeline.
 *
 * No stage-duration data exists anywhere in the backend (checked) -- these
 * weights are a hand-picked, clearly-labeled *estimate* based on which stage
 * is known to dominate (openai_dispatch, the actual LLM call), not a measured
 * average. `pipelineStageProgress()` in pipelineStream.ts already exists but
 * splits progress evenly across stage *slots*, which visibly stalls near
 * 40-50% for most of the real wait -- this weights by expected seconds
 * instead, and interpolates within the current stage using real elapsed time
 * rather than jumping only on the next event.
 */

import type { PipelineEvent } from "@/lib/pipelineStream";
import { PIPELINE_STAGE_LABELS } from "@/lib/pipelineStream";

export const STAGE_WEIGHTS_SECONDS: Record<string, number> = {
  queued: 4,
  worker_start: 1,
  internal_links: 3,
  openai_dispatch: 40,
  integrity_verify: 3,
  featured_image: 20,
  complete: 0,
};

const STAGE_ORDER = ["queued", "worker_start", "internal_links", "openai_dispatch", "integrity_verify", "featured_image", "complete"] as const;

const MILESTONE_COPY: { at: number; text: string }[] = [
  { at: 0, text: "Warming up the pipeline…" },
  { at: 15, text: "Getting started…" },
  { at: 45, text: "Making good progress…" },
  { at: 75, text: "Almost there!" },
  { at: 92, text: "Just polishing the final touches…" },
];

export function milestoneCopy(pct: number): string {
  let text = MILESTONE_COPY[0].text;
  for (const m of MILESTONE_COPY) {
    if (pct >= m.at) text = m.text;
  }
  return text;
}

export type GenerationProgressEstimate = {
  pct: number;
  etaSeconds: number | null;
  indeterminate: boolean;
  stageLabel: string;
  latestMessage: string | null;
  isError: boolean;
};

/** `now` is injectable for tests; defaults to the real clock. */
export function estimateGenerationProgress(
  events: PipelineEvent[],
  expectImage: boolean,
  now: number = Date.now(),
): GenerationProgressEstimate {
  const relevantStages: string[] = expectImage ? [...STAGE_ORDER] : STAGE_ORDER.filter((s) => s !== "featured_image");
  const totalSeconds = relevantStages.reduce((sum, s) => sum + STAGE_WEIGHTS_SECONDS[s], 0) || 1;

  const last = events[events.length - 1];
  if (!last) {
    return { pct: 0, etaSeconds: null, indeterminate: true, stageLabel: "Starting", latestMessage: null, isError: false };
  }

  const stage = (last.stage || "").trim().toLowerCase();
  if (stage === "error") {
    return { pct: 0, etaSeconds: null, indeterminate: false, stageLabel: "Error", latestMessage: last.message, isError: true };
  }
  if (stage === "complete") {
    return { pct: 100, etaSeconds: 0, indeterminate: false, stageLabel: "Complete", latestMessage: last.message, isError: false };
  }

  const idx = relevantStages.indexOf(stage);
  if (idx < 0) {
    // Unknown/connected/init stage -- treat as "just started", not an error.
    return { pct: 2, etaSeconds: totalSeconds, indeterminate: false, stageLabel: PIPELINE_STAGE_LABELS[stage] || "Working", latestMessage: last.message, isError: false };
  }

  const elapsedBeforeCurrent = relevantStages.slice(0, idx).reduce((sum, s) => sum + STAGE_WEIGHTS_SECONDS[s], 0);
  const currentWeight = STAGE_WEIGHTS_SECONDS[stage] || 1;
  const stageStartedAt = new Date(last.time).getTime();
  const secondsIntoStage = Number.isFinite(stageStartedAt) ? Math.max(0, (now - stageStartedAt) / 1000) : 0;
  // Never let time-in-stage alone claim more than 92% of that stage's own
  // weight -- only a real event for the *next* stage should cross that
  // threshold, so the bar never falsely claims a stage finished on its own.
  const withinStageSeconds = Math.min(currentWeight * 0.92, secondsIntoStage);

  const elapsedSeconds = elapsedBeforeCurrent + withinStageSeconds;
  const pct = Math.min(99, Math.round((elapsedSeconds / totalSeconds) * 100));
  const etaSeconds = Math.max(0, Math.round(totalSeconds - elapsedSeconds));

  return {
    pct,
    etaSeconds,
    indeterminate: false,
    stageLabel: PIPELINE_STAGE_LABELS[stage] || stage.replace(/_/g, " "),
    latestMessage: last.message,
    isError: false,
  };
}

export function formatEtaSeconds(seconds: number | null): string | null {
  if (seconds === null) return null;
  if (seconds <= 5) return "Almost done…";
  if (seconds < 60) return `About ${seconds}s left`;
  const mins = Math.round(seconds / 60);
  return `About ${mins} minute${mins === 1 ? "" : "s"} left`;
}
