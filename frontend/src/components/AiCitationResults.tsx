"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "@/lib/api";
import type { AiCitationCheck, AiCitationEngine, AiCitationRunSummary, AiCitationTrendPoint } from "@/lib/api";
import { DataTable, DataTableHead, DataTableBody, DataTableRow, DataTableHeaderCell, DataTableCell } from "@/components/ui";

type CssModule = { [key: string]: string };

export function formatAiCitationTimestamp(iso: string | null | undefined): string {
  if (!iso) return "Not available";
  const normalized = iso.includes("T") ? iso : iso.replace(" ", "T") + "Z";
  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) return "Not available";
  return (
    d.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" }) +
    " • " +
    d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
  );
}

const ENGINE_LABELS: Record<AiCitationEngine, string> = {
  chatgpt: "ChatGPT",
  perplexity: "Perplexity",
  gemini: "Gemini",
  google_ai_overview: "Google AI Overview",
};

export function engineLabel(engine: string): string {
  return ENGINE_LABELS[engine as AiCitationEngine] || engine;
}

const ENGINE_COLORS: Record<string, string> = {
  chatgpt: "var(--aa-success, #5db872)",
  perplexity: "var(--aa-info, #7090c8)",
  gemini: "var(--aa-warning, #d4a017)",
  google_ai_overview: "var(--aa-error, #c64545)",
};

const ICON_STROKE = { fill: "none" as const, stroke: "currentColor", strokeWidth: 1.75, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

/** Small representative glyphs per engine (not brand logos) -- one shape per
 * engine so the Platform column is scannable at a glance, color-coded to match
 * the same engine colors the trend chart legend already uses. */
function EngineIcon({ engine }: { engine: string }) {
  const color = ENGINE_COLORS[engine] || "var(--aa-muted)";
  const common = { viewBox: "0 0 24 24", width: 16, height: 16, "aria-hidden": true as const, style: { color, flexShrink: 0 } };
  switch (engine as AiCitationEngine) {
    case "chatgpt":
      return (
        <svg {...common}>
          <path d="M12 2l2.2 4.6 5 .8-3.6 3.6.9 5-4.5-2.4-4.5 2.4.9-5-3.6-3.6 5-.8z" {...ICON_STROKE} />
        </svg>
      );
    case "perplexity":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8.5" {...ICON_STROKE} />
          <path d="M12 7.5l2.2 3.8-2.2 1.3-2.2-1.3z" {...ICON_STROKE} />
        </svg>
      );
    case "gemini":
      return (
        <svg {...common}>
          <path d="M12 3c0 4-2 8-9 9 7 1 9 5 9 9 0-4 2-8 9-9-7-1-9-5-9-9z" {...ICON_STROKE} />
        </svg>
      );
    case "google_ai_overview":
      return (
        <svg {...common}>
          <circle cx="10.5" cy="10.5" r="6.5" {...ICON_STROKE} />
          <path d="M20 20l-4.8-4.8" {...ICON_STROKE} />
        </svg>
      );
    default:
      return null;
  }
}

function citedPillClass(styles: CssModule, check: AiCitationCheck): string {
  if (check.status === "failed") return `${styles.statusPill} ${styles.statusPending}`;
  if (check.status !== "done") return `${styles.statusPill} ${styles.statusNeutral}`;
  return check.cited ? `${styles.statusPill} ${styles.statusPublished}` : `${styles.statusPill} ${styles.statusNeutral}`;
}

function citedPillLabel(check: AiCitationCheck): string {
  if (check.status === "failed") return "Error";
  if (check.status === "queued" || check.status === "running") return "Checking…";
  return check.cited ? "Cited" : "Not cited";
}

/* ── Summary: per-engine cited rate for the latest run ──────────────────── */

