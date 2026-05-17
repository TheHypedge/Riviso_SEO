export type TokenPair = {
  access_token: string;
  refresh_token: string;
  token_type: "bearer";
};

export type UserPublic = {
  id: string;
  email: string;
  role: string;
  subscription_type?: string | null;
};

export type AdminUserPublic = {
  id: string;
  email: string;
  role: string;
  subscription_type?: string | null;
  full_name?: string | null;
  phone?: string | null;
  timezone?: string | null;
  address?: string | null;
  account_status?: string | null;
  is_deleted?: boolean;
  is_deactivated?: boolean;
  deleted_at?: string | null;
  deactivated_at?: string | null;
  deletion_requested_at?: string | null;
  reactivated_at?: string | null;
  retention_reason?: string | null;
  retargeting_retained?: boolean;
  created_at?: string | null;
  last_activity_at?: string | null;
  /** Number of projects owned by this user (admin list/reporting). */
  total_projects?: number;
};

export type AdminUserDetails = {
  user: AdminUserPublic;
  stats: {
    total_projects: number;
    total_articles: number;
    total_pending_articles: number;
    total_active_articles: number;
    total_draft_articles: number;
    total_published_articles: number;
  };
};

export type AdminWorkspaceResponse = {
  user_id: string;
  email: string;
  projects: { id: string; name: string; website_url?: string | null; article_count: number }[];
  articles: {
    id: string;
    project_id: string;
    project_name: string;
    title: string;
    status: string;
    created_at?: string | null;
    wp_link?: string | null;
  }[];
  articles_truncated: boolean;
};

export type ResearchIdeaRow = {
  id: string;
  title: string;
  focus_keyphrase: string;
  keywords: string[];
  score?: number | null;
  rationale?: string | null;
};

export type ResearchIdeasResponse = {
  ok: boolean;
  ideas: ResearchIdeaRow[];
  keyword_analysis?: Record<string, unknown> | null;
  scraped_queries?: string[];
  used_history_count?: number;
};

export type PlanPublic = {
  key: string;
  name?: string | null;
  is_default?: boolean | null;
  cost_monthly?: number | null;
  max_projects?: number | null;
  max_articles?: number | null;
  max_articles_per_day?: number | null;
  max_articles_per_month?: number | null;
  max_writing_prompts?: number | null;
  writing_prompt_char_limit?: number | null;
  max_image_prompts?: number | null;
  image_prompt_char_limit?: number | null;
  allow_scheduling?: boolean | null;
  max_scheduled_per_month?: number | null;
  allow_export?: boolean | null;
  max_export_per_month?: number | null;
  allow_bulk_upload?: boolean | null;
  max_cluster_plans_per_month?: number | null;
  max_custom_research_per_month?: number | null;
  max_context_links?: number | null;
  max_article_image_regenerations?: number | null;
};

export type MonthlyFeatureLimit = {
  feature: string;
  unlimited: boolean;
  enabled?: boolean;
  month_used: number;
  month_limit: number | null;
  month_remaining: number | null;
  month_key?: string;
  month_reset_at?: string | null;
};

export type CountFeatureLimit = {
  feature: string;
  unlimited: boolean;
  used: number;
  limit: number | null;
  remaining: number | null;
  renews_at?: string | null;
};

/**
 * Prompt-style feature limit. Combines a per-project count cap and a
 * per-prompt character cap so the UI can show "X / Y prompts used" plus a
 * live character counter inside the editor.
 */
export type PromptFeatureLimit = {
  feature: string;
  unlimited: boolean;
  used: number;
  limit: number | null;
  remaining: number | null;
  char_limit: number | null;
};

export type ProjectFeatureLimits = {
  plan_key: string;
  is_admin: boolean;
  cluster_plans: MonthlyFeatureLimit;
  custom_research: MonthlyFeatureLimit;
  scheduled_articles?: MonthlyFeatureLimit;
  export_articles?: MonthlyFeatureLimit;
  context_links: CountFeatureLimit;
  writing_prompts?: PromptFeatureLimit;
  image_prompts?: PromptFeatureLimit;
};

export type ProfilePublic = {
  id: string;
  email: string;
  full_name?: string | null;
  phone?: string | null;
  timezone?: string | null;
  subscription_type?: string | null;
  account_status?: string | null;
  created_at?: string | null;
};

export type ProjectPublic = {
  id: string;
  owner_user_id: string;
  name: string;
  website_url?: string | null;
  /**
   * Legacy plain-text representations. Always populated by the backend —
   * if the structured fields below are set the backend rebuilds these from
   * them so downstream LLM consumers keep working unchanged.
   */
  brand_identity?: string | null;
  niche_identifier?: string | null;
  /** Structured Brand identity inputs (Project Settings). */
  brand_voice?: string | null;
  brand_tones?: string[] | null;
  brand_rules?: string | null;
  /** Structured Niche identifier inputs (Project Settings). */
  niche_topic?: string | null;
  audience?: string[] | null;
  /** ISO-3166-1 alpha-2 codes (uppercase). */
  target_countries?: string[] | null;
  /** ``true`` means "every country" (global targeting). When set, ``target_countries`` is ignored. */
  target_countries_all?: boolean | null;
  target_cities?: string[] | null;
  /** ``true`` means "every city in the listed countries"; ignores the cities list. */
  target_cities_all?: boolean | null;
};

export type ProjectSettings = {
  id: string;
  name: string;
  website_url?: string | null;
  wp_site_url?: string | null;
  wp_username?: string | null;
  wp_app_password_set: boolean;
  wp_app_password?: string | null;
  /** Last-known WordPress verification snapshot (server-recorded). */
  wp_verified_at?: string | null;
  wp_verified_status?: string | null;
  wp_verified_message?: string | null;
  /**
   * Connector plugin verification snapshot (server-recorded). One of:
   *  - "active"     plugin responded to /ping with 200
   *  - "installed"  REST namespace registered, /ping unreachable
   *  - "capability" plugin installed but WP user lacks edit_posts
   *  - "missing"    no Riviso REST namespace found on the site
   *  - "unknown"    /wp-json/ couldn't be reached
   */
  wp_plugin_status?: string | null;
  wp_plugin_message?: string | null;
  plugin_download_url: string;
  default_wp_rest_base?: string | null;
  default_wp_status?: string | null;
  default_wp_category_ids?: number[];
  gsc_property_url?: string | null;
  gsc_index_on_publish?: boolean;
};

export type GscStatus = {
  configured: boolean;
  connected: boolean;
  email?: string | null;
};

export type ProjectGscStatus = {
  configured: boolean;
  connected: boolean;
  email?: string | null;
  connected_at?: string | null;
  property_url?: string | null;
  index_on_publish: boolean;
};

export type GscSite = {
  siteUrl: string;
  permissionLevel?: string;
};

/**
 * One sitemap registered on a Search Console property. Mirrors the Sitemaps API
 * ``WmxSitemap`` resource, flattened to the fields the UI actually renders.
 */
export type GscSitemap = {
  path: string;
  last_submitted?: string;
  last_downloaded?: string;
  is_pending?: boolean;
  is_sitemaps_index?: boolean;
  type?: string;
  warnings?: number;
  errors?: number;
  submitted_urls?: string;
  indexed_urls?: string;
};

