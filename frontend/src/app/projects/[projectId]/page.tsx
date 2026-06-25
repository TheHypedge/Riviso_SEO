"use client";

import Image from "next/image";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import styles from "../../page.module.css";
import projectsDark from "../projectsDark.module.css";
import { CategorySelect } from "@/components/CategorySelect";
import { ArticlesOverview } from "@/components/ArticlesOverview";
import { AnalyticsPanelSkeleton, ArticlesTableSkeleton, FormFieldsSkeleton, InlineListSkeleton, TextLinesSkeleton } from "@/components/skeleton";
import { BulkScheduleForm, type BulkScheduleFormValues } from "@/components/bulkSchedule/BulkScheduleForm";
import { BulkScheduleModal } from "@/components/bulkSchedule/BulkScheduleModal";
import {
  articleIdForClusterTopic,
  buildClusterScheduleSeeds,
} from "@/components/bulkSchedule/clusterScheduleUtils";
import type { BulkScheduleSeedRow } from "@/components/bulkSchedule/useBulkScheduleForm";
import { connectionErrorMessage, isAuthError } from "@/lib/networkErrors";
import { useFocusTrap } from "@/lib/useFocusTrap";
import {
  api,
  ApiError,
  ArticleListItem,
  ArticlePublic,
  BulkUploadRow,
  clearAuth,
  CollaboratorPublic,
  CollaboratorRole,
  downloadWordpressPlugin,
  getAccessToken,
  InvitationPublic,
  invalidateProjectSettingsCache,
  MembersResponse,
  mergeTopicClusterInList,
  PromptListResponse,
  ResearchIdeaRow as ApiResearchIdeaRow,
  TOPIC_CLUSTER_BUSY_STATUSES,
  TopicCluster,
} from "@/lib/api";
import { COUNTRIES, DEFAULT_COUNTRY_CODE } from "@/lib/countries";
import {
  AUDIENCE_PRESETS,
  BRAND_TONES,
  BRAND_VOICES,
  citiesForCountry,
} from "@/lib/brand_dictionaries";
import { useClusterValidation, type ValidatableTopic } from "@/hooks/useClusterValidation";
import { parseDatetimeLocal } from "@/lib/bulkScheduleDates";
import { scheduleMinFromNowMs } from "@/lib/scheduleTiming";
import { ProjectTabIcon, SidebarBackIcon, type ProjectTabKey } from "@/components/ProjectTabIcon";
import { ShopifyProjectSettings } from "@/components/ShopifyProjectSettings";
import { ShopifyProductMapPicker } from "@/components/shopify/ShopifyProductMapPicker";
import { resolveProjectPlatform } from "@/lib/projectPlatform";
import type { MappedShopifyProduct } from "@/lib/shopifyProductMapping";

type StatusFilter = "" | "pending" | "draft" | "scheduled" | "published";

type TabKey =
  | "overview"
  | "articles"
  | "products"
  | "research"
  | "scheduled_articles"
  | "prompts"
  | "context_links"
  | "tools"
  | "performance"
  | "project_settings"
  | "members";

type ResearchSubTabKey = "cluster" | "curations";

// Whitelist of valid tab values from the URL — anything else falls back to the
// default. Keeping the source of truth here (vs. re-deriving from ``tabLabel``
// inside the component) lets the lazy ``useState`` initializer read the URL
// before the component body runs.
const TAB_KEYS: ReadonlySet<TabKey> = new Set<TabKey>([
  "overview",
  "articles",
  "products",
  "research",
  "scheduled_articles",
  "prompts",
  "context_links",
  "tools",
  "performance",
  "project_settings",
  "members",
]);

/** Sidebar section order — Overview appears directly above Articles. */
const SIDEBAR_TAB_ORDER: TabKey[] = [
  "overview",
  "articles",
  "products",
  "research",
  "scheduled_articles",
  "prompts",
  "context_links",
  "tools",
  "performance",
  "members",
  "project_settings",
];

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

