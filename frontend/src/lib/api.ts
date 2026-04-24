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

const API_BASE_URL = (process.env.NEXT_PUBLIC_API_BASE_URL || "http://127.0.0.1:8001").replace(/\/+$/, "");

function apiUrl(path: string) {
  if (!API_BASE_URL) return path;
  if (/^https?:\/\//.test(path)) return path;
  return `${API_BASE_URL}${path.startsWith("/") ? "" : "/"}${path}`;
}

const TOKEN_KEY = "aa_access_token";

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

function emitGlobalLoading(delta: number) {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new CustomEvent("aa:loading", { detail: { delta } }));
  } catch {
    // ignore
  }
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json");
  const token = getAccessToken();
  if (token) headers.set("authorization", `Bearer ${token}`);

  emitGlobalLoading(+1);
  try {
    const res = await fetch(apiUrl(path), { ...init, headers });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || `${res.status} ${res.statusText}`);
    }
    return (await res.json()) as T;
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
  async listProjects() {
    return apiFetch<ProjectPublic[]>("/api/projects");
  },
  async createProject(name: string, website_url?: string) {
    return apiFetch<ProjectPublic>("/api/projects", {
      method: "POST",
      body: JSON.stringify({ name, website_url: website_url || null }),
    });
  },
  async getProjectSettings(projectId: string) {
    return apiFetch<ProjectSettings>(`/api/projects/${projectId}/settings`);
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
    }>,
  ) {
    return apiFetch<ProjectSettings>(`/api/projects/${projectId}/settings`, { method: "PATCH", body: JSON.stringify(patch) });
  },
  async verifyWordpress(projectId: string, payload: Partial<{ wp_site_url: string; wp_username: string; wp_app_password: string }>) {
    return apiFetch<WordpressVerifyResponse>(`/api/projects/${projectId}/wordpress/verify`, { method: "POST", body: JSON.stringify(payload) });
  },
  async wordpressPostTypes(projectId: string) {
    return apiFetch<WordpressPostType[]>(`/api/projects/${projectId}/wordpress/post-types`);
  },
  async wordpressCategories(projectId: string) {
    return apiFetch<WordpressCategory[]>(`/api/projects/${projectId}/wordpress/categories`);
  },
  async listScheduledJobs(projectId: string) {
    return apiFetch<ScheduledJobPublic[]>(`/api/projects/${projectId}/scheduled-jobs`);
  },
  async cancelScheduledJob(projectId: string, jobId: string) {
    return apiFetch<{ ok: boolean }>(`/api/projects/${projectId}/scheduled-jobs/${jobId}`, { method: "DELETE" });
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

  async bulkUploadArticles(projectId: string, rows: BulkUploadRow[]) {
    return apiFetch<{ ok: true; created: number; skipped: number; articles: ArticlePublic[] }>(`/api/projects/${projectId}/articles/bulk-upload`, {
      method: "POST",
      body: JSON.stringify({ rows }),
    });
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

  async listWritingPrompts(projectId: string) {
    return apiFetch<PromptListResponse>(`/api/projects/${projectId}/prompts`);
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
    const headers = new Headers();
    headers.set("content-type", "application/json");
    const token = getAccessToken();
    if (token) headers.set("authorization", `Bearer ${token}`);
    emitGlobalLoading(+1);
    try {
      const res = await fetch(apiUrl(`/api/projects/${projectId}/prompts/${promptId}`), { method: "DELETE", headers });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `${res.status} ${res.statusText}`);
      }
      return { ok: true as const };
    } finally {
      emitGlobalLoading(-1);
    }
  },

  async listImagePrompts(projectId: string) {
    return apiFetch<PromptListResponse>(`/api/projects/${projectId}/image-prompts`);
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
    const headers = new Headers();
    headers.set("content-type", "application/json");
    const token = getAccessToken();
    if (token) headers.set("authorization", `Bearer ${token}`);
    emitGlobalLoading(+1);
    try {
      const res = await fetch(apiUrl(`/api/projects/${projectId}/image-prompts/${promptId}`), { method: "DELETE", headers });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `${res.status} ${res.statusText}`);
      }
      return { ok: true as const };
    } finally {
      emitGlobalLoading(-1);
    }
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
    const headers = new Headers();
    headers.set("content-type", "application/json");
    const token = getAccessToken();
    if (token) headers.set("authorization", `Bearer ${token}`);
    emitGlobalLoading(+1);
    try {
      const res = await fetch(apiUrl(`/api/projects/${projectId}/context-links/${linkId}`), { method: "DELETE", headers });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `${res.status} ${res.statusText}`);
      }
      return { ok: true as const };
    } finally {
      emitGlobalLoading(-1);
    }
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
    }>(`/api/projects/${projectId}/articles/${articleId}/generate`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
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
    );
  },

  async publishArticleToLiveSite(
    projectId: string,
    articleId: string,
    payload: { image_file?: File | null; post_type: string; wp_status: "draft" | "publish"; category_ids: number[] },
  ) {
    const token = getAccessToken();
    const headers = new Headers();
    if (token) headers.set("authorization", `Bearer ${token}`);
    const fd = new FormData();
    if (payload.image_file) fd.set("image_file", payload.image_file);
    fd.set("post_type", payload.post_type);
    fd.set("wp_status", payload.wp_status);
    fd.set("category_ids", payload.category_ids.join(","));
    emitGlobalLoading(+1);
    try {
      const res = await fetch(apiUrl(`/api/projects/${projectId}/articles/${articleId}/publish`), {
        method: "POST",
        headers,
        body: fd,
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `${res.status} ${res.statusText}`);
      }
      return (await res.json()) as {
        ok: boolean;
        status: string;
        message: string;
        wp_post_id?: number;
        wp_link?: string | null;
      };
    } finally {
      emitGlobalLoading(-1);
    }
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
    const headers = new Headers();
    headers.set("content-type", "application/json");
    const token = getAccessToken();
    if (token) headers.set("authorization", `Bearer ${token}`);
    emitGlobalLoading(+1);
    try {
      const res = await fetch(apiUrl(`/api/admin/users/${userId}`), { method: "DELETE", headers });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `${res.status} ${res.statusText}`);
      }
      return { ok: true as const };
    } finally {
      emitGlobalLoading(-1);
    }
  },
  async adminListPlans() {
    return apiFetch<PlanPublic[]>("/api/admin/plans");
  },
  async adminUpsertPlan(planKey: string, payload: Partial<PlanPublic>) {
    return apiFetch<PlanPublic>(`/api/admin/plans/${encodeURIComponent(planKey)}`, { method: "PUT", body: JSON.stringify(payload) });
  },
};