export type GscSitemapList = {
  property_url?: string | null;
  suggested_sitemap_url?: string | null;
  sitemaps: GscSitemap[];
};

/* --- Feature 1: GSC ROI Dashboard ---------------------------------------- */

export type GscAnalyticsSeriesPoint = {
  date: string; // YYYY-MM-DD
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
};

export type GscAnalyticsTotals = {
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  days_with_data: number;
};

export type GscAnalyticsTopPage = {
  url: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
};

export type GscAnalyticsMarker = {
  date: string; // YYYY-MM-DD
  article_id: string;
  title: string;
  url: string;
};

export type GscAnalyticsResponse = {
  property_url?: string | null;
  range: { start_date: string; end_date: string; days: number };
  totals: GscAnalyticsTotals;
  series: GscAnalyticsSeriesPoint[];
  top_pages: GscAnalyticsTopPage[];
  markers: GscAnalyticsMarker[];
};

/* --- Feature 2: Topic Cluster (foundations) ------------------------------ */

export type TopicClusterPillar = {
  id: string;
  title: string;
  intent?: string;
  keywords?: string[];
  outline?: string[];
  imported_article_id?: string;
};

export type TopicClusterTopic = {
  id: string;
  title: string;
  intent?: string;
  keywords?: string[];
  imported_article_id?: string;
};

export type TopicClusterSerpRow = { title: string; url: string; snippet?: string };
export type TopicClusterSerpSummary = {
  query: string;
  gl: string;
  hl: string;
  fetched_at: number;
  result_count: number;
  results: TopicClusterSerpRow[];
};

export type TopicClusterGenError = { topic_id: string; message: string };

export type TopicCluster = {
  id: string;
  project_id: string;
  owner_user_id?: string;
  seed_intent: string;
  country_code: string;
  tone: string;
  status: string;
  pillar: TopicClusterPillar;
  clusters: TopicClusterTopic[];
  created_at?: string;
  updated_at?: string;
  serp_summary?: TopicClusterSerpSummary;
  generation_errors?: TopicClusterGenError[];
};

export type TopicClusterGenerateAllResponse = {
  ok: boolean;
  cluster: TopicCluster;
  errors: TopicClusterGenError[];
};

export type TopicClusterImportResponse = {
  ok: boolean;
  cluster: TopicCluster;
  errors: TopicClusterGenError[];
  imported_count: number;
  scheduled_count: number;
};

/* --- Article quota (per-user, plan-aware) --------------------------------- */

export type ArticleQuota = {
  plan_key: string;
  is_admin: boolean;
  unlimited: boolean;
  /** ``null`` ⇒ unlimited; otherwise the largest batch size the user can consume right now. */
  max_can_consume_now: number | null;
  day_used: number;
  day_limit: number | null;
  day_remaining: number | null;
  day_reset_at?: string | null;
  month_used: number;
  month_limit: number | null;
  month_remaining: number | null;
  month_reset_at?: string | null;
};

/* --- Cluster Validation: existence & intent ------------------------------ */

export type ClusterValidationStatus = "new" | "similar" | "duplicate";

export type ClusterValidationItemPayload = {
  temp_id: string;
  title: string;
  focus_keyphrase?: string;
  keywords?: string[];
};

export type ClusterValidationOutcome = {
  status: ClusterValidationStatus;
  reason: string;
  existing_url: string | null;
  existing_article_id: string | null;
  similarity: number | null;
};

export type ClusterValidationResponse = {
  results: Record<string, ClusterValidationOutcome>;
  cache_age_seconds: number | null;
  cache_refresh_started: boolean;
  embedding_used: boolean;
  elapsed_ms: number;
};

/* --- Feature 3: Site Map -------------------------------------------------- */

export type SiteMapEntry = {
  id: string;
  project_id: string;
  post_url: string;
  post_title: string;
  focus_keyphrase: string;
  focus_keywords: string[];
  post_id: string;
  post_modified_at: string;
  fetched_at: string;
};

export type SiteMapListResponse = {
  count: number;
  entries: SiteMapEntry[];
  wp_site_url?: string | null;
};

export type SiteMapSyncResponse = {
  count: number;
  truncated: boolean;
  fetched_at: string;
};

/**
 * Response from POST /api/projects/:id/articles/:articleId/gsc/request-indexing.
 *
 * The backend tries the Google Indexing API + sitemap ping, then always returns the
 * GSC URL Inspection deep link so the UI can hand off to the manual "Request Indexing"
 * button (which is the only way to make the request show up in URL Inspection history).
 */
export type RequestIndexingResponse = {
  ok: boolean;
  gsc_status?: string | null;
  gsc_inspection_requested_at?: string | null;
  gsc_inspection_url?: string | null;
  indexing_api?: { attempted: boolean; ok: boolean; error?: string };
  sitemap_ping?: { attempted: boolean; ok: boolean; sitemap_url?: string };
  inspect_panel_url?: string | null;
  note?: string | null;
};

export type GscIndexingStatus = {
  url: string;
  site_url: string;
  verdict?: string;
  coverage_state?: string;
  robots_txt_state?: string;
  indexing_state?: string;
  last_crawl_time?: string;
  page_fetch_state?: string;
  google_canonical?: string;
  user_canonical?: string;
  referring_urls?: string[];
  fetched_at?: string;
  raw?: Record<string, unknown> | null;
};

export type WordpressVerifyResponse = {
  ok: boolean;
  status: string;
  message: string;
};

export type WordpressPostType = {
  rest_base: string;
  name: string;
  taxonomies: string[];
};

export type WordpressCategory = {
  id: number;
  name: string;
};

export type ScheduledJobPublic = {
  id: string;
  project_id: string;
  article_id: string;
  run_at: string;
  post_type: string;
  wp_status: string;
  category_ids: number[];
  writing_prompt_id?: string | null;
  image_prompt_id?: string | null;
  generate_image?: boolean;
  state: string;
  last_error?: string | null;
  attempts: number;
  last_attempt_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  wp_post_id?: string | null;
  wp_link?: string | null;
};

export type ArticlePublic = {
  id: string;
  project_id: string;
  title: string;
  status: string;
  created_at?: string | null;
  updated_at?: string | null;
  posted_at?: string | null;
  keywords?: string[];
  focus_keyphrase?: string | null;
  wp_scheduled_at?: string | null;
  wp_schedule_error?: string | null;
  wp_link?: string | null;
  gsc_status?: string | null;
  hasBody?: boolean | null;
  monitor_status?: string | null; // Feature 4: "fresh" | "stale" | "unknown" | ""
  monitor_last_checked_at?: string | null;
  internal_links_count?: number | null; // Feature 3
};

export type ArticleListPage = {
  items: ArticlePublic[];
  total: number;
  page: number;
  per_page: number;
};

export type ArticleTitleRef = {
  id: string;
  title: string;
};

export type ArticleListQuery = {
  page?: number;
  per_page?: number;
  q?: string;
  status?: string;
  date_from?: string;
  date_to?: string;
  sort?: "asc" | "desc";
};

