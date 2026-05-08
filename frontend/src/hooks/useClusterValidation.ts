"use client";

/**
 * useClusterValidation — Existence & Intent Validation for the Cluster Planner.
 *
 * Given the topics rendered in a Topic Cluster card (one Pillar + N Cluster
 * articles), this hook calls the backend's ``POST /validate-clusters`` endpoint
 * and returns a stable map of ``temp_id → { status, reason, existing_url, … }``
 * which the UI uses to render badges and gate the "Generate all" button.
 *
 * Design notes:
 *
 * - **Non-blocking**: the hook never throws into render. On error it returns
 *   ``error`` and the UI keeps showing the previous results (or "VALIDATING…").
 * - **Abortable**: every new request cancels the in-flight one via
 *   ``AbortController`` so a fast-typing user (or rapid cluster reloads) never
 *   keeps stale promises around.
 * - **Stable input fingerprint**: we hash the items to a deterministic string
 *   so React doesn't re-fire the effect when the parent re-renders with a
 *   semantically identical list (a brand-new array reference each render is
 *   normal in React, and would otherwise spam the network).
 * - **Debounced**: a small debounce coalesces the burst of state updates that
 *   typically follow a cluster plan / regeneration completing.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import {
  api,
  ApiError,
  ClusterValidationItemPayload,
  ClusterValidationOutcome,
  ClusterValidationResponse,
  ClusterValidationStatus,
} from "@/lib/api";

export type ValidatableTopic = {
  /** Stable per-render id used to key results (e.g. ``"<clusterId>:<pillar|topic_id>"``). */
  temp_id: string;
  title: string;
  focus_keyphrase?: string;
  keywords?: string[];
  /** When true, skip validation for this topic (already imported / generated). */
  skip?: boolean;
};

export type ClusterValidationEntry = ClusterValidationOutcome & {
  /** When ``true`` the request is in-flight and the badge should show a loading style. */
  loading: boolean;
};

export type UseClusterValidationResult = {
  /** Map of ``temp_id`` → outcome. ``loading`` is per-entry. */
  results: Record<string, ClusterValidationEntry>;
  /** True while at least one batch is in flight. */
  loading: boolean;
  /** Last hard error from the API (excluding aborts). UI may surface this. */
  error: string | null;
  /** Optional metadata from the most recent successful response. */
  meta: {
    cacheAgeSeconds: number | null;
    cacheRefreshStarted: boolean;
    embeddingUsed: boolean;
    elapsedMs: number;
  } | null;
  /** Manual re-check (e.g. for a "Re-check" button on the cluster card). */
  refetch: () => void;
};

const DEBOUNCE_MS = 180;

function makeFingerprint(items: ValidatableTopic[]): string {
  // Order-stable, omits empty entries; fingerprint changes only when the
  // set of validatable topics actually changes.
  return items
    .filter((it) => !it.skip && (it.title || "").trim())
    .map((it) =>
      [
        it.temp_id,
        (it.title || "").trim().toLowerCase(),
        (it.focus_keyphrase || "").trim().toLowerCase(),
        (it.keywords || []).map((k) => (k || "").trim().toLowerCase()).join("|"),
      ].join("§"),
    )
    .join("\n");
}

