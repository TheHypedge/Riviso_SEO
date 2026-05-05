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
  created_at?: string | null;
  last_activity_at?: string | null;
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

export type PlanPublic = {
  key: string;
  name?: string | null;
  max_projects?: number | null;
  max_articles?: number | null;
  max_articles_per_day?: number | null;
  max_articles_per_month?: number | null;
  max_writing_prompts?: number | null;
  writing_prompt_char_limit?: number | null;
  max_image_prompts?: number | null;
  image_prompt_char_limit?: number | null;
  allow_scheduling?: boolean | null;
  allow_export?: boolean | null;
  allow_bulk_upload?: boolean | null;
};

export type ProfilePublic = {
  id: string;
  email: string;
  full_name?: string | null;
  phone?: string | null;
  timezone?: string | null;
  subscription_type?: string | null;
  created_at?: string | null;
};

export type ProjectPublic = {
  id: string;
  owner_user_id: string;
  name: string;
  website_url?: string | null;
};

export type ProjectSettings = {
  id: string;
  name: string;
  website_url?: string | null;
  wp_site_url?: string | null;
  wp_username?: string | null;
  wp_app_password_set: boolean;
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

export type GscSite = {
  siteUrl: string;
  permissionLevel?: string;
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

    if (res.status === 401 && path !== "/api/auth/login" && path !== "/api/auth/register" && path !== "/api/auth/refresh") {
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
  async cancelScheduledJob(projectId: string, jobId: string) {
    return apiFetch<{ ok: boolean }>(`/api/projects/${projectId}/scheduled-jobs/${jobId}`, { method: "DELETE" });
  },
  async clearScheduledJobs(projectId: string) {
    return apiFetch<{ ok: boolean; deleted: number }>(`/api/projects/${projectId}/scheduled-jobs`, { method: "DELETE" });
  },
  async updateScheduledJob(
    projectId: string,
    jobId: string,
    patch: Partial<{ run_at: string; post_type: string; wp_status: string; category_ids: number[] }>,
  ) {
    return apiFetch<ScheduledJobPublic>(`/api/projects/${projectId}/scheduled-jobs/${jobId}`, { method: "PATCH", body: JSON.stringify(patch) });
  },
  async listArticles(projectId: string) {
    return apiFetch<ArticlePublic[]>(`/api/projects/${projectId}/articles`);
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
    return apiFetch<{ ok: true; default_id: string }>(`/api/projects/${projectId}/prompts/default`, {
      method: "POST",
      body: JSON.stringify({ id }),
    });
  },

  async createWritingPrompt(projectId: string, payload: { name: string; text: string }) {
    return apiFetch<PromptItem>(`/api/projects/${projectId}/prompts`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  async updateWritingPrompt(projectId: string, promptId: string, payload: Partial<{ name: string; text: string }>) {
    return apiFetch<PromptItem>(`/api/projects/${projectId}/prompts/${promptId}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
  },

  async deleteWritingPrompt(projectId: string, promptId: string) {
    await apiFetch<unknown>(`/api/projects/${projectId}/prompts/${promptId}`, { method: "DELETE" });
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
    return apiFetch<{ ok: true; default_id: string }>(`/api/projects/${projectId}/image-prompts/default`, {
      method: "POST",
      body: JSON.stringify({ id }),
    });
  },

  async createImagePrompt(projectId: string, payload: { name: string; text: string }) {
    return apiFetch<PromptItem>(`/api/projects/${projectId}/image-prompts`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  async updateImagePrompt(projectId: string, promptId: string, payload: Partial<{ name: string; text: string }>) {
    return apiFetch<PromptItem>(`/api/projects/${projectId}/image-prompts/${promptId}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
  },

  async deleteImagePrompt(projectId: string, promptId: string) {
    await apiFetch<unknown>(`/api/projects/${projectId}/image-prompts/${promptId}`, { method: "DELETE" });
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
    return apiFetch<{ ok: boolean; status?: string }>(`/api/projects/${projectId}/articles/${articleId}/gsc/request-indexing`, {
      method: "POST",
    });
  },

  // Admin
  async adminListUsers() {
    return apiFetch<AdminUserPublic[]>("/api/admin/users");
  },
  async adminUpdateUser(userId: string, patch: Partial<{ role: string; subscription_type: string; full_name: string; phone: string; timezone: string }>) {
    return apiFetch<AdminUserPublic>(`/api/admin/users/${userId}`, { method: "PATCH", body: JSON.stringify(patch) });
  },
  async adminGetUserDetails(userId: string) {
    return apiFetch<AdminUserDetails>(`/api/admin/users/${userId}/details`);
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