export function AiCitationSummary({ checks, styles }: { checks: AiCitationCheck[]; styles: CssModule }) {
  const byEngine = useMemo(() => {
    const groups = new Map<string, AiCitationCheck[]>();
    for (const c of checks) {
      const list = groups.get(c.engine) || [];
      list.push(c);
      groups.set(c.engine, list);
    }
    return Array.from(groups.entries());
  }, [checks]);

  if (byEngine.length === 0) return null;

  return (
    <div className={`${styles.card} ${styles.cardWide}`}>
      <h3 className={styles.sectionTitle} style={{ fontSize: 15 }}>
        Citation Summary
      </h3>
      <div className={styles.siteAuditCategoryGrid}>
        {byEngine.map(([engine, cells]) => {
          const done = cells.filter((c) => c.status === "done" || c.status === "failed");
          const cited = cells.filter((c) => c.cited).length;
          const rate = done.length ? Math.round((cited / done.length) * 100) : null;
          const stillRunning = cells.some((c) => c.status === "queued" || c.status === "running");
          return (
            <div key={engine} className={styles.siteAuditCategoryCard}>
              <span className={styles.siteAuditCategoryLabel}>{engineLabel(engine)}</span>
              <span className={styles.siteAuditCategoryValue}>
                {rate === null ? "—" : `${rate}%`}
                {rate !== null ? <span className={styles.siteAuditCategoryValueUnit}>cited</span> : null}
              </span>
              <span className={styles.muted} style={{ fontSize: 11 }}>
                {cited} of {done.length} checked{stillRunning ? " (running…)" : ""}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── Checks table: one row per (prompt, engine) check, expandable for detail ─ */

function checkResultText(c: AiCitationCheck): string | null {
  if (c.matched_snippet) return `…${c.matched_snippet}…`;
  if (c.response_text) return c.response_text.slice(0, 160) + (c.response_text.length > 160 ? "…" : "");
  return null;
}

type CheckStatusFilter = "all" | "cited" | "not_cited" | "checking" | "error";

const CHECK_STATUS_FILTERS: { key: CheckStatusFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "cited", label: "Cited" },
  { key: "not_cited", label: "Not cited" },
  { key: "checking", label: "Checking" },
  { key: "error", label: "Error" },
];

/**
 * Self-fetching, server-paginated -- deliberately NOT fed from the `/latest`
 * response's `checks` array. `/latest` only ever returns the single most
 * recent run's cells (by design, for the "is a check currently running" poll),
 * which made this table look permanently capped at one run's size no matter
 * how much real history had accumulated underneath across many runs. This
 * queries GET .../ai-citations/checks directly, which spans every run ever
 * made for the project, so the table actually reflects the full accumulated
 * dataset -- the thing that makes the feature valuable at scale.
 */
export function AiCitationCheckList({ projectId, styles, refreshSignal }: { projectId: string; styles: CssModule; refreshSignal?: unknown }) {
  const [items, setItems] = useState<AiCitationCheck[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<CheckStatusFilter>("all");
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const perPage = 30;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .getAiCitationChecks(projectId, { page, per_page: perPage, q: q || undefined, status: filter === "all" ? undefined : filter })
      .then((res) => {
        if (cancelled) return;
        setItems(res.items || []);
        setTotal(res.total || 0);
      })
      .catch(() => {
        if (!cancelled) {
          setItems([]);
          setTotal(0);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, page, filter, q, refreshSignal]);

  const totalPages = Math.max(1, Math.ceil(total / perPage));

  if (!loading && total === 0 && filter === "all" && !q) return null;

  return (
    <div className={`${styles.card} ${styles.cardWide}`}>
      <div className={styles.analyticsHeaderRow}>
        <h3 className={styles.sectionTitle} style={{ fontSize: 15 }}>
          Checks {total > 0 ? <span className={styles.muted} style={{ fontWeight: 400, fontSize: 12 }}>({total.toLocaleString()} total)</span> : null}
        </h3>
        <div className={styles.segmentGroup} aria-label="Filter by status">
          {CHECK_STATUS_FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              className={styles.miniBtn}
              onClick={() => {
                setFilter(f.key);
                setPage(1);
              }}
              aria-pressed={filter === f.key}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>
      <input
        className={styles.input}
        placeholder="Search by keyword…"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setPage(1);
        }}
        style={{ marginBottom: 10 }}
      />
      {loading ? (
        <p className={styles.muted} style={{ margin: 0, fontSize: 13 }}>
          Loading…
        </p>
      ) : items.length === 0 ? (
        <p className={styles.muted} style={{ margin: 0, fontSize: 13 }}>
          No checks match this filter.
        </p>
      ) : (
        <DataTable>
          <DataTableHead>
            <DataTableRow>
              <DataTableHeaderCell>Platform</DataTableHeaderCell>
              <DataTableHeaderCell>Keyword</DataTableHeaderCell>
              <DataTableHeaderCell>Status</DataTableHeaderCell>
              <DataTableHeaderCell>Result</DataTableHeaderCell>
              <DataTableHeaderCell>Citations</DataTableHeaderCell>
              <DataTableHeaderCell>Checked</DataTableHeaderCell>
            </DataTableRow>
          </DataTableHead>
          <DataTableBody>
            {items.map((c) => {
              const isExpanded = expanded === c.id;
              const result = checkResultText(c);
              return (
                <Fragment key={c.id}>
                  <DataTableRow onClick={() => setExpanded(isExpanded ? null : c.id)} style={{ cursor: "pointer" }} aria-expanded={isExpanded}>
                    <DataTableCell>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600, fontSize: 13 }}>
                        <EngineIcon engine={c.engine} />
                        {engineLabel(c.engine)}
                      </div>
                    </DataTableCell>
                    <DataTableCell style={{ fontSize: 12 }}>{c.keyword}</DataTableCell>
                    <DataTableCell>
                      <span className={citedPillClass(styles, c)}>{citedPillLabel(c)}</span>
                    </DataTableCell>
                    <DataTableCell style={{ fontSize: 12, maxWidth: 320 }}>
                      {c.status === "failed" ? (
                        <span style={{ color: "var(--aa-error)" }}>{c.error || "This check failed."}</span>
                      ) : (
                        result || <span className={styles.muted}>—</span>
                      )}
                    </DataTableCell>
                    <DataTableCell style={{ fontSize: 12 }}>{c.citation_urls.length || <span className={styles.muted}>—</span>}</DataTableCell>
                    <DataTableCell style={{ fontSize: 12 }} className={styles.muted}>
                      {formatAiCitationTimestamp(c.queued_at)}
                    </DataTableCell>
                  </DataTableRow>
                  {isExpanded ? (
                    <DataTableRow>
                      <DataTableCell colSpan={6} style={{ background: "var(--aa-surface-soft)" }}>
                        <p className={styles.muted} style={{ margin: 0, fontSize: 12 }}>
                          Prompt: &ldquo;{c.prompt}&rdquo;
                        </p>
                        {c.status !== "failed" && c.response_text ? (
                          <p style={{ margin: "6px 0 0", fontSize: 12 }}>{c.response_text.slice(0, 600)}</p>
                        ) : null}
                        {c.citation_urls.length > 0 ? (
                          <p className={styles.muted} style={{ margin: "6px 0 0", fontSize: 12 }}>
                            Citations:{" "}
                            {c.citation_urls.map((u, i) => (
                              <a key={u} href={u} target="_blank" rel="noreferrer" style={{ marginRight: 8 }}>
                                {i + 1}
                              </a>
                            ))}
                          </p>
                        ) : null}
                      </DataTableCell>
                    </DataTableRow>
                  ) : null}
                </Fragment>
              );
            })}
          </DataTableBody>
        </DataTable>
      )}
      {totalPages > 1 ? (
        <div className={styles.analyticsHeaderRow} style={{ marginTop: 10 }}>
          <button type="button" className={styles.btnSecondary} disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
            Previous
          </button>
          <span className={styles.muted} style={{ fontSize: 12 }}>
            Page {page} of {totalPages} · {total.toLocaleString()} checks
          </span>
          <button type="button" className={styles.btnSecondary} disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>
            Next
          </button>
        </div>
      ) : null}
    </div>
  );
}

/* ── History list ────────────────────────────────────────────────────────── */

export function AiCitationHistoryList({ history, styles }: { history: AiCitationRunSummary[]; styles: CssModule }) {
  if (history.length === 0) return null;
  return (
    <div className={`${styles.card} ${styles.cardWide}`}>
      <h3 className={styles.sectionTitle} style={{ fontSize: 15 }}>
        Run History
      </h3>
      <ul className={styles.siteAuditHistoryList}>
        {history.map((run) => {
          const rate = run.completed ? Math.round((run.cited / run.completed) * 100) : null;
          return (
            <li key={run.run_id}>
              <div className={styles.siteAuditHistoryRow}>
                <span className={styles.siteAuditHistoryDate}>{formatAiCitationTimestamp(run.queued_at)}</span>
                <span className={styles.siteAuditHistoryScores}>
                  {run.cited} of {run.total} cited{rate !== null ? ` (${rate}%)` : ""}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* ── Trend chart: citation rate per engine over time ─────────────────────── */

type RangeKey = "30d" | "3m" | "6m" | "1y" | "all";
const RANGE_WEEKS: Record<RangeKey, number | null> = { "30d": 4, "3m": 13, "6m": 26, "1y": 52, all: null };

export function AiCitationTrendChart({ points, styles }: { points: AiCitationTrendPoint[]; styles: CssModule }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState<RangeKey>("3m");
  const [hoverWeek, setHoverWeek] = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; transform: string } | null>(null);

  const weeks = useMemo(() => {
    const all = Array.from(new Set(points.map((p) => p.week_start))).sort();
    const limit = RANGE_WEEKS[range];
    return limit ? all.slice(-limit) : all;
  }, [points, range]);

  const engines = useMemo(() => Array.from(new Set(points.map((p) => p.engine))).sort(), [points]);

  const W = 700;
  const H = 220;
  const padL = 36;
  const padR = 16;
  const padT = 20;
  const padB = 32;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  const xForIndex = useCallback((i: number, n: number) => (n <= 1 ? padL + innerW / 2 : padL + (innerW * i) / (n - 1)), [innerW]);
  const yForRate = useCallback((v: number) => padT + innerH - innerH * v, [innerH]);

  const byEngineWeek = useMemo(() => {
    const m = new Map<string, AiCitationTrendPoint>();
    for (const p of points) m.set(`${p.engine}|${p.week_start}`, p);
    return m;
  }, [points]);

  const series = useMemo(() => {
    const n = weeks.length;
    return engines.map((engine) => ({
      engine,
      pts: weeks.map((wk, i) => {
        const p = byEngineWeek.get(`${engine}|${wk}`);
        return { x: xForIndex(i, n), y: yForRate(p?.rate ?? 0), point: p || null };
      }),
    }));
  }, [engines, weeks, byEngineWeek, xForIndex, yForRate]);

  const linePath = (pts: { x: number; y: number }[]) => (pts.length ? `M ${pts.map((p) => `${p.x} ${p.y}`).join(" L ")}` : "");

  const showTooltip = useCallback((week: string, clientX: number, clientY: number) => {
    const tipW = 200;
    const pad = 12;
    const clampedX = typeof window !== "undefined" ? Math.min(Math.max(clientX, tipW / 2 + pad), window.innerWidth - tipW / 2 - pad) : clientX;
    setHoverWeek(week);
    setTooltip({ x: clampedX, y: clientY, transform: "translate(-50%, calc(-100% - 12px))" });
  }, []);
  const hideTooltip = useCallback(() => {
    setHoverWeek(null);
    setTooltip(null);
  }, []);

  const yTicks = [0, 0.25, 0.5, 0.75, 1];
  const colWidth = weeks.length > 1 ? innerW / (weeks.length - 1) : innerW;

  const tooltipEl =
    tooltip && hoverWeek ? (
      <div role="tooltip" style={{ position: "fixed", left: tooltip.x, top: tooltip.y, transform: tooltip.transform, zIndex: 10000 }} className={styles.siteAuditChartTooltip}>
        <div className={styles.siteAuditChartTooltipDate}>Week of {hoverWeek}</div>
        {engines.map((engine) => {
          const p = byEngineWeek.get(`${engine}|${hoverWeek}`);
          return (
            <div key={engine} className={styles.siteAuditChartTooltipRow}>
              <span className={styles.siteAuditChartTooltipSwatch} style={{ background: ENGINE_COLORS[engine] || "var(--aa-muted)" }} />
              {engineLabel(engine)} <strong>{p ? `${Math.round(p.rate * 100)}%` : "—"}</strong>
            </div>
          );
        })}
      </div>
    ) : null;

  return (
    <div className={`${styles.card} ${styles.cardWide}`}>
      <div className={styles.analyticsHeaderRow}>
        <h3 className={styles.sectionTitle} style={{ fontSize: 15 }}>
          Citation Rate Trend
        </h3>
        {weeks.length > 1 ? (
          <div className={styles.segmentGroup} aria-label="Date range">
            {(["30d", "3m", "6m", "1y", "all"] as const).map((r) => (
              <button key={r} type="button" className={styles.miniBtn} onClick={() => setRange(r)} aria-pressed={range === r}>
                {r === "all" ? "All" : r.toUpperCase()}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {weeks.length < 2 ? (
        <p className={styles.muted} style={{ margin: 0, fontSize: 13 }}>
          Run a few more checks over time to see your citation trend.
        </p>
      ) : (
        <>
          <ul className={styles.siteAuditChartLegend} aria-hidden="true">
            {engines.map((engine) => (
              <li key={engine}>
                <span className={styles.siteAuditChartLegendSwatch} style={{ background: ENGINE_COLORS[engine] || "var(--aa-muted)" }} /> {engineLabel(engine)}
              </li>
            ))}
          </ul>
          <div ref={wrapRef}>
            <svg viewBox={`0 0 ${W} ${H}`} width="100%" preserveAspectRatio="xMidYMid meet" role="img" aria-label="AI citation rate trend by engine" onMouseLeave={hideTooltip}>
              {yTicks.map((tick) => (
                <g key={tick}>
                  <line x1={padL} y1={yForRate(tick)} x2={W - padR} y2={yForRate(tick)} stroke="var(--aa-hairline)" strokeDasharray="4 6" />
                  <text x={padL - 8} y={yForRate(tick) + 4} textAnchor="end" fontSize={10} fill="var(--aa-muted)">
                    {Math.round(tick * 100)}%
                  </text>
                </g>
              ))}
              {series.map((s) => (
                <path key={s.engine} d={linePath(s.pts)} fill="none" stroke={ENGINE_COLORS[s.engine] || "var(--aa-muted)"} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
              ))}
              {weeks.map((wk, i) => (
                <rect
                  key={wk}
                  x={padL + colWidth * (i - 0.5)}
                  y={padT}
                  width={colWidth}
                  height={innerH}
                  fill="transparent"
                  onMouseMove={(e) => showTooltip(wk, e.clientX, e.clientY)}
                  onFocus={() => showTooltip(wk, xForIndex(i, weeks.length), padT + innerH / 2)}
                  onBlur={hideTooltip}
                  tabIndex={0}
                  role="presentation"
                />
              ))}
              {weeks.map((wk, i) =>
                i === 0 || i === weeks.length - 1 || i % Math.max(1, Math.floor(weeks.length / 5)) === 0 ? (
                  <text key={`lbl-${wk}`} x={xForIndex(i, weeks.length)} y={H - 8} textAnchor="middle" fontSize={10} fill="var(--aa-muted)">
                    {wk.slice(5)}
                  </text>
                ) : null,
              )}
            </svg>
          </div>
        </>
      )}
      {typeof document !== "undefined" && tooltipEl ? createPortal(tooltipEl, document.body) : null}
    </div>
  );
}
