import type { ProjectPublic } from "@/lib/api";

const STORAGE_KEY = "aa_dashboard_projects_v1";

type CachedProjects = {
  at: number;
  items: ProjectPublic[];
};

export function loadCachedProjects(): ProjectPublic[] | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedProjects;
    if (!parsed || !Array.isArray(parsed.items)) return null;
    return parsed.items;
  } catch {
    return null;
  }
}

export function saveCachedProjects(items: ProjectPublic[]) {
  if (typeof window === "undefined") return;
  try {
    const payload: CachedProjects = { at: Date.now(), items };
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    /* quota / private mode */
  }
}

export function cachedProjectsAgeMs(): number | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedProjects;
    return typeof parsed.at === "number" ? parsed.at : null;
  } catch {
    return null;
  }
}