export type BulkUploadRow = {
  title: string;
  focus_keyphrase?: string | null;
  keywords?: string[];
};

export type ArticleDetail = ArticlePublic & {
  article: string;
  meta_title?: string | null;
  meta_description?: string | null;
  image_url?: string | null;
  featured_image_regeneration_count?: number;
  featured_image_regeneration_limit?: number | null;
  featured_image_regeneration_remaining?: number | null;
  featured_image_regeneration_unlimited?: boolean;
};

export type PromptItem = {
  id: string;
  name: string;
  text: string;
};

export type PromptListResponse = {
  items: PromptItem[];
  default_id?: string | null;
};

export type ContextLinkItem = {
  id: string;
  label: string;
  url: string;
};

const ENV_API_BASE_URL = (process.env.NEXT_PUBLIC_API_BASE_URL || "").trim().replace(/\/+$/, "");

export function getApiBaseUrl(): string {
  if (ENV_API_BASE_URL) return ENV_API_BASE_URL;
  // SSR / build-time fallback
  if (typeof window === "undefined") return "http://127.0.0.1:8000";

  const host = (window.location.hostname || "").trim() || "127.0.0.1";
  const isLocal = host === "localhost" || host === "127.0.0.1";

  // Production browsers must not default to :8000 — that host/port is rarely reachable on the public
  // internet (firewall) and causes net::ERR_CONNECTION_TIMED_OUT. Assume API is reverse-proxied at the
  // same origin (e.g. https://riviso.com/api/... on port 443). Override with NEXT_PUBLIC_API_BASE_URL
  // when the API lives on another host (e.g. https://api.example.com).
  if (!isLocal) {
    return `${window.location.protocol}//${window.location.host}`;
  }

  const targetHost = host === "localhost" ? "127.0.0.1" : host;
  const proto = window.location.protocol === "https:" ? "https:" : "http:";
  return `${proto}//${targetHost}:8000`;
}

/** Same-origin path for the WordPress connector ZIP (proxied to the API in Next.js). */
export function getWordpressPluginDownloadPath(): string {
  return "/api/wordpress/plugin/download";
}

/** Download the Riviso WordPress connector ZIP (valid package for Plugins → Upload). */
export async function downloadWordpressPlugin(): Promise<void> {
  if (typeof window === "undefined") {
    throw new Error("Plugin download is only available in the browser.");
  }
  const res = await fetch(getWordpressPluginDownloadPath(), { method: "GET", cache: "no-store" });
  if (!res.ok) {
    let detail = `Plugin download failed (${res.status})`;
    try {
      const body = (await res.json()) as { detail?: string };
      if (body?.detail) detail = body.detail;
    } catch {
      /* not JSON */
    }
    throw new Error(detail);
  }
  const blob = await res.blob();
  if (!blob.size) {
    throw new Error("Plugin download was empty. Check that the API server is running.");
  }
  const cd = res.headers.get("content-disposition") || "";
  let filename = "riviso-content-operations.zip";
  const quoted = /filename="([^"]+)"/i.exec(cd);
  const plain = /filename=([^;\s]+)/i.exec(cd);
  if (quoted?.[1]) filename = quoted[1];
  else if (plain?.[1]) filename = plain[1].replace(/"/g, "");
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(objectUrl);
}

function apiUrl(path: string) {
  const API_BASE_URL = getApiBaseUrl();
  if (!API_BASE_URL) return path;
  if (/^https?:\/\//.test(path)) return path;
  return `${API_BASE_URL}${path.startsWith("/") ? "" : "/"}${path}`;
}

const TOKEN_KEY = "aa_access_token";
const REFRESH_KEY = "aa_refresh_token";

export function getAccessToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setAccessToken(token: string) {
  window.localStorage.setItem(TOKEN_KEY, token);
}

export function clearAccessToken() {
  window.localStorage.removeItem(TOKEN_KEY);
}

export function getRefreshToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(REFRESH_KEY);
}

export function setRefreshToken(token: string) {
  window.localStorage.setItem(REFRESH_KEY, token);
}

export function clearRefreshToken() {
  window.localStorage.removeItem(REFRESH_KEY);
}

export function clearAuth() {
  clearAccessToken();
  clearRefreshToken();
}

function emitGlobalLoading(delta: number) {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new CustomEvent("aa:loading", { detail: { delta } }));
  } catch {
    // ignore
  }
}

/** Structured FastAPI `HTTPException` payload when present (e.g. duplicate title responses). */
export class ApiError extends Error {
  readonly status: number;
  readonly detail: unknown;

  constructor(message: string, status: number, detail?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }
}

/**
 * Convert a Pydantic 422 validation `detail` array into a short, human
 * summary suitable for showing to end users.
 *
 * The raw shape FastAPI returns is:
 * ```
 * [{ type: "too_long", loc: ["body","target_countries"],
 *    msg: "List should have at most 50 items …", input: [...] }, ...]
 * ```
 * We pull out a friendly field name (the last useful entry in `loc`),
 * keep only the human-meaningful `msg`, and join the first few items so
 * the message stays readable when several fields fail together.
 *
 * Returns an empty string if the detail isn't recognisably a 422 array,
 * letting the caller fall back to whatever message it already has.
 */
function formatPydantic422(detail: unknown): string {
  if (!Array.isArray(detail) || detail.length === 0) return "";
  const lines: string[] = [];
  for (const item of detail) {
    if (!item || typeof item !== "object") continue;
    const rec = item as { loc?: unknown; msg?: unknown };
    const msg = typeof rec.msg === "string" ? rec.msg.trim() : "";
    if (!msg) continue;
    let field = "";
    if (Array.isArray(rec.loc)) {
      // Drop a leading "body" / "query" / "path" segment because that's
      // useless context for humans, then take the last string segment as
      // the human-readable field name.
      const segments = rec.loc
        .filter((x): x is string | number => typeof x === "string" || typeof x === "number")
        .map((x) => String(x))
        .filter((x) => x !== "body" && x !== "query" && x !== "path");
      if (segments.length > 0) {
        field = segments.join(" → ");
      }
    }
    lines.push(field ? `${field}: ${msg}` : msg);
    if (lines.length >= 4) break;
  }
  if (lines.length === 0) return "";
  if (detail.length > lines.length) {
    lines.push(`… and ${detail.length - lines.length} more.`);
  }
  return lines.join("\n");
}

/** Default budget for typical REST calls (lists, CRUD, login). */
export const DEFAULT_API_TIMEOUT_MS = 120_000;
/** OpenAI text+image generation, WordPress publish with upload, schedule-with-generation, large bulk import. */
export const LONG_API_TIMEOUT_MS = 600_000;
/** Token refresh must stay snappy so hanging refresh does not block the UI forever. */
const AUTH_REFRESH_TIMEOUT_MS = 45_000;
/** Non-critical metadata (prompts/WP types/categories) should not block UX for long. */
const META_API_TIMEOUT_MS = 15_000;