export function useClusterValidation(
  projectId: string | undefined,
  topics: ValidatableTopic[],
  options?: { enabled?: boolean; threshold?: number },
): UseClusterValidationResult {
  const enabled = options?.enabled !== false && !!projectId;
  const threshold = options?.threshold ?? 0.8;

  const [results, setResults] = useState<Record<string, ClusterValidationEntry>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useState<UseClusterValidationResult["meta"]>(null);
  // Bumping this triggers a re-fetch even when the fingerprint hasn't changed.
  const [refreshTick, setRefreshTick] = useState(0);

  const fingerprint = useMemo(() => makeFingerprint(topics), [topics]);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!enabled || !projectId) return;
    if (!fingerprint) {
      // Defer to a microtask so the synchronous-setState-in-effect lint
      // is satisfied; this also lets concurrent React batch the reset
      // alongside other parent commits without an extra render.
      queueMicrotask(() => setResults({}));
      return;
    }

    // Compute the validatable subset right here so we don't re-derive it from
    // the fingerprint and risk drift.
    const items: ClusterValidationItemPayload[] = topics
      .filter((t) => !t.skip && (t.title || "").trim())
      .map((t) => ({
        temp_id: t.temp_id,
        title: t.title,
        focus_keyphrase: t.focus_keyphrase || "",
        keywords: t.keywords || [],
      }));

    if (items.length === 0) {
      queueMicrotask(() => setResults({}));
      return;
    }

    // Eagerly mark every requested item as "validating" so the UI can render
    // the grey VALIDATING badge instantly while the network call settles.
    // Wrapped in queueMicrotask to satisfy the React 19 set-state-in-effect lint
    // — semantics are unchanged: the badge still flips to "validating" before
    // the next paint.
    queueMicrotask(() =>
      setResults((prev) => {
        const next: Record<string, ClusterValidationEntry> = { ...prev };
        for (const it of items) {
          const existing = prev[it.temp_id];
          next[it.temp_id] = {
            status: existing?.status ?? "new",
            reason: existing?.reason ?? "Validating against your library and live site…",
            existing_url: existing?.existing_url ?? null,
            existing_article_id: existing?.existing_article_id ?? null,
            similarity: existing?.similarity ?? null,
            loading: true,
          };
        }
        return next;
      })
    );

    // Cancel any in-flight request before kicking off a new one.
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    const debounce = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const resp: ClusterValidationResponse = await api.validateClusterTopics(
          projectId,
          { items, similarity_threshold: threshold },
          ctrl.signal,
        );
        if (ctrl.signal.aborted) return;

        setResults((prev) => {
          const next: Record<string, ClusterValidationEntry> = { ...prev };
          for (const it of items) {
            const r = resp.results?.[it.temp_id];
            if (r) {
              next[it.temp_id] = { ...r, loading: false };
            } else {
              // Backend silently dropped a row (shouldn't happen) — clear loading.
              next[it.temp_id] = {
                status: "new",
                reason: "Validation skipped — treated as new.",
                existing_url: null,
                existing_article_id: null,
                similarity: null,
                loading: false,
              };
            }
          }
          return next;
        });
        setMeta({
          cacheAgeSeconds: resp.cache_age_seconds,
          cacheRefreshStarted: resp.cache_refresh_started,
          embeddingUsed: resp.embedding_used,
          elapsedMs: resp.elapsed_ms,
        });
      } catch (e) {
        if (ctrl.signal.aborted) return;
        const msg = e instanceof ApiError ? e.message : (e as Error)?.message || "Validation failed";
        setError(msg);
        // Roll back the loading flags so badges don't get stuck.
        setResults((prev) => {
          const next: Record<string, ClusterValidationEntry> = { ...prev };
          for (const it of items) {
            const existing = prev[it.temp_id];
            next[it.temp_id] = {
              status: existing?.status ?? "new",
              reason: existing?.reason ?? "Could not validate — assuming new.",
              existing_url: existing?.existing_url ?? null,
              existing_article_id: existing?.existing_article_id ?? null,
              similarity: existing?.similarity ?? null,
              loading: false,
            };
          }
          return next;
        });
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(debounce);
      ctrl.abort();
    };
    // ``topics`` reference changes every render but ``fingerprint`` only changes
    // when the validatable subset actually changes. ``refreshTick`` lets the
    // caller force a re-fetch without altering the fingerprint.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, enabled, threshold, fingerprint, refreshTick]);

  return {
    results,
    loading,
    error,
    meta,
    refetch: () => setRefreshTick((n) => n + 1),
  };
}

export type { ClusterValidationStatus };
