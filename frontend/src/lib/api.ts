export type TokenPair = {
  access_token: string;
  refresh_token: string;
  token_type: "bearer";
};

export type RegisterPendingResponse = {
  ok: boolean;
  requires_verification: boolean;
  message: string;
  email: string;
  retry_after_seconds?: number;
};

export type ResendVerificationResponse = {
  ok: boolean;
  message: string;
  retry_after_seconds: number;
};

export type VerifyEmailResponse = {
  ok: boolean;
  message: string;
  access_token?: string | null;
  refresh_token?: string | null;
  token_type?: string;
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
  is_trial_plan?: boolean | null;
  trial_period_days?: number | null;
};

export type SubscriptionStatusPublic = {
  status: "active" | "trial_expired" | "no_trial" | string;
  plan_key: string;
  plan_name?: string | null;
  trial_start_date?: string | null;
  trial_end_date?: string | null;
  remaining_days: number;
  remaining_hours: number;
  remaining_minutes: number;
  is_trial_plan: boolean;
  usage: {
    articlesGeneratedToday: number;
    articlesGeneratedThisMonth: number;
    regenerationsThisMonth: number;
    schedulesThisMonth: number;
    exportsThisMonth: number;
  };
  features: {
    projectsMax?: number | null;
    articlesPerMonth?: number | null;
    articlesPerDay?: number | null;
    regenerationsPerMonth?: number | null;
    schedulesMax?: number | null;
    allowBulkUpload: boolean;
    allowBulkExport: boolean;
  };
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

export type ProjectPlatform = "wordpress" | "shopify";

export type ProjectPublic = {
  id: string;
  owner_user_id: string;
  name: string;
  website_url?: string | null;
  platform?: ProjectPlatform | string;
  shopify_connected?: boolean;
  shopify_sync_status?: string | null;
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
  // Collaboration fields — populated by the server
  is_shared?: boolean;
  your_role?: "owner" | "admin" | "editor" | "viewer" | null;
  owner_name?: string | null;
  member_count?: number;
};

export type ProjectSettings = {
  id: string;
  name: string;
  platform?: ProjectPlatform | string;
  website_url?: string | null;
  shopify_shop?: string | null;
  shopify_connected?: boolean;
  shopify_client_id?: string | null;
  shopify_client_secret_set?: boolean;
  shopify_access_token_set?: boolean;
  shopify_access_token?: string | null;
  shopify_verified_at?: string | null;
  shopify_verified_status?: string | null;
  shopify_verified_message?: string | null;
  shopify_product_aware_enabled?: boolean;
  wp_internal_link_aware_enabled?: boolean;
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

// --- GSC Insights (Feature 2) -----------------------------------------------

export type GscInsightsHeadlineStat = {
  value: number;
  prev: number;
  change_pct: number | null;
};

export type GscInsightsPage = {
  page: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  prev_clicks: number;
  change_pct: number | null;
  trend: "up" | "down" | "neutral";
};

export type GscInsightsQuery = {
  query: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  prev_clicks: number;
  change_pct: number | null;
  trend: "up" | "down" | "neutral";
};

export type GscInsightsCountry = {
  country_code: string;
  country_name: string;
  flag: string;
  clicks: number;
  share_pct: number;
};

export type GscInsightsTrafficSource = {
  source: string;
  source_type: string;
  clicks: number;
};

export type GscInsightsResponse = {
  property_url?: string | null;
  period: { start_date: string; end_date: string; days: number };
  prev_period: { start_date: string; end_date: string; days: number };
  headline: {
    clicks: GscInsightsHeadlineStat;
    impressions: GscInsightsHeadlineStat;
  };
  pages: GscInsightsPage[];
  queries: GscInsightsQuery[];
  countries: GscInsightsCountry[];
  traffic_sources: GscInsightsTrafficSource[];
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

export type TopicClusterQueuedResponse = {
  status: "queued";
  job_id: string;
  cluster_id: string;
  message: string;
};

export type TopicClusterWaitOptions = {
  onProgress?: (cluster: TopicCluster) => void;
  intervalMs?: number;
  maxWaitMs?: number;
  skipGlobalLoading?: boolean;
};

export function isTopicClusterQueuedResponse(value: unknown): value is TopicClusterQueuedResponse {
  return (
    !!value &&
    typeof value === "object" &&
    (value as TopicClusterQueuedResponse).status === "queued" &&
    typeof (value as TopicClusterQueuedResponse).cluster_id === "string"
  );
}

async function sleepMs(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export const TOPIC_CLUSTER_BUSY_STATUSES = new Set(["planning", "generating"]);

export function mergeTopicClusterInList(clusters: TopicCluster[], row: TopicCluster): TopicCluster[] {
  const id = (row.id || "").trim();
  if (!id) return clusters;
  return [row, ...clusters.filter((c) => c.id !== id)];
}

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

export type WorkspaceOverviewStats = {
  project_count: number;
  total_articles: number;
  published: number;
  pending: number;
  draft: number;
  scheduled: number;
  upcoming_scheduled: number;
};

export type WorkspaceFeedItem = {
  id: string;
  article_id: string;
  project_id: string;
  project_name: string;
  title: string;
  status_tag: string;
  sort_at?: string | null;
  image_url?: string | null;
};

export type WorkspaceActivityDay = {
  date: string;
  published: number;
  pending: number;
  scheduled: number;
};

export type WorkspaceOverviewResponse = {
  stats: WorkspaceOverviewStats;
  activity_series: WorkspaceActivityDay[];
  upcoming_scheduled: WorkspaceFeedItem[];
  recently_published: WorkspaceFeedItem[];
  pending: WorkspaceFeedItem[];
  drafts: WorkspaceFeedItem[];
};

/** Paginated Articles tab row — no body HTML (see GET .../articles). */
export type ArticleListItem = {
  id: string;
  project_id: string;
  title: string;
  status: string;
  keywords?: string[];
  focus_keyphrase?: string | null;
  gsc_status?: string | null;
  wp_link?: string | null;
  monitor_status?: string | null;
  wp_category_ids?: string;
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
  wp_post_id?: number | string | null;
  wp_rest_base?: string | null;
  wp_last_wp_status?: string | null;
  wp_modified_at?: string | null;
  wp_synced_at?: string | null;
  gsc_status?: string | null;
  hasBody?: boolean | null;
  monitor_status?: string | null; // Feature 4: "fresh" | "stale" | "unknown" | ""
  monitor_last_checked_at?: string | null;
  internal_links_count?: number | null; // Feature 3
  image_url?: string | null;
  shopify_blog_id?: number | null;
  shopify_article_id?: number | null;
  shopify_link?: string | null;
  wp_category_ids?: string | null;
};

export type ArticleListPage = {
  items: ArticleListItem[];
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

export type ClusterLinkSibling = {
  slot_id: string;
  role: "pillar" | "cluster" | string;
  title: string;
  article_id?: string | null;
  post_url?: string | null;
  is_live: boolean;
};

export type ClusterLinkContext = {
  cluster_id: string;
  role: "pillar" | "cluster" | string;
  slot_id: string;
  auto_link_ready: boolean;
  live_sibling_count: number;
  siblings: ClusterLinkSibling[];
};

export type ArticleDetail = ArticlePublic & {
  article: string;
  meta_title?: string | null;
  meta_description?: string | null;
  image_url?: string | null;
  generated_at?: string | null;
  has_featured_image?: boolean;
  featured_image_regeneration_count?: number;
  featured_image_regeneration_limit?: number | null;
  featured_image_regeneration_remaining?: number | null;
  featured_image_regeneration_unlimited?: boolean;
  integrity_ai_percentage?: number | null;
  integrity_flagged_paragraphs?: { index: number; text: string; reason: string }[] | null;
  integrity_last_audited_at?: string | null;
  topic_cluster_id?: string | null;
  topic_slot_id?: string | null;
  topic_role?: string | null;
  cluster_link_context?: ClusterLinkContext | null;
  generate_image?: boolean | null;
};

export type ArticleOperationQueuedResponse = {
  status: "queued";
  job_id: string;
  article_id: string;
  message: string;
  /** Server-side timestamp when the job was enqueued (YYYY-MM-DD HH:MM:SS UTC). */
  queued_at?: string | null;
};

export type ArticleGenerationStatus = {
  id: string;
  status: string;
  generated_at?: string | null;
  has_body: boolean;
  has_featured_image: boolean;
  featured_image_regeneration_count: number;
  /** Set by the worker when generation fails — surfaced immediately by polling. */
  generation_error?: string | null;
};

export type ArticleGenerationWaitOptions = {
  previousGeneratedAt?: string | null;
  /**
   * Server-side timestamp from the 202 queued_at field (same format as generated_at).
   * When set, the poll resolves when generated_at >= queuedAt, which is reliable even
   * for articles where generated_at was null/empty before this generation run.
   */
  queuedAt?: string | null;
  expectImage?: boolean;
  intervalMs?: number;
  maxWaitMs?: number;
  skipGlobalLoading?: boolean;
  /** When true and the backend returns 202 (queued), resolve immediately without polling. */
  noWait?: boolean;
};

/** Poll generation-status while a worker runs (Mongo + queue can be slow). */
const GENERATION_STATUS_TIMEOUT_MS = 45_000;
/** Default max wait for queued article generation (matches long-running backend work). */
const GENERATION_POLL_MAX_WAIT_MS = 600_000;
const POLL_INITIAL_INTERVAL_MS = 4000;
const POLL_MAX_INTERVAL_MS = 12000;
const POLL_BACKOFF_FACTOR = 1.35;
const FEATURED_IMAGE_FETCH_MAX_ATTEMPTS = 4;
const FEATURED_IMAGE_FETCH_RETRY_MS = 1500;

async function fetchArticleFeaturedImageResolved(
  projectId: string,
  articleId: string,
  opts?: ApiFetchOptions & { fresh?: boolean; maxAttempts?: number },
): Promise<string> {
  const maxAttempts = opts?.maxAttempts ?? FEATURED_IMAGE_FETCH_MAX_ATTEMPTS;
  const { maxAttempts: _drop, ...fetchOpts } = opts ?? {};
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const img = await api.getArticleFeaturedImage(projectId, articleId, fetchOpts);
      const url = (img.image_url || "").trim();
      if (url) return url;
      if (attempt + 1 < maxAttempts) {
        await sleepMs(FEATURED_IMAGE_FETCH_RETRY_MS * (attempt + 1));
      }
    } catch (e) {
      lastError = e;
      if (e instanceof ApiError && e.status === 404 && attempt + 1 < maxAttempts) {
        await sleepMs(FEATURED_IMAGE_FETCH_RETRY_MS * (attempt + 1));
        continue;
      }
      throw e;
    }
  }
  if (lastError instanceof ApiError) throw lastError;
  return "";
}

async function pollWithBackoff<T>(
  fn: () => Promise<T>,
  isDone: (value: T) => boolean,
  opts?: { intervalMs?: number; maxIntervalMs?: number; maxWaitMs?: number; backoffFactor?: number },
): Promise<T> {
  let intervalMs = opts?.intervalMs ?? POLL_INITIAL_INTERVAL_MS;
  const maxIntervalMs = opts?.maxIntervalMs ?? POLL_MAX_INTERVAL_MS;
  const maxWaitMs = opts?.maxWaitMs ?? 300_000;
  const backoffFactor = opts?.backoffFactor ?? POLL_BACKOFF_FACTOR;
  const deadline = Date.now() + maxWaitMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await fn();
    if (isDone(last)) return last;
    await sleepMs(intervalMs);
    intervalMs = Math.min(maxIntervalMs, Math.round(intervalMs * backoffFactor));
  }
  throw new ApiError(
    "Generation is taking longer than expected. Refresh the page in a minute — your article may still be generating in the background.",
    408,
  );
}

export function isArticleOperationQueuedResponse(value: unknown): value is ArticleOperationQueuedResponse {
  return (
    !!value &&
    typeof value === "object" &&
    (value as ArticleOperationQueuedResponse).status === "queued" &&
    typeof (value as ArticleOperationQueuedResponse).article_id === "string"
  );
}

export type WordPressArticleSyncResponse = {
  ok: boolean;
  message: string;
  changes: string[];
  wp_link?: string | null;
  wp_status?: string | null;
  wp_modified_at?: string | null;
  wp_synced_at?: string | null;
  article: ArticleDetail;
};

export type WordPressBulkSyncResponse = {
  ok: boolean;
  linked_count: number;
  synced_count: number;
  skipped_count: number;
  error_count: number;
  errors: { article_id: string; message: string }[];
};

export type ShopifyStatus = {
  configured: boolean;
  connect_ready?: boolean;
  setup_hint?: string | null;
  connected: boolean;
  shop?: string | null;
  connected_at?: string | null;
  sync_at?: string | null;
  sync_status?: string | null;
  sync_message?: string | null;
  counts: Record<string, number>;
  granted_scopes?: string[];
  required_scopes?: string[];
  recommended_scopes?: string[];
  needs_reauthorize?: boolean;
  can_publish?: boolean;
  missing_publish_scopes?: string[];
  has_product_catalog_scope?: boolean;
  warnings?: Array<{ resource: string; message: string }>;
};

export type ShopifyCatalog = {
  synced_at?: string | null;
  sync_status?: string | null;
  sync_message?: string | null;
  counts: Record<string, number>;
  shop: Record<string, string>;
  warnings?: Array<{
    resource: string;
    code: string;
    required_scope: string;
    message: string;
  }>;
  granted_scopes?: string[];
  required_scopes?: string[];
  recommended_scopes?: string[];
  products: Array<{
    id: number;
    title: string;
    handle: string;
    product_type?: string;
    image_url?: string;
    price?: string;
    status?: string;
  }>;
  collections: Array<{ id: number; title: string; handle: string }>;
  blogs: Array<{ id: number; title: string; handle: string; articles_count?: number }>;
  pages: Array<{ id: number; title: string; handle: string }>;
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

// ---------------------------------------------------------------------------
// Collaboration types
// ---------------------------------------------------------------------------

export type CollaboratorRole = "admin" | "editor" | "viewer";
export type InvitationStatus = "pending" | "accepted" | "declined" | "cancelled" | "expired";

export type CollaboratorPublic = {
  id: string;
  project_id: string;
  user_id: string;
  user_name: string;
  user_email: string;
  user_avatar_initials: string;
  role: CollaboratorRole;
  status: string;
  invited_at: string;
  joined_at?: string | null;
};

export type InvitationPublic = {
  id: string;
  project_id: string;
  project_name: string;
  project_website_url?: string | null;
  invited_email: string;
  invited_by_name: string;
  role: CollaboratorRole;
  status: InvitationStatus;
  created_at: string;
  expires_at: string;
  responded_at?: string | null;
};

export type MembersResponse = {
  collaborators: CollaboratorPublic[];
  pending_invitations: InvitationPublic[];
};

export type NotificationPublic = {
  id: string;
  type: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  read: boolean;
  created_at: string;
};

export type ActivityRecord = {
  id: string;
  actor_name: string;
  action: string;
  data: Record<string, unknown>;
  created_at: string;
};

const ENV_API_BASE_URL = (process.env.NEXT_PUBLIC_API_BASE_URL || "").trim().replace(/\/+$/, "");

const RIVISO_APP_HOSTS = new Set([
  "riviso.com",
  "www.riviso.com",
  "app.riviso.com",
  "riviso.cloud",
  "www.riviso.cloud",
  "app.riviso.cloud",
]);

export function getApiBaseUrl(): string {
  // SSR / build-time fallback
  if (typeof window === "undefined") {
    return ENV_API_BASE_URL || "http://127.0.0.1:8000";
  }

  const host = (window.location.hostname || "").trim() || "127.0.0.1";
  // Production app hosts: always call same-origin /api (Next rewrites → api.riviso.cloud).
  // Avoids cross-origin CORS failures when NEXT_PUBLIC_API_BASE_URL points at the API subdomain.
  if (RIVISO_APP_HOSTS.has(host)) {
    return `${window.location.protocol}//${window.location.host}`;
  }

  if (ENV_API_BASE_URL) return ENV_API_BASE_URL;

  const isLocal = host === "localhost" || host === "127.0.0.1";

  // Production browsers must not default to :8000 — that host/port is rarely reachable on the public
  // internet (firewall) and causes net::ERR_CONNECTION_TIMED_OUT. Assume API is reverse-proxied at the
  // same origin (e.g. https://riviso.com/api/... on port 443). Override with NEXT_PUBLIC_API_BASE_URL
  // when the API lives on another host (e.g. https://api.example.com).
  if (!isLocal) {
    return `${window.location.protocol}//${window.location.host}`;
  }

  // S1.3: route local dev through the same-origin Next proxy (`/api/*` → backend,
  // see next.config rewrites) so the httpOnly auth cookies are first-party and are
  // actually sent. Talking to `:8000` directly is cross-site, and the SameSite=Lax
  // cookies would not flow, breaking cookie-only auth.
  return `${window.location.protocol}//${window.location.host}`;
}

/** API path for the WordPress connector ZIP (built on demand from backend source). */
export function getWordpressPluginDownloadPath(): string {
  return "/api/wordpress/plugin/download";
}

/** Download the Riviso WordPress connector ZIP (valid package for Plugins → Upload). */
export async function downloadWordpressPlugin(downloadPath?: string): Promise<void> {
  if (typeof window === "undefined") {
    throw new Error("Plugin download is only available in the browser.");
  }
  const base = (downloadPath || getWordpressPluginDownloadPath()).trim();
  const url = base.startsWith("http")
    ? base
    : `${getApiBaseUrl()}${base.startsWith("/") ? base : `/${base}`}`;
  const headers = new Headers();
  // S1.3: authenticated via the httpOnly aa_access cookie (credentials: "include").
  headers.set("x-requested-with", "XMLHttpRequest");
  const res = await fetch(`${url}${url.includes("?") ? "&" : "?"}t=${Date.now()}`, {
    method: "GET",
    cache: "no-store",
    credentials: "include",
    headers,
  });
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

// S1.3: Access/refresh JWTs live ONLY in httpOnly cookies (aa_access / aa_refresh)
// set by the backend, so client JavaScript — and therefore any XSS — can never
// read them. We keep a single non-sensitive marker in localStorage purely so the
// UI can synchronously decide whether to render the app shell or redirect to
// login. The authoritative auth check is always the cookie, enforced server-side.
const SESSION_KEY = "aa_session";
const LEGACY_TOKEN_KEYS = ["aa_access_token", "aa_refresh_token"];

/** True when a session marker exists. UI gate only — NOT a security boundary. */
export function hasSession(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(SESSION_KEY) === "1";
}

/** Record that the user just authenticated (cookies carry the real tokens). */
export function markSession() {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(SESSION_KEY, "1");
  // Purge any JWTs persisted by older builds so they cannot linger in storage.
  for (const k of LEGACY_TOKEN_KEYS) window.localStorage.removeItem(k);
}

/**
 * Back-compat shim for the many `if (!getAccessToken())` UI auth gates. Returns a
 * non-sensitive truthy marker when a session exists and `null` otherwise; it
 * never exposes a real JWT. Prefer {@link hasSession} in new code.
 */
export function getAccessToken(): string | null {
  return hasSession() ? "1" : null;
}

/** Deprecated shims: tokens now arrive via httpOnly cookies; only mark the session. */
export function setAccessToken(_token?: string) {
  markSession();
}
export function setRefreshToken(_token?: string) {
  markSession();
}
export function getRefreshToken(): string | null {
  return null;
}

function clearSessionMarker() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(SESSION_KEY);
  for (const k of LEGACY_TOKEN_KEYS) window.localStorage.removeItem(k);
}

export function clearAuth() {
  clearSessionMarker();
  // Best-effort server-side refresh-token revocation + cookie clear (S1.1).
  if (typeof window !== "undefined") {
    try {
      void fetch(apiUrl("/api/auth/logout"), {
        method: "POST",
        credentials: "include",
        headers: { "x-requested-with": "XMLHttpRequest" },
        keepalive: true,
      });
    } catch {
      /* best-effort; cookies also expire on their own */
    }
  }
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
/** Editor shell/body: fail before Next.js navigation timeouts when Mongo is unreachable. */
export const ARTICLE_EDITOR_FETCH_TIMEOUT_MS = 45_000;

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
const _cacheArticleDetail = new Map<string, CacheEntry<ArticleDetail>>();
const _cacheArticleShell = new Map<string, CacheEntry<ArticleDetail>>();
const _cacheArticleBody = new Map<string, CacheEntry<{ article: string }>>();
const _cacheFeaturedImage = new Map<string, CacheEntry<{ image_url: string }>>();
const _cacheProfileMe = new Map<string, CacheEntry<ProfilePublic>>();
const _cacheListProjects = new Map<string, CacheEntry<ProjectPublic[]>>();
const _cacheGetProject = new Map<string, CacheEntry<ProjectPublic>>();
const _cacheFeatureLimits = new Map<string, CacheEntry<ProjectFeatureLimits>>();
const _cacheArticleQuota = new Map<string, CacheEntry<ArticleQuota>>();
const _cacheGscProjectStatus = new Map<string, CacheEntry<ProjectGscStatus>>();

function articleDetailCacheKey(projectId: string, articleId: string) {
  return `${projectId}:${articleId}`;
}

export function invalidateArticleDetailCache(projectId: string, articleId: string) {
  const key = articleDetailCacheKey(projectId, articleId);
  _cacheArticleDetail.delete(key);
  _cacheArticleShell.delete(key);
  _cacheArticleBody.delete(key);
  _cacheFeaturedImage.delete(key);
}

/** Bust cached settings (includes legacy keys without platform / shopify fields). */
export function invalidateProjectSettingsCache(projectId: string) {
  const pid = (projectId || "").trim();
  if (!pid) return;
  _cacheProjectSettings.delete(pid);
  _cacheProjectSettings.delete(`${pid}:v2`);
  _cacheWpTypes.delete(pid);
  _cacheWpCats.delete(pid);
}

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
  const name = (e as Error).name;
  if (name === "AbortError" || name === "TimeoutError") return true;
  const msg = String((e as Error).message || "").toLowerCase();
  return msg.includes("signal timed out") || msg.includes("aborted") || msg.includes("timeout");
}

function clientTimeoutError(timeoutMs: number): ApiError {
  return new ApiError(
    `Request timed out after ${Math.round(timeoutMs / 1000)}s. The server may still be working — wait a moment and refresh, or check your connection.`,
    408,
    { code: "client_timeout", timeoutMs },
  );
}

export type ApiFetchOptions = {
  /** Override default (see DEFAULT_API_TIMEOUT_MS). */
  timeoutMs?: number;
  /** @deprecated Global overlay removed — use page skeletons. Kept for API compatibility. */
  skipGlobalLoading?: boolean;
  /** Bypass browser/proxy caches (recommended after reconnecting from offline). */
  fresh?: boolean;
  /** Always hit the network without client-side response cache or cache-bust query params. */
  bypassClientCache?: boolean;
  /** Abort in-flight fetch when the caller unmounts or starts a new load. */
  signal?: AbortSignal;
};

function withFreshQuery(path: string, fresh?: boolean): string {
  if (!fresh) return path;
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}_=${Date.now()}`;
}

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
 * Authenticated JSON fetch with timeout and optional 401 refresh.
 * Loading UX is handled per-page via skeleton components (not a global overlay).
 */
async function apiFetch<T>(path: string, init?: RequestInit, opts?: ApiFetchOptions): Promise<T> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_API_TIMEOUT_MS;
  const urlPath = opts?.bypassClientCache ? path : withFreshQuery(path, opts?.fresh);
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json");
  headers.set("cache-control", "no-cache");
  headers.set("pragma", "no-cache");
  // S1.7: CSRF defense for cookie-authenticated mutations. A cross-site form
  // post cannot set this custom header, and CORS blocks it from disallowed origins.
  headers.set("x-requested-with", "XMLHttpRequest");
  // S1.3: auth travels in the httpOnly aa_access cookie (credentials: "include"),
  // never an Authorization header — there is no JWT in JS to attach.

  const doFetch = async (h: Headers) => {
      const signal = mergeAbortSignals(createTimeoutSignal(timeoutMs), opts?.signal ?? init?.signal);
      return fetch(apiUrl(urlPath), {
        ...init,
        headers: h,
        credentials: "include",
        signal,
        cache: "no-store",
      });
    };

    let res: Response;
    let retried503 = false;
    try {
      res = await doFetch(headers);
    } catch (e) {
      if (isAbortError(e)) {
        if (opts?.signal?.aborted) {
          throw new ApiError("Request cancelled", 0, { code: "aborted" });
        }
        throw clientTimeoutError(timeoutMs);
      }
      const msg = e instanceof Error ? e.message.toLowerCase() : "";
      if (
        e instanceof TypeError ||
        msg.includes("failed to fetch") ||
        msg.includes("networkerror") ||
        msg.includes("load failed")
      ) {
        throw new ApiError(
          "Could not reach the server. Check your Wi‑Fi connection and that the Riviso API is running.",
          0,
          { code: "network_error" },
        );
      }
      throw e;
    }

    if (
      res.status === 401 &&
      path !== "/api/auth/login" &&
      path !== "/api/auth/register" &&
      path !== "/api/auth/verify-email" &&
      path !== "/api/auth/resend-verification" &&
      path !== "/api/auth/forgot-password" &&
      path !== "/api/auth/reactivate" &&
      path !== "/api/auth/refresh"
    ) {
      // S1.3/S1.1: refresh using the httpOnly aa_refresh cookie (no token in JS).
      // Only attempt when we believe a session exists, to avoid hammering /refresh
      // for anonymous visitors. On success the backend rotates and re-sets the
      // aa_access / aa_refresh cookies, so we simply retry the original request.
      if (hasSession()) {
        try {
          const refreshSignal = createTimeoutSignal(AUTH_REFRESH_TIMEOUT_MS);
          const refreshed = await fetch(apiUrl("/api/auth/refresh"), {
            method: "POST",
            headers: { "x-requested-with": "XMLHttpRequest" },
            credentials: "include",
            signal: refreshSignal,
          });
          if (refreshed.ok) {
            try {
              res = await doFetch(headers);
            } catch (e) {
              if (isAbortError(e)) {
                throw clientTimeoutError(timeoutMs);
              }
              throw e;
            }
          } else if (refreshed.status === 401 || refreshed.status === 403) {
            // Refresh token was rejected or rotated away — the session is dead.
            clearSessionMarker();
          }
        } catch (e) {
          if (e instanceof ApiError) throw e;
          // Fall through to normal error handling
        }
      }
    }

    if (!res.ok) {
      if (res.status === 503 && !retried503) {
        retried503 = true;
        await new Promise((resolve) => setTimeout(resolve, 700));
        try {
          res = await doFetch(headers);
        } catch (e) {
          if (isAbortError(e)) {
            throw clientTimeoutError(timeoutMs);
          }
          throw e;
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
}

/** Form upload or non-JSON body: same timeout behavior as apiFetch. */
async function apiFetchRaw(path: string, init: RequestInit, opts?: ApiFetchOptions): Promise<Response> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_API_TIMEOUT_MS;
  const headers = new Headers(init.headers);
  // S1.3: cookie auth (credentials: "include"); S1.7: CSRF marker for mutations.
  headers.set("x-requested-with", "XMLHttpRequest");
  const signal = mergeAbortSignals(createTimeoutSignal(timeoutMs), opts?.signal ?? init.signal);

  try {
    return await fetch(apiUrl(withFreshQuery(path, opts?.fresh)), {
      ...init,
      headers,
      credentials: "include",
      signal,
      cache: "no-store",
    });
  } catch (e) {
    if (isAbortError(e)) {
      throw clientTimeoutError(timeoutMs);
    }
    throw e;
  }
}

export const api = {
  async login(email: string, password: string) {
    return apiFetch<TokenPair>(
      "/api/auth/login",
      {
        method: "POST",
        body: JSON.stringify({ email, password }),
      },
      { skipGlobalLoading: true },
    );
  },
  async refresh(refresh_token: string) {
    return apiFetch<TokenPair>("/api/auth/refresh", {
      method: "POST",
      body: JSON.stringify({ refresh_token }),
    });
  },
  async register(email: string, password: string) {
    return apiFetch<RegisterPendingResponse>(
      "/api/auth/register",
      {
        method: "POST",
        body: JSON.stringify({ email, password }),
      },
      { skipGlobalLoading: true },
    );
  },
  async verifyEmail(email: string, token: string) {
    return apiFetch<VerifyEmailResponse>(
      "/api/auth/verify-email",
      {
        method: "POST",
        body: JSON.stringify({ email, token }),
      },
      { skipGlobalLoading: true },
    );
  },
  async resendVerificationEmail(email: string) {
    return apiFetch<ResendVerificationResponse>(
      "/api/auth/resend-verification",
      {
        method: "POST",
        body: JSON.stringify({ email }),
      },
      { skipGlobalLoading: true },
    );
  },
  async forgotPassword(email: string) {
    return apiFetch<{ ok: boolean; message: string }>(
      "/api/auth/forgot-password",
      {
        method: "POST",
        body: JSON.stringify({ email }),
      },
      { skipGlobalLoading: true },
    );
  },
  async resetPassword(email: string, token: string, password: string) {
    return apiFetch<{ ok: boolean; message: string }>(
      "/api/auth/reset-password",
      {
        method: "POST",
        body: JSON.stringify({ email, token, password }),
      },
      { skipGlobalLoading: true },
    );
  },
  async reactivateAccount(email: string, password: string) {
    return apiFetch<TokenPair>(
      "/api/auth/reactivate",
      {
        method: "POST",
        body: JSON.stringify({ email, password }),
      },
      { skipGlobalLoading: true },
    );
  },
  async me(opts?: ApiFetchOptions) {
    return apiFetch<UserPublic>("/api/auth/me", undefined, opts);
  },
  async profileMe(opts?: ApiFetchOptions) {
    const key = "_";
    if (!opts?.fresh && !opts?.bypassClientCache) {
      const cached = cacheGet(_cacheProfileMe, key, 60_000);
      if (cached) return await cached;
    }
    const p = apiFetch<ProfilePublic>("/api/profile/me", undefined, opts);
    cacheSetInflight(_cacheProfileMe, key, p);
    try {
      const v = await p;
      cacheSetValue(_cacheProfileMe, key, v);
      return v;
    } catch (e) {
      _cacheProfileMe.delete(key);
      throw e;
    }
  },
  async getSubscriptionStatus(opts?: ApiFetchOptions) {
    return apiFetch<SubscriptionStatusPublic>("/api/user/subscription-status", undefined, {
      skipGlobalLoading: true,
      timeoutMs: META_API_TIMEOUT_MS,
      ...opts,
    });
  },
  async updateProfileMe(patch: Partial<{ full_name: string; phone: string; timezone: string }>) {
    const result = await apiFetch<ProfilePublic>("/api/profile/me", { method: "PATCH", body: JSON.stringify(patch) });
    _cacheProfileMe.delete("_");
    return result;
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
  async listProjects(opts?: ApiFetchOptions) {
    const key = "_";
    if (!opts?.fresh && !opts?.bypassClientCache) {
      const cached = cacheGet(_cacheListProjects, key, 60_000);
      if (cached) return await cached;
    } else if (opts?.fresh) {
      _cacheListProjects.delete(key);
    }
    const p = apiFetch<ProjectPublic[]>("/api/projects", undefined, opts);
    cacheSetInflight(_cacheListProjects, key, p);
    try {
      const v = await p;
      cacheSetValue(_cacheListProjects, key, v);
      return v;
    } catch (e) {
      _cacheListProjects.delete(key);
      throw e;
    }
  },
  async workspaceOverview(opts?: ApiFetchOptions) {
    return apiFetch<WorkspaceOverviewResponse>("/api/workspace/overview", undefined, opts);
  },
  async createProject(name: string, platform: ProjectPlatform, website_url?: string) {
    const result = await apiFetch<ProjectPublic>("/api/projects", {
      method: "POST",
      body: JSON.stringify({ name, website_url: website_url || null, platform }),
    });
    _cacheListProjects.delete("_");
    return result;
  },

  async verifyShopifyConnection(
    projectId: string,
    payload?: { shop?: string; client_id?: string; client_secret?: string; access_token?: string },
  ) {
    return apiFetch<{
      ok: boolean;
      status: string;
      message: string;
      needs_oauth?: boolean;
      needs_reauthorize?: boolean;
      reauthorize_url?: string | null;
      granted_scopes?: string[];
      missing_scopes?: string[];
      shop?: string | null;
    }>(`/api/projects/${projectId}/shopify/verify`, {
      method: "POST",
      body: JSON.stringify({
        shop: payload?.shop || null,
        client_id: payload?.client_id || null,
        client_secret: payload?.client_secret || null,
        access_token: payload?.access_token || null,
      }),
    });
  },

  async resolveShopifyShop(projectId: string, shop: string) {
    return apiFetch<{
      ok: boolean;
      myshopify_domain?: string | null;
      public_url?: string | null;
      message?: string | null;
    }>(`/api/projects/${projectId}/shopify/resolve-shop`, {
      method: "POST",
      body: JSON.stringify({ shop }),
    });
  },

  async getShopifyStatus(projectId: string, opts?: ApiFetchOptions) {
    return apiFetch<{
      configured: boolean;
      connect_ready?: boolean;
      setup_hint?: string | null;
      connected: boolean;
      shop?: string | null;
      connected_at?: string | null;
      sync_at?: string | null;
      sync_status?: string | null;
      sync_message?: string | null;
      counts: Record<string, number>;
      granted_scopes?: string[];
      required_scopes?: string[];
      recommended_scopes?: string[];
      needs_reauthorize?: boolean;
      can_publish?: boolean;
      missing_publish_scopes?: string[];
      has_product_catalog_scope?: boolean;
      warnings?: Array<{ resource: string; message: string }>;
    }>(`/api/projects/${projectId}/shopify/status`, undefined, {
      timeoutMs: META_API_TIMEOUT_MS,
      skipGlobalLoading: true,
      ...opts,
    });
  },

  async getShopifyConnectUrl(projectId: string, shop?: string, opts?: ApiFetchOptions) {
    const return_origin =
      typeof window !== "undefined" ? window.location.origin : undefined;
    return apiFetch<{ url: string; shop: string }>(
      `/api/projects/${projectId}/shopify/connect-url`,
      {
        method: "POST",
        body: JSON.stringify({
          ...(shop ? { shop } : {}),
          ...(return_origin ? { return_origin } : {}),
        }),
      },
      { skipGlobalLoading: true, ...opts },
    );
  },

  async connectShopify(
    projectId: string,
    payload: { shop: string; client_id: string; client_secret: string },
  ) {
    return apiFetch<{
      ok: boolean;
      status: string;
      message: string;
      shop?: string | null;
      needs_reauthorize?: boolean;
      reauthorize_url?: string | null;
      granted_scopes?: string[];
      missing_scopes?: string[];
    }>(`/api/projects/${projectId}/connect-shopify`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  async getShopifyReauthorizeUrl(
    projectId: string,
    payload?: { shop?: string; return_origin?: string },
  ) {
    const return_origin =
      payload?.return_origin ||
      (typeof window !== "undefined" ? window.location.origin : undefined);
    return apiFetch<{
      ok: boolean;
      url?: string | null;
      shop?: string | null;
      message?: string | null;
    }>(`/api/projects/${projectId}/shopify/reauthorize-url`, {
      method: "POST",
      body: JSON.stringify({
        ...(payload?.shop ? { shop: payload.shop } : {}),
        ...(return_origin ? { return_origin } : {}),
      }),
    });
  },

  /** @deprecated Use connectShopify with Client ID + Secret */
  async manualConnectShopify(projectId: string, payload: { shop: string; access_token: string }) {
    return apiFetch<{
      ok: boolean;
      status: string;
      message: string;
      shop?: string | null;
    }>(`/api/projects/${projectId}/shopify/manual-connect`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  async syncShopifyCatalog(projectId: string) {
    return apiFetch<{
      configured: boolean;
      connected: boolean;
      shop?: string | null;
      sync_at?: string | null;
      sync_status?: string | null;
      sync_message?: string | null;
      counts: Record<string, number>;
      warnings?: Array<{
        resource: string;
        code: string;
        required_scope: string;
        message: string;
      }>;
      granted_scopes?: string[];
      required_scopes?: string[];
      recommended_scopes?: string[];
    }>(`/api/projects/${projectId}/shopify/sync`, { method: "POST" }, { timeoutMs: 120_000 });
  },

  async getShopifyCatalog(projectId: string) {
    return apiFetch<{
      synced_at?: string | null;
      sync_status?: string | null;
      sync_message?: string | null;
      counts: Record<string, number>;
      shop: Record<string, string>;
      warnings?: Array<{
        resource: string;
        code: string;
        required_scope: string;
        message: string;
      }>;
      granted_scopes?: string[];
      required_scopes?: string[];
      recommended_scopes?: string[];
      products: Array<{
        id: number;
        title: string;
        handle: string;
        product_type?: string;
        image_url?: string;
        price?: string;
        status?: string;
      }>;
      collections: Array<{ id: number; title: string; handle: string }>;
      blogs: Array<{ id: number; title: string; handle: string; articles_count?: number }>;
      pages: Array<{ id: number; title: string; handle: string }>;
    }>(`/api/projects/${projectId}/shopify/catalog`);
  },

  async disconnectShopify(projectId: string) {
    return apiFetch<{ ok: boolean }>(`/api/projects/${projectId}/shopify/disconnect`, { method: "POST" });
  },
  async getProject(projectId: string, opts?: ApiFetchOptions) {
    if (!opts?.fresh && !opts?.bypassClientCache) {
      const cached = cacheGet(_cacheGetProject, projectId, 30_000);
      if (cached) return await cached;
    } else if (opts?.fresh) {
      _cacheGetProject.delete(projectId);
    }
    const p = apiFetch<ProjectPublic>(`/api/projects/${projectId}`, undefined, {
      timeoutMs: META_API_TIMEOUT_MS,
      skipGlobalLoading: true,
      ...opts,
    });
    cacheSetInflight(_cacheGetProject, projectId, p);
    try {
      const v = await p;
      cacheSetValue(_cacheGetProject, projectId, v);
      return v;
    } catch (e) {
      _cacheGetProject.delete(projectId);
      throw e;
    }
  },
  async updateProject(
    projectId: string,
    patch: Partial<{
      name: string;
      website_url: string | null;
      platform: ProjectPlatform | string;
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
    opts?: ApiFetchOptions,
  ) {
    const updated = await apiFetch<ProjectPublic>(`/api/projects/${projectId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }, { skipGlobalLoading: true, ...opts });
    invalidateProjectSettingsCache(projectId);
    _cacheGetProject.delete(projectId);
    _cacheListProjects.delete("_");
    return updated;
  },
  async deleteProject(projectId: string) {
    await apiFetch<unknown>(`/api/projects/${projectId}`, { method: "DELETE" });
    _cacheListProjects.delete("_");
    _cacheGetProject.delete(projectId);
    return { ok: true as const };
  },
  async getProjectSettings(projectId: string, opts?: { fresh?: boolean } & ApiFetchOptions) {
    const key = `${projectId}:v2`;
    const { fresh, ...fetchOpts } = opts || {};
    if (!fresh) {
      const cached = cacheGet(_cacheProjectSettings, key, 30_000);
      if (cached) return await cached;
    } else {
      invalidateProjectSettingsCache(projectId);
    }
    const p = apiFetch<ProjectSettings>(`/api/projects/${projectId}/settings`, undefined, {
      timeoutMs: META_API_TIMEOUT_MS,
      skipGlobalLoading: true,
      ...fetchOpts,
    });
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
      shopify_product_aware_enabled: boolean;
      wp_internal_link_aware_enabled: boolean;
      shopify_shop: string;
      shopify_client_id: string;
      shopify_client_secret: string;
      shopify_access_token: string;
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
      user_timezone: string;
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

  async postScheduledJobNow(
    projectId: string,
    jobId: string,
    body?: {
      writing_prompt_id?: string | null;
      image_prompt_id?: string | null;
      generate_image?: boolean;
    },
    opts?: ApiFetchOptions,
  ) {
    return apiFetch<{
      ok: boolean;
      status: string;
      async?: boolean;
      message: string;
      job?: ScheduledJobPublic;
      wp_post_id?: number | string | null;
      wp_link?: string | null;
    }>(
      `/api/projects/${projectId}/scheduled-jobs/${jobId}/post-now`,
      {
        method: "POST",
        body: body ? JSON.stringify(body) : undefined,
      },
      {
        timeoutMs: LONG_API_TIMEOUT_MS,
        skipGlobalLoading: true,
        ...opts,
      },
    );
  },
  async retryAllFailedScheduledPreparations(projectId: string) {
    return apiFetch<{ ok: boolean; retried: number; message: string }>(
      `/api/projects/${projectId}/scheduled-jobs/retry-failed-preparations`,
      { method: "POST" },
    );
  },
  async listArticlesPage(projectId: string, query: ArticleListQuery = {}, opts?: ApiFetchOptions) {
    const sp = new URLSearchParams();
    if (query.page != null) sp.set("page", String(query.page));
    sp.set("per_page", String(Math.min(query.per_page ?? 10, 100)));
    if (query.q) sp.set("q", query.q);
    if (query.status) sp.set("status", query.status);
    if (query.date_from) sp.set("date_from", query.date_from);
    if (query.date_to) sp.set("date_to", query.date_to);
    if (query.sort) sp.set("sort", query.sort);
    const qs = sp.toString();
    return apiFetch<ArticleListPage>(`/api/projects/${projectId}/articles${qs ? `?${qs}` : ""}`, undefined, {
      skipGlobalLoading: true,
      ...opts,
    });
  },
  /** Warm editor shell (and body) on hover — never throws to the UI. */
  prefetchArticle(projectId: string, articleId: string) {
    void api
      .getArticleEditorShell(projectId, articleId, { skipGlobalLoading: true })
      .then(() => api.getArticleBody(projectId, articleId, { skipGlobalLoading: true }))
      .catch(() => {
        /* optional */
      });
  },
  async listArticleTitles(projectId: string) {
    return apiFetch<ArticleTitleRef[]>(`/api/projects/${projectId}/articles/titles`);
  },
  /** Fetch all pages for export (bounded). */
  async listArticlesAll(projectId: string, query: Omit<ArticleListQuery, "page" | "per_page"> = {}) {
    const per_page = 500;
    const MAX_PAGES = 50;
    // P2.7: fetch page 1 to learn the total, then pull the remaining pages with
    // bounded concurrency instead of a serial 50-request waterfall.
    const first = await api.listArticlesPage(projectId, { ...query, page: 1, per_page });
    const items: ArticlePublic[] = [...(first.items || [])];
    const total = first.total || 0;
    if (items.length >= total || !(first.items || []).length) return items;

    const lastPage = Math.min(MAX_PAGES, Math.ceil(total / per_page));
    const pages: number[] = [];
    for (let p = 2; p <= lastPage; p += 1) pages.push(p);

    const CONCURRENCY = 4;
    for (let i = 0; i < pages.length; i += CONCURRENCY) {
      const batch = pages.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        batch.map((page) =>
          api
            .listArticlesPage(projectId, { ...query, page, per_page })
            .then((res) => res.items || [])
            .catch(() => [] as ArticlePublic[]),
        ),
      );
      for (const arr of results) items.push(...arr);
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

  async getArticleEditorShell(projectId: string, articleId: string, opts?: ApiFetchOptions & { fresh?: boolean }) {
    const key = articleDetailCacheKey(projectId, articleId);
    if (!opts?.fresh) {
      const cached = cacheGet(_cacheArticleShell, key, 60_000);
      if (cached) return await cached;
    }
    const p = apiFetch<ArticleDetail>(
      `/api/projects/${projectId}/articles/${articleId}/editor-shell`,
      undefined,
      {
        skipGlobalLoading: true,
        timeoutMs: ARTICLE_EDITOR_FETCH_TIMEOUT_MS,
        ...opts,
      },
    );
    if (!opts?.fresh) cacheSetInflight(_cacheArticleShell, key, p);
    try {
      const v = await p;
      if (!opts?.fresh) cacheSetValue(_cacheArticleShell, key, v);
      return v;
    } catch (e) {
      if (!opts?.fresh) _cacheArticleShell.delete(key);
      throw e;
    }
  },

  async getArticleBody(projectId: string, articleId: string, opts?: ApiFetchOptions & { fresh?: boolean }) {
    const key = articleDetailCacheKey(projectId, articleId);
    if (!opts?.fresh) {
      const cached = cacheGet(_cacheArticleBody, key, 60_000);
      if (cached) return await cached;
    }
    const p = apiFetch<{ article: string }>(
      `/api/projects/${projectId}/articles/${articleId}/body`,
      undefined,
      {
        skipGlobalLoading: true,
        timeoutMs: ARTICLE_EDITOR_FETCH_TIMEOUT_MS,
        ...opts,
      },
    );
    if (!opts?.fresh) cacheSetInflight(_cacheArticleBody, key, p);
    try {
      const v = await p;
      if (!opts?.fresh) cacheSetValue(_cacheArticleBody, key, v);
      return v;
    } catch (e) {
      if (!opts?.fresh) _cacheArticleBody.delete(key);
      throw e;
    }
  },

  async getArticle(projectId: string, articleId: string, opts?: ApiFetchOptions & { fresh?: boolean }) {
    const key = articleDetailCacheKey(projectId, articleId);
    if (!opts?.fresh) {
      const cached = cacheGet(_cacheArticleDetail, key, 60_000);
      if (cached) return await cached;
    }
    const p = apiFetch<ArticleDetail>(
      `/api/projects/${projectId}/articles/${articleId}`,
      undefined,
      {
        skipGlobalLoading: true,
        timeoutMs: ARTICLE_EDITOR_FETCH_TIMEOUT_MS,
        ...opts,
      },
    );
    if (!opts?.fresh) cacheSetInflight(_cacheArticleDetail, key, p);
    try {
      const v = await p;
      if (!opts?.fresh) {
        cacheSetValue(_cacheArticleDetail, key, v);
        cacheSetValue(_cacheArticleShell, key, { ...v, article: "" });
        cacheSetValue(_cacheArticleBody, key, { article: v.article || "" });
      }
      return v;
    } catch (e) {
      if (!opts?.fresh) _cacheArticleDetail.delete(key);
      throw e;
    }
  },

  async resolveArticleFeaturedImageUrl(
    projectId: string,
    articleId: string,
    opts?: ApiFetchOptions & { fresh?: boolean; maxAttempts?: number },
  ) {
    return fetchArticleFeaturedImageResolved(projectId, articleId, opts);
  },

  async getArticleFeaturedImage(projectId: string, articleId: string, opts?: ApiFetchOptions & { fresh?: boolean }) {
    const key = articleDetailCacheKey(projectId, articleId);
    if (!opts?.fresh && !opts?.bypassClientCache) {
      const cached = cacheGet(_cacheFeaturedImage, key, 120_000);
      if (cached) return await cached;
    }
    const p = apiFetch<{ image_url: string }>(
      `/api/projects/${projectId}/articles/${articleId}/featured-image`,
      undefined,
      opts,
    );
    if (!opts?.fresh && !opts?.bypassClientCache) cacheSetInflight(_cacheFeaturedImage, key, p);
    try {
      const v = await p;
      if (!opts?.fresh && !opts?.bypassClientCache) cacheSetValue(_cacheFeaturedImage, key, v);
      return v;
    } catch (e) {
      if (!opts?.fresh && !opts?.bypassClientCache) _cacheFeaturedImage.delete(key);
      throw e;
    }
  },

  async getArticleGenerationStatus(projectId: string, articleId: string, opts?: ApiFetchOptions) {
    return apiFetch<ArticleGenerationStatus>(
      `/api/projects/${projectId}/articles/${articleId}/generation-status`,
      undefined,
      { skipGlobalLoading: true, bypassClientCache: true, timeoutMs: GENERATION_STATUS_TIMEOUT_MS, ...opts },
    );
  },

  async getArticleClusterLinkContext(projectId: string, articleId: string, opts?: ApiFetchOptions) {
    return apiFetch<{ cluster_link_context: ClusterLinkContext | null }>(
      `/api/projects/${projectId}/articles/${articleId}/cluster-link-context`,
      undefined,
      { skipGlobalLoading: true, timeoutMs: META_API_TIMEOUT_MS, ...opts },
    );
  },

  async refreshArticleEditorPayload(
    projectId: string,
    articleId: string,
    opts?: ApiFetchOptions & { fresh?: boolean },
  ): Promise<ArticleDetail> {
    const fetchOpts = { skipGlobalLoading: true, fresh: true, ...opts };
    const [shell, body] = await Promise.all([
      api.getArticleEditorShell(projectId, articleId, fetchOpts),
      api.getArticleBody(projectId, articleId, fetchOpts),
    ]);
    let imageUrl = (shell.image_url || "").trim();
    if (!imageUrl && shell.has_featured_image) {
      try {
        imageUrl = await fetchArticleFeaturedImageResolved(projectId, articleId, fetchOpts);
      } catch {
        /* optional */
      }
    }
    const merged: ArticleDetail = { ...shell, article: body.article || "", image_url: imageUrl || shell.image_url };
    cacheSetValue(_cacheArticleDetail, articleDetailCacheKey(projectId, articleId), merged);
    cacheSetValue(_cacheArticleShell, articleDetailCacheKey(projectId, articleId), { ...shell, article: "" });
    cacheSetValue(_cacheArticleBody, articleDetailCacheKey(projectId, articleId), { article: body.article || "" });
    if (imageUrl) cacheSetValue(_cacheFeaturedImage, articleDetailCacheKey(projectId, articleId), { image_url: imageUrl });
    return merged;
  },

  async updateArticleCategories(
    projectId: string,
    items: Array<{ article_id: string; wp_category_ids: string }>,
  ) {
    return apiFetch<{ ok: boolean; results: Array<{ article_id: string; ok: boolean; wp_synced: boolean; error?: string | null }> }>(
      `/api/projects/${projectId}/articles/batch-categories`,
      {
        method: "POST",
        body: JSON.stringify({ items }),
      },
    );
  },

  async syncWpCategories(projectId: string) {
    return apiFetch<{ ok: boolean; synced: number }>(
      `/api/projects/${projectId}/articles/sync-wp-categories`,
      { method: "POST" },
    );
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
    opts?: ApiFetchOptions,
  ) {
    const v = await apiFetch<ArticleDetail>(
      `/api/projects/${projectId}/articles/${articleId}`,
      {
        method: "PATCH",
        body: JSON.stringify(patch),
      },
      opts,
    );
    cacheSetValue(_cacheArticleDetail, articleDetailCacheKey(projectId, articleId), v);
    return v;
  },

  async auditArticleIntegrity(
    projectId: string,
    articleId: string,
    markdown?: string,
    opts?: ApiFetchOptions,
  ) {
    return apiFetch<{
      ai_percentage: number;
      flagged_paragraphs: { index: number; text: string; reason: string }[];
      metrics?: Record<string, unknown>;
    }>(
      `/api/projects/${projectId}/articles/${articleId}/integrity/audit`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(markdown != null ? { markdown } : {}),
      },
      opts,
    );
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

  async compileWritingPromptTemplate(projectId: string, options: Record<string, unknown>) {
    return apiFetch<{ text: string }>(`/api/projects/${projectId}/prompts/compile-template`, {
      method: "POST",
      body: JSON.stringify(options),
    });
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

  async waitForArticleGenerationComplete(
    projectId: string,
    articleId: string,
    opts?: ArticleGenerationWaitOptions,
  ): Promise<ArticleDetail> {
    const previousGeneratedAt = (opts?.previousGeneratedAt || "").trim();
    const queuedAt = (opts?.queuedAt || "").trim();
    const expectImage = !!opts?.expectImage;
    const pollOpts = { skipGlobalLoading: true as const };

    await pollWithBackoff(
      () => api.getArticleGenerationStatus(projectId, articleId, pollOpts),
      (status) => {
        // Surface worker errors immediately instead of polling for 10 minutes.
        const genErr = (status.generation_error || "").trim();
        if (genErr) throw new ApiError(genErr, 500, { code: "generation_failed" });

        const genAt = (status.generated_at || "").trim();

        let generationFinished: boolean;
        if (queuedAt) {
          // Reliable path: backend gave us a queued_at timestamp.
          // Both queuedAt and genAt use "YYYY-MM-DD HH:MM:SS" — string >= is chronological.
          // Generation always completes after queuing, so genAt >= queuedAt is the signal.
          generationFinished = status.has_body && !!genAt && genAt >= queuedAt;
        } else if (previousGeneratedAt) {
          // Regeneration path: wait for a non-empty genAt that's different from before.
          // Never short-circuit on empty genAt — that would return stale content.
          generationFinished = status.has_body && !!genAt && genAt !== previousGeneratedAt;
        } else {
          // First generation: just wait for body to exist (no baseline to compare against).
          generationFinished = status.has_body;
        }

        if (!generationFinished) return false;
        if (expectImage && !status.has_featured_image) return false;
        return true;
      },
      {
        intervalMs: opts?.intervalMs ?? POLL_INITIAL_INTERVAL_MS,
        maxWaitMs: opts?.maxWaitMs ?? GENERATION_POLL_MAX_WAIT_MS,
      },
    );

    return api.refreshArticleEditorPayload(projectId, articleId, {
      ...pollOpts,
      timeoutMs: ARTICLE_EDITOR_FETCH_TIMEOUT_MS,
    });
  },

  async waitForFeaturedImageReady(
    projectId: string,
    articleId: string,
    opts?: {
      previousRegenCount?: number;
      hadFeaturedImage?: boolean;
      intervalMs?: number;
      maxWaitMs?: number;
      skipGlobalLoading?: boolean;
    },
  ): Promise<{ article: ArticleDetail; image_url: string }> {
    const baselineCount = opts?.previousRegenCount ?? 0;
    const baselineHas = !!opts?.hadFeaturedImage;
    const pollOpts = { skipGlobalLoading: true as const };

    await pollWithBackoff(
      () => api.getArticleGenerationStatus(projectId, articleId, pollOpts),
      (status) => {
        if (status.generation_error) {
          throw new ApiError(
            `Image generation failed: ${status.generation_error}`,
            500,
          );
        }
        return (
          status.has_featured_image &&
          (!baselineHas || status.featured_image_regeneration_count > baselineCount)
        );
      },
      {
        intervalMs: opts?.intervalMs ?? POLL_INITIAL_INTERVAL_MS,
        maxWaitMs: opts?.maxWaitMs ?? 180_000,
      },
    );

    let imageUrl = "";
    try {
      imageUrl = await fetchArticleFeaturedImageResolved(projectId, articleId, { ...pollOpts, fresh: true });
    } catch {
      /* optional */
    }
    const shell = await api.getArticleEditorShell(projectId, articleId, { ...pollOpts, fresh: true });
    const merged: ArticleDetail = {
      ...shell,
      image_url: imageUrl || shell.image_url || "",
      has_featured_image: shell.has_featured_image || !!imageUrl,
    };
    return { article: merged, image_url: imageUrl };
  },

  async generateArticle(
    projectId: string,
    articleId: string,
    payload: {
      writing_prompt_id?: string | null;
      image_prompt_id?: string | null;
      focus_keyphrase?: string | null;
      generate_image?: boolean;
      /** Shopify only: products to map into content and optional img2img reference. */
      mapped_products?: Array<{
        title: string;
        handle: string;
        featured_image_url?: string | null;
        image_url?: string | null;
      }> | null;
      /** WordPress only: site-map pages to link and optional img2img reference. */
      mapped_pages?: Array<{
        title: string;
        post_url: string;
        featured_image_url?: string | null;
        image_url?: string | null;
        post_id?: string | null;
      }> | null;
    },
    opts?: ArticleGenerationWaitOptions & { previousGeneratedAt?: string | null },
  ) {
    const { previousGeneratedAt, queuedAt, expectImage, intervalMs, maxWaitMs, skipGlobalLoading, noWait, ...fetchOpts } = opts ?? {};
    const res = await apiFetch<
      | {
          ok: boolean;
          status: string;
          message: string;
          image_warning?: string | null;
          requested?: unknown;
          resolved?: unknown;
          generated?: {
            article?: string;
            meta_title?: string;
            meta_description?: string;
            image_url?: string | null;
          };
        }
      | ArticleOperationQueuedResponse
    >(
      `/api/projects/${projectId}/articles/${articleId}/generate`,
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
      { timeoutMs: LONG_API_TIMEOUT_MS, ...fetchOpts },
    ).finally(() => invalidateArticleDetailCache(projectId, articleId));

    if (isArticleOperationQueuedResponse(res)) {
      if (noWait) {
        return { ok: true, status: "queued", message: res.message || "Article queued for generation." };
      }
      const art = await api.waitForArticleGenerationComplete(projectId, articleId, {
        previousGeneratedAt,
        queuedAt: (res as ArticleOperationQueuedResponse).queued_at ?? undefined,
        expectImage: expectImage ?? !!payload.generate_image,
        intervalMs,
        maxWaitMs,
        skipGlobalLoading,
      });
      return {
        ok: true,
        status: "generated",
        message: res.message || "Article generated successfully.",
        hydratedArticle: art,
        generated: {
          article: art.article,
          meta_title: art.meta_title || undefined,
          meta_description: art.meta_description || undefined,
          image_url: (art.image_url || "").trim() || null,
        },
      };
    }
    return res;
  },

  async regenerateArticleImage(
    projectId: string,
    articleId: string,
    payload: { image_prompt_id?: string | null; custom_image_prompt?: string | null },
    opts?: ApiFetchOptions & {
      previousRegenCount?: number;
      hadFeaturedImage?: boolean;
      intervalMs?: number;
      maxWaitMs?: number;
    },
  ) {
    const { previousRegenCount, hadFeaturedImage, intervalMs, maxWaitMs, ...fetchOpts } = opts ?? {};
    const res = await apiFetch<
      | {
          ok: boolean;
          status: string;
          message: string;
          image_url?: string | null;
          has_featured_image?: boolean;
          save_warning?: string | null;
          usage?: {
            used: number;
            limit: number | null;
            remaining: number | null;
            unlimited: boolean;
          };
        }
      | ArticleOperationQueuedResponse
    >(
      `/api/projects/${projectId}/articles/${articleId}/regenerate-image`,
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
      { timeoutMs: LONG_API_TIMEOUT_MS, skipGlobalLoading: true, ...fetchOpts },
    ).finally(() => invalidateArticleDetailCache(projectId, articleId));

    if (isArticleOperationQueuedResponse(res)) {
      const waited = await api.waitForFeaturedImageReady(projectId, articleId, {
        previousRegenCount,
        hadFeaturedImage,
        intervalMs,
        maxWaitMs,
        skipGlobalLoading: true,
      });
      return {
        ok: true,
        status: "image_regenerated",
        message: res.message || "Featured image regenerated successfully.",
        image_url: waited.image_url || null,
        has_featured_image: true,
        save_warning: null,
        hydratedArticle: waited.article,
      };
    }
    return res;
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
      user_timezone?: string;
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
      user_timezone?: string;
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
    opts?: ApiFetchOptions,
  ) {
    const fd = new FormData();
    if (payload.image_file) fd.set("image_file", payload.image_file);
    fd.set("post_type", payload.post_type);
    fd.set("wp_status", payload.wp_status);
    fd.set("category_ids", payload.category_ids.join(","));
    const res = await apiFetchRaw(
      `/api/projects/${projectId}/articles/${articleId}/publish`,
      { method: "POST", body: fd },
      { timeoutMs: LONG_API_TIMEOUT_MS, ...opts },
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

  async publishArticleToShopify(
    projectId: string,
    articleId: string,
    payload: { blog_id?: number | null; publish?: boolean },
    opts?: ApiFetchOptions,
  ) {
    return apiFetch<{
      ok: boolean;
      status: "draft" | "published" | string;
      message: string;
      shopify_article_id?: number | null;
      shopify_blog_id?: number | null;
      shopify_link?: string | null;
    }>(`/api/projects/${projectId}/articles/${articleId}/shopify/publish`, {
      method: "POST",
      body: JSON.stringify(payload || {}),
    }, opts);
  },

  async updateArticleOnWordPress(
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
      `/api/projects/${projectId}/articles/${articleId}/update-wordpress`,
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
      featured_media_id?: number | null;
      featured_image_uploaded?: boolean;
    };
  },

  async syncArticleFromWordPress(projectId: string, articleId: string) {
    return apiFetch<WordPressArticleSyncResponse>(
      `/api/projects/${projectId}/articles/${articleId}/sync-from-wordpress`,
      { method: "POST" },
      { timeoutMs: LONG_API_TIMEOUT_MS, skipGlobalLoading: true },
    ).finally(() => invalidateArticleDetailCache(projectId, articleId));
  },

  async syncLinkedArticlesFromWordPress(projectId: string) {
    return apiFetch<WordPressBulkSyncResponse>(
      `/api/projects/${projectId}/wordpress/sync-linked-articles`,
      { method: "POST" },
      { timeoutMs: LONG_API_TIMEOUT_MS },
    );
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
  async gscProjectStatus(projectId: string, opts?: ApiFetchOptions) {
    if (!opts?.fresh && !opts?.bypassClientCache) {
      const cached = cacheGet(_cacheGscProjectStatus, projectId, 30_000);
      if (cached) return await cached;
    } else if (opts?.fresh) {
      _cacheGscProjectStatus.delete(projectId);
    }
    const p = apiFetch<ProjectGscStatus>(`/api/projects/${projectId}/gsc/status`, undefined, opts);
    cacheSetInflight(_cacheGscProjectStatus, projectId, p);
    try {
      const v = await p;
      cacheSetValue(_cacheGscProjectStatus, projectId, v);
      return v;
    } catch (e) {
      _cacheGscProjectStatus.delete(projectId);
      throw e;
    }
  },
  async gscProjectConnectUrl(projectId: string, opts?: { origin?: string }) {
    const origin = opts?.origin || (typeof window !== "undefined" ? window.location.origin : "");
    const qs = origin ? `?frontend_origin=${encodeURIComponent(origin)}` : "";
    return apiFetch<{ url: string }>(`/api/projects/${projectId}/gsc/connect-url${qs}`);
  },
  async gscProjectListSites(projectId: string) {
    return apiFetch<GscSite[]>(`/api/projects/${projectId}/gsc/sites`);
  },
  async gscProjectDisconnect(projectId: string) {
    const result = await apiFetch<{ ok: boolean; disconnected_at?: string }>(
      `/api/projects/${projectId}/gsc/disconnect`,
      { method: "POST" },
    );
    _cacheGscProjectStatus.delete(projectId);
    return result;
  },
  async gscProjectSetProperty(
    projectId: string,
    payload: { property_url?: string | null; index_on_publish?: boolean },
  ) {
    const result = await apiFetch<{ ok: boolean; property_url?: string | null; index_on_publish: boolean }>(
      `/api/projects/${projectId}/gsc/property`,
      { method: "POST", body: JSON.stringify(payload) },
    );
    _cacheGscProjectStatus.delete(projectId);
    return result;
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

  async gscProjectInsights(projectId: string, opts: { days?: number } = {}) {
    const qs = new URLSearchParams();
    qs.set("days", String(opts.days ?? 28));
    return apiFetch<GscInsightsResponse>(
      `/api/projects/${projectId}/gsc/insights?${qs.toString()}`,
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
  async topicClusterGet(projectId: string, clusterId: string, opts?: ApiFetchOptions) {
    return apiFetch<TopicCluster>(
      `/api/projects/${projectId}/topic-clusters/${encodeURIComponent(clusterId)}`,
      undefined,
      opts,
    );
  },
  async waitForTopicClusterReady(
    projectId: string,
    clusterId: string,
    opts?: TopicClusterWaitOptions,
  ): Promise<TopicCluster> {
    const intervalMs = opts?.intervalMs ?? 2000;
    const maxWaitMs = opts?.maxWaitMs ?? 240_000;
    const deadline = Date.now() + maxWaitMs;
    const fetchOpts = opts?.skipGlobalLoading ? { skipGlobalLoading: true as const } : undefined;
    while (Date.now() < deadline) {
      const row = await api.topicClusterGet(projectId, clusterId, fetchOpts);
      opts?.onProgress?.(row);
      const status = (row.status || "").toLowerCase();
      if (!TOPIC_CLUSTER_BUSY_STATUSES.has(status)) {
        if (status === "error") {
          throw new ApiError("Cluster operation failed.", 502, row);
        }
        return row;
      }
      await sleepMs(intervalMs);
    }
    throw new ApiError("Timed out waiting for the cluster operation to finish.", 408);
  },
  async topicClusterPlan(
    projectId: string,
    payload: { seed_intent: string; country_code?: string; tone?: string; language?: string },
    opts?: ApiFetchOptions & TopicClusterWaitOptions,
  ) {
    const { onProgress, intervalMs, maxWaitMs, ...fetchOpts } = opts ?? {};
    const res = await apiFetch<TopicCluster | TopicClusterQueuedResponse>(
      `/api/projects/${projectId}/topic-clusters/plan`,
      {
        method: "POST",
        body: JSON.stringify(payload),
        headers: { "Content-Type": "application/json" },
      },
      { timeoutMs: LONG_API_TIMEOUT_MS, ...fetchOpts },
    );
    if (isTopicClusterQueuedResponse(res)) {
      try {
        onProgress?.(await api.topicClusterGet(projectId, res.cluster_id, fetchOpts));
      } catch {
        // Placeholder row may not be readable yet; polling will retry.
      }
      return api.waitForTopicClusterReady(projectId, res.cluster_id, {
        onProgress,
        intervalMs,
        maxWaitMs,
        skipGlobalLoading: fetchOpts?.skipGlobalLoading,
      });
    }
    return res as TopicCluster;
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
      mapped_products?: Array<{
        title: string;
        handle: string;
        featured_image_url?: string | null;
        image_url?: string | null;
      }> | null;
    },
    opts?: ApiFetchOptions & TopicClusterWaitOptions,
  ) {
    const { onProgress, intervalMs, maxWaitMs, ...fetchOpts } = opts ?? {};
    const res = await apiFetch<TopicClusterGenerateAllResponse | TopicClusterQueuedResponse>(
      `/api/projects/${projectId}/topic-clusters/${encodeURIComponent(clusterId)}/generate-all`,
      {
        method: "POST",
        body: JSON.stringify(body ?? {}),
        headers: { "Content-Type": "application/json" },
      },
      { timeoutMs: LONG_API_TIMEOUT_MS, ...fetchOpts },
    );
    if (isTopicClusterQueuedResponse(res)) {
      const cluster = await api.waitForTopicClusterReady(projectId, res.cluster_id, {
        onProgress,
        intervalMs,
        maxWaitMs,
        skipGlobalLoading: fetchOpts?.skipGlobalLoading,
      });
      return {
        ok: true,
        cluster,
        errors: cluster.generation_errors || [],
      };
    }
    return res as TopicClusterGenerateAllResponse;
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

  async articleQuota(projectId: string, opts?: ApiFetchOptions) {
    if (!opts?.fresh && !opts?.bypassClientCache) {
      const cached = cacheGet(_cacheArticleQuota, projectId, 30_000);
      if (cached) return await cached;
    } else if (opts?.fresh) {
      _cacheArticleQuota.delete(projectId);
    }
    const p = apiFetch<ArticleQuota>(`/api/projects/${projectId}/article-quota`, undefined, opts);
    cacheSetInflight(_cacheArticleQuota, projectId, p);
    try {
      const v = await p;
      cacheSetValue(_cacheArticleQuota, projectId, v);
      return v;
    } catch (e) {
      _cacheArticleQuota.delete(projectId);
      throw e;
    }
  },
  async projectFeatureLimits(projectId: string, opts?: ApiFetchOptions) {
    if (!opts?.fresh && !opts?.bypassClientCache) {
      const cached = cacheGet(_cacheFeatureLimits, projectId, 30_000);
      if (cached) return await cached;
    } else if (opts?.fresh) {
      _cacheFeatureLimits.delete(projectId);
    }
    const p = apiFetch<ProjectFeatureLimits>(`/api/projects/${projectId}/feature-limits`, undefined, opts);
    cacheSetInflight(_cacheFeatureLimits, projectId, p);
    try {
      const v = await p;
      cacheSetValue(_cacheFeatureLimits, projectId, v);
      return v;
    } catch (e) {
      _cacheFeatureLimits.delete(projectId);
      throw e;
    }
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
  async adminBulkUpdateUsers(
    items: Array<{ user_id: string; role?: string; subscription_type?: string; full_name?: string }>,
  ) {
    return apiFetch<{ updated: AdminUserPublic[]; errors: Array<{ user_id: string; error: string }> }>(
      "/api/admin/users/bulk-update",
      { method: "POST", body: JSON.stringify(items) },
    );
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
    }, { timeoutMs: LONG_API_TIMEOUT_MS });
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

  // ---------------------------------------------------------------------------
  // Collaboration — project-scoped
  // ---------------------------------------------------------------------------
  async lookupUserEmail(email: string): Promise<{ found: boolean; name?: string | null }> {
    const enc = encodeURIComponent(email.trim().toLowerCase());
    return apiFetch<{ found: boolean; name?: string | null }>(`/api/profile/lookup-email?email=${enc}`, undefined, { skipGlobalLoading: true });
  },
  async getProjectMembers(projectId: string): Promise<MembersResponse> {
    return apiFetch<MembersResponse>(`/api/projects/${projectId}/collaboration/members`, undefined, { skipGlobalLoading: true });
  },
  async inviteCollaborator(projectId: string, email: string, role: CollaboratorRole): Promise<InvitationPublic> {
    return apiFetch<InvitationPublic>(`/api/projects/${projectId}/collaboration/invite`, {
      method: "POST",
      body: JSON.stringify({ email, role }),
    });
  },
  async changeCollaboratorRole(projectId: string, collaboratorId: string, role: CollaboratorRole): Promise<CollaboratorPublic> {
    return apiFetch<CollaboratorPublic>(`/api/projects/${projectId}/collaboration/members/${collaboratorId}/role`, {
      method: "PATCH",
      body: JSON.stringify({ role }),
    });
  },
  async removeCollaborator(projectId: string, collaboratorId: string): Promise<void> {
    await apiFetch<unknown>(`/api/projects/${projectId}/collaboration/members/${collaboratorId}`, { method: "DELETE" });
  },
  async resendInvitation(projectId: string, invitationId: string): Promise<void> {
    await apiFetch<unknown>(`/api/projects/${projectId}/collaboration/invitations/${invitationId}/resend`, { method: "POST" });
  },
  async cancelInvitation(projectId: string, invitationId: string): Promise<void> {
    await apiFetch<unknown>(`/api/projects/${projectId}/collaboration/invitations/${invitationId}`, { method: "DELETE" });
  },
  async getProjectActivity(projectId: string): Promise<ActivityRecord[]> {
    return apiFetch<ActivityRecord[]>(`/api/projects/${projectId}/collaboration/activity`, undefined, { skipGlobalLoading: true });
  },

  // ---------------------------------------------------------------------------
  // Invitations — user-scoped
  // ---------------------------------------------------------------------------
  async getMyInvitations(): Promise<InvitationPublic[]> {
    return apiFetch<InvitationPublic[]>("/api/invitations", undefined, { skipGlobalLoading: true });
  },
  async acceptInvitation(invitationId: string): Promise<{ invitation: InvitationPublic; project: ProjectPublic | null }> {
    return apiFetch<{ invitation: InvitationPublic; project: ProjectPublic | null }>(`/api/invitations/${invitationId}/accept`, { method: "POST" });
  },
  async declineInvitation(invitationId: string): Promise<void> {
    await apiFetch<unknown>(`/api/invitations/${invitationId}/decline`, { method: "POST" });
  },
  async getInvitationByToken(token: string): Promise<InvitationPublic> {
    return apiFetch<InvitationPublic>(`/api/invitations/by-token/${encodeURIComponent(token)}`, undefined, { skipGlobalLoading: true });
  },

  // ---------------------------------------------------------------------------
  // Notifications
  // ---------------------------------------------------------------------------
  async getNotifications(): Promise<NotificationPublic[]> {
    return apiFetch<NotificationPublic[]>("/api/notifications", undefined, { skipGlobalLoading: true });
  },
  async getUnreadNotificationCount(): Promise<{ count: number }> {
    return apiFetch<{ count: number }>("/api/notifications/count", undefined, { skipGlobalLoading: true });
  },
  async markNotificationRead(notificationId: string): Promise<void> {
    await apiFetch<unknown>(`/api/notifications/${notificationId}/read`, { method: "PATCH" });
  },
  async markAllNotificationsRead(): Promise<void> {
    await apiFetch<unknown>("/api/notifications/read-all", { method: "POST" });
  },
};