function addMinutesToDatetimeLocal(value: string, minutes: number) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  d.setMinutes(d.getMinutes() + minutes);
  return toDatetimeLocalValue(d);
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
  height?: number;
  visible?: { clicks: boolean; impressions: boolean; position: boolean };
}) {
  const { series, markers } = props;
  const visible = props.visible ?? { clicks: true, impressions: true, position: false };
  const W = 920;
  const H = props.height ?? 420;
  const padL = 52;
  const padR = visible.position ? 46 : 12;
  const padT = 16;
  const padB = 44;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  const gridStroke = "var(--aa-hairline)";
  const plotOutline = "color-mix(in oklab, var(--aa-hairline), transparent 35%)";
  const axisFill = "var(--aa-muted)";
  const lineClicks = "var(--aa-primary)";
  const lineImpr = "#5b9cf6";
  const linePos = "#b97dff";
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
  const maxPos = Math.max(1, ...series.map((p) => p.position || 0));
  const minPos = Math.min(...series.map((p) => p.position || 0).filter((v) => v > 0));

  const yClicks = (v: number) => padT + innerH - (innerH * (v || 0)) / maxClicks;
  const yImpr = (v: number) => padT + innerH - (innerH * (v || 0)) / maxImpr;
  // For position, lower is better; invert so better = higher on chart
  const posRange = Math.max(1, maxPos - Math.min(0, minPos - 1));
  const yPos = (v: number) => padT + innerH - (innerH * (maxPos - (v || maxPos))) / posRange;

  const clicksPath = series.map((p, i) => `${i === 0 ? "M" : "L"} ${xIndex(i).toFixed(1)} ${yClicks(p.clicks).toFixed(1)}`).join(" ");
  const imprPath = series.map((p, i) => `${i === 0 ? "M" : "L"} ${xIndex(i).toFixed(1)} ${yImpr(p.impressions).toFixed(1)}`).join(" ");
  const posPath = series.map((p, i) => `${i === 0 ? "M" : "L"} ${xIndex(i).toFixed(1)} ${yPos(p.position).toFixed(1)}`).join(" ");

  const tickCount = 5;
  const yTicks = Array.from({ length: tickCount + 1 }, (_, i) => Math.round((maxClicks * i) / tickCount));

  const labelEvery = Math.max(1, Math.floor(series.length / 7));
  const xLabels = series
    .map((p, i) => ({ p, i }))
    .filter(({ i }) => i % labelEvery === 0 || i === series.length - 1);

  const dateToIndex = new Map<string, number>();
  dates.forEach((d, i) => dateToIndex.set(d, i));

  const markerDots = markers
    .map((m) => ({ ...m, idx: dateToIndex.get(m.date) }))
    .filter((m) => typeof m.idx === "number") as Array<import("@/lib/api").GscAnalyticsMarker & { idx: number }>;

  // Position right-axis ticks
  const posTicks = Array.from({ length: tickCount + 1 }, (_, i) => {
    const v = minPos + ((maxPos - minPos) * i) / tickCount;
    return Math.round(v * 10) / 10;
  }).reverse();

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="Search Console traffic over time with article publication markers"
      style={{ display: "block", width: "100%", height: "auto", maxWidth: "100%", minHeight: 240 }}
    >
      <rect x={padL} y={padT} width={innerW} height={innerH} fill="transparent" stroke={plotOutline} strokeWidth={1} />
      {yTicks.map((v, i) => {
        const y = padT + innerH - (innerH * i) / tickCount;
        return (
          <g key={`yt-${i}`}>
            <line x1={padL} y1={y} x2={padL + innerW} y2={y} stroke={gridStroke} strokeDasharray="2 4" strokeOpacity={0.85} />
            <text
              x={padL - 8}
              y={y + 4}
              textAnchor="end"
              fontSize={11}
              fill={axisFill}
              style={{ fontFamily: "var(--aa-font-ui)" }}
            >
              {v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k` : v.toLocaleString()}
            </text>
          </g>
        );
      })}
      {visible.position && posTicks.map((v, i) => {
        const y = padT + innerH - (innerH * (tickCount - i)) / tickCount;
        return (
          <text
            key={`ryt-${i}`}
            x={padL + innerW + 8}
            y={y + 4}
            textAnchor="start"
            fontSize={10}
            fill={linePos}
            fillOpacity={0.8}
            style={{ fontFamily: "var(--aa-font-ui)" }}
          >
            #{v.toFixed(0)}
          </text>
        );
      })}
      {xLabels.map(({ p, i }) => (
        <text
          key={`xl-${i}`}
          x={xIndex(i)}
          y={H - 12}
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
            <circle cx={x} cy={padT + 8} r={5} fill={markerDot} stroke={pointRing} strokeWidth={1.25}>
              <title>{`${m.title || "Article"} — published ${m.date}\n${m.url}`}</title>
            </circle>
          </g>
        );
      })}
      {visible.impressions && (
        <path d={imprPath} fill="none" stroke={lineImpr} strokeWidth={2} strokeOpacity={0.85} strokeLinecap="round" strokeLinejoin="round" />
      )}
      {visible.clicks && (
        <path d={clicksPath} fill="none" stroke={lineClicks} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
      )}
      {visible.position && (
        <path d={posPath} fill="none" stroke={linePos} strokeWidth={2} strokeOpacity={0.85} strokeLinecap="round" strokeLinejoin="round" />
      )}
      {visible.impressions && series.map((p, i) => (
        <circle
          key={`im-${i}`}
          cx={xIndex(i)}
          cy={yImpr(p.impressions)}
          r={series.length > 60 ? 2.5 : 3.5}
          fill={lineImpr}
          stroke={pointRing}
          strokeWidth={1}
          fillOpacity={0.9}
        >
          <title>{`${p.date}\nImpressions: ${p.impressions}`}</title>
        </circle>
      ))}
      {visible.clicks && series.map((p, i) => (
        <circle key={`cl-${i}`} cx={xIndex(i)} cy={yClicks(p.clicks)} r={series.length > 60 ? 3 : 4.5} fill={lineClicks} stroke={pointRing} strokeWidth={1.25}>
          <title>{`${p.date}\nClicks: ${p.clicks}\nImpressions: ${p.impressions}\nPosition: ${(p.position || 0).toFixed(1)}`}</title>
        </circle>
      ))}
      {visible.position && series.map((p, i) => (
        <circle key={`pos-${i}`} cx={xIndex(i)} cy={yPos(p.position)} r={series.length > 60 ? 2.5 : 3.5} fill={linePos} stroke={pointRing} strokeWidth={1} fillOpacity={0.9}>
          <title>{`${p.date}\nAvg position: ${(p.position || 0).toFixed(1)}`}</title>
        </circle>
      ))}
    </svg>
  );
}

type InsightTrendRow = {
  key: string;
  primary: ReactNode;
  secondary?: ReactNode;
  clicks: number;
  changePct: number | null;
};

/**
 * Ranked row list shared by the Insights "Your content" and "Queries leading
 * to your site" panels — one label, one trend chip, one value. Keeping this in
 * a single place means both panels read identically and a future tweak (e.g.
 * a new trend state) only has to land once.
 */
function InsightTrendRows({ rows, emptyLabel }: { rows: InsightTrendRow[]; emptyLabel: string }) {
  if (!rows.length) {
    return <div className={styles.muted} style={{ fontSize: 13 }}>{emptyLabel}</div>;
  }
  return (
    <div className={styles.analyticsRankList}>
      {rows.map((row) => {
        const chg = row.changePct;
        const trend = chg === null ? "flat" : chg > 0 ? "up" : chg < 0 ? "down" : "flat";
        return (
          <div key={row.key} className={styles.analyticsRankRow}>
            <div className={styles.analyticsRankLabel}>
              {row.primary}
              {row.secondary}
            </div>
            <div className={styles.analyticsRankStats}>
              {chg !== null ? (
                <span className={styles.analyticsTrendChip} data-trend={trend}>
                  {trend === "up" ? "↑" : trend === "down" ? "↓" : ""}
                  {Math.abs(chg).toFixed(0)}%
                </span>
              ) : null}
              <span className={styles.analyticsRankValue}>{row.clicks.toLocaleString()}</span>
            </div>
          </div>
        );
      })}
    </div>
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

// ---------------------------------------------------------------------------
// Guided prompt builder — static option sets (mirrors content_brief.py Literals)
// ---------------------------------------------------------------------------
const PB_CONTENT_TYPES = ["Blog Article","How-To Guide","Listicle","Product Review","Comparison Article","News Article","Case Study","Opinion / Editorial","Press Release","Landing Page Copy","Product Description","Buying Guide","Tutorial","Industry Report Summary","FAQ Page","Glossary / Definition Article","Interview-Style Article"] as const;
const PB_INDUSTRIES = ["Legal","Healthcare","Finance","Technology / SaaS","E-commerce / Retail","Real Estate","Education","Travel & Hospitality","Marketing & Advertising","Manufacturing","Food & Beverage","Fitness & Wellness","Automotive","Non-profit","Other / general"] as const;
const PB_TONES = ["Professional","Conversational","Friendly","Authoritative","Witty / humorous","Empathetic","Formal","Inspirational","Technical","Bold / confident"] as const;
const PB_WRITING_STYLES = ["Narrative / storytelling","Descriptive","Persuasive","Expository / informative","Technical / instructional","Conversational / casual"] as const;
const PB_BRAND_TRAITS = ["Innovative","Trustworthy","Bold","Friendly","Premium / luxury","Playful","Authoritative","Minimalist","Empathetic","Quirky"] as const;
const PB_CONTENT_DEPTHS = ["Beginner-friendly overview","Standard / balanced","In-depth / comprehensive","Expert-level / technical"] as const;
const PB_ARTICLE_LENGTHS = ["Short (600-900 words)","Medium (1,000-1,800 words)","Long (1,800-3,000 words)","Comprehensive (3,000+ words)"] as const;
const PB_EEAT_OPTIONS = ["Add Expert Opinions","Add Statistics","Add Research","Add Case Studies","Add Real Examples","Add Industry Benchmarks","Add FAQs"] as const;
const PB_SEO_OPTIONS = ["Generate Meta Title","Generate Meta Description","Generate FAQ Schema","Generate Article Schema","Generate Internal Linking","Optimize for Featured Snippet","Generate Social Snippets","Generate Image Alt Text"] as const;
const PB_RESTRICTIONS = ["No competitor mentions","No pricing or cost claims","No medical, legal, or financial advice claims","No first-person voice ('I', 'we')","No emojis","No exclamation points","Avoid superlatives ('best', '#1', 'guaranteed')","No fabricated statistics, names, or citations"] as const;

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
  const [overviewArticles, setOverviewArticles] = useState<ArticlePublic[]>([]);
  const [overviewScheduledJobs, setOverviewScheduledJobs] = useState<import("@/lib/api").ScheduledJobPublic[]>([]);
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [overviewRefreshKey, setOverviewRefreshKey] = useState(0);
  const [overviewRefreshedAt, setOverviewRefreshedAt] = useState<number | null>(null);

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
        view: null,
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
    const rawView = (searchParams?.get("view") || "").toLowerCase();

    let nextTab: TabKey = TAB_KEYS.has(rawTab as TabKey) ? (rawTab as TabKey) : "articles";
    if (!rawTab && rawView === "overview") nextTab = "overview";
    if (!rawTab && rawView && ["pending", "draft", "scheduled", "published"].includes(rawView)) {
      nextTab = "articles";
      setStatus(rawView as StatusFilter);
    }

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
  // List of every project the user owns. Powers the in-sidebar project
  // switcher so users can hop between projects without bouncing through
  // the dashboard. Loaded once per mount; refreshed silently when a
  // rename happens (see ``saveSettings``).
  const [projectsList, setProjectsList] = useState<import("@/lib/api").ProjectPublic[]>([]);
  const listProject = useMemo(
    () => projectsList.find((p) => p.id === projectId) ?? null,
    [projectsList, projectId],
  );
  const platformUrlHint = (searchParams.get("platform") || "").trim().toLowerCase();
  const projectPlatform = useMemo(
    () =>
      resolveProjectPlatform({
        settings,
        meta: projectMeta,
        listItem: listProject,
        urlHint: platformUrlHint,
      }),
    [settings, projectMeta, listProject, platformUrlHint],
  );
  const isShopifyProject = projectPlatform === "shopify";
  const [featureLimits, setFeatureLimits] = useState<import("@/lib/api").ProjectFeatureLimits | null>(null);
  const [articleQuota, setArticleQuota] = useState<import("@/lib/api").ArticleQuota | null>(null);
  const [websiteConnectionModal, setWebsiteConnectionModal] = useState<{
    title: string;
    message: string;
  } | null>(null);
  const websiteConnectionModalTrapRef = useFocusTrap(!!websiteConnectionModal);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsVerify, setSettingsVerify] = useState<import("@/lib/api").WordpressVerifyResponse | null>(null);
  const [settingsVerifying, setSettingsVerifying] = useState(false);
  const [confirmDeleteProject, setConfirmDeleteProject] = useState(false);
  const confirmDeleteProjectTrapRef = useFocusTrap(confirmDeleteProject);
  const [deletingProject, setDeletingProject] = useState(false);
  const [toast, setToast] = useState<{ message: string; tone: "success" | "error" } | null>(null);
  const toastTimerRef = useRef<number | null>(null);

  // Members tab state
  const [membersData, setMembersData] = useState<MembersResponse | null>(null);
  const [membersLoading, setMembersLoading] = useState(false);
  const [membersInviteEmail, setMembersInviteEmail] = useState("");
  const [membersInviteRole, setMembersInviteRole] = useState<CollaboratorRole>("editor");
  const [membersInviteBusy, setMembersInviteBusy] = useState(false);
  const [membersInviteError, setMembersInviteError] = useState<string | null>(null);
  const [membersRoleChangeBusy, setMembersRoleChangeBusy] = useState<string | null>(null);
  const [membersRemoveBusy, setMembersRemoveBusy] = useState<string | null>(null);
  const [membersResendBusy, setMembersResendBusy] = useState<string | null>(null);
  const [membersCancelBusy, setMembersCancelBusy] = useState<string | null>(null);

  // Shared accessible replacement for window.confirm — focus-trapped, themed,
  // and keyboard-dismissible, so destructive/disruptive actions across every
  // tab go through one consistent, on-brand confirmation surface.
  const [confirmPrompt, setConfirmPrompt] = useState<{
    title: string;
    body: string;
    confirmLabel: string;
    danger?: boolean;
    onConfirm: () => void;
  } | null>(null);
  const confirmPromptTrapRef = useFocusTrap(!!confirmPrompt);
  function askConfirm(opts: { title: string; body: string; confirmLabel?: string; danger?: boolean; onConfirm: () => void }) {
    setConfirmPrompt({
      title: opts.title,
      body: opts.body,
      confirmLabel: opts.confirmLabel || "Confirm",
      danger: opts.danger,
      onConfirm: opts.onConfirm,
    });
  }

  async function refreshFeatureLimits() {
    try {
      const limits = await api.projectFeatureLimits(projectId);
      setFeatureLimits(limits);
      return limits;
    } catch {
      return null;
    }
  }

  async function refreshArticleQuota() {
    try {
      const quota = await api.articleQuota(projectId, { fresh: true });
      setArticleQuota(quota);
      return quota;
    } catch {
      return null;
    }
  }

  const [sName, setSName] = useState("");
  const [sShopifyClientId, setSShopifyClientId] = useState("");
  const [sUrl, setSUrl] = useState("");
  const [sShopifyProductAware, setSShopifyProductAware] = useState(false);
  const [sWpInternalLinkAware, setSWpInternalLinkAware] = useState(false);
  const [sWpUser, setSWpUser] = useState("");
  const [sWpPass, setSWpPass] = useState("");
  const [showWpAppPassword, setShowWpAppPassword] = useState(false);
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
  const gscDisconnectModalTrapRef = useFocusTrap(gscConfirmDisconnect);
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
  const [indexingArticles, setIndexingArticles] = useState<ArticlePublic[]>([]);
  const [indexingArticlesLoading, setIndexingArticlesLoading] = useState(false);
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
  // Sub-tab within Performance & Analysis: "overview" = chart/top pages, "insights" = GSC Insights panel
  const [performanceSubTab, setPerformanceSubTab] = useState<"overview" | "insights">("overview");
  const [insights, setInsights] = useState<import("@/lib/api").GscInsightsResponse | null>(null);
  const [insightsBusy, setInsightsBusy] = useState<boolean>(false);
  const [insightsErr, setInsightsErr] = useState<string | null>(null);
  // Insights content sub-tabs (pages / queries)
  const [insightsPagesTab, setInsightsPagesTab] = useState<"top" | "up" | "down">("top");
  const [insightsQueriesTab, setInsightsQueriesTab] = useState<"top" | "up" | "down">("top");
  // Chart series visibility toggles
  const [chartSeries, setChartSeries] = useState<{ clicks: boolean; impressions: boolean; position: boolean }>({ clicks: true, impressions: true, position: false });
  // Top pages table: search + sort
  const [topPagesSearch, setTopPagesSearch] = useState<string>("");
  const [topPagesSortKey, setTopPagesSortKey] = useState<"clicks" | "impressions" | "ctr" | "position">("clicks");
  const [topPagesSortDir, setTopPagesSortDir] = useState<"asc" | "desc">("desc");

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
  const clusterErrorModalTrapRef = useFocusTrap(!!clusterErrorModal);
  const [researchScheduleModal, setResearchScheduleModal] = useState<
    | {
        kind: "cluster";
        clusterId: string;
        topicIds: string[] | null;
        seedRows: BulkScheduleSeedRow[];
      }
    | {
        kind: "curation";
        ideaIds: string[];
        seedRows: BulkScheduleSeedRow[];
      }
    | null
  >(null);
  const [researchScheduleBusy, setResearchScheduleBusy] = useState(false);
  const [researchScheduleError, setResearchScheduleError] = useState<string | null>(null);
  const [clusterGeneratePromptModal, setClusterGeneratePromptModal] = useState<{
    clusterId: string;
    topicIds: string[] | null;
    pendingCount: number;
    writingPromptId: string;
    imagePromptId: string;
    mappedProducts: MappedShopifyProduct[];
    step: "prompts" | "products";
    busy: boolean;
  } | null>(null);
  const [curationPromptModal, setCurationPromptModal] = useState<{
    ideaIds: string[];
    writingPromptId: string;
    imagePromptId: string;
    mappedProducts: MappedShopifyProduct[];
    step: "prompts" | "products";
    busy: boolean;
  } | null>(null);
  const clusterGeneratePromptModalTrapRef = useFocusTrap(!!clusterGeneratePromptModal);
  const curationPromptModalTrapRef = useFocusTrap(!!curationPromptModal);

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
  const wpPassLoadedRef = useRef<string>("");
  function normalizeUrlForDirtyCheck(raw: string) {
    const s = (raw || "").trim();
    if (!s) return "";
    return s.replace(/\/+$/, "");
  }
  function normalizePasswordForDirtyCheck(raw: string) {
    return (raw || "").replace(/\s+/g, "").trim();
  }
  const settingsDirty = useMemo(() => {
    if (!settings) return false;
    if (isShopifyProject) {
      return (
        sName.trim() !== (settings.name || "").trim() ||
        normalizeUrlForDirtyCheck(sUrl || "") !== normalizeUrlForDirtyCheck(settings.website_url || "") ||
        (sShopifyClientId || "").trim() !== (settings.shopify_client_id || "").trim() ||
        Boolean(sShopifyProductAware) !== Boolean(settings.shopify_product_aware_enabled)
      );
    }
    const baseUrl = settings.wp_site_url || settings.website_url || "";
    return (
      sName.trim() !== (settings.name || "").trim() ||
      normalizeUrlForDirtyCheck(sUrl || "") !== normalizeUrlForDirtyCheck(baseUrl) ||
      (sWpUser || "") !== (settings.wp_username || "") ||
      (sWpDefaultPostType || "") !== ((settings.default_wp_rest_base || "posts") as string) ||
      (sWpDefaultStatus || "") !== ((settings.default_wp_status || "draft") as string) ||
      JSON.stringify((sWpDefaultCategoryIds || []).slice().sort((a, b) => a - b)) !==
        JSON.stringify(((settings.default_wp_category_ids || []) as number[]).slice().sort((a, b) => a - b)) ||
      normalizePasswordForDirtyCheck(sWpPass) !== wpPassLoadedRef.current ||
      Boolean(sWpInternalLinkAware) !== Boolean(settings.wp_internal_link_aware_enabled)
    );
  }, [
    sName,
    sUrl,
    sShopifyClientId,
    sShopifyProductAware,
    sWpInternalLinkAware,
    sWpUser,
    sWpPass,
    settings,
    sWpDefaultPostType,
    sWpDefaultStatus,
    sWpDefaultCategoryIds,
    isShopifyProject,
  ]);

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
  const [listItems, setListItems] = useState<ArticleListItem[]>([]);
  const [listTotal, setListTotal] = useState(0);
  const [articlesListLoading, setArticlesListLoading] = useState(false);
  const [articleTitlesById, setArticleTitlesById] = useState<Record<string, string>>({});
  const [selectedMeta, setSelectedMeta] = useState<Record<string, { title: string }>>({});
  const [debouncedQ, setDebouncedQ] = useState("");
  const [scheduledJobs, setScheduledJobs] = useState<import("@/lib/api").ScheduledJobPublic[]>([]);
  const [scheduledLoading, setScheduledLoading] = useState(false);
  const [retryPrepBusyId, setRetryPrepBusyId] = useState<string | null>(null);
  const [retryAllFailedBusy, setRetryAllFailedBusy] = useState(false);
  const [scheduledSearch, setScheduledSearch] = useState("");
  const [scheduledOrder, setScheduledOrder] = useState<"desc" | "asc">("desc");
  const [shopifyCatalog, setShopifyCatalog] = useState<Awaited<ReturnType<typeof api.getShopifyCatalog>> | null>(null);
  const [shopifyCatalogLoading, setShopifyCatalogLoading] = useState(false);
  const [shopifyCatalogSyncing, setShopifyCatalogSyncing] = useState(false);
  const [shopifyCatalogErr, setShopifyCatalogErr] = useState<string | null>(null);
  const [shopifyCatalogNotice, setShopifyCatalogNotice] = useState<string | null>(null);
  const [shopifyProductStatus, setShopifyProductStatus] = useState<"" | "active" | "draft" | "archived">("");
  const [title, setTitle] = useState("");
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
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
  const [bulkScheduleSeedRows, setBulkScheduleSeedRows] = useState<BulkScheduleSeedRow[]>([]);
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
  const researchDupModalTrapRef = useFocusTrap(!!researchImportDupModal);

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
  const [promptsSaveSuccess, setPromptsSaveSuccess] = useState(false);
  const [showPromptModal, setShowPromptModal] = useState<null | { kind: "writing" | "image"; id: string }>(null);
  const [draftName, setDraftName] = useState("");
  const [draftText, setDraftText] = useState("");
  const [draftSetDefault, setDraftSetDefault] = useState(false);
  // Guided prompt builder state
  const [promptBuilderMode, setPromptBuilderMode] = useState<"manual" | "guided">("manual");
  const [builderBuilding, setBuilderBuilding] = useState(false);
  const [builderError, setBuilderError] = useState("");
  const [pbContentType, setPbContentType] = useState<string>("Blog Article");
  const [pbTargetAudience, setPbTargetAudience] = useState("");
  const [pbIndustry, setPbIndustry] = useState<string>("Other / general");
  const [pbToneOfVoice, setPbToneOfVoice] = useState<string>("Professional");
  const [pbWritingStyle, setPbWritingStyle] = useState<string>("Expository / informative");
  const [pbBrandPersonality, setPbBrandPersonality] = useState<string[]>([]);
  const [pbContentDepth, setPbContentDepth] = useState<string>("Standard / balanced");
  const [pbArticleLength, setPbArticleLength] = useState<string>("Medium (1,000-1,800 words)");
  const [pbEeatSettings, setPbEeatSettings] = useState<string[]>([]);
  const [pbSeoSettings, setPbSeoSettings] = useState<string[]>([]);
  const [pbContentRestrictions, setPbContentRestrictions] = useState<string[]>([]);
  const [pbUseWebsiteData, setPbUseWebsiteData] = useState(true);
  const [pbAdditionalInstructions, setPbAdditionalInstructions] = useState("");
  // Delete confirm for prompts (replaces window.confirm)
  const [deletePromptTarget, setDeletePromptTarget] = useState<{ kind: "writing" | "image"; id: string } | null>(null);

  // Context links module state (staged edits; saved on demand)
  type LinkDraft = { id: string; label: string; url: string; isNew?: boolean };
  const [linksLoading, setLinksLoading] = useState(false);
  const [linksSaving, setLinksSaving] = useState(false);
  const [linkDrafts, setLinkDrafts] = useState<LinkDraft[]>([]);
  const [linkDeleted, setLinkDeleted] = useState<Set<string>>(new Set());
  const [showLinkModal, setShowLinkModal] = useState<null | { id: string; isNew: boolean }>(null);
  const linkModalTrapRef = useFocusTrap(!!showLinkModal);
  const promptModalTrapRef = useFocusTrap(!!showPromptModal);
  const deletePromptTrapRef = useFocusTrap(!!deletePromptTarget);
  const [linkPhrase, setLinkPhrase] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
  const [linkSearch, setLinkSearch] = useState("");
  const [linkPage, setLinkPage] = useState(1);
  const [linkDuplicateConflicts, setLinkDuplicateConflicts] = useState<Array<{ phrase: string; conflict: LinkDraft }>>([]);
  const [linkSaveAttempted, setLinkSaveAttempted] = useState(false);

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
  // sessionStorage key for this project's WP categories (5-min client-side TTL).
  // Using a module-level constant avoids recreating the string on every render.
  const _wpCatsCacheKey = `rvs_cats_${projectId}`;

  const [wpCatsForSchedule, setWpCatsForSchedule] = useState<import("@/lib/api").WordpressCategory[]>(() => {
    // Read synchronously from sessionStorage so the dropdown is available on the
    // very first render — avoids waiting for the external WP API round-trip.
    try {
      const raw = sessionStorage.getItem(_wpCatsCacheKey);
      if (raw) {
        const { ts, data } = JSON.parse(raw) as { ts: number; data: import("@/lib/api").WordpressCategory[] };
        if (Date.now() - ts < 5 * 60 * 1000) return data;
        sessionStorage.removeItem(_wpCatsCacheKey);
      }
    } catch { /* ignore parse or storage errors */ }
    return [];
  });
  const [articleCategoryEdits, setArticleCategoryEdits] = useState<Record<string, string>>({});
  const [categorySaveBusy, setCategorySaveBusy] = useState(false);
  const [categorySaveError, setCategorySaveError] = useState<string | null>(null);
  const [wpCatsSyncDone, setWpCatsSyncDone] = useState(false);
  // false when sessionStorage pre-populated; true otherwise (shows "Loading" instead of "—").
  const [wpCatsLoading, setWpCatsLoading] = useState<boolean>(() => {
    try {
      const raw = sessionStorage.getItem(_wpCatsCacheKey);
      if (raw) {
        const { ts } = JSON.parse(raw) as { ts: number };
        if (Date.now() - ts < 5 * 60 * 1000) return false;
      }
    } catch { /* ignore */ }
    return true;
  });
  const [scheduleWritingPrompts, setScheduleWritingPrompts] = useState<PromptListResponse | null>(null);
  const [scheduleImagePrompts, setScheduleImagePrompts] = useState<PromptListResponse | null>(null);
  const [scheduleWritingPromptId, setScheduleWritingPromptId] = useState<string>("");
  const [scheduleImagePromptId, setScheduleImagePromptId] = useState<string>("");

  const [editJob, setEditJob] = useState<null | import("@/lib/api").ScheduledJobPublic>(null);
  const [editJobWhen, setEditJobWhen] = useState("");
  const [editJobPostType, setEditJobPostType] = useState("posts");
  const [editJobStatus, setEditJobStatus] = useState<"draft" | "publish">("draft");
  const [editJobCats, setEditJobCats] = useState<number[]>([]);
  const [editJobWritingPromptId, setEditJobWritingPromptId] = useState("");
  const [editJobImagePromptId, setEditJobImagePromptId] = useState("");
  const [editJobGenerateImage, setEditJobGenerateImage] = useState(true);
  const [editRescheduleBusy, setEditRescheduleBusy] = useState(false);
  const [confirmCancelJob, setConfirmCancelJob] = useState<null | import("@/lib/api").ScheduledJobPublic>(null);
  const [confirmPostNowJob, setConfirmPostNowJob] = useState<null | import("@/lib/api").ScheduledJobPublic>(null);
  const [postNowWritingPromptId, setPostNowWritingPromptId] = useState("");
  const [postNowImagePromptId, setPostNowImagePromptId] = useState("");
  const [postNowGenerateImage, setPostNowGenerateImage] = useState(true);
  const [postNowBusy, setPostNowBusy] = useState(false);
  const [postNowPhase, setPostNowPhase] = useState<"idle" | "generating" | "publishing">("idle");

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
    if (!Object.keys(articleTitlesById).length) return;
    const titleToId = new Map<string, string>();
    for (const [id, title] of Object.entries(articleTitlesById)) {
      const k = (title || "").trim().toLowerCase();
      if (!k) continue;
      if (!titleToId.has(k)) titleToId.set(k, id);
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
  }, [articleTitlesById, researchHydrated, researchResults]);

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQ(q), 300);
    return () => window.clearTimeout(t);
  }, [q]);

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
      router.replace("/");
      return;
    }
    (async () => {
      setError(null);
      setLoading(true);
      try {
        const skipSettingsHere = tab === "project_settings";
        const [ps, prof, limits, quota, pm] = await Promise.all([
          skipSettingsHere
            ? Promise.resolve(null)
            : api.getProjectSettings(projectId, { skipGlobalLoading: true }),
          api.profileMe({ skipGlobalLoading: true }),
          api.projectFeatureLimits(projectId, { skipGlobalLoading: true }).catch(() => null),
          api.articleQuota(projectId, { skipGlobalLoading: true }).catch(() => null),
          api.getProject(projectId, { skipGlobalLoading: true }).catch(() => null),
        ]);
        if (ps) {
          setSettings(ps);
          // Sync local form fields so settingsDirty doesn't report a false
          // positive before the user has visited the project_settings tab.
          setSName(ps.name || "");
          setSWpUser(ps.wp_username || "");
          const initPass = ps.wp_app_password || "";
          wpPassLoadedRef.current = normalizePasswordForDirtyCheck(initPass);
          setSWpPass(initPass);
          setSWpDefaultPostType((ps.default_wp_rest_base || "posts") as string);
          setSWpDefaultStatus((ps.default_wp_status || "draft") as "draft" | "publish");
          setSWpDefaultCategoryIds((ps.default_wp_category_ids || []) as number[]);
          setSWpInternalLinkAware(Boolean(ps.wp_internal_link_aware_enabled));
          setSShopifyClientId(ps.shopify_client_id || "");
          setSShopifyProductAware(Boolean(ps.shopify_product_aware_enabled));
        }
        if (pm) {
          setProjectMeta(pm);
          const plat = resolveProjectPlatform({ settings: ps, meta: pm });
          if (plat === "shopify") {
            setSUrl((ps?.website_url || pm.website_url || "").trim());
          } else if (ps) {
            setSUrl((ps.wp_site_url || ps.website_url || "").trim());
          }
        }
        setFeatureLimits(limits);
        setArticleQuota(quota);
        setProfile(prof);
        setProfileTz((prof?.timezone || "").trim());
        if (ps) {
          setWpDefaults({
            post_type: (ps.default_wp_rest_base || "posts") as string,
            wp_status: ((ps.default_wp_status || "draft") as "draft" | "publish"),
          });
        }
      } catch (e) {
        if (isAuthError(e)) {
          clearAuth();
          router.replace("/");
          return;
        }
        setError(connectionErrorMessage(e));
      } finally {
        setLoading(false);
      }
    })();
    // P2.8: load the project shell (settings/profile/limits/quota/meta) once per
    // project — not on every tab switch. The settings tab refetches its own data,
    // so `tab` is intentionally excluded from the dependency list here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, router, token]);

  useEffect(() => {
    if (!token || !projectId) return;
    let cancelled = false;
    (async () => {
      try {
        const titles = await api.listArticleTitles(projectId);
        if (cancelled) return;
        const map: Record<string, string> = {};
        for (const row of titles || []) {
          if (row.id) map[row.id] = row.title || "";
        }
        setArticleTitlesById(map);
      } catch {
        // Non-fatal — scheduled tab falls back to "(Untitled article)".
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, token]);

  useEffect(() => {
    if (!token || !projectId || tab !== "articles") return;
    let cancelled = false;
    (async () => {
      setArticlesListLoading(true);
      try {
        const res = await api.listArticlesPage(projectId, {
          page,
          per_page: pageSize,
          q: debouncedQ.trim() || undefined,
          status: status || undefined,
          date_from: dateFrom || undefined,
          date_to: dateTo || undefined,
          sort: dateOrder,
        });
        if (cancelled) return;
        setListItems(res.items || []);
        setListTotal(res.total || 0);
      } catch (e) {
        if (!cancelled) {
          if (isAuthError(e)) {
            clearAuth();
            router.replace("/");
            return;
          }
          setError(connectionErrorMessage(e));
        }
      } finally {
        if (!cancelled) setArticlesListLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, router, token, tab, page, pageSize, debouncedQ, status, dateFrom, dateTo, dateOrder]);

  useEffect(() => {
    if (tab !== "articles" || isShopifyProject || wpCatsForSchedule.length > 0 || !projectId) {
      // Shopify projects never fetch WP categories — clear loading immediately.
      if (isShopifyProject) setWpCatsLoading(false);
      return;
    }
    let cancelled = false;
    const doFetch = (isRetry: boolean) => {
      if (cancelled) return;
      setWpCatsLoading(true);
      // No opts — uses default 15 s timeout and benefits from in-memory dedup cache.
      api.wordpressCategories(projectId)
        .then((cats) => {
          if (cancelled) return;
          setWpCatsForSchedule(cats);
          setWpCatsLoading(false);
          // Persist to sessionStorage so the next page load shows the dropdown instantly.
          try { sessionStorage.setItem(_wpCatsCacheKey, JSON.stringify({ ts: Date.now(), data: cats })); } catch { /* ignore */ }
          // After categories load, sync wp_category_ids from live WP for articles that are missing it.
          if (!wpCatsSyncDone && cats.length > 0) {
            setWpCatsSyncDone(true);
            api.syncWpCategories(projectId)
              .then((res) => { if (res.synced > 0) refreshArticlesList(); })
              .catch(() => {});
          }
        })
        .catch(() => {
          if (cancelled) return;
          if (!isRetry) {
            // First attempt failed (e.g. backend cold-fetching WP on deploy).
            // Retry once after 5 s — by then the backend has warmed its cache.
            setTimeout(() => doFetch(true), 5000);
          } else {
            setWpCatsLoading(false);
          }
        });
    };
    doFetch(false);
    return () => { cancelled = true; };
  }, [tab, projectId, isShopifyProject, wpCatsForSchedule.length, wpCatsSyncDone]);

  useEffect(() => {
    if (!token || !projectId || tab !== "overview") return;
    let cancelled = false;
    (async () => {
      setOverviewLoading(true);
      try {
        const [articles, jobs] = await Promise.all([
          api.listArticlesAll(projectId),
          api.listScheduledJobsBoard(projectId).catch(() => [] as import("@/lib/api").ScheduledJobPublic[]),
        ]);
        if (cancelled) return;
        setOverviewArticles(articles || []);
        setOverviewScheduledJobs(jobs || []);
        setOverviewRefreshedAt(Date.now());
      } catch {
        if (!cancelled) {
          setOverviewArticles([]);
          setOverviewScheduledJobs([]);
        }
      } finally {
        if (!cancelled) setOverviewLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, token, tab, overviewRefreshKey]);

  useEffect(() => {
    if (!token || !projectId || (tab !== "tools" && tab !== "performance")) return;
    let cancelled = false;
    (async () => {
      setIndexingArticlesLoading(true);
      try {
        const items = await api.listArticlesAll(projectId, { status: "published" });
        if (cancelled) return;
        setIndexingArticles((items || []).filter((a) => (a.wp_link || "").trim()));
      } catch {
        if (!cancelled) setIndexingArticles([]);
      } finally {
        if (!cancelled) setIndexingArticlesLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, tab, token]);

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

  async function ensureScheduleMetaLoaded(): Promise<{
    writingPrompts: PromptListResponse | null;
    imagePrompts: PromptListResponse | null;
    wpTypes: import("@/lib/api").WordpressPostType[];
    wpCats: import("@/lib/api").WordpressCategory[];
  }> {
    const needWpTypes = !isShopifyProject && wpTypesForSchedule.length === 0;
    const needWpCats = !isShopifyProject && wpCatsForSchedule.length === 0;
    const needWritingPrompts = !scheduleWritingPrompts;
    const needImagePrompts = !scheduleImagePrompts;

    if (!needWpTypes && !needWpCats && !needWritingPrompts && !needImagePrompts) {
      return {
        writingPrompts: scheduleWritingPrompts,
        imagePrompts: scheduleImagePrompts,
        wpTypes: wpTypesForSchedule,
        wpCats: wpCatsForSchedule,
      };
    }

    const promptLoad = Promise.allSettled([
      needWritingPrompts ? api.listWritingPrompts(projectId) : Promise.resolve(scheduleWritingPrompts),
      needImagePrompts ? api.listImagePrompts(projectId) : Promise.resolve(scheduleImagePrompts),
    ]).then(([wpRes, ipRes]) => {
      const wp = wpRes.status === "fulfilled" ? wpRes.value : scheduleWritingPrompts;
      const ip = ipRes.status === "fulfilled" ? ipRes.value : scheduleImagePrompts;

      if (wpRes.status === "fulfilled" && wp) {
        setScheduleWritingPrompts(wp);
        setScheduleWritingPromptId((prev) => prev || wp.default_id || "");
      }
      if (ipRes.status === "fulfilled" && ip) {
        setScheduleImagePrompts(ip);
        setScheduleImagePromptId((prev) => prev || ip.default_id || "");
      }

      return {
        writingPrompts: wp || null,
        imagePrompts: ip || null,
      };
    });

    const wpMetaLoad = Promise.allSettled([
      needWpTypes ? api.wordpressPostTypes(projectId, { timeoutMs: 8000 }) : Promise.resolve(wpTypesForSchedule),
      needWpCats ? api.wordpressCategories(projectId, { timeoutMs: 8000 }) : Promise.resolve(wpCatsForSchedule),
    ]).then(([typesRes, catsRes]) => {
      const types = typesRes.status === "fulfilled" ? typesRes.value : wpTypesForSchedule;
      const cats = catsRes.status === "fulfilled" ? catsRes.value : wpCatsForSchedule;
      if (typesRes.status === "fulfilled") setWpTypesForSchedule(types);
      if (catsRes.status === "fulfilled") setWpCatsForSchedule(cats);
      return { wpTypes: types || [], wpCats: cats || [] };
    });

    const [promptResult, wpMetaResult] = await Promise.all([promptLoad, wpMetaLoad]);
    return { ...promptResult, ...wpMetaResult };
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

  function formatBulkScheduleWhenDisplay(when: string): { date: string; time: string; tz: string } {
    const p = parseDatetimeLocal(when);
    if (!p) return { date: (when || "").trim() || "—", time: "", tz: "" };
    const d = new Date(p.y, p.m - 1, p.d);
    const date = new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(d);
    const h12 = p.h % 12 || 12;
    const time = `${h12}:${String(p.min).padStart(2, "0")} ${p.h >= 12 ? "PM" : "AM"}`;
    const tz = profileTz || Intl.DateTimeFormat().resolvedOptions().timeZone;
    return { date, time, tz };
  }

  function formatScheduledRunAt(utcLike: string | null | undefined): { date: string; time: string; tz: string } {
    const v = (utcLike || "").trim();
    if (!v) return { date: "—", time: "", tz: "" };
    const iso = v.includes("T") ? v : v.replace(" ", "T") + "Z";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return { date: v, time: "", tz: "" };
    const tz = profileTz || Intl.DateTimeFormat().resolvedOptions().timeZone;
    try {
      const date = new Intl.DateTimeFormat(undefined, {
        timeZone: tz,
        weekday: "short",
        month: "short",
        day: "numeric",
        year: "numeric",
      }).format(d);
      const time = new Intl.DateTimeFormat(undefined, {
        timeZone: tz,
        hour: "numeric",
        minute: "2-digit",
      }).format(d);
      const tzName =
        new Intl.DateTimeFormat(undefined, { timeZone: tz, timeZoneName: "short" })
          .formatToParts(d)
          .find((p) => p.type === "timeZoneName")?.value || tz;
      return { date, time, tz: tzName };
    } catch {
      return { date: d.toLocaleString(), time: "", tz: "" };
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
      setListItems((prev) =>
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

  const ACTIVE_SCHEDULED_JOB_STATES = new Set([
    "scheduled",
    "content_generating",
    "image_generating",
    "ready_to_post",
    "posting",
    "failed",
  ]);

  function scheduledJobPreference(j: import("@/lib/api").ScheduledJobPublic): { active: number; runAt: string } {
    const st = (j.state || "").toLowerCase();
    const active = ACTIVE_SCHEDULED_JOB_STATES.has(st) ? 1 : 0;
    return { active, runAt: (j.run_at || "").trim() };
  }

  function pickBetterScheduledJob(
    a: import("@/lib/api").ScheduledJobPublic,
    b: import("@/lib/api").ScheduledJobPublic,
  ): import("@/lib/api").ScheduledJobPublic {
    const pa = scheduledJobPreference(a);
    const pb = scheduledJobPreference(b);
    if (pa.active !== pb.active) return pa.active > pb.active ? a : b;
    if (pa.runAt !== pb.runAt) return pa.runAt > pb.runAt ? a : b;
    return a;
  }

  /** One row per article — prefer upcoming pipeline jobs over legacy posted duplicates. */
  function dedupeScheduledJobs(rows: import("@/lib/api").ScheduledJobPublic[]) {
    const active = (rows || []).filter((j) => (j.state || "").toLowerCase() !== "cancelled");
    const bestByArticle = new Map<string, import("@/lib/api").ScheduledJobPublic>();
    for (const j of active) {
      const aid = (j.article_id || "").trim();
      if (!aid) continue;
      const cur = bestByArticle.get(aid);
      bestByArticle.set(aid, cur ? pickBetterScheduledJob(cur, j) : j);
    }
    const out = Array.from(bestByArticle.values());
    out.sort((a, b) => (b.run_at || "").localeCompare(a.run_at || ""));
    return out;
  }

  function normalizeArticleScheduleRunAt(raw: string): string {
    const v = (raw || "").trim();
    if (!v) return "";
    if (v.includes("T")) return v.replace("T", " ").replace(/\.\d+Z?$/i, "").slice(0, 19);
    return v.slice(0, 19);
  }

  /** Include articles with wp_scheduled_at when the job row is missing (bulk cadence safety net). */
  function isOrphanScheduledJob(j: { id: string }) {
    return (j.id || "").startsWith("pending_job_");
  }

  function scheduledJobUpdatedMs(j: import("@/lib/api").ScheduledJobPublic): number | null {
    const raw = (j.updated_at || j.last_attempt_at || "").trim();
    if (!raw) return null;
    const iso = raw.includes("T") ? raw : raw.replace(" ", "T") + "Z";
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? ms : null;
  }

  function isStalePostingJob(j: import("@/lib/api").ScheduledJobPublic): boolean {
    if ((j.state || "").toLowerCase() !== "posting") return false;
    if ((j.wp_post_id || "").trim()) return false;
    const ms = scheduledJobUpdatedMs(j);
    if (ms == null) return true;
    return Date.now() - ms > 3 * 60 * 1000;
  }

  function canPostNowScheduledJob(j: import("@/lib/api").ScheduledJobPublic): boolean {
    const jobState = (j.state || "").toLowerCase();
    if (["posted", "cancelled"].includes(jobState)) return false;
    if (isOrphanScheduledJob(j)) return false;
    if (jobState === "posting") return isStalePostingJob(j);
    return true;
  }

  async function openPostNowConfirm(j: import("@/lib/api").ScheduledJobPublic) {
    setError(null);
    if (!requireWebsiteConnectedForAction("Website is not connected for this project. Connect and verify WordPress before publishing scheduled articles.")) {
      return;
    }
    if (!canPostNowScheduledJob(j)) {
      if ((j.state || "").toLowerCase() === "posting") {
        setNotice("This article is being published. The list refreshes automatically — try again in a minute if it stays stuck.");
      }
      return;
    }
    const meta = await ensureScheduleMetaLoaded();
    setPostNowWritingPromptId((j.writing_prompt_id || meta.writingPrompts?.default_id || "").trim());
    setPostNowImagePromptId((j.image_prompt_id || meta.imagePrompts?.default_id || "").trim());
    setPostNowGenerateImage(Boolean(j.generate_image ?? true));
    setConfirmPostNowJob(j);
  }

  function closePostNowConfirm() {
    if (postNowBusy) return;
    setConfirmPostNowJob(null);
    setPostNowWritingPromptId("");
    setPostNowImagePromptId("");
    setPostNowGenerateImage(true);
  }

  function buildScheduledJobsView(
    jobs: import("@/lib/api").ScheduledJobPublic[],
    articles: ArticlePublic[],
  ): import("@/lib/api").ScheduledJobPublic[] {
    const merged = dedupeScheduledJobs(jobs);
    const haveJob = new Set(merged.map((j) => j.article_id));
    const extras: import("@/lib/api").ScheduledJobPublic[] = [];
    for (const a of articles) {
      const runAt = normalizeArticleScheduleRunAt(a.wp_scheduled_at || "");
      if (!runAt || haveJob.has(a.id)) continue;
      extras.push({
        id: `pending_job_${a.id}`,
        project_id: projectId,
        article_id: a.id,
        run_at: runAt,
        post_type: "posts",
        wp_status: "draft",
        category_ids: [],
        state: "scheduled",
        attempts: 0,
        wp_link: a.wp_link || null,
      });
    }
    return dedupeScheduledJobs([...merged, ...extras]);
  }

  const fetchScheduledJobsView = useCallback(async () => {
    try {
      return await api.listScheduledJobsBoard(projectId);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        const [jobs, articles] = await Promise.all([
          api.listScheduledJobs(projectId),
          api.listArticlesAll(projectId, {}).catch(() => [] as ArticlePublic[]),
        ]);
        return buildScheduledJobsView(jobs, articles);
      }
      throw e;
    }
  }, [projectId]);

  const reloadScheduledJobs = useCallback(async (opts?: { quiet?: boolean }) => {
    if (!opts?.quiet) {
      setError(null);
      setScheduledLoading(true);
    }
    try {
      setScheduledJobs(await fetchScheduledJobsView());
    } catch (e) {
      if (!opts?.quiet) {
        setError(e instanceof Error ? e.message : "Failed to load scheduled articles");
      }
    } finally {
      if (!opts?.quiet) setScheduledLoading(false);
    }
  }, [fetchScheduledJobsView]);

  useEffect(() => {
    if (!token) return;
    if (tab !== "scheduled_articles") return;
    void reloadScheduledJobs();
  }, [projectId, tab, token, reloadScheduledJobs]);

  // Poll while jobs are generating or publishing so status badges stay accurate.
  // P2.6: pause polling while the tab is hidden/offline and back off on consecutive
  // ticks (6s → 12s → 24s, capped) so a backgrounded tab doesn't hammer the API.
  useEffect(() => {
    if (tab !== "scheduled_articles") return;
    const needsPoll = scheduledJobs.some((j) => {
      const st = (j.state || "").toLowerCase();
      return st === "posting" || st === "content_generating" || st === "image_generating";
    });
    if (!needsPoll) return;

    let cancelled = false;
    let timer: number | undefined;
    let delay = 6000;
    const MAX_DELAY = 24000;

    const tick = async () => {
      if (cancelled) return;
      if (typeof document !== "undefined" && document.hidden) {
        // Hidden tab: skip the network call and re-check shortly.
        delay = MAX_DELAY;
      } else if (typeof navigator !== "undefined" && navigator.onLine === false) {
        delay = MAX_DELAY;
      } else {
        await reloadScheduledJobs({ quiet: true });
        delay = Math.min(MAX_DELAY, delay * 2);
      }
      if (!cancelled) timer = window.setTimeout(tick, delay);
    };

    timer = window.setTimeout(tick, delay);
    const onVisible = () => {
      // Resume promptly with a fresh fetch when the user returns to the tab.
      if (typeof document !== "undefined" && !document.hidden && !cancelled) {
        delay = 6000;
        if (timer) window.clearTimeout(timer);
        timer = window.setTimeout(tick, 0);
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [tab, scheduledJobs, reloadScheduledJobs]);

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
      const ensureShopify =
        (searchParams.get("ensure_platform") || "").trim().toLowerCase() === "shopify";
      if (ensureShopify) {
        try {
          const cur = await api.getProject(projectId);
          if ((cur.platform || "").toLowerCase() !== "shopify") {
            await api.updateProject(projectId, { platform: "shopify" });
          }
        } catch {
          // non-fatal
        }
        if (typeof window !== "undefined") {
          const url = new URL(window.location.href);
          url.searchParams.delete("ensure_platform");
          window.history.replaceState({}, "", url.toString());
        }
      }

      const [sRes, gsRes, pmRes] = await Promise.allSettled([
        api.getProjectSettings(projectId, { skipGlobalLoading: true }),
        api.gscProjectStatus(projectId),
        api.getProject(projectId, { skipGlobalLoading: true }),
      ]);
      if (sRes.status !== "fulfilled") throw sRes.reason;
      if (pmRes.status !== "fulfilled") throw pmRes.reason;
      const s = sRes.value;
      const pm = pmRes.value;
      setSettings(s);
      setProjectMeta(pm);
      setSName(s.name || "");
      setSShopifyClientId(s.shopify_client_id || "");
      setSShopifyProductAware(Boolean(s.shopify_product_aware_enabled));
      setSWpInternalLinkAware(Boolean(s.wp_internal_link_aware_enabled));
      const plat = resolveProjectPlatform({
        settings: s,
        meta: pm,
        listItem: listProject,
        urlHint: platformUrlHint,
      });
      if (plat === "shopify" && (pm?.platform || s.platform || "").toLowerCase() !== "shopify") {
        try {
          const fixed = await api.updateProject(projectId, { platform: "shopify" }, { skipGlobalLoading: true });
          setProjectMeta(fixed);
        } catch {
          // non-fatal
        }
      }
      setSUrl(
        plat === "shopify"
          ? (s.website_url || pm?.website_url || "")
          : (s.wp_site_url || s.website_url || ""),
      );
      setSWpUser(s.wp_username || "");
      {
        const nextPass = s.wp_app_password || "";
        wpPassLoadedRef.current = normalizePasswordForDirtyCheck(nextPass);
        setSWpPass(nextPass);
      }
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

      if (plat !== "shopify") {
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
  }, [projectId, tab, token, searchParams, platformUrlHint]);

  async function saveSettings() {
    if (!settings) return;
    setError(null);
    setGscSaveMsg(null);
    setSettingsSaving(true);
    try {
      const saved = await api.updateProjectSettings(
        projectId,
        isShopifyProject
          ? {
              name: sName.trim(),
              website_url: sUrl.trim(),
              shopify_shop: sUrl.trim(),
              shopify_client_id: sShopifyClientId.trim(),
              shopify_product_aware_enabled: Boolean(sShopifyProductAware),
            }
          : {
              name: sName,
              wp_site_url: sUrl,
              wp_username: sWpUser,
              default_wp_rest_base: sWpDefaultPostType,
              default_wp_status: sWpDefaultStatus,
              default_wp_category_ids: sWpDefaultCategoryIds,
              wp_internal_link_aware_enabled: Boolean(sWpInternalLinkAware),
              ...(sWpPass.replace(/\s+/g, "").trim()
                ? { wp_app_password: sWpPass.replace(/\s+/g, "").trim() }
                : {}),
            },
      );
      setSettings(saved);
      if (saved.wp_app_password) setSWpPass(saved.wp_app_password);
      setToast({ message: "Saved", tone: "success" });
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
      setToast({ message: e instanceof Error ? e.message : "Save failed", tone: "error" });
    } finally {
      setSettingsSaving(false);
    }
  }

  // Auto-hide toast
  useEffect(() => {
    if (!toast) return;
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 4000);
    return () => {
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
      toastTimerRef.current = null;
    };
  }, [toast]);

  // Auto-save the Shopify product-aware toggle (debounced).
  const autoSaveToggleTimerRef = useRef<number | null>(null);
  useEffect(() => {
    if (!token) return;
    if (tab !== "project_settings") return;
    if (!isShopifyProject) return;
    if (!settings) return;
    const next = Boolean(sShopifyProductAware);
    const cur = Boolean(settings.shopify_product_aware_enabled);
    if (next === cur) return;
    if (autoSaveToggleTimerRef.current) window.clearTimeout(autoSaveToggleTimerRef.current);
    autoSaveToggleTimerRef.current = window.setTimeout(() => {
      void api
        .updateProjectSettings(projectId, { shopify_product_aware_enabled: next })
        .then((saved) => {
          setSettings(saved);
          setToast({ message: "Saved", tone: "success" });
        })
        .catch((e) => {
          setToast({ message: e instanceof Error ? e.message : "Save failed", tone: "error" });
        });
    }, 450);
    return () => {
      if (autoSaveToggleTimerRef.current) window.clearTimeout(autoSaveToggleTimerRef.current);
      autoSaveToggleTimerRef.current = null;
    };
  }, [projectId, tab, token, isShopifyProject, settings, sShopifyProductAware]);

  // Auto-save Shopify project display name (debounced) so sidebar + switcher stay in sync.
  const shopifyNameSaveTimerRef = useRef<number | null>(null);
  useEffect(() => {
    if (!token || tab !== "project_settings" || !isShopifyProject || !settings) return;
    const next = sName.trim();
    const cur = (settings.name || "").trim();
    if (!next || next === cur) return;
    if (shopifyNameSaveTimerRef.current) window.clearTimeout(shopifyNameSaveTimerRef.current);
    shopifyNameSaveTimerRef.current = window.setTimeout(() => {
      void api
        .updateProjectSettings(projectId, { name: next })
        .then((saved) => {
          setSettings(saved);
          setProjectsList((prev) =>
            prev.map((p) => (p.id === projectId ? { ...p, name: saved.name || next } : p)),
          );
          setProjectMeta((pm) => (pm ? { ...pm, name: saved.name || next } : pm));
        })
        .catch(() => undefined);
    }, 700);
    return () => {
      if (shopifyNameSaveTimerRef.current) window.clearTimeout(shopifyNameSaveTimerRef.current);
      shopifyNameSaveTimerRef.current = null;
    };
  }, [projectId, tab, token, isShopifyProject, settings, sName]);

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
      const passNorm = sWpPass.replace(/\s+/g, "").trim();
      if (passNorm) {
        patch.wp_app_password = passNorm;
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
        ...(passNorm ? { wp_app_password: passNorm } : {}),
      });
      setSettingsVerify(res);

      // Step 3: pull the new ``wp_verified_at`` / ``wp_verified_status``
      // snapshot from the backend so the persistent status pill is up-to-date.
      try {
        const fresh = await api.getProjectSettings(projectId);
        setSettings(fresh);
        // Clear the typed app-password field on success — the value is now
        // stored server-side and the placeholder will switch to "•••••• (set)".
        if (fresh.wp_app_password) setSWpPass(fresh.wp_app_password);
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
      const gs = await api.gscProjectStatus(projectId, { fresh: true });
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

  async function reloadInsights(opts: { silent?: boolean } = {}) {
    if (!projectId) return;
    if (!opts.silent) setInsightsBusy(true);
    setInsightsErr(null);
    try {
      const res = await api.gscProjectInsights(projectId, { days: 28 });
      setInsights(res);
    } catch (e) {
      setInsightsErr(e instanceof Error ? e.message : "Failed to load insights");
      setInsights(null);
    } finally {
      if (!opts.silent) setInsightsBusy(false);
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
      setListItems((rows) =>
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
      setListItems((prev) =>
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
    if (tab !== "tools" && tab !== "performance") return;
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

  // Load Insights when the Insights sub-tab is first opened (or when the project/GSC status changes).
  useEffect(() => {
    if (!token || tab !== "performance" || performanceSubTab !== "insights") return;
    if (!gscStatus?.connected || !gscStatus?.property_url) {
      setInsights(null);
      setInsightsErr(null);
      return;
    }
    if (!insights) void reloadInsights();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, tab, performanceSubTab, token, gscStatus?.connected, gscStatus?.property_url]);

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

  useEffect(() => {
    if (!token) return;
    if (tab !== "products") return;
    if (!isShopifyProject) return;
    (async () => {
      setShopifyCatalogErr(null);
      setShopifyCatalogLoading(true);
      try {
        const cat = await api.getShopifyCatalog(projectId);
        setShopifyCatalog(cat);
      } catch (e) {
        setShopifyCatalog(null);
        setShopifyCatalogErr(e instanceof Error ? e.message : "Failed to load Shopify products");
      } finally {
        setShopifyCatalogLoading(false);
      }
    })();
  }, [projectId, tab, token, isShopifyProject]);

  useEffect(() => {
    if (!token) return;
    if (tab !== "members") return;
    (async () => {
      setMembersLoading(true);
      try {
        const data = await api.getProjectMembers(projectId);
        setMembersData(data);
      } catch { setMembersData(null); }
      setMembersLoading(false);
    })();
  }, [projectId, tab, token]);

  // Members tab helpers
  async function handleMembersInvite() {
    if (!membersInviteEmail.trim()) { setMembersInviteError("Enter an email address"); return; }
    setMembersInviteBusy(true);
    setMembersInviteError(null);
    try {
      await api.inviteCollaborator(projectId, membersInviteEmail.trim(), membersInviteRole);
      setMembersInviteEmail("");
      const data = await api.getProjectMembers(projectId);
      setMembersData(data);
      setToast({ message: `Invitation sent to ${membersInviteEmail.trim()}`, tone: "success" });
    } catch (e) {
      setMembersInviteError(e instanceof Error ? e.message : "Failed to send invitation");
    }
    setMembersInviteBusy(false);
  }

  async function handleMembersChangeRole(collaboratorId: string, newRole: CollaboratorRole) {
    setMembersRoleChangeBusy(collaboratorId);
    try {
      const updated = await api.changeCollaboratorRole(projectId, collaboratorId, newRole);
      setMembersData(prev => prev ? {
        ...prev,
        collaborators: prev.collaborators.map(c => c.id === collaboratorId ? updated : c),
      } : prev);
    } catch (e) {
      setToast({ message: e instanceof Error ? e.message : "Failed to change role", tone: "error" });
    }
    setMembersRoleChangeBusy(null);
  }

  async function handleMembersRemove(collab: CollaboratorPublic) {
    setMembersRemoveBusy(collab.id);
    try {
      await api.removeCollaborator(projectId, collab.id);
      setMembersData(prev => prev ? {
        ...prev,
        collaborators: prev.collaborators.filter(c => c.id !== collab.id),
      } : prev);
      setToast({ message: `${collab.user_name || collab.user_email} removed`, tone: "success" });
    } catch (e) {
      setToast({ message: e instanceof Error ? e.message : "Failed to remove member", tone: "error" });
    }
    setMembersRemoveBusy(null);
  }

  async function handleMembersResend(invitationId: string) {
    setMembersResendBusy(invitationId);
    try {
      await api.resendInvitation(projectId, invitationId);
      setToast({ message: "Invitation resent", tone: "success" });
    } catch (e) {
      setToast({ message: e instanceof Error ? e.message : "Failed to resend", tone: "error" });
    }
    setMembersResendBusy(null);
  }

  async function handleMembersCancel(invitationId: string) {
    setMembersCancelBusy(invitationId);
    try {
      await api.cancelInvitation(projectId, invitationId);
      setMembersData(prev => prev ? {
        ...prev,
        pending_invitations: prev.pending_invitations.filter(i => i.id !== invitationId),
      } : prev);
      setToast({ message: "Invitation cancelled", tone: "success" });
    } catch (e) {
      setToast({ message: e instanceof Error ? e.message : "Failed to cancel", tone: "error" });
    }
    setMembersCancelBusy(null);
  }

  async function loadShopifyCatalogIfNeeded() {
    if (!projectId || !isShopifyProject) return;
    if (shopifyCatalogLoading) return;
    if ((shopifyCatalog?.products || []).length > 0) return;
    setShopifyCatalogErr(null);
    setShopifyCatalogLoading(true);
    try {
      const cat = await api.getShopifyCatalog(projectId);
      setShopifyCatalog(cat);
    } catch (e) {
      setShopifyCatalog(null);
      setShopifyCatalogErr(e instanceof Error ? e.message : "Failed to load Shopify products");
    } finally {
      setShopifyCatalogLoading(false);
    }
  }

  async function runShopifyProductSync() {
    if (!projectId || !isShopifyProject) return;
    setShopifyCatalogErr(null);
    setShopifyCatalogNotice(null);
    setShopifyCatalogSyncing(true);
    try {
      const status = await api.syncShopifyCatalog(projectId);
      const cat = await api.getShopifyCatalog(projectId);
      setShopifyCatalog(cat);
      const msg = (status.sync_message || cat.sync_message || "").trim();
      if (msg) {
        setShopifyCatalogNotice(msg);
      }
      const productCount = status.counts?.products ?? cat.counts?.products ?? 0;
      if ((status.sync_status || "").toLowerCase() === "partial" && productCount === 0) {
        setShopifyCatalogErr(
          msg ||
            "Products could not be synced. Enable read_products on your Shopify app version, release it, then reconnect in Project Settings.",
        );
      }
    } catch (e) {
      setShopifyCatalogErr(e instanceof Error ? e.message : "Shopify sync failed");
    } finally {
      setShopifyCatalogSyncing(false);
    }
  }

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
      const shopifyFlag = (hashParams.get("shopify") || "").trim();
      if (shopifyFlag === "connected" || shopifyFlag === "error") {
        setTab("project_settings");
        if (shopifyFlag === "error") {
          setError(msg || "Shopify connect failed. Please try again.");
        } else {
          invalidateProjectSettingsCache(projectId);
          void Promise.all([
            api.getProject(projectId).then(setProjectMeta),
            api.getProjectSettings(projectId, { fresh: true }).then(setSettings),
          ])
            .then(() => api.syncShopifyCatalog(projectId))
            .then(() => {
              setToast({ message: "Shopify permissions updated — catalog synced", tone: "success" });
            })
            .catch(() => undefined);
        }
        if (url.hash) {
          url.hash = "";
          window.history.replaceState({}, "", url.toString());
        }
      } else if (flag === "connected" || flag === "error") {
        setTab("tools");
        if (flag === "connected") {
          setGscOpenedFromOAuth(true);
          setGscMsg(null);
          void reloadGscForProject({ showLoading: true });
        } else {
          setGscMsg(msg || "Google connect failed. Please try again.");
        }
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
      setPage(1);
      await reloadArticleTitles();
      await refreshArticlesList();
      setArticleTitlesById((prev) => ({ ...prev, [a.id]: a.title || "" }));
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
      const all = await api.listArticlesAll(projectId, {
        status: exportStatus || undefined,
        date_from: exportFrom || undefined,
        date_to: exportTo || undefined,
        sort: "desc",
      });
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
      await reloadArticleTitles();
      await refreshArticlesList();
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

  const totalPages = Math.max(1, Math.ceil(listTotal / pageSize));
  const pageClamped = Math.min(Math.max(1, page), totalPages);
  const pageItems = listItems;
  const hasGeneratingArticles = useMemo(
    () => pageItems.some((a) => { const s = (a.status || "").toLowerCase(); return s === "queued" || s === "generating"; }),
    [pageItems],
  );

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  // Poll articles list while any visible article is "queued" or "generating"
  // so status badges update automatically and action buttons restore on completion.
  // Backoff: 6s → 9s → 13s → … → 20s cap. Pauses when tab is hidden or offline.
  useEffect(() => {
    if (tab !== "articles" || !hasGeneratingArticles) return;
    let cancelled = false;
    let timer: number | undefined;
    let delay = 6000;
    const MAX_DELAY = 20000;

    const tick = async () => {
      if (cancelled) return;
      if (typeof document !== "undefined" && document.hidden) {
        delay = MAX_DELAY;
      } else if (typeof navigator !== "undefined" && navigator.onLine === false) {
        delay = MAX_DELAY;
      } else {
        try {
          const res = await api.listArticlesPage(projectId, {
            page,
            per_page: pageSize,
            q: debouncedQ.trim() || undefined,
            status: status || undefined,
            date_from: dateFrom || undefined,
            date_to: dateTo || undefined,
            sort: dateOrder,
          });
          if (!cancelled) {
            setListItems(res.items || []);
            setListTotal(res.total || 0);
          }
        } catch {
          // Non-fatal — next tick will retry.
        }
        delay = Math.min(MAX_DELAY, Math.floor(delay * 1.5));
      }
      if (!cancelled) timer = window.setTimeout(tick, delay);
    };

    timer = window.setTimeout(tick, delay);
    const onVisible = () => {
      if (typeof document !== "undefined" && !document.hidden && !cancelled) {
        delay = 6000;
        if (timer) window.clearTimeout(timer);
        timer = window.setTimeout(tick, 0);
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [tab, hasGeneratingArticles, projectId, page, pageSize, debouncedQ, status, dateFrom, dateTo, dateOrder]);

  function articleTitleFor(id: string) {
    return selectedMeta[id]?.title || articleTitlesById[id] || "(Untitled)";
  }

  async function refreshArticlesList() {
    const res = await api.listArticlesPage(projectId, {
      page,
      per_page: pageSize,
      q: debouncedQ.trim() || undefined,
      status: status || undefined,
      date_from: dateFrom || undefined,
      date_to: dateTo || undefined,
      sort: dateOrder,
    });
    setListItems(res.items || []);
    setListTotal(res.total || 0);
  }

  async function saveArticleCategories() {
    const items = Object.entries(articleCategoryEdits).map(([article_id, wp_category_ids]) => ({ article_id, wp_category_ids }));
    if (!items.length) return;
    setCategorySaveBusy(true);
    setCategorySaveError(null);
    try {
      await api.updateArticleCategories(projectId, items);
      setArticleCategoryEdits({});
      await refreshArticlesList();
    } catch (e) {
      setCategorySaveError(e instanceof Error ? e.message : "Failed to save categories");
    } finally {
      setCategorySaveBusy(false);
    }
  }

  async function reloadArticleTitles() {
    const titles = await api.listArticleTitles(projectId);
    const map: Record<string, string> = {};
    for (const row of titles || []) {
      if (row.id) map[row.id] = row.title || "";
    }
    setArticleTitlesById(map);
  }

  const allOnPageSelected = pageItems.length > 0 && pageItems.every((a) => selected[a.id]);

  function toggleAllOnPage() {
    const next = { ...selected };
    const nextMeta = { ...selectedMeta };
    const value = !allOnPageSelected;
    for (const a of pageItems) {
      next[a.id] = value;
      if (value) {
        nextMeta[a.id] = { title: a.title || "(Untitled)" };
      } else {
        delete nextMeta[a.id];
      }
    }
    setSelected(next);
    setSelectedMeta(nextMeta);
  }

  function toggleOne(id: string) {
    const turningOn = !selected[id];
    setSelected((prev) => ({ ...prev, [id]: turningOn }));
    const row = pageItems.find((a) => a.id === id);
    setSelectedMeta((prev) => {
      if (!turningOn) {
        const { [id]: _, ...rest } = prev;
        return rest;
      }
      return { ...prev, [id]: { title: row?.title || articleTitlesById[id] || "(Untitled)" } };
    });
  }

  async function bulkDelete() {
    if (selectedIds.length === 0) return;
    if (!confirm(`Delete ${selectedIds.length} selected article(s)? This cannot be undone.`)) return;
    setError(null);
    try {
      await api.bulkDeleteArticles(projectId, selectedIds);
      setSelected({});
      setSelectedMeta({});
      await reloadArticleTitles();
      await refreshArticlesList();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Bulk delete failed");
    }
  }

  async function deleteOne(articleId: string) {
    setError(null);
    try {
      await api.bulkDeleteArticles(projectId, [articleId]);
      setSelected((prev) => {
        const next = { ...prev };
        delete next[articleId];
        return next;
      });
      setConfirmDeleteId(null);
      await reloadArticleTitles();
      await refreshArticlesList();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    }
  }

  async function scheduleOne(articleId: string) {
    setError(null);
    if (!requireWebsiteConnectedForAction("Website is not connected for this project. Connect and verify WordPress before scheduling articles.")) return;
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
        user_timezone: profileTz || Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      // Optimistic UI update: scheduling should not block on re-fetching large lists,
      // which can time out on production proxies.
      if (scheduled?.wp_scheduled_at) {
        const runAt = String(scheduled.wp_scheduled_at || "");
        setListItems((prev) =>
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
      void reloadScheduledJobs({ quiet: true });
      void refreshFeatureLimits();
      setScheduleId(null);
      setScheduleWhen("");
      setScheduleWpStatus("draft");
      setSchedulePostType("posts");
      setScheduleWritingPromptId(scheduleWritingPrompts?.default_id || "");
      setScheduleImagePromptId(scheduleImagePrompts?.default_id || "");
    } catch (e) {
      if (showWebsiteConnectionErrorIfNeeded(e)) return;
      setError(e instanceof Error ? e.message : "Schedule failed");
    }
  }

  async function pollPostNowUntilSettled(jobId: string) {
    const delays = [2000, 3000, 5000, 8000, 10000, 15000, 20000, 30000, 45000, 60000, 90000, 120000];
    for (const delayMs of delays) {
      await new Promise((r) => setTimeout(r, delayMs));
      const rows = await fetchScheduledJobsView();
      setScheduledJobs(rows);
      const row = rows.find((j) => j.id === jobId);
      if (!row) return;
      const st = (row.state || "").toLowerCase();
      if (st === "posted") {
        setError(null);
        setNotice(
          row.wp_link
            ? `Published to WordPress: ${row.wp_link}`
            : "Published to WordPress.",
        );
        await refreshArticlesList();
        return;
      }
      if (st === "failed") {
        setError((row.last_error || "").trim() || "Post now failed");
        return;
      }
    }
    setNotice("Post now is still running. Scheduled Articles will keep updating — refresh in a minute if needed.");
  }

  async function postNowFromScheduledJob() {
    const j = confirmPostNowJob;
    if (!j) return;
    if (!requireWebsiteConnectedForAction("Website is not connected for this project. Connect and verify WordPress before publishing scheduled articles.")) return;
    setError(null);
    setPostNowBusy(true);
    const jobNeedsContent = !["ready_to_post", "posted"].includes((j.state || "").toLowerCase());
    setPostNowPhase(jobNeedsContent ? "generating" : "publishing");
    try {
      const res = await api.postScheduledJobNow(projectId, j.id, {
        writing_prompt_id: postNowWritingPromptId || null,
        image_prompt_id: postNowGenerateImage ? postNowImagePromptId || null : null,
        generate_image: postNowGenerateImage,
      });
      const jobId = res.job?.id || j.id;
      if (res.job) {
        setScheduledJobs((prev) => prev.map((row) => (row.id === jobId ? { ...row, ...res.job! } : row)));
      } else {
        setScheduledJobs((prev) =>
          prev.map((row) =>
            row.id === jobId ? { ...row, state: res.status === "posting" ? "posting" : "posting", last_error: null } : row,
          ),
        );
      }
      closePostNowConfirm();
      if (res.async || res.status === "accepted" || res.status === "posting") {
        setNotice(res.message || "Publishing…");
        void pollPostNowUntilSettled(jobId);
        return;
      }
      await refreshArticlesList();
      await reloadScheduledJobs({ quiet: true });
      setNotice(res.message || "Published to WordPress.");
    } catch (e) {
      if (showWebsiteConnectionErrorIfNeeded(e)) return;
      setError(e instanceof Error ? e.message : "Post now failed");
    } finally {
      setPostNowBusy(false);
      setPostNowPhase("idle");
    }
  }

  async function refreshScheduledJobsList() {
    await reloadScheduledJobs({ quiet: true });
  }

  async function pollScheduledJobsUntilSettled(jobIds: string[]) {
    const targets = new Set(jobIds);
    for (const delayMs of [2500, 5000, 10000, 20000, 45000]) {
      await new Promise((r) => setTimeout(r, delayMs));
      const rows = await fetchScheduledJobsView();
      setScheduledJobs(rows);
      const tracked = rows.filter((j) => targets.has(j.id));
      if (
        tracked.length === 0 ||
        tracked.every((j) => {
          const st = (j.state || "").toLowerCase();
          return st === "ready_to_post" || st === "posted" || st === "failed" || st === "cancelled";
        })
      ) {
        break;
      }
    }
  }

  async function retryScheduledPreparation(jobId: string) {
    setError(null);
    setRetryPrepBusyId(jobId);
    try {
      const res = await api.retryScheduledJobPreparation(projectId, jobId);
      setScheduledJobs((prev) =>
        prev.map((j) =>
          j.id === jobId
            ? { ...j, ...res.job, state: res.job.state || "content_generating", last_error: null }
            : j,
        ),
      );
      await pollScheduledJobsUntilSettled([jobId]);
    } catch (e) {
      if (showWebsiteConnectionErrorIfNeeded(e)) return;
      const msg =
        e instanceof ApiError && e.status === 404
          ? "Retry preparation is not available on the server yet. Deploy the latest backend, or use Re-Schedule after setting a new time at least 10 minutes from now."
          : e instanceof Error
            ? e.message
            : "Retry preparation failed";
      setError(msg);
    } finally {
      setRetryPrepBusyId(null);
    }
  }

  async function retryAllFailedScheduledPreparations() {
    setError(null);
    setRetryAllFailedBusy(true);
    try {
      const res = await api.retryAllFailedScheduledPreparations(projectId);
      await refreshScheduledJobsList();
      if (res.retried > 0) {
        const rows = await fetchScheduledJobsView();
        const ids = rows
          .filter((j) => ["content_generating", "image_generating"].includes((j.state || "").toLowerCase()))
          .map((j) => j.id);
        if (ids.length) await pollScheduledJobsUntilSettled(ids);
      }
    } catch (e) {
      if (showWebsiteConnectionErrorIfNeeded(e)) return;
      const msg =
        e instanceof ApiError && e.status === 404
          ? "Bulk retry is not available on the server yet. Deploy the latest backend, then use Retry preparation on each failed job."
          : e instanceof Error
            ? e.message
            : "Bulk retry failed";
      setError(msg);
    } finally {
      setRetryAllFailedBusy(false);
    }
  }

  async function openEditScheduledJob(j: import("@/lib/api").ScheduledJobPublic) {
    setError(null);
    setNotice(null);
    const min = new Date(Date.now() + 10 * 60 * 1000);
    setEditJobMin(toDatetimeLocalFromDateInProfileTz(min));

    const meta = await ensureScheduleMetaLoaded();
    const defaultPostType = (wpDefaults?.post_type || "posts").trim() || "posts";
    const defaultStatus = (wpDefaults?.wp_status || "draft") === "publish" ? "publish" : "draft";
    const nextPostType = (j.post_type || defaultPostType).trim() || defaultPostType;
    const nextStatus = (
      String(j.wp_status || defaultStatus).toLowerCase() === "publish" ? "publish" : "draft"
    ) as "draft" | "publish";
    const jobCats = Array.isArray(j.category_ids) ? j.category_ids : [];
    const defaultCats = ((settings?.default_wp_category_ids || []) as number[]).filter((id) => Number.isFinite(id));

    setEditJob(j);
    const failed = (j.state || "").toLowerCase() === "failed";
    const minWhen = toDatetimeLocalFromDateInProfileTz(new Date(Date.now() + 10 * 60 * 1000));
    const fromJob = toDatetimeLocalInProfileTz(j.run_at || "");
    // Failed jobs often still show a past run_at — default to the earliest valid slot.
    setEditJobWhen(failed ? minWhen : fromJob || minWhen);
    setEditJobPostType(nextPostType);
    setEditJobStatus(nextStatus);
    setEditJobCats(jobCats.length ? jobCats : defaultCats);
    setEditJobWritingPromptId((j.writing_prompt_id || meta.writingPrompts?.default_id || "").trim());
    setEditJobImagePromptId((j.image_prompt_id || meta.imagePrompts?.default_id || "").trim());
    setEditJobGenerateImage(Boolean(j.generate_image ?? true));
  }

  async function saveRescheduleChanges() {
    if (!editJob || editRescheduleBusy) return;
    setError(null);
    setNotice(null);
    if (
      !requireWebsiteConnectedForAction(
        "Website is not connected for this project. Connect and verify WordPress before editing scheduled articles.",
      )
    ) {
      return;
    }
    const when = editJobWhen.trim();
    if (!when) {
      setError("Please choose a schedule time.");
      return;
    }

    setEditRescheduleBusy(true);
    let savedJobId = editJob.id;
    try {
      const _userTz = profileTz || Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (isOrphanScheduledJob(editJob)) {
        await api.scheduleArticle(projectId, editJob.article_id, {
          wp_scheduled_at: when,
          wp_status: editJobStatus,
          post_type: editJobPostType,
          writing_prompt_id: editJobWritingPromptId || null,
          image_prompt_id: editJobImagePromptId || null,
          generate_image: editJobGenerateImage,
          user_timezone: _userTz,
        });
      } else {
        const updated = await api.updateScheduledJob(projectId, savedJobId, {
          run_at: when,
          post_type: editJobPostType,
          wp_status: editJobStatus,
          category_ids: editJobCats,
          writing_prompt_id: editJobWritingPromptId || null,
          image_prompt_id: editJobImagePromptId || null,
          generate_image: editJobGenerateImage,
          user_timezone: _userTz,
        });
        savedJobId = updated.id || savedJobId;
        setScheduledJobs((prev) => {
          const next = prev.map((row) => (row.id === editJob.id ? { ...row, ...updated } : row));
          return next.some((row) => row.id === savedJobId) ? next : [updated, ...next];
        });
      }

      setEditJob(null);
      setNotice("Schedule updated. Content preparation will run automatically when due.");
      void refreshScheduledJobsList();
      void pollScheduledJobsUntilSettled([savedJobId]);
    } catch (e) {
      if (showWebsiteConnectionErrorIfNeeded(e)) return;
      setError(e instanceof Error ? e.message : "Failed to update schedule");
    } finally {
      setEditRescheduleBusy(false);
    }
  }

  async function bulkChangeStatus(newStatus: "pending" | "draft" | "published") {
    if (selectedIds.length === 0) return;
    const count = selectedIds.length;
    setError(null);
    try {
      await api.bulkChangeStatus(projectId, selectedIds, newStatus);
      setListItems((prev) =>
        prev.map((a) => (selectedIds.includes(a.id) ? { ...a, status: newStatus } : a)),
      );
      setSelected({});
      setSelectedMeta({});
      setShowBulkPopup(false);
      setBulkMode("root");
      setNotice(`${count} article${count === 1 ? "" : "s"} marked as ${newStatus}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Bulk status update failed");
    }
  }

  function bulkEdit() {
    if (selectedIds.length !== 1) return;
    const aid = selectedIds[0];
    router.push(`/projects/${projectId}/articles/${aid}`);
  }

  const scheduleTimeZone = profileTz || Intl.DateTimeFormat().resolvedOptions().timeZone;

  const buildScheduleMinStr = useCallback(() => {
    return toDatetimeLocalFromDateInProfileTz(scheduleMinFromNowMs());
  }, [profileTz]);

  function bulkSchedule() {
    if (!selectedIds.length) return;
    if (!requireWebsiteConnectedForAction("Website is not connected for this project. Connect and verify WordPress before scheduling articles.")) return;
    void ensureScheduleMetaLoaded();
    setBulkScheduleSeedRows(
      selectedIds.map((id) => ({ id, title: articleTitleFor(id) })),
    );
    setBulkMode("schedule");
  }

  async function bulkScheduleSubmit(values: BulkScheduleFormValues) {
    if (!values.rows.length) return;
    if (!requireWebsiteConnectedForAction("Website is not connected for this project. Connect and verify WordPress before scheduling articles.")) return;
    setError(null);
    setBulkScheduling(true);
    try {
      const items = values.rows.map((r) => ({
        article_id: r.id,
        wp_scheduled_at: (r.when || "").trim(),
      }));

      const schedulePayload = {
        items,
        cadence: values.scheduleMode,
        wp_status: values.wpStatus,
        post_type: values.postType,
        writing_prompt_id: values.writingPromptId || null,
        image_prompt_id: values.imagePromptId || null,
        generate_image: values.generateImage,
        user_timezone: profileTz || Intl.DateTimeFormat().resolvedOptions().timeZone,
      };

      const res = await api.bulkScheduleArticles(projectId, schedulePayload);
      if (res.failed?.length) {
        const first = res.failed[0];
        throw new Error(first?.error || `Failed to schedule ${res.failed.length} article(s)`);
      }
      if ((res.scheduled || 0) < items.length) {
        throw new Error("Some articles could not be scheduled");
      }

      await refreshArticlesList();
      await reloadScheduledJobs({ quiet: true });
      setSelected({});
      void refreshFeatureLimits();
      setShowBulkPopup(false);
      setBulkMode("root");
      setBulkScheduleSeedRows([]);
    } catch (e) {
      if (showWebsiteConnectionErrorIfNeeded(e)) return;
      setError(e instanceof Error ? e.message : "Bulk schedule failed");
    } finally {
      setBulkScheduling(false);
    }
  }

  async function submitResearchBulkSchedule(values: BulkScheduleFormValues) {
    const modal = researchScheduleModal;
    if (!modal || !values.rows.length) return;
    if (!requireWebsiteConnectedForAction("Website is not connected for this project. Connect and verify WordPress before scheduling articles.")) return;
    setResearchScheduleError(null);
    setResearchScheduleBusy(true);
    try {
      let clusterAfterImport: TopicCluster | null = null;
      const ideaToArticle = new Map<string, string>();

      if (modal.kind === "cluster") {
        const importRes = await api.topicClusterImport(projectId, modal.clusterId, {
          topic_ids: modal.topicIds,
          wp_status: values.wpStatus,
          post_type: values.postType,
          writing_prompt_id: values.writingPromptId || null,
          image_prompt_id: values.imagePromptId || null,
          generate_image: values.generateImage,
        });
        clusterAfterImport = importRes.cluster;
        setTopicClusters((prev) =>
          prev.map((c) => (c.id === importRes.cluster.id ? importRes.cluster : c)),
        );
        for (const row of values.rows) {
          const articleId = articleIdForClusterTopic(importRes.cluster, row.id);
          if (!articleId) {
            throw new Error(`Could not resolve an article for “${row.title}”. Try importing again.`);
          }
          ideaToArticle.set(row.id, articleId);
        }
        if (importRes.errors?.length) {
          setClusterErrorModal({
            title: "Some topics couldn't be imported",
            message: `${importRes.errors.length} topic(s) failed during import.`,
            detail: importRes.errors.map((e) => `• ${e.topic_id}: ${e.message}`).join("\n"),
          });
        }
      } else {
        const selected = researchResults.filter((r) => modal.ideaIds.includes(r.id) && !r.imported);
        const imported = await importResearchIdeaRows(selected, {
          skipDuplicates: false,
          successVerb: "Imported for scheduling",
        });
        if (!imported?.articleIds.length) {
          throw new Error("Import did not create any articles to schedule.");
        }
        selected.forEach((r, idx) => {
          const aid = imported.articleIds[idx];
          if (aid) ideaToArticle.set(r.id, aid);
        });
      }

      const items = values.rows.map((r) => {
        const articleId =
          modal.kind === "cluster"
            ? articleIdForClusterTopic(clusterAfterImport!, r.id) || ideaToArticle.get(r.id)
            : ideaToArticle.get(r.id);
        if (!articleId) {
          throw new Error(`Could not resolve an article for “${r.title}”.`);
        }
        return { article_id: articleId, wp_scheduled_at: (r.when || "").trim() };
      });

      const res = await api.bulkScheduleArticles(projectId, {
        items,
        cadence: values.scheduleMode,
        wp_status: values.wpStatus,
        post_type: values.postType,
        writing_prompt_id: values.writingPromptId || null,
        image_prompt_id: values.imagePromptId || null,
        generate_image: values.generateImage,
        user_timezone: profileTz || Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      if (res.failed?.length) {
        const first = res.failed[0];
        throw new Error(first?.error || `Failed to schedule ${res.failed.length} article(s)`);
      }
      if ((res.scheduled || 0) < items.length) {
        throw new Error("Some articles could not be scheduled");
      }

      if (modal.kind === "cluster") {
        clearClusterSelection(modal.clusterId);
        setClusterPlanMsg(
          `Scheduled ${res.scheduled} article${res.scheduled === 1 ? "" : "s"}. Track them in the Scheduled Articles tab.`,
        );
      } else {
        setResearchImportMsg(
          `Scheduled ${res.scheduled} article${res.scheduled === 1 ? "" : "s"} with featured image generation enabled.`,
        );
        setResearchFilter("imported");
        await reloadArticleTitles();
        await refreshArticlesList();
      }
      void refreshFeatureLimits();
      await reloadScheduledJobs({ quiet: true });
      setResearchScheduleModal(null);
    } catch (e) {
      if (showWebsiteConnectionErrorIfNeeded(e)) return;
      setResearchScheduleError(e instanceof Error ? e.message : "Scheduling failed");
    } finally {
      setResearchScheduleBusy(false);
    }
  }

  function resetBuilder() {
    setPbContentType("Blog Article");
    setPbTargetAudience("");
    setPbIndustry("Other / general");
    setPbToneOfVoice("Professional");
    setPbWritingStyle("Expository / informative");
    setPbBrandPersonality([]);
    setPbContentDepth("Standard / balanced");
    setPbArticleLength("Medium (1,000-1,800 words)");
    setPbEeatSettings([]);
    setPbSeoSettings([]);
    setPbContentRestrictions([]);
    setPbUseWebsiteData(true);
    setPbAdditionalInstructions("");
    setBuilderError("");
  }

  function openPromptModal(kind: "writing" | "image", id: string) {
    const list = kind === "writing" ? wpDrafts : ipDrafts;
    const row = list.find((x) => x.id === id);
    setDraftName(row?.name || "");
    setDraftText(row?.text || "");
    const def = kind === "writing" ? wpDefault : ipDefault;
    setDraftSetDefault(!!id && def === id);
    // Default to guided mode for new writing prompts, manual for existing ones
    if (kind === "writing" && !row?.text) {
      resetBuilder();
      setPromptBuilderMode("guided");
    } else {
      setPromptBuilderMode("manual");
    }
    setShowPromptModal({ kind, id });
  }

  function startAddPrompt(kind: "writing" | "image") {
    const cap = kind === "writing" ? featureLimits?.writing_prompts : featureLimits?.image_prompts;
    if (cap && !cap.unlimited && typeof cap.limit === "number") {
      const count = (kind === "writing" ? wpDrafts : ipDrafts).length;
      if (count >= cap.limit) {
        setError(
          `${kind === "writing" ? "Writing" : "Image"} prompt limit reached for your ${featureLimits?.plan_key || "current"} plan (max ${cap.limit}). Delete an existing prompt to add another.`
        );
        return;
      }
    }
    const tmpId = `new_${kind}_${Date.now()}`;
    if (kind === "writing") setWpDrafts((p) => [{ id: tmpId, name: "", text: "", isNew: true }, ...p]);
    else setIpDrafts((p) => [{ id: tmpId, name: "", text: "", isNew: true }, ...p]);
    openPromptModal(kind, tmpId);
  }

  function markDeletePrompt(kind: "writing" | "image", id: string) {
    setDeletePromptTarget({ kind, id });
  }

  function confirmDeletePrompt() {
    if (!deletePromptTarget) return;
    const { kind, id } = deletePromptTarget;
    if (kind === "writing") {
      setWpDrafts((p) => p.filter((x) => x.id !== id));
      setWpDeleted((s) => new Set([...Array.from(s), id]));
      if (wpDefault === id) setWpDefault("");
    } else {
      setIpDrafts((p) => p.filter((x) => x.id !== id));
      setIpDeleted((s) => new Set([...Array.from(s), id]));
      if (ipDefault === id) setIpDefault("");
    }
    setDeletePromptTarget(null);
  }

  async function buildPromptText() {
    if (!showPromptModal) return;
    setBuilderBuilding(true);
    setBuilderError("");
    try {
      const result = await api.compileWritingPromptTemplate(projectId, {
        content_type: pbContentType,
        target_audience: pbTargetAudience,
        industry: pbIndustry,
        tone_of_voice: pbToneOfVoice,
        writing_style: pbWritingStyle,
        brand_personality: pbBrandPersonality,
        content_depth: pbContentDepth,
        article_length: pbArticleLength,
        eeat_settings: pbEeatSettings,
        seo_settings: pbSeoSettings,
        content_restrictions: pbContentRestrictions,
        use_website_data: pbUseWebsiteData,
        additional_instructions: pbAdditionalInstructions,
      });
      setDraftText(result.text);
      setPromptBuilderMode("manual");
    } catch (e) {
      setBuilderError(e instanceof Error ? e.message : "Failed to build prompt text");
    } finally {
      setBuilderBuilding(false);
    }
  }

  async function savePrompts() {
    setError(null);
    setPromptsSaveSuccess(false);
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

      // Save content optimization profiles and humanization settings
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
      setPromptsSaveSuccess(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save prompts");
    } finally {
      setPromptsSaving(false);
    }
  }

  function openLinkModal(id: string, forceIsNew?: boolean) {
    const row = linkDrafts.find((x) => x.id === id);
    setLinkPhrase(row?.label || "");
    setLinkUrl(row?.url || "");
    setLinkDuplicateConflicts([]);
    setLinkSaveAttempted(false);
    setShowLinkModal({ id, isNew: forceIsNew ?? !!row?.isNew });
  }

  function checkPhrasesForDuplicates(
    rawInput: string,
    excludeId: string,
  ): Array<{ phrase: string; conflict: LinkDraft }> {
    const phrases = rawInput.split(",").map((p) => p.trim()).filter(Boolean);
    const results: Array<{ phrase: string; conflict: LinkDraft }> = [];
    const seenInBatch = new Map<string, string>();
    for (const phrase of phrases) {
      const key = phrase.toLowerCase();
      const existingConflict = linkDrafts.find(
        (x) => x.id !== excludeId && (x.label || "").trim().toLowerCase() === key,
      );
      if (existingConflict) {
        results.push({ phrase, conflict: existingConflict });
      } else if (seenInBatch.has(key)) {
        results.push({
          phrase,
          conflict: { id: "__batch__", label: seenInBatch.get(key)!, url: "(entered above in this batch)", isNew: true },
        });
      } else {
        seenInBatch.set(key, phrase);
      }
    }
    return results;
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
    openLinkModal(tmpId, true);
  }

  function markDeleteLink(id: string) {
    askConfirm({
      title: "Delete this context link?",
      body: "This removes it from the list. The change applies once you click “Save changes”.",
      confirmLabel: "Delete link",
      danger: true,
      onConfirm: () => {
        setLinkDrafts((p) => p.filter((x) => x.id !== id));
        setLinkDeleted((s) => new Set([...Array.from(s), id]));
      },
    });
  }

  async function saveContextLinks() {
    setError(null);
    // Guard: detect duplicate phrases before committing to the API.
    const seenPhrases = new Map<string, string>();
    for (const d of linkDrafts) {
      const key = (d.label || "").trim().toLowerCase();
      if (!key) continue;
      if (seenPhrases.has(key)) {
        setError(
          `Duplicate phrase detected: "${d.label}" appears more than once. Each phrase must be unique before saving.`
        );
        return;
      }
      seenPhrases.set(key, d.id);
    }
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
    if (s === "queued") return `${styles.statusPill} ${styles.statusQueued}`;
    if (s === "generating") return `${styles.statusPill} ${styles.statusGenerating}`;
    return `${styles.statusPill} ${styles.statusNeutral}`;
  }

  function formatSupportingKeywords(keywords?: string[] | null): string {
    const parts = (keywords || []).map((k) => String(k).trim()).filter(Boolean);
    return parts.length ? parts.join(", ") : "—";
  }

  function renderArticleActions(a: ArticleListItem, title: string, iconBtnClass: string) {
    const inProgressStatus = (a.status || "").toLowerCase();
    if (inProgressStatus === "queued") {
      return (
        <span className={`${styles.articleInProgressBadge} ${styles.statusQueued}`} aria-label="Article is waiting in the generation queue">
          In Queue
        </span>
      );
    }
    if (inProgressStatus === "generating") {
      return (
        <span className={`${styles.articleInProgressBadge} ${styles.statusGenerating}`} aria-label="Article is currently being generated">
          Generating...
        </span>
      );
    }
    return (
      <>
        <Link
          href={`/projects/${projectId}/articles/${a.id}`}
          className={iconBtnClass}
          aria-label={`Edit ${title}`}
          data-tooltip="Edit article"
          onMouseEnter={() => api.prefetchArticle(projectId, a.id)}
        >
          <Icon.Edit />
        </Link>
        <button
          type="button"
          className={iconBtnClass}
          aria-label={`Schedule ${title}`}
          data-tooltip="Schedule article"
          onClick={() => {
            void ensureScheduleMetaLoaded();
            const min = new Date(Date.now() + 10 * 60 * 1000);
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
          <Icon.Calendar />
        </button>
        <span
          className={styles.articlesTableTooltipWrap}
          data-tooltip={!a.wp_link ? "Publish first to get a live URL" : "Request indexing in Search Console"}
        >
          <button
            type="button"
            className={iconBtnClass}
            aria-label={`Request indexing for ${title}`}
            disabled={!a.wp_link}
            onClick={() => {
              setRequestIndexingId(a.id);
              setRequestIndexingMsg("");
            }}
          >
            <Icon.Globe />
          </button>
        </span>
        {a.wp_link ? (
          <button
            type="button"
            className={iconBtnClass}
            aria-label={a.monitor_status === "fresh" ? `Mark ${title} stale` : `Mark ${title} fresh`}
            data-tooltip={a.monitor_status === "fresh" ? "Mark stale for refresh" : "Mark fresh"}
            onClick={() =>
              markArticleMonitor(a.id, (a.monitor_status === "fresh" ? "stale" : "fresh") as "fresh" | "stale")
            }
          >
            <Icon.Refresh />
          </button>
        ) : null}
        <button
          type="button"
          className={`${iconBtnClass} ${styles.articlesTableIconBtnDanger}`}
          aria-label={`Delete ${title}`}
          data-tooltip="Delete article"
          onClick={() => setConfirmDeleteId(a.id)}
        >
          <Icon.Trash />
        </button>
      </>
    );
  }

  function jobStateLabel(s: string) {
    const v = (s || "").toLowerCase();
    if (v === "scheduled") return "Scheduled";
    if (v === "content_generating") return "Generating content";
    if (v === "image_generating") return "Generating image";
    if (v === "ready_to_post") return "Ready to post";
    if (v === "posting") return "Posting…";
    if (v === "posted") return "Posted";
    if (v === "failed") return "Failed";
    if (v === "cancelled") return "Cancelled";
    return v || "Unknown";
  }

  function jobStateClass(s: string) {
    const v = (s || "").toLowerCase();
    const base = styles.scheduledStatePill;
    if (v === "ready_to_post") return `${base} ${styles.scheduledStateReady}`;
    if (v === "posted") return `${base} ${styles.scheduledStatePosted}`;
    if (v === "failed") return `${base} ${styles.scheduledStateFailed}`;
    if (v === "posting" || v === "content_generating" || v === "image_generating") {
      return `${base} ${styles.scheduledStateActive}`;
    }
    if (v === "scheduled") return `${base} ${styles.scheduledStateScheduled}`;
    return `${base} ${styles.scheduledStateNeutral}`;
  }

  const tabLabel: Record<TabKey, string> = {
    overview: "Overview",
    articles: "Articles",
    products: "Products",
    research: "Research",
    scheduled_articles: "Scheduled Articles",
    prompts: "Prompts",
    context_links: "Context links",
    tools: "Tools",
    // The Performance & Analysis tab is only useful once Search Console is connected
    // *and* the analytics endpoint has returned data — we hide the nav entry until
    // both conditions are true (see ``visibleTabs`` below). The label still lives
    // in this map so deep-links and persistence keep working.
    performance: "Performance & Analysis",
    members: "Members",
    project_settings: "Project Settings",
  };

  function goTab(next: TabKey) {
    if (next === tab) return;
    if ((tab === "tools" || tab === "project_settings") && !confirmLoseChanges()) return;
    setTab(next);
    setMobileNavOpen(false);
  }

  function goToArticlesFromOverview(filterStatus?: string) {
    if (filterStatus) {
      setStatus(filterStatus as StatusFilter);
      setPage(1);
    }
    goTab("articles");
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
  const visibleTabs: TabKey[] = SIDEBAR_TAB_ORDER.filter((k) => {
    if (k === "products") return isShopifyProject;
    if (k === "performance") return performanceTabAvailable;
    return true;
  });

  function renderNavLabel(k: TabKey) {
    return (
      <>
        <ProjectTabIcon tab={k as ProjectTabKey} className={styles.navItemIcon} />
        <span className={styles.navItemLabel}>{tabLabel[k]}</span>
      </>
    );
  }

  // ---------------------------------------------------------------------------
  // Research helpers (seeds, runs, filters, import)
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Topic cluster planner (Research tab)
  // ---------------------------------------------------------------------------

  async function resumePollingForBusyClusters(rows: TopicCluster[]) {
    const busy = rows.filter((c) =>
      TOPIC_CLUSTER_BUSY_STATUSES.has((c.status || "").toLowerCase()),
    );
    for (const cl of busy) {
      const clusterId = (cl.id || "").trim();
      if (!clusterId) continue;
      try {
        const row = await api.waitForTopicClusterReady(projectId, clusterId, {
          skipGlobalLoading: true,
          onProgress: (progress) => {
            setTopicClusters((prev) => prev.map((c) => (c.id === progress.id ? progress : c)));
          },
        });
        setTopicClusters((prev) => prev.map((c) => (c.id === row.id ? row : c)));
      } catch {
        // Stale busy rows or worker errors — user can reload or retry manually.
      }
    }
  }

  async function reloadTopicClusters() {
    if (!projectId) return;
    setTopicClustersLoading(true);
    setTopicClustersErr(null);
    try {
      const res = await api.topicClusterList(projectId);
      const rows = res.clusters || [];
      setTopicClusters(rows);
      void resumePollingForBusyClusters(rows);
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
      const row = await api.topicClusterPlan(
        projectId,
        {
          seed_intent: seed,
          country_code: researchCountry,
          tone: researchTone,
          language: researchLanguage,
        },
        {
          skipGlobalLoading: true,
          onProgress: (progress) => {
            setTopicClusters((prev) => mergeTopicClusterInList(prev, progress));
            const status = (progress.status || "").toLowerCase();
            if (TOPIC_CLUSTER_BUSY_STATUSES.has(status)) {
              setClusterPlanMsg(
                status === "planning"
                  ? "Planning cluster map…"
                  : "Generating cluster articles…",
              );
            }
          },
        },
      );
      setTopicClusters((prev) => mergeTopicClusterInList(prev, row));
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
      !!(cluster.pillar?.title || "").trim() &&
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
        if (code === "website_not_connected") {
          return {
            title: "Website not connected",
            message:
              msg ||
              "Website is not connected for this project. Connect and verify WordPress in Project Settings to generate or schedule articles.",
          };
        }
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
  async function generateForCluster(
    clusterId: string,
    opts?: {
      topicIds?: string[] | null;
      writingPromptId?: string | null;
      imagePromptId?: string | null;
      mappedProducts?: MappedShopifyProduct[] | null;
    },
  ) {
    // Shopify projects can generate drafts without the store being connected yet.
    // WordPress projects still require a verified connection for generation.
    if (!isShopifyProject) {
      if (
        !requireWebsiteConnectedForAction(
          "Website is not connected for this project. Connect and verify WordPress before generating articles.",
        )
      )
        return;
    }
    const effective = effectiveSelectionForCluster(clusterId);
    const topicIds = opts?.topicIds === undefined ? effective.topicIds : opts.topicIds;
    const pendingCount = topicIds ? topicIds.length : effective.pendingCount;
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
        const q = await api.articleQuota(projectId, { fresh: true });
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

      const mapped =
        isShopifyProject && opts?.mappedProducts?.length ? opts.mappedProducts : undefined;
      const res = await api.topicClusterGenerateAll(
        projectId,
        clusterId,
        {
          generate_image: true,
          writing_prompt_id: opts?.writingPromptId || null,
          image_prompt_id: opts?.imagePromptId || null,
          topic_ids: topicIds,
          mapped_products: mapped,
        },
        {
          skipGlobalLoading: true,
          onProgress: (progress) => {
            setTopicClusters((prev) => prev.map((c) => (c.id === progress.id ? progress : c)));
          },
        },
      );
      setTopicClusters((prev) => prev.map((c) => (c.id === res.cluster.id ? res.cluster : c)));
      void refreshArticleQuota();
      clearClusterSelection(clusterId);
      if (res.errors?.length) {
        setClusterErrorModal({
          title: "Some articles couldn't be generated",
          message: `Finished with ${res.errors.length} error${res.errors.length === 1 ? "" : "s"}. The successful drafts are now linked in the cluster.`,
          detail: res.errors.map((e) => `• ${e.topic_id}: ${e.message}`).join("\n"),
        });
      } else {
        setClusterPlanMsg("All selected articles and featured images generated. Open them from the links below.");
      }
    } catch (e) {
      setClusterErrorModal(buildErrorModalFromApiError(e, "Generation failed"));
    } finally {
      setClusterBulkBusy(null);
    }
  }

  async function openGenerateForCluster(clusterId: string) {
    if (!isShopifyProject) {
      if (
        !requireWebsiteConnectedForAction(
          "Website is not connected for this project. Connect and verify WordPress before generating articles.",
        )
      )
        return;
    }
    const { topicIds, pendingCount } = effectiveSelectionForCluster(clusterId);
    if (pendingCount === 0) {
      setClusterErrorModal({
        title: "Nothing to generate",
        message: "Every topic in this cluster has already been generated.",
      });
      return;
    }
    const prompts = await ensureScheduleMetaLoaded();
    if (isShopifyProject) {
      void loadShopifyCatalogIfNeeded();
    }
    setClusterGeneratePromptModal({
      clusterId,
      topicIds,
      pendingCount,
      writingPromptId: prompts.writingPrompts?.default_id || "",
      imagePromptId: prompts.imagePrompts?.default_id || "",
      mappedProducts: [],
      step: "prompts",
      busy: false,
    });
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

  /** Open bulk schedule modal for a cluster (selected slots or all pending). */
  async function openScheduleForCluster(clusterId: string) {
    if (!requireWebsiteConnectedForAction("Website is not connected for this project. Connect and verify WordPress before scheduling articles.")) return;
    const cluster = topicClusters.find((c) => c.id === clusterId);
    if (!cluster) return;
    const { topicIds, pendingCount } = effectiveSelectionForCluster(clusterId);
    if (pendingCount === 0) {
      setClusterErrorModal({
        title: "Nothing to schedule",
        message: "Every topic in this cluster has already been imported.",
      });
      return;
    }
    const seedRows = buildClusterScheduleSeeds(cluster, topicIds);
    if (!seedRows.length) {
      setClusterErrorModal({
        title: "Nothing to schedule",
        message: "No pending topics are available to schedule.",
      });
      return;
    }
    await ensureScheduleMetaLoaded();
    setResearchScheduleError(null);
    setResearchScheduleModal({ kind: "cluster", clusterId, topicIds, seedRows });
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

  async function importResearchIdeaRows(
    selected: ResearchIdeaRow[],
    opts: { skipDuplicates: boolean; successVerb: string },
  ): Promise<{ articleIds: string[]; refreshedArticles: ArticlePublic[]; created: number; skipped: number } | null> {
    setError(null);
    setResearchMsg(null);
    setResearchImportMsg(null);
    if (researchImporting) return null;

    if (!selected.length) return null;
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
      await reloadArticleTitles();
      const titleRows = await api.listArticleTitles(projectId);
      const titleToId = new Map<string, string>();
      for (const a of titleRows) {
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
        `${opts.successVerb} ${res.created} article${res.created === 1 ? "" : "s"}${skipped ? ` (${skipped} skipped as duplicates)` : ""}.`
      );
      setResearchFilter("imported");
      await refreshArticlesList();
      return {
        articleIds: selected
          .map((r) => titleToId.get((r.title || "").trim().toLowerCase()))
          .filter((id): id is string => !!id),
        refreshedArticles: [],
        created: res.created,
        skipped,
      };
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
          return null;
        }
      }
      setResearchImportMsg(e instanceof Error ? e.message : "Import failed");
      return null;
    } finally {
      setResearchImporting(false);
    }
  }

  async function importSelectedIdeas(opts: { skipDuplicates: boolean }) {
    const selected = researchResults.filter((r) => researchSelected.has(r.id) && !r.imported);
    await importResearchIdeaRows(selected, { skipDuplicates: opts.skipDuplicates, successVerb: "Imported" });
  }

  async function openCurationPromptModal(action: "generate" | "schedule") {
    if (!isShopifyProject) {
      if (
        !requireWebsiteConnectedForAction(
          action === "generate"
            ? "Website is not connected for this project. Connect and verify WordPress before generating articles."
            : "Website is not connected for this project. Connect and verify WordPress before scheduling articles.",
        )
      ) {
        return;
      }
    } else if (action === "schedule") {
      if (!(settings?.shopify_access_token || "").trim()) {
        openWebsiteConnectionPopup(
          "Connect your Shopify store in Project Settings before scheduling articles.",
        );
        return;
      }
    }
    const selected = researchResults.filter((r) => researchSelected.has(r.id) && !r.imported);
    if (!selected.length) {
      setResearchImportMsg("Select at least one not-imported idea first.");
      return;
    }
    if (action === "schedule") {
      await ensureScheduleMetaLoaded();
      setResearchScheduleError(null);
      setResearchScheduleModal({
        kind: "curation",
        ideaIds: selected.map((r) => r.id),
        seedRows: selected.map((r) => ({ id: r.id, title: r.title })),
      });
      return;
    }
    const prompts = await ensureScheduleMetaLoaded();
    if (isShopifyProject) {
      void loadShopifyCatalogIfNeeded();
    }
    setCurationPromptModal({
      ideaIds: selected.map((r) => r.id),
      writingPromptId: prompts.writingPrompts?.default_id || "",
      imagePromptId: prompts.imagePrompts?.default_id || "",
      mappedProducts: [],
      step: "prompts",
      busy: false,
    });
  }

  async function confirmCurationPromptAction() {
    const m = curationPromptModal;
    if (!m || m.busy) return;
    setCurationPromptModal({ ...m, busy: true });
    const selected = researchResults.filter((r) => m.ideaIds.includes(r.id) && !r.imported);
    try {
      const q = await api.articleQuota(projectId, { fresh: true }).catch(() => null);
      if (q && !q.unlimited && (q.max_can_consume_now ?? 0) < selected.length) {
        setResearchImportMsg(
          `Article generation limit reached. Your plan allows ${q.max_can_consume_now ?? 0} more generation${(q.max_can_consume_now ?? 0) === 1 ? "" : "s"} right now, but ${selected.length} selected idea${selected.length === 1 ? "" : "s"} need generation.`,
        );
        return;
      }

      const imported = await importResearchIdeaRows(selected, {
        skipDuplicates: false,
        successVerb: "Imported for generation",
      });
      if (!imported?.articleIds.length) return;

      const mapped = isShopifyProject && m.mappedProducts.length ? m.mappedProducts : undefined;
      // Fire all generation requests in parallel and return immediately.
      // Each POST enqueues the job in the Redis queue; the worker processes them.
      // Waiting serially for each article would block the UI for up to 10 min per article.
      await Promise.allSettled(
        imported.articleIds.map((articleId) =>
          api.generateArticle(
            projectId,
            articleId,
            {
              writing_prompt_id: m.writingPromptId || null,
              image_prompt_id: m.imagePromptId || null,
              generate_image: true,
              mapped_products: mapped,
            },
            { skipGlobalLoading: true, noWait: true },
          ),
        ),
      );
      const count = imported.articleIds.length;
      setResearchImportMsg(
        `${count} article${count === 1 ? "" : "s"} queued for generation. Check the Articles tab for progress.`,
      );
      setToast({
        message: `${count} article${count === 1 ? "" : "s"} queued for generation`,
        tone: "success",
      });
      void refreshArticleQuota();
      await reloadArticleTitles();
      void refreshArticlesList();
      setCurationPromptModal(null);
      setResearchFilter("imported");
    } catch (e) {
      const modal = buildErrorModalFromApiError(e, "Generation failed");
      setResearchImportMsg([modal.message, modal.detail].filter(Boolean).join("\n"));
    } finally {
      setCurationPromptModal((current) => (current ? { ...current, busy: false } : current));
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
    Edit: (props: { className?: string }) => (
      <svg viewBox="0 0 24 24" aria-hidden="true" className={props.className}>
        <path
          d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
    Status: (props: { className?: string }) => (
      <svg viewBox="0 0 24 24" aria-hidden="true" className={props.className}>
        <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.75" />
        <path d="M8 12h8" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
      </svg>
    ),
    Calendar: (props: { className?: string }) => (
      <svg viewBox="0 0 24 24" aria-hidden="true" className={props.className}>
        <rect x="3" y="4" width="18" height="18" rx="2" fill="none" stroke="currentColor" strokeWidth="1.75" />
        <path d="M16 2v4M8 2v4M3 10h18" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
      </svg>
    ),
    Trash: (props: { className?: string }) => (
      <svg viewBox="0 0 24 24" aria-hidden="true" className={props.className}>
        <path
          d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
    ChevronRight: (props: { className?: string }) => (
      <svg viewBox="0 0 24 24" aria-hidden="true" className={props.className}>
        <path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
    Document: (props: { className?: string }) => (
      <svg viewBox="0 0 24 24" aria-hidden="true" className={props.className}>
        <path
          d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M9 13h6M9 17h4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
    Layers: (props: { className?: string }) => (
      <svg viewBox="0 0 24 24" aria-hidden="true" className={props.className}>
        <path
          d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
    Globe: (props: { className?: string }) => (
      <svg viewBox="0 0 24 24" aria-hidden="true" className={props.className}>
        <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.75" />
        <path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18" fill="none" stroke="currentColor" strokeWidth="1.75" />
      </svg>
    ),
    Pen: (props: { className?: string }) => (
      <svg viewBox="0 0 24 24" aria-hidden="true" className={props.className}>
        <path
          d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
    Image: (props: { className?: string }) => (
      <svg viewBox="0 0 24 24" aria-hidden="true" className={props.className}>
        <rect x="3" y="3" width="18" height="18" rx="2" fill="none" stroke="currentColor" strokeWidth="1.75" />
        <circle cx="8.5" cy="8.5" r="1.5" fill="currentColor" />
        <path d="M21 15l-5-5L5 21" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
    Clock: (props: { className?: string }) => (
      <svg viewBox="0 0 24 24" aria-hidden="true" className={props.className}>
        <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.75" />
        <path d="M12 7v5l3 2" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
      </svg>
    ),
    List: (props: { className?: string }) => (
      <svg viewBox="0 0 24 24" aria-hidden="true" className={props.className}>
        <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
      </svg>
    ),
    Repeat: (props: { className?: string }) => (
      <svg viewBox="0 0 24 24" aria-hidden="true" className={props.className}>
        <path
          d="M17 1l4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 23l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
    CalendarMonth: (props: { className?: string }) => (
      <svg viewBox="0 0 24 24" aria-hidden="true" className={props.className}>
        <rect x="3" y="4" width="18" height="18" rx="2" fill="none" stroke="currentColor" strokeWidth="1.75" />
        <path d="M16 2v4M8 2v4M3 10h18M7 14h2M11 14h2M15 14h2" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
      </svg>
    ),
  };

  const scheduledVisible = useMemo(() => {
    const q = scheduledSearch.trim().toLowerCase();
    const titleFor = (articleId: string) => articleTitleFor(articleId).trim();
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
  }, [articleTitlesById, selectedMeta, scheduledJobs, scheduledOrder, scheduledSearch]);

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
  const websiteConnected = isShopifyProject
    ? (settings?.shopify_verified_status || "").trim().toLowerCase() === "connected" &&
      !!(settings?.shopify_verified_at || "").trim()
    : (settings?.wp_verified_status || "").trim().toLowerCase() === "connected" ||
      wpCatsForSchedule.length > 0;
  const showWebsiteRequiredOverlay = tab === "articles" && !loading && !websiteConnected;

  function formatRenewalDate(raw?: string | null) {
    const v = (raw || "").trim();
    if (!v) return "the next plan renewal";
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return v;
    const tz = profileTz || Intl.DateTimeFormat().resolvedOptions().timeZone;
    try {
      return new Intl.DateTimeFormat(undefined, {
        timeZone: tz,
        year: "numeric",
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }).format(d);
    } catch {
      return d.toLocaleString();
    }
  }

  function openWebsiteConnectionPopup(message?: string) {
    setWebsiteConnectionModal({
      title: "Website not connected",
      message:
        message ||
        (isShopifyProject
          ? "Connect your Shopify store in Project Settings to generate and schedule product-aware articles."
          : "Website is not connected for this project. Connect and verify WordPress in Project Settings to generate, schedule, or publish articles."),
    });
  }

  function requireWebsiteConnectedForAction(message?: string) {
    if (websiteConnected) return true;
    openWebsiteConnectionPopup(message);
    return false;
  }

  function showWebsiteConnectionErrorIfNeeded(e: unknown) {
    if (e instanceof ApiError && e.detail && typeof e.detail === "object" && !Array.isArray(e.detail)) {
      const d = e.detail as Record<string, unknown>;
      if (d.code === "website_not_connected") {
        openWebsiteConnectionPopup(typeof d.message === "string" ? d.message : undefined);
        return true;
      }
    }
    return false;
  }

  function monthlyLimitStatus(label: string, limit?: import("@/lib/api").MonthlyFeatureLimit | null) {
    if (!limit) return null;
    if (limit.enabled === false) {
      return `${label}: not enabled for your ${featureLimits?.plan_key || "current"} plan.`;
    }
    if (limit.unlimited) return `${label}: unlimited for this plan.`;
    const used = Number(limit.month_used || 0);
    const max = Number(limit.month_limit || 0);
    const remaining = typeof limit.month_remaining === "number" ? limit.month_remaining : Math.max(0, max - used);
    if (remaining <= 0) {
      return `the max limit of ${label} is exhausted and will be renewed on ${formatRenewalDate(limit.month_reset_at)}.`;
    }
    return `${label}: ${used}/${max} used this month (${remaining} remaining).`;
  }

  function articleGenerationLimitStatus() {
    if (!articleQuota) return null;
    if (articleQuota.unlimited) return "Article generation: unlimited for this plan.";
    const pieces: string[] = [];
    if (typeof articleQuota.day_limit === "number") {
      pieces.push(`${articleQuota.day_used}/${articleQuota.day_limit} daily`);
    }
    if (typeof articleQuota.month_limit === "number") {
      pieces.push(`${articleQuota.month_used}/${articleQuota.month_limit} monthly`);
    }
    if ((articleQuota.max_can_consume_now ?? 0) <= 0) {
      const resetAt =
        articleQuota.day_remaining === 0
          ? articleQuota.day_reset_at
          : articleQuota.month_reset_at || articleQuota.day_reset_at;
      return `the max limit of Article generation is exhausted and will be renewed on ${formatRenewalDate(resetAt)}.`;
    }
    return `Article generation: ${pieces.join(", ")} (${articleQuota.max_can_consume_now ?? 0} available now).`;
  }

  function contextLinksLimitStatus() {
    const cap = featureLimits?.context_links;
    if (!cap) return null;
    if (cap.unlimited) return "Context links: unlimited for this plan.";
    if ((cap.remaining ?? 0) <= 0) {
      return `the max limit of Context links is exhausted and will be renewed on ${formatRenewalDate(cap.renews_at)}.`;
    }
    return `Context links: ${cap.used}/${cap.limit} used (${cap.remaining} remaining).`;
  }

  function renderLimitStrip(items: Array<string | null | undefined>) {
    const lines = items.filter(Boolean) as string[];
    if (!lines.length) return null;
    return (
      <div className={styles.limitStatusStrip}>
        {lines.map((line) => (
          <span key={line} className={line.startsWith("the max limit") ? styles.limitStatusExhausted : undefined}>
            {line}
          </span>
        ))}
      </div>
    );
  }

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
                    {renderNavLabel(k)}
                  </button>
                ))}
              </div>
              <Link
                href="/dashboard?section=profile"
                className={`${styles.sidebarAccountCard} ${styles.sidebarAccountLink}`}
                onClick={() => setMobileNavOpen(false)}
              >
                <div className={styles.sidebarAvatar} aria-hidden="true">
                  {(sidebarEmail || "U").charAt(0).toUpperCase()}
                </div>
                <div className={styles.sidebarAccountMeta}>
                  <div className={styles.sidebarAccountEmail} title={sidebarEmail || "Signed in"}>
                    {sidebarEmail || "Signed in"}
                  </div>
                  <div className={styles.sidebarAccountPlan}>Plan: {sidebarPlan}</div>
                </div>
              </Link>
            </div>
          </>
        ) : null}

        <div className={styles.shell}>
          {toast ? (
            <div className={styles.toast} data-tone={toast.tone} role="status" aria-live="polite">
              {toast.message}
            </div>
          ) : null}
          <aside className={styles.sidebar} aria-label="Project navigation">
            <Link href="/dashboard" className={styles.sidebarBrand} aria-label="Riviso — go to dashboard">
              <Image
                src="/riviso-logo.png"
                alt=""
                width={32}
                height={32}
                priority
                className={styles.sidebarBrandLogo}
              />
              <span className={styles.sidebarBrandText}>Riviso</span>
            </Link>
            <div className={styles.sidebarNavMain}>
            
            <Link className={styles.sidebarBackLink} href="/dashboard">
              <SidebarBackIcon className={styles.sidebarBackIcon} aria-hidden="true" />
              <span>Back to dashboard</span>
            </Link>

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
                  {renderNavLabel(k)}
                </button>
              ))}
            </div>
            </div>
            <div className={styles.sidebarFooter}>
            <Link
              href="/dashboard?section=profile"
              className={`${styles.sidebarAccountCard} ${styles.sidebarAccountLink}`}
            >
              <div className={styles.sidebarAvatar} aria-hidden="true">
                {(sidebarEmail || "U").charAt(0).toUpperCase()}
              </div>
              <div className={styles.sidebarAccountMeta}>
                <div className={styles.sidebarAccountEmail} title={sidebarEmail || "Signed in"}>
                  {sidebarEmail || "Signed in"}
                </div>
                <div className={styles.sidebarAccountPlan}>Plan: {sidebarPlan}</div>
              </div>
            </Link>
            </div>
          </aside>

          <section className={styles.contentCol}>
            <div className={styles.intro} style={{ paddingTop: 0 }}>
              {tab === "overview" ? (
                <>
                  <div className={`${styles.desktopHeadRow} ${styles.hideOnMobile}`}>
                    <h1 style={{ margin: 0 }}>Overview</h1>
                  </div>
                  <div className={`${styles.mobileHeadRow} ${styles.showOnMobile}`}>
                    <h1 className={styles.mobileTitle} style={{ margin: 0 }}>
                      Overview
                    </h1>
                  </div>
                </>
              ) : tab === "articles" ? (
                <>
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
                    <button
                      className={`${styles.chipButton} ${styles.chipButtonPrimary}${status || dateFrom || dateTo ? ` ${styles.chipButtonFilterActive}` : ""}`}
                      type="button"
                      onClick={() => setShowMobileFilters(true)}
                      aria-expanded={showMobileFilters}
                    >
                      Filter{status || dateFrom || dateTo ? " · On" : ""}
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
              ) : tab === "products" ? (
                <>
                  <div className={`${styles.desktopHeadRow} ${styles.hideOnMobile}`}>
                    <h1 style={{ margin: 0 }}>Products</h1>
                    <button
                      className={styles.btnSecondary}
                      type="button"
                      onClick={() => void runShopifyProductSync()}
                      disabled={!isShopifyProject || shopifyCatalogSyncing}
                      title="Sync products from Shopify"
                    >
                      {shopifyCatalogSyncing ? "Syncing…" : "Sync from Shopify"}
                    </button>
                  </div>
                  <div className={`${styles.mobileHeadRow} ${styles.showOnMobile}`}>
                    <h1 className={styles.mobileTitle} style={{ margin: 0 }}>
                      Products
                    </h1>
                    <button
                      className={styles.btnSecondary}
                      type="button"
                      onClick={() => void runShopifyProductSync()}
                      disabled={!isShopifyProject || shopifyCatalogSyncing}
                      title="Sync products from Shopify"
                    >
                      {shopifyCatalogSyncing ? "Syncing…" : "Sync"}
                    </button>
                  </div>
                  <p className={styles.muted} style={{ margin: "8px 0 0", lineHeight: 1.55 }}>
                    All products fetched from Shopify for this project. This table uses the latest synced snapshot.
                  </p>
                </>
              ) : (
                <>
                  <h1 style={{ margin: 0 }}>{tabLabel[tab]}</h1>
                  {tab === "research" ? (
                    <p className={styles.researchPageLead}>
                      Plan topical clusters or run keyword curations — then generate, import, or schedule articles in one flow.
                    </p>
                  ) : null}
                  {tab === "project_settings" ? (
                    <p className={styles.settingsPageLead}>
                      {isShopifyProject
                        ? "Connect your Shopify store, define how the AI writes, and sync your catalog for product-aware articles."
                        : "Connect WordPress, define how the AI writes, and set publishing defaults for this project."}
                    </p>
                  ) : null}
                  {tab === "prompts" ? (
                    <p className={styles.promptsPageLead}>
                      Manage writing and image prompts for generation and scheduling. Set project defaults or override per article.
                    </p>
                  ) : null}
                </>
              )}
            </div>

        {tab === "overview" ? (
          <ArticlesOverview
            projectId={projectId}
            styles={styles as unknown as Record<string, string>}
            articles={overviewArticles}
            scheduledJobs={overviewScheduledJobs}
            titleByArticleId={articleTitlesById}
            selectedIds={selectedIds}
            gscTotals={analytics?.totals ?? null}
            loading={overviewLoading}
            lastRefreshedAt={overviewRefreshedAt}
            onRefresh={() => setOverviewRefreshKey((k) => k + 1)}
            onViewList={goToArticlesFromOverview}
          />
        ) : tab === "products" ? (
          <>
            {shopifyCatalogErr ? <p className={styles.error}>{shopifyCatalogErr}</p> : null}
            {shopifyCatalogNotice && !shopifyCatalogErr ? (
              <p className={styles.muted} style={{ marginTop: 8, lineHeight: 1.5, color: "rgba(150,191,72,0.92)" }}>
                {shopifyCatalogNotice}
              </p>
            ) : null}
            {(shopifyCatalog?.granted_scopes?.length || shopifyCatalog?.recommended_scopes?.length) ? (
              <div
                style={{
                  marginTop: 10,
                  padding: "12px 14px",
                  borderRadius: 10,
                  border: "1px solid color-mix(in oklab, var(--border, #333), transparent 40%)",
                  fontSize: 12,
                  lineHeight: 1.5,
                }}
              >
                <strong>Token scopes (from last connect/sync)</strong>
                <p className={styles.muted} style={{ margin: "6px 0 0" }}>
                  Riviso only receives scopes Shopify issues on the token — not every scope listed on your app page
                  unless they are on the <strong>active released version</strong> and you reconnected after release.
                </p>
                <p style={{ margin: "8px 0 0" }}>
                  <span className={styles.muted}>On token: </span>
                  {(shopifyCatalog?.granted_scopes || []).length > 0 ? (
                    (shopifyCatalog?.granted_scopes || []).map((s) => (
                      <code key={s} style={{ marginRight: 6 }}>
                        {s}
                      </code>
                    ))
                  ) : (
                    <span className={styles.muted}>unknown — reconnect in Project Settings</span>
                  )}
                </p>
                <p style={{ margin: "8px 0 0" }}>
                  <span className={styles.muted}>Required on token (Shopify Admin API): </span>
                  {(shopifyCatalog?.required_scopes || ["read_products", "read_content"]).map((s) => {
                    const has = (shopifyCatalog?.granted_scopes || []).includes(s);
                    return (
                      <code
                        key={s}
                        style={{
                          marginRight: 6,
                          color: has ? "rgba(150,191,72,0.95)" : "rgba(230,120,80,0.95)",
                        }}
                      >
                        {s}
                        {has ? " ✓" : " (missing on token)"}
                      </code>
                    );
                  })}
                </p>
                {(shopifyCatalog?.recommended_scopes || []).length > 0 ? (
                  <p className={styles.muted} style={{ margin: "8px 0 0", fontSize: 11 }}>
                    Optional: {(shopifyCatalog?.recommended_scopes || [])
                      .filter((s) => !(shopifyCatalog?.required_scopes || []).includes(s))
                      .join(", ")}
                  </p>
                ) : null}
              </div>
            ) : null}
            {(shopifyCatalog?.warnings || []).length > 0 ? (
              <div
                style={{
                  marginTop: 10,
                  padding: "12px 14px",
                  borderRadius: 10,
                  border: "1px solid color-mix(in oklab, #e6b422, transparent 50%)",
                  background: "color-mix(in oklab, #e6b422 12%, transparent)",
                  fontSize: 13,
                  lineHeight: 1.5,
                }}
              >
                <strong>Sync notes</strong>
                <ul style={{ margin: "8px 0 0", paddingLeft: "1.2rem" }}>
                  {(shopifyCatalog?.warnings || []).map((w, i) => (
                    <li key={`${w.resource}-${i}`}>{w.message}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {shopifyCatalogLoading ? <InlineListSkeleton rows={6} /> : null}
            {!shopifyCatalogLoading ? (
              <div className={`${styles.card} ${styles.cardWide}`} style={{ marginTop: 14 }}>
                <div className={styles.sectionHead}>
                  <div>
                    <h2 style={{ margin: 0, color: "#fff" }}>Shopify products</h2>
                    <div className={styles.muted} style={{ marginTop: 6 }}>
                      {shopifyCatalog?.synced_at
                        ? `Last synced: ${shopifyCatalog.synced_at}`
                        : "Not synced yet. Click “Sync from Shopify” above."}
                      {shopifyCatalog?.sync_message && shopifyCatalog.sync_status === "partial" ? (
                        <span style={{ display: "block", marginTop: 6, color: "rgba(230,180,60,0.95)" }}>
                          {shopifyCatalog.sync_message}
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <div className={styles.row} style={{ justifyContent: "flex-end", gap: 10, flexWrap: "wrap" }}>
                    <label className={styles.muted} style={{ fontSize: 12, fontWeight: 800 }}>
                      Status{" "}
                      <select
                        className={styles.select}
                        value={shopifyProductStatus}
                        onChange={(e) => setShopifyProductStatus((e.target.value || "") as "" | "active" | "draft" | "archived")}
                        style={{ marginLeft: 8, minWidth: 190 }}
                      >
                        <option value="">All products</option>
                        <option value="active">Active</option>
                        <option value="draft">Draft</option>
                        <option value="archived">Unlisted / Archived</option>
                      </select>
                    </label>
                    <div className={styles.muted} style={{ fontSize: 12, alignSelf: "center" }}>
                      {(() => {
                        const items = (shopifyCatalog?.products || []).filter((p) => {
                          const st = String((p as { status?: string }).status || "").trim().toLowerCase();
                          if (!shopifyProductStatus) return true;
                          return st === shopifyProductStatus;
                        });
                        return `${items.length} items`;
                      })()}
                    </div>
                  </div>
                </div>

                {(() => {
                  const products = (shopifyCatalog?.products || []).filter((p) => {
                    const st = String((p as { status?: string }).status || "").trim().toLowerCase();
                    if (!shopifyProductStatus) return true;
                    return st === shopifyProductStatus;
                  });
                  return products.length;
                })() === 0 ? (
                  <p className={styles.muted} style={{ marginTop: 8 }}>
                    No products found in the catalog snapshot.
                  </p>
                ) : (
                  <div style={{ width: "100%", overflowX: "auto" }}>
                    <table className={styles.table} style={{ marginTop: 10 }}>
                      <thead>
                        <tr>
                          <th className={styles.th} style={{ width: 64 }}>
                            Image
                          </th>
                          <th className={styles.th}>Title</th>
                          <th className={styles.th} style={{ width: 140 }}>
                            Status
                          </th>
                          <th className={styles.th} style={{ width: 140, textAlign: "right" }}>
                            Cost
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {(shopifyCatalog?.products || [])
                          .filter((p) => {
                            const st = String((p as { status?: string }).status || "").trim().toLowerCase();
                            if (!shopifyProductStatus) return true;
                            return st === shopifyProductStatus;
                          })
                          .map((p) => {
                          const price = (p as { price?: string }).price || "";
                          const rawStatus = String((p as { status?: string }).status || "").trim().toLowerCase();
                          const statusState =
                            rawStatus === "active" ? ("active" as const) : rawStatus === "draft" ? ("draft" as const) : ("unlisted" as const);
                          const statusLabel =
                            statusState === "active" ? "Active" : statusState === "draft" ? "Draft" : "Unlisted";
                          return (
                            <tr key={String(p.id || p.handle)}>
                              <td className={styles.td}>
                                {p.image_url ? (
                                  // eslint-disable-next-line @next/next/no-img-element
                                  <img
                                    src={p.image_url}
                                    alt=""
                                    width={44}
                                    height={44}
                                    style={{
                                      width: 44,
                                      height: 44,
                                      borderRadius: 10,
                                      objectFit: "cover",
                                      border: "1px solid var(--button-secondary-border)",
                                      background: "rgba(255,255,255,0.03)",
                                      display: "block",
                                    }}
                                    loading="lazy"
                                  />
                                ) : (
                                  <div
                                    style={{
                                      width: 44,
                                      height: 44,
                                      borderRadius: 10,
                                      border: "1px solid var(--button-secondary-border)",
                                      background: "rgba(255,255,255,0.03)",
                                    }}
                                  />
                                )}
                              </td>
                              <td className={styles.td}>
                                <div style={{ fontWeight: 800 }}>{p.title || "—"}</div>
                                <div className={styles.muted} style={{ fontSize: 12, marginTop: 4 }}>
                                  {p.handle ? <span>/{p.handle}</span> : null}
                                </div>
                              </td>
                              <td className={styles.td}>
                                <span className={styles.shopifyProductStatusPill} data-state={statusState}>
                                  {statusLabel}
                                </span>
                              </td>
                              <td className={styles.td} style={{ textAlign: "right", fontWeight: 850 }}>
                                {price ? (
                                  <>
                                    {shopifyCatalog?.shop?.currency ? (
                                      <span className={styles.muted} style={{ marginRight: 6 }}>
                                        {shopifyCatalog.shop.currency}
                                      </span>
                                    ) : null}
                                    {price}
                                  </>
                                ) : (
                                  <span className={styles.muted}>—</span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            ) : null}
          </>
        ) : null}

        {tab === "articles" ? (
          <>
            {showBulkPopup ? (
              <>
                <div className={styles.bulkBackdrop} onClick={() => setShowBulkPopup(false)} />
                <div
                  className={`${styles.bulkPopup} ${bulkMode === "schedule" ? styles.bulkPopupScheduleLayout : ""} ${bulkMode === "root" || bulkMode === "change_status" ? styles.bulkPopupCompact : ""}`}
                  role="dialog"
                  aria-modal="true"
                  aria-label="Bulk actions"
                >
                  <div className={styles.bulkPopupHead}>
                    <div className={styles.bulkPopupTitle}>
                      <strong>
                        {bulkMode === "schedule"
                          ? "Schedule articles"
                          : bulkMode === "change_status"
                            ? "Change status"
                            : "Bulk actions"}
                      </strong>
                      {bulkMode === "schedule" ? (
                        <div className={styles.bulkScheduleMetaChips}>
                          <span className={styles.bulkScheduleMetaChip}>
                            <Icon.Document className={styles.icon16} />
                            {bulkScheduleSeedRows.length} article{bulkScheduleSeedRows.length === 1 ? "" : "s"}
                          </span>
                          {profileTz ? (
                            <span className={styles.bulkScheduleMetaChip}>
                              <Icon.Clock className={styles.icon16} />
                              {profileTz}
                            </span>
                          ) : null}
                        </div>
                      ) : bulkMode === "root" ? (
                        <span className={styles.bulkPopupSubtitle}>
                          {selectedIds.length} article{selectedIds.length === 1 ? "" : "s"} selected
                        </span>
                      ) : bulkMode === "change_status" ? (
                        <span className={styles.bulkPopupSubtitle}>
                          Apply to {selectedIds.length} article{selectedIds.length === 1 ? "" : "s"}
                        </span>
                      ) : null}
                    </div>
                    <button className={styles.iconButton} type="button" aria-label="Close bulk actions" onClick={() => setShowBulkPopup(false)}>
                      <Icon.X className={styles.icon20} />
                    </button>
                  </div>
                  {bulkMode === "root" ? (
                    <div className={styles.bulkActionList} role="menu">
                      <button
                        className={styles.bulkActionItem}
                        type="button"
                        role="menuitem"
                        onClick={bulkEdit}
                        disabled={selectedIds.length !== 1}
                        title={selectedIds.length !== 1 ? "Select exactly 1 article to edit" : "Edit selected article"}
                      >
                        <span className={styles.bulkActionIcon} aria-hidden="true">
                          <Icon.Edit className={styles.icon20} />
                        </span>
                        <span className={styles.bulkActionText}>
                          <span className={styles.bulkActionLabel}>Edit article</span>
                          <span className={styles.bulkActionHint}>Opens the editor for one article</span>
                        </span>
                      </button>
                      <button
                        className={styles.bulkActionItem}
                        type="button"
                        role="menuitem"
                        onClick={() => setBulkMode("change_status")}
                      >
                        <span className={styles.bulkActionIcon} aria-hidden="true">
                          <Icon.Status className={styles.icon20} />
                        </span>
                        <span className={styles.bulkActionText}>
                          <span className={styles.bulkActionLabel}>Change status</span>
                          <span className={styles.bulkActionHint}>Pending, draft, or published</span>
                        </span>
                        <Icon.ChevronRight className={styles.bulkActionChevron} />
                      </button>
                      <button className={styles.bulkActionItem} type="button" role="menuitem" onClick={bulkSchedule}>
                        <span className={styles.bulkActionIcon} aria-hidden="true">
                          <Icon.Calendar className={styles.icon20} />
                        </span>
                        <span className={styles.bulkActionText}>
                          <span className={styles.bulkActionLabel}>Schedule articles</span>
                          <span className={styles.bulkActionHint}>Set WordPress publish times</span>
                        </span>
                        <Icon.ChevronRight className={styles.bulkActionChevron} />
                      </button>
                      <button
                        className={`${styles.bulkActionItem} ${styles.bulkActionItemDanger}`}
                        type="button"
                        role="menuitem"
                        onClick={bulkDelete}
                      >
                        <span className={`${styles.bulkActionIcon} ${styles.bulkActionIconDanger}`} aria-hidden="true">
                          <Icon.Trash className={styles.icon20} />
                        </span>
                        <span className={styles.bulkActionText}>
                          <span className={styles.bulkActionLabel}>Delete articles</span>
                          <span className={styles.bulkActionHint}>Removes selected articles permanently</span>
                        </span>
                      </button>
                    </div>
                  ) : bulkMode === "change_status" ? (
                    <>
                      <button type="button" className={styles.bulkActionBack} onClick={() => setBulkMode("root")}>
                        <Icon.Back className={styles.icon20} />
                        Back to actions
                      </button>
                      <div className={styles.bulkActionList} role="menu">
                        <button
                          className={styles.bulkActionItem}
                          type="button"
                          role="menuitem"
                          onClick={() => bulkChangeStatus("pending")}
                        >
                          <span className={`${styles.bulkActionStatusDot} ${styles.bulkActionStatusDotPending}`} aria-hidden="true" />
                          <span className={styles.bulkActionText}>
                            <span className={styles.bulkActionLabel}>Pending</span>
                          </span>
                        </button>
                        <button
                          className={styles.bulkActionItem}
                          type="button"
                          role="menuitem"
                          onClick={() => bulkChangeStatus("draft")}
                        >
                          <span className={`${styles.bulkActionStatusDot} ${styles.bulkActionStatusDotDraft}`} aria-hidden="true" />
                          <span className={styles.bulkActionText}>
                            <span className={styles.bulkActionLabel}>Draft</span>
                          </span>
                        </button>
                        <button
                          className={styles.bulkActionItem}
                          type="button"
                          role="menuitem"
                          onClick={() => bulkChangeStatus("published")}
                        >
                          <span className={`${styles.bulkActionStatusDot} ${styles.bulkActionStatusDotPublished}`} aria-hidden="true" />
                          <span className={styles.bulkActionText}>
                            <span className={styles.bulkActionLabel}>Published</span>
                          </span>
                        </button>
                      </div>
                    </>
                  ) : (
                    <BulkScheduleForm
                      seedRows={bulkScheduleSeedRows}
                      active={showBulkPopup && bulkMode === "schedule"}
                      profileTz={profileTz}
                      defaults={wpDefaults}
                      wpTypesForSchedule={wpTypesForSchedule}
                      scheduleWritingPrompts={scheduleWritingPrompts}
                      scheduleImagePrompts={scheduleImagePrompts}
                      submitting={bulkScheduling}
                      error={error}
                      onCancel={() => setBulkMode("root")}
                      onValidationError={setError}
                      onSubmit={bulkScheduleSubmit}
                      cancelLabel="Back to actions"
                    />
                  )}
                </div>
              </>
            ) : null}

              <div className={`${styles.card} ${styles.cardWide} ${styles.hideOnMobile} ${styles.articlesToolbar}`}>
                {tab === "articles"
                  ? renderLimitStrip([
                      articleGenerationLimitStatus(),
                      monthlyLimitStatus("Article scheduling", featureLimits?.scheduled_articles),
                      monthlyLimitStatus("Article export", featureLimits?.export_articles),
                    ])
                  : null}

                <div className={styles.articlesToolbarMain}>
                  <div className={styles.articlesToolbarFilters} role="group" aria-label="Article filters">
                    <label className={styles.articlesFilterField}>
                      <span className={styles.articlesFilterLabel}>Status</span>
                      <select
                        className={styles.articlesFilterControl}
                        value={status}
                        onChange={(e) => {
                          const next = e.target.value as StatusFilter;
                          setStatus(next);
                          setPage(1);
                        }}
                      >
                        <option value="">All</option>
                        <option value="pending">Pending</option>
                        <option value="draft">Draft</option>
                        <option value="scheduled">Scheduled</option>
                        <option value="published">Published</option>
                      </select>
                    </label>
                    <label className={styles.articlesFilterField}>
                      <span className={styles.articlesFilterLabel}>From</span>
                      <input
                        className={styles.articlesFilterControl}
                        type="date"
                        value={dateFrom}
                        onChange={(e) => setDateFrom(e.target.value)}
                      />
                    </label>
                    <label className={styles.articlesFilterField}>
                      <span className={styles.articlesFilterLabel}>To</span>
                      <input
                        className={styles.articlesFilterControl}
                        type="date"
                        value={dateTo}
                        onChange={(e) => setDateTo(e.target.value)}
                      />
                    </label>
                    <label className={styles.articlesFilterField}>
                      <span className={styles.articlesFilterLabel}>Sort</span>
                      <select
                        className={styles.articlesFilterControl}
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
                      <button
                        className={styles.articlesToolbarClear}
                        type="button"
                        onClick={() => {
                          setQ("");
                          setStatus("");
                          setDateFrom("");
                          setDateTo("");
                        }}
                      >
                        Clear
                      </button>
                    ) : null}
                  </div>

                  <div className={styles.articlesToolbarDivider} aria-hidden="true" />

                  <div className={styles.articlesToolbarActions}>
                    {Object.keys(articleCategoryEdits).length > 0 ? (
                      <div className={styles.articlesCategorySaveWrap}>
                        <button
                          className={styles.button}
                          type="button"
                          disabled={categorySaveBusy}
                          onClick={saveArticleCategories}
                        >
                          {categorySaveBusy ? "Saving…" : `Save categories (${Object.keys(articleCategoryEdits).length})`}
                        </button>
                        {categorySaveError ? (
                          <span className={styles.articlesCategorySaveError}>{categorySaveError}</span>
                        ) : null}
                      </div>
                    ) : null}
                    <button
                      className={styles.articlesToolbarBtn}
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
                      className={styles.articlesToolbarBtn}
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
                  </div>

                  <div className={styles.articlesToolbarSelection}>
                    <span className={styles.articlesSelectedCount}>{selectedIds.length} selected</span>
                    <button
                      className={`${styles.articlesToolbarActionsBtn} ${selectedIds.length ? styles.articlesToolbarActionsBtnActive : ""}`}
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
              <div className={`${styles.card} ${styles.cardWide} ${styles.articleListCard}`} style={{ padding: 0 }}>
                <div className={`${styles.articlesTableScroll} ${styles.articlesDesktopOnly}`}>
                  <div className={styles.articlesTableHead} role="row">
                    <span className={styles.articlesTableCheckboxCol}>
                      <input
                        type="checkbox"
                        checked={allOnPageSelected}
                        onChange={toggleAllOnPage}
                        aria-label="Select all articles on this page"
                      />
                    </span>
                    <span>Title</span>
                    <span>Focus Keyphrase</span>
                    <span>Supporting Keywords</span>
                    <span>Category</span>
                    <span>Status</span>
                    <span>Actions</span>
                  </div>

                  {loading || articlesListLoading ? (
                    <ArticlesTableSkeleton variant="desktop" />
                  ) : null}
                  {!loading && !articlesListLoading && listTotal === 0 ? (
                    <div className={styles.articlesTableMessage}>No articles match the current filters.</div>
                  ) : null}

                  {!loading && !articlesListLoading
                    ? pageItems.map((a) => {
                        const title = a.title || "(Untitled)";
                        const focus = (a.focus_keyphrase || "").trim() || "—";
                        const keywordsText = formatSupportingKeywords(a.keywords);
                        const gscRequested = (a.gsc_status || "").toLowerCase() === "inspected";
                        const _rawStatus = (a.status || "pending").toLowerCase();
                        const statusLabel =
                          _rawStatus === "queued" ? "In Queue" :
                          _rawStatus === "generating" ? "Generating..." :
                          _rawStatus.toUpperCase();
                        const statusTitle = `${statusLabel} · ${gscRequested ? "Indexing requested" : "Indexing not requested"}`;
                        return (
                          <article key={a.id} className={styles.articleRow}>
                            <div className={styles.articlesTableRowMain}>
                              <span className={styles.articlesTableCheckboxCol}>
                                <input
                                  type="checkbox"
                                  checked={!!selected[a.id]}
                                  onChange={() => toggleOne(a.id)}
                                  aria-label={`Select ${title}`}
                                />
                              </span>
                              <div className={`${styles.articlesTableCell} ${styles.articlesTableCellTitle}`}>
                                <Link
                                  href={`/projects/${projectId}/articles/${a.id}`}
                                  className={`${styles.articleTitleLink} ${styles.articlesTableClamp}`}
                                  title={title}
                                >
                                  {title}
                                </Link>
                              </div>
                              <div
                                className={`${styles.articlesTableCell} ${styles.articlesTableCellMuted}`}
                                data-mobile-label="Focus keyphrase"
                                title={focus !== "—" ? focus : undefined}
                              >
                                <span
                                  className={`${styles.articlesTableClamp} ${focus === "—" ? styles.articlesTableCellEmpty : ""}`}
                                >
                                  {focus}
                                </span>
                              </div>
                              <div
                                className={`${styles.articlesTableCell} ${styles.articlesTableCellMuted}`}
                                data-mobile-label="Supporting keywords"
                                title={keywordsText !== "—" ? keywordsText : undefined}
                              >
                                <span
                                  className={`${styles.articlesTableClamp} ${keywordsText === "—" ? styles.articlesTableCellEmpty : ""}`}
                                >
                                  {keywordsText}
                                </span>
                              </div>
                              <div className={styles.articlesTableCategoryCol}>
                                {wpCatsForSchedule.length > 0 ? (() => {
                                  const savedCatId = (a.wp_category_ids || "").split(",")[0]?.trim() || (sWpDefaultCategoryIds[0] ? String(sWpDefaultCategoryIds[0]) : "");
                                  const currentVal = articleCategoryEdits[a.id] !== undefined ? articleCategoryEdits[a.id] : savedCatId;
                                  const isDirty = articleCategoryEdits[a.id] !== undefined;
                                  return (
                                    <CategorySelect
                                      value={currentVal}
                                      options={wpCatsForSchedule.map((c) => ({ value: String(c.id), label: c.name }))}
                                      onChange={(newVal) => {
                                        setArticleCategoryEdits((prev) => {
                                          if (newVal === savedCatId) {
                                            const { [a.id]: _removed, ...rest } = prev;
                                            return rest;
                                          }
                                          return { ...prev, [a.id]: newVal };
                                        });
                                      }}
                                      isDirty={isDirty}
                                      ariaLabel={`Category for ${title}`}
                                    />
                                  );
                                })() : wpCatsLoading ? (
                                  <span className={styles.articlesTableCellLoading}>Loading</span>
                                ) : (
                                  <span className={styles.articlesTableCellEmpty}>—</span>
                                )}
                              </div>
                              <div className={styles.articlesTableStatusCol} data-mobile-label="Status" title={statusTitle}>
                                <span className={statusPillClass(a.status)}>{statusLabel}</span>
                              </div>
                              <div className={styles.articlesTableActionsCol}>
                                {renderArticleActions(a, title, styles.articlesTableIconBtn)}
                              </div>
                            </div>
                          </article>
                        );
                      })
                    : null}
                </div>

                <div className={styles.articlesMobileOnly} aria-label="Articles list">
                  <div className={styles.articlesMobileToolbar}>
                    <label className={styles.articlesMobileSelectAll}>
                      <input
                        type="checkbox"
                        checked={allOnPageSelected}
                        onChange={toggleAllOnPage}
                        aria-label="Select all articles on this page"
                      />
                      <span>Select all on page</span>
                    </label>
                    {selectedIds.length ? (
                      <span className={styles.articlesMobileSelectedCount}>{selectedIds.length} selected</span>
                    ) : null}
                  </div>

                  {loading || articlesListLoading ? (
                    <ArticlesTableSkeleton variant="mobile" />
                  ) : null}
                  {!loading && !articlesListLoading && listTotal === 0 ? (
                    <p className={styles.articlesMobileMessage}>No articles match the current filters.</p>
                  ) : null}

                  {!loading && !articlesListLoading
                    ? pageItems.map((a) => {
                        const title = a.title || "(Untitled)";
                        const focus = (a.focus_keyphrase || "").trim() || "—";
                        const keywordsText = formatSupportingKeywords(a.keywords);
                        const gscRequested = (a.gsc_status || "").toLowerCase() === "inspected";
                        const _rawStatus = (a.status || "pending").toLowerCase();
                        const statusLabel =
                          _rawStatus === "queued" ? "In Queue" :
                          _rawStatus === "generating" ? "Generating..." :
                          _rawStatus.toUpperCase();
                        const statusTitle = `${statusLabel} · ${gscRequested ? "Indexing requested" : "Indexing not requested"}`;
                        return (
                          <article key={`mobile-${a.id}`} className={styles.articlesMobileCard}>
                            <div className={styles.articlesMobileCardTop}>
                              <label className={styles.articlesMobileCardCheck}>
                                <input
                                  type="checkbox"
                                  checked={!!selected[a.id]}
                                  onChange={() => toggleOne(a.id)}
                                  aria-label={`Select ${title}`}
                                />
                              </label>
                              <span className={statusPillClass(a.status)} title={statusTitle}>
                                {statusLabel}
                              </span>
                            </div>
                            <Link
                              href={`/projects/${projectId}/articles/${a.id}`}
                              className={styles.articlesMobileCardTitle}
                            >
                              {title}
                            </Link>
                            <dl className={styles.articlesMobileMeta}>
                              <div className={styles.articlesMobileMetaRow}>
                                <dt>Focus keyphrase</dt>
                                <dd className={focus === "—" ? styles.articlesMobileMetaEmpty : undefined}>{focus}</dd>
                              </div>
                              <div className={styles.articlesMobileMetaRow}>
                                <dt>Supporting keywords</dt>
                                <dd className={keywordsText === "—" ? styles.articlesMobileMetaEmpty : undefined}>
                                  {keywordsText}
                                </dd>
                              </div>
                              {wpCatsForSchedule.length > 0 ? (() => {
                                const savedCatId = (a.wp_category_ids || "").split(",")[0]?.trim() || (sWpDefaultCategoryIds[0] ? String(sWpDefaultCategoryIds[0]) : "");
                                const currentVal = articleCategoryEdits[a.id] !== undefined ? articleCategoryEdits[a.id] : savedCatId;
                                const isDirty = articleCategoryEdits[a.id] !== undefined;
                                return (
                                  <div className={styles.articlesMobileMetaRow}>
                                    <dt>Category</dt>
                                    <dd>
                                      <CategorySelect
                                        value={currentVal}
                                        options={wpCatsForSchedule.map((c) => ({ value: String(c.id), label: c.name }))}
                                        onChange={(newVal) => {
                                          setArticleCategoryEdits((prev) => {
                                            if (newVal === savedCatId) {
                                              const { [a.id]: _removed, ...rest } = prev;
                                              return rest;
                                            }
                                            return { ...prev, [a.id]: newVal };
                                          });
                                        }}
                                        isDirty={isDirty}
                                        ariaLabel={`Category for ${title}`}
                                      />
                                    </dd>
                                  </div>
                                );
                              })() : wpCatsLoading ? (
                                <div className={styles.articlesMobileMetaRow}>
                                  <dt>Category</dt>
                                  <dd className={styles.articlesTableCellLoading}>Loading</dd>
                                </div>
                              ) : null}
                            </dl>
                            <div className={styles.articlesMobileActions}>
                              {renderArticleActions(a, title, styles.articlesMobileIconBtn)}
                            </div>
                          </article>
                        );
                      })
                    : null}
                </div>
                {showWebsiteRequiredOverlay ? (
                  <div className={styles.articleConnectionOverlay} role="dialog" aria-modal="true" aria-label="Website connection required">
                    <div className={styles.articleConnectionPopup}>
                      <div className={styles.articleConnectionKicker}>Website not connected</div>
                      <h3>Connect your WordPress website to continue</h3>
                      <p>
                        Article operations are locked until this project has a verified website connection.
                        Connect the website to generate, schedule, publish, and manage articles safely.
                      </p>
                      <div className={styles.articleConnectionActions}>
                        <button
                          type="button"
                          className={styles.button}
                          onClick={() => router.push(`/projects/${projectId}?tab=project_settings`)}
                        >
                          Connect Website
                        </button>
                        <button
                          type="button"
                          className={styles.btnSecondary}
                          onClick={() => router.push("/dashboard")}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>

              <div className={styles.articlesPagination}>
                <button className={styles.button} type="button" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={pageClamped <= 1}>
                  Prev
                </button>
                <span className={styles.articlesPaginationMeta}>
                  Page {pageClamped} / {totalPages} · {listTotal} item(s)
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
                        Times are interpreted in your profile timezone ({profileTz || "browser default"}). Minimum 10 minutes from now (enforced on save) — the article needs ~6-8 minutes to fully prepare before posting.
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

            {showMobileFilters ? (
              <>
                <button
                  type="button"
                  className={styles.modalBackdrop}
                  aria-label="Close filters"
                  onClick={() => setShowMobileFilters(false)}
                />
                <div className={styles.modalPanel} role="dialog" aria-modal="true" aria-label="Filter articles">
                  <div className={styles.modalHead}>
                    <h3 className={styles.modalTitle}>Filter articles</h3>
                    <button
                      type="button"
                      className={styles.iconButton}
                      aria-label="Close"
                      onClick={() => setShowMobileFilters(false)}
                    >
                      <Icon.X className={styles.icon20} />
                    </button>
                  </div>
                  <div className={styles.modalBody}>
                    <label className={styles.label}>
                      Status
                      <select
                        className={styles.input}
                        value={status}
                        onChange={(e) => {
                          const next = e.target.value as StatusFilter;
                          setStatus(next);
                          setPage(1);
                        }}
                      >
                        <option value="">All</option>
                        <option value="pending">Pending</option>
                        <option value="draft">Draft</option>
                        <option value="scheduled">Scheduled</option>
                        <option value="published">Published</option>
                      </select>
                    </label>
                    <div className={styles.articlesMobileFilterDates}>
                      <label className={styles.label}>
                        From
                        <input
                          className={styles.input}
                          type="date"
                          value={dateFrom}
                          onChange={(e) => {
                            setDateFrom(e.target.value);
                            setPage(1);
                          }}
                        />
                      </label>
                      <label className={styles.label}>
                        To
                        <input
                          className={styles.input}
                          type="date"
                          value={dateTo}
                          onChange={(e) => {
                            setDateTo(e.target.value);
                            setPage(1);
                          }}
                        />
                      </label>
                    </div>
                    <label className={styles.label}>
                      Sort
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
                        setQ("");
                        setStatus("");
                        setDateFrom("");
                        setDateTo("");
                        setPage(1);
                      }}
                      disabled={!q.trim() && !status && !dateFrom && !dateTo}
                    >
                      Clear all
                    </button>
                    <button type="button" className={styles.button} onClick={() => setShowMobileFilters(false)}>
                      Done
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
          <div className={styles.researchPage}>
            <div
              className={styles.researchSubTabs}
              role="tablist"
              aria-label="Research sections"
            >
              <button
                type="button"
                role="tab"
                aria-selected={researchSubTab === "cluster"}
                className={`${styles.researchSubTab} ${researchSubTab === "cluster" ? styles.researchSubTabActive : ""}`}
                onClick={() => setResearchSubTab("cluster")}
              >
                Cluster Planner
                {topicClusters.length > 0 ? (
                  <span className={styles.researchSubTabBadge}>{topicClusters.length}</span>
                ) : null}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={researchSubTab === "curations"}
                className={`${styles.researchSubTab} ${researchSubTab === "curations" ? styles.researchSubTabActive : ""}`}
                onClick={() => setResearchSubTab("curations")}
              >
                Custom Curations
                {researchResults.length > 0 ? (
                  <span className={styles.researchSubTabBadge}>{researchResults.length}</span>
                ) : null}
              </button>
            </div>

            {researchSubTab === "cluster" ? (
              <div className={styles.researchPanelStack}>
            <section className={`${styles.researchSectionCard} ${styles.clusterPlanner}`}>
              <div className={styles.researchSectionHead}>
                <div className={styles.researchSectionHeadMain}>
                  <p className={styles.researchSectionKicker}>Topical authority</p>
                  <h2 className={styles.researchSectionTitle}>Cluster planner</h2>
                  <p className={styles.researchSectionDesc}>
                    Enter a seed intent to map a pillar article plus 4–6 supporting cluster topics from a
                    live SERP snapshot. Country, language, and tone follow your Custom Curations settings.
                  </p>
                </div>
                <div className={styles.researchSectionActions}>
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
              {renderLimitStrip([
                monthlyLimitStatus("Cluster Planner", featureLimits?.cluster_plans),
                articleGenerationLimitStatus(),
                monthlyLimitStatus("Article scheduling", featureLimits?.scheduled_articles),
              ])}

              {topicClusters.length === 0 && !topicClustersLoading ? (
                <div className={styles.clusterEmptyHint}>
                  No saved clusters yet. Plan one above — it will appear here with a pillar plus
                  supporting topics tree.
                </div>
              ) : null}
            </section>

            {topicClusters.length > 0 || topicClustersLoading ? (
            <section className={styles.researchSectionCard}>
              <div className={styles.researchSectionHead}>
                <div className={styles.researchSectionHeadMain}>
                  <p className={styles.researchSectionKicker}>Your plans</p>
                  <h2 className={styles.researchSectionTitle}>Saved clusters</h2>
                  <p className={styles.researchSectionDesc}>
                    Select topics, then generate, import, or schedule in bulk. Leave selection empty to
                    act on every pending topic.
                  </p>
                </div>
              </div>
              {topicClustersLoading ? (
                <TextLinesSkeleton lines={4} />
              ) : null}
              <div className={styles.researchClustersStack}>
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
                  !pillarDone &&
                  !!(cl.pillar?.title || "").trim() &&
                  !(pillarValidation?.status === "duplicate");
                const clusterActionable = clusterRows.filter((c) => {
                  if ((c.imported_article_id || "").trim()) return false;
                  if (!(c.title || "").trim()) return false;
                  const v = clusterValidation.results[`${cl.id}::${c.id}`];
                  return v?.status !== "duplicate";
                }).length;
                const actionablePending =
                  (pillarActionable ? 1 : 0) + clusterActionable;
                const clusterRowKey = cl.id || `cluster-${cl.seed_intent}`;
                const isClusterBusy = TOPIC_CLUSTER_BUSY_STATUSES.has(statusKey);
                return (
                  <div key={clusterRowKey} className={styles.clusterRow}>
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
                          const generateDisabled =
                            anyBusy || isClusterBusy || allDuplicates || noPending || noActionable;
                          return (
                            <>
                              <button
                                type="button"
                                className={styles.button}
                                disabled={generateDisabled}
                                onClick={() => void openGenerateForCluster(cl.id)}
                                title={
                                  isClusterBusy
                                    ? "Wait for cluster planning or generation to finish."
                                    : allDuplicates
                                    ? "Every remaining topic already exists on your site or in this project."
                                    : noPending
                                      ? "Every topic in this cluster is already generated."
                                      : `Generate ${target} — uses one credit per article.`
                                }
                              >
                                {generateBusy || isClusterBusy
                                  ? statusKey === "planning"
                                    ? "Planning…"
                                    : "Generating…"
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
                                onClick={() => void openScheduleForCluster(cl.id)}
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
                                  {cl.pillar?.title ||
                                    (statusKey === "planning" ? cl.seed_intent : "(no pillar title)")}
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
                        {clusterRows.map((c, topicIdx) => {
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
                            <li key={`${clusterRowKey}::${slotId || topicIdx}`} className={styles.clusterTopicItem}>
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
            </section>
            ) : null}
              </div>
            ) : null}

            {researchSubTab === "curations" ? (
              <div className={styles.researchPanelStack}>
            <section className={styles.researchSectionCard}>
              <div className={styles.researchSectionHead}>
                <div className={styles.researchSectionHeadMain}>
                  <p className={styles.researchSectionKicker}>Keyword research</p>
                  <h2 className={styles.researchSectionTitle}>Curation settings</h2>
                  <p className={styles.researchSectionDesc}>
                    Fine-tune brand context, intent, and seed keywords before you run research.
                  </p>
                </div>
                <div className={styles.researchSectionActions}>
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
              </div>

              <div className={styles.researchFieldsGrid}>
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

                <label className={`${styles.label} ${styles.researchFieldFull}`}>
                  Seed keywords / topics
                  <div className={styles.researchSeedRow}>
                    <input
                      className={styles.input}
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
                  <p className={styles.researchHelperText}>
                    Tip: Paste comma-separated or newline-separated lists. Up to 200 seeds are saved with this project.
                  </p>
                  {researchSeeds.length ? (
                    <div className={styles.researchSeedChips}>
                      {researchSeeds.map((s, idx) => (
                        <span key={`${s}-${idx}`} className={styles.researchSeedChip}>
                          {s}
                          <button
                            type="button"
                            className={styles.researchSeedChipRemove}
                            aria-label={`Remove ${s}`}
                            onClick={() => removeSeedAt(idx)}
                          >
                            ×
                          </button>
                        </span>
                      ))}
                      {researchSeeds.length > 1 ? (
                        <button
                          type="button"
                          className={styles.miniBtn}
                          onClick={() =>
                            askConfirm({
                              title: "Clear seed keywords?",
                              body: `This removes all ${researchSeeds.length} seed keyword${researchSeeds.length === 1 ? "" : "s"} from this project. You can add new ones at any time.`,
                              confirmLabel: "Clear keywords",
                              danger: true,
                              onConfirm: () => setResearchSeeds([]),
                            })
                          }
                        >
                          Clear all
                        </button>
                      ) : null}
                    </div>
                  ) : (
                    <p className={styles.researchHelperText}>No seed keywords yet. Add a few to start research.</p>
                  )}
                </label>
              </div>

              {researchMsg ? (
                <div className={styles.muted} style={{ marginTop: 10, whiteSpace: "pre-wrap" }}>
                  {researchMsg}
                </div>
              ) : null}
              {renderLimitStrip([monthlyLimitStatus("Custom Curations", featureLimits?.custom_research)])}

              {researchKeywordAnalysis ? (
                <div className={styles.researchKeywordBlock}>
                  <h3 className={styles.researchSectionTitle} style={{ fontSize: 15, marginBottom: 10 }}>Keyword analysis</h3>
                  <div className={styles.researchKeywordGrid}>
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
            </section>

            <section className={styles.researchSectionCard}>
              <div className={styles.researchSectionHead}>
                <div className={styles.researchSectionHeadMain}>
                  <p className={styles.researchSectionKicker}>Ideas</p>
                  <h2 className={styles.researchSectionTitle}>Research results</h2>
                  <p className={styles.researchSectionDesc}>
                    Browse, filter, and import ideas into your Articles list.
                  </p>
                </div>
                <div className={styles.researchSectionActions}>
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
                  <button
                    className={styles.button}
                    type="button"
                    disabled={!researchSelected.size || researchImporting}
                    onClick={() => void openCurationPromptModal("generate")}
                  >
                    Generate selected
                  </button>
                  <button
                    className={styles.btnSecondary}
                    type="button"
                    disabled={!researchSelected.size || researchImporting}
                    onClick={() => void openCurationPromptModal("schedule")}
                  >
                    Schedule selected
                  </button>
                </div>
              </div>

              {researchResults.length ? (
                <div className={styles.researchFilterBar}>
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
                        className={`${styles.researchFilterChip} ${active ? styles.researchFilterChipActive : ""}`}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                  <span className={styles.researchHelperText} style={{ marginLeft: "auto", marginTop: 0 }}>
                    Persisted locally for this project.
                  </span>
                  <button
                    type="button"
                    className={styles.miniBtn}
                    onClick={() => {
                      if (!researchResults.length) return;
                      askConfirm({
                        title: "Clear research results?",
                        body: `This removes all ${researchResults.length} saved idea${researchResults.length === 1 ? "" : "s"} for this project. Run research again at any time to regenerate ideas.`,
                        confirmLabel: "Clear results",
                        danger: true,
                        onConfirm: () => {
                          setResearchResults([]);
                          setResearchSelected(new Set());
                          setResearchLatestRunId(null);
                        },
                      });
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
                <div className={styles.researchResultsScroll}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th className={styles.th} style={{ width: 44 }}>
                        <input
                          type="checkbox"
                          aria-label="Select all importable research ideas"
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
                            <span className={`${styles.pill} ${styles.researchResultImportedPill}`}>
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
                </div>
              ) : null}
            </section>

            {researchImportDupModal ? (
              <>
                <button type="button" className={styles.modalBackdrop} aria-label="Close" onClick={() => setResearchImportDupModal(null)} />
                <div ref={researchDupModalTrapRef} className={styles.modalPanel} role="dialog" aria-modal="true" aria-label="Duplicate articles detected" style={{ maxWidth: 520 }}>
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
              </div>
            ) : null}
          </div>
        ) : null}

        {tab === "scheduled_articles" ? (
          <>
            <div className={`${styles.card} ${styles.cardWide} ${styles.articlesToolbar}`}>
              {renderLimitStrip([monthlyLimitStatus("Article scheduling", featureLimits?.scheduled_articles)])}
              {notice ? (
                <p className={styles.muted} style={{ margin: "8px 0 0", color: "var(--aa-success, #16a34a)" }}>
                  {notice}
                </p>
              ) : null}
              {error && tab === "scheduled_articles" && !editJob ? <p className={styles.error}>{error}</p> : null}

              <div className={styles.articlesToolbarMain}>
                <div className={styles.articlesToolbarFilters} role="group" aria-label="Scheduled article filters">
                  <label className={styles.articlesFilterField}>
                    <span className={styles.articlesFilterLabel}>Order</span>
                    <select
                      className={styles.articlesFilterControl}
                      value={scheduledOrder}
                      onChange={(e) => setScheduledOrder(e.target.value as "asc" | "desc")}
                    >
                      <option value="desc">Latest → Oldest</option>
                      <option value="asc">Oldest → Latest</option>
                    </select>
                  </label>
                  <label className={`${styles.articlesFilterField} ${styles.articlesFilterFieldWide}`}>
                    <span className={styles.articlesFilterLabel}>Search</span>
                    <input
                      className={styles.articlesFilterControl}
                      value={scheduledSearch}
                      onChange={(e) => setScheduledSearch(e.target.value)}
                      placeholder="Article title…"
                    />
                  </label>
                </div>

                <div className={styles.articlesToolbarDivider} aria-hidden="true" />

                <div className={styles.articlesToolbarActions}>
                  {scheduledJobs.some((j) => (j.state || "").toLowerCase() === "failed") ? (
                    <button
                      type="button"
                      className={`${styles.articlesToolbarBtn} ${styles.articlesToolbarBtnWarn}`}
                      disabled={retryAllFailedBusy || !!retryPrepBusyId}
                      onClick={() => void retryAllFailedScheduledPreparations()}
                      title="Re-run generation for every failed scheduled job"
                    >
                      {retryAllFailedBusy ? "Retrying all…" : "Retry all failed"}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className={styles.articlesToolbarIconBtn}
                    aria-label="Refresh scheduled articles"
                    disabled={scheduledLoading}
                    onClick={() => void reloadScheduledJobs()}
                  >
                    <Icon.Refresh className={styles.icon20} />
                  </button>
                </div>
              </div>

              {scheduledLoading ? <TextLinesSkeleton lines={3} /> : null}
              {error ? <p className={styles.error} style={{ margin: 0 }}>{error}</p> : null}
            </div>

            <div className={`${styles.card} ${styles.cardWide} ${styles.scheduledListCard}`}>
              {scheduledVisible.length === 0 && !scheduledLoading ? (
                <div className={styles.scheduledEmpty}>No scheduled articles yet.</div>
              ) : (
                <>
                  <div className={styles.scheduledListHeader} aria-hidden="true">
                    <span>Article</span>
                    <span>Publish at</span>
                    <span>Status</span>
                  </div>
                  {scheduledVisible.map((j) => {
                    const jobState = (j.state || "").toLowerCase();
                    const postNowAllowed = canPostNowScheduledJob(j);
                    const isFailed = jobState === "failed";
                    const when = formatScheduledRunAt(j.run_at);
                    const wpStatus = (j.wp_status || "draft").toLowerCase() === "publish" ? "Publish" : "Draft";
                    return (
                      <div key={j.id} className={styles.scheduledRow}>
                        <div className={styles.scheduledMain}>
                          <Link
                            href={`/projects/${projectId}/articles/${j.article_id}`}
                            className={styles.articleTitleLink}
                          >
                            {articleTitleFor(j.article_id)}
                          </Link>
                          <div className={styles.scheduledActions}>
                            {jobState === "posted" ? (
                              j.wp_link ? (
                                <a className={styles.miniBtn} href={j.wp_link} target="_blank" rel="noreferrer">
                                  View on Live
                                </a>
                              ) : null
                            ) : (
                              <>
                                <button
                                  type="button"
                                  className={styles.miniBtn}
                                  onClick={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    void openPostNowConfirm(j);
                                  }}
                                  disabled={
                                    postNowBusy ||
                                    jobState === "cancelled" ||
                                    isOrphanScheduledJob(j)
                                  }
                                  title={
                                    postNowAllowed
                                      ? "Publish to WordPress now"
                                      : jobState === "posting"
                                        ? "Publishing in progress — click for status"
                                        : "Not available after cancelled"
                                  }
                                >
                                  Post Now
                                </button>
                                {isFailed ? (
                                  <button
                                    type="button"
                                    className={styles.miniBtn}
                                    onClick={() => void retryScheduledPreparation(j.id)}
                                    disabled={retryPrepBusyId === j.id || isOrphanScheduledJob(j)}
                                    title="Re-run article and image generation for this scheduled post"
                                  >
                                    {retryPrepBusyId === j.id ? "Retrying…" : "Retry preparation"}
                                  </button>
                                ) : null}
                                <button
                                  type="button"
                                  className={styles.miniBtn}
                                  onClick={() => void openEditScheduledJob(j)}
                                  disabled={jobState === "cancelled"}
                                >
                                  Re-Schedule
                                </button>
                                <button
                                  type="button"
                                  className={`${styles.miniBtn} ${styles.miniDanger}`}
                                  onClick={() => setConfirmCancelJob(j)}
                                  disabled={jobState === "cancelled"}
                                >
                                  Cancel
                                </button>
                              </>
                            )}
                          </div>
                          {j.last_error ? <div className={styles.scheduledError}>{j.last_error}</div> : null}
                        </div>

                        <div className={styles.scheduledWhen}>
                          <time className={styles.scheduledWhenPrimary} dateTime={j.run_at || undefined}>
                            {when.date}
                          </time>
                          {when.time ? (
                            <span className={styles.scheduledWhenSecondary}>
                              {when.time}
                              {when.tz ? <span className={styles.scheduledWhenTz}> · {when.tz}</span> : null}
                            </span>
                          ) : null}
                          <div className={styles.scheduledWhenMeta}>
                            <span className={styles.scheduledChip}>{j.post_type || "posts"}</span>
                            <span className={styles.scheduledChip}>{wpStatus}</span>
                          </div>
                        </div>

                        <div className={styles.scheduledStatusCol}>
                          <span className={jobStateClass(j.state)}>{jobStateLabel(j.state)}</span>
                        </div>
                      </div>
                    );
                  })}
                </>
              )}
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
                      {(editJob.state || "").toLowerCase() === "failed" ? (
                        <div className={styles.muted} style={{ fontSize: 12, marginTop: 6 }}>
                          Failed posts are re-queued with a new time at least 10 minutes from now. Content and image generation will run again after you save.
                        </div>
                      ) : (
                        <div className={styles.muted} style={{ fontSize: 12, marginTop: 6 }}>
                          Minimum 10 minutes from now. The article needs a few minutes to prepare before posting.
                        </div>
                      )}
                    </label>
                    <label className={styles.label}>
                      WordPress post type
                      <select className={styles.input} value={editJobPostType} onChange={(e) => setEditJobPostType(e.target.value)}>
                        <option value="posts">Posts</option>
                        <option value="pages">Pages</option>
                        {editJobPostType &&
                        !["posts", "pages"].includes(editJobPostType) &&
                        !wpTypesForSchedule.some((t) => t.rest_base === editJobPostType) ? (
                          <option value={editJobPostType}>{editJobPostType}</option>
                        ) : null}
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
                      Writing prompt
                      <select
                        className={styles.input}
                        value={editJobWritingPromptId}
                        onChange={(e) => setEditJobWritingPromptId(e.target.value)}
                      >
                        <option value="">Project default</option>
                        {editJobWritingPromptId &&
                        !scheduleWritingPrompts?.items.some((p) => p.id === editJobWritingPromptId) ? (
                          <option value={editJobWritingPromptId}>{editJobWritingPromptId}</option>
                        ) : null}
                        {(scheduleWritingPrompts?.items || []).map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name || p.id}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className={styles.label}>
                      Generate image
                      <select
                        className={styles.input}
                        value={editJobGenerateImage ? "yes" : "no"}
                        onChange={(e) => setEditJobGenerateImage(e.target.value === "yes")}
                      >
                        <option value="yes">Yes</option>
                        <option value="no">No</option>
                      </select>
                    </label>
                    <label className={styles.label}>
                      Image prompt
                      <select
                        className={styles.input}
                        value={editJobImagePromptId}
                        onChange={(e) => setEditJobImagePromptId(e.target.value)}
                        disabled={!editJobGenerateImage}
                      >
                        <option value="">Project default</option>
                        {editJobImagePromptId &&
                        !scheduleImagePrompts?.items.some((p) => p.id === editJobImagePromptId) ? (
                          <option value={editJobImagePromptId}>{editJobImagePromptId}</option>
                        ) : null}
                        {(scheduleImagePrompts?.items || []).map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name || p.id}
                          </option>
                        ))}
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
                      disabled={editRescheduleBusy}
                      onClick={() => void saveRescheduleChanges()}
                    >
                      {editRescheduleBusy ? "Saving…" : "Save changes"}
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
                      This removes the article from Scheduled Articles and returns it to your Articles list as pending.
                    </p>
                    <div className={styles.muted} style={{ fontSize: 12 }}>
                      {articleTitleFor(confirmCancelJob.article_id)}
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
                          const cancelled = confirmCancelJob;
                          if (!isOrphanScheduledJob(cancelled)) {
                            await api.cancelScheduledJob(projectId, cancelled.id);
                          }
                          setScheduledJobs((prev) =>
                            prev.filter(
                              (j) =>
                                j.id !== cancelled.id && j.article_id !== cancelled.article_id,
                            ),
                          );
                          await refreshArticlesList();
                          setConfirmCancelJob(null);
                          setTab("articles");
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


        {tab === "prompts" ? (
          <>
          <div className={styles.promptsPage}>
            <div className={styles.settingsActionBar}>
              <p className={styles.settingsActionBarHint}>
                Set defaults for article and image generation. Individual articles can override either prompt.
              </p>
              <button
                className={styles.button}
                type="button"
                onClick={() => { setPromptsSaveSuccess(false); void savePrompts(); }}
                disabled={promptsSaving || promptsLoading}
              >
                {promptsSaving ? "Saving…" : "Save changes"}
              </button>
            </div>
            {promptsLoading ? <FormFieldsSkeleton fields={4} /> : null}
            {error ? <p className={styles.error}>{error}</p> : null}

            <div className={styles.promptsPageGrid}>
              <section className={styles.promptsPanel} aria-labelledby="prompts-writing-heading">
                <div className={styles.promptsPanelHead}>
                  <div className={styles.promptsPanelHeadMain}>
                    <p className={styles.promptsPanelKicker}>Articles</p>
                    <h2 className={styles.promptsPanelTitle} id="prompts-writing-heading">
                      Article writing prompts
                    </h2>
                    {(() => {
                      const cap = featureLimits?.writing_prompts;
                      if (!cap) return null;
                      const used = wpDrafts.length;
                      if (cap.unlimited || cap.limit == null) {
                        return (
                          <p className={styles.promptsPanelMeta}>
                            {used} prompt{used === 1 ? "" : "s"} · unlimited on your {featureLimits?.plan_key} plan
                          </p>
                        );
                      }
                      const limit = cap.limit;
                      return (
                        <p className={styles.promptsPanelMeta}>
                          {used} / {limit} used · {Math.max(0, limit - used)} left on your {featureLimits?.plan_key} plan
                        </p>
                      );
                    })()}
                  </div>
                  {(() => {
                    const cap = featureLimits?.writing_prompts;
                    const atLimit = !!(cap && !cap.unlimited && typeof cap.limit === "number" && wpDrafts.length >= cap.limit);
                    return (
                      <button
                        className={`${styles.btnSecondary} ${styles.promptsPanelAddBtn}`}
                        type="button"
                        onClick={() => startAddPrompt("writing")}
                        disabled={atLimit}
                        title={atLimit ? `Writing prompt limit reached for your ${featureLimits?.plan_key || "current"} plan.` : undefined}
                      >
                        + Add new
                      </button>
                    );
                  })()}
                </div>
                <p className={styles.promptsPanelDesc}>
                  Default is used when you generate or schedule unless you override on the article.
                </p>
                <div className={styles.promptsPromptList}>
                  {wpDrafts.length === 0 ? (
                    <div className={styles.promptsEmpty}>No writing prompts yet. Add one to get started.</div>
                  ) : null}
                  {wpDrafts.map((p) => (
                    <article
                      key={p.id}
                      className={styles.promptsPromptCard}
                      data-default={wpDefault === p.id ? "true" : "false"}
                    >
                      <div className={styles.promptsPromptCardTop}>
                        <h3 className={styles.promptsPromptName}>{p.name || "(Untitled prompt)"}</h3>
                        <div className={styles.promptsPromptActions}>
                          <button className={styles.miniBtn} type="button" onClick={() => openPromptModal("writing", p.id)}>
                            Edit
                          </button>
                          <button
                            className={`${styles.miniBtn} ${styles.miniDanger}`}
                            type="button"
                            onClick={() => markDeletePrompt("writing", p.id)}
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                      <label className={styles.promptsDefaultRow}>
                        <input
                          type="radio"
                          name="wp-default"
                          checked={wpDefault === p.id}
                          onChange={() => setWpDefault(p.id)}
                        />
                        Set as default
                      </label>
                      <p className={styles.promptsPromptPreview} title={p.text || ""}>
                        {(p.text || "").trim() || "No prompt text yet."}
                      </p>
                    </article>
                  ))}
                </div>
              </section>

              <section className={styles.promptsPanel} aria-labelledby="prompts-image-heading">
                <div className={styles.promptsPanelHead}>
                  <div className={styles.promptsPanelHeadMain}>
                    <p className={styles.promptsPanelKicker}>Images</p>
                    <h2 className={styles.promptsPanelTitle} id="prompts-image-heading">
                      Image prompts
                    </h2>
                    {(() => {
                      const cap = featureLimits?.image_prompts;
                      if (!cap) return null;
                      const used = ipDrafts.length;
                      if (cap.unlimited || cap.limit == null) {
                        return (
                          <p className={styles.promptsPanelMeta}>
                            {used} prompt{used === 1 ? "" : "s"} · unlimited on your {featureLimits?.plan_key} plan
                          </p>
                        );
                      }
                      const limit = cap.limit;
                      return (
                        <p className={styles.promptsPanelMeta}>
                          {used} / {limit} used · {Math.max(0, limit - used)} left on your {featureLimits?.plan_key} plan
                        </p>
                      );
                    })()}
                  </div>
                  {(() => {
                    const cap = featureLimits?.image_prompts;
                    const atLimit = !!(cap && !cap.unlimited && typeof cap.limit === "number" && ipDrafts.length >= cap.limit);
                    return (
                      <button
                        className={`${styles.btnSecondary} ${styles.promptsPanelAddBtn}`}
                        type="button"
                        onClick={() => startAddPrompt("image")}
                        disabled={atLimit}
                        title={atLimit ? `Image prompt limit reached for your ${featureLimits?.plan_key || "current"} plan.` : undefined}
                      >
                        + Add new
                      </button>
                    );
                  })()}
                </div>
                <p className={styles.promptsPanelDesc}>
                  Custom image prompts are allowed. Riviso appends article focus, brand identity, and niche context, then validates the prompt is image-only.
                </p>
                <div className={styles.promptsPromptList}>
                  {ipDrafts.length === 0 ? (
                    <div className={styles.promptsEmpty}>No image prompts yet. Add one to get started.</div>
                  ) : null}
                  {ipDrafts.map((p) => (
                    <article
                      key={p.id}
                      className={styles.promptsPromptCard}
                      data-default={ipDefault === p.id ? "true" : "false"}
                    >
                      <div className={styles.promptsPromptCardTop}>
                        <h3 className={styles.promptsPromptName}>{p.name || "(Untitled prompt)"}</h3>
                        <div className={styles.promptsPromptActions}>
                          <button className={styles.miniBtn} type="button" onClick={() => openPromptModal("image", p.id)}>
                            Edit
                          </button>
                          <button
                            className={`${styles.miniBtn} ${styles.miniDanger}`}
                            type="button"
                            onClick={() => markDeletePrompt("image", p.id)}
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                      <label className={styles.promptsDefaultRow}>
                        <input
                          type="radio"
                          name="ip-default"
                          checked={ipDefault === p.id}
                          onChange={() => setIpDefault(p.id)}
                        />
                        Set as default
                      </label>
                      <p className={styles.promptsPromptPreview} title={p.text || ""}>
                        {(p.text || "").trim() || "No prompt text yet."}
                      </p>
                    </article>
                  ))}
                </div>
              </section>
            </div>

            {/* Save success banner */}
            {promptsSaveSuccess && (
              <div style={{
                marginTop: 12, padding: "10px 14px", borderRadius: 8, fontSize: 13,
                background: "color-mix(in oklab, #22c55e 12%, transparent)",
                border: "1px solid color-mix(in oklab, #22c55e 40%, transparent)",
                color: "inherit", display: "flex", alignItems: "center", gap: 8,
              }}>
                <span style={{ color: "#22c55e", fontWeight: 700 }}>✓</span>
                Settings saved successfully.
              </div>
            )}

          </div>
            {showPromptModal ? (() => {
              const promptKindCap = showPromptModal.kind === "writing"
                ? featureLimits?.writing_prompts
                : featureLimits?.image_prompts;
              const promptCharLimit = promptKindCap && !promptKindCap.unlimited && typeof promptKindCap.char_limit === "number" && promptKindCap.char_limit > 0
                ? promptKindCap.char_limit
                : null;
              const draftLen = draftText.length;
              const overLimit = promptCharLimit !== null && draftLen > promptCharLimit;
              const nearLimit = promptCharLimit !== null && !overLimit && draftLen >= Math.max(1, promptCharLimit - Math.max(50, Math.round(promptCharLimit * 0.05)));
              const counterColor = overLimit ? "#ff6b6b" : nearLimit ? "#f59e0b" : undefined;
              const isWriting = showPromptModal.kind === "writing";
              const isGuided = isWriting && promptBuilderMode === "guided";
              return (
              <>
                <button type="button" className={styles.modalBackdrop} aria-label="Close" onClick={() => setShowPromptModal(null)} />
                <div
                  ref={promptModalTrapRef}
                  className={styles.modalPanel}
                  role="dialog"
                  aria-modal="true"
                  aria-label={isWriting ? "Article writing prompt" : "Image prompt"}
                  style={isGuided ? { width: "min(820px, calc(100% - 24px))" } : undefined}
                >
                  <div className={styles.modalHead}>
                    <h3 className={styles.modalTitle}>
                      {isWriting ? "Article writing prompt" : "Image prompt"}
                    </h3>
                    <button type="button" className={styles.btnSecondary} onClick={() => setShowPromptModal(null)}>
                      Close
                    </button>
                  </div>

                  {/* Mode tabs — writing prompts only */}
                  {isWriting ? (
                    <div className={styles.pbModeTabs} role="tablist" aria-label="Prompt creation mode" style={{ marginBottom: 14 }}>
                      <button
                        role="tab"
                        aria-selected={promptBuilderMode === "manual"}
                        className={`${styles.pbModeBtn}${promptBuilderMode === "manual" ? ` ${styles.pbModeBtnActive}` : ""}`}
                        type="button"
                        onClick={() => setPromptBuilderMode("manual")}
                      >
                        Write manually
                      </button>
                      <button
                        role="tab"
                        aria-selected={promptBuilderMode === "guided"}
                        className={`${styles.pbModeBtn}${promptBuilderMode === "guided" ? ` ${styles.pbModeBtnActive}` : ""}`}
                        type="button"
                        onClick={() => { resetBuilder(); setPromptBuilderMode("guided"); }}
                      >
                        Build with options
                      </button>
                    </div>
                  ) : null}

                  {/* GUIDED BUILDER BODY */}
                  {isGuided ? (
                    <div className={styles.modalBody}>
                      <label className={styles.label}>
                        Prompt name
                        <input className={styles.input} value={draftName} onChange={(e) => setDraftName(e.target.value)} maxLength={200} placeholder="e.g. SEO blog — conversational" />
                      </label>

                      <div className={styles.pbSections}>
                        {/* Section 1: Content */}
                        <div className={styles.pbSection}>
                          <p className={styles.pbSectionTitle}>Content</p>
                          <div className={styles.pbField}>
                            <span className={styles.pbFieldLabel}>Content type</span>
                            <select className={styles.pbSelect} value={pbContentType} onChange={(e) => setPbContentType(e.target.value)}>
                              {PB_CONTENT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                            </select>
                          </div>
                          <div className={styles.pbField}>
                            <span className={styles.pbFieldLabel}>Target audience <span style={{ fontWeight: 400, color: "var(--aa-muted)" }}>(optional)</span></span>
                            <input
                              className={styles.pbInput}
                              value={pbTargetAudience}
                              onChange={(e) => setPbTargetAudience(e.target.value)}
                              maxLength={300}
                              placeholder="e.g. Small business owners, first-time buyers"
                            />
                          </div>
                          <div className={styles.pbField}>
                            <span className={styles.pbFieldLabel}>Industry</span>
                            <select className={styles.pbSelect} value={pbIndustry} onChange={(e) => setPbIndustry(e.target.value)}>
                              {PB_INDUSTRIES.map((i) => <option key={i} value={i}>{i}</option>)}
                            </select>
                          </div>
                        </div>

                        {/* Section 2: Voice & Style */}
                        <div className={styles.pbSection}>
                          <p className={styles.pbSectionTitle}>Voice & Style</p>
                          <div className={styles.pbField}>
                            <span className={styles.pbFieldLabel}>Tone of voice</span>
                            <div className={styles.pbRadioRow} role="radiogroup" aria-label="Tone of voice">
                              {PB_TONES.map((t) => (
                                <label key={t} className={`${styles.pbRadioChip}${pbToneOfVoice === t ? ` ${styles.pbRadioChipSelected}` : ""}`}>
                                  <input type="radio" name="pb-tone" value={t} checked={pbToneOfVoice === t} onChange={() => setPbToneOfVoice(t)} />
                                  {t}
                                </label>
                              ))}
                            </div>
                          </div>
                          <div className={styles.pbField}>
                            <span className={styles.pbFieldLabel}>Writing style</span>
                            <div className={styles.pbRadioRow} role="radiogroup" aria-label="Writing style">
                              {PB_WRITING_STYLES.map((s) => (
                                <label key={s} className={`${styles.pbRadioChip}${pbWritingStyle === s ? ` ${styles.pbRadioChipSelected}` : ""}`}>
                                  <input type="radio" name="pb-style" value={s} checked={pbWritingStyle === s} onChange={() => setPbWritingStyle(s)} />
                                  {s}
                                </label>
                              ))}
                            </div>
                          </div>
                          <div className={styles.pbField}>
                            <span className={styles.pbFieldLabel}>Brand personality <span style={{ fontWeight: 400, color: "var(--aa-muted)" }}>(pick any)</span></span>
                            <div className={styles.pbCheckGrid}>
                              {PB_BRAND_TRAITS.map((t) => (
                                <label key={t} className={styles.pbCheckItem}>
                                  <input
                                    type="checkbox"
                                    checked={pbBrandPersonality.includes(t)}
                                    onChange={(e) => setPbBrandPersonality((prev) => e.target.checked ? [...prev, t] : prev.filter((x) => x !== t))}
                                  />
                                  {t}
                                </label>
                              ))}
                            </div>
                          </div>
                        </div>

                        {/* Section 3: Depth & Length */}
                        <div className={styles.pbSection}>
                          <p className={styles.pbSectionTitle}>Depth & Length</p>
                          <div className={styles.pbField}>
                            <span className={styles.pbFieldLabel}>Content depth</span>
                            <div className={styles.pbRadioRow} role="radiogroup" aria-label="Content depth">
                              {PB_CONTENT_DEPTHS.map((d) => (
                                <label key={d} className={`${styles.pbRadioChip}${pbContentDepth === d ? ` ${styles.pbRadioChipSelected}` : ""}`}>
                                  <input type="radio" name="pb-depth" value={d} checked={pbContentDepth === d} onChange={() => setPbContentDepth(d)} />
                                  {d}
                                </label>
                              ))}
                            </div>
                          </div>
                          <div className={styles.pbField}>
                            <span className={styles.pbFieldLabel}>Article length</span>
                            <div className={styles.pbRadioRow} role="radiogroup" aria-label="Article length">
                              {PB_ARTICLE_LENGTHS.map((l) => (
                                <label key={l} className={`${styles.pbRadioChip}${pbArticleLength === l ? ` ${styles.pbRadioChipSelected}` : ""}`}>
                                  <input type="radio" name="pb-length" value={l} checked={pbArticleLength === l} onChange={() => setPbArticleLength(l)} />
                                  {l}
                                </label>
                              ))}
                            </div>
                          </div>
                        </div>

                        {/* Section 4: EEAT & SEO */}
                        <div className={styles.pbSection}>
                          <p className={styles.pbSectionTitle}>Trust & SEO</p>
                          <div className={styles.pbField}>
                            <span className={styles.pbFieldLabel}>EEAT additions <span style={{ fontWeight: 400, color: "var(--aa-muted)" }}>(pick any)</span></span>
                            <div className={styles.pbCheckGrid}>
                              {PB_EEAT_OPTIONS.map((o) => (
                                <label key={o} className={styles.pbCheckItem}>
                                  <input
                                    type="checkbox"
                                    checked={pbEeatSettings.includes(o)}
                                    onChange={(e) => setPbEeatSettings((prev) => e.target.checked ? [...prev, o] : prev.filter((x) => x !== o))}
                                  />
                                  {o}
                                </label>
                              ))}
                            </div>
                          </div>
                          <div className={styles.pbField}>
                            <span className={styles.pbFieldLabel}>SEO options <span style={{ fontWeight: 400, color: "var(--aa-muted)" }}>(pick any)</span></span>
                            <div className={styles.pbCheckGrid}>
                              {PB_SEO_OPTIONS.map((o) => (
                                <label key={o} className={styles.pbCheckItem}>
                                  <input
                                    type="checkbox"
                                    checked={pbSeoSettings.includes(o)}
                                    onChange={(e) => setPbSeoSettings((prev) => e.target.checked ? [...prev, o] : prev.filter((x) => x !== o))}
                                  />
                                  {o}
                                </label>
                              ))}
                            </div>
                          </div>
                        </div>

                        {/* Section 5: Guardrails & Data */}
                        <div className={styles.pbSection}>
                          <p className={styles.pbSectionTitle}>Guardrails & Data</p>
                          <div className={styles.pbField}>
                            <span className={styles.pbFieldLabel}>Content restrictions <span style={{ fontWeight: 400, color: "var(--aa-muted)" }}>(pick any)</span></span>
                            <div className={styles.pbCheckGrid}>
                              {PB_RESTRICTIONS.map((r) => (
                                <label key={r} className={styles.pbCheckItem}>
                                  <input
                                    type="checkbox"
                                    checked={pbContentRestrictions.includes(r)}
                                    onChange={(e) => setPbContentRestrictions((prev) => e.target.checked ? [...prev, r] : prev.filter((x) => x !== r))}
                                  />
                                  {r}
                                </label>
                              ))}
                            </div>
                          </div>
                          <label className={styles.pbToggleRow}>
                            <input
                              type="checkbox"
                              checked={pbUseWebsiteData}
                              onChange={(e) => setPbUseWebsiteData(e.target.checked)}
                              style={{ accentColor: "var(--aa-primary)", flexShrink: 0 }}
                            />
                            <span className={styles.pbToggleLabel}>
                              Use project brand &amp; site context
                              <span className={styles.pbToggleSub}>Folds in brand identity, site description, and product context when generating</span>
                            </span>
                          </label>
                          <div className={styles.pbField}>
                            <span className={styles.pbFieldLabel}>Additional instructions <span style={{ fontWeight: 400, color: "var(--aa-muted)" }}>(optional — highest priority)</span></span>
                            <textarea
                              className={styles.pbTextarea}
                              value={pbAdditionalInstructions}
                              onChange={(e) => setPbAdditionalInstructions(e.target.value)}
                              maxLength={20000}
                              rows={3}
                              placeholder="Anything specific — these instructions take priority over everything above"
                            />
                          </div>
                        </div>
                      </div>

                      {builderError ? (
                        <div role="alert" style={{ fontSize: 12.5, color: "var(--aa-error)", marginTop: 4 }}>{builderError}</div>
                      ) : null}

                      <div className={styles.modalFooter} style={{ paddingTop: 12 }}>
                        <button type="button" className={styles.btnSecondary} onClick={() => setShowPromptModal(null)}>
                          Cancel
                        </button>
                        <button
                          className={styles.button}
                          type="button"
                          onClick={() => void buildPromptText()}
                          disabled={!draftName.trim() || builderBuilding}
                        >
                          {builderBuilding ? "Building…" : "Build prompt text →"}
                        </button>
                      </div>
                    </div>
                  ) : (
                    /* MANUAL BODY */
                    <div className={styles.modalBody}>
                      <label className={styles.label}>
                        Prompt name
                        <input className={styles.input} value={draftName} onChange={(e) => setDraftName(e.target.value)} maxLength={200} />
                      </label>
                      <label className={styles.label}>
                        {isWriting && draftText && promptBuilderMode === "manual" && draftText.includes("WRITING GUIDELINES") ? (
                          <span>
                            Prompt text
                            <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 600, color: "var(--aa-primary)", background: "color-mix(in oklab, var(--aa-primary), transparent 88%)", border: "1px solid color-mix(in oklab, var(--aa-primary), transparent 60%)", borderRadius: 4, padding: "1px 6px" }}>
                              Built from options
                            </span>
                          </span>
                        ) : "Prompt text"}
                        <textarea
                          className={styles.textarea}
                          style={{ minHeight: 240, borderColor: overLimit ? "#ff6b6b" : undefined }}
                          value={draftText}
                          maxLength={promptCharLimit ?? undefined}
                          onChange={(e) => {
                            const next = e.target.value;
                            if (promptCharLimit !== null && next.length > promptCharLimit) {
                              setDraftText(next.slice(0, promptCharLimit));
                            } else {
                              setDraftText(next);
                            }
                          }}
                        />
                      </label>
                      <div
                        style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 11.5, color: counterColor, marginTop: -4 }}
                        className={counterColor ? undefined : styles.muted}
                      >
                        <span>
                          {promptCharLimit !== null
                            ? `${draftLen.toLocaleString()} / ${promptCharLimit.toLocaleString()} characters`
                            : `${draftLen.toLocaleString()} characters`}
                        </span>
                        {promptCharLimit !== null ? (
                          <span>{overLimit ? "Exceeds plan limit" : `${Math.max(0, promptCharLimit - draftLen).toLocaleString()} left`}</span>
                        ) : null}
                      </div>
                      {promptCharLimit !== null ? (
                        <div className={styles.muted} style={{ fontSize: 11, lineHeight: 1.45 }}>
                          Your {featureLimits?.plan_key || "current"} plan allows up to {promptCharLimit.toLocaleString()} characters per {isWriting ? "writing" : "image"} prompt.
                        </div>
                      ) : null}
                      {!isWriting ? (
                        <div className={styles.muted} style={{ fontSize: 12, lineHeight: 1.5 }}>
                          Describe the visual style, composition, lighting, camera, or scene for the
                          featured image only. Brand identity and niche context are appended automatically
                          when the image prompt is processed.
                        </div>
                      ) : null}
                      <label className={styles.checkboxRow}>
                        <input type="checkbox" checked={draftSetDefault} onChange={(e) => setDraftSetDefault(e.target.checked)} />
                        Set as default for this project
                      </label>
                      <div className={styles.modalFooter} style={{ padding: 0, marginTop: 4 }}>
                        <button type="button" className={styles.btnSecondary} onClick={() => setShowPromptModal(null)}>
                          Cancel
                        </button>
                        <button
                          className={styles.button}
                          type="button"
                          onClick={() => {
                            const { kind, id } = showPromptModal;
                            const text = promptCharLimit !== null ? draftText.slice(0, promptCharLimit) : draftText;
                            if (kind === "writing") {
                              setWpDrafts((prev) => prev.map((x) => (x.id === id ? { ...x, name: draftName, text } : x)));
                              if (draftSetDefault) setWpDefault(id);
                            } else {
                              setIpDrafts((prev) => prev.map((x) => (x.id === id ? { ...x, name: draftName, text } : x)));
                              if (draftSetDefault) setIpDefault(id);
                            }
                            setShowPromptModal(null);
                          }}
                          disabled={!draftName.trim() || !draftText.trim() || overLimit}
                          title={overLimit ? `Prompt exceeds the ${promptCharLimit?.toLocaleString()} character limit for your plan.` : undefined}
                        >
                          Save prompt
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </>
              );
            })() : null}

            {/* Delete prompt confirmation modal */}
            {deletePromptTarget ? (
              <>
                <button type="button" className={styles.modalBackdrop} aria-label="Cancel" onClick={() => setDeletePromptTarget(null)} />
                <div
                  ref={deletePromptTrapRef}
                  className={styles.modalPanel}
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="delete-prompt-heading"
                  aria-describedby="delete-prompt-desc"
                  style={{ maxWidth: 420 }}
                >
                  <div className={styles.modalHead}>
                    <h3 className={styles.modalTitle} id="delete-prompt-heading">Delete prompt?</h3>
                  </div>
                  <div className={styles.modalBody}>
                    <p id="delete-prompt-desc" style={{ margin: 0, fontSize: 14, lineHeight: 1.55 }}>
                      This will remove the prompt from the list. The change applies when you click <strong>Save changes</strong>.
                    </p>
                  </div>
                  <div className={styles.modalFooter}>
                    <button type="button" className={styles.btnSecondary} onClick={() => setDeletePromptTarget(null)}>
                      Cancel
                    </button>
                    <button type="button" className={`${styles.button} ${styles.btnDanger}`} onClick={confirmDeletePrompt}>
                      Delete prompt
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
              {linksLoading ? <InlineListSkeleton rows={5} /> : null}
              {renderLimitStrip([contextLinksLimitStatus()])}
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
                                <button
                                  className={styles.miniBtn}
                                  type="button"
                                  onClick={() => openLinkModal(x.id)}
                                  aria-label={`Edit context link “${x.label || x.url}”`}
                                >
                                  Edit
                                </button>
                                <button
                                  className={`${styles.miniBtn} ${styles.miniDanger}`}
                                  type="button"
                                  onClick={() => markDeleteLink(x.id)}
                                  aria-label={`Delete context link “${x.label || x.url}”`}
                                >
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

            {showLinkModal ? (() => {
              const isNewLink = showLinkModal.isNew;
              const parsedPhrases = isNewLink
                ? linkPhrase.split(",").map((p) => p.trim()).filter(Boolean)
                : [linkPhrase.trim()].filter(Boolean);
              const phraseCount = parsedPhrases.length;
              const hasConflicts = linkDuplicateConflicts.length > 0;
              const conflictPhraseSet = new Set(linkDuplicateConflicts.map((c) => c.phrase.toLowerCase()));
              const phraseBlank = !linkPhrase.trim();
              const urlBlank = !linkUrl.trim();
              const noValidPhrases = isNewLink && linkPhrase.trim() && phraseCount === 0;
              const canSave = !phraseBlank && !urlBlank && !hasConflicts && !noValidPhrases;
              return (
                <>
                  <button
                    type="button"
                    className={styles.modalBackdrop}
                    aria-label="Close"
                    onClick={() => { setShowLinkModal(null); setLinkDuplicateConflicts([]); setLinkSaveAttempted(false); }}
                  />
                  <div ref={linkModalTrapRef} className={styles.modalPanel} role="dialog" aria-modal="true" aria-label="Context link">
                    <div className={styles.modalHead}>
                      <h3 className={styles.modalTitle}>{isNewLink ? "Add context link(s)" : "Edit context link"}</h3>
                      <button type="button" className={styles.btnSecondary} onClick={() => { setShowLinkModal(null); setLinkDuplicateConflicts([]); setLinkSaveAttempted(false); }}>
                        Close
                      </button>
                    </div>
                    <div className={styles.modalBody}>
                      <label className={styles.label}>
                        {isNewLink ? "Exact phrase(s)" : "Exact phrase"}
                        <input
                          className={styles.input}
                          value={linkPhrase}
                          onChange={(e) => {
                            const val = e.target.value;
                            setLinkPhrase(val);
                            setLinkDuplicateConflicts(checkPhrasesForDuplicates(val, showLinkModal.id));
                          }}
                          placeholder={
                            isNewLink
                              ? "e.g. Best Lawyers in Delhi, Top Court Lawyers, Legal Experts"
                              : "e.g. Supreme Court Lawyers in Chandigarh"
                          }
                          aria-describedby={
                            isNewLink
                              ? "link-multi-hint link-duplicate-errors"
                              : hasConflicts
                              ? "link-duplicate-errors"
                              : undefined
                          }
                          aria-invalid={hasConflicts}
                        />
                      </label>

                      {linkSaveAttempted && phraseBlank ? (
                        <p role="alert" className={styles.error} style={{ fontSize: 13, marginTop: -4 }}>
                          Phrase cannot be blank.
                        </p>
                      ) : isNewLink ? (
                        <p id="link-multi-hint" className={styles.muted} style={{ fontSize: 12, marginTop: -4 }}>
                          Separate multiple phrases with commas — each becomes its own link entry sharing the same URL.
                        </p>
                      ) : null}

                      {isNewLink && parsedPhrases.length > 0 ? (
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6, marginBottom: 2 }}>
                          {parsedPhrases.map((p) => {
                            const isDupe = conflictPhraseSet.has(p.toLowerCase());
                            return (
                              <span
                                key={p}
                                style={{
                                  display: "inline-flex",
                                  alignItems: "center",
                                  padding: "2px 10px",
                                  borderRadius: 99,
                                  fontSize: 12,
                                  fontWeight: 500,
                                  background: isDupe
                                    ? "color-mix(in srgb, var(--aa-danger, #dc2626) 12%, transparent)"
                                    : "color-mix(in srgb, var(--aa-accent, #6366f1) 12%, transparent)",
                                  color: isDupe ? "var(--aa-danger, #dc2626)" : "var(--aa-accent, #6366f1)",
                                  border: `1px solid ${isDupe ? "color-mix(in srgb, var(--aa-danger, #dc2626) 30%, transparent)" : "color-mix(in srgb, var(--aa-accent, #6366f1) 30%, transparent)"}`,
                                }}
                              >
                                {isDupe ? "⚠ " : null}{p}
                              </span>
                            );
                          })}
                        </div>
                      ) : null}

                      {hasConflicts ? (
                        <div
                          id="link-duplicate-errors"
                          role="alert"
                          className={styles.error}
                          style={{ marginTop: 6, marginBottom: 4, fontSize: 13 }}
                        >
                          {linkDuplicateConflicts.map(({ phrase, conflict }) => (
                            <div key={phrase} style={{ marginBottom: 4 }}>
                              Duplicate: <strong>&ldquo;{phrase}&rdquo;</strong> already exists
                              {conflict.id !== "__batch__" ? (
                                <> — linked to <span style={{ wordBreak: "break-all" }}>{conflict.url}</span></>
                              ) : (
                                <> — entered twice in this batch</>
                              )}
                            </div>
                          ))}
                          <div className={styles.muted} style={{ marginTop: 2 }}>
                            Each phrase must be unique. The same URL can appear on multiple phrases.
                          </div>
                        </div>
                      ) : null}

                      <label className={styles.label} style={{ marginTop: 8 }}>
                        Link URL
                        <input
                          className={styles.input}
                          value={linkUrl}
                          onChange={(e) => setLinkUrl(e.target.value)}
                          placeholder="https://example.com/page"
                          aria-invalid={linkSaveAttempted && urlBlank}
                        />
                      </label>
                      {linkSaveAttempted && urlBlank ? (
                        <p role="alert" className={styles.error} style={{ fontSize: 13, marginTop: -4 }}>
                          URL cannot be blank.
                        </p>
                      ) : null}
                      {isNewLink && phraseCount > 1 ? (
                        <p className={styles.muted} style={{ fontSize: 12 }}>
                          {phraseCount} link entries will be created, each with this URL. You can edit them individually afterwards.
                        </p>
                      ) : (
                        <p className={styles.muted} style={{ fontSize: 12 }}>
                          Matching is case-insensitive. We&apos;ll link the visible phrase text as it appears in the article.
                        </p>
                      )}
                    </div>
                    <div className={styles.modalFooter}>
                      <button
                        type="button"
                        className={styles.btnSecondary}
                        onClick={() => { setShowLinkModal(null); setLinkDuplicateConflicts([]); setLinkSaveAttempted(false); }}
                      >
                        Cancel
                      </button>
                      <button
                        className={styles.button}
                        type="button"
                        onClick={() => {
                          setLinkSaveAttempted(true);
                          if (!canSave) return;
                          const id = showLinkModal.id;
                          const freshConflicts = checkPhrasesForDuplicates(linkPhrase, id);
                          if (freshConflicts.length > 0) {
                            setLinkDuplicateConflicts(freshConflicts);
                            return;
                          }
                          const url = linkUrl.trim();
                          if (isNewLink) {
                            const phrases = linkPhrase.split(",").map((p) => p.trim()).filter(Boolean);
                            const newDrafts: LinkDraft[] = phrases.map((phrase) => ({
                              id: `new_link_${Date.now()}_${Math.random().toString(36).slice(2)}`,
                              label: phrase,
                              url,
                              isNew: true,
                            }));
                            setLinkDrafts((prev) => [...newDrafts, ...prev.filter((d) => d.id !== id)]);
                          } else {
                            setLinkDrafts((prev) => prev.map((d) => (d.id === id ? { ...d, label: linkPhrase.trim(), url } : d)));
                          }
                          setLinkDuplicateConflicts([]);
                          setLinkSaveAttempted(false);
                          setShowLinkModal(null);
                        }}
                      >
                        {isNewLink
                          ? phraseCount > 1
                            ? `Add ${phraseCount} links`
                            : "Add link"
                          : "Save link"}
                      </button>
                    </div>
                  </div>
                </>
              );
            })() : null}
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
                <div className={styles.muted} style={{ marginTop: 10, fontWeight: 700, color: "var(--aa-success, #16a34a)" }}>
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
                    <code> URL · title · focus keyphrase · featured image</code>. When{" "}
                    <strong>Internal-link aware articles</strong> is on, generation can weave these URLs into new drafts
                    and use a page featured image as a hero-image style reference.
                  </div>
                  {!isShopifyProject ? (
                    <label
                      className={styles.label}
                      style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12, marginBottom: 0 }}
                    >
                      <input
                        type="checkbox"
                        checked={sWpInternalLinkAware}
                        onChange={(e) => setSWpInternalLinkAware(e.target.checked)}
                      />
                      <span style={{ fontSize: 13 }}>Internal-link aware articles</span>
                    </label>
                  ) : null}
                  {siteMapMsg ? (
                    <div className={styles.muted} style={{ fontSize: 13, marginTop: 8 }}>{siteMapMsg}</div>
                  ) : null}
                  <div className={styles.muted} style={{ fontSize: 13, marginTop: 10 }}>
                    {siteMap
                      ? `Stored: ${siteMap.count} post${siteMap.count === 1 ? "" : "s"}` + (siteMap.wp_site_url ? ` from ${siteMap.wp_site_url}` : "")
                      : "Site map not synced yet."}
                  </div>
                </div>

              </>
            ) : (
              <div className={`${styles.card} ${styles.cardWide}`} style={{ marginTop: 14 }}>
                <p className={styles.clusterCardSubtitle} style={{ margin: 0, lineHeight: 1.55 }}>
                  <strong>Internal site-map sync</strong> appears here after you connect Google above, pick a Search Console property, and click <strong>Save</strong> so this project is
                  fully linked to a verified property.
                </p>
              </div>
            )}

            {gscConfirmDisconnect ? (
              <>
                <button
                  type="button"
                  className={styles.modalBackdrop}
                  aria-label="Close"
                  onClick={() => setGscConfirmDisconnect(false)}
                />
                <div ref={gscDisconnectModalTrapRef} className={styles.modalPanel} role="dialog" aria-modal="true" aria-label="Disconnect Search Console">
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
                      className={styles.btnDanger}
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
          <div className={styles.analyticsStack}>
            {/* ── Header bar: title + connection state + sub-tab + refresh ── */}
            <div className={`${styles.card} ${styles.cardWide}`}>
              <div className={styles.analyticsHeaderRow}>
                <div className={styles.analyticsHeaderTitle}>
                  <h2 className={styles.sectionTitle}>Performance & Analysis</h2>
                  {analytics?.property_url || gscStatus?.property_url ? (
                    <div className={styles.analyticsPropertyTag}>
                      <span className={styles.analyticsPropertyDot} aria-hidden="true" />
                      <span>
                        Connected to{" "}
                        <code className={styles.analyticsPropertyCode}>
                          {(analytics?.property_url || gscStatus?.property_url || "").toString()}
                        </code>
                      </span>
                    </div>
                  ) : (
                    <p className={styles.muted} style={{ margin: 0, fontSize: 13 }}>
                      No Search Console property linked yet.
                    </p>
                  )}
                </div>
                <div className={styles.analyticsHeaderActions}>
                  <div className={styles.segmentGroup} aria-label="Performance view">
                    {(["overview", "insights"] as const).map((st) => (
                      <button key={st} type="button" className={styles.miniBtn}
                        onClick={() => setPerformanceSubTab(st)} aria-pressed={performanceSubTab === st}>
                        {st === "overview" ? "Overview" : "Insights"}
                      </button>
                    ))}
                  </div>
                  {performanceSubTab === "overview" ? (
                    <button type="button" className={styles.miniBtn} onClick={() => reloadAnalytics()} disabled={analyticsBusy}>
                      {analyticsBusy ? "Refreshing…" : "Refresh"}
                    </button>
                  ) : (
                    <button type="button" className={styles.miniBtn} onClick={() => { setInsights(null); void reloadInsights(); }} disabled={insightsBusy}>
                      {insightsBusy ? "Refreshing…" : "Refresh"}
                    </button>
                  )}
                </div>
              </div>

              {/* ── OVERVIEW ── */}
              {performanceSubTab === "overview" ? (
                <>
                  {/* Date range segmented control */}
                  <div className={styles.analyticsRangeBar}>
                    <div className={styles.segmentGroup} aria-label="Date range">
                      {([
                        { d: 7, label: "7d" },
                        { d: 28, label: "28d" },
                        { d: 90, label: "90d" },
                        { d: 180, label: "6m" },
                        { d: 365, label: "12m" },
                      ] as const).map(({ d, label }) => (
                        <button key={d} type="button" className={styles.miniBtn}
                          onClick={() => setAnalyticsRangePreset(d)}
                          disabled={analyticsBusy} aria-pressed={analyticsRangePreset === d}>
                          {label}
                        </button>
                      ))}
                      <button type="button" className={styles.miniBtn}
                        onClick={() => setAnalyticsRangePreset("custom")}
                        disabled={analyticsBusy} aria-pressed={analyticsRangePreset === "custom"}>
                        Custom…
                      </button>
                    </div>
                    {analyticsRangePreset === "custom" ? (
                      <div className={styles.analyticsCustomRange}>
                        <span className={styles.muted} style={{ fontSize: 12 }}>From</span>
                        <input type="date" className={styles.input} value={analyticsCustomStart}
                          onChange={(e) => setAnalyticsCustomStart(e.target.value)}
                          max={analyticsCustomEnd || undefined} style={{ height: 34, maxWidth: 160 }} />
                        <span className={styles.muted} style={{ fontSize: 12 }}>to</span>
                        <input type="date" className={styles.input} value={analyticsCustomEnd}
                          onChange={(e) => setAnalyticsCustomEnd(e.target.value)}
                          min={analyticsCustomStart || undefined}
                          max={new Date().toISOString().slice(0, 10)} style={{ height: 34, maxWidth: 160 }} />
                        <button type="button" className={styles.button} onClick={() => reloadAnalytics()}
                          disabled={analyticsBusy || !analyticsCustomStart || !analyticsCustomEnd || analyticsCustomStart > analyticsCustomEnd}>
                          Apply
                        </button>
                      </div>
                    ) : null}
                    {analytics?.range ? (
                      <span className={styles.analyticsRangeMeta}>
                        {analytics.range.start_date} → {analytics.range.end_date} · {analytics.range.days} days
                      </span>
                    ) : null}
                  </div>

                  {analyticsErr ? (
                    <div className={styles.error} style={{ marginTop: 16 }}>{analyticsErr}</div>
                  ) : analyticsBusy && !analytics ? (
                    <div style={{ marginTop: 18 }}><AnalyticsPanelSkeleton variant="overview" /></div>
                  ) : analytics ? (
                    <>
                      {/* KPI summary cards */}
                      <div className={styles.kpiGrid}>
                        {(() => {
                          const s = analytics.series;
                          const mid = Math.floor(s.length / 2);
                          const pct = (a: number, b: number) => b === 0 ? null : Math.round(((a - b) / Math.abs(b)) * 100);
                          const sumKey = (arr: typeof s, k: "clicks" | "impressions") => arr.reduce((acc, p) => acc + (p[k] || 0), 0);
                          const avgKey = (arr: typeof s, k: "ctr" | "position") => arr.length === 0 ? 0 : arr.reduce((acc, p) => acc + (p[k] || 0), 0) / arr.length;
                          const first = mid > 0 ? s.slice(0, mid) : [];
                          const second = mid > 0 ? s.slice(mid) : [];
                          const dClicks = mid > 0 ? pct(sumKey(second, "clicks"), sumKey(first, "clicks")) : null;
                          const dImpr = mid > 0 ? pct(sumKey(second, "impressions"), sumKey(first, "impressions")) : null;
                          const dCtr = mid > 0 ? pct(avgKey(second, "ctr"), avgKey(first, "ctr")) : null;
                          const dPos = mid > 0 ? pct(avgKey(second, "position"), avgKey(first, "position")) : null;
                          const tiles: Array<{ label: string; value: string; delta: number | null; accent: string; sub?: string; invertDelta?: boolean }> = [
                            { label: "Total clicks", value: (analytics.totals.clicks || 0).toLocaleString(), delta: dClicks, accent: "clicks", sub: `${analytics.totals.days_with_data} days with data` },
                            { label: "Total impressions", value: (analytics.totals.impressions || 0).toLocaleString(), delta: dImpr, accent: "impressions" },
                            { label: "Avg CTR", value: `${((analytics.totals.ctr || 0) * 100).toFixed(2)}%`, delta: dCtr, accent: "ctr" },
                            { label: "Avg position", value: (analytics.totals.position || 0).toFixed(1), delta: dPos, accent: "position", invertDelta: true },
                          ];
                          return tiles.map(({ label, value, delta, accent, sub, invertDelta }) => {
                            const trend = delta === null ? "flat" : (invertDelta ? delta < 0 : delta > 0) ? "up" : (invertDelta ? delta > 0 : delta < 0) ? "down" : "flat";
                            return (
                              <div key={label} className={styles.kpiTile} data-accent={accent}>
                                <div className={styles.kpiLabel}>{label}</div>
                                <div className={styles.kpiValueRow}>
                                  <div className={styles.kpiValue}>{value}</div>
                                  {delta !== null ? (
                                    <span className={styles.kpiDelta} data-trend={trend}>
                                      {trend === "up" ? "↑" : trend === "down" ? "↓" : ""}
                                      {Math.abs(delta)}%
                                    </span>
                                  ) : null}
                                </div>
                                {sub ? <div className={styles.kpiSub}>{sub}</div> : null}
                              </div>
                            );
                          });
                        })()}
                      </div>

                      {/* Chart with series toggles */}
                      <div className={styles.analyticsChartBleed} style={{ marginTop: 20 }}>
                        <div className={styles.chartSeriesBar}>
                          {([
                            { key: "clicks" as const, label: "Clicks", color: "var(--aa-primary)" },
                            { key: "impressions" as const, label: "Impressions", color: "#5b9cf6" },
                            { key: "position" as const, label: "Avg position", color: "#b97dff" },
                          ]).map(({ key, label, color }) => (
                            <button
                              key={key}
                              type="button"
                              className={styles.chartSeriesBtn}
                              aria-pressed={chartSeries[key]}
                              onClick={() => setChartSeries((prev) => ({ ...prev, [key]: !prev[key] }))}
                            >
                              <span className={styles.chartSeriesDot} style={{ background: color, opacity: chartSeries[key] ? 1 : 0.3 }} />
                              <span style={{ opacity: chartSeries[key] ? 1 : 0.45 }}>{label}</span>
                            </button>
                          ))}
                          {analytics.markers.length > 0 ? (
                            <span className={styles.analyticsLegendMeta}>
                              <span className={styles.analyticsLegendSwatch} data-series="marker" style={{ display: "inline-block" }} />
                              {" "}{analytics.markers.length} article{analytics.markers.length === 1 ? "" : "s"} published
                            </span>
                          ) : null}
                        </div>
                        <AnalyticsLineChart
                          series={analytics.series}
                          markers={analytics.markers}
                          height={420}
                          visible={chartSeries}
                        />
                      </div>
                    </>
                  ) : (
                    <div className={styles.analyticsEmptyState}>
                      {!gscStatus?.connected || !gscStatus?.property_url ? (
                        <>
                          <p className={styles.analyticsEmptyTitle}>Connect Search Console</p>
                          <p className={styles.analyticsEmptyBody}>
                            Link a Search Console property to see clicks, impressions, and ranking data for this site.
                          </p>
                          <button type="button" className={styles.button} onClick={() => goTab("tools")}>
                            Open Tools to connect
                          </button>
                        </>
                      ) : (
                        <>
                          <p className={styles.analyticsEmptyTitle}>No traffic in this window</p>
                          <p className={styles.analyticsEmptyBody}>
                            Try a wider date range, or check back once Search Console has activity for this property.
                          </p>
                        </>
                      )}
                    </div>
                  )}
                </>
              ) : null}

              {/* ── INSIGHTS headline KPIs ── */}
              {performanceSubTab === "insights" ? (
                <>
                  {insightsErr ? (
                    <div className={styles.error} style={{ marginTop: 16 }}>{insightsErr}</div>
                  ) : insightsBusy && !insights ? (
                    <div style={{ marginTop: 18 }}><AnalyticsPanelSkeleton variant="insights" /></div>
                  ) : insights ? (
                    <div className={styles.kpiGrid} style={{ marginTop: 18 }}>
                      {([
                        { key: "clicks" as const, label: "Total clicks", accent: "clicks" },
                        { key: "impressions" as const, label: "Total impressions", accent: "impressions" },
                      ] as const).map(({ key, label, accent }) => {
                        const stat = insights.headline[key];
                        const chg = stat.change_pct;
                        const trend = chg === null ? "flat" : chg > 0 ? "up" : chg < 0 ? "down" : "flat";
                        return (
                          <div key={key} className={styles.kpiTile} data-accent={accent}>
                            <div className={styles.kpiLabel}>{label}</div>
                            <div className={styles.kpiValueRow}>
                              <div className={styles.kpiValue}>
                                {stat.value >= 1000 ? `${(stat.value / 1000).toFixed(1)}K` : stat.value.toLocaleString()}
                              </div>
                              {chg !== null ? (
                                <span className={styles.kpiDelta} data-trend={trend}>
                                  {trend === "up" ? "↑" : trend === "down" ? "↓" : ""}
                                  {Math.abs(chg).toFixed(0)}%
                                </span>
                              ) : null}
                            </div>
                            <div className={styles.kpiSub}>vs previous {insights.period.days} days</div>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className={styles.analyticsEmptyState}>
                      {gscStatus?.connected && gscStatus?.property_url ? (
                        <>
                          <p className={styles.analyticsEmptyTitle}>Ready when you are</p>
                          <p className={styles.analyticsEmptyBody}>
                            Load Insights to see headline trends, top content, and the queries driving clicks to this site.
                          </p>
                          <button type="button" className={styles.button} onClick={() => void reloadInsights()}>
                            Load Insights
                          </button>
                        </>
                      ) : (
                        <>
                          <p className={styles.analyticsEmptyTitle}>Connect Search Console</p>
                          <p className={styles.analyticsEmptyBody}>
                            Link a property to see which content and queries are driving clicks to this site.
                          </p>
                          <button type="button" className={styles.button} onClick={() => goTab("tools")}>
                            Open Tools to connect
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </>
              ) : null}
            </div>{/* end header card */}

            {/* ── OVERVIEW: Quick insight cards + sortable top pages table ── */}
            {performanceSubTab === "overview" && analytics && analytics.top_pages.length > 0 ? (
              <>
                {/* Quick insight cards */}
                {(() => {
                  const pages = analytics.top_pages;
                  const bestClicks = pages.reduce((a, b) => b.clicks > a.clicks ? b : a, pages[0]);
                  const bestPos = pages.filter((p) => p.position > 0).reduce((a, b) => b.position < a.position ? b : a, pages.find((p) => p.position > 0) ?? pages[0]);
                  const lowestCtr = [...pages].filter((p) => p.impressions > 50).sort((a, b) => a.ctr - b.ctr)[0];
                  const bigOpp = [...pages].filter((p) => p.impressions > 0).sort((a, b) => (b.impressions * (1 - b.ctr)) - (a.impressions * (1 - a.ctr)))[0];
                  const slug = (url: string) => { try { return new URL(url).pathname.replace(/^\/|\/$/g, "") || "/"; } catch { return url; } };
                  const cards: Array<{ title: string; value: string; detail: string; url?: string } | null> = [
                    bestClicks ? { title: "Best page", value: bestClicks.clicks.toLocaleString() + " clicks", detail: slug(bestClicks.url), url: bestClicks.url } : null,
                    bestPos ? { title: "Best ranking", value: `#${bestPos.position.toFixed(1)}`, detail: slug(bestPos.url), url: bestPos.url } : null,
                    lowestCtr ? { title: "Lowest CTR", value: `${(lowestCtr.ctr * 100).toFixed(2)}%`, detail: `${lowestCtr.impressions.toLocaleString()} impressions`, url: lowestCtr.url } : null,
                    bigOpp ? { title: "Biggest opportunity", value: bigOpp.impressions.toLocaleString() + " impressions", detail: `${(bigOpp.ctr * 100).toFixed(2)}% CTR`, url: bigOpp.url } : null,
                  ];
                  return (
                    <div className={styles.insightCardGrid}>
                      {cards.filter(Boolean).map((c) => c && (
                        <div key={c.title} className={styles.insightCard}>
                          <div className={styles.insightCardTitle}>{c.title}</div>
                          <div className={styles.insightCardValue}>{c.value}</div>
                          <div className={styles.insightCardDetail} title={c.url}>
                            {c.url ? (
                              <a href={c.url} target="_blank" rel="noopener noreferrer" className={styles.tableLink}>{c.detail}</a>
                            ) : c.detail}
                          </div>
                        </div>
                      ))}
                    </div>
                  );
                })()}

                {/* Top pages table with search + sort */}
                <div className={`${styles.card} ${styles.cardWide}`}>
                  <div className={styles.analyticsPanelHeadRow}>
                    <h3 className={styles.sectionSecondaryTitle} style={{ margin: 0 }}>Top pages</h3>
                    <input
                      type="search"
                      className={`${styles.input} ${styles.analyticsTableSearch}`}
                      placeholder="Filter by URL…"
                      value={topPagesSearch}
                      onChange={(e) => setTopPagesSearch(e.target.value)}
                    />
                  </div>
                  <div className={styles.analyticsTableWrap}>
                    <table className={`${styles.table} ${styles.tableZebra} ${styles.analyticsTopPagesTable}`} style={{ border: 0 }}>
                      <thead className={styles.analyticsTableSticky}>
                        <tr>
                          <th className={styles.th} style={{ width: "45%" }}>URL</th>
                          {(["clicks", "impressions", "ctr", "position"] as const).map((col) => (
                            <th
                              key={col}
                              className={`${styles.th} ${styles.thNum} ${styles.thSortable}`}
                              onClick={() => {
                                if (topPagesSortKey === col) {
                                  setTopPagesSortDir((d) => d === "asc" ? "desc" : "asc");
                                } else {
                                  setTopPagesSortKey(col);
                                  setTopPagesSortDir(col === "position" ? "asc" : "desc");
                                }
                              }}
                              aria-sort={topPagesSortKey === col ? (topPagesSortDir === "asc" ? "ascending" : "descending") : "none"}
                            >
                              <span className={styles.thSortLabel}>
                                {col === "ctr" ? "CTR" : col.charAt(0).toUpperCase() + col.slice(1)}
                                <span className={styles.thSortIcon} aria-hidden="true">
                                  {topPagesSortKey === col ? (topPagesSortDir === "asc" ? " ▲" : " ▼") : " ⇅"}
                                </span>
                              </span>
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {(() => {
                          const q = topPagesSearch.trim().toLowerCase();
                          const filtered = analytics.top_pages.filter((r) => !q || r.url.toLowerCase().includes(q));
                          const sorted = [...filtered].sort((a, b) => {
                            const av = topPagesSortKey === "ctr" ? a.ctr : a[topPagesSortKey];
                            const bv = topPagesSortKey === "ctr" ? b.ctr : b[topPagesSortKey];
                            return topPagesSortDir === "asc" ? av - bv : bv - av;
                          });
                          if (sorted.length === 0) {
                            return (
                              <tr><td className={`${styles.td} ${styles.tdMuted}`} colSpan={5} style={{ textAlign: "center", padding: 20 }}>
                                No pages match "{topPagesSearch}".
                              </td></tr>
                            );
                          }
                          return sorted.map((row) => {
                            const slug = (() => { try { return new URL(row.url).pathname.replace(/^\/|\/$/g, "") || "/"; } catch { return row.url; } })();
                            return (
                              <tr key={row.url} className={styles.analyticsPageRow}>
                                <td className={styles.td} style={{ maxWidth: 0 }}>
                                  <a href={row.url} target="_blank" rel="noopener noreferrer"
                                    className={styles.tableLink} title={row.url}
                                    style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 500 }}>
                                    {slug}
                                  </a>
                                  <div className={styles.muted} style={{ fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: 1 }}>
                                    {row.url}
                                  </div>
                                </td>
                                <td className={`${styles.td} ${styles.tdNum}`}>{row.clicks.toLocaleString()}</td>
                                <td className={`${styles.td} ${styles.tdNum}`}>{row.impressions.toLocaleString()}</td>
                                <td className={`${styles.td} ${styles.tdNum}`}>{(row.ctr * 100).toFixed(2)}%</td>
                                <td className={`${styles.td} ${styles.tdNum}`}>{row.position.toFixed(1)}</td>
                              </tr>
                            );
                          });
                        })()}
                      </tbody>
                    </table>
                  </div>
                  <div className={styles.muted} style={{ fontSize: 12, marginTop: 8 }}>
                    {analytics.top_pages.length} URLs from the linked property · sorted by {topPagesSortKey}
                  </div>
                </div>
              </>
            ) : null}

            {/* ── INSIGHTS: content + queries + countries ── */}
            {performanceSubTab === "insights" && insights ? (
              <>
                {/* Your content */}
                <div className={`${styles.card} ${styles.cardWide}`}>
                  <div className={styles.analyticsPanelHeadRow}>
                    <h3 className={styles.sectionSecondaryTitle}>Your content</h3>
                    <div className={styles.segmentGroup}>
                      {(["top", "up", "down"] as const).map((t) => (
                        <button key={t} type="button" className={styles.miniBtn}
                          onClick={() => setInsightsPagesTab(t)} aria-pressed={insightsPagesTab === t}>
                          {t === "top" ? "Top" : t === "up" ? "Trending up" : "Trending down"}
                        </button>
                      ))}
                    </div>
                  </div>
                  {(() => {
                    const sorted = [...insights.pages].filter((p) =>
                      insightsPagesTab === "top" ? true :
                      insightsPagesTab === "up" ? (p.change_pct ?? 0) > 0 :
                      (p.change_pct ?? 0) < 0
                    ).sort((a, b) =>
                      insightsPagesTab === "top" ? b.clicks - a.clicks :
                      insightsPagesTab === "up" ? (b.change_pct ?? 0) - (a.change_pct ?? 0) :
                      (a.change_pct ?? 0) - (b.change_pct ?? 0)
                    ).slice(0, 5);
                    const rows: InsightTrendRow[] = sorted.map((row) => {
                      const slug = (() => { try { return new URL(row.page).pathname.replace(/^\/|\/$/g, "") || "/"; } catch { return row.page; } })();
                      return {
                        key: row.page,
                        primary: (
                          <a href={row.page} target="_blank" rel="noopener noreferrer" className={styles.tableLink}
                            style={{ fontSize: 13, fontWeight: 500, display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {slug}
                          </a>
                        ),
                        secondary: (
                          <div className={styles.muted} style={{ fontSize: 11, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.page}</div>
                        ),
                        clicks: row.clicks,
                        changePct: row.change_pct,
                      };
                    });
                    return <InsightTrendRows rows={rows} emptyLabel="No data for this view." />;
                  })()}
                </div>

                {/* Queries */}
                <div className={`${styles.card} ${styles.cardWide}`}>
                  <div className={styles.analyticsPanelHeadRow}>
                    <h3 className={styles.sectionSecondaryTitle}>Queries leading to your site</h3>
                    <div className={styles.segmentGroup}>
                      {(["top", "up", "down"] as const).map((t) => (
                        <button key={t} type="button" className={styles.miniBtn}
                          onClick={() => setInsightsQueriesTab(t)} aria-pressed={insightsQueriesTab === t}>
                          {t === "top" ? "Top" : t === "up" ? "Trending up" : "Trending down"}
                        </button>
                      ))}
                    </div>
                  </div>
                  {(() => {
                    const sorted = [...insights.queries].filter((q) =>
                      insightsQueriesTab === "top" ? true :
                      insightsQueriesTab === "up" ? (q.change_pct ?? 0) > 0 :
                      (q.change_pct ?? 0) < 0
                    ).sort((a, b) =>
                      insightsQueriesTab === "top" ? b.clicks - a.clicks :
                      insightsQueriesTab === "up" ? (b.change_pct ?? 0) - (a.change_pct ?? 0) :
                      (a.change_pct ?? 0) - (b.change_pct ?? 0)
                    ).slice(0, 5);
                    const rows: InsightTrendRow[] = sorted.map((row) => ({
                      key: row.query,
                      primary: <span style={{ fontSize: 13, fontWeight: 500 }}>{row.query}</span>,
                      clicks: row.clicks,
                      changePct: row.change_pct,
                    }));
                    return <InsightTrendRows rows={rows} emptyLabel="No data for this view." />;
                  })()}
                </div>

                {/* Countries + traffic sources */}
                <div className={styles.analyticsInsightsGrid}>
                  <div className={`${styles.card} ${styles.cardWide}`}>
                    <h3 style={{ marginTop: 0, marginBottom: 14 }} className={styles.sectionSecondaryTitle}>Top countries</h3>
                    {insights.countries.length === 0 ? (
                      <div className={styles.muted} style={{ fontSize: 13 }}>No country data available.</div>
                    ) : (
                      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                        {insights.countries.slice(0, 5).map((c) => (
                          <div key={c.country_code} className={styles.analyticsCountryRow}>
                            <span className={styles.analyticsCountryFlag}>{c.flag || "🌐"}</span>
                            <span className={styles.analyticsCountryName}>{c.country_name}</span>
                            <div className={styles.analyticsCountryTrack}>
                              <div className={styles.analyticsCountryFill} style={{ width: `${c.share_pct}%` }} />
                            </div>
                            <span className={styles.analyticsCountryShare}>{c.share_pct.toFixed(0)}%</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  {insights.traffic_sources.length > 0 ? (
                    <div className={styles.card} style={{ minWidth: 200 }}>
                      <h3 style={{ marginTop: 0, marginBottom: 14 }} className={styles.sectionSecondaryTitle}>Additional traffic sources</h3>
                      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        {insights.traffic_sources.map((s) => (
                          <div key={s.source} className={styles.analyticsSourceRow}>
                            <span style={{ fontSize: 13 }}>{s.source}</span>
                            <span style={{ fontSize: 14, fontWeight: 700 }}>{s.clicks.toLocaleString()}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              </>
            ) : null}

            {/* ── GSC TOOLS: Sitemap submission + Indexing status ── */}
            {gscStatus?.connected && (gscStatus?.property_url || "").trim() ? (
              <>
                {/* Sitemap submission */}
                <div className={`${styles.card} ${styles.cardWide}`}>
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

                {/* Existing articles — indexing status */}
                <div className={`${styles.card} ${styles.cardWide}`}>
                  <h3 style={{ marginTop: 0 }} className={`${styles.sectionSecondaryTitle}`}>Existing articles — indexing status</h3>
                  <div className={styles.muted} style={{ fontSize: 12, marginBottom: 10, lineHeight: 1.5 }}>
                    <strong>Check</strong> reads the URL&apos;s current coverage from Search Console (read-only).{" "}
                    <strong>Index now</strong> pings Google&apos;s Indexing API (officially supported only for
                    JobPosting / BroadcastEvent — for general articles it&apos;s a discovery hint and is{" "}
                    <em>not</em> reflected in URL Inspection&apos;s history) and pings your sitemap, then opens
                    Search Console&apos;s URL Inspection panel pre-filled with the URL. Pressing{" "}
                    <strong>REQUEST INDEXING</strong> there is the only action that produces the visible
                    &ldquo;Indexing requested&rdquo; entry in Search Console.
                  </div>
                  {(() => {
                    if (indexingArticlesLoading) {
                      return <TextLinesSkeleton lines={3} />;
                    }
                    const allPublished = indexingArticles;
                    if (!allPublished.length) {
                      return (
                        <div className={styles.muted} style={{ fontSize: 13 }}>
                          No published articles yet. Once an article goes live, it will appear here.
                        </div>
                      );
                    }

                    const q = indexingSearch.trim().toLowerCase();
                    const filtered = allPublished.filter((a) => {
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
                        <div className={styles.row} style={{ gap: 8, marginBottom: 10, flexWrap: "wrap", alignItems: "center" }}>
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
                            Showing {pageRows.length} of {total} ({allPublished.length} published)
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
                                    <td className={styles.td} style={{ maxWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={a.title}>
                                      {a.title || "(untitled)"}
                                    </td>
                                    <td className={styles.td} style={{ maxWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                      <a href={a.wp_link || "#"} target="_blank" rel="noopener noreferrer" className={styles.tableLink} title={a.wp_link || ""}>
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
                            <span>Page {safePage} / {totalPages}</span>
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
              </>
            ) : null}
          </div>
        ) : null}

        {tab === "members" ? (
          <div className={styles.settingsPage}>
            <div className={styles.intro}>
              <h1 style={{ margin: 0 }}>Members</h1>
              <p style={{ marginBottom: 0 }}>Manage who has access to this project.</p>
            </div>

            {/* Invite form — only owner/admin */}
            {projectMeta && (!projectMeta.is_shared || projectMeta.your_role === "admin" || projectMeta.your_role === "owner") && (
              <div className={projectsDark.membersCard}>
                <h2 className={projectsDark.membersSectionTitle}>Invite collaborator</h2>
                <div className={projectsDark.membersInviteRow}>
                  <input
                    type="email"
                    className={projectsDark.membersEmailInput}
                    placeholder="Email address"
                    value={membersInviteEmail}
                    onChange={e => { setMembersInviteEmail(e.target.value); setMembersInviteError(null); }}
                    onKeyDown={e => { if (e.key === "Enter") void handleMembersInvite(); }}
                    aria-label="Invite email"
                  />
                  <select
                    className={projectsDark.membersRoleSelect}
                    value={membersInviteRole}
                    onChange={e => setMembersInviteRole(e.target.value as CollaboratorRole)}
                    aria-label="Role"
                  >
                    <option value="admin">Admin</option>
                    <option value="editor">Editor</option>
                    <option value="viewer">Viewer</option>
                  </select>
                  <button
                    type="button"
                    className={styles.button}
                    disabled={membersInviteBusy}
                    onClick={() => void handleMembersInvite()}
                  >
                    {membersInviteBusy ? "Sending…" : "Send invite"}
                  </button>
                </div>
                {membersInviteError && (
                  <p className={projectsDark.membersInviteError} role="alert">{membersInviteError}</p>
                )}
              </div>
            )}

            {membersLoading ? (
              <div className={projectsDark.membersCard}>
                <p className={projectsDark.membersMuted}>Loading members…</p>
              </div>
            ) : (
              <>
                {/* Current members */}
                <div className={projectsDark.membersCard}>
                  <h2 className={projectsDark.membersSectionTitle}>Current members</h2>

                  {/* Owner row */}
                  <div className={projectsDark.memberRow}>
                    <div className={projectsDark.memberAvatar}>
                      {projectMeta?.owner_name ? projectMeta.owner_name.slice(0, 2).toUpperCase() : "OW"}
                    </div>
                    <div className={projectsDark.memberInfo}>
                      <span className={projectsDark.memberName}>{projectMeta?.owner_name || "Project Owner"}</span>
                      <span className={projectsDark.memberEmail}>Owner</span>
                    </div>
                    <span className={projectsDark.ownerBadge}>Owner</span>
                  </div>

                  {/* Collaborators */}
                  {(membersData?.collaborators || []).map(c => (
                    <div key={c.id} className={projectsDark.memberRow}>
                      <div className={projectsDark.memberAvatar}>{c.user_avatar_initials || "?"}</div>
                      <div className={projectsDark.memberInfo}>
                        <span className={projectsDark.memberName}>{c.user_name || c.user_email}</span>
                        <span className={projectsDark.memberEmail}>{c.user_email}</span>
                      </div>
                      {projectMeta && (!projectMeta.is_shared || projectMeta.your_role === "admin" || projectMeta.your_role === "owner") ? (
                        <>
                          <select
                            className={projectsDark.membersRoleSelect}
                            value={c.role}
                            disabled={membersRoleChangeBusy === c.id}
                            onChange={e => void handleMembersChangeRole(c.id, e.target.value as CollaboratorRole)}
                            aria-label={`Role for ${c.user_name || c.user_email}`}
                          >
                            <option value="admin">Admin</option>
                            <option value="editor">Editor</option>
                            <option value="viewer">Viewer</option>
                          </select>
                          <button
                            type="button"
                            className={projectsDark.memberRemoveBtn}
                            disabled={membersRemoveBusy === c.id}
                            onClick={() => void handleMembersRemove(c)}
                          >
                            {membersRemoveBusy === c.id ? "…" : "Remove"}
                          </button>
                        </>
                      ) : (
                        <span className={projectsDark.memberRoleBadge}>{c.role}</span>
                      )}
                    </div>
                  ))}

                  {(membersData?.collaborators || []).length === 0 && (
                    <p className={projectsDark.membersMuted}>No collaborators yet.</p>
                  )}
                </div>

                {/* Pending invitations */}
                {(membersData?.pending_invitations || []).length > 0 && (
                  <div className={projectsDark.membersCard}>
                    <h2 className={projectsDark.membersSectionTitle}>Pending invitations</h2>
                    {(membersData?.pending_invitations || []).map((inv: InvitationPublic) => (
                      <div key={inv.id} className={projectsDark.memberRow}>
                        <div className={`${projectsDark.memberAvatar} ${projectsDark.memberAvatarPending}`}>?</div>
                        <div className={projectsDark.memberInfo}>
                          <span className={projectsDark.memberName}>{inv.invited_email}</span>
                          <span className={projectsDark.memberEmail}>{inv.role} · Pending</span>
                        </div>
                        {projectMeta && (!projectMeta.is_shared || projectMeta.your_role === "admin" || projectMeta.your_role === "owner") && (
                          <>
                            <button
                              type="button"
                              className={projectsDark.memberResendBtn}
                              disabled={membersResendBusy === inv.id}
                              onClick={() => void handleMembersResend(inv.id)}
                            >
                              {membersResendBusy === inv.id ? "…" : "Resend"}
                            </button>
                            <button
                              type="button"
                              className={projectsDark.memberRemoveBtn}
                              disabled={membersCancelBusy === inv.id}
                              onClick={() => void handleMembersCancel(inv.id)}
                            >
                              {membersCancelBusy === inv.id ? "…" : "Cancel"}
                            </button>
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        ) : null}

        {tab === "project_settings" ? (
          <div className={styles.settingsPage}>
            {(() => {
              const connectionOkForSave = isShopifyProject
                ? (settings?.shopify_verified_status || "").toLowerCase() === "connected" &&
                  !!(settings?.shopify_verified_at || "").trim()
                : !!settings &&
                  (settings.wp_verified_status || "").toLowerCase() === "connected" &&
                  !!(settings.wp_verified_at || "").trim();
              const showSave = settings
                ? settingsDirty || (connectionOkForSave && identityDirty)
                : settingsDirty || identityDirty;
              if (!showSave) return null;
              return (
                <div className={styles.settingsActionBar}>
                  <p className={styles.settingsActionBarHint}>You have unsaved changes on this page.</p>
                  <button
                    className={styles.button}
                    type="button"
                    onClick={saveSettings}
                    disabled={settingsSaving || settingsLoading}
                  >
                    {settingsSaving ? "Saving…" : "Save changes"}
                  </button>
                </div>
              );
            })()}
            {settingsLoading ? <FormFieldsSkeleton fields={5} /> : null}
            {error ? <p className={styles.error}>{error}</p> : null}

            {!settingsLoading && settings ? (
              <>
              {isShopifyProject ? (
                <ShopifyProjectSettings
                  projectId={projectId}
                  name={sName}
                  storeUrl={sUrl}
                  clientId={sShopifyClientId}
                  settings={settings}
                  productAwareEnabled={Boolean(sShopifyProductAware)}
                  onProductAwareEnabledChange={(value) => {
                    setSShopifyProductAware(value);
                  }}
                  onNameChange={setSName}
                  onStoreUrlChange={setSUrl}
                  onClientIdChange={setSShopifyClientId}
                  onSettingsSaved={(saved) => {
                    setSettings(saved);
                    setSShopifyClientId(saved.shopify_client_id || "");
                    setSName(saved.name || sName);
                    setProjectsList((prev) =>
                      prev.map((p) => (p.id === projectId ? { ...p, name: saved.name || p.name } : p)),
                    );
                  }}
                  onConnectionChange={() => {
                    invalidateProjectSettingsCache(projectId);
                    void api.getProject(projectId).then(setProjectMeta).catch(() => undefined);
                    void api.getProjectSettings(projectId, { fresh: true }).then((fresh) => {
                      setSettings(fresh);
                      setSName(fresh.name || "");
                      setSShopifyClientId(fresh.shopify_client_id || "");
                    }).catch(() => undefined);
                  }}
                />
              ) : null}
              {!isShopifyProject ? (
              <section className={styles.settingsSectionCard}>
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
                    <p className={styles.settingsSectionKicker}>Website</p>
                    <h3 className={styles.settingsSectionTitle}>
                      WordPress connection
                    </h3>
                    <p className={styles.settingsSectionDesc}>
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
                      pluginLabel = "Plugin verified";
                      pluginState = "verified";
                      pluginTitle =
                        pluginMsg ||
                        "Riviso connector /ping and /publish routes verified on this site.";
                    } else if (pluginStatus === "upgrade_required") {
                      pluginLabel = "Plugin upgrade required";
                      pluginState = "warning";
                      pluginTitle =
                        pluginMsg ||
                        "An older or incomplete Riviso connector was detected. Download v0.2.0+ and verify again.";
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

                <div className={styles.settingsFieldsGrid}>
                  <label className={styles.settingsFieldLabel}>
                    Project display name
                    <input className={styles.input} value={sName} onChange={(e) => setSName(e.target.value)} />
                  </label>
                  <label className={styles.settingsFieldLabel}>
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
                  <label className={styles.settingsFieldLabel}>
                    WordPress username
                    <input
                      className={styles.input}
                      value={sWpUser}
                      onChange={(e) => setSWpUser(e.target.value)}
                      placeholder="Login username (not always your email)"
                      autoComplete="username"
                    />
                  </label>
                  <label className={styles.settingsFieldLabel}>
                    Application password
                    <span className={styles.authPasswordWrap}>
                      <input
                        className={`${styles.input} ${styles.authPasswordInput}`}
                        value={sWpPass}
                        type={showWpAppPassword ? "text" : "password"}
                        onChange={(e) => setSWpPass(e.target.value)}
                        placeholder="Paste from WordPress → Users → Profile → Application Passwords"
                        autoComplete="off"
                        spellCheck={false}
                      />
                      <button
                        type="button"
                        className={styles.authToggle}
                        onClick={() => setShowWpAppPassword((v) => !v)}
                        aria-label={showWpAppPassword ? "Hide application password" : "Show application password"}
                        title={showWpAppPassword ? "Hide password" : "Show password"}
                      >
                        {showWpAppPassword ? "×" : "👁"}
                      </button>
                    </span>
                  </label>
                </div>

                <div className={styles.wpConnectionActions}>
                  <button
                    className={styles.btnSecondary}
                    type="button"
                    onClick={async () => {
                      try {
                        setError(null);
                        await downloadWordpressPlugin(settings?.plugin_download_url);
                      } catch (e) {
                        setError(e instanceof Error ? e.message : "Could not download plugin.");
                      }
                    }}
                  >
                    Download plugin
                  </button>
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

                </section>
              ) : null}

                {(() => {
                  if (!settings) return null;
                  const wpVerifiedOk = isShopifyProject
                    ? (settings.shopify_verified_status || "").toLowerCase() === "connected" &&
                      !!(settings.shopify_verified_at || "").trim()
                    : (settings.wp_verified_status || "").toLowerCase() === "connected" &&
                      !!(settings.wp_verified_at || "").trim();
                  if (!wpVerifiedOk) {
                    return (
                      <div className={styles.settingsLockedBanner}>
                        <strong>Brand identity</strong>, <strong>niche</strong>, and{" "}
                        {isShopifyProject ? <strong>catalog tools</strong> : <strong>WordPress defaults</strong>} unlock
                        after {isShopifyProject ? "Shopify is connected" : "WordPress returns a successful verify (green Verified pill above)"}.
                        {isShopifyProject ? (
                          <>
                            {" "}
                            Enter your shop URL, Client ID, and Client secret above, then click{" "}
                            <strong>Verify connection</strong> or <strong>Refresh connection</strong>.
                          </>
                        ) : (
                          <> Finish connecting your site, then click <strong>Verify connection</strong> again if credentials changed.</>
                        )}
                      </div>
                    );
                  }
                  return (
                    <>
                      <section className={styles.settingsSectionCard}>
                      {/* ----------------------------------------------------------------
                       * Brand identity — structured form
                       * Replaces the old free-text textarea with three discrete inputs
                       * (voice / tones / rules). The backend rebuilds the legacy
                       * `brand_identity` plain-text string from these every time we
                       * save, so downstream consumers (article generation, image
                       * prompt builder) keep working without changes.
                       * ---------------------------------------------------------------- */}
                      <div className={styles.brandSection}>
                        <p className={styles.settingsSectionKicker}>Content</p>
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
                          <label className={`${styles.brandFieldLabel} ${styles.settingsFieldFull}`}>
                            Tones <span className={styles.brandFieldHelp} style={{ fontWeight: 500, opacity: 1 }}>(pick up to 5)</span>
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
                                    aria-pressed={selected}
                                    disabled={disabled}
                                    title={disabled ? "Pick up to 5 tones — remove one to add another." : undefined}
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
                        <label className={`${styles.brandFieldLabel} ${styles.settingsFieldFull}`}>
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
                      </section>

                      <section className={styles.settingsSectionCard}>
                      {/* ----------------------------------------------------------------
                       * Niche identifier — structured form
                       * Topic + audience + countries + cities. The backend rebuilds the
                       * legacy `niche_identifier` plain-text string from this every save.
                       * ---------------------------------------------------------------- */}
                      <div className={styles.brandSection}>
                        <p className={styles.settingsSectionKicker}>Targeting</p>
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
                                  aria-pressed={selected}
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
                                  aria-label={`Remove custom audience “${custom}”`}
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
                                className={`${styles.chipPickerBox} ${styles.settingsChipScroll}`}
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
                                        aria-pressed={selected}
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
                                                      aria-pressed={selected}
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
                                              aria-label={`Remove custom city “${city}”`}
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
                      </section>

                      {!isShopifyProject ? (
                      <section className={styles.settingsSectionCard}>
                        <p className={styles.settingsSectionKicker}>Publishing</p>
                        <h3 className={styles.settingsSectionTitle}>WordPress defaults</h3>
                        <p className={styles.settingsSectionDesc}>
                          Pre-selected when publishing articles. You can still override per article.
                        </p>

                        <div className={styles.settingsFieldsGrid} style={{ marginTop: 16 }}>
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
                      </section>
                      ) : null}
                    </>
                  );
                })()}

                <div className={styles.settingsInfoCard}>
                  <h3 className={styles.settingsInfoCardTitle}>Google Search Console</h3>
                  <p className={styles.settingsInfoCardDesc}>
                    Search Console connection moved to{" "}
                    <button type="button" className={styles.settingsInfoLink} onClick={() => setTab("tools")}>
                      Tools → Search Console
                    </button>
                    . Each project connects to its own Google account and chooses its property there.
                  </p>
                </div>

                <div className={styles.settingsDangerCard}>
                  <h3 className={styles.settingsDangerCardTitle}>Danger zone</h3>
                  <p className={styles.settingsDangerCardDesc}>
                    Deleting a project removes it permanently, including all settings, website connections, prompts, scheduled jobs, and articles.
                  </p>
                  <div className={styles.settingsDangerActions}>
                    <button type="button" className={`${styles.miniBtn} ${styles.miniDanger}`} onClick={() => setConfirmDeleteProject(true)} disabled={deletingProject}>
                      Delete project
                    </button>
                  </div>
                </div>
              </>
            ) : null}
          </div>
        ) : null}

        {confirmDeleteProject ? (
          <div className={styles.modalBackdrop} role="dialog" aria-modal="true" aria-label="Confirm delete project">
            <div ref={confirmDeleteProjectTrapRef} className={styles.modalPanel}>
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
            <div ref={clusterErrorModalTrapRef} className={styles.modalPanel}>
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

        {confirmPostNowJob ? (
          <div className={styles.modalBackdrop} role="dialog" aria-modal="true" aria-label="Post now">
            <div className={styles.modalPanel}>
              <div className={styles.modalHead}>
                <h3 className={styles.modalTitle}>Post now</h3>
                <button
                  type="button"
                  className={styles.btnSecondary}
                  onClick={closePostNowConfirm}
                  disabled={postNowBusy}
                >
                  Close
                </button>
              </div>
              <div className={styles.modalBody}>
                <p style={{ marginTop: 0 }}>
                  Are you sure you want to post it now? With this, the post will be published to the website now.
                </p>
                {!["ready_to_post", "posted"].includes((confirmPostNowJob.state || "").toLowerCase()) ? (
                  <>
                    <p className={styles.muted} style={{ fontSize: 12, marginBottom: 12 }}>
                      Content is not generated yet — Riviso will create the article and featured image first, then publish.
                    </p>
                    <label className={styles.label}>
                      Writing prompt
                      <select
                        className={styles.input}
                        value={postNowWritingPromptId}
                        onChange={(e) => setPostNowWritingPromptId(e.target.value)}
                        disabled={postNowBusy}
                      >
                        <option value="">Project default (system prompt)</option>
                        {postNowWritingPromptId &&
                        !scheduleWritingPrompts?.items.some((p) => p.id === postNowWritingPromptId) ? (
                          <option value={postNowWritingPromptId}>{postNowWritingPromptId}</option>
                        ) : null}
                        {(scheduleWritingPrompts?.items || []).map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name || p.id}
                          </option>
                        ))}
                      </select>
                      {scheduleWritingPrompts?.default_id ? (
                        <div className={styles.muted} style={{ fontSize: 12, marginTop: 6 }}>
                          Default:{" "}
                          <strong>
                            {scheduleWritingPrompts.items.find((x) => x.id === scheduleWritingPrompts.default_id)?.name ||
                              scheduleWritingPrompts.default_id}
                          </strong>
                        </div>
                      ) : null}
                    </label>
                    <label className={styles.label}>
                      Generate image
                      <select
                        className={styles.input}
                        value={postNowGenerateImage ? "yes" : "no"}
                        onChange={(e) => setPostNowGenerateImage(e.target.value === "yes")}
                        disabled={postNowBusy}
                      >
                        <option value="yes">Yes</option>
                        <option value="no">No</option>
                      </select>
                    </label>
                    <label className={styles.label}>
                      Image prompt
                      <select
                        className={styles.input}
                        value={postNowImagePromptId}
                        onChange={(e) => setPostNowImagePromptId(e.target.value)}
                        disabled={postNowBusy || !postNowGenerateImage}
                      >
                        <option value="">Project default (system prompt)</option>
                        {postNowImagePromptId &&
                        !scheduleImagePrompts?.items.some((p) => p.id === postNowImagePromptId) ? (
                          <option value={postNowImagePromptId}>{postNowImagePromptId}</option>
                        ) : null}
                        {(scheduleImagePrompts?.items || []).map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name || p.id}
                          </option>
                        ))}
                      </select>
                      {postNowGenerateImage && scheduleImagePrompts?.default_id ? (
                        <div className={styles.muted} style={{ fontSize: 12, marginTop: 6 }}>
                          Default:{" "}
                          <strong>
                            {scheduleImagePrompts.items.find((x) => x.id === scheduleImagePrompts.default_id)?.name ||
                              scheduleImagePrompts.default_id}
                          </strong>
                        </div>
                      ) : null}
                    </label>
                  </>
                ) : null}
                <div className={styles.muted} style={{ fontSize: 12, marginTop: 10 }}>
                  {articleTitleFor(confirmPostNowJob.article_id)}
                </div>
                {error ? <p className={styles.error} style={{ marginTop: 10 }}>{error}</p> : null}
              </div>
              <div className={styles.modalFooter}>
                <button
                  type="button"
                  className={styles.btnSecondary}
                  onClick={closePostNowConfirm}
                  disabled={postNowBusy}
                >
                  No
                </button>
                <button
                  type="button"
                  className={styles.button}
                  onClick={() => void postNowFromScheduledJob()}
                  disabled={postNowBusy}
                >
                  {postNowBusy
                    ? postNowPhase === "generating"
                      ? "Generating & publishing…"
                      : "Publishing…"
                    : "Yes, post now"}
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {websiteConnectionModal ? (
          <div
            className={styles.modalBackdrop}
            role="dialog"
            aria-modal="true"
            aria-label={websiteConnectionModal.title}
          >
            <div ref={websiteConnectionModalTrapRef} className={styles.modalPanel}>
              <div className={styles.modalHead}>
                <h3 className={styles.modalTitle}>{websiteConnectionModal.title}</h3>
                <button
                  type="button"
                  className={styles.iconButton}
                  aria-label="Close"
                  onClick={() => setWebsiteConnectionModal(null)}
                >
                  <Icon.X className={styles.icon20} />
                </button>
              </div>
              <div className={styles.modalBody}>
                <p style={{ margin: 0, lineHeight: 1.55 }}>{websiteConnectionModal.message}</p>
              </div>
              <div className={styles.modalFooter}>
                <button
                  type="button"
                  className={styles.btnSecondary}
                  onClick={() => {
                    setWebsiteConnectionModal(null);
                    router.push("/dashboard");
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className={styles.button}
                  onClick={() => {
                    setWebsiteConnectionModal(null);
                    router.push(`/projects/${projectId}?tab=project_settings`);
                  }}
                >
                  Connect Website
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {curationPromptModal ? (
          <div
            className={styles.modalBackdrop}
            role="dialog"
            aria-modal="true"
            aria-label="Generate curation articles"
          >
            <div ref={curationPromptModalTrapRef} className={styles.modalPanel}>
              <div className={styles.modalHead}>
                <h3 className={styles.modalTitle}>
                  Generate {curationPromptModal.ideaIds.length} selected idea{curationPromptModal.ideaIds.length === 1 ? "" : "s"}
                </h3>
                <button
                  type="button"
                  className={styles.iconButton}
                  aria-label="Close"
                  onClick={() => setCurationPromptModal(null)}
                  disabled={curationPromptModal.busy}
                >
                  <Icon.X className={styles.icon20} />
                </button>
              </div>
              <div className={styles.modalBody}>
                {curationPromptModal.step === "prompts" ? (
                  <>
                    <p className={styles.muted} style={{ marginTop: 0, lineHeight: 1.55 }}>
                      Selected ideas will be imported, then generated with article content and featured images.
                    </p>
                    <label className={styles.label}>
                      Writing prompt
                      <select
                        className={styles.input}
                        value={curationPromptModal.writingPromptId}
                        onChange={(e) =>
                          setCurationPromptModal((m) => (m ? { ...m, writingPromptId: e.target.value } : m))
                        }
                      >
                        <option value="">Project default</option>
                        {(scheduleWritingPrompts?.items || []).map((p) => (
                          <option key={p.id} value={p.id}>{p.name || p.id}</option>
                        ))}
                      </select>
                    </label>
                    <label className={styles.label}>
                      Image prompt
                      <select
                        className={styles.input}
                        value={curationPromptModal.imagePromptId}
                        onChange={(e) =>
                          setCurationPromptModal((m) => (m ? { ...m, imagePromptId: e.target.value } : m))
                        }
                      >
                        <option value="">Project default</option>
                        {(scheduleImagePrompts?.items || []).map((p) => (
                          <option key={p.id} value={p.id}>{p.name || p.id}</option>
                        ))}
                      </select>
                    </label>
                  </>
                ) : (
                  <>
                    <p className={styles.muted} style={{ marginTop: 0, lineHeight: 1.55 }}>
                      Map <strong>active</strong> store products for this batch. Content will link to{" "}
                      <code>/products/&#123;handle&#125;</code> and the featured image can use the first product photo as a
                      style reference.
                    </p>
                    <ShopifyProductMapPicker
                      products={shopifyCatalog?.products || []}
                      value={curationPromptModal.mappedProducts}
                      onChange={(mappedProducts) =>
                        setCurationPromptModal((m) => (m ? { ...m, mappedProducts } : m))
                      }
                      loading={shopifyCatalogLoading}
                      grantedScopes={shopifyCatalog?.granted_scopes || []}
                    />
                  </>
                )}
              </div>
              <div className={styles.modalFooter}>
                {curationPromptModal.step === "products" ? (
                  <button
                    type="button"
                    className={styles.btnSecondary}
                    onClick={() =>
                      setCurationPromptModal((m) => (m ? { ...m, step: "prompts" } : m))
                    }
                    disabled={curationPromptModal.busy}
                  >
                    Back
                  </button>
                ) : (
                  <button
                    type="button"
                    className={styles.btnSecondary}
                    onClick={() => setCurationPromptModal(null)}
                    disabled={curationPromptModal.busy}
                  >
                    Cancel
                  </button>
                )}
                {curationPromptModal.step === "prompts" ? (
                  <button
                    type="button"
                    className={styles.button}
                    disabled={curationPromptModal.busy}
                    onClick={() => {
                      if (isShopifyProject) {
                        void loadShopifyCatalogIfNeeded();
                        setCurationPromptModal((m) => (m ? { ...m, step: "products" } : m));
                      } else {
                        void confirmCurationPromptAction();
                      }
                    }}
                  >
                    {isShopifyProject ? "Next: Map products" : curationPromptModal.busy ? "Generating…" : "Generate articles + images"}
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      className={styles.btnSecondary}
                      disabled={curationPromptModal.busy}
                      onClick={() => void confirmCurationPromptAction()}
                    >
                      Skip — generate without products
                    </button>
                    <button
                      type="button"
                      className={styles.button}
                      disabled={curationPromptModal.busy || !curationPromptModal.mappedProducts.length}
                      onClick={() => void confirmCurationPromptAction()}
                    >
                      {curationPromptModal.busy ? "Generating…" : "Generate with mapped products"}
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        ) : null}

        {clusterGeneratePromptModal ? (
          <div
            className={styles.modalBackdrop}
            role="dialog"
            aria-modal="true"
            aria-label="Generate cluster articles"
          >
            <div ref={clusterGeneratePromptModalTrapRef} className={styles.modalPanel}>
              <div className={styles.modalHead}>
                <h3 className={styles.modalTitle}>
                  {clusterGeneratePromptModal.step === "products"
                    ? "Map products for generation"
                    : `Generate ${clusterGeneratePromptModal.pendingCount} article${clusterGeneratePromptModal.pendingCount === 1 ? "" : "s"} + images`}
                </h3>
                <button
                  type="button"
                  className={styles.iconButton}
                  aria-label="Close"
                  onClick={() => setClusterGeneratePromptModal(null)}
                  disabled={clusterGeneratePromptModal.busy}
                >
                  <Icon.X className={styles.icon20} />
                </button>
              </div>
              <div className={styles.modalBody}>
                {clusterGeneratePromptModal.step === "prompts" ? (
                  <>
                    <p className={styles.muted} style={{ marginTop: 0, lineHeight: 1.55 }}>
                      Choose prompts for this batch. On the next step you can map active Shopify products into every
                      generated article.
                    </p>
                    <label className={styles.label}>
                      Writing prompt
                      <select
                        className={styles.input}
                        value={clusterGeneratePromptModal.writingPromptId}
                        onChange={(e) =>
                          setClusterGeneratePromptModal((m) => (m ? { ...m, writingPromptId: e.target.value } : m))
                        }
                      >
                        <option value="">Project default</option>
                        {(scheduleWritingPrompts?.items || []).map((p) => (
                          <option key={p.id} value={p.id}>{p.name || p.id}</option>
                        ))}
                      </select>
                    </label>
                    <label className={styles.label}>
                      Image prompt
                      <select
                        className={styles.input}
                        value={clusterGeneratePromptModal.imagePromptId}
                        onChange={(e) =>
                          setClusterGeneratePromptModal((m) => (m ? { ...m, imagePromptId: e.target.value } : m))
                        }
                      >
                        <option value="">Project default</option>
                        {(scheduleImagePrompts?.items || []).map((p) => (
                          <option key={p.id} value={p.id}>{p.name || p.id}</option>
                        ))}
                      </select>
                    </label>
                  </>
                ) : (
                  <>
                    <p className={styles.muted} style={{ marginTop: 0, lineHeight: 1.55 }}>
                      Select up to 3 <strong>active</strong> products for pillar + cluster articles in this batch.
                    </p>
                    <ShopifyProductMapPicker
                      products={shopifyCatalog?.products || []}
                      value={clusterGeneratePromptModal.mappedProducts}
                      onChange={(mappedProducts) =>
                        setClusterGeneratePromptModal((m) => (m ? { ...m, mappedProducts } : m))
                      }
                      loading={shopifyCatalogLoading}
                      grantedScopes={shopifyCatalog?.granted_scopes || []}
                    />
                  </>
                )}
              </div>
              <div className={styles.modalFooter}>
                {clusterGeneratePromptModal.step === "products" ? (
                  <button
                    type="button"
                    className={styles.btnSecondary}
                    onClick={() =>
                      setClusterGeneratePromptModal((m) => (m ? { ...m, step: "prompts" } : m))
                    }
                    disabled={clusterGeneratePromptModal.busy}
                  >
                    Back
                  </button>
                ) : (
                  <button
                    type="button"
                    className={styles.btnSecondary}
                    onClick={() => setClusterGeneratePromptModal(null)}
                    disabled={clusterGeneratePromptModal.busy}
                  >
                    Cancel
                  </button>
                )}
                {clusterGeneratePromptModal.step === "prompts" ? (
                  <button
                    type="button"
                    className={styles.button}
                    disabled={clusterGeneratePromptModal.busy}
                    onClick={() => {
                      if (isShopifyProject) {
                        void loadShopifyCatalogIfNeeded();
                        setClusterGeneratePromptModal((m) => (m ? { ...m, step: "products" } : m));
                      } else {
                        const m = clusterGeneratePromptModal;
                        if (!m) return;
                        setClusterGeneratePromptModal(null);
                        void generateForCluster(m.clusterId, {
                          topicIds: m.topicIds,
                          writingPromptId: m.writingPromptId || null,
                          imagePromptId: m.imagePromptId || null,
                        });
                      }
                    }}
                  >
                    {isShopifyProject ? "Next: Map products" : clusterGeneratePromptModal.busy ? "Generating…" : "Generate articles + images"}
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      className={styles.btnSecondary}
                      disabled={clusterGeneratePromptModal.busy}
                      onClick={() => {
                        const m = clusterGeneratePromptModal;
                        if (!m) return;
                        setClusterGeneratePromptModal(null);
                        void generateForCluster(m.clusterId, {
                          topicIds: m.topicIds,
                          writingPromptId: m.writingPromptId || null,
                          imagePromptId: m.imagePromptId || null,
                          mappedProducts: [],
                        });
                      }}
                    >
                      Skip — generate without products
                    </button>
                    <button
                      type="button"
                      className={styles.button}
                      disabled={!clusterGeneratePromptModal.mappedProducts.length}
                      onClick={() => {
                        const m = clusterGeneratePromptModal;
                        if (!m) return;
                        setClusterGeneratePromptModal(null);
                        void generateForCluster(m.clusterId, {
                          topicIds: m.topicIds,
                          writingPromptId: m.writingPromptId || null,
                          imagePromptId: m.imagePromptId || null,
                          mappedProducts: m.mappedProducts,
                        });
                      }}
                    >
                      Generate with mapped products
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        ) : null}

        <BulkScheduleModal
          open={!!researchScheduleModal}
          title={
            researchScheduleModal?.kind === "cluster"
              ? `Schedule ${researchScheduleModal.seedRows.length} topic${researchScheduleModal.seedRows.length === 1 ? "" : "s"}`
              : `Schedule ${researchScheduleModal?.seedRows.length ?? 0} idea${researchScheduleModal?.seedRows.length === 1 ? "" : "s"}`
          }
          seedRows={researchScheduleModal?.seedRows ?? []}
          profileTz={profileTz}
          defaults={wpDefaults}
          wpTypesForSchedule={wpTypesForSchedule}
          scheduleWritingPrompts={scheduleWritingPrompts}
          scheduleImagePrompts={scheduleImagePrompts}
          submitting={researchScheduleBusy}
          error={researchScheduleError}
          onClose={() => {
            if (!researchScheduleBusy) {
              setResearchScheduleModal(null);
              setResearchScheduleError(null);
            }
          }}
          onValidationError={setResearchScheduleError}
          onSubmit={submitResearchBulkSchedule}
        />

        {confirmPrompt ? (
          <>
            <button
              type="button"
              className={styles.modalBackdrop}
              aria-label="Close"
              onClick={() => setConfirmPrompt(null)}
            />
            <div
              ref={confirmPromptTrapRef}
              className={styles.modalPanel}
              role="dialog"
              aria-modal="true"
              aria-label={confirmPrompt.title}
              style={{ maxWidth: 440 }}
            >
              <div className={styles.modalHead}>
                <h3 className={styles.modalTitle}>{confirmPrompt.title}</h3>
                <button type="button" className={styles.btnSecondary} onClick={() => setConfirmPrompt(null)}>
                  Close
                </button>
              </div>
              <div className={styles.modalBody}>
                <p style={{ marginTop: 0, lineHeight: 1.55 }}>{confirmPrompt.body}</p>
              </div>
              <div className={styles.modalFooter}>
                <button type="button" className={styles.btnSecondary} onClick={() => setConfirmPrompt(null)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className={confirmPrompt.danger ? `${styles.miniBtn} ${styles.miniDanger}` : styles.button}
                  onClick={() => {
                    const run = confirmPrompt.onConfirm;
                    setConfirmPrompt(null);
                    run();
                  }}
                >
                  {confirmPrompt.confirmLabel}
                </button>
              </div>
            </div>
          </>
        ) : null}
          </section>
        </div>
      </main>
    </div>
  );
}

