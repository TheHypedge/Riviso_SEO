"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import styles from "../../page.module.css";
import projectsDark from "../projectsDark.module.css";
import { api, ApiError, ArticlePublic, BulkUploadRow, clearAuth, getAccessToken, getApiBaseUrl, PromptListResponse, ResearchIdeaRow as ApiResearchIdeaRow, TopicCluster } from "@/lib/api";
import { COUNTRIES, DEFAULT_COUNTRY_CODE } from "@/lib/countries";
import {
  AUDIENCE_PRESETS,
  BRAND_TONES,
  BRAND_VOICES,
  citiesForCountry,
} from "@/lib/brand_dictionaries";
import { useClusterValidation, type ValidatableTopic } from "@/hooks/useClusterValidation";

type StatusFilter = "" | "pending" | "draft" | "scheduled" | "published";
type TabKey =
  | "articles"
  | "research"
  | "scheduled_articles"
  | "configuration"
  | "prompts"
  | "context_links"
  | "tools"
  | "performance"
  | "project_settings";

type ResearchSubTabKey = "cluster" | "curations";

// Whitelist of valid tab values from the URL — anything else falls back to the
// default. Keeping the source of truth here (vs. re-deriving from ``tabLabel``
// inside the component) lets the lazy ``useState`` initializer read the URL
// before the component body runs.
const TAB_KEYS: ReadonlySet<TabKey> = new Set<TabKey>([
  "articles",
  "research",
  "scheduled_articles",
  "configuration",
  "prompts",
  "context_links",
  "tools",
  "performance",
  "project_settings",
]);

const RESEARCH_SUBTAB_KEYS: ReadonlySet<ResearchSubTabKey> = new Set<ResearchSubTabKey>([
  "cluster",
  "curations",
]);

/**
 * Initial tab values used by both the server render and the first client
 * render. We deliberately do **not** read ``window.location.search`` from
 * the lazy ``useState`` initializer — doing so produces a different value
 * on the server (no ``window``) than on the client (real URL), which
 * trips React 19's hydration-mismatch detector against the sidebar's
 * ``navItemActive`` class. The post-mount ``useEffect`` in the page
 * component upgrades the state to the URL-derived tab on the first frame
 * after hydration, so deep-linked URLs (?tab=project_settings, …) still
 * restore correctly.
 */
function defaultInitialTab(): TabKey {
  return "articles";
}

function defaultInitialResearchSubTab(): ResearchSubTabKey {
  return "cluster";
}

function parseDateOnly(s: string): Date | null {
  const v = (s || "").trim();
  if (!v) return null;
  const d = new Date(v + "T00:00:00");
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseCreatedAt(s?: string | null): Date | null {
  const v = (s || "").trim();
  if (!v) return null;
  // created_at from legacy is "YYYY-MM-DD HH:MM:SS"
  const iso = v.includes("T") ? v : v.replace(" ", "T") + "Z";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toDatetimeLocalValue(d: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  const yyyy = d.getFullYear();
  const mm = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const hh = pad(d.getHours());
  const mi = pad(d.getMinutes());
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
}

/** Align with backend: NFKC + trim + lowercase (Python uses casefold server-side). */
function normalizeArticleTitleKey(s: string): string {
  const t = (s || "").trim();
  if (!t) return "";
  try {
    return t.normalize("NFKC").toLowerCase();
  } catch {
    return t.toLowerCase();
  }
}

/** Same title (case-insensitive): keep first row in file order (treated as oldest). */
function dedupeBulkUploadRowsByTitle(rows: BulkUploadRow[]): {
  rows: BulkUploadRow[];
  duplicateTitles: string[];
  droppedCount: number;
} {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const k = normalizeArticleTitleKey(r.title || "");
    if (!k) continue;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const seen = new Set<string>();
  const out: BulkUploadRow[] = [];
  const firstDisplay = new Map<string, string>();
  for (const r of rows) {
    const raw = (r.title || "").trim();
    const k = normalizeArticleTitleKey(raw);
    if (!k) continue;
    if (!firstDisplay.has(k)) firstDisplay.set(k, raw);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  const duplicateTitles = [...firstDisplay.entries()]
    .filter(([key]) => (counts.get(key) || 0) > 1)
    .map(([, display]) => display)
    .sort((a, b) => a.localeCompare(b));
  const droppedCount = [...counts.values()].reduce((s, c) => s + Math.max(0, c - 1), 0);
  return { rows: out, duplicateTitles, droppedCount };
}

type ProjectDupRow = { submitted_title: string; existing_title: string; existing_id: string };

type ResearchIntent = "informational" | "commercial" | "transactional" | "navigational";
type ResearchTone =
  | "professional"
  | "friendly"
  | "authoritative"
  | "conversational"
  | "technical"
  | "casual"
  | "formal"
  | "witty"
  | "humorous"
  | "empathetic"
  | "persuasive"
  | "inspirational"
  | "confident"
  | "educational"
  | "storytelling"
  | "neutral"
  | "enthusiastic"
  | "analytical";

const RESEARCH_TONE_OPTIONS: { value: ResearchTone; label: string }[] = [
  { value: "professional", label: "Professional" },
  { value: "friendly", label: "Friendly" },
  { value: "authoritative", label: "Authoritative" },
  { value: "conversational", label: "Conversational" },
  { value: "technical", label: "Technical" },
  { value: "casual", label: "Casual" },
  { value: "formal", label: "Formal" },
  { value: "witty", label: "Witty" },
  { value: "humorous", label: "Humorous" },
  { value: "empathetic", label: "Empathetic" },
  { value: "persuasive", label: "Persuasive" },
  { value: "inspirational", label: "Inspirational" },
  { value: "confident", label: "Confident" },
  { value: "educational", label: "Educational" },
  { value: "storytelling", label: "Storytelling" },
  { value: "neutral", label: "Neutral" },
  { value: "enthusiastic", label: "Enthusiastic" },
  { value: "analytical", label: "Analytical" },
];

type ResearchIdeaRow = {
  id: string;
  title: string;
  focus_keyphrase: string;
  keywords: string[];
  score?: number | null;
  rationale?: string | null;
  imported?: boolean;
  imported_at?: string | null;
  imported_article_id?: string | null;
  generated_at?: string | null;
  run_id?: string | null;
};

type ResearchFilter = "all" | "latest" | "not_imported" | "imported";

type PersistedResearchState = {
  v: 1;
  seeds: string[];
  results: ResearchIdeaRow[];
  latestRunId: string | null;
  brandNiche: string;
  intent: ResearchIntent;
  tone: ResearchTone;
  country: string;
  language: string;
  filter: ResearchFilter;
};

function researchStorageKey(projectId: string): string {
  return `riviso.research.${projectId}.v1`;
}

function loadPersistedResearch(projectId: string): PersistedResearchState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(researchStorageKey(projectId));
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object" || obj.v !== 1) return null;
    return obj as PersistedResearchState;
  } catch {
    return null;
  }
}

function persistResearch(projectId: string, state: PersistedResearchState): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(researchStorageKey(projectId), JSON.stringify(state));
  } catch {
    /* ignore quota / serialization errors */
  }
}

function makeResearchKey(title: string, focus: string): string {
  return `${(title || "").trim().toLowerCase()}::${(focus || "").trim().toLowerCase()}`;
}

/**
 * Dependency-free SVG line chart for the GSC ROI Dashboard.
 *
 * Renders two series (clicks + impressions) sharing the X axis, with vertical
 * dashed markers for each Riviso article published inside the window. The chart
 * is responsive — `viewBox` keeps the geometry fixed while CSS scales the SVG
 * to its container.
 *
 * Designed to keep a low surface area: no tooltip portal, no axis library, no
 * deps. If/when product asks for richer interactions we can swap to a chart lib
 * without changing the call sites in this page.
 */
function AnalyticsLineChart(props: {
  series: import("@/lib/api").GscAnalyticsSeriesPoint[];
  markers: import("@/lib/api").GscAnalyticsMarker[];
}) {
  const { series, markers } = props;
  const W = 920;
  const H = 300;
  const padL = 48;
  const padR = 10;
  const padT = 14;
  const padB = 40;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  /** Theme tokens — readable on dark project cards and aligned with Riviso brand (coral + cream + gold). */
  const gridStroke = "var(--aa-hairline)";
  const plotOutline = "color-mix(in oklab, var(--aa-hairline), transparent 35%)";
  const axisFill = "var(--aa-muted)";
  const lineClicks = "var(--aa-primary)";
  const lineImpr = "var(--aa-surface-cream-strong)";
  const markerLine = "color-mix(in oklab, var(--aa-warning), transparent 22%)";
  const markerDot = "var(--aa-warning)";
  const pointRing = "rgba(255, 255, 255, 0.92)";

  if (!series || series.length === 0) {
    return (
      <div style={{ padding: "24px 12px", textAlign: "center" }} className="aa-muted">
        No traffic data in this window yet.
      </div>
    );
  }

  const dates = series.map((p) => p.date);
  const xIndex = (i: number) => padL + (innerW * i) / Math.max(1, series.length - 1);

  const maxClicks = Math.max(1, ...series.map((p) => p.clicks || 0));
  const maxImpr = Math.max(1, ...series.map((p) => p.impressions || 0));

  const yClicks = (v: number) => padT + innerH - (innerH * (v || 0)) / maxClicks;
  const yImpr = (v: number) => padT + innerH - (innerH * (v || 0)) / maxImpr;

  const clicksPath = series.map((p, i) => `${i === 0 ? "M" : "L"} ${xIndex(i).toFixed(1)} ${yClicks(p.clicks).toFixed(1)}`).join(" ");
  const imprPath = series.map((p, i) => `${i === 0 ? "M" : "L"} ${xIndex(i).toFixed(1)} ${yImpr(p.impressions).toFixed(1)}`).join(" ");

  const tickCount = 4;
  const yTicks = Array.from({ length: tickCount + 1 }, (_, i) => Math.round((maxClicks * i) / tickCount));

  const labelEvery = Math.max(1, Math.floor(series.length / 6));
  const xLabels = series
    .map((p, i) => ({ p, i }))
    .filter(({ i }) => i % labelEvery === 0 || i === series.length - 1);

  const dateToIndex = new Map<string, number>();
  dates.forEach((d, i) => dateToIndex.set(d, i));

  const markerDots = markers
    .map((m) => ({ ...m, idx: dateToIndex.get(m.date) }))
    .filter((m) => typeof m.idx === "number") as Array<import("@/lib/api").GscAnalyticsMarker & { idx: number }>;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      height="auto"
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="Search Console traffic over time with article publication markers"
      style={{ display: "block", maxWidth: "100%", minHeight: 220 }}
    >
      <rect x={padL} y={padT} width={innerW} height={innerH} fill="transparent" stroke={plotOutline} strokeWidth={1} />
      {yTicks.map((v, i) => {
        const y = padT + innerH - (innerH * i) / tickCount;
        return (
          <g key={`yt-${i}`}>
            <line x1={padL} y1={y} x2={W - padR} y2={y} stroke={gridStroke} strokeDasharray="2 4" strokeOpacity={0.95} />
            <text
              x={padL - 8}
              y={y + 4}
              textAnchor="end"
              fontSize={11}
              fill={axisFill}
              style={{ fontFamily: "var(--aa-font-ui)" }}
            >
              {v.toLocaleString()}
            </text>
          </g>
        );
      })}
      {xLabels.map(({ p, i }) => (
        <text
          key={`xl-${i}`}
          x={xIndex(i)}
          y={H - 10}
          textAnchor="middle"
          fontSize={11}
          fill={axisFill}
          style={{ fontFamily: "var(--aa-font-ui)" }}
        >
          {p.date.slice(5)}
        </text>
      ))}
      {markerDots.map((m, i) => {
        const x = xIndex(m.idx);
        return (
          <g key={`mk-${i}`}>
            <line
              x1={x}
              y1={padT}
              x2={x}
              y2={padT + innerH}
              stroke={markerLine}
              strokeWidth={1.25}
              strokeDasharray="5 4"
            />
            <circle cx={x} cy={padT + 7} r={5} fill={markerDot} stroke={pointRing} strokeWidth={1.25}>
              <title>{`${m.title || "Article"} — published ${m.date}\n${m.url}`}</title>
            </circle>
          </g>
        );
      })}
      <path d={imprPath} fill="none" stroke={lineImpr} strokeWidth={2.25} strokeOpacity={0.92} strokeLinecap="round" strokeLinejoin="round" />
      <path d={clicksPath} fill="none" stroke={lineClicks} strokeWidth={2.75} strokeLinecap="round" strokeLinejoin="round" />
      {series.map((p, i) => (
        <circle
          key={`im-${i}`}
          cx={xIndex(i)}
          cy={yImpr(p.impressions)}
          r={4}
          fill={lineImpr}
          stroke={pointRing}
          strokeWidth={1}
          fillOpacity={0.95}
        >
          <title>{`${p.date}\nImpressions: ${p.impressions}`}</title>
        </circle>
      ))}
      {series.map((p, i) => (
        <circle key={`cl-${i}`} cx={xIndex(i)} cy={yClicks(p.clicks)} r={5.5} fill={lineClicks} stroke={pointRing} strokeWidth={1.35}>
          <title>{`${p.date}\nClicks: ${p.clicks}\nImpressions: ${p.impressions}\nPosition: ${(p.position || 0).toFixed(1)}`}</title>
        </circle>
      ))}
    </svg>
  );
}

/**
 * Small badge that surfaces the result of the Cluster Validation engine for a
 * single Pillar/Cluster topic. Renders in four states:
 *   - validating  — grey pill with a spinner (request in flight or queued).
 *   - new         — green pill, "NEW TOPIC".
 *   - similar     — orange pill, "POTENTIAL DUPLICATE" + optional "View existing →".
 *   - duplicate   — red pill, "EXISTS ON SITE" or "EXISTS IN PROJECT".
 *
 * Returns ``null`` when no entry is available *and* nothing is loading — this
 * prevents the badge column from rendering an empty placeholder for already-
 * imported topics or before the first validation pass kicks off.
 */
function ValidationBadge({ entry }: { entry?: import("@/hooks/useClusterValidation").ClusterValidationEntry | null }) {
  if (!entry) return null;
  if (entry.loading) {
    return (
      <span className={styles.validationBadge} data-state="validating" title="Validating against your library and live site…">
        Validating…
      </span>
    );
  }
  const onSite = entry.status === "duplicate" && !!entry.existing_url;
  const label =
    entry.status === "new"
      ? "New topic"
      : entry.status === "similar"
        ? "Potential duplicate"
        : onSite
          ? "Exists on site"
          : "Exists in project";
  return (
    <>
      <span className={styles.validationBadge} data-state={entry.status} title={entry.reason || undefined}>
        {label}
      </span>
      {entry.existing_url ? (
        <a
          className={styles.validationLink}
          href={entry.existing_url}
          target="_blank"
          rel="noreferrer"
        >
          View existing →
        </a>
      ) : null}
      {entry.status === "similar" && typeof entry.similarity === "number" ? (
        <span className={styles.validationMeta}>cos {entry.similarity.toFixed(2)}</span>
      ) : null}
    </>
  );
}

