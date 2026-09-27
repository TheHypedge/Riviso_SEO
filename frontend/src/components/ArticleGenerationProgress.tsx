"use client";

import { useEffect, useRef, useState } from "react";

import styles from "./ArticleGenerationProgress.module.css";
import { api, type ArticleDetail } from "@/lib/api";
import { estimateGenerationProgress, formatEtaSeconds, milestoneCopy } from "@/lib/articleGenerationEta";
import { subscribeArticlePipelineStream, type PipelineEvent } from "@/lib/pipelineStream";

type Props = {
  projectId: string;
  articleId: string;
  /** Whether this run is expected to also generate a featured image -- shifts
   * the ETA total; without it the "featured_image" stage weight is excluded. */
  expectImage: boolean;
  /** The article's own `generated_at` before this run, if any -- lets the
   * completion poll tell "still the old draft" apart from "actually done." */
  previousGeneratedAt?: string | null;
  onComplete: (article: ArticleDetail) => void;
  onError: (message: string) => void;
};

/**
 * Shown in place of the (otherwise empty) editor body whenever this article's
 * generation is running somewhere other than a button click in this exact
 * tab -- opened mid-generation, or started elsewhere while this tab sits
 * open. Uses the low-level `subscribeArticlePipelineStream` directly (not
 * `createArticlePipelineMonitor`) specifically so it does NOT also trigger
 * the unrelated full-screen `GlobalLoadingProvider` overlay, which is reserved
 * for actions this tab itself initiated.
 *
 * The SSE channel has no replay (confirmed in `pipeline_streamer.py`), so a
 * client that subscribes mid-run knows nothing about which stage already
 * happened -- this renders an honest indeterminate state until the first
 * real event arrives, rather than guessing.
 */
export function ArticleGenerationProgress({ projectId, articleId, expectImage, previousGeneratedAt, onComplete, onError }: Props) {
  const [events, setEvents] = useState<PipelineEvent[]>([]);
  const [, forceTick] = useState(0);
  const settledRef = useRef(false);

  useEffect(() => {
    settledRef.current = false;
    const abort = new AbortController();

    void subscribeArticlePipelineStream(
      projectId,
      articleId,
      (ev) => setEvents((prev) => (prev.length && prev[prev.length - 1].message === ev.message ? prev : [...prev, ev])),
      abort.signal,
    ).catch(() => {
      /* stream ends on disconnect or Redis offline -- the completion poll below is the real source of truth */
    });

    api
      .waitForArticleGenerationComplete(projectId, articleId, { previousGeneratedAt, skipGlobalLoading: true })
      .then((article) => {
        if (settledRef.current) return;
        settledRef.current = true;
        onComplete(article);
      })
      .catch((e) => {
        if (settledRef.current) return;
        settledRef.current = true;
        onError(e instanceof Error ? e.message : "Article generation failed.");
      });

    return () => {
      abort.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, articleId]);

  // Re-render once a second so the within-stage ETA/percentage keeps advancing
  // between real SSE events, instead of only jumping on the next message.
  useEffect(() => {
    const id = window.setInterval(() => forceTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, []);

  const estimate = estimateGenerationProgress(events, expectImage);

  useEffect(() => {
    if (!estimate.isError || settledRef.current) return;
    settledRef.current = true;
    onError(estimate.latestMessage || "Article generation failed.");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [estimate.isError]);

  const etaText = formatEtaSeconds(estimate.etaSeconds);

  return (
    <div className={styles.card} role="status" aria-live="polite" aria-label="Article generation in progress">
      <div className={styles.iconWrap} aria-hidden="true">
        ✨
      </div>
      <p className={styles.headline}>Your article is being generated…</p>
      <p className={styles.statusLine}>{estimate.latestMessage || "Warming up the pipeline…"}</p>

      <div className={styles.barShell}>
        <div className={styles.track} data-indeterminate={estimate.indeterminate ? "true" : "false"}>
          <div className={styles.fill} style={estimate.indeterminate ? undefined : { width: `${estimate.pct}%` }} />
        </div>
        <div className={styles.metaRow}>
          <span>{estimate.indeterminate ? "Getting started…" : `${estimate.pct}%`}</span>
          <span>{etaText || ""}</span>
        </div>
      </div>

      {!estimate.indeterminate ? <p className={styles.milestone}>{milestoneCopy(estimate.pct)}</p> : null}
    </div>
  );
}