type CacheEntry<T> = { at: number; value: T } | { at: number; inflight: Promise<T> };
function cacheGet<T>(m: Map<string, CacheEntry<T>>, key: string, ttlMs: number): T | Promise<T> | null {
  const e = m.get(key);
  if (!e) return null;
  if (Date.now() - e.at > ttlMs) {
    m.delete(key);
    return null;
  }
  return "inflight" in e ? e.inflight : e.value;
}
function cacheSetInflight<T>(m: Map<string, CacheEntry<T>>, key: string, p: Promise<T>) {
  m.set(key, { at: Date.now(), inflight: p });
}
function cacheSetValue<T>(m: Map<string, CacheEntry<T>>, key: string, v: T) {
  m.set(key, { at: Date.now(), value: v });
}

const _cacheWritingPrompts = new Map<string, CacheEntry<PromptListResponse>>();
const _cacheImagePrompts = new Map<string, CacheEntry<PromptListResponse>>();
const _cacheWpTypes = new Map<string, CacheEntry<WordpressPostType[]>>();
const _cacheWpCats = new Map<string, CacheEntry<WordpressCategory[]>>();
const _cacheProjectSettings = new Map<string, CacheEntry<ProjectSettings>>();

function createTimeoutSignal(ms: number): AbortSignal {
  const AT = AbortSignal as unknown as { timeout?: (n: number) => AbortSignal };
  if (typeof AT.timeout === "function") {
    return AT.timeout(ms);
  }
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

function mergeAbortSignals(a: AbortSignal, b: AbortSignal | null | undefined): AbortSignal {
  if (!b) return a;
  if (a.aborted || b.aborted) {
    const c = new AbortController();
    c.abort();
    return c.signal;
  }
  const c = new AbortController();
  const onAbort = () => c.abort();
  a.addEventListener("abort", onAbort, { once: true });
  b.addEventListener("abort", onAbort, { once: true });
  return c.signal;
}

function isAbortError(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  return (e as Error).name === "AbortError";
}

export type ApiFetchOptions = {
  /** Override default (see DEFAULT_API_TIMEOUT_MS). */
  timeoutMs?: number;
};

async function parseOkJson<T>(res: Response): Promise<T> {
  if (res.status === 204 || res.status === 205) {
    return undefined as T;
  }
  const text = await res.text();
  if (!text.trim()) {
    return undefined as T;
  }
  return JSON.parse(text) as T;
}

/**
 * Authenticated JSON fetch with timeout, optional 401 refresh, and global loading counter.
 * Long-running routes should pass ``timeoutMs: LONG_API_TIMEOUT_MS`` via the third argument.
 */
async function apiFetch<T>(path: string, init?: RequestInit, opts?: ApiFetchOptions): Promise<T> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_API_TIMEOUT_MS;
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json");
  const token = getAccessToken();
  if (token) headers.set("authorization", `Bearer ${token}`);

  emitGlobalLoading(+1);
  try {
    const doFetch = async (h: Headers) => {
      const signal = mergeAbortSignals(createTimeoutSignal(timeoutMs), init?.signal);
      return fetch(apiUrl(path), { ...init, headers: h, credentials: "include", signal });
    };

    let res: Response;
    try {
      res = await doFetch(headers);
    } catch (e) {
      if (isAbortError(e)) {
        throw new ApiError(
          `Request timed out after ${Math.round(timeoutMs / 1000)}s. Check your connection, or increase proxy timeouts (nginx) for long tasks.`,
          408,
          { code: "client_timeout", timeoutMs },
        );
      }
      throw e;
    }

    if (
      res.status === 401 &&
      path !== "/api/auth/login" &&
      path !== "/api/auth/register" &&
      path !== "/api/auth/reactivate" &&
      path !== "/api/auth/refresh"
    ) {
      const rt = getRefreshToken();
      if (rt) {
        try {
          const refreshSignal = createTimeoutSignal(AUTH_REFRESH_TIMEOUT_MS);
          const refreshed = await fetch(apiUrl("/api/auth/refresh"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ refresh_token: rt }),
            credentials: "include",
            signal: refreshSignal,
          });
          if (refreshed.ok) {
            const tokens = (await refreshed.json()) as TokenPair;
            if (tokens?.access_token) setAccessToken(tokens.access_token);
            if (tokens?.refresh_token) setRefreshToken(tokens.refresh_token);
            const headers2 = new Headers(init?.headers);
            headers2.set("content-type", "application/json");
            const token2 = getAccessToken();
            if (token2) headers2.set("authorization", `Bearer ${token2}`);
            try {
              res = await doFetch(headers2);
            } catch (e) {
              if (isAbortError(e)) {
                throw new ApiError(
                  `Request timed out after ${Math.round(timeoutMs / 1000)}s. Check your connection, or increase proxy timeouts (nginx) for long tasks.`,
                  408,
                  { code: "client_timeout", timeoutMs },
                );
              }
              throw e;
            }
          }
        } catch (e) {
          if (e instanceof ApiError) throw e;
          // Fall through to normal error handling
        }
      }
    }

    if (!res.ok) {
      const text = await res.text();
      let detail: unknown;
      let msg = text || `${res.status} ${res.statusText}`;
      try {
        const parsed = JSON.parse(text) as { detail?: unknown };
        if (parsed && typeof parsed === "object" && "detail" in parsed) {
          detail = parsed.detail;
          if (typeof detail === "string") {
            msg = detail;
          } else if (detail && typeof detail === "object" && detail !== null && "message" in detail) {
            const m = (detail as { message?: unknown }).message;
            if (typeof m === "string" && m.trim()) msg = m;
          } else if (Array.isArray(detail)) {
            // FastAPI / Pydantic 422 validation errors come back as a list
            // of `{type, loc, msg, input}` items. Dumping that JSON directly
            // to the user (as we used to) is hostile — translate it into a
            // short, action-oriented summary instead.
            const friendly = formatPydantic422(detail);
            if (friendly) msg = friendly;
          }
        }
      } catch {
        // use raw text as message
      }
      throw new ApiError(msg, res.status, detail);
    }
    return parseOkJson<T>(res);
  } finally {
    emitGlobalLoading(-1);
  }
}

/** Form upload or non-JSON body: same timeout and loading behavior as apiFetch. */
async function apiFetchRaw(path: string, init: RequestInit, opts?: ApiFetchOptions): Promise<Response> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_API_TIMEOUT_MS;
  const token = getAccessToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  const signal = mergeAbortSignals(createTimeoutSignal(timeoutMs), init.signal);

  emitGlobalLoading(+1);
  try {
    try {
      return await fetch(apiUrl(path), { ...init, headers, credentials: "include", signal });
    } catch (e) {
      if (isAbortError(e)) {
        throw new ApiError(
          `Request timed out after ${Math.round(timeoutMs / 1000)}s. Try again or increase proxy read timeouts for large uploads.`,
          408,
          { code: "client_timeout", timeoutMs },
        );
      }
      throw e;
    }
  } finally {
    emitGlobalLoading(-1);
  }
}