export default function ProjectPage() {
  const router = useRouter();
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;

  const token = useMemo(() => getAccessToken(), []);
  const searchParams = useSearchParams();

  // The active section of the project page is mirrored into ``?tab=…`` (and
  // ``?subtab=…`` for Research) so a hard refresh, browser back/forward, or a
  // shared link all land on the same view.
  //
  // Important: we initialise both state values to a fixed default that the
  // server can also render. Reading ``window.location.search`` here would
  // produce different values during SSR vs. hydration and trip React 19's
  // ``navItem`` / ``navItemActive`` hydration mismatch warning. The
  // ``useEffect`` below picks up the real URL on the first frame after
  // hydration, so deep-linked tabs (?tab=project_settings, etc.) still
  // restore correctly without the visible flicker hurting hydration.
  const [tab, setTabState] = useState<TabKey>(defaultInitialTab);
  const [researchSubTab, setResearchSubTabState] = useState<ResearchSubTabKey>(
    defaultInitialResearchSubTab,
  );

  // Single helper that mutates ``window.location`` query params and asks the
  // App Router to replace the URL without scrolling. ``null``/empty values
  // delete the key so we keep URLs minimal (e.g. omit ``?tab=articles``).
  const updateUrlParams = useCallback(
    (updates: Record<string, string | null | undefined>) => {
      if (typeof window === "undefined") return;
      try {
        const url = new URL(window.location.href);
        for (const [key, value] of Object.entries(updates)) {
          if (value === null || value === undefined || value === "") {
            url.searchParams.delete(key);
          } else {
            url.searchParams.set(key, value);
          }
        }
        const next = `${url.pathname}${url.search ? url.search : ""}${url.hash || ""}`;
        router.replace(next, { scroll: false });
      } catch {
        // Best-effort URL sync; state is still authoritative for rendering.
      }
    },
    [router],
  );

  const setTab = useCallback(
    (next: TabKey) => {
      setTabState(next);
      // Keep URLs tidy: drop the param entirely for the default tab, and clear
      // ``subtab`` whenever we leave Research so stale sub-tab state can't leak
      // into other sections via shared links.
      const updates: Record<string, string | null> = {
        tab: next === "articles" ? null : next,
      };
      if (next !== "research") updates.subtab = null;
      updateUrlParams(updates);
    },
    [updateUrlParams],
  );

  const setResearchSubTab = useCallback(
    (next: ResearchSubTabKey) => {
      setResearchSubTabState(next);
      updateUrlParams({ subtab: next === "cluster" ? null : next });
    },
    [updateUrlParams],
  );

  // Sync state ← URL when the user navigates with browser back/forward or when
  // another effect updates the query string (e.g. OAuth redirect handler).
  useEffect(() => {
    const rawTab = (searchParams?.get("tab") || "").toLowerCase();
    const nextTab: TabKey = TAB_KEYS.has(rawTab as TabKey) ? (rawTab as TabKey) : "articles";
    setTabState((prev) => (prev === nextTab ? prev : nextTab));

    const rawSub = (searchParams?.get("subtab") || "").toLowerCase();
    const nextSub: ResearchSubTabKey = RESEARCH_SUBTAB_KEYS.has(rawSub as ResearchSubTabKey)
      ? (rawSub as ResearchSubTabKey)
      : "cluster";
    setResearchSubTabState((prev) => (prev === nextSub ? prev : nextSub));
  }, [searchParams]);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [settings, setSettings] = useState<import("@/lib/api").ProjectSettings | null>(null);
  const [projectMeta, setProjectMeta] = useState<import("@/lib/api").ProjectPublic | null>(null);
  const [featureLimits, setFeatureLimits] = useState<import("@/lib/api").ProjectFeatureLimits | null>(null);
  // List of every project the user owns. Powers the in-sidebar project
  // switcher so users can hop between projects without bouncing through
  // the dashboard. Loaded once per mount; refreshed silently when a
  // rename happens (see ``saveSettings``).
  const [projectsList, setProjectsList] = useState<import("@/lib/api").ProjectPublic[]>([]);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsVerify, setSettingsVerify] = useState<import("@/lib/api").WordpressVerifyResponse | null>(null);
  const [settingsVerifying, setSettingsVerifying] = useState(false);
  const [confirmDeleteProject, setConfirmDeleteProject] = useState(false);
  const [deletingProject, setDeletingProject] = useState(false);

  async function refreshFeatureLimits() {
    try {
      const limits = await api.projectFeatureLimits(projectId);
      setFeatureLimits(limits);
      return limits;
    } catch {
      return null;
    }
  }

  const [sName, setSName] = useState("");
  const [sUrl, setSUrl] = useState("");
  const [sWpUser, setSWpUser] = useState("");
  const [sWpPass, setSWpPass] = useState("");
  const [sWpDefaultPostType, setSWpDefaultPostType] = useState("posts");
  const [sWpDefaultStatus, setSWpDefaultStatus] = useState<"draft" | "publish">("draft");
  const [sWpDefaultCategoryIds, setSWpDefaultCategoryIds] = useState<number[]>([]);
  const [sGscPropertyUrl, setSGscPropertyUrl] = useState("");
  const [sGscIndexOnPublish, setSGscIndexOnPublish] = useState(true);
  // Structured Brand identity inputs.
  const [brandVoice, setBrandVoice] = useState("");
  const [brandTones, setBrandTones] = useState<string[]>([]);
  const [brandRules, setBrandRules] = useState("");
  // Structured Niche identifier inputs.
  const [nicheTopic, setNicheTopic] = useState("");
  const [audienceList, setAudienceList] = useState<string[]>([]);
  const [audienceCustomDraft, setAudienceCustomDraft] = useState("");
  const [targetCountries, setTargetCountries] = useState<string[]>([]);
  const [targetCountriesAll, setTargetCountriesAll] = useState(false);
  const [targetCitiesAll, setTargetCitiesAll] = useState(false);
  const [targetCities, setTargetCities] = useState<string[]>([]);
  const [cityCustomDraft, setCityCustomDraft] = useState("");
  const [countryFilter, setCountryFilter] = useState("");
  const [settingsPostTypes, setSettingsPostTypes] = useState<import("@/lib/api").WordpressPostType[]>([]);
  const [settingsCategories, setSettingsCategories] = useState<import("@/lib/api").WordpressCategory[]>([]);
  const [gscStatus, setGscStatus] = useState<import("@/lib/api").ProjectGscStatus | null>(null);
  const [gscSites, setGscSites] = useState<import("@/lib/api").GscSite[]>([]);
  const [gscLoading, setGscLoading] = useState(false);
  const [gscSaveMsg, setGscSaveMsg] = useState<string | null>(null);
  const [gscConnecting, setGscConnecting] = useState(false);
  const [gscDisconnecting, setGscDisconnecting] = useState(false);
  const [gscConfirmDisconnect, setGscConfirmDisconnect] = useState(false);
  const [gscMsg, setGscMsg] = useState<string | null>(null);
  const [gscOpenedFromOAuth, setGscOpenedFromOAuth] = useState(false);
  // True when the per-project GSC routes return 404 — almost always means the VPS
  // backend wasn't restarted with the latest code. Surfaced with an actionable hint
  // so the user does not chase the (misleading) "OAuth not configured" message.
  const [gscApiUnavailable, setGscApiUnavailable] = useState(false);
  const [articleIndexBusy, setArticleIndexBusy] = useState<Record<string, "request" | "check" | undefined>>({});
  const [articleIndexMsg, setArticleIndexMsg] = useState<Record<string, string | null>>({});
  const [articleIndexStatus, setArticleIndexStatus] = useState<Record<string, import("@/lib/api").GscIndexingStatus | null>>({});
  // Per-article result of the most recent "Index now" call. Holds the deep link to GSC's URL
  // Inspection panel (where the user must press REQUEST INDEXING — Google has no public API
  // equivalent) plus a structured trace of which channels we actually pinged.
  const [articleIndexResult, setArticleIndexResult] = useState<
    Record<string, import("@/lib/api").RequestIndexingResponse | null>
  >({});
  // Sitemap submission state for the Tools tab. ``sitemaps`` mirrors the registered
  // sitemaps Google reports back so the user can see lastSubmitted / status.
  const [gscSitemaps, setGscSitemaps] = useState<import("@/lib/api").GscSitemap[]>([]);
  const [gscSitemapSuggested, setGscSitemapSuggested] = useState<string>("");
  const [sitemapInput, setSitemapInput] = useState<string>("");
  const [sitemapBusy, setSitemapBusy] = useState<"submit" | "delete" | "load" | null>(null);
  const [sitemapMsg, setSitemapMsg] = useState<string | null>(null);
  const [sitemapDeletingPath, setSitemapDeletingPath] = useState<string | null>(null);

  // Pagination + filtering for the "Existing articles — indexing status" table on the
  // Tools tab. Defaults to 10 rows/page; status filter aligns with the coverage states
  // surfaced by the backend (pending / inspected / requested).
  const [indexingPage, setIndexingPage] = useState<number>(1);
  const [indexingPageSize, setIndexingPageSize] = useState<number>(10);
  const [indexingStatusFilter, setIndexingStatusFilter] = useState<string>("");
  const [indexingSearch, setIndexingSearch] = useState<string>("");

  // ---- Feature 1: GSC ROI Dashboard ----------------------------------------
  // ``analyticsRangePreset`` is the active range chip on the Performance tab — one of
  // 7 / 28 / 90 / 180 / 365 days, or the literal string ``"custom"`` which uses
  // ``analyticsCustomStart`` / ``analyticsCustomEnd`` as the [start, end] window.
  // We always keep the last ``analytics`` payload around so the Performance tab can
  // be hidden until at least one fetch has succeeded.
  const [analytics, setAnalytics] = useState<import("@/lib/api").GscAnalyticsResponse | null>(null);
  const [analyticsBusy, setAnalyticsBusy] = useState<boolean>(false);
  const [analyticsErr, setAnalyticsErr] = useState<string | null>(null);
  const [analyticsRangePreset, setAnalyticsRangePreset] = useState<number | "custom">(28);
  const [analyticsCustomStart, setAnalyticsCustomStart] = useState<string>("");
  const [analyticsCustomEnd, setAnalyticsCustomEnd] = useState<string>("");

  // ---- Feature 3: Site map (Internal Linking) -------------------------------
  const [siteMap, setSiteMap] = useState<import("@/lib/api").SiteMapListResponse | null>(null);
  const [siteMapBusy, setSiteMapBusy] = useState<boolean>(false);
  const [siteMapMsg, setSiteMapMsg] = useState<string | null>(null);

  // ---- Feature 2: Topic Clusters (Topical Authority) -----------------------
  const [topicClusters, setTopicClusters] = useState<TopicCluster[]>([]);
  const [topicClustersLoading, setTopicClustersLoading] = useState(false);
  const [topicClustersErr, setTopicClustersErr] = useState<string | null>(null);
  const [clusterSeedIntent, setClusterSeedIntent] = useState("");
  const [clusterPlanBusy, setClusterPlanBusy] = useState(false);
  const [clusterPlanMsg, setClusterPlanMsg] = useState<string | null>(null);
  // ``selected[clusterId] = Set<slotId>`` — per-cluster selection of slot ids
  // ("pillar" + each cluster topic id). Keeping selections per cluster (vs. a
  // global flat set) lets the bulk-action toolbar in each card act
  // independently when the user has multiple clusters open.
  const [clusterSelected, setClusterSelected] = useState<Record<string, Set<string>>>({});
  type BulkActionKind = "generate" | "import" | "schedule";
  const [clusterBulkBusy, setClusterBulkBusy] = useState<{ clusterId: string; kind: BulkActionKind } | null>(null);
  // Modal payloads. ``error`` shows a polished popup for quota / generation
  // errors. ``schedule`` opens the datetime + WP-status picker for the
  // "Schedule selected/all" action.
  const [clusterErrorModal, setClusterErrorModal] = useState<{
    title: string;
    message: string;
    detail?: string | null;
  } | null>(null);
  const [clusterScheduleModal, setClusterScheduleModal] = useState<{
    clusterId: string;
    topicIds: string[] | null; // null = all pending
    runAt: string; // datetime-local value
    wpStatus: "draft" | "publish";
    busy: boolean;
  } | null>(null);

  // Flatten every cluster's pillar + topics into a single validation batch so
  // we make at most one network call per cluster set (vs. one per cluster).
  // ``temp_id`` namespaces by cluster so two clusters with overlapping topic ids
  // don't collide. ``skip`` is set for already-imported topics — those are
  // settled so re-validating wastes a backend hop.
  const validatableTopics = useMemo<ValidatableTopic[]>(() => {
    const out: ValidatableTopic[] = [];
    for (const cl of topicClusters) {
      const pillar = cl.pillar || ({} as TopicCluster["pillar"]);
      const pillarTitle = (pillar.title || "").trim();
      if (pillarTitle) {
        out.push({
          temp_id: `${cl.id}::pillar`,
          title: pillarTitle,
          focus_keyphrase: (pillar.keywords || [])[0] || pillarTitle,
          keywords: pillar.keywords || [],
          skip: !!(pillar.imported_article_id || "").trim(),
        });
      }
      for (const c of cl.clusters || []) {
        const t = (c.title || "").trim();
        if (!t) continue;
        out.push({
          temp_id: `${cl.id}::${c.id}`,
          title: t,
          focus_keyphrase: (c.keywords || [])[0] || t,
          keywords: c.keywords || [],
          skip: !!(c.imported_article_id || "").trim(),
        });
      }
    }
    return out;
  }, [topicClusters]);

  const clusterValidation = useClusterValidation(projectId, validatableTopics, {
    enabled: tab === "research" && researchSubTab === "cluster",
  });
  const settingsDirty = useMemo(() => {
    if (!settings) return false;
    return (
      sName.trim() !== (settings.name || "").trim() ||
      (sUrl || "") !== (settings.wp_site_url || settings.website_url || "") ||
      (sWpUser || "") !== (settings.wp_username || "") ||
      (sWpDefaultPostType || "") !== ((settings.default_wp_rest_base || "posts") as string) ||
      (sWpDefaultStatus || "") !== ((settings.default_wp_status || "draft") as string) ||
      JSON.stringify((sWpDefaultCategoryIds || []).slice().sort((a, b) => a - b)) !==
        JSON.stringify(((settings.default_wp_category_ids || []) as number[]).slice().sort((a, b) => a - b)) ||
      !!sWpPass.trim()
    );
  }, [sName, sUrl, sWpUser, sWpPass, settings, sWpDefaultPostType, sWpDefaultStatus, sWpDefaultCategoryIds]);

  const identityDirty = useMemo(() => {
    if (!projectMeta) return false;
    const sortedJoin = (xs: string[] | null | undefined) =>
      JSON.stringify((xs || []).slice().sort());
    return (
      (brandVoice || "").trim() !== ((projectMeta.brand_voice || "") as string).trim() ||
      sortedJoin(brandTones) !== sortedJoin((projectMeta.brand_tones || []) as string[]) ||
      (brandRules || "").trim() !== ((projectMeta.brand_rules || "") as string).trim() ||
      (nicheTopic || "").trim() !== ((projectMeta.niche_topic || "") as string).trim() ||
      sortedJoin(audienceList) !== sortedJoin((projectMeta.audience || []) as string[]) ||
      sortedJoin(targetCountries) !==
        sortedJoin((projectMeta.target_countries || []) as string[]) ||
      Boolean(targetCountriesAll) !== Boolean(projectMeta.target_countries_all) ||
      sortedJoin(targetCities) !==
        sortedJoin((projectMeta.target_cities || []) as string[]) ||
      Boolean(targetCitiesAll) !== Boolean(projectMeta.target_cities_all)
    );
  }, [
    projectMeta,
    brandVoice,
    brandTones,
    brandRules,
    nicheTopic,
    audienceList,
    targetCountries,
    targetCountriesAll,
    targetCities,
    targetCitiesAll,
  ]);
  const [articles, setArticles] = useState<ArticlePublic[]>([]);
  const [scheduledJobs, setScheduledJobs] = useState<import("@/lib/api").ScheduledJobPublic[]>([]);
  const [scheduledLoading, setScheduledLoading] = useState(false);
  const [scheduledSearch, setScheduledSearch] = useState("");
  const [scheduledOrder, setScheduledOrder] = useState<"desc" | "asc">("desc");
  const [title, setTitle] = useState("");
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showBulkPopup, setShowBulkPopup] = useState(false);
  const [showAddArticle, setShowAddArticle] = useState(false);
  const [showExportArticles, setShowExportArticles] = useState(false);
  const [exportFrom, setExportFrom] = useState("");
  const [exportTo, setExportTo] = useState("");
  const [exportStatus, setExportStatus] = useState<StatusFilter>("");
  const [exporting, setExporting] = useState(false);
  const [showBulkUpload, setShowBulkUpload] = useState(false);
  const [bulkUploadErrors, setBulkUploadErrors] = useState<string[]>([]);
  const [bulkUploadRows, setBulkUploadRows] = useState<BulkUploadRow[]>([]);
  const [bulkUploading, setBulkUploading] = useState(false);
  const [bulkParseDupTitles, setBulkParseDupTitles] = useState<string[]>([]);
  const [postImportDupTitles, setPostImportDupTitles] = useState<string[] | null>(null);
  const [postImportProjectSkipped, setPostImportProjectSkipped] = useState(0);
  const [bulkProjectDupModal, setBulkProjectDupModal] = useState<{
    projectDuplicates: ProjectDupRow[];
    inFileDuplicateTitles: string[];
    wouldCreateCount: number;
  } | null>(null);
  const [addArticleDupModal, setAddArticleDupModal] = useState<{
    message: string;
    duplicates: ProjectDupRow[];
  } | null>(null);
  const [bulkDupExpandList, setBulkDupExpandList] = useState(false);
  const [bulkMode, setBulkMode] = useState<"root" | "change_status" | "schedule">("root");
  const [scheduleMin, setScheduleMin] = useState("");
  const [editJobMin, setEditJobMin] = useState("");
  const [bulkScheduleMin, setBulkScheduleMin] = useState("");
  const [bulkScheduleRows, setBulkScheduleRows] = useState<Array<{ id: string; title: string; when: string }>>([]);
  const [bulkScheduleWpStatus, setBulkScheduleWpStatus] = useState<"draft" | "publish">("draft");
  const [bulkSchedulePostType, setBulkSchedulePostType] = useState("posts");
  const [bulkScheduling, setBulkScheduling] = useState(false);

  // Research module state
  const [researchBrandNiche, setResearchBrandNiche] = useState("");
  const [researchIntent, setResearchIntent] = useState<ResearchIntent>("informational");
  const [researchTone, setResearchTone] = useState<ResearchTone>("professional");
  const [researchSeeds, setResearchSeeds] = useState<string[]>([]);
  const [researchSeedInput, setResearchSeedInput] = useState("");
  const [researchCountry, setResearchCountry] = useState(DEFAULT_COUNTRY_CODE);
  const [researchLanguage, setResearchLanguage] = useState("en");
  const [researchBusy, setResearchBusy] = useState(false);
  const [researchGeneratingMore, setResearchGeneratingMore] = useState(false);
  const [researchMsg, setResearchMsg] = useState<string | null>(null);
  const [researchResults, setResearchResults] = useState<ResearchIdeaRow[]>([]);
  const [researchLatestRunId, setResearchLatestRunId] = useState<string | null>(null);
  const [researchFilter, setResearchFilter] = useState<ResearchFilter>("latest");
  const [researchSelected, setResearchSelected] = useState<Set<string>>(new Set());
  const [researchImporting, setResearchImporting] = useState(false);
  const [researchImportMsg, setResearchImportMsg] = useState<string | null>(null);
  const [researchHydrated, setResearchHydrated] = useState(false);
  const [researchKeywordAnalysis, setResearchKeywordAnalysis] = useState<{
    primary_keywords: string[];
    supporting_keywords: string[];
    notes: string;
  } | null>(null);
  const [researchImportDupModal, setResearchImportDupModal] = useState<{
    projectDuplicates: ProjectDupRow[];
    inFileDuplicateTitles: string[];
    wouldCreateCount: number;
  } | null>(null);

  // Prompts module state (staged edits; saved on demand)
  const [writingPrompts, setWritingPrompts] = useState<PromptListResponse | null>(null);
  const [imagePrompts, setImagePrompts] = useState<PromptListResponse | null>(null);
  const [promptsLoading, setPromptsLoading] = useState(false);
  const [promptsSaving, setPromptsSaving] = useState(false);

  type PromptDraft = { id: string; name: string; text: string; isNew?: boolean };
  const [wpDrafts, setWpDrafts] = useState<PromptDraft[]>([]);
  const [ipDrafts, setIpDrafts] = useState<PromptDraft[]>([]);
  const [wpDefault, setWpDefault] = useState<string>("");
  const [ipDefault, setIpDefault] = useState<string>("");
  const [wpDeleted, setWpDeleted] = useState<Set<string>>(new Set());
  const [ipDeleted, setIpDeleted] = useState<Set<string>>(new Set());
  const [showPromptModal, setShowPromptModal] = useState<null | { kind: "writing" | "image"; id: string }>(null);
  const [draftName, setDraftName] = useState("");
  const [draftText, setDraftText] = useState("");
  const [draftSetDefault, setDraftSetDefault] = useState(false);

  // Context links module state (staged edits; saved on demand)
  type LinkDraft = { id: string; label: string; url: string; isNew?: boolean };
  const [linksLoading, setLinksLoading] = useState(false);
  const [linksSaving, setLinksSaving] = useState(false);
  const [linkDrafts, setLinkDrafts] = useState<LinkDraft[]>([]);
  const [linkDeleted, setLinkDeleted] = useState<Set<string>>(new Set());
  const [showLinkModal, setShowLinkModal] = useState<null | { id: string }>(null);
  const [linkPhrase, setLinkPhrase] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
  const [linkSearch, setLinkSearch] = useState("");
  const [linkPage, setLinkPage] = useState(1);

  // Toolbar
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<StatusFilter>("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [dateOrder, setDateOrder] = useState<"desc" | "asc">("desc");
  const [page, setPage] = useState(1);
  const [profileTz, setProfileTz] = useState<string>("");
  const [profile, setProfile] = useState<import("@/lib/api").ProfilePublic | null>(null);
  const [showMobileFilters, setShowMobileFilters] = useState(false);

  // Bulk selection
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const selectedIds = useMemo(() => Object.keys(selected).filter((k) => selected[k]), [selected]);

  // Per-article actions
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [scheduleId, setScheduleId] = useState<string | null>(null);
  const [requestIndexingId, setRequestIndexingId] = useState<string | null>(null);
  const [requestIndexingBusy, setRequestIndexingBusy] = useState(false);
  const [requestIndexingMsg, setRequestIndexingMsg] = useState<string>("");
  const [requestIndexingResult, setRequestIndexingResult] = useState<
    import("@/lib/api").RequestIndexingResponse | null
  >(null);
  const [scheduleWhen, setScheduleWhen] = useState("");
  const [scheduleWpStatus, setScheduleWpStatus] = useState<"draft" | "publish">("draft");
  const [schedulePostType, setSchedulePostType] = useState("posts");
  const [wpDefaults, setWpDefaults] = useState<{ post_type: string; wp_status: "draft" | "publish" } | null>(null);
  const [wpTypesForSchedule, setWpTypesForSchedule] = useState<import("@/lib/api").WordpressPostType[]>([]);
  const [wpCatsForSchedule, setWpCatsForSchedule] = useState<import("@/lib/api").WordpressCategory[]>([]);
  const [scheduleWritingPrompts, setScheduleWritingPrompts] = useState<PromptListResponse | null>(null);
  const [scheduleImagePrompts, setScheduleImagePrompts] = useState<PromptListResponse | null>(null);
  const [scheduleWritingPromptId, setScheduleWritingPromptId] = useState<string>("");
  const [scheduleImagePromptId, setScheduleImagePromptId] = useState<string>("");

  const [editJob, setEditJob] = useState<null | import("@/lib/api").ScheduledJobPublic>(null);
  const [editJobWhen, setEditJobWhen] = useState("");
  const [editJobPostType, setEditJobPostType] = useState("posts");
  const [editJobStatus, setEditJobStatus] = useState<"draft" | "publish">("draft");
  const [editJobCats, setEditJobCats] = useState<number[]>([]);
  const [confirmCancelJob, setConfirmCancelJob] = useState<null | import("@/lib/api").ScheduledJobPublic>(null);
  const [confirmPostNowJob, setConfirmPostNowJob] = useState<null | import("@/lib/api").ScheduledJobPublic>(null);
  const [postNowBusy, setPostNowBusy] = useState(false);

  const pageSize = 10;

  // Hydrate persisted research state once per project.
  useEffect(() => {
    if (!projectId) return;
    const persisted = loadPersistedResearch(projectId);
    if (persisted) {
      setResearchSeeds(Array.isArray(persisted.seeds) ? persisted.seeds.slice(0, 200) : []);
      setResearchResults(Array.isArray(persisted.results) ? persisted.results : []);
      setResearchLatestRunId(persisted.latestRunId || null);
      if (typeof persisted.brandNiche === "string") setResearchBrandNiche(persisted.brandNiche);
      if (persisted.intent) setResearchIntent(persisted.intent);
      if (persisted.tone) setResearchTone(persisted.tone);
      if (persisted.country) setResearchCountry(persisted.country);
      if (persisted.language) setResearchLanguage(persisted.language);
      if (persisted.filter) setResearchFilter(persisted.filter);
    }
    setResearchHydrated(true);
  }, [projectId]);

  // Reconcile imported flag against actual articles in the project (covers manual deletes
  // or imports made via the Articles tab using the same title/focus pair).
  useEffect(() => {
    if (!researchHydrated) return;
    if (!researchResults.length) return;
    if (!articles || !articles.length) return;
    const titleToId = new Map<string, string>();
    for (const a of articles) {
      const k = (a.title || "").trim().toLowerCase();
      if (!k) continue;
      if (!titleToId.has(k)) titleToId.set(k, a.id);
    }
    let changed = false;
    const next = researchResults.map((r) => {
      const k = (r.title || "").trim().toLowerCase();
      const matched = k ? titleToId.get(k) : undefined;
      if (matched && (!r.imported || !r.imported_article_id)) {
        changed = true;
        return {
          ...r,
          imported: true,
          imported_article_id: matched,
          imported_at: r.imported_at || new Date().toISOString(),
        };
      }
      return r;
    });
    if (changed) setResearchResults(next);
  }, [articles, researchHydrated, researchResults]);

  // Persist research state on changes (after hydration).
  useEffect(() => {
    if (!researchHydrated || !projectId) return;
    persistResearch(projectId, {
      v: 1,
      seeds: researchSeeds,
      results: researchResults,
      latestRunId: researchLatestRunId,
      brandNiche: researchBrandNiche,
      intent: researchIntent,
      tone: researchTone,
      country: researchCountry,
      language: researchLanguage,
      filter: researchFilter,
    });
  }, [
    researchHydrated,
    projectId,
    researchSeeds,
    researchResults,
    researchLatestRunId,
    researchBrandNiche,
    researchIntent,
    researchTone,
    researchCountry,
    researchLanguage,
    researchFilter,
  ]);

  useEffect(() => {
    if (!token) {
      router.replace("/login");
      return;
    }
    (async () => {
      setError(null);
      setLoading(true);
      try {
        const [list, ps, prof, limits] = await Promise.all([
          api.listArticles(projectId),
          api.getProjectSettings(projectId),
          api.profileMe(),
          api.projectFeatureLimits(projectId).catch(() => null),
        ]);
        setArticles(list);
        setFeatureLimits(limits);
        setProfile(prof);
        setProfileTz((prof?.timezone || "").trim());
        setWpDefaults({
          post_type: (ps.default_wp_rest_base || "posts") as string,
          wp_status: ((ps.default_wp_status || "draft") as "draft" | "publish"),
        });
      } catch {
        clearAuth();
        router.replace("/login");
      } finally {
        setLoading(false);
      }
    })();
  }, [projectId, router, token]);

  // Load the user's full project list so the sidebar switcher can render
  // every project they own. Runs once per mount — projects rarely change
  // mid-session and any rename inside *this* page already mutates the
  // entry locally (see ``saveSettings``). A failure is non-fatal: the
  // dropdown simply falls back to a single read-only entry showing the
  // current project's name.
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      try {
        const list = await api.listProjects();
        if (!cancelled) setProjectsList(list || []);
      } catch {
        // Silent — sidebar dropdown gracefully degrades to "current project only".
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  // Bootstrap GSC status (and analytics, if a property is linked) once per project mount,
  // independent of the active tab. Without this the "Performance & Analysis" nav entry
  // only appears after the user opens Tools, because ``performanceTabAvailable`` depends
  // on both ``gscStatus.connected`` and a non-empty analytics payload.
  useEffect(() => {
    if (!token || !projectId) return;
    let cancelled = false;
    (async () => {
      try {
        const gs = await api.gscProjectStatus(projectId);
        if (cancelled) return;
        setGscStatus(gs);
        setGscApiUnavailable(false);
        if (gs?.connected && (gs?.property_url || "").trim()) {
          try {
            const res = await api.gscProjectAnalytics(projectId, { days: 28 });
            if (!cancelled) setAnalytics(res);
          } catch {
            // Silent — the Performance tab simply won't appear until data is available.
          }
        }
      } catch (e) {
        if (cancelled) return;
        if (e instanceof ApiError && e.status === 404) {
          setGscApiUnavailable(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, token]);

  async function ensureScheduleMetaLoaded() {
    if (wpTypesForSchedule.length || wpCatsForSchedule.length || scheduleWritingPrompts || scheduleImagePrompts) return;
    try {
      const [types, cats, wp, ip] = await Promise.all([
        api.wordpressPostTypes(projectId, { timeoutMs: 8000 }),
        api.wordpressCategories(projectId, { timeoutMs: 8000 }),
        api.listWritingPrompts(projectId),
        api.listImagePrompts(projectId),
      ]);
      setWpTypesForSchedule(types);
      setWpCatsForSchedule(cats);
      setScheduleWritingPrompts(wp);
      setScheduleImagePrompts(ip);
      setScheduleWritingPromptId(wp.default_id || "");
      setScheduleImagePromptId(ip.default_id || "");
    } catch {
      // ignore
    }
  }

  function formatInProfileTz(utcLike: string | null | undefined) {
    const v = (utcLike || "").trim();
    if (!v) return "—";
    const iso = v.includes("T") ? v : v.replace(" ", "T") + "Z";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return v;
    const tz = profileTz || Intl.DateTimeFormat().resolvedOptions().timeZone;
    try {
      return new Intl.DateTimeFormat(undefined, {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }).format(d);
    } catch {
      return d.toLocaleString();
    }
  }

  async function requestIndexingOne(articleId: string) {
    setRequestIndexingBusy(true);
    setRequestIndexingMsg("Pinging Google’s discovery endpoints…");
    setRequestIndexingResult(null);
    try {
      const res = await api.requestIndexing(projectId, articleId);
      setRequestIndexingResult(res);
      const parts: string[] = [];
      if (res?.indexing_api?.attempted) {
        parts.push(res.indexing_api.ok ? "Indexing API ping sent." : "Indexing API ping failed.");
      }
      if (res?.sitemap_ping?.attempted) {
        parts.push(res.sitemap_ping.ok ? "Sitemap pinged." : "Sitemap ping failed.");
      }
      if (!parts.length) parts.push("No automated channel was available.");
      parts.push("Press 'Open in Search Console' to finish via the manual REQUEST INDEXING button.");
      setRequestIndexingMsg(parts.join(" "));
      const newStatus = (res?.gsc_status || "manual_required").toString();
      setArticles((prev) =>
        prev.map((a) => (a.id === articleId ? { ...a, gsc_status: newStatus } : a)),
      );
    } catch (e) {
      setRequestIndexingMsg((e as Error)?.message || "Request failed.");
    } finally {
      setRequestIndexingBusy(false);
    }
  }

  function toDatetimeLocalInProfileTz(utcLike: string) {
    const v = (utcLike || "").trim();
    if (!v) return "";
    const iso = v.includes("T") ? v : v.replace(" ", "T") + "Z";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const tz = profileTz || Intl.DateTimeFormat().resolvedOptions().timeZone;
    try {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).formatToParts(d);
      const get = (type: string) => parts.find((p) => p.type === type)?.value || "";
      const y = get("year");
      const m = get("month");
      const day = get("day");
      const hh = get("hour");
      const mm = get("minute");
      if (!y || !m || !day || !hh || !mm) return "";
      return `${y}-${m}-${day}T${hh}:${mm}`;
    } catch {
      return "";
    }
  }

  function toDatetimeLocalFromDateInProfileTz(d: Date) {
    if (Number.isNaN(d.getTime())) return "";
    const tz = profileTz || Intl.DateTimeFormat().resolvedOptions().timeZone;
    try {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).formatToParts(d);
      const get = (type: string) => parts.find((p) => p.type === type)?.value || "";
      const y = get("year");
      const m = get("month");
      const day = get("day");
      const hh = get("hour");
      const mm = get("minute");
      if (!y || !m || !day || !hh || !mm) return "";
      return `${y}-${m}-${day}T${hh}:${mm}`;
    } catch {
      return toDatetimeLocalValue(d);
    }
  }

  function dedupeScheduledJobs(rows: import("@/lib/api").ScheduledJobPublic[]) {
    const bestByArticle = new Map<string, import("@/lib/api").ScheduledJobPublic>();
    type JobWithTimestamps = import("@/lib/api").ScheduledJobPublic & { updated_at?: string; created_at?: string };
    const score = (j: import("@/lib/api").ScheduledJobPublic) => {
      const jj = j as JobWithTimestamps;
      const s = jj.updated_at || jj.created_at || j.run_at || "";
      return typeof s === "string" ? s : "";
    };
    for (const j of rows || []) {
      const aid = (j.article_id || "").trim();
      if (!aid) continue;
      const cur = bestByArticle.get(aid);
      if (!cur) {
        bestByArticle.set(aid, j);
        continue;
      }
      if (score(j) > score(cur)) bestByArticle.set(aid, j);
    }
    const out = Array.from(bestByArticle.values());
    out.sort((a, b) => (b.run_at || "").localeCompare(a.run_at || ""));
    return out;
  }

  useEffect(() => {
    if (!token) return;
    if (tab !== "scheduled_articles") return;
    (async () => {
      setError(null);
      setScheduledLoading(true);
      try {
        const jobs = await api.listScheduledJobs(projectId);
        setScheduledJobs(dedupeScheduledJobs(jobs));
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load scheduled articles");
      } finally {
        setScheduledLoading(false);
      }
    })();
  }, [projectId, tab, token]);

  useEffect(() => {
    if (!token) return;
    if (tab !== "project_settings") return;
    (async () => {
      setError(null);
      setGscSaveMsg(null);
      setSettingsLoading(true);
      setGscLoading(true);
      try {
      // Use ``allSettled`` so a stale backend (404 on the per-project GSC route) does not
      // wipe the rest of the settings tab — we surface the deployment-lag hint instead.
      const [sRes, gsRes, pmRes] = await Promise.allSettled([
        api.getProjectSettings(projectId),
        api.gscProjectStatus(projectId),
        api.getProject(projectId),
      ]);
      if (sRes.status !== "fulfilled") throw sRes.reason;
      if (pmRes.status !== "fulfilled") throw pmRes.reason;
      const s = sRes.value;
      const pm = pmRes.value;
      setSettings(s);
      setProjectMeta(pm);
      setSName(s.name || "");
      setSUrl(s.wp_site_url || s.website_url || "");
      setSWpUser(s.wp_username || "");
      setSWpPass("");
      setBrandVoice((pm?.brand_voice || "") as string);
      setBrandTones(((pm?.brand_tones || []) as string[]).slice());
      setBrandRules((pm?.brand_rules || "") as string);
      setNicheTopic((pm?.niche_topic || "") as string);
      setAudienceList(((pm?.audience || []) as string[]).slice());
      setTargetCountries(
        ((pm?.target_countries || []) as string[]).map((c) => (c || "").toUpperCase()),
      );
      setTargetCountriesAll(Boolean(pm?.target_countries_all));
      setTargetCitiesAll(Boolean(pm?.target_cities_all));
      setTargetCities(((pm?.target_cities || []) as string[]).slice());
      setAudienceCustomDraft("");
      setCityCustomDraft("");
      setCountryFilter("");
      setSWpDefaultPostType((s.default_wp_rest_base || "posts") as string);
      setSWpDefaultStatus(((s.default_wp_status || "draft") as "draft" | "publish"));
      setSWpDefaultCategoryIds((s.default_wp_category_ids || []) as number[]);
      setSGscPropertyUrl((s.gsc_property_url || "") as string);
      setSGscIndexOnPublish(Boolean(s.gsc_index_on_publish ?? true));
      if (gsRes.status === "fulfilled") {
        setGscStatus(gsRes.value);
        setGscApiUnavailable(false);
      } else if (gsRes.reason instanceof ApiError && gsRes.reason.status === 404) {
        setGscApiUnavailable(true);
        setGscMsg(
          "Backend is missing the per-project Search Console routes. Pull the latest code on the VPS and restart the FastAPI service (or recreate the Docker container)."
        );
      }
      setSettingsVerify(null);

      // Load WP options for defaults if connected
      try {
        const [types, cats] = await Promise.all([
          api.wordpressPostTypes(projectId),
          api.wordpressCategories(projectId),
        ]);
        setSettingsPostTypes(types);
        setSettingsCategories(cats);
      } catch {
        setSettingsPostTypes([]);
        setSettingsCategories([]);
      }

      try {
        if (gsRes.status === "fulfilled" && gsRes.value?.connected) {
          const sites = await api.gscProjectListSites(projectId);
          setGscSites(sites || []);
        } else {
          setGscSites([]);
        }
      } catch {
        setGscSites([]);
      }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load project settings");
      } finally {
        setSettingsLoading(false);
        setGscLoading(false);
      }
    })();
  }, [projectId, tab, token]);

  async function saveSettings() {
    if (!settings) return;
    setError(null);
    setGscSaveMsg(null);
    setSettingsSaving(true);
    try {
      const saved = await api.updateProjectSettings(projectId, {
        name: sName,
        wp_site_url: sUrl,
        wp_username: sWpUser,
        default_wp_rest_base: sWpDefaultPostType,
        default_wp_status: sWpDefaultStatus,
        default_wp_category_ids: sWpDefaultCategoryIds,
        ...(sWpPass.trim() ? { wp_app_password: sWpPass } : {}),
      });
      setSettings(saved);
      setSWpPass("");
      // Keep the sidebar project switcher in sync with project renames
      // without forcing a refetch of the entire list.
      setProjectsList((prev) =>
        prev.map((p) => (p.id === projectId ? { ...p, name: saved.name || p.name } : p)),
      );
      if (identityDirty) {
        const pm2 = await api.updateProject(projectId, {
          brand_voice: (brandVoice || "").trim(),
          brand_tones: brandTones.slice(),
          brand_rules: (brandRules || "").trim(),
          niche_topic: (nicheTopic || "").trim(),
          audience: audienceList.slice(),
          // When "all countries" is on we send the flag and an empty list
          // (the backend treats the flag as the source of truth so this
          // stays internally consistent).
          target_countries: targetCountriesAll ? [] : targetCountries.slice(),
          target_countries_all: !!targetCountriesAll,
          target_cities: targetCitiesAll ? [] : targetCities.slice(),
          target_cities_all: !!targetCitiesAll,
        });
        setProjectMeta(pm2);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save settings");
    } finally {
      setSettingsSaving(false);
    }
  }

  /**
   * Verify the WordPress connection from the Project Settings tab.
   *
   * The dashboard's "Connect WordPress" popup persists the credentials
   * *before* hitting the verify endpoint so the saved record always matches
   * what was tested. We follow the same pattern here: PATCH the current form
   * values into ``/settings`` first, then call ``/verify`` (which will pick
   * up the freshly-saved credentials), then reload settings so the persisted
   * ``wp_verified_at`` snapshot drives the green status pill on next render.
   *
   * If the user only changed ``sUrl``/``sWpUser`` we still send those —
   * patching same-as-before fields is a safe no-op and the backend's
   * "creds_changed" guard will only invalidate the verification cache when
   * something actually changed.
   */
  async function verifySettings() {
    setSettingsVerify(null);
    setSettingsVerifying(true);
    try {
      // Step 1: persist whatever the user currently typed so the verification
      // snapshot lines up with what's stored. ``wp_app_password`` is only
      // included when typed (the input shows "•••••• (set)" when not).
      const patch: Parameters<typeof api.updateProjectSettings>[1] = {
        wp_site_url: sUrl.trim(),
        wp_username: sWpUser.trim(),
      };
      if (sWpPass.trim()) {
        patch.wp_app_password = sWpPass.trim();
      }
      try {
        await api.updateProjectSettings(projectId, patch);
      } catch {
        // Persisting is best-effort here — proceed to verify anyway with
        // overrides so the user can still see the result of their input.
      }

      // Step 2: verify. We pass overrides too so an unsaved password is still
      // tested if the patch above failed.
      const res = await api.verifyWordpress(projectId, {
        wp_site_url: sUrl.trim(),
        wp_username: sWpUser.trim(),
        ...(sWpPass.trim() ? { wp_app_password: sWpPass.trim() } : {}),
      });
      setSettingsVerify(res);

      // Step 3: pull the new ``wp_verified_at`` / ``wp_verified_status``
      // snapshot from the backend so the persistent status pill is up-to-date.
      try {
        const fresh = await api.getProjectSettings(projectId);
        setSettings(fresh);
        // Clear the typed app-password field on success — the value is now
        // stored server-side and the placeholder will switch to "•••••• (set)".
        if (res.ok) setSWpPass("");
      } catch {
        // Settings refresh failure is non-fatal; the inline ``settingsVerify``
        // result still shows the immediate outcome.
      }
    } catch (e) {
      setSettingsVerify({ ok: false, status: "error", message: e instanceof Error ? e.message : "Verify failed" });
    } finally {
      setSettingsVerifying(false);
    }
  }

  async function reloadGscForProject(opts: { showLoading?: boolean } = {}) {
    if (!projectId) return;
    if (opts.showLoading) setGscLoading(true);
    try {
      const gs = await api.gscProjectStatus(projectId);
      setGscStatus(gs);
      setGscApiUnavailable(false);
      if ((gs?.property_url || "") !== undefined && gs?.property_url) {
        setSGscPropertyUrl(gs.property_url);
      }
      setSGscIndexOnPublish(Boolean(gs?.index_on_publish ?? true));
      if (gs?.connected) {
        try {
          const sites = await api.gscProjectListSites(projectId);
          setGscSites(sites || []);
        } catch {
          setGscSites([]);
        }
      } else {
        setGscSites([]);
      }
    } catch (e) {
      // 404 on the per-project route means the backend hasn't been redeployed with
      // the latest code (the legacy build doesn't expose /api/projects/:id/gsc/*).
      // Treat that as a separate, actionable state rather than the generic "not configured".
      if (e instanceof ApiError && e.status === 404) {
        setGscApiUnavailable(true);
        setGscMsg(
          "Backend is missing the per-project Search Console routes. Pull the latest code on the VPS and restart the FastAPI service (or recreate the Docker container)."
        );
      } else {
        setGscApiUnavailable(false);
        setGscMsg(e instanceof Error ? e.message : "Failed to refresh Search Console status");
      }
    } finally {
      if (opts.showLoading) setGscLoading(false);
    }
  }

  async function connectGscForProject() {
    setGscMsg(null);
    setGscConnecting(true);
    try {
      const res = await api.gscProjectConnectUrl(projectId);
      if (res?.url) {
        window.location.href = res.url;
      } else {
        throw new Error("No OAuth URL returned");
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        setGscApiUnavailable(true);
        setGscMsg(
          "Backend is missing the per-project Search Console routes. Pull the latest code on the VPS and restart the FastAPI service (or recreate the Docker container)."
        );
      } else if (e instanceof ApiError && e.status === 400) {
        // Backend explicitly told us OAuth is not configured.
        setGscMsg(
          (e.message && e.message.toLowerCase().includes("oauth"))
            ? "Google OAuth is not configured on the server. Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in the backend env, then restart the backend service. (Tip: curl /api/health to verify the running process picked them up.)"
            : (e.message || "Could not start Google connect")
        );
      } else {
        setGscMsg(e instanceof Error ? e.message : "Could not start Google connect");
      }
      setGscConnecting(false);
    }
  }

  async function disconnectGscForProject() {
    setGscMsg(null);
    setGscDisconnecting(true);
    try {
      await api.gscProjectDisconnect(projectId);
      setSGscPropertyUrl("");
      setGscSites([]);
      setGscStatus({
        configured: gscStatus?.configured ?? false,
        connected: false,
        email: null,
        connected_at: null,
        property_url: null,
        index_on_publish: gscStatus?.index_on_publish ?? true,
      });
      setGscMsg("Disconnected Google Search Console for this project.");
    } catch (e) {
      setGscMsg(e instanceof Error ? e.message : "Failed to disconnect");
    } finally {
      setGscDisconnecting(false);
      setGscConfirmDisconnect(false);
    }
  }

  async function reloadProjectSitemaps(opts: { silent?: boolean } = {}) {
    if (!projectId) return;
    if (!opts.silent) setSitemapBusy("load");
    setSitemapMsg(null);
    try {
      const res = await api.gscProjectListSitemaps(projectId);
      setGscSitemaps(res?.sitemaps || []);
      setGscSitemapSuggested(res?.suggested_sitemap_url || "");
      setSitemapInput((prev) => prev || res?.suggested_sitemap_url || "");
    } catch (e) {
      setGscSitemaps([]);
      setSitemapMsg(e instanceof Error ? e.message : "Failed to load sitemaps");
    } finally {
      if (!opts.silent) setSitemapBusy(null);
    }
  }

  async function submitProjectSitemap() {
    if (!projectId) return;
    setSitemapBusy("submit");
    setSitemapMsg(null);
    try {
      const res = await api.gscProjectSubmitSitemap(projectId, sitemapInput.trim() || null);
      setSitemapMsg(
        `Submitted ${res?.sitemap_url || "sitemap"}. Google will recrawl on its own schedule — typically within 24 hours.`,
      );
      await reloadProjectSitemaps({ silent: true });
    } catch (e) {
      setSitemapMsg(e instanceof Error ? e.message : "Sitemap submission failed");
    } finally {
      setSitemapBusy(null);
    }
  }

  async function deleteProjectSitemap(sitemapUrl: string) {
    if (!projectId || !sitemapUrl) return;
    setSitemapBusy("delete");
    setSitemapDeletingPath(sitemapUrl);
    setSitemapMsg(null);
    try {
      await api.gscProjectDeleteSitemap(projectId, sitemapUrl);
      setSitemapMsg(`Removed ${sitemapUrl} from Search Console.`);
      await reloadProjectSitemaps({ silent: true });
    } catch (e) {
      setSitemapMsg(e instanceof Error ? e.message : "Failed to remove sitemap");
    } finally {
      setSitemapBusy(null);
      setSitemapDeletingPath(null);
    }
  }

  // ---- Feature 1: GSC ROI Dashboard handlers -------------------------------
  async function reloadAnalytics(opts: { silent?: boolean } = {}) {
    if (!projectId) return;
    if (!opts.silent) setAnalyticsBusy(true);
    setAnalyticsErr(null);
    try {
      // Resolve the active window: explicit [start,end] when both are filled and the
      // ``"custom"`` chip is selected; otherwise the active preset's day count.
      const callOpts: { days?: number; start?: string; end?: string } = {};
      if (
        analyticsRangePreset === "custom" &&
        analyticsCustomStart &&
        analyticsCustomEnd
      ) {
        callOpts.start = analyticsCustomStart;
        callOpts.end = analyticsCustomEnd;
      } else {
        callOpts.days =
          typeof analyticsRangePreset === "number" ? analyticsRangePreset : 28;
      }
      const res = await api.gscProjectAnalytics(projectId, callOpts);
      setAnalytics(res);
      // Seed the custom-range pickers with whatever the server actually used so the
      // user can tweak from a sensible starting point without re-typing dates.
      if (res?.range?.start_date && !analyticsCustomStart) {
        setAnalyticsCustomStart(res.range.start_date);
      }
      if (res?.range?.end_date && !analyticsCustomEnd) {
        setAnalyticsCustomEnd(res.range.end_date);
      }
    } catch (e) {
      // Backend versions before this rollout will 404 the route — surface a clear message.
      const status = e instanceof ApiError ? e.status : null;
      if (status === 404) {
        setAnalyticsErr(
          "Backend is missing the new analytics route. Pull the latest code on the VPS and restart the FastAPI service (or recreate the Docker container).",
        );
      } else {
        setAnalyticsErr(e instanceof Error ? e.message : "Failed to load analytics");
      }
      setAnalytics(null);
    } finally {
      if (!opts.silent) setAnalyticsBusy(false);
    }
  }

  // ---- Feature 3: Site Map handlers ----------------------------------------
  async function reloadSiteMap(opts: { silent?: boolean } = {}) {
    if (!projectId) return;
    if (!opts.silent) setSiteMapBusy(true);
    try {
      const res = await api.siteMapList(projectId);
      setSiteMap(res);
    } catch (e) {
      setSiteMap({ count: 0, entries: [], wp_site_url: null });
      setSiteMapMsg(e instanceof Error ? e.message : "Failed to load site map");
    } finally {
      if (!opts.silent) setSiteMapBusy(false);
    }
  }

  async function syncSiteMap() {
    if (!projectId) return;
    setSiteMapBusy(true);
    setSiteMapMsg(null);
    try {
      const res = await api.siteMapSync(projectId);
      setSiteMapMsg(
        res.truncated
          ? `Synced ${res.count} posts (truncated — your site has more than 5,000 posts; the WP plugin push path lands next iteration).`
          : `Synced ${res.count} posts. Internal-link engine will use this list for new articles.`,
      );
      await reloadSiteMap({ silent: true });
    } catch (e) {
      setSiteMapMsg(e instanceof Error ? e.message : "Site-map sync failed");
    } finally {
      setSiteMapBusy(false);
    }
  }

  // ---- Feature 4: monitor mark (used in articles list) ---------------------
  async function markArticleMonitor(articleId: string, status: "fresh" | "stale" | "unknown") {
    if (!projectId || !articleId) return;
    try {
      const res = await api.articleMarkMonitor(projectId, articleId, status);
      const newStatus = res?.monitor?.status || status;
      // Optimistic local update so the list re-renders immediately.
      setArticles((rows) =>
        rows.map((r) => (r.id === articleId ? { ...r, monitor_status: newStatus } : r)),
      );
    } catch (e) {
      // Errors here surface in the row's tooltip via the next list reload.
      console.warn("Mark monitor failed:", e);
    }
  }

  async function saveGscPropertyForProject(propertyUrl: string, indexOnPublish: boolean) {
    setGscSaveMsg(null);
    try {
      const res = await api.gscProjectSetProperty(projectId, {
        property_url: propertyUrl || "",
        index_on_publish: indexOnPublish,
      });
      setSGscPropertyUrl(res?.property_url || "");
      setSGscIndexOnPublish(Boolean(res?.index_on_publish));
      setGscStatus((s) =>
        s
          ? { ...s, property_url: res?.property_url || null, index_on_publish: Boolean(res?.index_on_publish) }
          : s,
      );
      setGscSaveMsg(
        propertyUrl
          ? "Property linked. Google Search Console will be used for this project."
          : "Property cleared.",
      );
    } catch (e) {
      setGscMsg(e instanceof Error ? e.message : "Failed to save Search Console property");
    }
  }

  async function requestArticleIndexing(articleId: string) {
    if (!articleId) return;
    setArticleIndexBusy((m) => ({ ...m, [articleId]: "request" }));
    setArticleIndexMsg((m) => ({ ...m, [articleId]: null }));
    setArticleIndexResult((m) => ({ ...m, [articleId]: null }));
    try {
      const res = await api.requestIndexing(projectId, articleId);
      setArticleIndexResult((m) => ({ ...m, [articleId]: res }));
      // Build a short, accurate one-liner that does not claim more than what really happened.
      const parts: string[] = [];
      if (res?.indexing_api?.attempted) {
        parts.push(res.indexing_api.ok ? "Indexing API ping sent." : "Indexing API ping failed.");
      }
      if (res?.sitemap_ping?.attempted) {
        parts.push(res.sitemap_ping.ok ? "Sitemap pinged." : "Sitemap ping failed.");
      }
      parts.push("Click 'Open in Search Console' to finish via the manual Request Indexing button.");
      setArticleIndexMsg((m) => ({ ...m, [articleId]: parts.join(" ") }));
      setArticles((prev) =>
        prev.map((a) => (a.id === articleId ? { ...a, gsc_status: res?.gsc_status || a.gsc_status } : a)),
      );
    } catch (e) {
      setArticleIndexMsg((m) => ({
        ...m,
        [articleId]: e instanceof Error ? e.message : "Indexing request failed",
      }));
    } finally {
      setArticleIndexBusy((m) => ({ ...m, [articleId]: undefined }));
    }
  }

  async function checkArticleIndexing(articleId: string) {
    if (!articleId) return;
    setArticleIndexBusy((m) => ({ ...m, [articleId]: "check" }));
    setArticleIndexMsg((m) => ({ ...m, [articleId]: null }));
    try {
      const res = await api.checkArticleIndexingStatus(projectId, articleId);
      setArticleIndexStatus((m) => ({ ...m, [articleId]: res }));
      const verdict = (res.verdict || res.coverage_state || "").trim() || "Unknown";
      setArticleIndexMsg((m) => ({ ...m, [articleId]: `Status: ${verdict}` }));
    } catch (e) {
      setArticleIndexMsg((m) => ({
        ...m,
        [articleId]: e instanceof Error ? e.message : "Status check failed",
      }));
    } finally {
      setArticleIndexBusy((m) => ({ ...m, [articleId]: undefined }));
    }
  }

  async function deleteProjectNow() {
    setError(null);
    setDeletingProject(true);
    try {
      await api.deleteProject(projectId);
      router.push("/dashboard");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete project");
    } finally {
      setDeletingProject(false);
      setConfirmDeleteProject(false);
    }
  }

  function confirmLoseChanges() {
    if (!settingsDirty) return true;
    return confirm("All the changes will not be saved. Are you sure to cancel?");
  }

  useEffect(() => {
    if (!token) return;
    if (tab !== "prompts") return;
    (async () => {
      setError(null);
      setPromptsLoading(true);
      try {
        const [wp, ip] = await Promise.all([
          api.listWritingPrompts(projectId),
          api.listImagePrompts(projectId),
        ]);
        setWritingPrompts(wp);
        setImagePrompts(ip);
        setWpDrafts((wp.items || []).map((p) => ({ id: p.id, name: p.name, text: p.text })));
        setIpDrafts((ip.items || []).map((p) => ({ id: p.id, name: p.name, text: p.text })));
        setWpDefault(wp.default_id || "");
        setIpDefault(ip.default_id || "");
        setWpDeleted(new Set());
        setIpDeleted(new Set());
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load prompts");
      } finally {
        setPromptsLoading(false);
      }
    })();
  }, [projectId, tab, token]);

  useEffect(() => {
    if (!token) return;
    if (tab !== "context_links") return;
    (async () => {
      setError(null);
      setLinksLoading(true);
      try {
        const items = await api.listContextLinks(projectId);
        setLinkDrafts(items.map((x) => ({ id: x.id, label: x.label, url: x.url })));
        setLinkDeleted(new Set());
        setLinkSearch("");
        setLinkPage(1);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load context links");
      } finally {
        setLinksLoading(false);
      }
    })();
  }, [projectId, tab, token]);

  useEffect(() => {
    if (!token) return;
    if (tab !== "tools") return;
    setGscSaveMsg(null);
    setGscMsg(null);
    void reloadGscForProject({ showLoading: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, tab, token]);

  // Auto-load registered sitemaps once a property is linked. Re-runs whenever the
  // user links / unlinks a property so the table reflects the current property.
  useEffect(() => {
    if (!token) return;
    if (tab !== "tools") return;
    if (!gscStatus?.connected || !gscStatus?.property_url) {
      setGscSitemaps([]);
      setGscSitemapSuggested("");
      return;
    }
    void reloadProjectSitemaps({ silent: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, tab, token, gscStatus?.connected, gscStatus?.property_url]);

  // Feature 1: load analytics when either the Tools tab (mini view, optional) or the
  // Performance & Analysis tab is open AND a property is linked. Re-fetches when the
  // active preset changes; the custom-range chip only refetches when the user clicks
  // "Apply" inside the Performance tab so partial date input doesn't fire requests.
  useEffect(() => {
    if (!token) return;
    if (tab !== "tools" && tab !== "performance") return;
    if (!gscStatus?.connected || !gscStatus?.property_url) {
      setAnalytics(null);
      setAnalyticsErr(null);
      return;
    }
    if (analyticsRangePreset === "custom") {
      // Custom range fetches are explicit (button click) — skip the auto-fetch.
      if (!analytics) void reloadAnalytics();
      return;
    }
    void reloadAnalytics();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, tab, token, gscStatus?.connected, gscStatus?.property_url, analyticsRangePreset]);

  // Feature 3: load the stored site map whenever Tools opens. Sync is manual (button).
  useEffect(() => {
    if (!token) return;
    if (tab !== "tools") return;
    void reloadSiteMap({ silent: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, tab, token]);

  useEffect(() => {
    if (!token) return;
    if (tab !== "research") return;
    void reloadTopicClusters();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, tab, token]);

  // Handle the OAuth redirect (URL contains ?tab=tools#gsc=connected|error&msg=...)
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!projectId) return;
    try {
      const url = new URL(window.location.href);
      const rawHash = (url.hash || "").replace(/^#/, "");
      const hashParams = new URLSearchParams(rawHash);
      const flag = (hashParams.get("gsc") || "").trim();
      const msg = (hashParams.get("msg") || "").trim();
      if (flag === "connected" || flag === "error") {
        setTab("tools");
        if (flag === "connected") {
          setGscOpenedFromOAuth(true);
          setGscMsg(null);
          void reloadGscForProject({ showLoading: true });
        } else {
          setGscMsg(msg || "Google connect failed. Please try again.");
        }
        // Strip only the OAuth hash artefacts. ``setTab("tools")`` already
        // wrote ``?tab=tools`` into the URL via ``router.replace``, and we
        // intentionally keep that param so a refresh leaves the user on the
        // Tools tab where the connection result is shown.
        if (url.hash) {
          url.hash = "";
          window.history.replaceState({}, "", url.toString());
        }
      }
    } catch {
      // ignore
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => {
    queueMicrotask(() => {
      setPage(1);
      setSelected({});
    });
  }, [q, status, dateFrom, dateTo, projectId]);

  async function createArticle() {
    setError(null);
    setAddArticleDupModal(null);
    setCreating(true);
    try {
      const a = await api.createArticle(projectId, title);
      setArticles((prev) => [a, ...prev]);
      setTitle("");
      setShowAddArticle(false);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.detail && typeof e.detail === "object" && e.detail !== null) {
        const d = e.detail as Record<string, unknown>;
        const msg = typeof d.message === "string" ? d.message : e.message;
        const raw = d.duplicates;
        const duplicates: ProjectDupRow[] = Array.isArray(raw)
          ? raw
              .filter((x): x is Record<string, unknown> => x !== null && typeof x === "object")
              .map((x) => ({
                submitted_title: String(x.submitted_title ?? ""),
                existing_title: String(x.existing_title ?? ""),
                existing_id: String(x.existing_id ?? ""),
              }))
          : [];
        setAddArticleDupModal({ message: msg, duplicates });
        return;
      }
      setError(e instanceof Error ? e.message : "Failed to create article");
    } finally {
      setCreating(false);
    }
  }

  function createdAtMs(a: { created_at?: string | null }) {
    const d = parseCreatedAt(a.created_at);
    return d ? d.getTime() : 0;
  }

  async function exportArticlesNow() {
    setError(null);
    setExporting(true);
    try {
      await api.consumeExportQuota(projectId);
      const all = await api.listArticles(projectId);
      const df = parseDateOnly(exportFrom);
      const dt = parseDateOnly(exportTo);

      const filteredForExport = (all || [])
        .filter((a) => {
          if (exportStatus && (a.status || "").toLowerCase() !== exportStatus) return false;
          const ca = parseCreatedAt(a.created_at);
          if (df && ca && ca < df) return false;
          if (dt && ca) {
            const end = new Date(dt.getTime() + 24 * 60 * 60 * 1000);
            if (ca >= end) return false;
          }
          return true;
        })
        .sort((a, b) => createdAtMs(b) - createdAtMs(a));

      const rows: Array<[string, string, string, string, string]> = filteredForExport.map((a) => [
        (a.title || "").trim(),
        (a.focus_keyphrase || "").trim(),
        (a.keywords || []).join(", "),
        (a.status || "").toUpperCase(),
        (a.wp_link || "").trim(),
      ]);

      const XLSX = await import("xlsx");
      const header: [string, string, string, string, string] = ["Article Title", "Focus Keyphrase", "Targeting/support keywords", "Status", "Live URL"];
      const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
      ws["!cols"] = [{ wch: 46 }, { wch: 26 }, { wch: 42 }, { wch: 14 }, { wch: 44 }];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Articles");

      const out = XLSX.write(wb, { bookType: "xlsx", type: "array" });
      const blob = new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      const el = document.createElement("a");
      const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", "");
      el.href = URL.createObjectURL(blob);
      el.download = `articles_${projectId}_${stamp}.xlsx`;
      document.body.appendChild(el);
      el.click();
      el.remove();
      setTimeout(() => URL.revokeObjectURL(el.href), 2500);

      setShowExportArticles(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to export articles");
    } finally {
      setExporting(false);
    }
  }

  async function downloadBulkSample() {
    setError(null);
    const XLSX = await import("xlsx");
    const header: [string, string, string] = ["Article Title", "Focus Keyphrase", "Targeting/support keywords"];
    const example1: [string, string, string] = [
      "How to Choose the Best Supreme Court Lawyer",
      "best supreme court lawyer",
      "supreme court lawyer, legal advice, litigation",
    ];
    const example2: [string, string, string] = [
      "Supreme Court Litigation Process Explained",
      "supreme court litigation process",
      "litigation process, supreme court case, advocate",
    ];
    const ws = XLSX.utils.aoa_to_sheet([header, example1, example2]);
    ws["!cols"] = [{ wch: 46 }, { wch: 26 }, { wch: 42 }, { wch: 14 }, { wch: 44 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Sample");
    const out = XLSX.write(wb, { bookType: "xlsx", type: "array" });
    const blob = new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const el = document.createElement("a");
    el.href = URL.createObjectURL(blob);
    el.download = `bulk_upload_sample.xlsx`;
    document.body.appendChild(el);
    el.click();
    el.remove();
    setTimeout(() => URL.revokeObjectURL(el.href), 2500);
  }

  function normHeader(v: unknown) {
    return String(v || "")
      .trim()
      .toLowerCase()
      .replaceAll("_", " ")
      .replace(/\s+/g, " ");
  }

  async function onBulkFilePicked(file: File | null) {
    setBulkUploadErrors([]);
    setBulkUploadRows([]);
    setBulkParseDupTitles([]);
    if (!file) return;
    try {
      const XLSX = await import("xlsx");
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const sheetName = wb.SheetNames[0];
      if (!sheetName) {
        setBulkUploadErrors(["No sheet found in the uploaded file."]);
        return;
      }
      const ws = wb.Sheets[sheetName];
      const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" }) as unknown[][];
      if (!aoa.length) {
        setBulkUploadErrors(["The sheet is empty."]);
        return;
      }

      const headerRow = (aoa[0] || []).map(normHeader);
      const idxTitle = headerRow.findIndex((h) => h === "article title" || h === "title");
      const idxFocus = headerRow.findIndex((h) => h === "focus keyphrase" || h === "focus key phrase" || h === "focus key");
      const idxKeywords = headerRow.findIndex((h) => h === "targeting/support keywords" || h === "targeting keywords" || h === "support keywords" || h === "keywords");
      // Status/Live URL are intentionally not part of bulk upload.

      const errs: string[] = [];
      if (idxTitle < 0) errs.push('Missing required column: "Article Title"');
      if (idxFocus < 0) errs.push('Missing column: "Focus Keyphrase"');
      if (idxKeywords < 0) errs.push('Missing column: "Targeting/support keywords"');
      if (errs.length) {
        setBulkUploadErrors(errs);
        return;
      }

      const outRows: BulkUploadRow[] = [];
      const rowErrors: string[] = [];
      for (let r = 1; r < aoa.length; r++) {
        const row = aoa[r] || [];
        const title = String(row[idxTitle] || "").trim();
        const focus_keyphrase = String(row[idxFocus] || "").trim();
        const kwRaw = String(row[idxKeywords] || "").trim();

        if (!title) {
          // allow blank rows (common in spreadsheets)
          continue;
        }

        const keywords = kwRaw
          .split(/[,;]+/g)
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => s.slice(0, 80));

        // de-dupe (case-insensitive), max 10
        const seen = new Set<string>();
        const keywordsDedup: string[] = [];
        for (const k of keywords) {
          const key = k.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          keywordsDedup.push(k);
          if (keywordsDedup.length >= 10) break;
        }

        if (title.length > 500) rowErrors.push(`Row ${r + 1}: Title too long (max 500). It will be truncated.`);
        if (focus_keyphrase.length > 500) rowErrors.push(`Row ${r + 1}: Focus Keyphrase too long (max 500). It will be truncated.`);

        outRows.push({
          title: title.slice(0, 500),
          focus_keyphrase: focus_keyphrase ? focus_keyphrase.slice(0, 500) : null,
          keywords: keywordsDedup,
        });
      }

      if (!outRows.length) {
        setBulkUploadErrors(["No valid rows found. Make sure the sheet has data under the headers."]);
        return;
      }

      const { rows: deduped, duplicateTitles } = dedupeBulkUploadRowsByTitle(outRows);
      setBulkUploadRows(deduped);
      setBulkParseDupTitles(duplicateTitles);
      if (rowErrors.length) setBulkUploadErrors(rowErrors.slice(0, 30));
    } catch (e) {
      setBulkUploadErrors([e instanceof Error ? e.message : "Failed to read the uploaded Excel file."]);
    }
  }

  async function importBulkRows(confirmSkipProjectDup = false) {
    if (!bulkUploadRows.length) return;
    setError(null);
    setBulkUploading(true);
    try {
      const res = await api.bulkUploadArticles(projectId, bulkUploadRows, {
        skipProjectDuplicateConflicts: confirmSkipProjectDup,
      });
      // fastest: refresh list (also ensures ordering latest->oldest)
      setArticles(await api.listArticles(projectId));
      setBulkProjectDupModal(null);
      setBulkDupExpandList(false);
      setShowBulkUpload(false);
      setBulkUploadRows([]);
      setBulkUploadErrors([]);
      setBulkParseDupTitles([]);
      const dups = (res.duplicate_titles || []).filter(Boolean);
      if (dups.length) setPostImportDupTitles(dups);
      else setPostImportDupTitles(null);
      const ps = res.project_skipped_as_duplicates || 0;
      setPostImportProjectSkipped(ps);
      if (!res.created) {
        if (ps > 0 && !dups.length) {
          setError("No new articles were added: every import row matched an existing article title in this project.");
        } else if (!ps && !dups.length) {
          setError("No articles were created from the uploaded file.");
        }
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.detail && typeof e.detail === "object" && e.detail !== null) {
        const d = e.detail as Record<string, unknown>;
        if (d.error === "duplicate_article_titles") {
          const raw = d.project_duplicates;
          const projectDuplicates: ProjectDupRow[] = Array.isArray(raw)
            ? raw
                .filter((x): x is Record<string, unknown> => x !== null && typeof x === "object")
                .map((x) => ({
                  submitted_title: String(x.submitted_title ?? ""),
                  existing_title: String(x.existing_title ?? ""),
                  existing_id: String(x.existing_id ?? ""),
                }))
            : [];
          const inRaw = d.in_file_duplicate_titles;
          const inFileDuplicateTitles = Array.isArray(inRaw)
            ? inRaw.filter((x): x is string => typeof x === "string")
            : [];
          const wc = d.would_create_count;
          setBulkProjectDupModal({
            projectDuplicates,
            inFileDuplicateTitles,
            wouldCreateCount: typeof wc === "number" ? wc : 0,
          });
          return;
        }
      }
      setError(e instanceof Error ? e.message : "Bulk upload failed");
    } finally {
      setBulkUploading(false);
    }
  }

  const filtered = useMemo(() => {
    const qn = q.trim().toLowerCase();
    const df = parseDateOnly(dateFrom);
    const dt = parseDateOnly(dateTo);

    const out = articles.filter((a) => {
      if (status && (a.status || "").toLowerCase() !== status) return false;

      if (qn) {
        const hay = [
          a.title,
          a.focus_keyphrase || "",
          ...(a.keywords || []),
        ]
          .join(" ")
          .toLowerCase();
        if (!hay.includes(qn)) return false;
      }

      const ca = parseCreatedAt(a.created_at);
      if (df && ca && ca < df) return false;
      if (dt && ca) {
        // inclusive end date
        const end = new Date(dt.getTime() + 24 * 60 * 60 * 1000);
        if (ca >= end) return false;
      }
      return true;
    });

    const createdAtMs = (a: { created_at?: string | null }) => {
      const d = parseCreatedAt(a.created_at);
      return d ? d.getTime() : 0;
    };

    out.sort((a, b) => (dateOrder === "asc" ? createdAtMs(a) - createdAtMs(b) : createdAtMs(b) - createdAtMs(a)));
    return out;
  }, [articles, dateFrom, dateTo, q, status, dateOrder]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const pageClamped = Math.min(Math.max(1, page), totalPages);
  const pageItems = filtered.slice((pageClamped - 1) * pageSize, pageClamped * pageSize);

  const allOnPageSelected = pageItems.length > 0 && pageItems.every((a) => selected[a.id]);

  function toggleAllOnPage() {
    const next = { ...selected };
    const value = !allOnPageSelected;
    for (const a of pageItems) next[a.id] = value;
    setSelected(next);
  }

  function toggleOne(id: string) {
    setSelected((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  async function bulkDelete() {
    if (selectedIds.length === 0) return;
    if (!confirm(`Delete ${selectedIds.length} selected article(s)? This cannot be undone.`)) return;
    setError(null);
    try {
      await api.bulkDeleteArticles(projectId, selectedIds);
      setArticles((prev) => prev.filter((a) => !selectedIds.includes(a.id)));
      setSelected({});
    } catch (e) {
      setError(e instanceof Error ? e.message : "Bulk delete failed");
    }
  }

  async function deleteOne(articleId: string) {
    setError(null);
    try {
      await api.bulkDeleteArticles(projectId, [articleId]);
      setArticles((prev) => prev.filter((x) => x.id !== articleId));
      setSelected((prev) => {
        const next = { ...prev };
        delete next[articleId];
        return next;
      });
      setConfirmDeleteId(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    }
  }

  async function scheduleOne(articleId: string) {
    setError(null);
    try {
      await ensureScheduleMetaLoaded();
      const when = scheduleWhen.trim();
      if (!when) throw new Error("Please choose a schedule time");

      const scheduled = await api.scheduleArticle(projectId, articleId, {
        wp_scheduled_at: when,
        wp_status: scheduleWpStatus,
        post_type: schedulePostType,
        writing_prompt_id: scheduleWritingPromptId || null,
        image_prompt_id: scheduleImagePromptId || null,
        generate_image: true,
      });
      // Optimistic UI update: scheduling should not block on re-fetching large lists,
      // which can time out on production proxies.
      if (scheduled?.wp_scheduled_at) {
        const runAt = String(scheduled.wp_scheduled_at || "");
        setArticles((prev) =>
          prev.map((a) =>
            a.id === articleId
              ? {
                  ...a,
                  wp_scheduled_at: runAt,
                  wp_schedule_error: "",
                }
              : a,
          ),
        );
      }
      // Best-effort: refresh Scheduled Articles in the background (don't block UX).
      api
        .listScheduledJobs(projectId)
        .then((jobs) => setScheduledJobs(dedupeScheduledJobs(jobs)))
        .catch(() => {});
      setScheduleId(null);
      setScheduleWhen("");
      setScheduleWpStatus("draft");
      setSchedulePostType("posts");
      setScheduleWritingPromptId(scheduleWritingPrompts?.default_id || "");
      setScheduleImagePromptId(scheduleImagePrompts?.default_id || "");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Schedule failed");
    }
  }

  async function postNowFromScheduledJob() {
    const j = confirmPostNowJob;
    if (!j) return;
    setError(null);
    setPostNowBusy(true);
    try {
      await api.publishArticleToLiveSite(projectId, j.article_id, {
        post_type: (j.post_type || "posts").trim() || "posts",
        wp_status: (String(j.wp_status || "draft").toLowerCase() === "publish" ? "publish" : "draft") as "draft" | "publish",
        category_ids: j.category_ids || [],
      });
      setArticles(await api.listArticles(projectId));
      setScheduledJobs(dedupeScheduledJobs(await api.listScheduledJobs(projectId)));
      setConfirmPostNowJob(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Post now failed");
    } finally {
      setPostNowBusy(false);
    }
  }

  async function bulkChangeStatus(newStatus: "pending" | "draft" | "published") {
    if (selectedIds.length === 0) return;
    setError(null);
    try {
      await api.bulkChangeStatus(projectId, selectedIds, newStatus);
      setArticles((prev) =>
        prev.map((a) => (selectedIds.includes(a.id) ? { ...a, status: newStatus } : a)),
      );
      setSelected({});
    } catch (e) {
      setError(e instanceof Error ? e.message : "Bulk status update failed");
    }
  }

  function bulkEdit() {
    if (selectedIds.length !== 1) return;
    const aid = selectedIds[0];
    router.push(`/projects/${projectId}/articles/${aid}`);
  }

  function bulkSchedule() {
    if (!selectedIds.length) return;
    void ensureScheduleMetaLoaded();
    const min = new Date(Date.now() + 5 * 60 * 1000);
    const minStr = toDatetimeLocalFromDateInProfileTz(min);
    setBulkScheduleMin(minStr);
    setBulkScheduleWpStatus(wpDefaults?.wp_status || "draft");
    setBulkSchedulePostType(wpDefaults?.post_type || "posts");
    setScheduleWritingPromptId(scheduleWritingPrompts?.default_id || "");
    setScheduleImagePromptId(scheduleImagePrompts?.default_id || "");
    setBulkScheduleRows(
      selectedIds.map((id) => ({
        id,
        title: articles.find((a) => a.id === id)?.title || "(Untitled)",
        when: minStr,
      })),
    );
    setBulkMode("schedule");
  }

  async function bulkScheduleSubmit() {
    if (!bulkScheduleRows.length) return;
    setError(null);
    setBulkScheduling(true);
    try {
      for (const r of bulkScheduleRows) {
        const when = (r.when || "").trim();
        if (!when) throw new Error("Please set date/time for all selected articles");
        await api.scheduleArticle(projectId, r.id, {
          wp_scheduled_at: when,
          wp_status: bulkScheduleWpStatus,
          post_type: bulkSchedulePostType,
          writing_prompt_id: scheduleWritingPromptId || null,
          image_prompt_id: scheduleImagePromptId || null,
          generate_image: true,
        });
      }

      setArticles(await api.listArticles(projectId));
      try {
        setScheduledJobs(dedupeScheduledJobs(await api.listScheduledJobs(projectId)));
      } catch {
        // ignore
      }
      setSelected({});
      setShowBulkPopup(false);
      setBulkMode("root");
      setBulkScheduleRows([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Bulk schedule failed");
    } finally {
      setBulkScheduling(false);
    }
  }

  function openPromptModal(kind: "writing" | "image", id: string) {
    const list = kind === "writing" ? wpDrafts : ipDrafts;
    const row = list.find((x) => x.id === id);
    setDraftName(row?.name || "");
    setDraftText(row?.text || "");
    const def = kind === "writing" ? wpDefault : ipDefault;
    setDraftSetDefault(!!id && def === id);
    setShowPromptModal({ kind, id });
  }

  function startAddPrompt(kind: "writing" | "image") {
    const tmpId = `new_${kind}_${Date.now()}`;
    if (kind === "writing") setWpDrafts((p) => [{ id: tmpId, name: "", text: "", isNew: true }, ...p]);
    else setIpDrafts((p) => [{ id: tmpId, name: "", text: "", isNew: true }, ...p]);
    openPromptModal(kind, tmpId);
  }

  function markDeletePrompt(kind: "writing" | "image", id: string) {
    if (!confirm("Delete this prompt? (Will apply when you click Save changes)")) return;
    if (kind === "writing") {
      setWpDrafts((p) => p.filter((x) => x.id !== id));
      setWpDeleted((s) => new Set([...Array.from(s), id]));
      if (wpDefault === id) setWpDefault("");
    } else {
      setIpDrafts((p) => p.filter((x) => x.id !== id));
      setIpDeleted((s) => new Set([...Array.from(s), id]));
      if (ipDefault === id) setIpDefault("");
    }
  }

  async function savePrompts() {
    setError(null);
    setPromptsSaving(true);
    try {
      // WRITING: deletes
      for (const id of Array.from(wpDeleted)) {
        if (!id.startsWith("new_")) await api.deleteWritingPrompt(projectId, id);
      }
      // WRITING: upserts
      const wpIdMap = new Map<string, string>(); // tmp -> real
      for (const d of wpDrafts) {
        const name = (d.name || "").trim();
        const text = (d.text || "").trim();
        if (!name || !text) continue;
        if (d.isNew || d.id.startsWith("new_")) {
          const created = await api.createWritingPrompt(projectId, { name, text });
          wpIdMap.set(d.id, created.id);
        } else {
          await api.updateWritingPrompt(projectId, d.id, { name, text });
        }
      }
      const newWpDefault = wpIdMap.get(wpDefault) || wpDefault;
      if (newWpDefault && newWpDefault !== (writingPrompts?.default_id || "")) {
        await api.setDefaultWritingPrompt(projectId, newWpDefault);
      }

      // IMAGE: deletes
      for (const id of Array.from(ipDeleted)) {
        if (!id.startsWith("new_")) await api.deleteImagePrompt(projectId, id);
      }
      // IMAGE: upserts
      const ipIdMap = new Map<string, string>();
      for (const d of ipDrafts) {
        const name = (d.name || "").trim();
        const text = (d.text || "").trim();
        if (!name || !text) continue;
        if (d.isNew || d.id.startsWith("new_")) {
          const created = await api.createImagePrompt(projectId, { name, text });
          ipIdMap.set(d.id, created.id);
        } else {
          await api.updateImagePrompt(projectId, d.id, { name, text });
        }
      }
      const newIpDefault = ipIdMap.get(ipDefault) || ipDefault;
      if (newIpDefault && newIpDefault !== (imagePrompts?.default_id || "")) {
        await api.setDefaultImagePrompt(projectId, newIpDefault);
      }

      // Refresh from backend for canonical ids/defaults
      const [wp2, ip2] = await Promise.all([
        api.listWritingPrompts(projectId),
        api.listImagePrompts(projectId),
      ]);
      setWritingPrompts(wp2);
      setImagePrompts(ip2);
      setWpDrafts((wp2.items || []).map((p) => ({ id: p.id, name: p.name, text: p.text })));
      setIpDrafts((ip2.items || []).map((p) => ({ id: p.id, name: p.name, text: p.text })));
      setWpDefault(wp2.default_id || "");
      setIpDefault(ip2.default_id || "");
      setWpDeleted(new Set());
      setIpDeleted(new Set());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save prompts");
    } finally {
      setPromptsSaving(false);
    }
  }

  function openLinkModal(id: string) {
    const row = linkDrafts.find((x) => x.id === id);
    setLinkPhrase(row?.label || "");
    setLinkUrl(row?.url || "");
    setShowLinkModal({ id });
  }

  function startAddLink() {
    const cap = featureLimits?.context_links;
    const activeDraftCount = linkDrafts.length;
    if (cap && !cap.unlimited && activeDraftCount >= (cap.limit ?? 0)) {
      setError(
        `Context link limit reached for your ${featureLimits?.plan_key || "current"} plan (max ${cap.limit}).`
      );
      return;
    }
    const tmpId = `new_link_${Date.now()}`;
    setLinkDrafts((p) => [{ id: tmpId, label: "", url: "", isNew: true }, ...p]);
    openLinkModal(tmpId);
  }

  function markDeleteLink(id: string) {
    if (!confirm("Delete this context link? (Will apply when you click Save changes)")) return;
    setLinkDrafts((p) => p.filter((x) => x.id !== id));
    setLinkDeleted((s) => new Set([...Array.from(s), id]));
  }

  async function saveContextLinks() {
    setError(null);
    setLinksSaving(true);
    try {
      for (const id of Array.from(linkDeleted)) {
        if (!id.startsWith("new_")) await api.deleteContextLink(projectId, id);
      }
      for (const d of linkDrafts) {
        const phrase = (d.label || "").trim();
        const url = (d.url || "").trim();
        if (!phrase || !url) continue;
        if (d.isNew || d.id.startsWith("new_")) {
          await api.createContextLink(projectId, { label: phrase, url });
        } else {
          await api.updateContextLink(projectId, d.id, { label: phrase, url });
        }
      }
      const items = await api.listContextLinks(projectId);
      setLinkDrafts(items.map((x) => ({ id: x.id, label: x.label, url: x.url })));
      setLinkDeleted(new Set());
      setLinkPage(1);
      void refreshFeatureLimits();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save context links");
    } finally {
      setLinksSaving(false);
    }
  }

  function statusPillClass(raw?: string | null) {
    const s = (raw || "pending").toLowerCase();
    if (s === "pending") return `${styles.statusPill} ${styles.statusPending}`;
    if (s === "draft") return `${styles.statusPill} ${styles.statusDraft}`;
    if (s === "published") return `${styles.statusPill} ${styles.statusPublished}`;
    return `${styles.statusPill} ${styles.statusNeutral}`;
  }

  function jobStateLabel(s: string) {
    const v = (s || "").toLowerCase();
    if (v === "scheduled") return "Scheduled";
    if (v === "content_generating") return "Generating content…";
    if (v === "image_generating") return "Generating image…";
    if (v === "ready_to_post") return "Article is ready to post";
    if (v === "posting") return "Posting in progress";
    if (v === "posted") return "Posted";
    if (v === "failed") return "Failed";
    if (v === "cancelled") return "Cancelled";
    return v || "unknown";
  }

  const tabLabel: Record<TabKey, string> = {
    articles: "Articles",
    research: "Research",
    scheduled_articles: "Scheduled Articles",
    configuration: "Configuration",
    prompts: "Prompts",
    context_links: "Context links",
    tools: "Tools",
    // The Performance & Analysis tab is only useful once Search Console is connected
    // *and* the analytics endpoint has returned data — we hide the nav entry until
    // both conditions are true (see ``visibleTabs`` below). The label still lives
    // in this map so deep-links and persistence keep working.
    performance: "Performance & Analysis",
    project_settings: "Project Settings",
  };

  function goTab(next: TabKey) {
    if (next === tab) return;
    if ((next === "tools" || next === "project_settings") && !confirmLoseChanges()) return;
    setTab(next);
    setMobileNavOpen(false);
  }

  /**
   * Hop to another project from the sidebar switcher. Preserves the
   * current ``tab`` (and ``subtab`` for Research) in the URL so the user
   * lands on the same screen in the new project. Honours the unsaved-
   * changes guard exactly the same way ``goTab`` does so users can't
   * lose half-typed Project Settings or Tools edits by accident.
   */
  function switchProject(nextId: string) {
    if (!nextId || nextId === projectId) return;
    if ((tab === "tools" || tab === "project_settings") && !confirmLoseChanges()) return;
    const params = new URLSearchParams();
    if (tab && tab !== "articles") params.set("tab", tab);
    if (tab === "research" && researchSubTab) params.set("subtab", researchSubTab);
    const qs = params.toString();
    setMobileNavOpen(false);
    router.push(`/projects/${nextId}${qs ? `?${qs}` : ""}`);
  }

  // Performance & Analysis is conditional on Search Console being connected and at least
  // one analytics payload having been fetched. Tabs are otherwise listed in ``tabLabel`` order.
  const performanceTabAvailable = Boolean(
    gscStatus?.connected && gscStatus?.property_url && analytics && (analytics.series || []).length > 0,
  );
  const visibleTabs: TabKey[] = (Object.keys(tabLabel) as TabKey[]).filter((k) => {
    if (k === "performance") return performanceTabAvailable;
    return true;
  });

  // ---------------------------------------------------------------------------
  // Research helpers (seeds, runs, filters, import)
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Topic cluster planner (Research tab)
  // ---------------------------------------------------------------------------

  async function reloadTopicClusters() {
    if (!projectId) return;
    setTopicClustersLoading(true);
    setTopicClustersErr(null);
    try {
      const res = await api.topicClusterList(projectId);
      setTopicClusters(res.clusters || []);
    } catch (e) {
      const msg =
        e instanceof ApiError && e.status === 404
          ? "Topic cluster API not available on this backend (deploy the latest backend)."
          : e instanceof Error
            ? e.message
            : "Failed to load topic clusters";
      setTopicClustersErr(msg);
      setTopicClusters([]);
    } finally {
      setTopicClustersLoading(false);
    }
  }

  async function planTopicClusterFromResearch() {
    const seed = clusterSeedIntent.trim();
    if (seed.length < 3) {
      setClusterPlanMsg("Enter a seed intent (at least 3 characters).");
      return;
    }
    const clusterQuota = featureLimits?.cluster_plans;
    if (clusterQuota && !clusterQuota.unlimited && (clusterQuota.month_remaining ?? 0) <= 0) {
      setClusterPlanMsg(
        `Monthly Cluster Planner limit reached for your ${featureLimits?.plan_key || "current"} plan.`
      );
      return;
    }
    setClusterPlanBusy(true);
    setClusterPlanMsg(null);
    try {
      const row = await api.topicClusterPlan(projectId, {
        seed_intent: seed,
        country_code: researchCountry,
        tone: researchTone,
        language: researchLanguage,
      });
      setTopicClusters((prev) => [row, ...prev.filter((c) => c.id !== row.id)]);
      void refreshFeatureLimits();
      setClusterPlanMsg("Cluster map saved. Review below, then run Generate all for drafts + content.");
    } catch (e) {
      setClusterPlanMsg(e instanceof Error ? e.message : "Planning failed");
    } finally {
      setClusterPlanBusy(false);
    }
  }

  /**
   * Pull the slot ids the user has currently selected inside ``clusterId``. When
   * the selection is empty we treat that as "act on every pending topic", which
   * matches the natural reading of "Generate all" / "Import all" buttons.
   *
   * Returns ``null`` to express "all pending" (the backend interprets a missing
   * ``topic_ids`` as exactly that), or a deduped list when the user selected
   * specific rows. Slot ids that are *already imported* are filtered out here
   * too so the backend never receives a no-op selection.
   */
  /**
   * Look up the cluster validation entry for a given selection-slot id.
   *
   * Selection slot ids and the validation hook's ``temp_id`` keys are NOT
   * the same string for the pillar row — the validation hook always uses
   * the literal ``::pillar`` suffix while the selection set uses
   * ``cluster.pillar?.id`` (which may be a uuid or "pillar" depending on
   * how the planner generated the document). This helper bridges the two.
   */
  function clusterSlotValidation(
    clusterId: string,
    slotId: string,
  ): import("@/hooks/useClusterValidation").ClusterValidationEntry | null {
    const cluster = topicClusters.find((c) => c.id === clusterId);
    if (!cluster) return null;
    const pillarSlot = (cluster.pillar?.id || "pillar").trim() || "pillar";
    const key =
      slotId === pillarSlot
        ? `${clusterId}::pillar`
        : `${clusterId}::${slotId}`;
    return clusterValidation.results[key] ?? null;
  }

  /**
   * ``true`` iff the validation engine has confirmed this slot already
   * exists either in the project's article library or on the live
   * WordPress site (``status === "duplicate"``). Topics in this state are
   * un-selectable and excluded from every bulk action.
   *
   * Note: ``"similar"`` (potential duplicate) is intentionally NOT
   * blocked here — those rows still let the user opt in once they've
   * eyeballed the suggested existing URL.
   */
  function isClusterSlotDuplicate(clusterId: string, slotId: string): boolean {
    return clusterSlotValidation(clusterId, slotId)?.status === "duplicate";
  }

  function effectiveSelectionForCluster(clusterId: string): {
    topicIds: string[] | null;
    pendingCount: number;
  } {
    const cluster = topicClusters.find((c) => c.id === clusterId);
    if (!cluster) return { topicIds: null, pendingCount: 0 };
    const pillarSlot = (cluster.pillar?.id || "pillar").trim() || "pillar";
    const pillarPending =
      !(cluster.pillar?.imported_article_id || "").trim() &&
      !isClusterSlotDuplicate(clusterId, pillarSlot);
    const pendingClusterIds = (cluster.clusters || [])
      .filter((c) => !!(c.title || "").trim() && !(c.imported_article_id || "").trim())
      .map((c) => (c.id || "").trim() || "cluster")
      .filter((id) => !isClusterSlotDuplicate(clusterId, id));
    const allPendingCount = (pillarPending ? 1 : 0) + pendingClusterIds.length;

    const sel = clusterSelected[clusterId] || new Set<string>();
    if (sel.size === 0) return { topicIds: null, pendingCount: allPendingCount };

    const filtered: string[] = [];
    if (sel.has(pillarSlot) && pillarPending) filtered.push(pillarSlot);
    for (const id of pendingClusterIds) {
      if (sel.has(id)) filtered.push(id);
    }
    // If the user selected only already-imported / duplicate rows, fall
    // back to "all pending" so the action button doesn't silently 400
    // with "nothing to do" — but ``allPendingCount`` already excludes
    // duplicates so the fallback is also safe.
    if (filtered.length === 0) return { topicIds: null, pendingCount: allPendingCount };
    return { topicIds: filtered, pendingCount: filtered.length };
  }

  function clearClusterSelection(clusterId: string) {
    setClusterSelected((prev) => {
      if (!prev[clusterId] || prev[clusterId].size === 0) return prev;
      const next = { ...prev };
      next[clusterId] = new Set();
      return next;
    });
  }

  function toggleClusterSlot(clusterId: string, slotId: string) {
    // Confirmed-duplicate rows are un-selectable: the engine has already
    // matched them to an existing article in this project or on the live
    // site, so any bulk action would be a no-op (or worse, a duplicate
    // import). The checkbox is also withheld at the JSX level — this is
    // a defence in depth for stale state where validation flipped from
    // ``new`` to ``duplicate`` after the row was selected.
    if (isClusterSlotDuplicate(clusterId, slotId)) return;
    setClusterSelected((prev) => {
      const cur = new Set(prev[clusterId] || []);
      if (cur.has(slotId)) cur.delete(slotId);
      else cur.add(slotId);
      return { ...prev, [clusterId]: cur };
    });
  }

  function selectAllPendingForCluster(clusterId: string) {
    const cluster = topicClusters.find((c) => c.id === clusterId);
    if (!cluster) return;
    const next = new Set<string>();
    const pillarSlot = (cluster.pillar?.id || "pillar").trim() || "pillar";
    if (
      !(cluster.pillar?.imported_article_id || "").trim() &&
      (cluster.pillar?.title || "").trim() &&
      !isClusterSlotDuplicate(clusterId, pillarSlot)
    ) {
      next.add(pillarSlot);
    }
    for (const c of cluster.clusters || []) {
      if (!(c.title || "").trim()) continue;
      if ((c.imported_article_id || "").trim()) continue;
      const slotId = (c.id || "").trim() || "cluster";
      if (isClusterSlotDuplicate(clusterId, slotId)) continue;
      next.add(slotId);
    }
    setClusterSelected((prev) => ({ ...prev, [clusterId]: next }));
  }

  /**
   * Translate a backend error (raw ``ApiError``) into the structured payload our
   * ``clusterErrorModal`` consumes. The backend returns a structured ``detail``
   * object for ``quota_exceeded`` so the modal can show actionable numbers; for
   * everything else we fall back to the message text.
   */
  function buildErrorModalFromApiError(e: unknown, fallbackTitle: string): {
    title: string;
    message: string;
    detail?: string | null;
  } {
    if (e instanceof ApiError && e.detail && typeof e.detail === "object" && !Array.isArray(e.detail)) {
      {
        const d = e.detail as Record<string, unknown>;
        const code = typeof d.code === "string" ? d.code : "";
        const msg = typeof d.message === "string" ? d.message : "";
        if (code === "quota_exceeded") {
          const needed = typeof d.needed === "number" ? d.needed : null;
          const allowed = typeof d.allowed === "number" ? d.allowed : null;
          const dayRemaining = d.day_remaining as number | null | undefined;
          const monthRemaining = d.month_remaining as number | null | undefined;
          const lines: string[] = [];
          if (needed !== null && allowed !== null) {
            lines.push(`Requested: ${needed} article${needed === 1 ? "" : "s"}.`);
            lines.push(`Allowed right now: ${allowed}.`);
          }
          if (typeof dayRemaining === "number") lines.push(`Daily remaining: ${dayRemaining}.`);
          if (typeof monthRemaining === "number") lines.push(`Monthly remaining: ${monthRemaining}.`);
          return {
            title: "Article generation limit reached",
            message:
              msg ||
              "Your plan doesn't have enough remaining article generations to cover this batch.",
            detail: lines.join(" "),
          };
        }
        if (typeof d.message === "string" && d.message) {
          return { title: fallbackTitle, message: d.message };
        }
      }
    }
    const msg = e instanceof Error ? e.message : "Something went wrong. Please try again.";
    return { title: fallbackTitle, message: msg };
  }

  /**
   * "Generate all"/"Generate selected": pre-flight the user's article quota and
   * pop a clear modal when there aren't enough credits, otherwise fire the
   * batched generate endpoint. Errors land in the same modal — never inline-
   * truncated like before.
   */
  async function generateForCluster(clusterId: string) {
    const { topicIds, pendingCount } = effectiveSelectionForCluster(clusterId);
    if (pendingCount === 0) {
      setClusterErrorModal({
        title: "Nothing to generate",
        message: "Every topic in this cluster has already been generated.",
      });
      return;
    }

    setClusterBulkBusy({ clusterId, kind: "generate" });
    setClusterPlanMsg(null);
    try {
      // Pre-flight: ask the backend how many credits are left before we kick
      // off a request that would otherwise 403 partway through.
      try {
        const q = await api.articleQuota(projectId);
        if (!q.unlimited && (q.max_can_consume_now ?? 0) < pendingCount) {
          setClusterErrorModal({
            title: "Article generation limit reached",
            message:
              `Your ${q.plan_key || "current"} plan only allows ${q.max_can_consume_now ?? 0} more article ` +
              `${(q.max_can_consume_now ?? 0) === 1 ? "generation" : "generations"} right now, but you're ` +
              `trying to generate ${pendingCount}.`,
            detail:
              [
                typeof q.day_remaining === "number" ? `Daily remaining: ${q.day_remaining}.` : null,
                typeof q.month_remaining === "number" ? `Monthly remaining: ${q.month_remaining}.` : null,
                "Tip: import the topics first (no credits used) and generate them later, or upgrade your plan.",
              ]
                .filter(Boolean)
                .join(" "),
          });
          return;
        }
      } catch {
        // Quota endpoint failure is non-fatal — fall through and let the
        // generate endpoint enforce the same limit server-side.
      }

      const res = await api.topicClusterGenerateAll(projectId, clusterId, {
        generate_image: false,
        writing_prompt_id: null,
        topic_ids: topicIds,
      });
      setTopicClusters((prev) => prev.map((c) => (c.id === res.cluster.id ? res.cluster : c)));
      clearClusterSelection(clusterId);
      if (res.errors?.length) {
        setClusterErrorModal({
          title: "Some articles couldn't be generated",
          message: `Finished with ${res.errors.length} error${res.errors.length === 1 ? "" : "s"}. The successful drafts are now linked in the cluster.`,
          detail: res.errors.map((e) => `• ${e.topic_id}: ${e.message}`).join("\n"),
        });
      } else {
        setClusterPlanMsg("All selected articles generated. Open them from the links below.");
      }
    } catch (e) {
      setClusterErrorModal(buildErrorModalFromApiError(e, "Generation failed"));
    } finally {
      setClusterBulkBusy(null);
    }
  }

  /**
   * "Import all"/"Import selected": create pending article rows in the project's
   * Articles tab without consuming any generation credits. Useful when the user
   * wants to review/edit titles or focus keyphrases before generation.
   */
  async function importForCluster(clusterId: string) {
    const { topicIds, pendingCount } = effectiveSelectionForCluster(clusterId);
    if (pendingCount === 0) {
      setClusterErrorModal({
        title: "Nothing to import",
        message: "Every topic in this cluster has already been imported.",
      });
      return;
    }
    setClusterBulkBusy({ clusterId, kind: "import" });
    setClusterPlanMsg(null);
    try {
      const res = await api.topicClusterImport(projectId, clusterId, {
        topic_ids: topicIds,
      });
      setTopicClusters((prev) => prev.map((c) => (c.id === res.cluster.id ? res.cluster : c)));
      clearClusterSelection(clusterId);
      if (res.errors?.length) {
        setClusterErrorModal({
          title: "Some topics couldn't be imported",
          message: `Imported ${res.imported_count}, ${res.errors.length} failed.`,
          detail: res.errors.map((e) => `• ${e.topic_id}: ${e.message}`).join("\n"),
        });
      } else {
        setClusterPlanMsg(
          `Imported ${res.imported_count} topic${res.imported_count === 1 ? "" : "s"} into Articles as pending drafts.`,
        );
      }
    } catch (e) {
      setClusterErrorModal(buildErrorModalFromApiError(e, "Import failed"));
    } finally {
      setClusterBulkBusy(null);
    }
  }

  /** Open the schedule picker modal for a cluster (selected slots or all pending). */
  function openScheduleForCluster(clusterId: string) {
    const { topicIds, pendingCount } = effectiveSelectionForCluster(clusterId);
    if (pendingCount === 0) {
      setClusterErrorModal({
        title: "Nothing to schedule",
        message: "Every topic in this cluster has already been imported.",
      });
      return;
    }
    // Default schedule: ~24h from now, rounded to the next 5-min boundary.
    const dt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    dt.setSeconds(0, 0);
    dt.setMinutes(dt.getMinutes() + (5 - (dt.getMinutes() % 5 || 5)));
    setClusterScheduleModal({
      clusterId,
      topicIds,
      runAt: toDatetimeLocalValue(dt),
      wpStatus: "draft",
      busy: false,
    });
  }

  /** Submit handler for the schedule modal. */
  async function confirmScheduleForCluster() {
    const m = clusterScheduleModal;
    if (!m || m.busy) return;
    setClusterScheduleModal({ ...m, busy: true });
    try {
      const res = await api.topicClusterImport(projectId, m.clusterId, {
        topic_ids: m.topicIds,
        schedule_at: m.runAt,
        wp_status: m.wpStatus,
      });
      setTopicClusters((prev) => prev.map((c) => (c.id === res.cluster.id ? res.cluster : c)));
      clearClusterSelection(m.clusterId);
      setClusterScheduleModal(null);
      if (res.errors?.length) {
        setClusterErrorModal({
          title: "Some topics couldn't be scheduled",
          message: `Scheduled ${res.scheduled_count}, ${res.errors.length} failed.`,
          detail: res.errors.map((e) => `• ${e.topic_id}: ${e.message}`).join("\n"),
        });
      } else {
        setClusterPlanMsg(
          `Scheduled ${res.scheduled_count} article${res.scheduled_count === 1 ? "" : "s"} starting ${m.runAt.replace("T", " ")}. Track them in the Scheduled Articles tab.`,
        );
      }
    } catch (e) {
      setClusterScheduleModal(m); // restore busy=false
      setClusterErrorModal(buildErrorModalFromApiError(e, "Scheduling failed"));
    } finally {
      setClusterScheduleModal((prev) => (prev ? { ...prev, busy: false } : null));
    }
  }

  function addSeedKeywordsFromInput() {
    const raw = (researchSeedInput || "").trim();
    if (!raw) return;
    const tokens = raw
      .split(/[\n,]/g)
      .map((t) => t.trim())
      .filter(Boolean);
    if (!tokens.length) return;
    setResearchSeeds((prev) => {
      const next = [...prev];
      const lower = new Set(prev.map((p) => p.toLowerCase()));
      for (const t of tokens) {
        const k = t.toLowerCase();
        if (lower.has(k)) continue;
        lower.add(k);
        next.push(t);
      }
      return next.slice(0, 200);
    });
    setResearchSeedInput("");
  }

  function removeSeedAt(idx: number) {
    setResearchSeeds((prev) => prev.filter((_, i) => i !== idx));
  }

  async function runResearch(opts: {
    mode: "replace" | "append";
    seeds: string[];
    brandNiche: string;
    intent: ResearchIntent;
    tone: ResearchTone;
    country: string;
    language: string;
  }) {
    setError(null);
    setResearchMsg(null);
    setResearchImportMsg(null);
    if (opts.mode === "replace") setResearchKeywordAnalysis(null);

    const seeds = (opts.seeds || []).map((s) => s.trim()).filter(Boolean).slice(0, 25);
    if (!seeds.length) {
      setResearchMsg("Add at least one seed keyword/topic.");
      return;
    }
    const researchQuota = featureLimits?.custom_research;
    if (researchQuota && !researchQuota.unlimited && (researchQuota.month_remaining ?? 0) <= 0) {
      setResearchMsg(
        `Monthly Custom Curations limit reached for your ${featureLimits?.plan_key || "current"} plan.`
      );
      return;
    }

    if (opts.mode === "append") setResearchGeneratingMore(true);
    else setResearchBusy(true);

    try {
      const res = await api.researchIdeas(projectId, {
        brand_niche: opts.brandNiche,
        intent: opts.intent,
        tone: opts.tone,
        seed_keywords: seeds,
        country: opts.country,
        language: opts.language,
      });
      const rows = (res?.ideas || []) as ApiResearchIdeaRow[];
      const ka = (res as unknown as { keyword_analysis?: unknown })?.keyword_analysis;

      const runId = `run_${Date.now()}`;
      const generatedAt = new Date().toISOString();

      const incoming: ResearchIdeaRow[] = Array.isArray(rows)
        ? rows
            .filter((r) => r && typeof r === "object")
            .map((r) => ({
              id: String(
                (r as ApiResearchIdeaRow).id ||
                  `${(r as ApiResearchIdeaRow).title}:${(r as ApiResearchIdeaRow).focus_keyphrase}`
              ),
              title: String((r as ApiResearchIdeaRow).title || "").trim(),
              focus_keyphrase: String((r as ApiResearchIdeaRow).focus_keyphrase || "").trim(),
              keywords: Array.isArray((r as ApiResearchIdeaRow).keywords)
                ? (r as ApiResearchIdeaRow).keywords.map((k) => String(k || "").trim()).filter(Boolean)
                : [],
              score: (r as ApiResearchIdeaRow).score ?? null,
              rationale: (r as ApiResearchIdeaRow).rationale ?? null,
              imported: false,
              imported_at: null,
              imported_article_id: null,
              generated_at: generatedAt,
              run_id: runId,
            }))
            .filter((r) => r.title && r.focus_keyphrase)
        : [];

      // Merge incoming with persisted (dedupe by title+focus_keyphrase, preserve imported flag).
      setResearchResults((prev) => {
        const base = opts.mode === "replace" ? [] : prev;
        const indexByKey = new Map<string, number>();
        const merged: ResearchIdeaRow[] = [];
        for (const r of base) {
          const k = makeResearchKey(r.title, r.focus_keyphrase);
          if (!indexByKey.has(k)) {
            indexByKey.set(k, merged.length);
            merged.push(r);
          }
        }
        for (const r of incoming) {
          const k = makeResearchKey(r.title, r.focus_keyphrase);
          const at = indexByKey.get(k);
          if (at == null) {
            indexByKey.set(k, merged.length);
            merged.push({ ...r, run_id: runId, generated_at: generatedAt });
          } else {
            // Refresh the existing row's runId/generated_at and merge keywords; keep imported flag.
            const existing = merged[at];
            const seenK = new Set((existing.keywords || []).map((x) => x.toLowerCase()));
            const extraK = (r.keywords || []).filter((x) => !seenK.has(x.toLowerCase()));
            merged[at] = {
              ...existing,
              keywords: [...(existing.keywords || []), ...extraK].slice(0, 12),
              rationale: existing.rationale || r.rationale || null,
              run_id: runId,
              generated_at: generatedAt,
            };
          }
        }
        return merged;
      });

      setResearchLatestRunId(runId);
      setResearchFilter("latest");
      setResearchSelected(new Set());
      void refreshFeatureLimits();

      if (!incoming.length) setResearchMsg("No results returned. Try different seeds.");

      if (ka && typeof ka === "object" && ka !== null) {
        const obj = ka as Record<string, unknown>;
        const asStringArray = (v: unknown) =>
          Array.isArray(v) ? v.map((x) => String(x || "").trim()).filter(Boolean) : [];
        const primary =
          asStringArray(obj.primary_keywords) ||
          asStringArray(obj.primary_topics) ||
          asStringArray(obj.primaryTopics) ||
          asStringArray(obj.primary) ||
          [];
        const supporting =
          asStringArray(obj.supporting_keywords) ||
          asStringArray(obj.supportingKeywords) ||
          asStringArray(obj.supporting) ||
          [];
        const notes = String(obj.notes || obj.note || "").trim();
        if (primary.length || supporting.length || notes) {
          setResearchKeywordAnalysis({
            primary_keywords: primary,
            supporting_keywords: supporting,
            notes,
          });
        }
      }
    } catch (e) {
      setResearchMsg(e instanceof Error ? e.message : "Research failed");
    } finally {
      setResearchBusy(false);
      setResearchGeneratingMore(false);
    }
  }

  async function importSelectedIdeas(opts: { skipDuplicates: boolean }) {
    setError(null);
    setResearchMsg(null);
    setResearchImportMsg(null);
    if (researchImporting) return;

    const selected = researchResults.filter((r) => researchSelected.has(r.id) && !r.imported);
    if (!selected.length) return;
    const rows: BulkUploadRow[] = selected.map((r) => ({
      title: r.title,
      focus_keyphrase: r.focus_keyphrase,
      keywords: (r.keywords || []).slice(0, 10),
    }));

    setResearchImporting(true);
    try {
      const res = await api.bulkUploadArticles(projectId, rows, {
        skipProjectDuplicateConflicts: opts.skipDuplicates,
      });
      const refreshedArticles = await api.listArticles(projectId);
      setArticles(refreshedArticles);

      // Build a title -> article-id map for newly imported items.
      const titleToId = new Map<string, string>();
      for (const a of refreshedArticles) {
        const k = (a.title || "").trim().toLowerCase();
        if (!k) continue;
        if (!titleToId.has(k)) titleToId.set(k, a.id);
      }
      const importedIds = new Set(selected.map((r) => r.id));
      const importedAt = new Date().toISOString();
      setResearchResults((prev) =>
        prev.map((r) => {
          if (!importedIds.has(r.id)) return r;
          const matchedId = titleToId.get((r.title || "").trim().toLowerCase()) || r.imported_article_id || null;
          return { ...r, imported: true, imported_at: importedAt, imported_article_id: matchedId };
        })
      );

      setResearchImportDupModal(null);
      setResearchSelected(new Set());
      const skipped = res.project_skipped_as_duplicates || 0;
      setResearchImportMsg(
        `Imported ${res.created} article${res.created === 1 ? "" : "s"}${skipped ? ` (${skipped} skipped as duplicates)` : ""}.`
      );
      setResearchFilter("imported");
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.detail && typeof e.detail === "object" && e.detail !== null) {
        const d = e.detail as Record<string, unknown>;
        if (d.error === "duplicate_article_titles") {
          const raw = d.project_duplicates;
          const projectDuplicates: ProjectDupRow[] = Array.isArray(raw)
            ? raw
                .filter((x): x is Record<string, unknown> => x !== null && typeof x === "object")
                .map((x) => ({
                  submitted_title: String(x.submitted_title ?? ""),
                  existing_title: String(x.existing_title ?? ""),
                  existing_id: String(x.existing_id ?? ""),
                }))
            : [];
          const inRaw = d.in_file_duplicate_titles;
          const inFileDuplicateTitles = Array.isArray(inRaw)
            ? inRaw.filter((x): x is string => typeof x === "string")
            : [];
          const wc = d.would_create_count;
          setResearchImportDupModal({
            projectDuplicates,
            inFileDuplicateTitles,
            wouldCreateCount: typeof wc === "number" ? wc : 0,
          });
          return;
        }
      }
      setResearchImportMsg(e instanceof Error ? e.message : "Import failed");
    } finally {
      setResearchImporting(false);
    }
  }

  const filteredResearchResults = useMemo(() => {
    if (!researchResults.length) return [] as ResearchIdeaRow[];
    switch (researchFilter) {
      case "latest":
        return researchLatestRunId
          ? researchResults.filter((r) => r.run_id === researchLatestRunId)
          : researchResults;
      case "imported":
        return researchResults.filter((r) => !!r.imported);
      case "not_imported":
        return researchResults.filter((r) => !r.imported);
      case "all":
      default:
        return researchResults;
    }
  }, [researchResults, researchFilter, researchLatestRunId]);

  const researchCounts = useMemo(() => {
    const all = researchResults.length;
    let imported = 0;
    let latest = 0;
    for (const r of researchResults) {
      if (r.imported) imported += 1;
      if (researchLatestRunId && r.run_id === researchLatestRunId) latest += 1;
    }
    return { all, imported, notImported: all - imported, latest };
  }, [researchResults, researchLatestRunId]);

  const Icon = {
    Menu: (props: { className?: string }) => (
      <svg viewBox="0 0 24 24" aria-hidden="true" className={props.className}>
        <path d="M4 6.5h16M4 12h16M4 17.5h16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    ),
    Back: (props: { className?: string }) => (
      <svg viewBox="0 0 24 24" aria-hidden="true" className={props.className}>
        <path d="M14.5 6.5L9 12l5.5 5.5M10 12h10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
    X: (props: { className?: string }) => (
      <svg viewBox="0 0 24 24" aria-hidden="true" className={props.className}>
        <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    ),
    Refresh: (props: { className?: string }) => (
      <svg viewBox="0 0 24 24" aria-hidden="true" className={props.className}>
        <path
          d="M20 12a8 8 0 1 1-2.34-5.66M20 4v6h-6"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
  };

  const scheduledVisible = useMemo(() => {
    const q = scheduledSearch.trim().toLowerCase();
    const titleFor = (articleId: string) => (articles.find((a) => a.id === articleId)?.title || "").trim();
    const parseTs = (runAt: string | null | undefined) => {
      const v = (runAt || "").trim();
      if (!v) return 0;
      const iso = v.includes("T") ? v : v.replace(" ", "T") + "Z";
      const t = Date.parse(iso);
      return Number.isFinite(t) ? t : 0;
    };
    let rows = (scheduledJobs || []).slice();
    if (q) {
      rows = rows.filter((j) => {
        const t = titleFor(j.article_id).toLowerCase();
        const id = String(j.article_id || "").toLowerCase();
        return t.includes(q) || id.includes(q);
      });
    }
    rows.sort((a, b) => {
      const ta = parseTs(a.run_at);
      const tb = parseTs(b.run_at);
      return scheduledOrder === "asc" ? ta - tb : tb - ta;
    });
    return rows;
  }, [articles, scheduledJobs, scheduledOrder, scheduledSearch]);

  const clusterPlanLimitReached = Boolean(
    featureLimits?.cluster_plans &&
      !featureLimits.cluster_plans.unlimited &&
      (featureLimits.cluster_plans.month_remaining ?? 0) <= 0,
  );
  const customResearchLimitReached = Boolean(
    featureLimits?.custom_research &&
      !featureLimits.custom_research.unlimited &&
      (featureLimits.custom_research.month_remaining ?? 0) <= 0,
  );
  const contextLinkLimitReached = Boolean(
    featureLimits?.context_links &&
      !featureLimits.context_links.unlimited &&
      linkDrafts.length >= (featureLimits.context_links.limit ?? 0),
  );
  const sidebarEmail = (profile?.email || "").trim();
  const sidebarPlan = (profile?.subscription_type || "beta").trim() || "beta";

  return (
    <div className={`${styles.page} ${styles.pageTop} ${projectsDark.projectsDark}`}>
      <main className={`${styles.main} ${styles.mainWide}`}>
        <div className={styles.mobileTabsBar} role="navigation" aria-label="Project sections">
         
          <Link className={styles.mobileBackButton} href="/dashboard" aria-label="Back to dashboard">
            <Icon.Back className={styles.icon20} />
            Back
          </Link>

          <button
            type="button"
            className={styles.mobileMenuButton}
            aria-label="Open menu"
            aria-haspopup="dialog"
            aria-expanded={mobileNavOpen ? "true" : "false"}
            onClick={() => setMobileNavOpen(true)}
          >
            <Icon.Menu className={styles.icon20} />
          </button>
         
        </div>

        {mobileNavOpen ? (
          <>
            <button
              type="button"
              className={styles.offcanvasBackdrop}
              aria-label="Close menu"
              onClick={() => setMobileNavOpen(false)}
            />
            <div className={styles.offcanvasPanel} role="dialog" aria-modal="true" aria-label="Project menu">
              <div className={styles.offcanvasHead}>
                <div className={styles.offcanvasTitle}>Menu</div>
                <button type="button" className={styles.iconButton} aria-label="Close menu" onClick={() => setMobileNavOpen(false)}>
                  <Icon.X className={styles.icon20} />
                </button>
              </div>
              <div className={styles.offcanvasBody}>
                {visibleTabs.map((k) => (
                  <button
                    key={k}
                    type="button"
                    className={`${styles.offcanvasItem} ${tab === k ? styles.offcanvasItemActive : ""}`}
                    onClick={() => goTab(k)}
                  >
                    {tabLabel[k]}
                  </button>
                ))}
              </div>
              <div className={styles.sidebarAccountCard}>
                <div className={styles.sidebarAvatar} aria-hidden="true">
                  {(sidebarEmail || "U").charAt(0).toUpperCase()}
                </div>
                <div className={styles.sidebarAccountMeta}>
                  <div className={styles.sidebarAccountEmail} title={sidebarEmail || "Signed in"}>
                    {sidebarEmail || "Signed in"}
                  </div>
                  <div className={styles.sidebarAccountPlan}>Plan: {sidebarPlan}</div>
                </div>
              </div>
            </div>
          </>
        ) : null}

        <div className={styles.shell}>
          <aside className={styles.sidebar} aria-label="Project navigation">
            <div className={styles.sidebarTitle}>PROJECT</div>
            <div className={styles.navGroup}>
              <Link className={styles.navItem} href="/dashboard">
                ← Back to dashboard
              </Link>
            </div>

            {/* Project switcher lives in its own labelled block so it
                reads as a stand-alone control, not "another nav item"
                stacked under the Back-to-dashboard button. The dotted
                hairline + Current-project caption gives it the same
                visual rhythm as the SECTIONS group below. */}
            {(() => {
              const list = projectsList.slice();
              const hasCurrent = list.some((p) => p.id === projectId);
              if (!hasCurrent) {
                list.unshift({
                  id: projectId,
                  owner_user_id: "",
                  name: (projectMeta?.name || "Current project").trim() || "Current project",
                } as import("@/lib/api").ProjectPublic);
              }
              const currentName =
                (list.find((p) => p.id === projectId)?.name || "").trim() ||
                "Current project";
              return (
                <div className={styles.projectSwitcherBlock}>
                  <label
                    className={styles.sidebarTitle}
                    htmlFor="aa-project-switcher"
                    style={{ marginBottom: 8 }}
                  >
                    CURRENT PROJECT
                  </label>
                  <div className={styles.projectSwitcherField}>
                    <select
                      id="aa-project-switcher"
                      className={styles.projectSwitcher}
                      value={projectId}
                      onChange={(e) => switchProject(e.target.value)}
                      aria-label="Switch project"
                      title={currentName}
                    >
                      {list.map((p) => (
                        <option key={p.id} value={p.id}>
                          {(p.name || "").trim() || "Untitled project"}
                        </option>
                      ))}
                    </select>
                    <span className={styles.projectSwitcherChevron} aria-hidden="true">
                      ▾
                    </span>
                  </div>
                  <div className={styles.projectSwitcherCaption}>
                    Switch to another project — your active section is preserved.
                  </div>
                </div>
              );
            })()}

            <div className={styles.sidebarDivider} aria-hidden="true" />

            <div className={styles.sidebarTitle}>SECTIONS</div>
            <div className={styles.navGroup} role="navigation" aria-label="Project sections">
              {visibleTabs.map((k) => (
                <button
                  key={k}
                  type="button"
                  className={`${styles.navItem} ${tab === k ? styles.navItemActive : ""}`}
                  onClick={() => goTab(k)}
                >
                  {tabLabel[k]}
                </button>
              ))}
            </div>
            <div className={styles.sidebarAccountCard}>
              <div className={styles.sidebarAvatar} aria-hidden="true">
                {(sidebarEmail || "U").charAt(0).toUpperCase()}
              </div>
              <div className={styles.sidebarAccountMeta}>
                <div className={styles.sidebarAccountEmail} title={sidebarEmail || "Signed in"}>
                  {sidebarEmail || "Signed in"}
                </div>
                <div className={styles.sidebarAccountPlan}>Plan: {sidebarPlan}</div>
              </div>
            </div>
          </aside>

          <section className={styles.contentCol}>
            <div className={styles.intro} style={{ paddingTop: 0 }}>
              {tab === "articles" ? (
                <>
                  {/* Desktop header: Articles + live search + add */}
                  <div className={`${styles.desktopHeadRow} ${styles.hideOnMobile}`}>
                    <h1 style={{ margin: 0 }}>Articles</h1>
                    <div className={styles.headSearchWrap} aria-label="Live search">
                      <input
                        className={`${styles.input} ${styles.headSearchInput}`}
                        placeholder="Search by title, keyphrase, keyword…"
                        value={q}
                        onChange={(e) => setQ(e.target.value)}
                      />
                    </div>
                    <button
                      className={styles.button}
                      type="button"
                      onClick={() => {
                        setError(null);
                        setAddArticleDupModal(null);
                        setShowAddArticle(true);
                      }}
                    >
                      + Add article
                    </button>
                  </div>

                  {/* Mobile header: Articles + add */}
                  <div className={`${styles.mobileHeadRow} ${styles.showOnMobile}`}>
                    <h1 className={styles.mobileTitle} style={{ margin: 0 }}>
                      Articles
                    </h1>
                    <button
                      className={styles.button}
                      type="button"
                      onClick={() => {
                        setError(null);
                        setAddArticleDupModal(null);
                        setShowAddArticle(true);
                      }}
                    >
                      + Add article
                    </button>
                  </div>

                  {/* Mobile: live search full width under header */}
                  <div className={styles.showOnMobile} style={{ width: "100%" }}>
                    <input
                      className={`${styles.input} ${styles.headSearchInputMobile}`}
                      placeholder="Search by title, keyphrase, keyword…"
                      value={q}
                      onChange={(e) => setQ(e.target.value)}
                    />
                  </div>
                

                  <div className={styles.mobileActionChips}>
                    <button
                      className={styles.chipButton}
                      type="button"
                      onClick={() => {
                        setError(null);
                        setBulkUploadErrors([]);
                        setBulkUploadRows([]);
                        setBulkParseDupTitles([]);
                        setShowBulkUpload(true);
                      }}
                    >
                      Bulk Upload
                    </button>
                    <button
                      className={styles.chipButton}
                      type="button"
                      onClick={() => {
                        setError(null);
                        setExportFrom(dateFrom || "");
                        setExportTo(dateTo || "");
                        setExportStatus(status || "");
                        setShowExportArticles(true);
                      }}
                    >
                      Export
                    </button>
                    <button className={`${styles.chipButton} ${styles.chipButtonPrimary}`} type="button" onClick={() => setShowMobileFilters(true)}>
                      Filter
                    </button>
                    {selectedIds.length ? (
                      <button
                        className={`${styles.chipButton} ${styles.buttonHighlight}`}
                        type="button"
                        onClick={() => {
                          setBulkMode("root");
                          setShowBulkPopup(true);
                        }}
                      >
                        Actions…
                      </button>
                    ) : null}
                  </div>
                </>
              ) : (
                <>
                  <h1 style={{ margin: 0 }}>{tabLabel[tab]}</h1>
                  {tab === "research" ? (
                    <div className={styles.muted} style={{ marginTop: 6, lineHeight: 1.55 }}>
                      Generate optimized titles, focus keyphrases, and keywords — then import them into Articles.
                    </div>
                  ) : null}
                </>
              )}
            </div>

            {showMobileFilters ? (
              <>
                <button type="button" className={styles.modalBackdrop} aria-label="Close filters" onClick={() => setShowMobileFilters(false)} />
                <div className={styles.modalPanel} role="dialog" aria-modal="true" aria-label="Filters">
                  <div className={styles.modalHead}>
                    <h3 className={styles.modalTitle}>Filter</h3>
                    <button type="button" className={styles.iconButton} aria-label="Close" onClick={() => setShowMobileFilters(false)}>
                      <Icon.X className={styles.icon20} />
                    </button>
                  </div>
                  <div className={styles.modalBody}>
                    <label className={styles.label}>
                      Status
                      <select className={styles.input} value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
                        <option value="">All</option>
                        <option value="pending">Pending</option>
                        <option value="draft">Draft</option>
                        <option value="scheduled">Scheduled</option>
                        <option value="published">Published</option>
                      </select>
                    </label>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 10 }}>
                      <label className={styles.label}>
                        From
                        <input className={styles.input} type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
                      </label>
                      <label className={styles.label}>
                        To
                        <input className={styles.input} type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
                      </label>
                    </div>
                    <label className={styles.label} style={{ marginTop: 10 }}>
                      Date order
                      <select
                        className={styles.input}
                        value={dateOrder}
                        onChange={(e) => {
                          setDateOrder(e.target.value as "asc" | "desc");
                          setPage(1);
                        }}
                      >
                        <option value="desc">Latest → Oldest</option>
                        <option value="asc">Oldest → Latest</option>
                      </select>
                    </label>
                  </div>
                  <div className={styles.modalFooter}>
                    <button
                      type="button"
                      className={styles.btnSecondary}
                      onClick={() => {
                        setStatus("");
                        setDateFrom("");
                        setDateTo("");
                        setDateOrder("desc");
                      }}
                    >
                      Clear
                    </button>
                    <button type="button" className={styles.button} onClick={() => setShowMobileFilters(false)}>
                      Apply
                    </button>
                  </div>
                </div>
              </>
            ) : null}

        {tab === "articles" ? (
          <>
            {showBulkPopup ? (
              <>
                <div className={styles.bulkBackdrop} onClick={() => setShowBulkPopup(false)} />
                <div className={styles.bulkPopup} role="dialog" aria-modal="true" aria-label="Bulk actions">
                  <div className={styles.bulkPopupHead}>
                    <div className={styles.bulkPopupTitle}>
                      <strong>Schedule articles</strong>
                    </div>
                    <button className={styles.iconButton} type="button" aria-label="Close bulk actions" onClick={() => setShowBulkPopup(false)}>
                      <Icon.X className={styles.icon20} />
                    </button>
                  </div>
                  {bulkMode === "root" ? (
                    <div className={styles.bulkPopupActions} style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))" }}>
                      <button
                        className={styles.button}
                        type="button"
                        onClick={bulkEdit}
                        disabled={selectedIds.length !== 1}
                        title={selectedIds.length !== 1 ? "Select exactly 1 article to edit" : "Edit selected article"}
                      >
                        Edit article
                      </button>
                      <button className={styles.button} type="button" onClick={() => setBulkMode("change_status")}>
                        Change status
                      </button>
                      <button className={styles.button} type="button" onClick={bulkSchedule}>
                        Schedule articles
                      </button>
                      <button className={styles.button} type="button" onClick={bulkDelete}>
                        Delete articles
                      </button>
                    </div>
                  ) : bulkMode === "change_status" ? (
                    <>
                      <div className={styles.row} style={{ paddingTop: 12, justifyContent: "space-between", alignItems: "center" }}>
                        <div className={styles.muted} style={{ fontWeight: 700 }}>
                          Pick a status
                        </div>
                        <button type="button" className={styles.btnSecondary} onClick={() => setBulkMode("root")}>
                          Back
                        </button>
                      </div>
                      <div className={styles.bulkPopupActions} style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
                        <button className={styles.button} type="button" onClick={() => bulkChangeStatus("pending")}>
                          Pending
                        </button>
                        <button className={styles.button} type="button" onClick={() => bulkChangeStatus("draft")}>
                          Draft
                        </button>
                        <button className={styles.button} type="button" onClick={() => bulkChangeStatus("published")}>
                          Published
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className={styles.row} style={{ paddingTop: 12, justifyContent: "space-between", alignItems: "center" }}>
                        <div className={styles.muted} style={{ fontWeight: 700 }}>
                          Schedule {bulkScheduleRows.length} article(s) {profileTz ? <span style={{ fontWeight: 500 }}>(Timezone: {profileTz})</span> : null}
                        </div>
                      </div>

                      <div className={styles.bulkScheduleGrid} style={{ paddingTop: 10 }}>
                        <label className={styles.label}>
                          WordPress post type (applies to all)
                          <select className={styles.input} value={bulkSchedulePostType} onChange={(e) => setBulkSchedulePostType(e.target.value)} disabled={bulkScheduling}>
                            <option value="posts">Posts</option>
                            <option value="pages">Pages</option>
                            {wpTypesForSchedule
                              .filter((t) => t.rest_base && !["posts", "pages"].includes(t.rest_base))
                              .map((t) => (
                                <option key={t.rest_base} value={t.rest_base}>
                                  {t.name || t.rest_base}
                                </option>
                              ))}
                          </select>
                        </label>
                        <label className={styles.label}>
                          WordPress status (applies to all)
                          <select className={styles.input} value={bulkScheduleWpStatus} onChange={(e) => setBulkScheduleWpStatus(e.target.value as "draft" | "publish")} disabled={bulkScheduling}>
                            <option value="draft">Draft</option>
                            <option value="publish">Publish</option>
                          </select>
                        </label>
                      </div>

                      <div className={styles.bulkScheduleGrid} style={{ paddingTop: 10 }}>
                        <label className={styles.label}>
                          Writing prompt (applies to all)
                          <select className={styles.input} value={scheduleWritingPromptId} onChange={(e) => setScheduleWritingPromptId(e.target.value)} disabled={bulkScheduling}>
                            <option value="">Use project default</option>
                            {(scheduleWritingPrompts?.items || []).map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.name || p.id}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className={styles.label}>
                          Image prompt (applies to all)
                          <select className={styles.input} value={scheduleImagePromptId} onChange={(e) => setScheduleImagePromptId(e.target.value)} disabled={bulkScheduling}>
                            <option value="">Use project default</option>
                            {(scheduleImagePrompts?.items || []).map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.name || p.id}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>

                      <div style={{ paddingTop: 10, maxHeight: 340, overflow: "auto", borderTop: "1px solid var(--button-secondary-border)", marginTop: 12 }}>
                        {bulkScheduleRows.map((r, idx) => (
                          <div key={r.id} className={styles.bulkScheduleRow}>
                            <div style={{ minWidth: 0 }}>
                              <div style={{ fontWeight: 800, fontSize: 13, wordBreak: "break-word" }}>{idx + 1}. {r.title}</div>
                              <div className={styles.muted} style={{ fontSize: 12 }}>{r.id}</div>
                            </div>
                            <label className={styles.label} style={{ margin: 0 }}>
                              Date & time
                              <input
                                className={styles.input}
                                type="datetime-local"
                                value={r.when}
                                min={bulkScheduleMin || undefined}
                                step={60}
                                disabled={bulkScheduling}
                                onChange={(e) => {
                                  const v = e.target.value;
                                  setBulkScheduleRows((prev) => prev.map((x) => (x.id === r.id ? { ...x, when: v } : x)));
                                }}
                              />
                            </label>
                          </div>
                        ))}
                      </div>

                      {error ? <p className={styles.error} style={{ marginTop: 10 }}>{error}</p> : null}

                      <div className={styles.row} style={{ paddingTop: 12, justifyContent: "flex-end", gap: 10 }}>
                        <button type="button" className={styles.btnSecondary} onClick={() => setBulkMode("root")} disabled={bulkScheduling}>
                          Cancel
                        </button>
                        <button type="button" className={styles.button} onClick={bulkScheduleSubmit} disabled={bulkScheduling || !bulkScheduleRows.length}>
                          {bulkScheduling ? "Scheduling…" : "Schedule"}
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </>
            ) : null}

              <div className={`${styles.card} ${styles.cardWide} ${styles.hideOnMobile} ${styles.desktopFiltersWrap}`}>
                <div className={styles.filtersGrid}>
                  <label className={styles.label}>
                    Status
                    <select className={styles.input} value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
                      <option value="">All</option>
                      <option value="pending">Pending</option>
                      <option value="draft">Draft</option>
                      <option value="scheduled">Scheduled</option>
                      <option value="published">Published</option>
                    </select>
                  </label>
                  <label className={styles.label}>
                    From
                    <input className={styles.input} type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
                  </label>
                  <label className={styles.label}>
                    To
                    <input className={styles.input} type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
                  </label>
                  <label className={styles.label}>
                    Date order
                    <select
                      className={styles.input}
                      value={dateOrder}
                      onChange={(e) => {
                        setDateOrder(e.target.value as "asc" | "desc");
                        setPage(1);
                      }}
                    >
                      <option value="desc">Latest → Oldest</option>
                      <option value="asc">Oldest → Latest</option>
                    </select>
                  </label>
                  {q.trim() || status || dateFrom || dateTo ? (
                    <button className={styles.button} type="button" onClick={() => { setQ(""); setStatus(""); setDateFrom(""); setDateTo(""); }}>
                      Clear filters
                    </button>
                  ) : (
                    <div />
                  )}
                </div>

                <div className={styles.filtersActionsRow}>
                  <div className={styles.filtersActionsLeft}>
                    <button
                      className={styles.btnSecondary}
                      type="button"
                      onClick={() => {
                        setError(null);
                        setBulkUploadErrors([]);
                        setBulkUploadRows([]);
                        setBulkParseDupTitles([]);
                        setShowBulkUpload(true);
                      }}
                    >
                      Bulk Upload
                    </button>
                    <button
                      className={styles.btnSecondary}
                      type="button"
                      onClick={() => {
                        setError(null);
                        setExportFrom(dateFrom || "");
                        setExportTo(dateTo || "");
                        setExportStatus(status || "");
                        setShowExportArticles(true);
                      }}
                    >
                      Export Articles
                    </button>
                  </div>
                  <div className={styles.filtersActionsRight}>
                    <span className={styles.smallMuted}>{selectedIds.length} selected</span>
                    <button
                      className={`${styles.button} ${selectedIds.length ? styles.buttonHighlight : ""}`}
                      type="button"
                      onClick={() => {
                        if (!selectedIds.length) return;
                        setBulkMode("root");
                        setShowBulkPopup(true);
                      }}
                      disabled={selectedIds.length === 0}
                    >
                      Actions…
                    </button>
                  </div>
                </div>
              </div>

              <div className={`${styles.card} ${styles.cardWide}`} style={{ padding: 0 }}>
                <div className={styles.articlesListHead}>
                  <input type="checkbox" checked={allOnPageSelected} onChange={toggleAllOnPage} />
                  <div className={styles.smallMuted}>Title</div>
                  <div className={`${styles.smallMuted} ${styles.pushRight}`}>Status</div>
                </div>

                {loading ? <div style={{ padding: 14 }}>Loading…</div> : null}
                {!loading && filtered.length === 0 ? <div style={{ padding: 14 }}>No articles match the current filters.</div> : null}

                {!loading
                  ? pageItems.map((a) => (
                      <div
                        key={a.id}
                        className={styles.articleRow}
                      >
                        <input type="checkbox" checked={!!selected[a.id]} onChange={() => toggleOne(a.id)} />
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <Link
                            href={`/projects/${projectId}/articles/${a.id}`}
                            className={styles.articleTitleLink}
                          >
                            {a.title || "(Untitled)"}
                          </Link>
                          <div style={{ marginTop: 4, fontSize: 12, color: "#666", lineHeight: 1.4 }}>
                            {a.focus_keyphrase ? (
                              <span style={{ marginRight: 10 }}>
                                <span style={{ color: "#999" }}>Focus:</span> {a.focus_keyphrase}
                              </span>
                            ) : null}
                            {a.keywords && a.keywords.length ? (
                              <span>
                                <span style={{ color: "#999" }}>Keywords:</span> {a.keywords.join(", ")}
                              </span>
                            ) : null}
                          </div>
                          <div style={{ marginTop: 4, fontSize: 12, color: "#777" }}>
                            <span>Updated {a.updated_at || a.created_at || "—"}</span>
                            <span> · Posted {a.posted_at || "—"}</span>
                            <span> · Sched {formatInProfileTz(a.wp_scheduled_at)}</span>
                            {a.wp_link ? (
                              <span>
                                {" "}
                                ·{" "}
                                <a href={a.wp_link} target="_blank" rel="noreferrer" style={{ color: "var(--link-color, #1677ff)" }}>
                                  View live
                                </a>
                              </span>
                            ) : null}
                            {a.wp_schedule_error ? <span style={{ color: "#ff4d4f" }}> · Schedule error</span> : null}
                            {a.wp_link ? (
                              <span style={{ marginLeft: 6 }}>
                                ·{" "}
                                <span
                                  title={
                                    a.monitor_status === "fresh"
                                      ? "Optimization status: fresh — recently published or refreshed."
                                      : a.monitor_status === "stale"
                                      ? "Optimization status: stale — schedule a Smart Refresh to keep rankings."
                                      : "Optimization status not yet evaluated. Mark manually below; auto rank-monitoring lands in the next iteration."
                                  }
                                  style={{
                                    display: "inline-block",
                                    padding: "1px 6px",
                                    borderRadius: 4,
                                    fontWeight: 700,
                                    fontSize: 11,
                                    color:
                                      a.monitor_status === "stale"
                                        ? "#b00020"
                                        : a.monitor_status === "fresh"
                                        ? "#2f7d32"
                                        : "#666",
                                    background:
                                      a.monitor_status === "stale"
                                        ? "rgba(176,0,32,0.08)"
                                        : a.monitor_status === "fresh"
                                        ? "rgba(47,125,50,0.10)"
                                        : "rgba(0,0,0,0.05)",
                                  }}
                                >
                                  {a.monitor_status === "stale"
                                    ? "Stale"
                                    : a.monitor_status === "fresh"
                                    ? "Fresh"
                                    : "Optimization: —"}
                                </span>
                              </span>
                            ) : null}
                          </div>

                          <div className={styles.articleActions}>
                            <Link href={`/projects/${projectId}/articles/${a.id}`} className={`${styles.miniBtn} ${styles.miniPrimary}`}>
                              Edit
                            </Link>
                            <button
                              type="button"
                              className={styles.miniBtn}
                              onClick={() => {
                                const min = new Date(Date.now() + 5 * 60 * 1000);
                                const minStr = toDatetimeLocalFromDateInProfileTz(min);
                                setScheduleMin(minStr);
                                setScheduleId(a.id);
                                setScheduleWhen(minStr);
                                setScheduleWpStatus(wpDefaults?.wp_status || "draft");
                                setSchedulePostType(wpDefaults?.post_type || "posts");
                                setScheduleWritingPromptId(scheduleWritingPrompts?.default_id || "");
                                setScheduleImagePromptId(scheduleImagePrompts?.default_id || "");
                              }}
                            >
                              Schedule
                            </button>
                            <button
                              type="button"
                              className={styles.miniBtn}
                              onClick={() => {
                                setRequestIndexingId(a.id);
                                setRequestIndexingMsg("");
                              }}
                              disabled={!a.wp_link}
                              title={!a.wp_link ? "Publish first to get a live URL." : "Request indexing (URL Inspection) in Google Search Console."}
                            >
                              Request Indexing
                            </button>
                            {a.wp_link ? (
                              <button
                                type="button"
                                className={styles.miniBtn}
                                onClick={() =>
                                  markArticleMonitor(
                                    a.id,
                                    (a.monitor_status === "fresh" ? "stale" : "fresh") as "fresh" | "stale",
                                  )
                                }
                                title={
                                  a.monitor_status === "fresh"
                                    ? "Mark this article stale — once Smart Refresh ships, it will queue an updated regeneration."
                                    : "Mark this article fresh — clears the stale flag in the dashboard."
                                }
                              >
                                {a.monitor_status === "fresh" ? "Mark stale" : "Mark fresh"}
                              </button>
                            ) : null}
                            <button type="button" className={`${styles.miniBtn} ${styles.miniDanger}`} onClick={() => setConfirmDeleteId(a.id)}>
                              Delete
                            </button>
                          </div>
                        </div>
                        <div className={styles.articleMetaCol}>
                          <span style={{ fontSize: 12, color: "#666" }}>{(a.gsc_status || "").toLowerCase() === "inspected" ? "Requested" : "Not requested"}</span>
                          <span className={statusPillClass(a.status)}>{(a.status || "pending").toUpperCase()}</span>
                        </div>
                      </div>
                    ))
                  : null}
              </div>

              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <button className={styles.button} type="button" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={pageClamped <= 1}>
                  Prev
                </button>
                <span style={{ fontSize: 13, color: "#666" }}>
                  Page {pageClamped} / {totalPages} · {filtered.length} item(s)
                </span>
                <button className={styles.button} type="button" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={pageClamped >= totalPages}>
                  Next
                </button>
              </div>

            {confirmDeleteId ? (
              <div className={styles.modalBackdrop} role="dialog" aria-modal="true" aria-label="Confirm delete">
                <div className={styles.modalPanel}>
                  <div className={styles.modalHead}>
                    <h3 className={styles.modalTitle}>Delete article?</h3>
                    <button type="button" className={styles.iconButton} aria-label="Close" onClick={() => setConfirmDeleteId(null)}>
                      <Icon.X className={styles.icon20} />
                    </button>
                  </div>
                  <div className={styles.modalBody}>
                    This will permanently delete the article. Are you sure?
                    {error ? <p className={styles.error} style={{ marginTop: 10 }}>{error}</p> : null}
                  </div>
                  <div className={styles.modalFooter}>
                    <button type="button" className={styles.btnSecondary} onClick={() => setConfirmDeleteId(null)}>
                      Cancel
                    </button>
                    <button type="button" className={styles.button} onClick={() => deleteOne(confirmDeleteId)}>
                      Yes, delete
                    </button>
                  </div>
                </div>
              </div>
            ) : null}

            {scheduleId ? (
              <div className={styles.modalBackdrop} role="dialog" aria-modal="true" aria-label="Schedule article">
                <div className={styles.modalPanel}>
                  <div className={styles.modalHead}>
                    <h3 className={styles.modalTitle}>Schedule article</h3>
                    <button type="button" className={styles.iconButton} aria-label="Close" onClick={() => setScheduleId(null)}>
                      <Icon.X className={styles.icon20} />
                    </button>
                  </div>
                  <div className={styles.modalBody}>
                    <label className={styles.label}>
                      Schedule time
                      <input
                        className={styles.input}
                        type="datetime-local"
                        value={scheduleWhen}
                        min={scheduleMin || undefined}
                        step={60}
                        onChange={(e) => setScheduleWhen(e.target.value)}
                      />
                      <div className={styles.muted} style={{ fontSize: 12, marginTop: 6 }}>
                        Times are interpreted in your profile timezone ({profileTz || "browser default"}). Minimum 5 minutes from now (enforced on save).
                      </div>
                    </label>

                    <label className={styles.label}>
                      Writing prompt
                      <select className={styles.input} value={scheduleWritingPromptId} onChange={(e) => setScheduleWritingPromptId(e.target.value)}>
                        <option value="">Project default</option>
                        {(scheduleWritingPrompts?.items || []).map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                      {scheduleWritingPrompts?.default_id ? (
                        <div className={styles.muted} style={{ fontSize: 12, marginTop: 6 }}>
                          Default:{" "}
                          <strong>
                            {scheduleWritingPrompts.items.find((x) => x.id === scheduleWritingPrompts.default_id)?.name || scheduleWritingPrompts.default_id}
                          </strong>
                        </div>
                      ) : null}
                    </label>

                    <label className={styles.label}>
                      Image prompt
                      <select className={styles.input} value={scheduleImagePromptId} onChange={(e) => setScheduleImagePromptId(e.target.value)}>
                        <option value="">Project default</option>
                        {(scheduleImagePrompts?.items || []).map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                      {scheduleImagePrompts?.default_id ? (
                        <div className={styles.muted} style={{ fontSize: 12, marginTop: 6 }}>
                          Default:{" "}
                          <strong>
                            {scheduleImagePrompts.items.find((x) => x.id === scheduleImagePrompts.default_id)?.name || scheduleImagePrompts.default_id}
                          </strong>
                        </div>
                      ) : null}
                    </label>

                    <label className={styles.label}>
                      WordPress post type
                      <select className={styles.input} value={schedulePostType} onChange={(e) => setSchedulePostType(e.target.value)}>
                        <option value="posts">Posts</option>
                        <option value="pages">Pages</option>
                        {wpTypesForSchedule
                          .filter((t) => t.rest_base && !["posts", "pages"].includes(t.rest_base))
                          .map((t) => (
                            <option key={t.rest_base} value={t.rest_base}>
                              {t.name || t.rest_base}
                            </option>
                          ))}
                      </select>
                    </label>
                    <label className={styles.label}>
                      WordPress status
                      <select className={styles.input} value={scheduleWpStatus} onChange={(e) => setScheduleWpStatus(e.target.value as "draft" | "publish")}>
                        <option value="draft">Draft</option>
                        <option value="publish">Publish</option>
                      </select>
                    </label>
                    {error ? <p className={styles.error}>{error}</p> : null}
                    <div className={styles.muted} style={{ fontSize: 12, marginTop: 6 }}>
                      This sets the schedule time on the article in our system. (Queue runner will publish at the scheduled time.)
                    </div>
                  </div>
                  <div className={styles.modalFooter}>
                    <button type="button" className={styles.btnSecondary} onClick={() => setScheduleId(null)}>
                      Cancel
                    </button>
                    <button type="button" className={styles.button} onClick={() => scheduleOne(scheduleId)}>
                      Schedule
                    </button>
                  </div>
                </div>
              </div>
            ) : null}

            {requestIndexingId ? (
              <div className={styles.modalBackdrop} role="dialog" aria-modal="true" aria-label="Request indexing">
                <div className={styles.modalPanel}>
                  <div className={styles.modalHead}>
                    <h3 className={styles.modalTitle}>Request indexing</h3>
                    <button
                      type="button"
                      className={styles.iconButton}
                      aria-label="Close"
                      onClick={() => {
                        if (requestIndexingBusy) return;
                        setRequestIndexingId(null);
                        setRequestIndexingMsg("");
                        setRequestIndexingResult(null);
                      }}
                    >
                      <Icon.X className={styles.icon20} />
                    </button>
                  </div>
                  <div className={styles.modalBody}>
                    <div style={{ fontSize: 13, color: "#666", lineHeight: 1.5 }}>
                      This pings the Google Indexing API (when configured) and your sitemap as
                      discovery hints. Google does <strong>not</strong> expose a public API equivalent
                      of the &ldquo;Request Indexing&rdquo; button in URL Inspection — to actually
                      queue a crawl that appears in Search Console, click{" "}
                      <strong>Open in Search Console</strong> below and press{" "}
                      <strong>REQUEST INDEXING</strong> there.
                    </div>
                    {requestIndexingMsg ? (
                      <div style={{ marginTop: 10, fontSize: 13, lineHeight: 1.5 }}>
                        {requestIndexingMsg}
                      </div>
                    ) : null}
                    {requestIndexingResult?.inspect_panel_url ? (
                      <div style={{ marginTop: 12 }}>
                        <a
                          href={requestIndexingResult.inspect_panel_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className={styles.button}
                          style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
                        >
                          Open in Search Console ↗
                        </a>
                      </div>
                    ) : null}
                  </div>
                  <div className={styles.modalFoot}>
                    <button
                      type="button"
                      className={styles.btnSecondary}
                      onClick={() => {
                        setRequestIndexingId(null);
                        setRequestIndexingMsg("");
                        setRequestIndexingResult(null);
                      }}
                      disabled={requestIndexingBusy}
                    >
                      Close
                    </button>
                    <button
                      type="button"
                      className={styles.button}
                      onClick={() => requestIndexingOne(requestIndexingId)}
                      disabled={requestIndexingBusy}
                    >
                      {requestIndexingBusy
                        ? "Pinging…"
                        : requestIndexingResult
                        ? "Retry pings"
                        : "Run discovery pings"}
                    </button>
                  </div>
                </div>
              </div>
            ) : null}

            {showAddArticle ? (
              <>
                <button type="button" className={styles.modalBackdrop} aria-label="Close" onClick={() => setShowAddArticle(false)} />
                <div className={styles.modalPanel} role="dialog" aria-modal="true" aria-label="Add article">
                  <div className={styles.modalHead}>
                    <h3 className={styles.modalTitle}>Add article</h3>
                    <button type="button" className={styles.iconButton} aria-label="Close" onClick={() => setShowAddArticle(false)}>
                      <Icon.X className={styles.icon20} />
                    </button>
                  </div>
                  <div className={styles.modalBody}>
                    <label className={styles.label}>
                      Title
                      <input className={styles.input} value={title} onChange={(e) => setTitle(e.target.value)} />
                    </label>
                    {error ? <p className={styles.error}>{error}</p> : null}
                  </div>
                  <div className={styles.modalFooter}>
                    <button type="button" className={styles.btnSecondary} onClick={() => setShowAddArticle(false)}>
                      Cancel
                    </button>
                    <button className={styles.button} type="button" onClick={createArticle} disabled={creating || !title.trim()}>
                      {creating ? "Adding…" : "Add"}
                    </button>
                  </div>
                </div>
              </>
            ) : null}

            {showExportArticles ? (
              <>
                <button
                  type="button"
                  className={styles.modalBackdrop}
                  aria-label="Close"
                  onClick={() => (exporting ? null : setShowExportArticles(false))}
                />
                <div className={styles.modalPanel} role="dialog" aria-modal="true" aria-label="Export articles">
                  <div className={styles.modalHead}>
                    <h3 className={styles.modalTitle}>Export Articles</h3>
                    <button type="button" className={styles.iconButton} aria-label="Close" onClick={() => (exporting ? null : setShowExportArticles(false))}>
                      <Icon.X className={styles.icon20} />
                    </button>
                  </div>
                  <div className={styles.modalBody}>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                      <label className={styles.label}>
                        From
                        <input className={styles.input} type="date" value={exportFrom} onChange={(e) => setExportFrom(e.target.value)} />
                      </label>
                      <label className={styles.label}>
                        To
                        <input className={styles.input} type="date" value={exportTo} onChange={(e) => setExportTo(e.target.value)} />
                      </label>
                    </div>

                    <label className={styles.label} style={{ marginTop: 12 }}>
                      Status
                      <select className={styles.input} value={exportStatus} onChange={(e) => setExportStatus(e.target.value as StatusFilter)}>
                        <option value="">All</option>
                        <option value="pending">Pending</option>
                        <option value="draft">Draft</option>
                        <option value="scheduled">Scheduled</option>
                        <option value="published">Published</option>
                      </select>
                    </label>

                    <div className={styles.muted} style={{ fontSize: 12, marginTop: 10 }}>
                      Export order: <b>Latest → Oldest</b> (by Created date).
                    </div>

                    {error ? <p className={styles.error}>{error}</p> : null}
                  </div>
                  <div className={styles.modalFooter}>
                    <button type="button" className={styles.btnSecondary} onClick={() => setShowExportArticles(false)} disabled={exporting}>
                      Cancel
                    </button>
                    <button type="button" className={styles.button} onClick={exportArticlesNow} disabled={exporting}>
                      {exporting ? "Exporting…" : "Export"}
                    </button>
                  </div>
                </div>
              </>
            ) : null}

            {showBulkUpload ? (
              <>
                <button
                  type="button"
                  className={styles.modalBackdrop}
                  aria-label="Close"
                  onClick={() => {
                    if (bulkUploading) return;
                    setBulkParseDupTitles([]);
                    setShowBulkUpload(false);
                  }}
                />
                <div className={styles.modalPanel} role="dialog" aria-modal="true" aria-label="Bulk upload articles">
                  <div className={styles.modalHead}>
                    <h3 className={styles.modalTitle}>Bulk Upload</h3>
                    <button
                      type="button"
                      className={styles.iconButton}
                      aria-label="Close"
                      onClick={() => {
                        if (bulkUploading) return;
                        setBulkParseDupTitles([]);
                        setShowBulkUpload(false);
                      }}
                    >
                      <Icon.X className={styles.icon20} />
                    </button>
                  </div>
                  <div className={styles.modalBody}>
                    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                      <button type="button" className={styles.btnSecondary} onClick={downloadBulkSample}>
                        Download sample Excel
                      </button>
                      <label className={styles.btnSecondary} style={{ cursor: "pointer" }}>
                        Upload Excel
                        <input
                          type="file"
                          accept=".xlsx,.xls"
                          style={{ display: "none" }}
                          onChange={(e) => onBulkFilePicked(e.target.files?.[0] || null)}
                        />
                      </label>
                      {bulkUploadRows.length ? (
                        <span className={styles.muted} style={{ fontSize: 12 }}>
                          {bulkUploadRows.length} rows ready to import
                        </span>
                      ) : (
                        <span className={styles.muted} style={{ fontSize: 12 }}>
                          Upload an Excel file with the required columns.
                        </span>
                      )}
                    </div>

                    {bulkUploadErrors.length ? (
                      <div style={{ marginTop: 12 }}>
                        {bulkUploadErrors.map((x, idx) => (
                          <div key={idx} className={styles.error} style={{ margin: "6px 0" }}>
                            {x}
                          </div>
                        ))}
                      </div>
                    ) : null}

                    {bulkParseDupTitles.length ? (
                      <div
                        style={{
                          marginTop: 12,
                          padding: "10px 12px",
                          borderRadius: 8,
                          background: "#fff7e6",
                          border: "1px solid #ffd591",
                          fontSize: 13,
                          lineHeight: 1.5,
                        }}
                        role="status"
                      >
                        <strong>Duplicate article titles</strong> — only the <strong>first</strong> row in your file (oldest) is kept for each title. Extra rows were removed before import.
                        <ul style={{ margin: "8px 0 0", paddingLeft: 20 }}>
                          {bulkParseDupTitles.map((t) => (
                            <li key={t}>{t}</li>
                          ))}
                        </ul>
                      </div>
                    ) : null}

                    {bulkUploadRows.length ? (
                      <div style={{ marginTop: 12, fontSize: 12, color: "#666", lineHeight: 1.5 }}>
                        Columns validated and sanitized. Imported articles will be created with <b>Pending</b> status.
                      </div>
                    ) : null}

                    {error ? <p className={styles.error}>{error}</p> : null}
                  </div>
                  <div className={styles.modalFooter}>
                    <button
                      type="button"
                      className={styles.btnSecondary}
                      onClick={() => {
                        setBulkParseDupTitles([]);
                        setShowBulkUpload(false);
                      }}
                      disabled={bulkUploading}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className={styles.button}
                      onClick={() => void importBulkRows(false)}
                      disabled={bulkUploading || !bulkUploadRows.length}
                    >
                      {bulkUploading ? "Importing…" : "Import"}
                    </button>
                  </div>
                </div>
              </>
            ) : null}

            {bulkProjectDupModal ? (
              <>
                <button
                  type="button"
                  className={styles.modalBackdrop}
                  aria-label="Close"
                  onClick={() => {
                    setBulkProjectDupModal(null);
                    setBulkDupExpandList(false);
                  }}
                />
                <div
                  className={styles.modalPanel}
                  role="dialog"
                  aria-modal="true"
                  aria-label="Duplicate articles detected"
                  style={{ maxWidth: 520 }}
                >
                  <div className={styles.modalHead}>
                    <h3 className={styles.modalTitle}>Duplicate articles detected</h3>
                    <button
                      type="button"
                      className={styles.btnSecondary}
                      onClick={() => {
                        setBulkProjectDupModal(null);
                        setBulkDupExpandList(false);
                      }}
                    >
                      Close
                    </button>
                  </div>
                  <div className={styles.modalBody}>
                    <p style={{ marginTop: 0, lineHeight: 1.55 }}>
                      Our system found one or more titles that already exist in this project (comparison is not case-sensitive). Only unique article titles can be added.
                    </p>
                    {bulkProjectDupModal.wouldCreateCount > 0 ? (
                      <p style={{ lineHeight: 1.55 }}>
                        You can continue and import <strong>{bulkProjectDupModal.wouldCreateCount}</strong> unique{" "}
                        {bulkProjectDupModal.wouldCreateCount === 1 ? "article" : "articles"}, skipping rows that conflict with existing titles.
                      </p>
                    ) : (
                      <p style={{ lineHeight: 1.55 }}>
                        No rows can be imported without conflicting with articles already in this project. Remove or rename those rows in your file and try again.
                      </p>
                    )}
                    {bulkProjectDupModal.inFileDuplicateTitles.length ? (
                      <div
                        style={{
                          marginTop: 12,
                          padding: "10px 12px",
                          borderRadius: 8,
                          background: "#fff7e6",
                          border: "1px solid #ffd591",
                          fontSize: 13,
                          lineHeight: 1.5,
                        }}
                      >
                        <strong>In-file duplicates:</strong> your sheet still had repeated titles; only the first occurrence per title was kept before this check.
                      </div>
                    ) : null}
                    <div style={{ marginTop: 14 }}>
                      <button
                        type="button"
                        className={styles.btnSecondary}
                        onClick={() => setBulkDupExpandList((v) => !v)}
                        aria-expanded={bulkDupExpandList}
                      >
                        {bulkDupExpandList ? "Hide" : "View"} list of conflicts with existing articles ({bulkProjectDupModal.projectDuplicates.length})
                      </button>
                      {bulkDupExpandList ? (
                        <ul style={{ margin: "10px 0 0", paddingLeft: 20, lineHeight: 1.55, maxHeight: 220, overflow: "auto" }}>
                          {bulkProjectDupModal.projectDuplicates.map((row, i) => (
                            <li key={`${row.existing_id}-${i}`}>
                              <span style={{ fontWeight: 600 }}>{row.submitted_title || "(empty)"}</span>
                              {" — matches existing: "}
                              <Link className={styles.articleTitleLink} href={`/projects/${projectId}/articles/${row.existing_id}`}>
                                {row.existing_title || row.existing_id}
                              </Link>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  </div>
                  <div className={styles.modalFooter}>
                    <button
                      type="button"
                      className={styles.btnSecondary}
                      onClick={() => {
                        setBulkProjectDupModal(null);
                        setBulkDupExpandList(false);
                      }}
                    >
                      Cancel
                    </button>
                    {bulkProjectDupModal.wouldCreateCount > 0 ? (
                      <button
                        type="button"
                        className={styles.button}
                        onClick={() => importBulkRows(true)}
                        disabled={bulkUploading}
                      >
                        {bulkUploading ? "Importing…" : `Continue — import ${bulkProjectDupModal.wouldCreateCount} unique`}
                      </button>
                    ) : null}
                  </div>
                </div>
              </>
            ) : null}

            {addArticleDupModal ? (
              <>
                <button type="button" className={styles.modalBackdrop} aria-label="Close" onClick={() => setAddArticleDupModal(null)} />
                <div className={styles.modalPanel} role="dialog" aria-modal="true" aria-label="Duplicate article title" style={{ maxWidth: 480 }}>
                  <div className={styles.modalHead}>
                    <h3 className={styles.modalTitle}>Duplicate article</h3>
                    <button type="button" className={styles.btnSecondary} onClick={() => setAddArticleDupModal(null)}>
                      Close
                    </button>
                  </div>
                  <div className={styles.modalBody}>
                    <p style={{ marginTop: 0, lineHeight: 1.55 }}>{addArticleDupModal.message}</p>
                    {addArticleDupModal.duplicates.length ? (
                      <ul style={{ margin: "12px 0 0", paddingLeft: 20, lineHeight: 1.55 }}>
                        {addArticleDupModal.duplicates.map((row) => (
                          <li key={row.existing_id}>
                            Matches existing:{" "}
                            <Link className={styles.articleTitleLink} href={`/projects/${projectId}/articles/${row.existing_id}`}>
                              {row.existing_title || row.existing_id}
                            </Link>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                  <div className={styles.modalFooter}>
                    <button type="button" className={styles.button} onClick={() => setAddArticleDupModal(null)}>
                      OK
                    </button>
                  </div>
                </div>
              </>
            ) : null}

            {(postImportDupTitles && postImportDupTitles.length) || postImportProjectSkipped > 0 ? (
              <>
                <button
                  type="button"
                  className={styles.modalBackdrop}
                  aria-label="Close"
                  onClick={() => {
                    setPostImportDupTitles(null);
                    setPostImportProjectSkipped(0);
                  }}
                />
                <div className={styles.modalPanel} role="dialog" aria-modal="true" aria-label="Import summary">
                  <div className={styles.modalHead}>
                    <h3 className={styles.modalTitle}>Import summary</h3>
                    <button
                      type="button"
                      className={styles.btnSecondary}
                      onClick={() => {
                        setPostImportDupTitles(null);
                        setPostImportProjectSkipped(0);
                      }}
                    >
                      Close
                    </button>
                  </div>
                  <div className={styles.modalBody}>
                    {postImportDupTitles && postImportDupTitles.length ? (
                      <>
                        <p style={{ marginTop: 0, lineHeight: 1.55 }}>
                          Your file had more than one row with the same title (case-insensitive). Only the <strong>first</strong> row in the sheet — treated as the older entry — was imported for each duplicate name.
                        </p>
                        <p style={{ marginBottom: 6, fontWeight: 600 }}>Titles that had duplicates:</p>
                        <ul style={{ margin: 0, paddingLeft: 20, lineHeight: 1.6 }}>
                          {postImportDupTitles.map((t) => (
                            <li key={t}>{t}</li>
                          ))}
                        </ul>
                      </>
                    ) : null}
                    {postImportProjectSkipped > 0 ? (
                      <p style={{ marginTop: postImportDupTitles && postImportDupTitles.length ? 14 : 0, lineHeight: 1.55 }}>
                        <strong>{postImportProjectSkipped}</strong> row{postImportProjectSkipped === 1 ? "" : "s"} skipped because the same title already exists in this project.
                      </p>
                    ) : null}
                  </div>
                  <div className={styles.modalFooter}>
                    <button
                      type="button"
                      className={styles.button}
                      onClick={() => {
                        setPostImportDupTitles(null);
                        setPostImportProjectSkipped(0);
                      }}
                    >
                      OK
                    </button>
                  </div>
                </div>
              </>
            ) : null}
          </>
        ) : null}

        {tab === "research" ? (
          <>
            {/* Sub-tab strip — switches the Research panel between Cluster Planner
                (Feature 2) and the existing keyword-driven Custom Curations flow. */}
            <div
              className={styles.subTabs}
              role="tablist"
              aria-label="Research sub-sections"
            >
              <button
                type="button"
                role="tab"
                aria-selected={researchSubTab === "cluster"}
                className={`${styles.subTab} ${researchSubTab === "cluster" ? styles.subTabActive : ""}`}
                onClick={() => setResearchSubTab("cluster")}
              >
                Cluster Planner
                {topicClusters.length > 0 ? (
                  <span className={styles.subTabBadge}>{topicClusters.length}</span>
                ) : null}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={researchSubTab === "curations"}
                className={`${styles.subTab} ${researchSubTab === "curations" ? styles.subTabActive : ""}`}
                onClick={() => setResearchSubTab("curations")}
              >
                Custom Curations
                {researchResults.length > 0 ? (
                  <span className={styles.subTabBadge}>{researchResults.length}</span>
                ) : null}
              </button>
            </div>

            {researchSubTab === "cluster" ? (
              <>
            {/* Feature 2 — Topical Authority Cluster Mapping */}
            <div className={`${styles.card} ${styles.cardWide} ${styles.clusterPlanner}`}>
              <div className={styles.clusterPlannerHead}>
                <div style={{ minWidth: 0, flex: "1 1 320px" }}>
                  <h2 className={styles.clusterCardTitle}>Topical authority — Cluster planner</h2>
                  <p className={styles.clusterCardSubtitle}>
                    Seed intent → live Google SERP snapshot (best-effort) → one Pillar + 4–6 Cluster
                    articles. Uses the same country, language, and tone you set in Research curation
                    below.
                  </p>
                </div>
                <div className={styles.clusterPlannerActions}>
                  <button
                    type="button"
                    className={styles.miniBtn}
                    onClick={() => reloadTopicClusters()}
                    disabled={topicClustersLoading}
                  >
                    {topicClustersLoading ? "Refreshing…" : "Refresh list"}
                  </button>
                  <button
                    className={styles.button}
                    type="button"
                    disabled={
                      clusterPlanBusy ||
                      clusterPlanLimitReached ||
                      !clusterSeedIntent.trim() ||
                      clusterSeedIntent.trim().length < 3
                    }
                    title={
                      clusterPlanLimitReached
                        ? "Monthly Cluster Planner limit reached for your plan."
                        : undefined
                    }
                    onClick={() => planTopicClusterFromResearch()}
                  >
                    {clusterPlanBusy ? "Planning…" : "Plan cluster"}
                  </button>
                </div>
              </div>

              <label className={styles.label}>
                Seed intent
                <textarea
                  className={styles.textarea}
                  rows={3}
                  value={clusterSeedIntent}
                  onChange={(e) => setClusterSeedIntent(e.target.value)}
                  placeholder="e.g. Best RERA lawyers in Chandigarh for homebuyer disputes"
                />
              </label>

              {topicClustersErr ? (
                <div className={styles.error}>{topicClustersErr}</div>
              ) : null}
              {clusterPlanMsg ? (
                <div className={styles.clusterPlanFeedback}>{clusterPlanMsg}</div>
              ) : null}

              <p className={styles.clusterPlannerHint}>
                Pick the topics you want, then choose an action: <strong>Generate</strong> uses one
                credit per article, <strong>Import</strong> stages drafts in Articles for free, and
                <strong> Schedule</strong> imports + auto-publishes them to WordPress. Tick rows
                individually, or leave selection empty to act on every pending topic.
              </p>
              {featureLimits?.cluster_plans ? (
                <div className={styles.muted} style={{ fontSize: 12, marginTop: 8 }}>
                  Cluster Planner usage:{" "}
                  {featureLimits.cluster_plans.unlimited
                    ? "Unlimited for this plan"
                    : `${featureLimits.cluster_plans.month_used}/${featureLimits.cluster_plans.month_limit} used this month`}
                  .
                </div>
              ) : null}

              {topicClusters.length === 0 && !topicClustersLoading ? (
                <div className={styles.clusterEmptyHint}>
                  No saved clusters yet. Plan one above — it will appear here with a pillar plus
                  supporting topics tree.
                </div>
              ) : null}

              {topicClusters.map((cl) => {
                const serpN = cl.serp_summary?.result_count ?? 0;
                const pillarDone = !!(cl.pillar?.imported_article_id || "").trim();
                const clusterRows = cl.clusters || [];
                const clusterSlots = clusterRows.length;
                const clusterDone = clusterRows.filter(
                  (c) => !!(c.imported_article_id || "").trim(),
                ).length;
                const totalDone = (pillarDone ? 1 : 0) + clusterDone;
                const totalSlots = (clusterSlots > 0 ? clusterSlots : 0) + 1;
                const allDone = pillarDone && clusterDone === clusterSlots && clusterSlots > 0;
                const statusKey = (cl.status || "draft").toLowerCase();
                // Pull validation outcomes for this cluster's pillar + topics so we
                // can render badges and disable Generate-all if every remaining
                // (non-imported) row is a confirmed duplicate.
                const pillarValidation = clusterValidation.results[`${cl.id}::pillar`];
                const remainingValidations: typeof pillarValidation[] = [];
                if (!pillarDone && pillarValidation) remainingValidations.push(pillarValidation);
                for (const c of clusterRows) {
                  if ((c.imported_article_id || "").trim()) continue;
                  const v = clusterValidation.results[`${cl.id}::${c.id}`];
                  if (v) remainingValidations.push(v);
                }
                const allDuplicates =
                  remainingValidations.length > 0 &&
                  remainingValidations.every((v) => v && v.status === "duplicate");
                // Number of non-imported AND non-duplicate rows. This drives
                // the bulk action buttons + "X pending" copy so we never
                // promise "Import 6" when 1 of those 6 already exists on
                // the site.
                const pillarActionable =
                  !pillarDone && !(pillarValidation?.status === "duplicate");
                const clusterActionable = clusterRows.filter((c) => {
                  if ((c.imported_article_id || "").trim()) return false;
                  const v = clusterValidation.results[`${cl.id}::${c.id}`];
                  return v?.status !== "duplicate";
                }).length;
                const actionablePending =
                  (pillarActionable ? 1 : 0) + clusterActionable;
                return (
                  <div key={cl.id} className={styles.clusterRow}>
                    <div className={styles.clusterRowHead}>
                      <div className={styles.clusterRowTitleBlock}>
                        <h3 className={styles.clusterRowSeed}>{cl.seed_intent}</h3>
                        <div className={styles.clusterRowMeta}>
                          <span className={styles.clusterMetaChip}>{cl.country_code}</span>
                          <span className={styles.clusterMetaChip}>{cl.tone}</span>
                          <span
                            className={styles.clusterMetaChip}
                            data-variant={`status-${statusKey}`}
                          >
                            {statusKey.replace("_", " ")}
                          </span>
                          <span className={styles.clusterMetaChip}>
                            SERP {serpN ? `${serpN} rows` : "0 (LLM-inferred)"}
                          </span>
                          <span className={styles.clusterMetaChip}>
                            {totalDone}/{totalSlots} generated
                          </span>
                          {cl.created_at ? (
                            <span className={styles.clusterMetaChip}>{cl.created_at}</span>
                          ) : null}
                        </div>
                      </div>
                      <div className={styles.clusterRowActions}>
                        {(() => {
                          const sel = clusterSelected[cl.id] || new Set<string>();
                          const selN = sel.size;
                          const bulk =
                            clusterBulkBusy && clusterBulkBusy.clusterId === cl.id
                              ? clusterBulkBusy
                              : null;
                          const generateBusy = bulk?.kind === "generate";
                          const importBusy = bulk?.kind === "import";
                          const scheduleBusy = bulk?.kind === "schedule";
                          const anyBusy = !!bulk || clusterPlanBusy;
                          const target =
                            selN > 0
                              ? `${selN} selected`
                              : `${actionablePending} pending`;
                          const noPending = totalDone >= totalSlots;
                          // ``noActionable`` includes confirmed duplicates so we
                          // disable bulk import/schedule whenever every remaining
                          // pending row already exists in the project / on site.
                          const noActionable = actionablePending === 0 && selN === 0;
                          const generateDisabled = anyBusy || allDuplicates || noPending || noActionable;
                          return (
                            <>
                              <button
                                type="button"
                                className={styles.button}
                                disabled={generateDisabled}
                                onClick={() => generateForCluster(cl.id)}
                                title={
                                  allDuplicates
                                    ? "Every remaining topic already exists on your site or in this project."
                                    : noPending
                                      ? "Every topic in this cluster is already generated."
                                      : `Generate ${target} — uses one credit per article.`
                                }
                              >
                                {generateBusy
                                  ? "Generating…"
                                  : allDone
                                    ? "All generated"
                                    : allDuplicates
                                      ? "All duplicates"
                                      : `Generate ${selN > 0 ? "selected" : "all"}`}
                              </button>
                              <button
                                type="button"
                                className={styles.btnSecondary}
                                disabled={anyBusy || noPending || noActionable}
                                onClick={() => importForCluster(cl.id)}
                                title={
                                  noPending
                                    ? "Every topic is already imported."
                                    : noActionable
                                      ? "Every remaining topic already exists on your site or in this project."
                                      : `Import ${target} into Articles as pending drafts (no credits used).`
                                }
                              >
                                {importBusy ? "Importing…" : `Import ${selN > 0 ? "selected" : "all"}`}
                              </button>
                              <button
                                type="button"
                                className={styles.btnSecondary}
                                disabled={anyBusy || noPending || noActionable}
                                onClick={() => openScheduleForCluster(cl.id)}
                                title={
                                  noPending
                                    ? "Every topic is already imported."
                                    : noActionable
                                      ? "Every remaining topic already exists on your site or in this project."
                                      : `Import ${target} and schedule them for auto-generation + publish.`
                                }
                              >
                                {scheduleBusy ? "Scheduling…" : `Schedule ${selN > 0 ? "selected" : "all"}`}
                              </button>
                            </>
                          );
                        })()}
                      </div>
                    </div>

                    {(cl.generation_errors || []).length > 0 ? (
                      <div className={styles.clusterErrorsBox}>
                        {(cl.generation_errors || []).map((er) => (
                          <div key={`${er.topic_id}-${er.message.slice(0, 24)}`}>
                            <code>{er.topic_id}</code>
                            {er.message}
                          </div>
                        ))}
                      </div>
                    ) : null}

                    {(() => {
                      const sel = clusterSelected[cl.id] || new Set<string>();
                      const pendingTotal = totalSlots - totalDone;
                      if (pendingTotal === 0) return null;
                      // Show duplicates excluded count separately so the
                      // user understands why "X pending" might be lower
                      // than the visual list of un-imported topics.
                      const dupExcluded = pendingTotal - actionablePending;
                      return (
                        <div className={styles.clusterSelectionBar}>
                          <span className={styles.clusterSelectionCount}>
                            {sel.size > 0
                              ? `${sel.size} of ${actionablePending} selected`
                              : actionablePending > 0
                                ? `${actionablePending} pending — bulk action will use all${
                                    dupExcluded > 0
                                      ? ` (${dupExcluded} already exists)`
                                      : ""
                                  }`
                                : `0 actionable — every remaining topic already exists`}
                          </span>
                          <div className={styles.clusterSelectionLinks}>
                            <button
                              type="button"
                              className={styles.miniLinkBtn}
                              onClick={() => selectAllPendingForCluster(cl.id)}
                              disabled={
                                actionablePending === 0 ||
                                sel.size === actionablePending
                              }
                            >
                              Select all pending
                            </button>
                            <button
                              type="button"
                              className={styles.miniLinkBtn}
                              onClick={() => clearClusterSelection(cl.id)}
                              disabled={sel.size === 0}
                            >
                              Clear selection
                            </button>
                          </div>
                        </div>
                      );
                    })()}

                    <div className={styles.clusterTreeSection}>
                      <h4 className={styles.clusterTreeLabel}>Pillar article</h4>
                      {(() => {
                        const pillarSlot = (cl.pillar?.id || "pillar").trim() || "pillar";
                        const sel = clusterSelected[cl.id] || new Set<string>();
                        const checked = sel.has(pillarSlot);
                        const pillarDup = pillarValidation?.status === "duplicate";
                        const pillarMuted = !pillarDone && pillarDup;
                        return (
                          <div className={styles.clusterPillarBox}>
                            <div
                              className={styles.clusterTopicHead}
                              data-duplicate={pillarMuted ? "true" : undefined}
                            >
                              {!pillarDone && !pillarDup ? (
                                <input
                                  type="checkbox"
                                  className={styles.clusterTopicCheckbox}
                                  checked={checked}
                                  onChange={() => toggleClusterSlot(cl.id, pillarSlot)}
                                  aria-label="Select pillar article"
                                />
                              ) : null}
                              <div className={styles.clusterTopicHeadBody}>
                                <h5 className={styles.clusterTopicTitle}>
                                  {cl.pillar?.title || "(no pillar title)"}
                                </h5>
                                {cl.pillar?.intent ? (
                                  <p className={styles.clusterTopicIntent}>{cl.pillar.intent}</p>
                                ) : null}
                              </div>
                            </div>
                            <div className={styles.clusterTopicFooter}>
                              {pillarDone ? (
                                <>
                                  <span className={styles.clusterTopicPill} data-state="imported">
                                    Imported
                                  </span>
                                  <Link
                                    className={styles.clusterOpenLink}
                                    href={`/projects/${projectId}/articles/${(
                                      cl.pillar?.imported_article_id || ""
                                    ).trim()}`}
                                  >
                                    Open article →
                                  </Link>
                                </>
                              ) : (
                                <>
                                  <span className={styles.clusterTopicPill} data-state="pending">
                                    Pending generation
                                  </span>
                                  <ValidationBadge entry={pillarValidation} />
                                </>
                              )}
                            </div>
                          </div>
                        );
                      })()}
                    </div>

                    <div className={styles.clusterTreeSection}>
                      <h4 className={styles.clusterTreeLabel}>
                        Cluster articles ({clusterSlots})
                      </h4>
                      <ul className={styles.clusterTopicList}>
                        {clusterRows.map((c) => {
                          const done = !!(c.imported_article_id || "").trim();
                          const v = clusterValidation.results[`${cl.id}::${c.id}`];
                          const slotId = (c.id || "").trim() || "cluster";
                          const sel = clusterSelected[cl.id] || new Set<string>();
                          const checked = sel.has(slotId);
                          // ``isDup`` excludes already-imported rows (those
                          // already render with the green "Imported" pill +
                          // their own muted state) so we only dim NEW rows
                          // the engine confirmed already exist elsewhere.
                          const isDup = !done && v?.status === "duplicate";
                          return (
                            <li key={c.id} className={styles.clusterTopicItem}>
                              <div
                                className={styles.clusterTopicHead}
                                data-duplicate={isDup ? "true" : undefined}
                              >
                                {!done && !isDup ? (
                                  <input
                                    type="checkbox"
                                    className={styles.clusterTopicCheckbox}
                                    checked={checked}
                                    onChange={() => toggleClusterSlot(cl.id, slotId)}
                                    aria-label={`Select topic ${c.title}`}
                                  />
                                ) : null}
                                <div className={styles.clusterTopicHeadBody}>
                                  <h5 className={styles.clusterTopicTitle}>{c.title}</h5>
                                  {c.intent ? (
                                    <p className={styles.clusterTopicIntent}>{c.intent}</p>
                                  ) : null}
                                </div>
                              </div>
                              <div className={styles.clusterTopicFooter}>
                                {done ? (
                                  <>
                                    <span
                                      className={styles.clusterTopicPill}
                                      data-state="imported"
                                    >
                                      Imported
                                    </span>
                                    <Link
                                      className={styles.clusterOpenLink}
                                      href={`/projects/${projectId}/articles/${(
                                        c.imported_article_id || ""
                                      ).trim()}`}
                                    >
                                      Open article →
                                    </Link>
                                  </>
                                ) : (
                                  <>
                                    <span
                                      className={styles.clusterTopicPill}
                                      data-state="pending"
                                    >
                                      Pending
                                    </span>
                                    <ValidationBadge entry={v} />
                                  </>
                                )}
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  </div>
                );
              })}
            </div>
              </>
            ) : null}

            {researchSubTab === "curations" ? (
              <>
            <div className={`${styles.card} ${styles.cardWide}`}>
              <div className={styles.sectionHead}>
                <div>
                  <h2 className={styles.clusterCardTitle}>Curation</h2>
                  <p className={styles.clusterCardSubtitle}>
                    Fine-tune results for your brand and intent.
                  </p>
                </div>
                <button
                  className={styles.button}
                  type="button"
                  disabled={researchBusy || researchGeneratingMore || researchSeeds.length === 0 || customResearchLimitReached}
                  title={
                    customResearchLimitReached
                      ? "Monthly Custom Curations limit reached for your plan."
                      : researchSeeds.length === 0
                        ? "Add seed keywords first"
                        : undefined
                  }
                  onClick={() =>
                    runResearch({
                      mode: "replace",
                      seeds: researchSeeds,
                      brandNiche: researchBrandNiche,
                      intent: researchIntent,
                      tone: researchTone,
                      country: researchCountry,
                      language: researchLanguage,
                    })
                  }
                >
                  {researchBusy ? "Researching…" : "Run research"}
                </button>
              </div>

              <div
                style={{
                  marginTop: 12,
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                  gap: 12,
                }}
              >
                <label className={styles.label}>
                  Brand niche
                  <input className={styles.input} value={researchBrandNiche} onChange={(e) => setResearchBrandNiche(e.target.value)} placeholder="e.g. MSME legal services in India" />
                </label>

                <label className={styles.label}>
                  Article intent
                  <select className={styles.select} value={researchIntent} onChange={(e) => setResearchIntent(e.target.value as ResearchIntent)}>
                    <option value="informational">Informational</option>
                    <option value="commercial">Commercial</option>
                    <option value="transactional">Transactional</option>
                    <option value="navigational">Navigational</option>
                  </select>
                </label>

                <label className={styles.label}>
                  Article tone
                  <select className={styles.select} value={researchTone} onChange={(e) => setResearchTone(e.target.value as ResearchTone)}>
                    {RESEARCH_TONE_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className={styles.label}>
                  Country
                  <select className={styles.select} value={researchCountry} onChange={(e) => setResearchCountry(e.target.value)}>
                    {COUNTRIES.map((c) => (
                      <option key={c.code} value={c.code}>
                        {c.name} ({c.code})
                      </option>
                    ))}
                  </select>
                </label>

                <label className={styles.label}>
                  Language
                  <input className={styles.input} value={researchLanguage} onChange={(e) => setResearchLanguage(e.target.value)} placeholder="en" />
                </label>

                <div className={styles.label} style={{ gridColumn: "1 / -1" }}>
                  <span>Seed keywords/topics</span>
                  <div style={{ display: "flex", gap: 8, marginTop: 6, flexWrap: "wrap" }}>
                    <input
                      className={styles.input}
                      style={{ flex: "1 1 240px", minWidth: 200 }}
                      value={researchSeedInput}
                      onChange={(e) => setResearchSeedInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          addSeedKeywordsFromInput();
                        }
                      }}
                      placeholder="Type a seed keyword/topic and press Enter or click Add"
                    />
                    <button
                      type="button"
                      className={styles.button}
                      onClick={addSeedKeywordsFromInput}
                      disabled={!researchSeedInput.trim()}
                    >
                      Add Keywords
                    </button>
                  </div>
                  <div className={styles.muted} style={{ fontSize: 12, marginTop: 6 }}>
                    Tip: Paste comma-separated or newline-separated lists. Up to 200 seeds are saved with this project.
                  </div>
                  {researchSeeds.length ? (
                    <div style={{ marginTop: 10, display: "flex", flexWrap: "wrap", gap: 8 }}>
                      {researchSeeds.map((s, idx) => (
                        <span
                          key={`${s}-${idx}`}
                          className={styles.pill}
                          style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
                        >
                          {s}
                          <button
                            type="button"
                            aria-label={`Remove ${s}`}
                            onClick={() => removeSeedAt(idx)}
                            style={{
                              border: "none",
                              background: "transparent",
                              color: "inherit",
                              cursor: "pointer",
                              fontWeight: 900,
                              padding: 0,
                              lineHeight: 1,
                              fontSize: 14,
                            }}
                          >
                            ×
                          </button>
                        </span>
                      ))}
                      {researchSeeds.length > 1 ? (
                        <button
                          type="button"
                          className={styles.miniBtn}
                          onClick={() => {
                            if (confirm("Clear all seed keywords?")) setResearchSeeds([]);
                          }}
                        >
                          Clear all
                        </button>
                      ) : null}
                    </div>
                  ) : (
                    <div className={styles.muted} style={{ fontSize: 12, marginTop: 8 }}>
                      No seed keywords yet. Add a few to start research.
                    </div>
                  )}
                </div>
              </div>

              {researchMsg ? (
                <div className={styles.muted} style={{ marginTop: 10, whiteSpace: "pre-wrap" }}>
                  {researchMsg}
                </div>
              ) : null}
              {featureLimits?.custom_research ? (
                <div className={styles.muted} style={{ marginTop: 10, fontSize: 12 }}>
                  Custom Curations usage:{" "}
                  {featureLimits.custom_research.unlimited
                    ? "Unlimited for this plan"
                    : `${featureLimits.custom_research.month_used}/${featureLimits.custom_research.month_limit} used this month`}
                  .
                </div>
              ) : null}

              {researchKeywordAnalysis ? (
                <div style={{ marginTop: 14, borderTop: "1px solid var(--aa-hairline)", paddingTop: 14 }}>
                  <div style={{ fontWeight: 900, marginBottom: 8 }}>Keyword analysis</div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
                    <div>
                      <div className={styles.muted} style={{ fontSize: 12, marginBottom: 8 }}>
                        Primary keywords
                      </div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                        {(researchKeywordAnalysis.primary_keywords || []).length ? (
                          researchKeywordAnalysis.primary_keywords.slice(0, 24).map((k) => (
                            <span key={k} className={styles.pill}>
                              {k}
                            </span>
                          ))
                        ) : (
                          <span className={styles.muted} style={{ fontSize: 12 }}>
                            —
                          </span>
                        )}
                      </div>
                    </div>
                    <div>
                      <div className={styles.muted} style={{ fontSize: 12, marginBottom: 8 }}>
                        Supporting keywords
                      </div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                        {(researchKeywordAnalysis.supporting_keywords || []).length ? (
                          researchKeywordAnalysis.supporting_keywords.slice(0, 36).map((k) => (
                            <span key={k} className={styles.pill}>
                              {k}
                            </span>
                          ))
                        ) : (
                          <span className={styles.muted} style={{ fontSize: 12 }}>
                            —
                          </span>
                        )}
                      </div>
                    </div>
                    <div style={{ gridColumn: "1 / -1" }}>
                      <div className={styles.muted} style={{ fontSize: 12, marginBottom: 8 }}>
                        Notes
                      </div>
                      <div style={{ lineHeight: 1.55, fontSize: 13, color: "var(--aa-ink)" }}>
                        {researchKeywordAnalysis.notes || <span className={styles.muted}>—</span>}
                      </div>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>

            <div className={`${styles.card} ${styles.cardWide}`} style={{ marginTop: 14 }}>
              <div className={styles.sectionHead}>
                <div>
                  <h2 style={{ margin: 0 }}>Results</h2>
                  <div className={styles.muted}>Browse, filter, and import ideas into your Articles list.</div>
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
                  <button
                    type="button"
                    className={styles.btnSecondary}
                    disabled={researchBusy || researchGeneratingMore || researchSeeds.length === 0 || customResearchLimitReached}
                    onClick={() =>
                      runResearch({
                        mode: "append",
                        seeds: researchSeeds,
                        brandNiche: researchBrandNiche,
                        intent: researchIntent,
                        tone: researchTone,
                        country: researchCountry,
                        language: researchLanguage,
                      })
                    }
                    title={
                      customResearchLimitReached
                        ? "Monthly Custom Curations limit reached for your plan."
                        : researchSeeds.length === 0
                          ? "Add seed keywords first"
                          : "Generate more ideas using current seeds"
                    }
                  >
                    {researchGeneratingMore ? "Generating…" : "Generate more"}
                  </button>
                  <button
                    className={styles.button}
                    type="button"
                    disabled={!researchSelected.size || researchImporting}
                    onClick={() => importSelectedIdeas({ skipDuplicates: false })}
                  >
                    {researchImporting ? "Importing…" : `Import selected${researchSelected.size ? ` (${researchSelected.size})` : ""}`}
                  </button>
                </div>
              </div>

              {researchResults.length ? (
                <div style={{ marginTop: 12, display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                  {([
                    { key: "latest", label: `Latest${researchCounts.latest ? ` (${researchCounts.latest})` : ""}` },
                    { key: "not_imported", label: `Not Imported (${researchCounts.notImported})` },
                    { key: "imported", label: `Imported (${researchCounts.imported})` },
                    { key: "all", label: `All (${researchCounts.all})` },
                  ] as { key: ResearchFilter; label: string }[]).map((opt) => {
                    const active = researchFilter === opt.key;
                    return (
                      <button
                        key={opt.key}
                        type="button"
                        onClick={() => {
                          setResearchFilter(opt.key);
                          setResearchSelected(new Set());
                        }}
                        className={styles.miniBtn}
                        style={
                          active
                            ? {
                                borderColor: "var(--aa-ink)",
                                background: "var(--aa-ink)",
                                color: "var(--aa-canvas)",
                              }
                            : undefined
                        }
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                  <span className={styles.muted} style={{ fontSize: 12, marginLeft: "auto" }}>
                    Persisted locally for this project.
                  </span>
                  <button
                    type="button"
                    className={styles.miniBtn}
                    onClick={() => {
                      if (!researchResults.length) return;
                      if (confirm("Clear all saved research results for this project?")) {
                        setResearchResults([]);
                        setResearchSelected(new Set());
                        setResearchLatestRunId(null);
                      }
                    }}
                  >
                    Clear results
                  </button>
                </div>
              ) : null}

              {researchImportMsg ? (
                <div className={styles.muted} style={{ marginTop: 10, whiteSpace: "pre-wrap" }}>
                  {researchImportMsg}{" "}
                  <button type="button" className={styles.miniBtn} onClick={() => goTab("articles")}>
                    Open Articles
                  </button>
                </div>
              ) : null}

              {!researchResults.length ? <div className={styles.muted}>Run research to see results.</div> : null}

              {researchResults.length && !filteredResearchResults.length ? (
                <div className={styles.muted} style={{ marginTop: 10 }}>No ideas match this filter.</div>
              ) : null}

              {filteredResearchResults.length ? (
                <table className={styles.table} style={{ marginTop: 10 }}>
                  <thead>
                    <tr>
                      <th className={styles.th} style={{ width: 44 }}>
                        <input
                          type="checkbox"
                          checked={(() => {
                            const sel = filteredResearchResults.filter((r) => !r.imported);
                            return sel.length > 0 && sel.every((r) => researchSelected.has(r.id));
                          })()}
                          onChange={(e) => {
                            setResearchSelected((prev) => {
                              const next = new Set(prev);
                              const target = filteredResearchResults.filter((r) => !r.imported);
                              if (e.target.checked) target.forEach((r) => next.add(r.id));
                              else target.forEach((r) => next.delete(r.id));
                              return next;
                            });
                          }}
                        />
                      </th>
                      <th className={styles.th}>Title</th>
                      <th className={styles.th}>Focus keyphrase</th>
                      <th className={styles.th}>Keywords</th>
                      <th className={styles.th} style={{ width: 110 }}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredResearchResults.map((r) => (
                      <tr key={r.id} style={r.imported ? { opacity: 0.7 } : undefined}>
                        <td className={styles.td}>
                          <input
                            type="checkbox"
                            disabled={!!r.imported}
                            checked={researchSelected.has(r.id)}
                            onChange={(e) => {
                              setResearchSelected((prev) => {
                                const next = new Set(prev);
                                if (e.target.checked) next.add(r.id);
                                else next.delete(r.id);
                                return next;
                              });
                            }}
                          />
                        </td>
                        <td className={styles.td} style={{ maxWidth: 420 }}>
                          <div style={{ fontWeight: 900 }}>{r.title}</div>
                          {r.rationale ? <div className={styles.muted} style={{ fontSize: 12, marginTop: 6 }}>{r.rationale}</div> : null}
                        </td>
                        <td className={styles.td}>{r.focus_keyphrase}</td>
                        <td className={styles.td}>
                          <div className={styles.muted} style={{ fontSize: 12, lineHeight: 1.5 }}>
                            {(r.keywords || []).slice(0, 10).join(", ") || "—"}
                          </div>
                        </td>
                        <td className={styles.td}>
                          {r.imported ? (
                            <span
                              className={styles.pill}
                              style={{
                                color: "#0a7a32",
                                borderColor: "rgba(10, 122, 50, 0.35)",
                                background: "rgba(10, 122, 50, 0.08)",
                                fontWeight: 800,
                              }}
                            >
                              Imported
                            </span>
                          ) : (
                            <span className={styles.muted} style={{ fontSize: 12 }}>Not imported</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : null}
            </div>

            {researchImportDupModal ? (
              <>
                <button type="button" className={styles.modalBackdrop} aria-label="Close" onClick={() => setResearchImportDupModal(null)} />
                <div className={styles.modalPanel} role="dialog" aria-modal="true" aria-label="Duplicate articles detected" style={{ maxWidth: 520 }}>
                  <div className={styles.modalHead}>
                    <h3 className={styles.modalTitle}>Duplicate articles detected</h3>
                    <button type="button" className={styles.btnSecondary} onClick={() => setResearchImportDupModal(null)}>
                      Close
                    </button>
                  </div>
                  <div className={styles.modalBody}>
                    <p style={{ marginTop: 0, lineHeight: 1.55 }}>
                      Some selected titles already exist in this project (comparison is not case-sensitive). You can skip duplicates and import only unique rows.
                    </p>
                    <div className={styles.muted} style={{ fontSize: 12, lineHeight: 1.55 }}>
                      Conflicts: <b>{researchImportDupModal.projectDuplicates.length}</b> · Would create: <b>{researchImportDupModal.wouldCreateCount}</b>
                    </div>
                    {researchImportDupModal.projectDuplicates.length ? (
                      <div style={{ marginTop: 10 }}>
                        <div className={styles.muted} style={{ fontSize: 12, marginBottom: 6 }}>
                          Conflicting titles
                        </div>
                        <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.55 }}>
                          {researchImportDupModal.projectDuplicates.slice(0, 25).map((row) => (
                            <li key={`${row.submitted_title}:${row.existing_id}`}>
                              <span style={{ fontWeight: 800 }}>{row.submitted_title}</span>{" "}
                              <span className={styles.muted} style={{ fontSize: 12 }}>
                                (existing: {row.existing_title})
                              </span>
                            </li>
                          ))}
                        </ul>
                        {researchImportDupModal.projectDuplicates.length > 25 ? (
                          <div className={styles.muted} style={{ marginTop: 8, fontSize: 12 }}>
                            Showing first 25 conflicts.
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                  <div className={styles.modalFooter}>
                    <button type="button" className={styles.btnSecondary} onClick={() => setResearchImportDupModal(null)} disabled={researchImporting}>
                      Cancel
                    </button>
                    <button
                      type="button"
                      className={styles.button}
                      disabled={researchImporting}
                      onClick={() => importSelectedIdeas({ skipDuplicates: true })}
                    >
                      Import unique only
                    </button>
                  </div>
                </div>
              </>
            ) : null}
              </>
            ) : null}
          </>
        ) : null}

        {tab === "scheduled_articles" ? (
          <>
            <div className={`${styles.card} ${styles.cardWide}`}>
              <div className={styles.scheduledHeadRow}>
                <div className={styles.scheduledHeadFilters}>
                  <label className={styles.label} style={{ margin: 0 }}>
                    Order
                    <select className={styles.input} value={scheduledOrder} onChange={(e) => setScheduledOrder(e.target.value as "asc" | "desc")}>
                      <option value="desc">Latest → Oldest</option>
                      <option value="asc">Oldest → Latest</option>
                    </select>
                  </label>
                  <label className={styles.label} style={{ margin: 0 }}>
                    Search
                    <input
                      className={styles.input}
                      value={scheduledSearch}
                      onChange={(e) => setScheduledSearch(e.target.value)}
                      placeholder="Search by article title…"
                    />
                  </label>
                </div>
                <div className={styles.scheduledHeadActions}>
                  <button
                    type="button"
                    className={styles.iconButton}
                    aria-label="Refresh scheduled articles"
                    onClick={async () => {
                      setScheduledLoading(true);
                      try {
                        setScheduledJobs(dedupeScheduledJobs(await api.listScheduledJobs(projectId)));
                      } finally {
                        setScheduledLoading(false);
                      }
                    }}
                  >
                    <Icon.Refresh className={styles.icon20} />
                  </button>
                </div>
              </div>

              {scheduledLoading ? <div className={styles.muted}>Loading…</div> : null}
              {error ? <p className={styles.error}>{error}</p> : null}
            </div>

            <div className={`${styles.card} ${styles.cardWide}`} style={{ padding: 0 }}>
              <div style={{ display: "flex", gap: 12, alignItems: "center", padding: "12px 14px", borderBottom: "1px solid var(--button-secondary-border)" }}>
                <div style={{ fontSize: 12, color: "#666" }}>Article</div>
                <div style={{ marginLeft: "auto", fontSize: 12, color: "#666" }}>Schedule</div>
              </div>

              {scheduledVisible.length === 0 && !scheduledLoading ? (
                <div style={{ padding: 14, color: "#666" }}>No scheduled articles yet.</div>
              ) : null}

              {scheduledVisible.map((j) => {
                const jobState = (j.state || "").toLowerCase();
                const canPostNow = !["posted", "cancelled", "posting"].includes(jobState);
                return (
                <div key={j.id} className={styles.scheduledRow}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <Link
                      href={`/projects/${projectId}/articles/${j.article_id}`}
                      className={styles.articleTitleLink}
                    >
                      {articles.find((a) => a.id === j.article_id)?.title || "(Untitled article)"}
                    </Link>
                    <div className={styles.scheduledActions}>
                      <button
                        type="button"
                        className={styles.miniBtn}
                        onClick={() => {
                          setError(null);
                          setConfirmPostNowJob(j);
                        }}
                        disabled={!canPostNow}
                        title={canPostNow ? "Publish to WordPress now" : "Not available while posting or after posted/cancelled"}
                      >
                        Post Now
                      </button>
                      <button
                        type="button"
                        className={styles.miniBtn}
                        onClick={() => {
                          const min = new Date(Date.now() + 5 * 60 * 1000);
                          setEditJobMin(toDatetimeLocalFromDateInProfileTz(min));
                          setEditJob(j);
                          // Show schedule time in the user's profile timezone
                          setEditJobWhen(toDatetimeLocalInProfileTz(j.run_at || ""));
                          setEditJobPostType(j.post_type || "posts");
                          setEditJobStatus(((j.wp_status || "draft") as "draft" | "publish"));
                          setEditJobCats(j.category_ids || []);
                        }}
                        disabled={["posted", "cancelled"].includes((j.state || "").toLowerCase())}
                      >
                        Re-Schedule
                      </button>
                      <button
                        type="button"
                        className={`${styles.miniBtn} ${styles.miniDanger}`}
                        onClick={async () => {
                          setConfirmCancelJob(j);
                        }}
                        disabled={["posted", "cancelled"].includes((j.state || "").toLowerCase())}
                      >
                        Cancel
                      </button>
                      {j.wp_link ? (
                        <a className={styles.miniBtn} href={j.wp_link} target="_blank" rel="noreferrer">
                          View on WordPress
                        </a>
                      ) : null}
                    </div>
                    {j.last_error ? <div style={{ marginTop: 6, fontSize: 12, color: "#ff4d4f" }}>{j.last_error}</div> : null}
                  </div>

                  <div className={styles.scheduledMeta}>
                    <div className={styles.scheduledMetaGrid}>
                      <div className={styles.scheduledMetaItem}>
                        <span className={styles.scheduledMetaLabel}>Time</span>
                        <span className={styles.scheduledMetaValue}>{formatInProfileTz(j.run_at)}</span>
                      </div>
                      <div className={styles.scheduledMetaItem}>
                        <span className={styles.scheduledMetaLabel}>Type</span>
                        <span className={styles.scheduledMetaValue}>{j.post_type || "posts"}</span>
                      </div>
                      <div className={styles.scheduledMetaItem}>
                        <span className={styles.scheduledMetaLabel}>WP</span>
                        <span className={styles.scheduledMetaValue}>{j.wp_status || "draft"}</span>
                      </div>
                    </div>
                    <span className={styles.statusPill}>{jobStateLabel(j.state)}</span>
                  </div>
                </div>
                );
              })}
            </div>

            {editJob ? (
              <div className={styles.modalBackdrop} role="dialog" aria-modal="true" aria-label="Re-schedule article">
                <div className={styles.modalPanel}>
                  <div className={styles.modalHead}>
                    <h3 className={styles.modalTitle}>Re-schedule article</h3>
                    <button type="button" className={styles.btnSecondary} onClick={() => setEditJob(null)}>
                      Close
                    </button>
                  </div>
                  <div className={styles.modalBody}>
                    <label className={styles.label}>
                      Schedule time {profileTz ? <span className={styles.muted}>(Timezone: {profileTz})</span> : null}
                      <input
                        className={styles.input}
                        type="datetime-local"
                        value={editJobWhen}
                        min={editJobMin || undefined}
                        step={60}
                        onChange={(e) => setEditJobWhen(e.target.value)}
                      />
                    </label>
                    <label className={styles.label}>
                      WordPress post type
                      <select className={styles.input} value={editJobPostType} onChange={(e) => setEditJobPostType(e.target.value)}>
                        <option value="posts">Posts</option>
                        <option value="pages">Pages</option>
                        {wpTypesForSchedule
                          .filter((t) => t.rest_base && !["posts", "pages"].includes(t.rest_base))
                          .map((t) => (
                            <option key={t.rest_base} value={t.rest_base}>
                              {t.name || t.rest_base}
                            </option>
                          ))}
                      </select>
                    </label>
                    <label className={styles.label}>
                      WordPress status
                      <select className={styles.input} value={editJobStatus} onChange={(e) => setEditJobStatus(e.target.value as "draft" | "publish")}>
                        <option value="draft">Draft</option>
                        <option value="publish">Publish</option>
                      </select>
                    </label>
                    <label className={styles.label}>
                      Categories
                      <select
                        className={styles.input}
                        multiple
                        value={editJobCats.map(String)}
                        onChange={(e) => {
                          const ids = Array.from(e.target.selectedOptions).map((o) => Number(o.value)).filter((n) => Number.isFinite(n));
                          setEditJobCats(ids);
                        }}
                        style={{ minHeight: 120 }}
                      >
                        {wpCatsForSchedule.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                      <div className={styles.muted} style={{ fontSize: 12, marginTop: 6 }}>
                        Hold Cmd/Ctrl to select multiple categories.
                      </div>
                    </label>
                    {error ? <p className={styles.error}>{error}</p> : null}
                  </div>
                  <div className={styles.modalFooter}>
                    <button type="button" className={styles.btnSecondary} onClick={() => setEditJob(null)}>
                      Cancel
                    </button>
                    <button
                      type="button"
                      className={styles.button}
                      onClick={async () => {
                        try {
                          setError(null);
                          if (!editJobWhen.trim()) throw new Error("Invalid schedule time");
                          await api.updateScheduledJob(projectId, editJob.id, {
                            // Backend interprets this as local time in the user's profile timezone and stores UTC.
                            run_at: editJobWhen,
                            post_type: editJobPostType,
                            wp_status: editJobStatus,
                            category_ids: editJobCats,
                          });
                          setScheduledJobs(dedupeScheduledJobs(await api.listScheduledJobs(projectId)));
                          setEditJob(null);
                        } catch (e) {
                          setError(e instanceof Error ? e.message : "Failed to update schedule");
                        }
                      }}
                    >
                      Save changes
                    </button>
                  </div>
                </div>
              </div>
            ) : null}

            {confirmPostNowJob ? (
              <div className={styles.modalBackdrop} role="dialog" aria-modal="true" aria-label="Post now">
                <div className={styles.modalPanel}>
                  <div className={styles.modalHead}>
                    <h3 className={styles.modalTitle}>Post now</h3>
                    <button type="button" className={styles.btnSecondary} onClick={() => setConfirmPostNowJob(null)} disabled={postNowBusy}>
                      Close
                    </button>
                  </div>
                  <div className={styles.modalBody}>
                    <p style={{ marginTop: 0 }}>
                      Are you sure you want to post it now? With this, the post will be published to the website now.
                    </p>
                    <div className={styles.muted} style={{ fontSize: 12 }}>
                      {articles.find((a) => a.id === confirmPostNowJob.article_id)?.title || "(Untitled article)"}
                    </div>
                    {error ? <p className={styles.error} style={{ marginTop: 10 }}>{error}</p> : null}
                  </div>
                  <div className={styles.modalFooter}>
                    <button type="button" className={styles.btnSecondary} onClick={() => setConfirmPostNowJob(null)} disabled={postNowBusy}>
                      No
                    </button>
                    <button type="button" className={styles.button} onClick={postNowFromScheduledJob} disabled={postNowBusy}>
                      {postNowBusy ? "Publishing…" : "Yes, post now"}
                    </button>
                  </div>
                </div>
              </div>
            ) : null}

            {confirmCancelJob ? (
              <div className={styles.modalBackdrop} role="dialog" aria-modal="true" aria-label="Cancel scheduled article">
                <div className={styles.modalPanel}>
                  <div className={styles.modalHead}>
                    <h3 className={styles.modalTitle}>Cancel scheduled article</h3>
                    <button type="button" className={styles.btnSecondary} onClick={() => setConfirmCancelJob(null)}>
                      Close
                    </button>
                  </div>
                  <div className={styles.modalBody}>
                    <p style={{ marginTop: 0 }}>
                      Are you sure you want to cancel this scheduled post?
                    </p>
                    <div className={styles.muted} style={{ fontSize: 12 }}>
                      {articles.find((a) => a.id === confirmCancelJob.article_id)?.title || "(Untitled article)"}
                    </div>
                  </div>
                  <div className={styles.modalFooter}>
                    <button type="button" className={styles.btnSecondary} onClick={() => setConfirmCancelJob(null)}>
                      Keep scheduled
                    </button>
                    <button
                      type="button"
                      className={`${styles.button} ${styles.miniDanger}`}
                      onClick={async () => {
                        try {
                          setError(null);
                          await api.cancelScheduledJob(projectId, confirmCancelJob.id);
                          setScheduledJobs(dedupeScheduledJobs(await api.listScheduledJobs(projectId)));
                          setConfirmCancelJob(null);
                        } catch (e) {
                          setError(e instanceof Error ? e.message : "Failed to cancel scheduled job");
                        }
                      }}
                    >
                      Yes, cancel
                    </button>
                  </div>
                </div>
              </div>
            ) : null}

          </>
        ) : null}

        {tab === "configuration" ? (
          <div className={`${styles.card} ${styles.cardWide}`}>
            <h2 className={styles.clusterCardTitle}>Configuration</h2>
            <p className={styles.clusterCardSubtitle}>
              WordPress defaults, featured-image settings, and Search Console wiring live in
              <strong> Project Settings</strong> and <strong>Tools</strong> for now. We&apos;ll move
              the most-used controls back here once the dedicated form lands.
            </p>
          </div>
        ) : null}

        {tab === "prompts" ? (
          <>
            <div className={`${styles.card} ${styles.cardWide}`}>
              <div className={styles.projectCardTop}>
                <div>
                  <h2 className={styles.clusterCardTitle}>Prompts</h2>
                  <p className={styles.clusterCardSubtitle}>
                    Manage writing prompts and image prompts. Set the defaults used by generation
                    and scheduling — individual articles can override them anytime.
                  </p>
                </div>
                <button className={styles.button} type="button" onClick={savePrompts} disabled={promptsSaving || promptsLoading}>
                  {promptsSaving ? "Saving…" : "Save changes"}
                </button>
              </div>
              {promptsLoading ? <div className={styles.muted}>Loading prompts…</div> : null}
              {error ? <p className={styles.error}>{error}</p> : null}
            </div>

            <div className={styles.twoCol}>
              <div className={`${styles.card} ${styles.cardWide}`}>
                <div className={styles.projectCardTop}>
                  <h3 className={styles.clusterTreeLabel}>Article writing prompts</h3>
                  <button className={styles.btnSecondary} type="button" onClick={() => startAddPrompt("writing")}>
                    + Add new
                  </button>
                </div>
                <div className={styles.clusterCardSubtitle} style={{ fontSize: 12.5 }}>
                  Default is used when you generate or schedule unless you override on the article.
                </div>

                <div className={styles.list}>
                  {wpDrafts.length === 0 ? <div className={styles.muted}>No writing prompts yet.</div> : null}
                  {wpDrafts.map((p) => (
                    <div key={p.id} className={styles.listItem}>
                      <div className={styles.listItemTop}>
                        <div style={{ fontWeight: 900 }}>{p.name || "(Untitled prompt)"}</div>
                        <div className={styles.row}>
                          <button className={styles.miniBtn} type="button" onClick={() => openPromptModal("writing", p.id)}>
                            Edit
                          </button>
                          <button className={`${styles.miniBtn} ${styles.miniDanger}`} type="button" onClick={() => markDeletePrompt("writing", p.id)}>
                            Delete
                          </button>
                        </div>
                      </div>
                      <div className={styles.checkboxRow}>
                        <input
                          type="radio"
                          name="wp-default"
                          checked={wpDefault === p.id}
                          onChange={() => setWpDefault(p.id)}
                        />
                        Set as default
                      </div>
                      <div className={styles.monoSmall}>{(p.text || "").slice(0, 240)}{(p.text || "").length > 240 ? "…" : ""}</div>
                    </div>
                  ))}
                </div>
              </div>

              <div className={`${styles.card} ${styles.cardWide}`}>
                <div className={styles.projectCardTop}>
                  <h3 className={styles.clusterTreeLabel}>Image prompts</h3>
                  <button className={styles.btnSecondary} type="button" onClick={() => startAddPrompt("image")}>
                    + Add new
                  </button>
                </div>
                <div className={styles.clusterCardSubtitle} style={{ fontSize: 12.5 }}>
                  Default is used when generating featured images unless overridden.
                </div>

                <div className={styles.list}>
                  {ipDrafts.length === 0 ? <div className={styles.muted}>No image prompts yet.</div> : null}
                  {ipDrafts.map((p) => (
                    <div key={p.id} className={styles.listItem}>
                      <div className={styles.listItemTop}>
                        <div style={{ fontWeight: 900 }}>{p.name || "(Untitled prompt)"}</div>
                        <div className={styles.row}>
                          <button className={styles.miniBtn} type="button" onClick={() => openPromptModal("image", p.id)}>
                            Edit
                          </button>
                          <button className={`${styles.miniBtn} ${styles.miniDanger}`} type="button" onClick={() => markDeletePrompt("image", p.id)}>
                            Delete
                          </button>
                        </div>
                      </div>
                      <div className={styles.checkboxRow}>
                        <input
                          type="radio"
                          name="ip-default"
                          checked={ipDefault === p.id}
                          onChange={() => setIpDefault(p.id)}
                        />
                        Set as default
                      </div>
                      <div className={styles.monoSmall}>{(p.text || "").slice(0, 240)}{(p.text || "").length > 240 ? "…" : ""}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {showPromptModal ? (
              <>
                <button type="button" className={styles.modalBackdrop} aria-label="Close" onClick={() => setShowPromptModal(null)} />
                <div className={styles.modalPanel} role="dialog" aria-modal="true" aria-label="Edit prompt">
                  <div className={styles.modalHead}>
                    <h3 className={styles.modalTitle}>
                      {showPromptModal.kind === "writing" ? "Article writing prompt" : "Image prompt"}
                    </h3>
                    <button type="button" className={styles.btnSecondary} onClick={() => setShowPromptModal(null)}>
                      Close
                    </button>
                  </div>
                  <div className={styles.modalBody}>
                    <label className={styles.label}>
                      Prompt name
                      <input className={styles.input} value={draftName} onChange={(e) => setDraftName(e.target.value)} />
                    </label>
                    <label className={styles.label}>
                      Actual prompt
                      <textarea className={styles.textarea} style={{ minHeight: 240 }} value={draftText} onChange={(e) => setDraftText(e.target.value)} />
                    </label>
                    <label className={styles.checkboxRow}>
                      <input
                        type="checkbox"
                        checked={draftSetDefault}
                        onChange={(e) => setDraftSetDefault(e.target.checked)}
                      />
                      Set as default for this project
                    </label>
                  </div>
                  <div className={styles.modalFooter}>
                    <button type="button" className={styles.btnSecondary} onClick={() => setShowPromptModal(null)}>
                      Cancel
                    </button>
                    <button
                      className={styles.button}
                      type="button"
                      onClick={() => {
                        const { kind, id } = showPromptModal;
                        if (kind === "writing") {
                          setWpDrafts((prev) => prev.map((x) => (x.id === id ? { ...x, name: draftName, text: draftText } : x)));
                          if (draftSetDefault) setWpDefault(id);
                        } else {
                          setIpDrafts((prev) => prev.map((x) => (x.id === id ? { ...x, name: draftName, text: draftText } : x)));
                          if (draftSetDefault) setIpDefault(id);
                        }
                        setShowPromptModal(null);
                      }}
                      disabled={!draftName.trim() || !draftText.trim()}
                    >
                      Save prompt
                    </button>
                  </div>
                </div>
              </>
            ) : null}
          </>
        ) : null}

        {tab === "context_links" ? (
          <>
            <div className={`${styles.card} ${styles.cardWide}`}>
              <div className={styles.projectCardTop}>
                <div>
                  <h2 className={styles.clusterCardTitle}>Context links</h2>
                  <p className={styles.clusterCardSubtitle}>
                    Add exact phrases with target URLs. When an article publishes to WordPress,
                    every match is linked on the live site (case-insensitive).
                  </p>
                </div>
                <div className={styles.row} style={{ justifyContent: "flex-end" }}>
                  <button
                    className={styles.btnSecondary}
                    type="button"
                    onClick={startAddLink}
                    disabled={linksLoading || linksSaving || contextLinkLimitReached}
                    title={
                      contextLinkLimitReached
                        ? "Context link limit reached for your plan."
                        : undefined
                    }
                  >
                    + Add link
                  </button>
                  <button className={styles.button} type="button" onClick={saveContextLinks} disabled={linksLoading || linksSaving}>
                    {linksSaving ? "Saving…" : "Save changes"}
                  </button>
                </div>
              </div>
              {linksLoading ? <div className={styles.muted}>Loading links…</div> : null}
              {featureLimits?.context_links ? (
                <div className={styles.muted} style={{ marginTop: 10, fontSize: 12 }}>
                  Context links:{" "}
                  {featureLimits.context_links.unlimited
                    ? `${linkDrafts.length} added (unlimited for this plan)`
                    : `${linkDrafts.length}/${featureLimits.context_links.limit} used`}
                  .
                </div>
              ) : null}
              {error ? <p className={styles.error}>{error}</p> : null}
            </div>

            {(() => {
              const qn = linkSearch.trim().toLowerCase();
              const filtered = qn
                ? linkDrafts.filter((x) => (x.label || "").toLowerCase().includes(qn) || (x.url || "").toLowerCase().includes(qn))
                : linkDrafts;
              const pageSize = 10;
              const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
              const pageClamped = Math.min(Math.max(1, linkPage), totalPages);
              const pageItems = filtered.slice((pageClamped - 1) * pageSize, pageClamped * pageSize);

              return (
                <>
                  <div className={`${styles.card} ${styles.cardWide}`}>
                    <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
                      <label className={styles.label} style={{ flex: 1, minWidth: 280 }}>
                        Search
                        <input
                          className={styles.input}
                          value={linkSearch}
                          onChange={(e) => {
                            setLinkSearch(e.target.value);
                            setLinkPage(1);
                          }}
                          placeholder="Search exact phrase or link…"
                        />
                      </label>
                      <div className={styles.muted} style={{ fontSize: 12, paddingBottom: 10 }}>
                        {filtered.length} link(s)
                      </div>
                    </div>
                  </div>

                  <div className={`${styles.card} ${styles.cardWide}`}>
                    <table className={styles.table}>
                      <thead>
                        <tr>
                          <th className={styles.th}>Exact phrase</th>
                          <th className={styles.th}>Link</th>
                          <th className={styles.th}>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {pageItems.map((x) => (
                          <tr key={x.id}>
                            <td className={styles.td}>{x.label || "—"}</td>
                            <td className={`${styles.td} ${styles.tdMuted}`}>{x.url}</td>
                            <td className={styles.td}>
                              <div className={styles.row}>
                                <button className={styles.miniBtn} type="button" onClick={() => openLinkModal(x.id)}>
                                  Edit
                                </button>
                                <button className={`${styles.miniBtn} ${styles.miniDanger}`} type="button" onClick={() => markDeleteLink(x.id)}>
                                  Delete
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                        {pageItems.length === 0 ? (
                          <tr>
                            <td className={styles.td} colSpan={3}>
                              <span className={styles.muted}>No context links match your search.</span>
                            </td>
                          </tr>
                        ) : null}
                      </tbody>
                    </table>
                  </div>

                  <div className={`${styles.card} ${styles.cardWide}`}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <button
                        className={styles.button}
                        type="button"
                        onClick={() => setLinkPage((p) => Math.max(1, p - 1))}
                        disabled={pageClamped <= 1}
                      >
                        Prev
                      </button>
                      <span className={styles.muted} style={{ fontSize: 13 }}>
                        Page {pageClamped} / {totalPages}
                      </span>
                      <button
                        className={styles.button}
                        type="button"
                        onClick={() => setLinkPage((p) => Math.min(totalPages, p + 1))}
                        disabled={pageClamped >= totalPages}
                      >
                        Next
                      </button>
                    </div>
                  </div>
                </>
              );
            })()}

            {showLinkModal ? (
              <>
                <button type="button" className={styles.modalBackdrop} aria-label="Close" onClick={() => setShowLinkModal(null)} />
                <div className={styles.modalPanel} role="dialog" aria-modal="true" aria-label="Context link">
                  <div className={styles.modalHead}>
                    <h3 className={styles.modalTitle}>Add / edit context link</h3>
                    <button type="button" className={styles.btnSecondary} onClick={() => setShowLinkModal(null)}>
                      Close
                    </button>
                  </div>
                  <div className={styles.modalBody}>
                    <label className={styles.label}>
                      Exact phrase
                      <input className={styles.input} value={linkPhrase} onChange={(e) => setLinkPhrase(e.target.value)} placeholder="e.g. Supreme Court Lawyers in Chandigarh" />
                    </label>
                    <label className={styles.label}>
                      Link
                      <input className={styles.input} value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} placeholder="https://example.com/page" />
                    </label>
                    <div className={styles.muted} style={{ fontSize: 12 }}>
                      Matching is case-insensitive. We’ll link the visible phrase text as it appears in the article.
                    </div>
                  </div>
                  <div className={styles.modalFooter}>
                    <button type="button" className={styles.btnSecondary} onClick={() => setShowLinkModal(null)}>
                      Cancel
                    </button>
                    <button
                      className={styles.button}
                      type="button"
                      onClick={() => {
                        const id = showLinkModal.id;
                        setLinkDrafts((prev) => prev.map((d) => (d.id === id ? { ...d, label: linkPhrase, url: linkUrl } : d)));
                        setShowLinkModal(null);
                      }}
                      disabled={!linkPhrase.trim() || !linkUrl.trim()}
                    >
                      Save link
                    </button>
                  </div>
                </div>
              </>
            ) : null}
          </>
        ) : null}

        {tab === "tools" ? (
          <>
            <div className={`${styles.card} ${styles.cardWide}`}>
              <h2 className={styles.clusterCardTitle} style={{ marginTop: 0 }}>Search Console</h2>
              <p className={styles.clusterCardSubtitle}>
                Connect this project to its own Google account and Search Console property. After a
                live publish we automatically request indexing for the post URL — and each project
                can use a different Google account.
              </p>

              {gscMsg ? <div className={styles.error} style={{ marginTop: 10 }}>{gscMsg}</div> : null}
              {gscOpenedFromOAuth && gscStatus?.connected ? (
                <div className={styles.muted} style={{ marginTop: 10, fontWeight: 700, color: "var(--success-text, #2f7d32)" }}>
                  Connected{gscStatus?.email ? ` (${gscStatus.email})` : ""}.
                </div>
              ) : null}

              <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: "1fr auto", gap: 12, alignItems: "center" }}>
                <div>
                  <div style={{ fontWeight: 800 }}>
                    {gscLoading
                      ? "Loading…"
                      : gscApiUnavailable
                      ? "Backend update required"
                      : gscStatus?.connected
                      ? `Connected${gscStatus.email ? ` (${gscStatus.email})` : ""}`
                      : "Not connected"}
                  </div>
                  <div className={styles.muted} style={{ fontSize: 12, marginTop: 4 }}>
                    {gscApiUnavailable
                      ? "The deployed backend doesn’t expose /api/projects/:id/gsc/* yet. Pull the latest code on the VPS and restart the backend (Docker: docker compose up -d --build backend; systemd: sudo systemctl restart auto-articles-backend)."
                      : gscStatus?.configured
                      ? gscStatus?.connected
                        ? `Linked${gscStatus.connected_at ? ` on ${gscStatus.connected_at} UTC` : ""}.`
                        : "Click Connect Google to authorize Search Console for this project."
                      : "Google OAuth client is not configured on the server. Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in the backend env, then restart the FastAPI service. Verify by curl-ing /api/health — gsc_oauth_configured should be true."}
                  </div>
                </div>
                <div className={styles.row} style={{ gap: 8 }}>
                  {gscStatus?.connected ? (
                    <button
                      type="button"
                      className={styles.btnSecondary}
                      onClick={() => setGscConfirmDisconnect(true)}
                      disabled={gscDisconnecting}
                    >
                      {gscDisconnecting ? "Disconnecting…" : "Disconnect"}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className={styles.button}
                    onClick={connectGscForProject}
                    disabled={
                      gscConnecting ||
                      gscApiUnavailable ||
                      // Hide-disable when backend explicitly reports configured=false.
                      gscStatus?.configured === false
                    }
                    title={
                      gscApiUnavailable
                        ? "Redeploy the backend to enable per-project Search Console connections."
                        : gscStatus?.configured === false
                        ? "Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in the backend env, then restart the FastAPI service."
                        : undefined
                    }
                  >
                    {gscConnecting
                      ? "Opening Google…"
                      : gscStatus?.connected
                      ? "Reconnect"
                      : "Connect Google"}
                  </button>
                </div>
              </div>

              <div style={{ marginTop: 18 }}>
                <label className={styles.label}>
                  Property for this project
                  <select
                    className={styles.input}
                    value={sGscPropertyUrl}
                    onChange={(e) => setSGscPropertyUrl(e.target.value)}
                    disabled={!gscStatus?.connected}
                  >
                    <option value="">— None —</option>
                    {gscSites.map((s) => (
                      <option key={s.siteUrl} value={s.siteUrl}>
                        {s.siteUrl}
                        {s.permissionLevel ? ` (${s.permissionLevel})` : ""}
                      </option>
                    ))}
                  </select>
                  {!gscStatus?.connected ? (
                    <div className={styles.muted} style={{ fontSize: 12, marginTop: 6 }}>
                      Connect Google for this project first.
                    </div>
                  ) : gscSites.length === 0 ? (
                    <div className={styles.muted} style={{ fontSize: 12, marginTop: 6 }}>
                      No properties available. Add/verify a Search Console property under this Google account, then click Reconnect.
                    </div>
                  ) : null}
                </label>

                <label className={styles.label} style={{ marginTop: 12 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <input
                      type="checkbox"
                      checked={sGscIndexOnPublish}
                      onChange={(e) => setSGscIndexOnPublish(e.target.checked)}
                      disabled={!gscStatus?.connected}
                    />
                    <span>Submit URL to Google for indexing automatically after a live publish</span>
                  </div>
                </label>

                <div className={styles.row} style={{ gap: 8, marginTop: 12, justifyContent: "flex-end" }}>
                  <button
                    type="button"
                    className={styles.button}
                    onClick={() => saveGscPropertyForProject(sGscPropertyUrl, sGscIndexOnPublish)}
                    disabled={!gscStatus?.connected}
                  >
                    Save
                  </button>
                </div>

                {gscSaveMsg ? (
                  <div className={styles.muted} style={{ fontSize: 13, marginTop: 8 }}>
                    {gscSaveMsg}
                  </div>
                ) : null}
              </div>
            </div>

            {gscStatus?.connected && (gscStatus?.property_url || "").trim() ? (
              <>
                {/* Feature 1 — GSC ROI summary (full chart lives on Performance & Analysis tab) */}
                <div className={`${styles.card} ${styles.cardWide}`} style={{ marginTop: 14 }}>
                  <div className={styles.row} style={{ justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                    <h3 style={{ marginTop: 0, marginBottom: 0 }} className={`${styles.sectionSecondaryTitle}`}>Performance summary (last 28 days)</h3>
                    {performanceTabAvailable ? (
                      <button type="button" className={styles.button} onClick={() => goTab("performance")}>
                        Open Performance & Analysis →
                      </button>
                    ) : null}
                  </div>

                  {analyticsErr ? (
                    <div className={styles.error} style={{ marginTop: 10 }}>{analyticsErr}</div>
                  ) : analyticsBusy && !analytics ? (
                    <div className={styles.muted} style={{ fontSize: 13, marginTop: 10 }}>
                      Loading Search Console data…
                    </div>
                  ) : analytics ? (
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
                        gap: 12,
                        marginTop: 14,
                      }}
                    >
                      <div className={styles.kpiTile}>
                        <div className={styles.kpiLabel}>Clicks</div>
                        <div className={styles.kpiValue}>{(analytics.totals.clicks || 0).toLocaleString()}</div>
                      </div>
                      <div className={styles.kpiTile}>
                        <div className={styles.kpiLabel}>Impressions</div>
                        <div className={styles.kpiValue}>{(analytics.totals.impressions || 0).toLocaleString()}</div>
                      </div>
                      <div className={styles.kpiTile}>
                        <div className={styles.kpiLabel}>Avg CTR</div>
                        <div className={styles.kpiValue}>{((analytics.totals.ctr || 0) * 100).toFixed(2)}%</div>
                      </div>
                      <div className={styles.kpiTile}>
                        <div className={styles.kpiLabel}>Avg position</div>
                        <div className={styles.kpiValue}>{(analytics.totals.position || 0).toFixed(1)}</div>
                      </div>
                    </div>
                  ) : null}
                </div>

                {/* Feature 3 — Site Map (Internal Linking ingestion) */}
                <div className={`${styles.card} ${styles.cardWide}`} style={{ marginTop: 14 }}>
                  <div className={styles.row} style={{ justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                    <h3 style={{ marginTop: 0, marginBottom: 0 }} className={`${styles.sectionSecondaryTitle}`}>Internal linking — Site map</h3>
                    <button type="button" className={styles.button} onClick={syncSiteMap} disabled={siteMapBusy}>
                      {siteMapBusy ? "Syncing…" : "Sync from WordPress"}
                    </button>
                  </div>
                  <div className={styles.muted} style={{ fontSize: 12, marginTop: 6, lineHeight: 1.5 }}>
                    Riviso pulls every published post from your WordPress REST API and stores
                    <code> URL · title · focus keyphrase</code>. New articles will use this list to auto-insert
                    contextual <code>&lt;a&gt;</code> tags before posting (matching engine ships in the next iteration —
                    today this card mirrors the data so you can verify nothing&apos;s stale).
                  </div>
                  {siteMapMsg ? (
                    <div className={styles.muted} style={{ fontSize: 13, marginTop: 8 }}>{siteMapMsg}</div>
                  ) : null}
                  <div className={styles.muted} style={{ fontSize: 13, marginTop: 10 }}>
                    {siteMap
                      ? `Stored: ${siteMap.count} post${siteMap.count === 1 ? "" : "s"}` + (siteMap.wp_site_url ? ` from ${siteMap.wp_site_url}` : "")
                      : "Site map not synced yet."}
                  </div>
                </div>

                <div className={`${styles.card} ${styles.cardWide}`} style={{ marginTop: 14 }}>
                  <h3 style={{ marginTop: 0 }} className={`${styles.sectionSecondaryTitle}`}>Sitemap submission</h3>
                  <div className={styles.muted} style={{ fontSize: 12, marginBottom: 12, lineHeight: 1.5 }}>
                    Register your sitemap once and Google will recrawl it on its own schedule — every
                    future article gets discovered without per-post action. Sitemap submission is the
                    officially supported public API for telling Search Console about new URLs.
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8, alignItems: "stretch" }}>
                    <input
                      type="url"
                      className={styles.input}
                      placeholder={gscSitemapSuggested || "https://example.com/sitemap.xml"}
                      value={sitemapInput}
                      onChange={(e) => setSitemapInput(e.target.value)}
                      disabled={sitemapBusy === "submit" || sitemapBusy === "delete"}
                    />
                    <button
                      type="button"
                      className={styles.button}
                      onClick={submitProjectSitemap}
                      disabled={sitemapBusy === "submit" || sitemapBusy === "delete"}
                    >
                      {sitemapBusy === "submit" ? "Submitting…" : "Submit sitemap"}
                    </button>
                  </div>
                  <div className={styles.muted} style={{ fontSize: 11, marginTop: 6, lineHeight: 1.45 }}>
                    Default suggestion is <code>{gscSitemapSuggested || "—"}</code> (the WordPress core
                    sitemap). If you use Yoast or RankMath the index sitemap usually lives at{" "}
                    <code>/sitemap_index.xml</code> — paste that URL and submit it instead.
                  </div>

                  {sitemapMsg ? (
                    <div className={styles.muted} style={{ fontSize: 13, marginTop: 10, lineHeight: 1.5 }}>
                      {sitemapMsg}
                    </div>
                  ) : null}

                  <div style={{ marginTop: 16 }}>
                    <div className={styles.row} style={{ justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                      <div style={{ fontWeight: 700 }}>Registered sitemaps</div>
                      <button
                        type="button"
                        className={styles.miniBtn}
                        onClick={() => reloadProjectSitemaps()}
                        disabled={sitemapBusy === "load"}
                      >
                        {sitemapBusy === "load" ? "Refreshing…" : "Refresh"}
                      </button>
                    </div>
                    {gscSitemaps.length === 0 ? (
                      <div className={styles.muted} style={{ fontSize: 13 }}>
                        No sitemaps registered yet. Submit one above to enable automatic discovery.
                      </div>
                    ) : (
                      <div style={{ overflowX: "auto" }}>
                        <table className={`${styles.table} ${styles.tableZebra}`}>
                          <thead>
                            <tr>
                              <th className={styles.th}>Sitemap URL</th>
                              <th className={styles.th}>Last submitted</th>
                              <th className={`${styles.th} ${styles.thNum}`}>Submitted</th>
                              <th className={`${styles.th} ${styles.thNum}`}>Indexed</th>
                              <th className={styles.th}>Status</th>
                              <th className={styles.th} style={{ textAlign: "right" }}>Actions</th>
                            </tr>
                          </thead>
                          <tbody>
                            {gscSitemaps.map((s) => {
                              const isDeleting = sitemapBusy === "delete" && sitemapDeletingPath === s.path;
                              const errs = s.errors || 0;
                              const warns = s.warnings || 0;
                              const pillClass = errs > 0
                                ? `${styles.statusPill} ${styles.pillDanger}`
                                : warns > 0
                                ? `${styles.statusPill} ${styles.pillWarn}`
                                : `${styles.statusPill} ${styles.pillSuccess}`;
                              const pillLabel = errs > 0
                                ? `${errs} error${errs === 1 ? "" : "s"}`
                                : warns > 0
                                ? `${warns} warning${warns === 1 ? "" : "s"}`
                                : "OK";
                              return (
                                <tr key={s.path}>
                                  <td className={styles.td} style={{ maxWidth: 360, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                    <a href={s.path} target="_blank" rel="noopener noreferrer" className={styles.tableLink}>
                                      {s.path}
                                    </a>
                                  </td>
                                  <td className={`${styles.td} ${styles.tdMuted}`} style={{ fontSize: 12 }}>
                                    {s.last_submitted ? new Date(s.last_submitted).toLocaleString() : "—"}
                                  </td>
                                  <td className={`${styles.td} ${styles.tdNum}`}>{s.submitted_urls || "—"}</td>
                                  <td className={`${styles.td} ${styles.tdNum}`}>{s.indexed_urls || "—"}</td>
                                  <td className={styles.td}>
                                    <span className={pillClass}>{pillLabel}</span>
                                  </td>
                                  <td className={styles.td} style={{ textAlign: "right" }}>
                                    <div className={styles.row} style={{ gap: 6, justifyContent: "flex-end", flexWrap: "wrap" }}>
                                      <button
                                        type="button"
                                        className={styles.miniBtn}
                                        onClick={() => {
                                          setSitemapInput(s.path);
                                          void submitProjectSitemap();
                                        }}
                                        disabled={Boolean(sitemapBusy)}
                                      >
                                        Resubmit
                                      </button>
                                      <button
                                        type="button"
                                        className={`${styles.miniBtn} ${styles.miniDanger}`}
                                        onClick={() => deleteProjectSitemap(s.path)}
                                        disabled={Boolean(sitemapBusy)}
                                      >
                                        {isDeleting ? "Removing…" : "Remove"}
                                      </button>
                                    </div>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </div>
              </>
            ) : (
              <div className={`${styles.card} ${styles.cardWide}`} style={{ marginTop: 14 }}>
                <p className={styles.clusterCardSubtitle} style={{ margin: 0, lineHeight: 1.55 }}>
                  <strong>Performance summary</strong>, <strong>internal site-map sync</strong>, and <strong>sitemap submission</strong>{" "}
                  appear here after you connect Google above, pick a Search Console property, and click <strong>Save</strong> so this project is
                  fully linked to a verified property.
                </p>
              </div>
            )}

            <div className={`${styles.card} ${styles.cardWide}`} style={{ marginTop: 14 }}>
              <h3 style={{ marginTop: 0 }} className={`${styles.sectionSecondaryTitle}`}>Existing articles — indexing status</h3>
              <div className={styles.muted} style={{ fontSize: 12, marginBottom: 10, lineHeight: 1.5 }}>
                <strong>Check</strong> reads the URL’s current coverage from Search Console (read-only).{" "}
                <strong>Index now</strong> pings Google’s Indexing API (officially supported only for
                JobPosting / BroadcastEvent — for general articles it’s a discovery hint and is{" "}
                <em>not</em> reflected in URL Inspection’s history) and pings your sitemap, then opens
                Search Console’s URL Inspection panel pre-filled with the URL. Pressing{" "}
                <strong>REQUEST INDEXING</strong> there is the only action that produces the visible
                &ldquo;Indexing requested&rdquo; entry in Search Console.
              </div>

              {!gscStatus?.connected || !gscStatus?.property_url ? (
                <div className={styles.muted} style={{ fontSize: 13 }}>
                  Connect Google and link a property above to use these actions.
                </div>
              ) : (() => {
                const allPublished = (articles || []).filter((a) => (a.wp_link || "").trim());
                if (!allPublished.length) {
                  return (
                    <div className={styles.muted} style={{ fontSize: 13 }}>
                      No published articles yet. Once an article goes live, it will appear here.
                    </div>
                  );
                }

                const q = indexingSearch.trim().toLowerCase();
                const filtered = allPublished.filter((a) => {
                  // Effective coverage: live status from a "Check" if available, else stored gsc_status.
                  const status = articleIndexStatus[a.id];
                  const coverage = (status?.coverage_state || a.gsc_status || "").toString().toLowerCase();
                  if (indexingStatusFilter && coverage !== indexingStatusFilter) return false;
                  if (!q) return true;
                  const hay = `${a.title || ""} ${a.wp_link || ""}`.toLowerCase();
                  return hay.includes(q);
                });

                const total = filtered.length;
                const totalPages = Math.max(1, Math.ceil(total / indexingPageSize));
                const safePage = Math.min(Math.max(1, indexingPage), totalPages);
                const pageStart = (safePage - 1) * indexingPageSize;
                const pageRows = filtered.slice(pageStart, pageStart + indexingPageSize);

                // Map a coverage / gsc_status string to a status pill class + label.
                const pillFor = (coverage: string) => {
                  const s = (coverage || "").toLowerCase();
                  if (s === "indexed" || s === "valid")
                    return { cls: `${styles.statusPill} ${styles.pillSuccess}`, label: "Indexed" };
                  if (s === "requested" || s === "manual_required" || s === "sitemap_pinged" || s === "index_api_pinged")
                    return { cls: `${styles.statusPill} ${styles.pillInfo}`, label: "Requested" };
                  if (s === "inspected")
                    return { cls: `${styles.statusPill} ${styles.pillInfo}`, label: "Inspected" };
                  if (s === "error" || s === "failed")
                    return { cls: `${styles.statusPill} ${styles.pillDanger}`, label: "Error" };
                  if (s === "pending" || !s)
                    return { cls: `${styles.statusPill} ${styles.pillNeutral}`, label: "Pending" };
                  return { cls: `${styles.statusPill} ${styles.pillNeutral}`, label: coverage };
                };

                return (
                  <>
                    <div
                      className={styles.row}
                      style={{ gap: 8, marginBottom: 10, flexWrap: "wrap", alignItems: "center" }}
                    >
                      <input
                        className={styles.input}
                        type="search"
                        placeholder="Search title or URL…"
                        value={indexingSearch}
                        onChange={(e) => {
                          setIndexingSearch(e.target.value);
                          setIndexingPage(1);
                        }}
                        style={{ maxWidth: 260, height: 36 }}
                      />
                      <select
                        className={styles.input}
                        value={indexingStatusFilter}
                        onChange={(e) => {
                          setIndexingStatusFilter(e.target.value);
                          setIndexingPage(1);
                        }}
                        style={{ maxWidth: 200, height: 36 }}
                      >
                        <option value="">All statuses</option>
                        <option value="pending">Pending</option>
                        <option value="inspected">Inspected</option>
                        <option value="requested">Requested</option>
                        <option value="indexed">Indexed</option>
                        <option value="manual_required">Manual required</option>
                      </select>
                      <select
                        className={styles.input}
                        value={String(indexingPageSize)}
                        onChange={(e) => {
                          setIndexingPageSize(parseInt(e.target.value, 10) || 10);
                          setIndexingPage(1);
                        }}
                        style={{ maxWidth: 130, height: 36 }}
                        title="Rows per page"
                      >
                        <option value="10">10 / page</option>
                        <option value="25">25 / page</option>
                        <option value="50">50 / page</option>
                        <option value="100">100 / page</option>
                      </select>
                      <span className={styles.muted} style={{ fontSize: 12, marginLeft: "auto" }}>
                        Showing {pageRows.length} of {total} (
                        {allPublished.length} published)
                      </span>
                    </div>

                    <div style={{ overflowX: "auto", border: "1px solid var(--aa-hairline)", borderRadius: 12 }}>
                      <table className={`${styles.table} ${styles.tableZebra}`} style={{ border: "0" }}>
                        <thead>
                          <tr>
                            <th className={styles.th} style={{ width: "30%" }}>Title</th>
                            <th className={styles.th} style={{ width: "40%" }}>Live URL</th>
                            <th className={styles.th} style={{ width: 110 }}>Status</th>
                            <th className={styles.th} style={{ textAlign: "right" }}>Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {pageRows.map((a) => {
                            const busy = articleIndexBusy[a.id];
                            const msg = articleIndexMsg[a.id];
                            const status = articleIndexStatus[a.id];
                            const result = articleIndexResult[a.id];
                            const inspectUrl = result?.inspect_panel_url || "";
                            const coverage = (status?.coverage_state || a.gsc_status || "").toString();
                            const pill = pillFor(coverage);
                            return (
                              <tr key={a.id}>
                                <td
                                  className={styles.td}
                                  style={{ maxWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                                  title={a.title}
                                >
                                  {a.title || "(untitled)"}
                                </td>
                                <td
                                  className={styles.td}
                                  style={{ maxWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                                >
                                  <a
                                    href={a.wp_link || "#"}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className={styles.tableLink}
                                    title={a.wp_link || ""}
                                  >
                                    {a.wp_link}
                                  </a>
                                </td>
                                <td className={styles.td}>
                                  <span className={pill.cls}>{pill.label}</span>
                                  {msg ? (
                                    <div className={styles.muted} style={{ fontSize: 11, marginTop: 4, lineHeight: 1.45 }}>
                                      {msg}
                                    </div>
                                  ) : null}
                                </td>
                                <td className={styles.td} style={{ textAlign: "right" }}>
                                  <div className={styles.row} style={{ gap: 6, justifyContent: "flex-end", flexWrap: "wrap" }}>
                                    <button
                                      type="button"
                                      className={styles.miniBtn}
                                      onClick={() => checkArticleIndexing(a.id)}
                                      disabled={Boolean(busy)}
                                    >
                                      {busy === "check" ? "Checking…" : "Check"}
                                    </button>
                                    <button
                                      type="button"
                                      className={`${styles.miniBtn} ${styles.miniPrimary}`}
                                      onClick={() => requestArticleIndexing(a.id)}
                                      disabled={Boolean(busy)}
                                    >
                                      {busy === "request" ? "Submitting…" : "Index now"}
                                    </button>
                                    {inspectUrl ? (
                                      <a
                                        href={inspectUrl}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className={styles.miniBtn}
                                        title="Opens Google Search Console URL Inspection pre-filled with this URL — press REQUEST INDEXING there to actually queue a crawl that shows up in URL Inspection history."
                                      >
                                        GSC ↗
                                      </a>
                                    ) : null}
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                          {pageRows.length === 0 ? (
                            <tr>
                              <td className={`${styles.td} ${styles.tdMuted}`} colSpan={4} style={{ textAlign: "center", padding: 18 }}>
                                No articles match the current filters.
                              </td>
                            </tr>
                          ) : null}
                        </tbody>
                      </table>
                      <div className={styles.pagerBar}>
                        <span>
                          Page {safePage} / {totalPages}
                        </span>
                        <div className={styles.row} style={{ gap: 6 }}>
                          <button
                            type="button"
                            className={styles.miniBtn}
                            onClick={() => setIndexingPage((p) => Math.max(1, p - 1))}
                            disabled={safePage <= 1}
                          >
                            ← Prev
                          </button>
                          <button
                            type="button"
                            className={styles.miniBtn}
                            onClick={() => setIndexingPage((p) => Math.min(totalPages, p + 1))}
                            disabled={safePage >= totalPages}
                          >
                            Next →
                          </button>
                        </div>
                      </div>
                    </div>
                  </>
                );
              })()}
            </div>

            {gscConfirmDisconnect ? (
              <>
                <button
                  type="button"
                  className={styles.modalBackdrop}
                  aria-label="Close"
                  onClick={() => setGscConfirmDisconnect(false)}
                />
                <div className={styles.modalPanel} role="dialog" aria-modal="true" aria-label="Disconnect Search Console">
                  <div className={styles.modalHead}>
                    <h3 className={styles.modalTitle}>Disconnect Search Console?</h3>
                  </div>
                  <div className={styles.modalBody}>
                    <p>
                      The connection for this project will be removed. The Google account itself stays connected (revoke it from your Google account if needed).
                    </p>
                  </div>
                  <div className={styles.modalFooter}>
                    <button
                      type="button"
                      className={styles.btnSecondary}
                      onClick={() => setGscConfirmDisconnect(false)}
                      disabled={gscDisconnecting}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className={`${styles.button} ${styles.miniDanger || ""}`}
                      onClick={disconnectGscForProject}
                      disabled={gscDisconnecting}
                    >
                      {gscDisconnecting ? "Disconnecting…" : "Disconnect"}
                    </button>
                  </div>
                </div>
              </>
            ) : null}
          </>
        ) : null}

        {tab === "performance" ? (
          <>
            {/* Performance & Analysis — full-width chart with rich range controls. */}
            <div className={`${styles.card} ${styles.cardWide}`}>
              <div className={styles.row} style={{ justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
                <div>
                  <h2 style={{ marginTop: 0, marginBottom: 4 }} className={`${styles.sectionTitle}`}>
                    Performance & Analysis
                  </h2>
                  <div className={styles.muted} style={{ fontSize: 12, lineHeight: 1.5 }}>
                    Search Console clicks and impressions for{" "}
                    <code>{(analytics?.property_url || gscStatus?.property_url || "—").toString()}</code>.
                    Gold markers show when Riviso published an article — hover to see which.
                    Google delays final data ~2-3 days; the latest two points may shift slightly.
                  </div>
                </div>
                <button type="button" className={styles.miniBtn} onClick={() => reloadAnalytics()} disabled={analyticsBusy}>
                  {analyticsBusy ? "Refreshing…" : "Refresh"}
                </button>
              </div>

              {/* Range controls: presets + custom range */}
              <div
                className={styles.row}
                style={{ gap: 8, marginTop: 14, flexWrap: "wrap", alignItems: "center" }}
              >
                {[
                  { d: 7, label: "7d" },
                  { d: 28, label: "28d" },
                  { d: 90, label: "90d" },
                  { d: 180, label: "6m" },
                  { d: 365, label: "12m" },
                ].map(({ d, label }) => (
                  <button
                    key={d}
                    type="button"
                    className={styles.miniBtn}
                    onClick={() => {
                      setAnalyticsRangePreset(d);
                    }}
                    style={{
                      fontWeight: analyticsRangePreset === d ? 800 : 600,
                      background:
                        analyticsRangePreset === d
                          ? "color-mix(in oklab, var(--aa-primary), transparent 80%)"
                          : undefined,
                      borderColor:
                        analyticsRangePreset === d
                          ? "color-mix(in oklab, var(--aa-primary), transparent 50%)"
                          : undefined,
                    }}
                    disabled={analyticsBusy}
                    aria-pressed={analyticsRangePreset === d}
                  >
                    {label}
                  </button>
                ))}
                <button
                  type="button"
                  className={styles.miniBtn}
                  onClick={() => setAnalyticsRangePreset("custom")}
                  style={{
                    fontWeight: analyticsRangePreset === "custom" ? 800 : 600,
                    background:
                      analyticsRangePreset === "custom"
                        ? "color-mix(in oklab, var(--aa-primary), transparent 80%)"
                        : undefined,
                    borderColor:
                      analyticsRangePreset === "custom"
                        ? "color-mix(in oklab, var(--aa-primary), transparent 50%)"
                        : undefined,
                  }}
                  disabled={analyticsBusy}
                  aria-pressed={analyticsRangePreset === "custom"}
                >
                  Custom…
                </button>

                {analyticsRangePreset === "custom" ? (
                  <div className={styles.row} style={{ gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                    <span className={styles.muted} style={{ fontSize: 12 }}>From</span>
                    <input
                      type="date"
                      className={styles.input}
                      value={analyticsCustomStart}
                      onChange={(e) => setAnalyticsCustomStart(e.target.value)}
                      max={analyticsCustomEnd || undefined}
                      style={{ height: 36, maxWidth: 170 }}
                    />
                    <span className={styles.muted} style={{ fontSize: 12 }}>to</span>
                    <input
                      type="date"
                      className={styles.input}
                      value={analyticsCustomEnd}
                      onChange={(e) => setAnalyticsCustomEnd(e.target.value)}
                      min={analyticsCustomStart || undefined}
                      max={new Date().toISOString().slice(0, 10)}
                      style={{ height: 36, maxWidth: 170 }}
                    />
                    <button
                      type="button"
                      className={styles.button}
                      onClick={() => reloadAnalytics()}
                      disabled={
                        analyticsBusy ||
                        !analyticsCustomStart ||
                        !analyticsCustomEnd ||
                        analyticsCustomStart > analyticsCustomEnd
                      }
                    >
                      Apply
                    </button>
                  </div>
                ) : null}
                {analytics?.range ? (
                  <span className={styles.muted} style={{ fontSize: 12, marginLeft: "auto" }}>
                    {analytics.range.start_date} → {analytics.range.end_date} ({analytics.range.days} days)
                  </span>
                ) : null}
              </div>

              {analyticsErr ? (
                <div className={styles.error} style={{ marginTop: 14 }}>{analyticsErr}</div>
              ) : analyticsBusy && !analytics ? (
                <div className={styles.muted} style={{ fontSize: 13, marginTop: 14 }}>Loading Search Console data…</div>
              ) : analytics ? (
                <>
                  {/* KPI tiles */}
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
                      gap: 12,
                      marginTop: 16,
                    }}
                  >
                    <div className={styles.kpiTile}>
                      <div className={styles.kpiLabel}>Clicks</div>
                      <div className={styles.kpiValue}>{(analytics.totals.clicks || 0).toLocaleString()}</div>
                      <div className={styles.kpiSub}>{analytics.totals.days_with_data} days with data</div>
                    </div>
                    <div className={styles.kpiTile}>
                      <div className={styles.kpiLabel}>Impressions</div>
                      <div className={styles.kpiValue}>{(analytics.totals.impressions || 0).toLocaleString()}</div>
                    </div>
                    <div className={styles.kpiTile}>
                      <div className={styles.kpiLabel}>Avg CTR</div>
                      <div className={styles.kpiValue}>{((analytics.totals.ctr || 0) * 100).toFixed(2)}%</div>
                    </div>
                    <div className={styles.kpiTile}>
                      <div className={styles.kpiLabel}>Avg position</div>
                      <div className={styles.kpiValue}>{(analytics.totals.position || 0).toFixed(1)}</div>
                    </div>
                  </div>

                  {/* Chart — edge-to-edge within the card (horizontal bleed cancels card padding). */}
                  <div className={styles.analyticsChartBleed} style={{ marginTop: 18 }}>
                    <AnalyticsLineChart series={analytics.series} markers={analytics.markers} />
                    <div className={styles.analyticsChartLegend}>
                      <span className={styles.analyticsLegendSwatch} data-series="clicks" /> Clicks
                      <span className={styles.analyticsLegendSwatch} data-series="impr" /> Impressions
                      <span className={styles.analyticsLegendSwatch} data-series="marker" /> Article published
                      <span className={styles.analyticsLegendMeta}>
                        · {analytics.markers.length} article{analytics.markers.length === 1 ? "" : "s"} in this window
                      </span>
                    </div>
                  </div>
                </>
              ) : (
                <div className={styles.muted} style={{ fontSize: 13, marginTop: 14 }}>
                  No analytics data yet for this property.
                </div>
              )}
            </div>

            {/* Top pages table — high-contrast version */}
            {analytics && analytics.top_pages.length > 0 ? (
              <div className={`${styles.card} ${styles.cardWide}`} style={{ marginTop: 14 }}>
                <h3 style={{ marginTop: 0 }} className={`${styles.sectionSecondaryTitle}`}>Top pages by clicks</h3>
                <div className={styles.muted} style={{ fontSize: 12, marginBottom: 10 }}>
                  Up to {analytics.top_pages.length} URLs from the linked property, sorted by clicks within the active window.
                </div>
                <div style={{ overflowX: "auto", border: "1px solid var(--aa-hairline)", borderRadius: 12 }}>
                  <table className={`${styles.table} ${styles.tableZebra} ${styles.analyticsTopPagesTable}`} style={{ border: 0 }}>
                    <thead>
                      <tr>
                        <th className={styles.th} style={{ width: "60%" }}>URL</th>
                        <th className={`${styles.th} ${styles.thNum}`}>Clicks</th>
                        <th className={`${styles.th} ${styles.thNum}`}>Impressions</th>
                        <th className={`${styles.th} ${styles.thNum}`}>CTR</th>
                        <th className={`${styles.th} ${styles.thNum}`}>Position</th>
                      </tr>
                    </thead>
                    <tbody>
                      {analytics.top_pages.map((row) => (
                        <tr key={row.url}>
                          <td
                            className={styles.td}
                            style={{ maxWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                          >
                            <a
                              href={row.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className={styles.tableLink}
                              title={row.url}
                            >
                              {row.url}
                            </a>
                          </td>
                          <td className={`${styles.td} ${styles.tdNum}`}>{row.clicks.toLocaleString()}</td>
                          <td className={`${styles.td} ${styles.tdNum}`}>{row.impressions.toLocaleString()}</td>
                          <td className={`${styles.td} ${styles.tdNum}`}>{(row.ctr * 100).toFixed(2)}%</td>
                          <td className={`${styles.td} ${styles.tdNum}`}>{row.position.toFixed(1)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}
          </>
        ) : null}

        {tab === "project_settings" ? (
          <>
            <div className={`${styles.card} ${styles.cardWide}`}>
              <div className={styles.projectCardTop}>
                {(() => {
                  const wpOkForSave =
                    !!settings &&
                    (settings.wp_verified_status || "").toLowerCase() === "connected" &&
                    !!(settings.wp_verified_at || "").trim();
                  const showSave = settings ? settingsDirty || (wpOkForSave && identityDirty) : settingsDirty || identityDirty;
                  return showSave ? (
                    <button className={styles.button} type="button" onClick={saveSettings} disabled={settingsSaving || settingsLoading}>
                      {settingsSaving ? "Saving…" : "Save"}
                    </button>
                  ) : null;
                })()}
              </div>
              {settingsLoading ? <div className={styles.muted}>Loading settings…</div> : null}
              {error ? <p className={styles.error}>{error}</p> : null}
            </div>

            {settings ? (
              <div className={`${styles.card} ${styles.cardWide}`}>
                {/*
                  WordPress connection block: header + clear status pill so a user
                  who skipped the "Connect WordPress" popup at project creation
                  can see exactly what's missing and fix it from here. The pill
                  reads from the persisted ``wp_verified_at`` snapshot the
                  backend records on every successful verify call, so it stays
                  honest across reloads.
                */}
                <div className={styles.wpConnectionHead}>
                  <div>
                    <h3 className={styles.clusterTreeLabel} style={{ margin: 0 }}>
                      WordPress connection
                    </h3>
                    <p className={styles.clusterCardSubtitle}>
                      Riviso publishes generated articles via WordPress&apos;s REST API. Provide
                      your site URL, username, and an{" "}
                      <a
                        href="https://wordpress.org/documentation/article/application-passwords/"
                        target="_blank"
                        rel="noreferrer"
                        className={styles.clusterOpenLink}
                      >
                        Application Password
                      </a>{" "}
                      (Users → Profile → Application Passwords), then click <strong>Verify
                      connection</strong>.
                    </p>
                  </div>
                  {(() => {
                    const status = (settings.wp_verified_status || "").toLowerCase();
                    const verifiedAt = (settings.wp_verified_at || "").trim();
                    let label = "Not connected";
                    let dataState: "verified" | "warning" | "failed" | "pending" = "pending";
                    let title = "No WordPress credentials saved yet. Fill in the fields below and click Verify connection.";
                    if (status === "connected" && verifiedAt) {
                      label = "Verified";
                      dataState = "verified";
                      title = `Last verified ${verifiedAt} UTC.`;
                    } else if (status === "auth_failed") {
                      label = "Auth failed";
                      dataState = "failed";
                      title = settings.wp_verified_message || "Authentication failed. Check username and application password.";
                    } else if (status === "failed" || status === "error") {
                      label = "Verification failed";
                      dataState = "failed";
                      title = settings.wp_verified_message || "Could not verify WordPress connection.";
                    } else if (settings.wp_app_password_set && (settings.wp_site_url || settings.website_url)) {
                      label = "Not verified yet";
                      dataState = "warning";
                      title = "Credentials are saved but no successful verify on record. Click Verify connection.";
                    }

                    // Independent plugin pill — only meaningful once a verify
                    // has run (i.e. the credentials pill is no longer in the
                    // "Not connected" state).
                    const pluginStatus = (settings.wp_plugin_status || "").toLowerCase();
                    const pluginMsg = (settings.wp_plugin_message || "").trim();
                    let pluginLabel = "";
                    let pluginState: "verified" | "warning" | "failed" | "pending" = "pending";
                    let pluginTitle = pluginMsg;
                    if (pluginStatus === "active") {
                      pluginLabel = "Plugin active";
                      pluginState = "verified";
                      pluginTitle = pluginMsg || "Connector plugin responded to /ping with 200.";
                    } else if (pluginStatus === "installed") {
                      pluginLabel = "Plugin registered, /ping unreachable";
                      pluginState = "warning";
                      pluginTitle = pluginMsg || "Plugin REST namespace is registered but /ping was rejected.";
                    } else if (pluginStatus === "capability") {
                      pluginLabel = "Plugin: capability blocked";
                      pluginState = "failed";
                      pluginTitle = pluginMsg || "Plugin is installed but the WordPress user lacks edit_posts.";
                    } else if (pluginStatus === "missing") {
                      pluginLabel = "Plugin not active";
                      pluginState = "failed";
                      pluginTitle = pluginMsg || "Connector plugin not detected on the site.";
                    } else if (pluginStatus === "unknown") {
                      pluginLabel = "Plugin: unknown";
                      pluginState = "warning";
                      pluginTitle = pluginMsg || "Could not reach the WordPress REST index.";
                    }

                    return (
                      <span className={styles.wpStatusPillStack}>
                        <span className={styles.wpStatusPill} data-state={dataState} title={title}>
                          {label}
                          {dataState === "verified" && verifiedAt ? (
                            <span className={styles.wpStatusPillTime}>· {verifiedAt} UTC</span>
                          ) : null}
                        </span>
                        {pluginLabel ? (
                          <span
                            className={styles.wpStatusPill}
                            data-state={pluginState}
                            title={pluginTitle}
                          >
                            {pluginLabel}
                          </span>
                        ) : null}
                      </span>
                    );
                  })()}
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <label className={styles.label}>
                    Project display name
                    <input className={styles.input} value={sName} onChange={(e) => setSName(e.target.value)} />
                  </label>
                  <label className={styles.label}>
                    WordPress site URL
                    <input
                      className={styles.input}
                      value={sUrl}
                      onChange={(e) => setSUrl(e.target.value)}
                      placeholder="https://example.com"
                      autoComplete="url"
                      inputMode="url"
                    />
                  </label>
                  <label className={styles.label}>
                    WordPress username
                    <input
                      className={styles.input}
                      value={sWpUser}
                      onChange={(e) => setSWpUser(e.target.value)}
                      placeholder="e.g. admin"
                      autoComplete="username"
                    />
                  </label>
                  <label className={styles.label}>
                    Application password
                    <input
                      className={styles.input}
                      value={sWpPass}
                      type="password"
                      onChange={(e) => setSWpPass(e.target.value)}
                      placeholder={settings.wp_app_password_set ? "•••••••••• (set)" : "xxxx xxxx xxxx xxxx"}
                      autoComplete="new-password"
                    />
                  </label>
                </div>

                <div className={styles.wpConnectionActions}>
                  <a
                    className={styles.btnSecondary}
                    href={`${getApiBaseUrl()}${settings.plugin_download_url}`}
                    download
                  >
                    Download plugin
                  </a>
                  <button
                    className={styles.button}
                    type="button"
                    onClick={verifySettings}
                    disabled={
                      settingsVerifying ||
                      !sUrl.trim() ||
                      !sWpUser.trim() ||
                      (!sWpPass.trim() && !settings.wp_app_password_set)
                    }
                    title={
                      !sWpPass.trim() && !settings.wp_app_password_set
                        ? "Enter the application password first."
                        : "Save credentials and check the WordPress REST API responds."
                    }
                  >
                    {settingsVerifying ? "Verifying…" : "Verify connection"}
                  </button>
                </div>

                {settingsVerify ? (
                  <div
                    className={settingsVerify.ok ? styles.wpVerifyResultOk : styles.wpVerifyResultErr}
                    style={{ whiteSpace: "pre-wrap" }}
                  >
                    {settingsVerify.message}
                  </div>
                ) : null}

                {(() => {
                  const wpVerifiedOk =
                    (settings.wp_verified_status || "").toLowerCase() === "connected" &&
                    !!(settings.wp_verified_at || "").trim();
                  if (!wpVerifiedOk) {
                    return (
                      <div
                        className={styles.clusterCardSubtitle}
                        style={{
                          marginTop: 16,
                          paddingTop: 14,
                          borderTop: "1px solid var(--button-secondary-border)",
                          lineHeight: 1.55,
                        }}
                      >
                        <strong>Brand identity</strong>, <strong>niche</strong>, and <strong>WordPress defaults</strong> unlock
                        after WordPress returns a successful verify (green &quot;Verified&quot; pill above). Finish connecting your
                        site, then click <strong>Verify connection</strong> again if credentials changed.
                      </div>
                    );
                  }
                  return (
                    <>
                      {/* ----------------------------------------------------------------
                       * Brand identity — structured form
                       * Replaces the old free-text textarea with three discrete inputs
                       * (voice / tones / rules). The backend rebuilds the legacy
                       * `brand_identity` plain-text string from these every time we
                       * save, so downstream consumers (article generation, image
                       * prompt builder) keep working without changes.
                       * ---------------------------------------------------------------- */}
                      <div className={styles.brandSection}>
                        <h4 className={styles.brandSectionTitle}>Brand identity</h4>
                        <p className={styles.brandSectionSub}>
                          Sets <strong>how</strong> the AI writes for this project. Choose the
                          posture (voice), the modes you want it to mix (tones), and any
                          do/don&apos;t rules it should respect on every article.
                        </p>
                        <div className={styles.brandFieldGrid}>
                          <label className={styles.brandFieldLabel}>
                            Voice
                            <select
                              className={styles.input}
                              value={brandVoice}
                              onChange={(e) => setBrandVoice(e.target.value)}
                            >
                              <option value="">Pick a voice…</option>
                              {BRAND_VOICES.map((v) => (
                                <option key={v.id} value={v.label}>
                                  {v.label}
                                </option>
                              ))}
                            </select>
                            <span className={styles.brandFieldHelp}>
                              The overall posture every article should carry — pick one.
                            </span>
                          </label>
                          <label className={styles.brandFieldLabel}>
                            Tones <span style={{ opacity: 0.6, fontWeight: 500 }}>(pick up to 5)</span>
                            <div className={styles.chipPickerBox}>
                              {BRAND_TONES.map((t) => {
                                const selected = brandTones.includes(t.label);
                                const disabled = !selected && brandTones.length >= 5;
                                return (
                                  <button
                                    key={t.id}
                                    type="button"
                                    className={styles.chipOption}
                                    data-selected={selected}
                                    data-disabled={disabled}
                                    onClick={() => {
                                      if (selected) {
                                        setBrandTones((xs) => xs.filter((x) => x !== t.label));
                                      } else if (!disabled) {
                                        setBrandTones((xs) => [...xs, t.label]);
                                      }
                                    }}
                                  >
                                    {t.label}
                                  </button>
                                );
                              })}
                            </div>
                            <span className={styles.brandFieldHelp}>
                              Selected: {brandTones.length}/5. The AI mixes these as it
                              writes — e.g. &quot;Direct + Evidence-driven + No hype&quot;.
                            </span>
                          </label>
                        </div>
                        <label className={styles.brandFieldLabel}>
                          Rules
                          <textarea
                            className={styles.input}
                            value={brandRules}
                            onChange={(e) => setBrandRules(e.target.value.slice(0, 4000))}
                            rows={4}
                            placeholder={
                              "Examples — keep it short and concrete:\n" +
                              "• Avoid buzzwords (synergy, leverage, game-changer).\n" +
                              "• Always cite a source when quoting numbers.\n" +
                              "• Use short paragraphs and bullet checklists.\n" +
                              "• Never promise outcomes; describe likelihoods."
                            }
                            style={{ resize: "vertical" }}
                          />
                          <span className={styles.brandFieldHelp}>
                            {brandRules.trim().length}/4000 chars · One bullet per line.
                            These are appended to the AI&apos;s system prompt on every
                            article.
                          </span>
                        </label>
                      </div>

                      {/* ----------------------------------------------------------------
                       * Niche identifier — structured form
                       * Topic + audience + countries + cities. The backend rebuilds the
                       * legacy `niche_identifier` plain-text string from this every save.
                       * ---------------------------------------------------------------- */}
                      <div className={styles.brandSection}>
                        <h4 className={styles.brandSectionTitle}>Niche identifier</h4>
                        <p className={styles.brandSectionSub}>
                          Sets <strong>what</strong> and <strong>who</strong> every article is
                          about. Pin the topic universe, the audience, and the geographies
                          you want examples and references to come from.
                        </p>

                        <label className={styles.brandFieldLabel}>
                          Niche
                          <input
                            className={styles.input}
                            value={nicheTopic}
                            onChange={(e) => setNicheTopic(e.target.value.slice(0, 500))}
                            placeholder="e.g. Mutual divorce advocacy in India · MSME dispute resolution · DTC home decor"
                          />
                          <span className={styles.brandFieldHelp}>
                            One line. Industry + sub-topic + the differentiator that
                            distinguishes you from generic content in the same space.
                          </span>
                        </label>

                        <label className={styles.brandFieldLabel}>
                          Audience <span style={{ opacity: 0.6, fontWeight: 500 }}>(multi-select)</span>
                          <div className={styles.chipPickerBox}>
                            {AUDIENCE_PRESETS.map((a) => {
                              const selected = audienceList.includes(a.label);
                              return (
                                <button
                                  key={a.id}
                                  type="button"
                                  className={styles.chipOption}
                                  data-selected={selected}
                                  onClick={() => {
                                    if (selected) {
                                      setAudienceList((xs) => xs.filter((x) => x !== a.label));
                                    } else {
                                      setAudienceList((xs) => [...xs, a.label]);
                                    }
                                  }}
                                >
                                  {a.label}
                                </button>
                              );
                            })}
                            {/* Custom audiences — render as removable chips alongside the presets. */}
                            {audienceList
                              .filter(
                                (x) => !AUDIENCE_PRESETS.some((p) => p.label === x),
                              )
                              .map((custom) => (
                                <button
                                  key={`custom-${custom}`}
                                  type="button"
                                  className={styles.chipOption}
                                  data-selected={true}
                                  data-removable="true"
                                  onClick={() =>
                                    setAudienceList((xs) => xs.filter((x) => x !== custom))
                                  }
                                >
                                  {custom}
                                </button>
                              ))}
                          </div>
                          <div className={styles.chipFreeRow}>
                            <input
                              className={styles.chipFreeInput}
                              value={audienceCustomDraft}
                              onChange={(e) =>
                                setAudienceCustomDraft(e.target.value.slice(0, 120))
                              }
                              placeholder="Add a custom audience and press Enter…"
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  e.preventDefault();
                                  const v = audienceCustomDraft.trim();
                                  if (v && !audienceList.includes(v)) {
                                    setAudienceList((xs) => [...xs, v]);
                                  }
                                  setAudienceCustomDraft("");
                                }
                              }}
                            />
                            <button
                              type="button"
                              className={styles.chipFreeAddBtn}
                              disabled={
                                !audienceCustomDraft.trim() ||
                                audienceList.includes(audienceCustomDraft.trim())
                              }
                              onClick={() => {
                                const v = audienceCustomDraft.trim();
                                if (v && !audienceList.includes(v)) {
                                  setAudienceList((xs) => [...xs, v]);
                                }
                                setAudienceCustomDraft("");
                              }}
                            >
                              Add
                            </button>
                          </div>
                        </label>

                        <label className={styles.brandFieldLabel}>
                          Target countries
                          <div className={styles.brandToggleRow}>
                            <input
                              type="checkbox"
                              checked={!!targetCountriesAll}
                              onChange={(e) => {
                                const next = e.target.checked;
                                setTargetCountriesAll(next);
                                if (next) {
                                  // Single sentinel — don't enumerate 250+ codes.
                                  // Drop the country list AND any cities tied to
                                  // specific countries (we keep custom-typed cities
                                  // because the user explicitly added those).
                                  setTargetCountries([]);
                                  setTargetCities([]);
                                  setTargetCitiesAll(false);
                                }
                              }}
                            />
                            Select all countries (global targeting)
                          </div>
                          {!targetCountriesAll ? (
                            <>
                              <input
                                className={styles.chipFreeInput}
                                value={countryFilter}
                                onChange={(e) => setCountryFilter(e.target.value)}
                                placeholder="Filter countries…"
                                style={{ marginTop: 6 }}
                              />
                              <div
                                className={styles.chipPickerBox}
                                style={{ maxHeight: 220, overflowY: "auto" }}
                              >
                                {(() => {
                                  const q = countryFilter.trim().toLowerCase();
                                  const items = q
                                    ? COUNTRIES.filter(
                                        (c) =>
                                          c.name.toLowerCase().includes(q) ||
                                          c.code.toLowerCase().includes(q),
                                      )
                                    : COUNTRIES;
                                  if (items.length === 0) {
                                    return (
                                      <span className={styles.chipPickerEmpty}>
                                        No matches
                                      </span>
                                    );
                                  }
                                  return items.map((c) => {
                                    const selected = targetCountries.includes(c.code);
                                    return (
                                      <button
                                        key={c.code}
                                        type="button"
                                        className={styles.chipOption}
                                        data-selected={selected}
                                        onClick={() => {
                                          if (selected) {
                                            setTargetCountries((xs) =>
                                              xs.filter((x) => x !== c.code),
                                            );
                                            // Drop any cities tied to this country.
                                            const cities = citiesForCountry(c.code);
                                            if (cities.length > 0) {
                                              setTargetCities((xs) =>
                                                xs.filter((x) => !cities.includes(x)),
                                              );
                                            }
                                          } else {
                                            setTargetCountries((xs) => [...xs, c.code]);
                                          }
                                        }}
                                      >
                                        {c.name}
                                      </button>
                                    );
                                  });
                                })()}
                              </div>
                              <span className={styles.brandFieldHelp}>
                                {targetCountries.length === 0
                                  ? "No countries selected — articles won't be pinned to any geography."
                                  : `${targetCountries.length} selected.`}
                              </span>
                            </>
                          ) : (
                            <span className={styles.brandFieldHelp}>
                              Articles will be written for a global audience. The country
                              list and country-scoped city pickers are disabled while
                              this is on.
                            </span>
                          )}
                        </label>

                        {/* City targeting only makes sense when at least one country
                         * is in scope. Globally-targeted projects skip this section
                         * entirely so we never show a meaningless "pick a country
                         * first" hint right under "Select all countries". */}
                        {!targetCountriesAll && (
                        <label className={styles.brandFieldLabel}>
                          Target cities
                          <div className={styles.brandToggleRow}>
                            <input
                              type="checkbox"
                              checked={targetCitiesAll}
                              onChange={(e) => {
                                setTargetCitiesAll(e.target.checked);
                                if (e.target.checked) setTargetCities([]);
                              }}
                            />
                            Use all major cities of the selected countries
                          </div>
                          {!targetCitiesAll && (
                            <>
                              {targetCountries.length === 0 ? (
                                <div className={styles.chipPickerBox}>
                                  <span className={styles.chipPickerEmpty}>
                                    Pick one or more target countries first.
                                  </span>
                                </div>
                              ) : (
                                <>
                                  <div
                                    className={styles.chipPickerBox}
                                    style={{ maxHeight: 220, overflowY: "auto" }}
                                  >
                                    {(() => {
                                      const cityGroups: { country: string; cities: string[] }[] =
                                        targetCountries
                                          .map((code) => ({
                                            country: code,
                                            cities: citiesForCountry(code),
                                          }))
                                          .filter((g) => g.cities.length > 0);
                                      const customCities = targetCities.filter(
                                        (c) =>
                                          !cityGroups.some((g) => g.cities.includes(c)),
                                      );
                                      if (cityGroups.length === 0 && customCities.length === 0) {
                                        return (
                                          <span className={styles.chipPickerEmpty}>
                                            No curated city list for the selected
                                            countries — type cities below to add them.
                                          </span>
                                        );
                                      }
                                      return (
                                        <>
                                          {cityGroups.map((g) => (
                                            <div
                                              key={g.country}
                                              style={{
                                                display: "flex",
                                                flexDirection: "column",
                                                gap: 4,
                                                width: "100%",
                                              }}
                                            >
                                              <div
                                                className={styles.chipPickerEmpty}
                                                style={{
                                                  fontWeight: 700,
                                                  textTransform: "uppercase",
                                                  letterSpacing: "0.04em",
                                                  fontSize: 11,
                                                }}
                                              >
                                                {(COUNTRIES.find((c) => c.code === g.country)?.name) ||
                                                  g.country}
                                              </div>
                                              <div
                                                style={{
                                                  display: "flex",
                                                  flexWrap: "wrap",
                                                  gap: 6,
                                                }}
                                              >
                                                {g.cities.map((city) => {
                                                  const selected = targetCities.includes(city);
                                                  return (
                                                    <button
                                                      key={`${g.country}-${city}`}
                                                      type="button"
                                                      className={styles.chipOption}
                                                      data-selected={selected}
                                                      onClick={() => {
                                                        if (selected) {
                                                          setTargetCities((xs) =>
                                                            xs.filter((x) => x !== city),
                                                          );
                                                        } else {
                                                          setTargetCities((xs) => [...xs, city]);
                                                        }
                                                      }}
                                                    >
                                                      {city}
                                                    </button>
                                                  );
                                                })}
                                              </div>
                                            </div>
                                          ))}
                                          {customCities.map((city) => (
                                            <button
                                              key={`custom-city-${city}`}
                                              type="button"
                                              className={styles.chipOption}
                                              data-selected={true}
                                              data-removable="true"
                                              onClick={() =>
                                                setTargetCities((xs) =>
                                                  xs.filter((x) => x !== city),
                                                )
                                              }
                                            >
                                              {city}
                                            </button>
                                          ))}
                                        </>
                                      );
                                    })()}
                                  </div>
                                  <div className={styles.chipFreeRow}>
                                    <input
                                      className={styles.chipFreeInput}
                                      value={cityCustomDraft}
                                      onChange={(e) =>
                                        setCityCustomDraft(e.target.value.slice(0, 120))
                                      }
                                      placeholder="Add a city not in the list…"
                                      onKeyDown={(e) => {
                                        if (e.key === "Enter") {
                                          e.preventDefault();
                                          const v = cityCustomDraft.trim();
                                          if (v && !targetCities.includes(v)) {
                                            setTargetCities((xs) => [...xs, v]);
                                          }
                                          setCityCustomDraft("");
                                        }
                                      }}
                                    />
                                    <button
                                      type="button"
                                      className={styles.chipFreeAddBtn}
                                      disabled={
                                        !cityCustomDraft.trim() ||
                                        targetCities.includes(cityCustomDraft.trim())
                                      }
                                      onClick={() => {
                                        const v = cityCustomDraft.trim();
                                        if (v && !targetCities.includes(v)) {
                                          setTargetCities((xs) => [...xs, v]);
                                        }
                                        setCityCustomDraft("");
                                      }}
                                    >
                                      Add
                                    </button>
                                  </div>
                                </>
                              )}
                              <span className={styles.brandFieldHelp}>
                                {targetCities.length === 0
                                  ? "No specific cities selected."
                                  : `${targetCities.length} cities selected.`}
                              </span>
                            </>
                          )}
                        </label>
                        )}
                      </div>

                      <div style={{ marginTop: 14, borderTop: "1px solid var(--button-secondary-border)", paddingTop: 14 }}>
                        <div style={{ fontWeight: 900, marginBottom: 8 }}>WordPress defaults</div>
                        <div className={styles.muted} style={{ fontSize: 12, marginBottom: 10 }}>
                          These defaults will be pre-selected when publishing articles. You can still change them per article.
                        </div>

                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                          <label className={styles.label}>
                            Default post type
                            <select className={styles.input} value={sWpDefaultPostType} onChange={(e) => setSWpDefaultPostType(e.target.value)}>
                              <option value="posts">Posts</option>
                              <option value="pages">Pages</option>
                              {settingsPostTypes
                                .filter((t) => t.rest_base && !["posts", "pages"].includes(t.rest_base))
                                .map((t) => (
                                  <option key={t.rest_base} value={t.rest_base}>
                                    {t.name || t.rest_base}
                                  </option>
                                ))}
                            </select>
                          </label>

                          <label className={styles.label}>
                            Default status
                            <select className={styles.input} value={sWpDefaultStatus} onChange={(e) => setSWpDefaultStatus(e.target.value as "draft" | "publish")}>
                              <option value="draft">Draft</option>
                              <option value="publish">Publish</option>
                            </select>
                          </label>
                        </div>

                        <label className={styles.label} style={{ marginTop: 10 }}>
                          Default category
                          <select
                            className={styles.input}
                            multiple
                            value={sWpDefaultCategoryIds.map(String)}
                            onChange={(e) => {
                              const ids = Array.from(e.target.selectedOptions).map((o) => Number(o.value)).filter((n) => Number.isFinite(n));
                              setSWpDefaultCategoryIds(ids);
                            }}
                            style={{ minHeight: 120 }}
                          >
                            {settingsCategories.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name}
                              </option>
                            ))}
                          </select>
                          <div className={styles.muted} style={{ fontSize: 12, marginTop: 6 }}>
                            Hold Cmd/Ctrl to select multiple categories.
                          </div>
                        </label>
                      </div>
                    </>
                  );
                })()}

                <div style={{ marginTop: 14, borderTop: "1px solid var(--button-secondary-border)", paddingTop: 14 }}>
                  <div style={{ fontWeight: 900, marginBottom: 8 }}>Google Search Console</div>
                  <div className={styles.muted} style={{ fontSize: 12, marginBottom: 10, lineHeight: 1.5 }}>
                    Search Console connection moved to{" "}
                    <button
                      type="button"
                      className={styles.linkButton}
                      onClick={() => setTab("tools")}
                      style={{ background: "none", border: "none", padding: 0, color: "inherit", textDecoration: "underline", cursor: "pointer" }}
                    >
                      Tools → Search Console
                    </button>
                    . Each project now connects to its own Google account and chooses its property there.
                  </div>
                </div>

                <div style={{ marginTop: 16, borderTop: "1px solid var(--button-secondary-border)", paddingTop: 14 }}>
                  <div style={{ fontWeight: 900, marginBottom: 8 }}>Danger zone</div>
                  <div className={styles.muted} style={{ fontSize: 13, lineHeight: 1.5 }}>
                    Deleting a project removes it permanently, including all settings, website connections, prompts, scheduled jobs, and articles.
                  </div>
                  <div className={styles.row} style={{ justifyContent: "flex-end", marginTop: 10 }}>
                    <button type="button" className={`${styles.miniBtn} ${styles.miniDanger}`} onClick={() => setConfirmDeleteProject(true)} disabled={deletingProject}>
                      Delete project
                    </button>
                  </div>
                </div>
              </div>
            ) : null}
          </>
        ) : null}

        {confirmDeleteProject ? (
          <div className={styles.modalBackdrop} role="dialog" aria-modal="true" aria-label="Confirm delete project">
            <div className={styles.modalPanel}>
              <div className={styles.modalHead}>
                <h3 className={styles.modalTitle}>Delete project?</h3>
                <button type="button" className={styles.btnSecondary} onClick={() => (deletingProject ? null : setConfirmDeleteProject(false))}>
                  Close
                </button>
              </div>
              <div className={styles.modalBody}>
                <div style={{ lineHeight: 1.55 }}>
                  This will permanently delete the project and all its data:
                  <ul style={{ margin: "10px 0 0", paddingLeft: 18 }}>
                    <li>Project settings and website connections</li>
                    <li>Writing prompts and image prompts</li>
                    <li>Context links</li>
                    <li>Scheduled jobs</li>
                    <li>All articles in this project</li>
                  </ul>
                  <div style={{ marginTop: 10 }}>
                    <strong>This action cannot be undone.</strong>
                  </div>
                </div>
                {error ? <p className={styles.error} style={{ marginTop: 10 }}>{error}</p> : null}
              </div>
              <div className={styles.modalFooter}>
                <button type="button" className={styles.btnSecondary} onClick={() => setConfirmDeleteProject(false)} disabled={deletingProject}>
                  Cancel
                </button>
                <button type="button" className={`${styles.miniBtn} ${styles.miniDanger}`} onClick={() => void deleteProjectNow()} disabled={deletingProject}>
                  {deletingProject ? "Deleting…" : "Yes, delete project"}
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {clusterErrorModal ? (
          <div
            className={styles.modalBackdrop}
            role="dialog"
            aria-modal="true"
            aria-label={clusterErrorModal.title}
          >
            <div className={styles.modalPanel}>
              <div className={styles.modalHead}>
                <h3 className={styles.modalTitle}>{clusterErrorModal.title}</h3>
                <button
                  type="button"
                  className={styles.iconButton}
                  aria-label="Close"
                  onClick={() => setClusterErrorModal(null)}
                >
                  <Icon.X className={styles.icon20} />
                </button>
              </div>
              <div className={styles.modalBody}>
                <p style={{ margin: 0, lineHeight: 1.55 }}>{clusterErrorModal.message}</p>
                {clusterErrorModal.detail ? (
                  <pre className={styles.clusterModalDetail}>{clusterErrorModal.detail}</pre>
                ) : null}
              </div>
              <div className={styles.modalFooter}>
                <button
                  type="button"
                  className={styles.button}
                  onClick={() => setClusterErrorModal(null)}
                >
                  Got it
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {clusterScheduleModal ? (
          <div
            className={styles.modalBackdrop}
            role="dialog"
            aria-modal="true"
            aria-label="Schedule cluster articles"
          >
            <div className={styles.modalPanel}>
              <div className={styles.modalHead}>
                <h3 className={styles.modalTitle}>
                  Schedule {clusterScheduleModal.topicIds ? `${clusterScheduleModal.topicIds.length} topic${clusterScheduleModal.topicIds.length === 1 ? "" : "s"}` : "all pending topics"}
                </h3>
                <button
                  type="button"
                  className={styles.iconButton}
                  aria-label="Close"
                  onClick={() => setClusterScheduleModal(null)}
                  disabled={clusterScheduleModal.busy}
                >
                  <Icon.X className={styles.icon20} />
                </button>
              </div>
              <div className={styles.modalBody}>
                <p className={styles.muted} style={{ marginTop: 0, lineHeight: 1.55 }}>
                  Each topic will be imported as a pending article and queued for the scheduler.
                  Subsequent imports are staggered 5 minutes apart so WordPress doesn&apos;t reject
                  them for rate limiting.
                </p>
                <label className={styles.label}>
                  Start time
                  <input
                    type="datetime-local"
                    className={styles.input}
                    value={clusterScheduleModal.runAt}
                    step={300}
                    onChange={(e) =>
                      setClusterScheduleModal((m) => (m ? { ...m, runAt: e.target.value } : m))
                    }
                  />
                  <div className={styles.muted} style={{ fontSize: 12, marginTop: 6 }}>
                    Times are interpreted in your profile timezone. Minimum 5 minutes from now.
                  </div>
                </label>
                <label className={styles.label}>
                  WordPress status on publish
                  <select
                    className={styles.input}
                    value={clusterScheduleModal.wpStatus}
                    onChange={(e) =>
                      setClusterScheduleModal((m) =>
                        m ? { ...m, wpStatus: e.target.value as "draft" | "publish" } : m,
                      )
                    }
                  >
                    <option value="draft">Draft (review on WordPress before going live)</option>
                    <option value="publish">Publish immediately at the scheduled time</option>
                  </select>
                </label>
              </div>
              <div className={styles.modalFooter}>
                <button
                  type="button"
                  className={styles.btnSecondary}
                  onClick={() => setClusterScheduleModal(null)}
                  disabled={clusterScheduleModal.busy}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className={styles.button}
                  onClick={() => void confirmScheduleForCluster()}
                  disabled={clusterScheduleModal.busy || !clusterScheduleModal.runAt}
                >
                  {clusterScheduleModal.busy ? "Scheduling…" : "Schedule"}
                </button>
              </div>
            </div>
          </div>
        ) : null}
          </section>
        </div>
      </main>
    </div>
  );
}