export const api = {
  async login(email: string, password: string) {
    return apiFetch<TokenPair>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
  },
  async refresh(refresh_token: string) {
    return apiFetch<TokenPair>("/api/auth/refresh", {
      method: "POST",
      body: JSON.stringify({ refresh_token }),
    });
  },
  async register(email: string, password: string) {
    return apiFetch<TokenPair>("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
  },
  async reactivateAccount(email: string, password: string) {
    return apiFetch<TokenPair>("/api/auth/reactivate", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
  },
  async me() {
    return apiFetch<UserPublic>("/api/auth/me");
  },
  async profileMe() {
    return apiFetch<ProfilePublic>("/api/profile/me");
  },
  async updateProfileMe(patch: Partial<{ full_name: string; phone: string; timezone: string }>) {
    return apiFetch<ProfilePublic>("/api/profile/me", { method: "PATCH", body: JSON.stringify(patch) });
  },
  async gscStatus() {
    return apiFetch<GscStatus>("/api/gsc/status");
  },
  async gscConnectUrl() {
    return apiFetch<{ url: string }>("/api/gsc/connect-url");
  },
  async gscListSites() {
    return apiFetch<GscSite[]>("/api/gsc/sites");
  },
  async listProjects() {
    return apiFetch<ProjectPublic[]>("/api/projects");
  },
  async createProject(name: string, website_url?: string) {
    return apiFetch<ProjectPublic>("/api/projects", {
      method: "POST",
      body: JSON.stringify({ name, website_url: website_url || null }),
    });
  },
  async getProject(projectId: string) {
    return apiFetch<ProjectPublic>(`/api/projects/${projectId}`);
  },
  async updateProject(
    projectId: string,
    patch: Partial<{
      name: string;
      website_url: string | null;
      brand_identity: string | null;
      niche_identifier: string | null;
      brand_voice: string | null;
      brand_tones: string[];
      brand_rules: string | null;
      niche_topic: string | null;
      audience: string[];
      target_countries: string[];
      target_countries_all: boolean;
      target_cities: string[];
      target_cities_all: boolean;
    }>,
  ) {
    return apiFetch<ProjectPublic>(`/api/projects/${projectId}`, { method: "PATCH", body: JSON.stringify(patch) });
  },
  async deleteProject(projectId: string) {
    await apiFetch<unknown>(`/api/projects/${projectId}`, { method: "DELETE" });
    return { ok: true as const };
  },
  async getProjectSettings(projectId: string) {
    const key = projectId;
    const cached = cacheGet(_cacheProjectSettings, key, 30_000);
    if (cached) return await cached;
    const p = apiFetch<ProjectSettings>(`/api/projects/${projectId}/settings`, undefined, { timeoutMs: META_API_TIMEOUT_MS });
    cacheSetInflight(_cacheProjectSettings, key, p);
    try {
      const v = await p;
      cacheSetValue(_cacheProjectSettings, key, v);
      return v;
    } catch (e) {
      _cacheProjectSettings.delete(key);
      throw e;
    }
  },
  async getProjectSettingsWithOpts(projectId: string, opts?: ApiFetchOptions) {
    return apiFetch<ProjectSettings>(`/api/projects/${projectId}/settings`, undefined, opts);
  },
  async updateProjectSettings(
    projectId: string,
    patch: Partial<{
      name: string;
      website_url: string;
      wp_site_url: string;
      wp_username: string;
      wp_app_password: string;
      default_wp_rest_base: string;
      default_wp_status: string;
      default_wp_category_ids: number[];
      gsc_property_url: string;
      gsc_index_on_publish: boolean;
    }>,
  ) {
    return apiFetch<ProjectSettings>(`/api/projects/${projectId}/settings`, { method: "PATCH", body: JSON.stringify(patch) });
  },
  async verifyWordpress(projectId: string, payload: Partial<{ wp_site_url: string; wp_username: string; wp_app_password: string }>) {
    return apiFetch<WordpressVerifyResponse>(
      `/api/projects/${projectId}/wordpress/verify`,
      { method: "POST", body: JSON.stringify(payload) },
      { timeoutMs: LONG_API_TIMEOUT_MS },
    );
  },
  async wordpressPostTypes(projectId: string, opts?: ApiFetchOptions) {
    const key = projectId;
    const cached = cacheGet(_cacheWpTypes, key, 60_000);
    if (cached && !opts) return await cached;
    const p = apiFetch<WordpressPostType[]>(
      `/api/projects/${projectId}/wordpress/post-types`,
      undefined,
      opts ?? { timeoutMs: META_API_TIMEOUT_MS },
    );
    if (!opts) cacheSetInflight(_cacheWpTypes, key, p);
    try {
      const v = await p;
      if (!opts) cacheSetValue(_cacheWpTypes, key, v);
      return v;
    } catch (e) {
      if (!opts) _cacheWpTypes.delete(key);
      throw e;
    }
  },
  async wordpressCategories(projectId: string, opts?: ApiFetchOptions) {
    const key = projectId;
    const cached = cacheGet(_cacheWpCats, key, 60_000);
    if (cached && !opts) return await cached;
    const p = apiFetch<WordpressCategory[]>(
      `/api/projects/${projectId}/wordpress/categories`,
      undefined,
      opts ?? { timeoutMs: META_API_TIMEOUT_MS },
    );
    if (!opts) cacheSetInflight(_cacheWpCats, key, p);
    try {
      const v = await p;
      if (!opts) cacheSetValue(_cacheWpCats, key, v);
      return v;
    } catch (e) {
      if (!opts) _cacheWpCats.delete(key);
      throw e;
    }
  },
  async listScheduledJobs(projectId: string) {
    return apiFetch<ScheduledJobPublic[]>(`/api/projects/${projectId}/scheduled-jobs`);
  },
  /** Deduped jobs + orphan article stubs — one round-trip for the Scheduled tab. */
  async listScheduledJobsBoard(projectId: string) {
    return apiFetch<ScheduledJobPublic[]>(`/api/projects/${projectId}/scheduled-jobs/board`);
  },
  async cancelScheduledJob(projectId: string, jobId: string) {
    return apiFetch<{ ok: boolean }>(`/api/projects/${projectId}/scheduled-jobs/${jobId}`, { method: "DELETE" });
  },
  async clearScheduledJobs(projectId: string) {
    return apiFetch<{ ok: boolean; deleted: number }>(`/api/projects/${projectId}/scheduled-jobs`, { method: "DELETE" });
  },
  async updateScheduledJob(
    projectId: string,
    jobId: string,
    patch: Partial<{
      run_at: string;
      post_type: string;
      wp_status: string;
      category_ids: number[];
      writing_prompt_id: string | null;
      image_prompt_id: string | null;
      generate_image: boolean;
    }>,
  ) {
    return apiFetch<ScheduledJobPublic>(`/api/projects/${projectId}/scheduled-jobs/${jobId}`, { method: "PATCH", body: JSON.stringify(patch) });
  },
  async retryScheduledJobPreparation(projectId: string, jobId: string) {
    return apiFetch<{ ok: boolean; message: string; job: ScheduledJobPublic }>(
      `/api/projects/${projectId}/scheduled-jobs/${jobId}/retry-preparation`,
      { method: "POST" },
    );
  },
  async retryAllFailedScheduledPreparations(projectId: string) {
    return apiFetch<{ ok: boolean; retried: number; message: string }>(
      `/api/projects/${projectId}/scheduled-jobs/retry-failed-preparations`,
      { method: "POST" },
    );
  },
  async listArticlesPage(projectId: string, query: ArticleListQuery = {}) {
    const sp = new URLSearchParams();
    if (query.page != null) sp.set("page", String(query.page));
    if (query.per_page != null) sp.set("per_page", String(query.per_page));
    if (query.q) sp.set("q", query.q);
    if (query.status) sp.set("status", query.status);
    if (query.date_from) sp.set("date_from", query.date_from);
    if (query.date_to) sp.set("date_to", query.date_to);
    if (query.sort) sp.set("sort", query.sort);
    const qs = sp.toString();
    return apiFetch<ArticleListPage>(`/api/projects/${projectId}/articles${qs ? `?${qs}` : ""}`);
  },
  async listArticleTitles(projectId: string) {
    return apiFetch<ArticleTitleRef[]>(`/api/projects/${projectId}/articles/titles`);
  },
  /** Fetch all pages for export (bounded). */
  async listArticlesAll(projectId: string, query: Omit<ArticleListQuery, "page" | "per_page"> = {}) {
    const per_page = 500;
    const items: ArticlePublic[] = [];
    let page = 1;
    let total = 0;
    while (page <= 50) {
      const res = await api.listArticlesPage(projectId, { ...query, page, per_page });
      total = res.total;
      items.push(...(res.items || []));
      if (items.length >= total || !(res.items || []).length) break;
      page += 1;
    }
    return items;
  },
  async consumeExportQuota(projectId: string) {
    return apiFetch<{ ok: boolean }>(`/api/projects/${projectId}/articles/export/consume`, { method: "POST" });
  },
  async createArticle(projectId: string, title: string) {
    return apiFetch<ArticlePublic>(`/api/projects/${projectId}/articles`, {
      method: "POST",
      body: JSON.stringify({ title, keywords: [] }),
    });
  },
  async bulkDeleteArticles(projectId: string, article_ids: string[]) {
    return apiFetch<{ ok: true; deleted: number }>(`/api/projects/${projectId}/articles/bulk`, {
      method: "POST",
      body: JSON.stringify({ action: "delete", article_ids }),
    });
  },
  async bulkChangeStatus(projectId: string, article_ids: string[], new_status: "pending" | "draft" | "published") {
    return apiFetch<{ ok: true; updated: number; new_status: string }>(`/api/projects/${projectId}/articles/bulk`, {
      method: "POST",
      body: JSON.stringify({ action: "change_status", article_ids, new_status }),
    });
  },

  async bulkUploadArticles(
    projectId: string,
    rows: BulkUploadRow[],
    opts?: { skipProjectDuplicateConflicts?: boolean },
  ) {
    return apiFetch<{
      ok: true;
      created: number;
      skipped: number;
      articles: ArticlePublic[];
      duplicate_titles?: string[];
      duplicate_rows_dropped?: number;
      project_skipped_as_duplicates?: number;
    }>(
      `/api/projects/${projectId}/articles/bulk-upload`,
      {
        method: "POST",
        body: JSON.stringify({
          rows,
          skip_project_duplicate_conflicts: opts?.skipProjectDuplicateConflicts === true,
        }),
      },
      { timeoutMs: LONG_API_TIMEOUT_MS },
    );
  },

  async getArticle(projectId: string, articleId: string) {
    return apiFetch<ArticleDetail>(`/api/projects/${projectId}/articles/${articleId}`);
  },

  async updateArticle(
    projectId: string,
    articleId: string,
    patch: Partial<{
      title: string;
      keywords: string[];
      focus_keyphrase: string;
      article: string;
      meta_title: string;
      meta_description: string;
    }>,
  ) {
    return apiFetch<ArticleDetail>(`/api/projects/${projectId}/articles/${articleId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  },

  async listWritingPrompts(projectId: string, opts?: ApiFetchOptions) {
    const key = projectId;
    const cached = cacheGet(_cacheWritingPrompts, key, 30_000);
    if (cached && !opts) return await cached;
    const p = apiFetch<PromptListResponse>(`/api/projects/${projectId}/prompts`, undefined, opts ?? { timeoutMs: META_API_TIMEOUT_MS });
    if (!opts) cacheSetInflight(_cacheWritingPrompts, key, p);
    try {
      const v = await p;
      if (!opts) cacheSetValue(_cacheWritingPrompts, key, v);
      return v;
    } catch (e) {
      if (!opts) _cacheWritingPrompts.delete(key);
      throw e;
    }
  },

  async setDefaultWritingPrompt(projectId: string, id: string) {
    const out = await apiFetch<{ ok: true; default_id: string }>(`/api/projects/${projectId}/prompts/default`, {
      method: "POST",
      body: JSON.stringify({ id }),
    });
    _cacheWritingPrompts.delete(projectId);
    return out;
  },

  async createWritingPrompt(projectId: string, payload: { name: string; text: string }) {
    const out = await apiFetch<PromptItem>(`/api/projects/${projectId}/prompts`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    _cacheWritingPrompts.delete(projectId);
    return out;
  },

  async updateWritingPrompt(projectId: string, promptId: string, payload: Partial<{ name: string; text: string }>) {
    const out = await apiFetch<PromptItem>(`/api/projects/${projectId}/prompts/${promptId}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
    _cacheWritingPrompts.delete(projectId);
    return out;
  },

  async deleteWritingPrompt(projectId: string, promptId: string) {
    await apiFetch<unknown>(`/api/projects/${projectId}/prompts/${promptId}`, { method: "DELETE" });
    _cacheWritingPrompts.delete(projectId);
    return { ok: true as const };
  },

  async listImagePrompts(projectId: string, opts?: ApiFetchOptions) {
    const key = projectId;
    const cached = cacheGet(_cacheImagePrompts, key, 30_000);
    if (cached && !opts) return await cached;
    const p = apiFetch<PromptListResponse>(`/api/projects/${projectId}/image-prompts`, undefined, opts ?? { timeoutMs: META_API_TIMEOUT_MS });
    if (!opts) cacheSetInflight(_cacheImagePrompts, key, p);
    try {
      const v = await p;
      if (!opts) cacheSetValue(_cacheImagePrompts, key, v);
      return v;
    } catch (e) {
      if (!opts) _cacheImagePrompts.delete(key);
      throw e;
    }
  },

  async setDefaultImagePrompt(projectId: string, id: string) {
    const out = await apiFetch<{ ok: true; default_id: string }>(`/api/projects/${projectId}/image-prompts/default`, {
      method: "POST",
      body: JSON.stringify({ id }),
    });
    _cacheImagePrompts.delete(projectId);
    return out;
  },

  async createImagePrompt(projectId: string, payload: { name: string; text: string }) {
    const out = await apiFetch<PromptItem>(`/api/projects/${projectId}/image-prompts`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    _cacheImagePrompts.delete(projectId);
    return out;
  },

  async updateImagePrompt(projectId: string, promptId: string, payload: Partial<{ name: string; text: string }>) {
    const out = await apiFetch<PromptItem>(`/api/projects/${projectId}/image-prompts/${promptId}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
    _cacheImagePrompts.delete(projectId);
    return out;
  },

  async deleteImagePrompt(projectId: string, promptId: string) {
    await apiFetch<unknown>(`/api/projects/${projectId}/image-prompts/${promptId}`, { method: "DELETE" });
    _cacheImagePrompts.delete(projectId);
    return { ok: true as const };
  },

  // Context links
  async listContextLinks(projectId: string) {
    return apiFetch<ContextLinkItem[]>(`/api/projects/${projectId}/context-links`);
  },
  async createContextLink(projectId: string, payload: { label: string; url: string }) {
    return apiFetch<ContextLinkItem>(`/api/projects/${projectId}/context-links`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },
  async updateContextLink(projectId: string, linkId: string, payload: Partial<{ label: string; url: string }>) {
    return apiFetch<ContextLinkItem>(`/api/projects/${projectId}/context-links/${linkId}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
  },
  async deleteContextLink(projectId: string, linkId: string) {
    await apiFetch<unknown>(`/api/projects/${projectId}/context-links/${linkId}`, { method: "DELETE" });
    return { ok: true as const };
  },

  async generateArticle(
    projectId: string,
    articleId: string,
    payload: {
      writing_prompt_id?: string | null;
      image_prompt_id?: string | null;
      focus_keyphrase?: string | null;
      generate_image?: boolean;
    },
  ) {
    return apiFetch<{
      ok: boolean;
      status: string;
      message: string;
      requested?: unknown;
      resolved?: unknown;
      generated?: {
        article?: string;
        meta_title?: string;
        meta_description?: string;
        image_url?: string | null;
      };
    }>(
      `/api/projects/${projectId}/articles/${articleId}/generate`,
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
      { timeoutMs: LONG_API_TIMEOUT_MS },
    );
  },

  async regenerateArticleImage(
    projectId: string,
    articleId: string,
    payload: { image_prompt_id?: string | null },
  ) {
    return apiFetch<{
      ok: boolean;
      status: string;
      message: string;
      image_url?: string | null;
      usage?: {
        used: number;
        limit: number | null;
        remaining: number | null;
        unlimited: boolean;
      };
    }>(
      `/api/projects/${projectId}/articles/${articleId}/regenerate-image`,
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
      { timeoutMs: LONG_API_TIMEOUT_MS },
    );
  },

  async scheduleArticle(
    projectId: string,
    articleId: string,
    payload: {
      wp_scheduled_at: string;
      wp_status: "draft" | "publish";
      post_type: string;
      writing_prompt_id?: string | null;
      image_prompt_id?: string | null;
      generate_image?: boolean;
    },
  ) {
    return apiFetch<{ ok: boolean; status: string; message: string; wp_scheduled_at?: string; post_type?: string; wp_status?: string }>(
      `/api/projects/${projectId}/articles/${articleId}/schedule`,
      { method: "POST", body: JSON.stringify(payload) },
      { timeoutMs: LONG_API_TIMEOUT_MS },
    );
  },

  async bulkScheduleArticles(
    projectId: string,
    payload: {
      items: Array<{ article_id: string; wp_scheduled_at: string }>;
      cadence?: "manual" | "weekly" | "monthly";
      wp_status: "draft" | "publish";
      post_type: string;
      writing_prompt_id?: string | null;
      image_prompt_id?: string | null;
      generate_image?: boolean;
    },
  ) {
    return apiFetch<{
      ok: boolean;
      scheduled: number;
      failed: Array<{ article_id: string; error: string }>;
    }>(`/api/projects/${projectId}/articles/bulk-schedule`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  async publishArticleToLiveSite(
    projectId: string,
    articleId: string,
    payload: { image_file?: File | null; post_type: string; wp_status: "draft" | "publish"; category_ids: number[] },
  ) {
    const fd = new FormData();
    if (payload.image_file) fd.set("image_file", payload.image_file);
    fd.set("post_type", payload.post_type);
    fd.set("wp_status", payload.wp_status);
    fd.set("category_ids", payload.category_ids.join(","));
    const res = await apiFetchRaw(
      `/api/projects/${projectId}/articles/${articleId}/publish`,
      { method: "POST", body: fd },
      { timeoutMs: LONG_API_TIMEOUT_MS },
    );
    if (!res.ok) {
      const text = await res.text();
      let msg = text || `${res.status} ${res.statusText}`;
      try {
        const parsed = JSON.parse(text) as { detail?: unknown };
        if (parsed && typeof parsed === "object" && "detail" in parsed) {
          const d = parsed.detail;
          if (typeof d === "string") msg = d;
          else if (d && typeof d === "object" && d !== null && "message" in d && typeof (d as { message?: unknown }).message === "string") {
            msg = (d as { message: string }).message;
          }
        }
      } catch {
        // keep msg
      }
      throw new ApiError(msg, res.status);
    }
    return (await res.json()) as {
      ok: boolean;
      status: string;
      message: string;
      wp_post_id?: number;
      wp_link?: string | null;
    };
  },

  async requestIndexing(projectId: string, articleId: string) {
    return apiFetch<RequestIndexingResponse>(
      `/api/projects/${projectId}/articles/${articleId}/gsc/request-indexing`,
      { method: "POST" },
    );
  },
  async checkArticleIndexingStatus(projectId: string, articleId: string) {
    return apiFetch<GscIndexingStatus>(
      `/api/projects/${projectId}/articles/${articleId}/gsc/indexing-status`,
    );
  },
  async gscProjectStatus(projectId: string) {
    return apiFetch<ProjectGscStatus>(`/api/projects/${projectId}/gsc/status`);
  },
  async gscProjectConnectUrl(projectId: string) {
    return apiFetch<{ url: string }>(`/api/projects/${projectId}/gsc/connect-url`);
  },
  async gscProjectListSites(projectId: string) {
    return apiFetch<GscSite[]>(`/api/projects/${projectId}/gsc/sites`);
  },
  async gscProjectDisconnect(projectId: string) {
    return apiFetch<{ ok: boolean; disconnected_at?: string }>(
      `/api/projects/${projectId}/gsc/disconnect`,
      { method: "POST" },
    );
  },
  async gscProjectSetProperty(
    projectId: string,
    payload: { property_url?: string | null; index_on_publish?: boolean },
  ) {
    return apiFetch<{ ok: boolean; property_url?: string | null; index_on_publish: boolean }>(
      `/api/projects/${projectId}/gsc/property`,
      { method: "POST", body: JSON.stringify(payload) },
    );
  },

  async gscProjectListSitemaps(projectId: string) {
    return apiFetch<GscSitemapList>(`/api/projects/${projectId}/gsc/sitemaps`);
  },
  async gscProjectSubmitSitemap(projectId: string, sitemapUrl?: string | null) {
    return apiFetch<{ ok: boolean; sitemap_url: string; submitted_at?: string }>(
      `/api/projects/${projectId}/gsc/sitemaps`,
      {
        method: "POST",
        body: JSON.stringify({ sitemap_url: (sitemapUrl || "").trim() || null }),
      },
    );
  },
  async gscProjectDeleteSitemap(projectId: string, sitemapUrl: string) {
    const qs = new URLSearchParams({ sitemap_url: sitemapUrl });
    return apiFetch<{ ok: boolean; sitemap_url: string }>(
      `/api/projects/${projectId}/gsc/sitemaps?${qs.toString()}`,
      { method: "DELETE" },
    );
  },

  // Feature 1 — GSC ROI Dashboard
  // Pass either ``days`` (preset) OR ``start``/``end`` (custom range, YYYY-MM-DD).
  // The backend prefers explicit start/end when both are present, otherwise falls
  // back to ``days``. ``topPagesLimit`` controls how many rows the top-pages list returns.
  async gscProjectAnalytics(
    projectId: string,
    opts: { days?: number; start?: string; end?: string; topPagesLimit?: number } = {},
  ) {
    const qs = new URLSearchParams();
    qs.set("top_pages_limit", String(opts.topPagesLimit ?? 25));
    if (opts.start && opts.end) {
      qs.set("start_date", opts.start);
      qs.set("end_date", opts.end);
    } else {
      qs.set("days", String(opts.days ?? 30));
    }
    return apiFetch<GscAnalyticsResponse>(
      `/api/projects/${projectId}/gsc/analytics?${qs.toString()}`,
    );
  },

  // Feature 3 — Site Map (Internal Linking ingestion)
  async siteMapList(projectId: string) {
    return apiFetch<SiteMapListResponse>(`/api/projects/${projectId}/site-map`);
  },
  async siteMapSync(projectId: string) {
    return apiFetch<SiteMapSyncResponse>(`/api/projects/${projectId}/site-map/sync`, {
      method: "POST",
    });
  },

  // Feature 2 — Topic Clusters (foundations)
  async topicClusterList(projectId: string) {
    return apiFetch<{ clusters: TopicCluster[] }>(`/api/projects/${projectId}/topic-clusters`);
  },
  async topicClusterGet(projectId: string, clusterId: string) {
    return apiFetch<TopicCluster>(
      `/api/projects/${projectId}/topic-clusters/${encodeURIComponent(clusterId)}`,
    );
  },
  async topicClusterPlan(
    projectId: string,
    payload: { seed_intent: string; country_code?: string; tone?: string; language?: string },
  ) {
    return apiFetch<TopicCluster>(`/api/projects/${projectId}/topic-clusters/plan`, {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" },
    }, { timeoutMs: LONG_API_TIMEOUT_MS });
  },
  async validateClusterTopics(
    projectId: string,
    payload: {
      items: ClusterValidationItemPayload[];
      similarity_threshold?: number;
    },
    signal?: AbortSignal,
  ) {
    return apiFetch<ClusterValidationResponse>(
      `/api/projects/${projectId}/validate-clusters`,
      {
        method: "POST",
        body: JSON.stringify({
          items: payload.items,
          similarity_threshold: payload.similarity_threshold ?? 0.8,
        }),
        headers: { "Content-Type": "application/json" },
        signal,
      },
    );
  },

  async topicClusterGenerateAll(
    projectId: string,
    clusterId: string,
    body?: {
      generate_image?: boolean;
      writing_prompt_id?: string | null;
      image_prompt_id?: string | null;
      /** ``null``/omitted ⇒ generate every pending topic. */
      topic_ids?: string[] | null;
    },
  ) {
    return apiFetch<TopicClusterGenerateAllResponse>(
      `/api/projects/${projectId}/topic-clusters/${encodeURIComponent(clusterId)}/generate-all`,
      {
        method: "POST",
        body: JSON.stringify(body ?? {}),
        headers: { "Content-Type": "application/json" },
      },
      { timeoutMs: LONG_API_TIMEOUT_MS },
    );
  },

  async topicClusterImport(
    projectId: string,
    clusterId: string,
    body?: {
      topic_ids?: string[] | null;
      schedule_at?: string | null;
      post_type?: string | null;
      wp_status?: "draft" | "publish";
      writing_prompt_id?: string | null;
      image_prompt_id?: string | null;
      generate_image?: boolean;
    },
  ) {
    return apiFetch<TopicClusterImportResponse>(
      `/api/projects/${projectId}/topic-clusters/${encodeURIComponent(clusterId)}/import`,
      {
        method: "POST",
        body: JSON.stringify(body ?? {}),
        headers: { "Content-Type": "application/json" },
      },
    );
  },

  async articleQuota(projectId: string) {
    return apiFetch<ArticleQuota>(`/api/projects/${projectId}/article-quota`);
  },
  async projectFeatureLimits(projectId: string) {
    return apiFetch<ProjectFeatureLimits>(`/api/projects/${projectId}/feature-limits`);
  },

  // Feature 4 — Smart Refresh (foundations)
  async articleMarkMonitor(projectId: string, articleId: string, status: "fresh" | "stale" | "unknown") {
    return apiFetch<{ ok: boolean; monitor: { status: string; last_checked_at: string } }>(
      `/api/projects/${projectId}/articles/${articleId}/monitor/mark`,
      { method: "POST", body: JSON.stringify({ status }) },
    );
  },
  async articleSmartRefresh(projectId: string, articleId: string) {
    // Backend currently 501s; the helper is here so the UI can render a typed CTA.
    return apiFetch<{ ok: boolean; article_id: string }>(
      `/api/projects/${projectId}/articles/${articleId}/monitor/refresh`,
      { method: "POST" },
    );
  },

  // Admin
  async adminListUsers() {
    return apiFetch<AdminUserPublic[]>("/api/admin/users");
  },
  async adminUpdateUser(
    userId: string,
    patch: Partial<{
      role: string;
      subscription_type: string;
      full_name: string;
      phone: string;
      timezone: string;
      account_status: string;
      is_deleted: boolean;
      is_deactivated: boolean;
    }>,
  ) {
    return apiFetch<AdminUserPublic>(`/api/admin/users/${userId}`, { method: "PATCH", body: JSON.stringify(patch) });
  },
  async adminGetUserDetails(userId: string) {
    return apiFetch<AdminUserDetails>(`/api/admin/users/${userId}/details`);
  },
  async adminGetUserWorkspace(userId: string) {
    return apiFetch<AdminWorkspaceResponse>(`/api/admin/users/${encodeURIComponent(userId)}/workspace`);
  },

  async researchIdeas(
    projectId: string,
    payload: {
      brand_niche?: string;
      intent?: "informational" | "commercial" | "transactional" | "navigational";
      tone?:
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
      seed_keywords: string[];
      country?: string;
      language?: string;
      max_ideas?: number;
    },
  ) {
    return apiFetch<ResearchIdeasResponse>(`/api/projects/${projectId}/research/ideas`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },
  async adminDeleteUser(userId: string) {
    await apiFetch<unknown>(`/api/admin/users/${userId}`, { method: "DELETE" });
    return { ok: true as const };
  },
  async adminListPlans() {
    return apiFetch<PlanPublic[]>("/api/admin/plans");
  },
  async adminUpsertPlan(planKey: string, payload: Partial<PlanPublic>) {
    return apiFetch<PlanPublic>(`/api/admin/plans/${encodeURIComponent(planKey)}`, { method: "PUT", body: JSON.stringify(payload) });
  },
};

