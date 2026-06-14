"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { DashboardNavIcon } from "@/components/DashboardNavIcon";
import { ShopifyManualConnectGuide } from "@/components/shopify/ShopifyManualConnectGuide";
import { TutorialStepperModal } from "@/components/TutorialStepperModal";
import { WorkspaceProjectOverview } from "@/components/WorkspaceProjectOverview";
import { DashboardProjectsSkeleton, DetailPanelSkeleton, FormFieldsSkeleton } from "@/components/skeleton";
import styles from "../page.module.css";
import dashStyles from "./dashboard.module.css";
import {
  AdminUserDetails,
  AdminUserPublic,
  AdminWorkspaceResponse,
  api,
  clearAuth,
  downloadWordpressPlugin,
  getAccessToken,
  invalidateProjectSettingsCache,
  PlanPublic,
  ProfilePublic,
  ProjectPlatform,
  ProjectPublic,
  ProjectSettings,
  WordpressVerifyResponse,
  WorkspaceOverviewResponse,
} from "@/lib/api";
import { cachedProjectsAgeMs, loadCachedProjects, saveCachedProjects } from "@/lib/projectsCache";
import { connectionErrorMessage, isAuthError, isNetworkError } from "@/lib/networkErrors";
import { useFocusTrap } from "@/lib/useFocusTrap";

type DashSection = "overview" | "projects" | "users" | "limits" | "profile";

const DASH_SECTIONS = new Set<DashSection>(["overview", "projects", "users", "limits", "profile"]);

function planComparable(p: PlanPublic) {
  return {
    key: p.key,
    name: p.name || "",
    is_default: Boolean(p.is_default),
    cost_monthly: Number(p.cost_monthly ?? 0),
    max_projects: Number(p.max_projects ?? 0),
    max_articles_per_day: Number(p.max_articles_per_day ?? 0),
    max_articles_per_month: Number(p.max_articles_per_month ?? 0),
    allow_export: Boolean(p.allow_export),
    max_export_per_month: Number(p.max_export_per_month ?? 0),
    allow_scheduling: Boolean(p.allow_scheduling),
    max_scheduled_per_month: Number(p.max_scheduled_per_month ?? 0),
    allow_bulk_upload: Boolean(p.allow_bulk_upload),
    max_cluster_plans_per_month: Number(p.max_cluster_plans_per_month ?? 0),
    max_custom_research_per_month: Number(p.max_custom_research_per_month ?? 0),
    max_context_links: Number(p.max_context_links ?? 0),
    max_article_image_regenerations: Number(p.max_article_image_regenerations ?? 0),
    is_trial_plan: Boolean(p.is_trial_plan),
    trial_period_days: Number(p.trial_period_days ?? 0),
  };
}

function plansFingerprint(items: PlanPublic[]) {
  return JSON.stringify(
    items
      .map(planComparable)
      .sort((a, b) => a.key.localeCompare(b.key)),
  );
}

export default function DashboardPage() {
  const router = useRouter();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [meEmail, setMeEmail] = useState<string>("");
  const [mePlan, setMePlan] = useState<string>("");
  const [meRole, setMeRole] = useState<string>("");
  const [projects, setProjects] = useState<ProjectPublic[]>([]);
  const [workspaceOverview, setWorkspaceOverview] = useState<WorkspaceOverviewResponse | null>(null);
  const [workspaceOverviewLoading, setWorkspaceOverviewLoading] = useState(false);
  const [workspaceOverviewError, setWorkspaceOverviewError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [website, setWebsite] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [isOnline, setIsOnline] = useState(true);
  const [dataMayBeStale, setDataMayBeStale] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [projectMenuOpen, setProjectMenuOpen] = useState<string | null>(null);
  const [section, setSection] = useState<DashSection>("projects");
  const [sectionReady, setSectionReady] = useState(false);
  const [showTutorial, setShowTutorial] = useState(false);
  const [showAddProject, setShowAddProject] = useState(false);
  const [addProjectStep, setAddProjectStep] = useState<"form" | "platform">("form");
  const [showWpConnect, setShowWpConnect] = useState(false);
  const [wpProject, setWpProject] = useState<ProjectPublic | null>(null);
  const [wpSettings, setWpSettings] = useState<ProjectSettings | null>(null);
  const [wpUsername, setWpUsername] = useState("");
  const [wpAppPassword, setWpAppPassword] = useState("");
  const [wpVerify, setWpVerify] = useState<WordpressVerifyResponse | null>(null);
  const [wpVerifying, setWpVerifying] = useState(false);
  const [showShopifyConnect, setShowShopifyConnect] = useState(false);
  const [shopifyProject, setShopifyProject] = useState<ProjectPublic | null>(null);
  const [shopifyShopUrl, setShopifyShopUrl] = useState("");
  const [shopifyClientId, setShopifyClientId] = useState("");
  const [shopifyClientSecret, setShopifyClientSecret] = useState("");
  const [shopifyVerify, setShopifyVerify] = useState<{ ok: boolean; message: string } | null>(null);
  const [shopifyConnecting, setShopifyConnecting] = useState(false);
  const [deleteUserTarget, setDeleteUserTarget] = useState<{ id: string; name: string } | null>(null);
  const [wpPluginError, setWpPluginError] = useState<string | null>(null);

  // Admin modules — users
  const [savedUsers, setSavedUsers] = useState<AdminUserPublic[]>([]);
  const [userEdits, setUserEdits] = useState<Record<string, { role?: string; subscription_type?: string; full_name?: string }>>({});
  const [usersLoading, setUsersLoading] = useState(false);
  const [usersSaving, setUsersSaving] = useState(false);
  const [usersSuccessMsg, setUsersSuccessMsg] = useState<string | null>(null);
  const usersSuccessTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showUsersLeaveModal, setShowUsersLeaveModal] = useState(false);
  const [usersLeavePending, setUsersLeavePending] = useState<(() => void) | null>(null);
  const usersLeaveModalTrapRef = useFocusTrap(showUsersLeaveModal);
  const [userDetails, setUserDetails] = useState<AdminUserDetails | null>(null);
  const [userDetailsLoading, setUserDetailsLoading] = useState(false);
  const [userWorkspace, setUserWorkspace] = useState<AdminWorkspaceResponse | null>(null);
  const [userWorkspaceLoading, setUserWorkspaceLoading] = useState(false);
  const [plans, setPlans] = useState<PlanPublic[]>([]);
  const [savedPlans, setSavedPlans] = useState<PlanPublic[]>([]);
  const [plansLoading, setPlansLoading] = useState(false);
  const [plansSaving, setPlansSaving] = useState(false);
  const [profile, setProfile] = useState<ProfilePublic | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileClockTick, setProfileClockTick] = useState(0);

  function normalizeTimeZoneId(tz: string) {
    const raw = (tz || "").trim();
    if (!raw) return "";
    // Keep frontend display aligned with backend normalization + IANA canonical IDs.
    if (raw === "Asia/Calcutta") return "Asia/Kolkata";
    return raw;
  }

  const browserTimeZone = useMemo(() => {
    try {
      return normalizeTimeZoneId(Intl.DateTimeFormat().resolvedOptions().timeZone || "");
    } catch {
      return "";
    }
  }, []);

  const timeZoneOptions = useMemo(() => {
    const intlAny = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
    const raw = typeof intlAny.supportedValuesOf === "function" ? intlAny.supportedValuesOf("timeZone") : [];
    const list = Array.isArray(raw) && raw.length ? raw : [browserTimeZone, "UTC"].filter(Boolean);
    const uniq = Array.from(new Set(list.filter(Boolean)));
    uniq.sort((a, b) => a.localeCompare(b));
    if (browserTimeZone && !uniq.includes(browserTimeZone)) uniq.unshift(browserTimeZone);
    if (!uniq.includes("UTC")) uniq.push("UTC");
    return uniq;
  }, [browserTimeZone]);

  const users = useMemo(
    () => savedUsers.map((u) => ({ ...u, ...(userEdits[u.id] ?? {}) })),
    [savedUsers, userEdits],
  );

  const usersDirty = useMemo(() => Object.keys(userEdits).length > 0, [userEdits]);
  const usersDirtyCount = useMemo(() => Object.keys(userEdits).length, [userEdits]);

  const plansDirty = useMemo(
    () => plansFingerprint(plans) !== plansFingerprint(savedPlans),
    [plans, savedPlans],
  );

  // Limits module (create new plan)
  const [newPlanKey, setNewPlanKey] = useState("");
  const [newPlanName, setNewPlanName] = useState("");
  const [newPlanMaxProjects, setNewPlanMaxProjects] = useState<number>(2);
  const [newPlanMaxArticlesPerDay, setNewPlanMaxArticlesPerDay] = useState<number>(0);
  const [newPlanMaxArticlesPerMonth, setNewPlanMaxArticlesPerMonth] = useState<number>(0);
  const [newPlanAllowExport, setNewPlanAllowExport] = useState<boolean>(true);
  const [newPlanMaxExportPerMonth, setNewPlanMaxExportPerMonth] = useState<number>(0);
  const [newPlanAllowScheduling, setNewPlanAllowScheduling] = useState<boolean>(true);
  const [newPlanMaxScheduledPerMonth, setNewPlanMaxScheduledPerMonth] = useState<number>(0);
  const [newPlanMaxClusterPlansPerMonth, setNewPlanMaxClusterPlansPerMonth] = useState<number>(0);
  const [newPlanMaxCustomResearchPerMonth, setNewPlanMaxCustomResearchPerMonth] = useState<number>(0);
  const [newPlanMaxContextLinks, setNewPlanMaxContextLinks] = useState<number>(10);
  const [newPlanMaxArticleImageRegenerations, setNewPlanMaxArticleImageRegenerations] = useState<number>(3);
  const [newPlanCostMonthly, setNewPlanCostMonthly] = useState<number>(0);
  const [newPlanIsDefault, setNewPlanIsDefault] = useState<boolean>(false);
  const [newPlanIsTrialPlan, setNewPlanIsTrialPlan] = useState<boolean>(false);
  const [newPlanTrialPeriodDays, setNewPlanTrialPeriodDays] = useState<number>(14);

  const token = useMemo(() => getAccessToken(), []);
  const isAdmin = (meRole || "").trim().toLowerCase() === "admin";

  const addProjectTrapRef = useFocusTrap(showAddProject);
  const shopifyConnectTrapRef = useFocusTrap(showShopifyConnect && !!shopifyProject);
  const wpConnectTrapRef = useFocusTrap(showWpConnect && !!wpProject);
  const userDetailsTrapRef = useFocusTrap(!!(userDetailsLoading || userDetails));
  const workspaceTrapRef = useFocusTrap(!!(userWorkspaceLoading || userWorkspace));
  const deleteUserTrapRef = useFocusTrap(!!deleteUserTarget);

  function normalizePlatform(p: ProjectPublic | null | undefined): ProjectPlatform {
    const raw = ((p?.platform || "") as string).trim().toLowerCase();
    return raw === "shopify" ? "shopify" : "wordpress";
  }

  const PlatformIcon = {
    WordPress: (props: { className?: string }) => (
      <svg viewBox="0 0 32 32" aria-hidden="true" className={props.className}>
        <circle cx="16" cy="16" r="15" fill="currentColor" opacity="0.16" />
        <path
          d="M16 6.3c-5.36 0-9.7 4.34-9.7 9.7 0 4.28 2.76 7.9 6.6 9.18L8.9 14.6c-.37-.9.29-1.88 1.25-1.88h.7l3.25 8.95 2-6.03-1.38-3.8c-.28-.77.3-1.6 1.12-1.6h.28c.76 0 1.34.74 1.12 1.46l-.65 2.02 2.22 6.06 2.05-6.4c.26-.81.07-1.55-.16-2.04-.19-.38-.6-.98-.6-1.48 0-.58.44-1.12 1.07-1.12.05 0 .1.01.15.01A9.67 9.67 0 0 0 16 6.3Zm0 19.4c-1.06 0-2.07-.18-3.01-.5l3.2-9.29 3.16 9.18c.01.03.03.06.04.09-.98.33-2.03.52-3.39.52Zm4.73-1.07-2.6-7.1 2.38-7.09c.22-.69.9-1.12 1.62-1.03.44.91.7 1.94.7 3.03 0 4.14-2.6 7.66-6.24 9.19.05.02.1.04.14.06Z"
          fill="currentColor"
        />
        <circle cx="16" cy="16" r="14.5" fill="none" stroke="currentColor" opacity="0.28" />
      </svg>
    ),
    Shopify: (props: { className?: string }) => (
      <svg viewBox="0 0 32 32" aria-hidden="true" className={props.className}>
        <path
          d="M8.8 10.9 16 8.6l7.2 2.3c.4.1.7.5.7.9l-1.3 15.3c0 .5-.5.9-1 .9H10.4c-.5 0-.9-.4-1-.9L8.1 11.8c0-.4.3-.8.7-.9Z"
          fill="currentColor"
          opacity="0.16"
        />
        <path
          d="M20.3 12.6c-.2-1.3-1-2.3-2-2.7.1-.2.1-.5.1-.7 0-1.5-.8-2.4-1.7-2.4-.7 0-1.2.6-1.5 1.3-.3-.1-.6-.1-.9 0-.7.3-1.1 1.2-1.3 2.4-.6.2-1.2.4-1.8.6l-.3 3.1c.6-.2 1.2-.4 1.8-.6 0 .2 0 .4 0 .6 0 2.3 1.5 3.7 3.8 3.7 1.4 0 2.6-.4 3.5-.9l.3-3.1c-.8.6-2 1.1-3.2 1.1-1.1 0-1.8-.5-1.8-1.6 0-.3 0-.6.1-.9 1.7-.5 3.2-1 4.8-1.4Zm-4.2-1.1c.1-.6.2-1 .3-1.4.2-.6.4-.8.6-.9.2.2.4.6.4 1.2 0 .1 0 .2 0 .3-.4.1-.9.3-1.3.4Z"
          fill="currentColor"
        />
        <path
          d="M23.4 10.2 16 7.8l-7.4 2.4c-.9.3-1.5 1.1-1.4 2l1.3 15.3c.1 1.1 1 2 2.1 2h11.2c1.1 0 2-.9 2.1-2L24.8 12c.1-.9-.5-1.7-1.4-2Zm-.6 17.2c0 .6-.5 1.1-1.1 1.1H10.3c-.6 0-1.1-.5-1.1-1.1L7.9 12.1c0-.5.3-.9.7-1.1L16 8.7l7.4 2.3c.4.1.7.6.7 1.1l-1.3 15.3Z"
          fill="currentColor"
          opacity="0.28"
        />
      </svg>
    ),
  };

  // Default section matches SSR; sync from ?section= after hydration (see project page tab pattern).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const raw = (params.get("section") || "projects") as DashSection;
    let next: DashSection = DASH_SECTIONS.has(raw) ? raw : "projects";
    if (!isAdmin && (next === "users" || next === "limits")) next = "projects";
    /* eslint-disable react-hooks/set-state-in-effect -- one-time URL → section sync; avoids SSR window mismatch */
    setSection((prev) => (prev === next ? prev : next));
    setSectionReady(true);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [isAdmin]);

  function canAccessSection(next: DashSection) {
    if (next === "users" || next === "limits") return isAdmin;
    return true;
  }

  const doGoSection = useCallback((next: DashSection) => {
    const target = canAccessSection(next) ? next : "projects";
    setSection(target);
    setMobileNavOpen(false);
    router.push(
      target === "projects" ? "/dashboard" : target === "overview" ? "/dashboard?section=overview" : `/dashboard?section=${target}`,
    );
  }, [canAccessSection, router]);

  function goSection(next: DashSection) {
    if (section === "users" && usersDirty) {
      setUsersLeavePending(() => () => doGoSection(next));
      setShowUsersLeaveModal(true);
      return;
    }
    doGoSection(next);
  }

  const Icon = {
    Menu: (props: { className?: string }) => (
      <svg viewBox="0 0 24 24" aria-hidden="true" className={props.className}>
        <path d="M4 6.5h16M4 12h16M4 17.5h16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    ),
    X: (props: { className?: string }) => (
      <svg viewBox="0 0 24 24" aria-hidden="true" className={props.className}>
        <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    ),
  };

  useEffect(() => {
    if (typeof window === "undefined") return;
    setIsOnline(navigator.onLine);
    const onOnline = () => {
      setIsOnline(true);
      setError(null);
      void reloadProjects({ silent: true, fresh: true });
      if (section === "overview") void reloadWorkspaceOverview();
    };
    const onOffline = () => setIsOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, section]);

  useEffect(() => {
    if (!token) {
      router.replace("/");
      return;
    }
    const cached = loadCachedProjects();
    if (cached?.length) {
      setProjects(cached);
      const age = cachedProjectsAgeMs();
      if (age) setLastSyncedAt(age);
    }
    (async () => {
      setError(null);
      setLoading(true);
      try {
        const me = await api.me({ fresh: true, skipGlobalLoading: true });
        setMeEmail(me.email);
        setMePlan(me.subscription_type || "beta");
        const role = me.role || "user";
        setMeRole(role);
        if (role.trim().toLowerCase() !== "admin") {
          const params = new URLSearchParams(window.location.search);
          const requestedSection = (params.get("section") || "projects") as DashSection;
          if (requestedSection === "users" || requestedSection === "limits") {
            setSection("projects");
            router.replace("/dashboard");
          }
        }
        const items = await api.listProjects({ fresh: true, skipGlobalLoading: true });
        setProjects(items);
        saveCachedProjects(items);
        setLastSyncedAt(Date.now());
        setDataMayBeStale(false);
      } catch (e) {
        if (isAuthError(e)) {
          clearAuth();
          router.replace("/");
          return;
        }
        setDataMayBeStale(true);
        setError(connectionErrorMessage(e));
        if (!cached?.length) {
          setProjects([]);
        }
      } finally {
        setLoading(false);
      }
    })();
  }, [router, token]);

  async function reloadProjects(opts?: { silent?: boolean; fresh?: boolean }) {
    if (!token) return;
    if (!navigator.onLine) {
      setDataMayBeStale(true);
      setError("You are offline. Reconnect to Wi‑Fi, then refresh.");
      return;
    }
    if (opts?.silent) setRefreshing(true);
    else setLoading(true);
    try {
      const items = await api.listProjects({
        fresh: opts?.fresh !== false,
        skipGlobalLoading: true,
      });
      setProjects(items);
      saveCachedProjects(items);
      setLastSyncedAt(Date.now());
      setDataMayBeStale(false);
      setError(null);
    } catch (e) {
      if (isAuthError(e)) {
        clearAuth();
        router.replace("/");
        return;
      }
      setDataMayBeStale(true);
      setError(connectionErrorMessage(e));
    } finally {
      if (opts?.silent) setRefreshing(false);
      else setLoading(false);
    }
  }

  async function reloadWorkspaceOverview() {
    if (!token || !navigator.onLine) return;
    setWorkspaceOverviewLoading(true);
    setWorkspaceOverviewError(null);
    try {
      const data = await api.workspaceOverview({ fresh: true, skipGlobalLoading: true });
      setWorkspaceOverview(data);
    } catch (e) {
      setWorkspaceOverview(null);
      setWorkspaceOverviewError(connectionErrorMessage(e));
    } finally {
      setWorkspaceOverviewLoading(false);
    }
  }

  // If a project is renamed inside `/projects/[id]`, Next may keep this page mounted.
  // Refresh the list on focus/visibility so the dashboard always shows the latest name.
  useEffect(() => {
    if (!token) return;
    const onFocus = () => void reloadProjects({ silent: true, fresh: true });
    const onVis = () => {
      if (document.visibilityState === "visible") void reloadProjects({ silent: true, fresh: true });
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVis);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(() => {
    if (!token) return;
    const id = window.setInterval(() => {
      if (document.visibilityState !== "visible" || !navigator.onLine) return;
      void reloadProjects({ silent: true, fresh: true });
    }, 90_000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(() => {
    if (!token || section !== "overview") return;
    void reloadWorkspaceOverview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section, token]);

  // Per-project GSC flow now redirects directly to /projects/{id}?tab=tools, so the
  // dashboard no longer needs to handle Search Console OAuth callbacks. If a stale
  // hash is present on this page (older clients/links), strip it silently.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const url = new URL(window.location.href);
      const rawHash = (url.hash || "").replace(/^#/, "");
      const hashParams = new URLSearchParams(rawHash);
      const flag = (hashParams.get("gsc") || "").trim();
      if (flag === "connected" || flag === "error") {
        url.hash = "";
        window.history.replaceState({}, "", url.toString());
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    if (!token) return;
    (async () => {
      setError(null);
      try {
        if (section === "users" && isAdmin) {
          setUsersLoading(true);
          setPlansLoading(true);
          const [userItems, planItems] = await Promise.all([
            api.adminListUsers(),
            api.adminListPlans(),
          ]);
          setSavedUsers(userItems);
          setUserEdits({});
          setPlans(planItems);
          setSavedPlans(planItems);
        } else if (section === "limits" && isAdmin) {
          setPlansLoading(true);
          const items = await api.adminListPlans();
          setPlans(items);
          setSavedPlans(items);
        } else if (section === "profile") {
          setProfileLoading(true);
          const me = await api.profileMe();
          setProfile({
            ...me,
            timezone: normalizeTimeZoneId(me.timezone || browserTimeZone || "").trim() || null,
          });
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load admin module");
      } finally {
        setUsersLoading(false);
        setPlansLoading(false);
        setProfileLoading(false);
      }
    })();
  }, [browserTimeZone, isAdmin, section, token]);

  useEffect(() => {
    if (!usersDirty || section !== "users") return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [usersDirty, section]);

  useEffect(() => {
    if (section !== "profile") return;
    const id = window.setInterval(() => setProfileClockTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, [section]);

  function formatWallClockInTz(tz: string | null | undefined, tick: number) {
    void tick;
    const z = ((tz || "").trim() || "UTC").trim();
    try {
      return new Intl.DateTimeFormat("en-CA", {
        timeZone: z,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      })
        .format(new Date())
        .replace(",", "");
    } catch {
      return "—";
    }
  }

  function openAddProject() {
    setError(null);
    setAddProjectStep("form");
    setShowAddProject(true);
  }

  function closeAddProject() {
    setShowAddProject(false);
    setAddProjectStep("form");
  }

  function openShopifyConnect(project: ProjectPublic) {
    setShopifyProject(project);
    setShopifyShopUrl((project.website_url || "").trim());
    setShopifyVerify(null);
    setShopifyClientId("");
    setShopifyClientSecret("");
    setShowShopifyConnect(true);
  }

  function closeShopifyConnect() {
    setShowShopifyConnect(false);
    setShopifyProject(null);
    setShopifyShopUrl("");
    setShopifyClientId("");
    setShopifyClientSecret("");
    setShopifyVerify(null);
  }

  function closeWpConnect() {
    setShowWpConnect(false);
    setWpPluginError(null);
  }

  async function refreshProjectInList(projectId: string) {
    try {
      const fresh = await api.getProject(projectId, { skipGlobalLoading: true });
      setProjects((prev) => prev.map((x) => (x.id === projectId ? { ...x, ...fresh } : x)));
    } catch {
      /* keep prior list state */
    }
  }

  async function createProjectWithPlatform(platform: ProjectPlatform) {
    setError(null);
    setCreating(true);
    try {
      let p = await api.createProject(name, platform, website);
      const plat = (platform || "wordpress").trim().toLowerCase();
      if ((p.platform || "").toLowerCase() !== plat) {
        p = await api.updateProject(p.id, { platform: plat }, { skipGlobalLoading: true });
      }
      setProjects((prev) => [{ ...p, platform: plat }, ...prev]);
      setName("");
      setWebsite("");
      closeAddProject();

      if (plat === "shopify") {
        invalidateProjectSettingsCache(p.id);
        openShopifyConnect({ ...p, platform: "shopify" });
        return;
      }

      setWpProject(p);
      setWpVerify(null);
      setWpUsername("");
      setWpAppPassword("");
      try {
        const settings = await api.getProjectSettings(p.id);
        setWpSettings(settings);
      } catch {
        setWpSettings(null);
      }
      setShowWpConnect(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create project");
    } finally {
      setCreating(false);
    }
  }

  function logout() {
    clearAuth();
    router.replace("/");
  }

  function updateUserField(userId: string, field: "role" | "subscription_type" | "full_name", value: string) {
    const original = savedUsers.find((u) => u.id === userId);
    setUserEdits((prev) => {
      const existing = prev[userId] ?? {};
      const next = { ...existing, [field]: value };
      // If the new value matches the original, drop that field from edits
      if (original && original[field] === value) {
        delete next[field];
      }
      if (Object.keys(next).length === 0) {
        const { [userId]: _, ...rest } = prev;
        return rest;
      }
      return { ...prev, [userId]: next };
    });
  }

  function discardUserChanges() {
    setUserEdits({});
  }

  function showUsersSuccess(msg: string) {
    if (usersSuccessTimerRef.current) clearTimeout(usersSuccessTimerRef.current);
    setUsersSuccessMsg(msg);
    usersSuccessTimerRef.current = setTimeout(() => setUsersSuccessMsg(null), 4000);
  }

  async function saveAllUsers() {
    if (!usersDirty || usersSaving) return;
    setError(null);
    setUsersSaving(true);
    try {
      const items = Object.entries(userEdits).map(([user_id, edits]) => ({ user_id, ...edits }));
      const res = await api.adminBulkUpdateUsers(items);
      setSavedUsers((prev) => {
        const byId = new Map(res.updated.map((u) => [u.id, u]));
        return prev.map((u) => byId.get(u.id) ?? u);
      });
      setUserEdits({});
      const errCount = res.errors.length;
      showUsersSuccess(
        errCount > 0
          ? `${res.updated.length} user${res.updated.length !== 1 ? "s" : ""} saved — ${errCount} failed`
          : `${res.updated.length} user${res.updated.length !== 1 ? "s" : ""} saved successfully`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save users");
    } finally {
      setUsersSaving(false);
    }
  }

  async function viewUserDetails(userId: string) {
    setError(null);
    setUserDetails(null);
    setUserDetailsLoading(true);
    try {
      const d = await api.adminGetUserDetails(userId);
      setUserDetails(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load user details");
    } finally {
      setUserDetailsLoading(false);
    }
  }

  async function openUserWorkspace(userId: string) {
    setError(null);
    setUserWorkspace(null);
    setUserWorkspaceLoading(true);
    setUserDetails(null);
    setUserDetailsLoading(false);
    try {
      const w = await api.adminGetUserWorkspace(userId);
      setUserWorkspace(w);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load workspace");
    } finally {
      setUserWorkspaceLoading(false);
    }
  }

  function closeUserWorkspace() {
    setUserWorkspace(null);
    setUserWorkspaceLoading(false);
  }

  function promptDeleteUser(user: AdminUserPublic) {
    setDeleteUserTarget({ id: user.id, name: user.full_name || user.email });
  }

  async function confirmDeleteUser() {
    if (!deleteUserTarget) return;
    setError(null);
    try {
      await api.adminDeleteUser(deleteUserTarget.id);
      setSavedUsers((prev) => prev.filter((u) => u.id !== deleteUserTarget.id));
      setUserEdits((prev) => { const { [deleteUserTarget.id]: _, ...rest } = prev; return rest; });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to deactivate user");
    } finally {
      setDeleteUserTarget(null);
    }
  }

  async function upsertPlan(key: string, patch: Partial<PlanPublic>) {
    setError(null);
    try {
      const saved = await api.adminUpsertPlan(key, patch);
      setPlans((prev) => {
        const exists = prev.some((p) => p.key === saved.key);
        return exists ? prev.map((p) => (p.key === saved.key ? saved : p)) : [saved, ...prev];
      });
      setSavedPlans((prev) => {
        const exists = prev.some((p) => p.key === saved.key);
        return exists ? prev.map((p) => (p.key === saved.key ? saved : p)) : [saved, ...prev];
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save plan");
    }
  }

  async function saveAllPlans() {
    if (!plansDirty || plansSaving) return;
    setError(null);
    setPlansSaving(true);
    try {
      const saved: PlanPublic[] = [];
      for (const p of plans) {
        saved.push(await api.adminUpsertPlan(p.key, p));
      }
      saved.sort((a, b) => a.key.localeCompare(b.key));
      setPlans(saved);
      setSavedPlans(saved);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save plan changes");
    } finally {
      setPlansSaving(false);
    }
  }

  function updatePlanDraft(key: string, patch: Partial<PlanPublic>) {
    setPlans((prev) => prev.map((p) => (p.key === key ? { ...p, ...patch } : p)));
  }

  function updateDefaultPlanDraft(key: string, checked: boolean) {
    setPlans((prev) =>
      prev.map((p) =>
        p.key === key
          ? { ...p, is_default: checked }
          : checked
            ? { ...p, is_default: false }
            : p,
      ),
    );
  }

  function updateTrialPlanDraft(key: string, checked: boolean) {
    setPlans((prev) =>
      prev.map((p) =>
        p.key === key
          ? { ...p, is_trial_plan: checked, trial_period_days: checked ? p.trial_period_days || 14 : 0 }
          : checked
            ? { ...p, is_trial_plan: false }
            : p,
      ),
    );
  }

  async function createPlan() {
    const key = newPlanKey.trim().toLowerCase();
    if (!key) return;
    await upsertPlan(key, {
      key,
      name: newPlanName.trim() || key,
      is_default: newPlanIsDefault,
      cost_monthly: newPlanCostMonthly,
      max_projects: newPlanMaxProjects,
      max_articles_per_day: newPlanMaxArticlesPerDay,
      max_articles_per_month: newPlanMaxArticlesPerMonth,
      allow_export: newPlanAllowExport,
      max_export_per_month: newPlanAllowExport ? newPlanMaxExportPerMonth : 0,
      allow_scheduling: newPlanAllowScheduling,
      max_scheduled_per_month: newPlanAllowScheduling ? newPlanMaxScheduledPerMonth : 0,
      max_cluster_plans_per_month: newPlanMaxClusterPlansPerMonth,
      max_custom_research_per_month: newPlanMaxCustomResearchPerMonth,
      max_context_links: newPlanMaxContextLinks,
      max_article_image_regenerations: newPlanMaxArticleImageRegenerations,
      is_trial_plan: newPlanIsTrialPlan,
      trial_period_days: newPlanIsTrialPlan ? newPlanTrialPeriodDays : 0,
    });
    setNewPlanKey("");
    setNewPlanName("");
    setNewPlanMaxProjects(2);
    setNewPlanMaxArticlesPerDay(0);
    setNewPlanMaxArticlesPerMonth(0);
    setNewPlanAllowExport(true);
    setNewPlanMaxExportPerMonth(0);
    setNewPlanAllowScheduling(true);
    setNewPlanMaxScheduledPerMonth(0);
    setNewPlanMaxClusterPlansPerMonth(0);
    setNewPlanMaxCustomResearchPerMonth(0);
    setNewPlanMaxContextLinks(10);
    setNewPlanMaxArticleImageRegenerations(3);
    setNewPlanCostMonthly(0);
    setNewPlanIsDefault(false);
    setNewPlanIsTrialPlan(false);
    setNewPlanTrialPeriodDays(14);
  }

  async function saveProfile() {
    if (!profile) return;
    setError(null);
    try {
      const saved = await api.updateProfileMe({
        full_name: profile.full_name || "",
        phone: profile.phone || "",
        timezone: profile.timezone || "",
      });
      setProfile(saved);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save profile");
    }
  }

  return (
    <div className={`${styles.page} ${styles.pageTop} ${dashStyles.dashboardDark}`}>
      <main className={`${styles.main} ${styles.mainWide}`}>
        <div className={styles.mobileTopBar}>
          <button type="button" className={styles.mobileMenuBtn} onClick={() => setMobileNavOpen(true)} aria-label="Open menu">
            <Icon.Menu className={styles.icon20} />
          </button>
          <div className={styles.mobileTopTitle}>Dashboard</div>
        </div>

        <div className={styles.shell}>
          {mobileNavOpen ? <button type="button" className={styles.sidebarOverlay} aria-label="Close menu" onClick={() => setMobileNavOpen(false)} /> : null}
          <aside className={`${styles.sidebar} ${mobileNavOpen ? styles.sidebarOpen : ""}`}>
            <div className={styles.sidebarMobileHead}>
              <div className={styles.sidebarMobileTitle}>Menu</div>
              <button type="button" className={styles.iconButton} onClick={() => setMobileNavOpen(false)} aria-label="Close menu">
                <Icon.X className={styles.icon20} />
              </button>
            </div>
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
            <div className={`${styles.sidebarNavMain} ${dashStyles.sidebarNavCompact}`}>
              <div className={styles.sidebarTitle}>{isAdmin ? "Admin" : "Workspace"}</div>
              <div className={styles.navGroup}>
                <button
                  type="button"
                  className={`${styles.navItem} ${section === "overview" ? styles.navItemActive : ""}`}
                  onClick={() => goSection("overview")}
                >
                  <DashboardNavIcon nav="overview" className={styles.navItemIcon} />
                  <span className={styles.navItemLabel}>Project overview</span>
                </button>
                <button
                  type="button"
                  className={`${styles.navItem} ${section === "projects" ? styles.navItemActive : ""}`}
                  onClick={() => goSection("projects")}
                >
                  <DashboardNavIcon nav="projects" className={styles.navItemIcon} />
                  <span className={styles.navItemLabel}>Project management</span>
                </button>
                {isAdmin ? (
                  <>
                    <button
                      type="button"
                      className={`${styles.navItem} ${section === "users" ? styles.navItemActive : ""}`}
                      onClick={() => goSection("users")}
                    >
                      <DashboardNavIcon nav="users" className={styles.navItemIcon} />
                      <span className={styles.navItemLabel}>Manage users</span>
                    </button>
                    <button
                      type="button"
                      className={`${styles.navItem} ${section === "limits" ? styles.navItemActive : ""}`}
                      onClick={() => goSection("limits")}
                    >
                      <DashboardNavIcon nav="limits" className={styles.navItemIcon} />
                      <span className={styles.navItemLabel}>System limitations</span>
                    </button>
                  </>
                ) : null}
              </div>
            </div>

            <div className={`${styles.sidebarFooter} ${dashStyles.sidebarFooterCompact}`}>
              <div className={styles.sidebarTitle}>Account</div>
              <div className={styles.navGroup} style={{ marginBottom: 0 }}>
                <button
                  type="button"
                  className={`${styles.navItem} ${section === "profile" ? styles.navItemActive : ""}`}
                  onClick={() => goSection("profile")}
                >
                  <DashboardNavIcon nav="profile" className={styles.navItemIcon} />
                  <span className={styles.navItemLabel}>User profile</span>
                </button>
                <button
                  type="button"
                  className={styles.navItem}
                  onClick={() => {
                    setMobileNavOpen(false);
                    setShowTutorial(true);
                  }}
                >
                  <DashboardNavIcon nav="tutorial" className={styles.navItemIcon} />
                  <span className={styles.navItemLabel}>Watch tutorial</span>
                </button>
                <button
                  type="button"
                  className={styles.navItem}
                  onClick={() => {
                    setMobileNavOpen(false);
                    logout();
                  }}
                >
                  <DashboardNavIcon nav="logout" className={styles.navItemIcon} />
                  <span className={styles.navItemLabel}>Logout</span>
                </button>
              </div>

              <div className={styles.sidebarAccountCard} aria-label="Signed-in account">
                <div className={styles.sidebarAvatar} aria-hidden="true">
                  {(meEmail || "U").trim().charAt(0).toUpperCase()}
                </div>
                <div className={styles.sidebarAccountMeta}>
                  <div className={styles.sidebarAccountEmail} title={meEmail || "Signed in"}>
                    {meEmail || "Signed in"}
                  </div>
                  <div className={styles.sidebarAccountPlan}>
                    Plan: {(mePlan || "beta").trim() || "beta"}
                  </div>
                </div>
              </div>
            </div>

          </aside>

          <section className={styles.contentCol}>
            <div role="status" aria-live="polite" aria-atomic="true">
              {error ? <div className={styles.error}>{error}</div> : null}
              {!isOnline ? (
                <div className={styles.error} style={{ marginBottom: 12 }}>
                  You are offline. Data below may be outdated until your connection is restored.
                </div>
              ) : null}
            </div>
            {dataMayBeStale && isOnline && !error ? (
              <div className={styles.muted} style={{ marginBottom: 12, fontSize: 13, lineHeight: 1.5 }}>
                Showing last known project list
                {lastSyncedAt
                  ? ` from ${new Date(lastSyncedAt).toLocaleString()}`
                  : ""}
                .{" "}
                <button
                  type="button"
                  className={styles.btnSecondary}
                  style={{ marginLeft: 6, padding: "2px 10px", fontSize: 12 }}
                  onClick={() => void reloadProjects({ fresh: true })}
                >
                  Refresh now
                </button>
              </div>
            ) : null}

            {section === "overview" ? (
              <>
                <div className={styles.intro}>
                  <h1>Project overview</h1>
                  <p>Content operations across all projects — upcoming schedules, recent posts, and queues.</p>
                </div>
                <WorkspaceProjectOverview
                  data={workspaceOverview}
                  loading={!sectionReady || (workspaceOverviewLoading && !workspaceOverview)}
                  error={workspaceOverviewError}
                  styles={dashStyles as unknown as Record<string, string>}
                  onGoProjects={() => goSection("projects")}
                  onOpenTutorial={() => setShowTutorial(true)}
                />
              </>
            ) : null}

            {section === "projects" ? (
              <>
                <div className={styles.intro}>
                  <h1>Projects</h1>
                  <p>Create and manage projects from your workspace.</p>
                </div>

                <div className={`${styles.card} ${styles.cardWide}`}>
                  <div className={dashStyles.cardHeaderRow}>
                    <div className={dashStyles.cardHeaderTitleGroup}>
                      <div className={dashStyles.cardHeaderTitle}>Projects</div>
                      <div className={dashStyles.mutedCount}>
                        {loading
                          ? "Loading…"
                          : `${projects.length} total${
                              lastSyncedAt && !dataMayBeStale
                                ? ` · synced ${new Date(lastSyncedAt).toLocaleTimeString()}`
                                : ""
                            }`}
                      </div>
                    </div>
                    <div className={dashStyles.cardHeaderRight}>
                      <button
                        type="button"
                        className={styles.btnSecondary}
                        disabled={loading || refreshing}
                        onClick={() => void reloadProjects({ fresh: true })}
                        title="Fetch latest projects from the server"
                      >
                        {loading || refreshing ? "Refreshing…" : "Refresh"}
                      </button>
                      <button
                        className={styles.button}
                        type="button"
                        onClick={() => {
                          setError(null);
                          openAddProject();
                        }}
                      >
                        + Add project
                      </button>
                    </div>
                  </div>

                  {!loading && projects.length === 0 ? <p className={styles.muted}>No projects yet.</p> : null}

                  {loading && projects.length === 0 ? (
                    <DashboardProjectsSkeleton />
                  ) : (
                  <div className={styles.grid}>
                    {projects.map((p) => (
                      <article
                        key={p.id}
                        className={styles.projectCard}
                      >
                        <div className={styles.projectCardTop}>
                          <Link
                            href={`/projects/${p.id}`}
                            className={styles.projectCardLink}
                          >
                            {p.name}
                          </Link>
                          <div className={styles.projectMenuWrap}>
                            <button
                              type="button"
                              className={styles.projectMenuButton}
                              aria-label={`Project actions for ${p.name}`}
                              aria-haspopup="menu"
                              aria-expanded={projectMenuOpen === p.id ? "true" : "false"}
                              onClick={() => {
                                setProjectMenuOpen((cur) => (cur === p.id ? null : p.id));
                              }}
                            >
                              ⋮
                            </button>
                            {projectMenuOpen === p.id ? (
                              <div
                                className={styles.projectMenu}
                                role="menu"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <button
                                  type="button"
                                  className={styles.projectMenuItem}
                                  role="menuitem"
                                  onClick={() => {
                                    setProjectMenuOpen(null);
                                    router.push(`/projects/${p.id}`);
                                  }}
                                >
                                  Open
                                </button>
                                <button
                                  type="button"
                                  className={styles.projectMenuItem}
                                  role="menuitem"
                                  onClick={() => {
                                    setProjectMenuOpen(null);
                                    router.push(`/projects/${p.id}?tab=project_settings`);
                                  }}
                                >
                                  Project settings
                                </button>
                                {normalizePlatform(p) === "shopify" ? (
                                  <button
                                    type="button"
                                    className={styles.projectMenuItem}
                                    role="menuitem"
                                    onClick={() => {
                                      setProjectMenuOpen(null);
                                      openShopifyConnect(p);
                                    }}
                                  >
                                    {p.shopify_connected ? "Shopify connection" : "Connect Shopify store"}
                                  </button>
                                ) : null}
                              </div>
                            ) : null}
                          </div>
                        </div>
                        <div className={styles.muted}>{p.website_url || "—"}</div>
                        <div className={styles.projectPlatformRow} aria-label={`Platform ${normalizePlatform(p)}`}>
                          {normalizePlatform(p) === "shopify" ? (
                            <>
                              <PlatformIcon.Shopify className={styles.projectPlatformLogo} />
                              <span className={styles.projectPlatformLabel}>Shopify</span>
                              <span
                                className={styles.projectConnectionPill}
                                data-state={p.shopify_connected ? "verified" : "pending"}
                              >
                                {p.shopify_connected ? "Connected" : "Not connected"}
                              </span>
                            </>
                          ) : (
                            <>
                              <PlatformIcon.WordPress className={styles.projectPlatformLogo} />
                              <span className={styles.projectPlatformLabel}>WordPress</span>
                            </>
                          )}
                        </div>
                      </article>
                    ))}
                  </div>
                  )}
                </div>
              </>
            ) : null}

            {section === "users" && isAdmin ? (
              <>
                <div className={styles.intro}>
                  <div className={styles.sectionHead}>
                    <div>
                      <h1 style={{ margin: 0 }}>Manage users</h1>
                      <p style={{ marginBottom: 0 }}>
                        Change roles and subscription plans. Changes are staged until you save.
                      </p>
                    </div>
                    <div className={dashStyles.usersToolbar}>
                      {usersDirty ? (
                        <span className={dashStyles.usersUnsavedBadge} aria-live="polite">
                          <span className={dashStyles.usersUnsavedDot} aria-hidden="true" />
                          {usersDirtyCount} unsaved {usersDirtyCount === 1 ? "change" : "changes"}
                        </span>
                      ) : null}
                      {usersDirty ? (
                        <button
                          type="button"
                          className={`${styles.miniBtn}`}
                          onClick={discardUserChanges}
                          disabled={usersSaving}
                        >
                          Discard
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className={`${styles.button} ${!usersDirty ? dashStyles.usersSaveBtnDisabled : ""}`}
                        onClick={() => void saveAllUsers()}
                        disabled={!usersDirty || usersSaving}
                        aria-disabled={!usersDirty}
                      >
                        {usersSaving ? "Saving…" : "Save changes"}
                      </button>
                    </div>
                  </div>
                </div>

                {/* Success toast */}
                {usersSuccessMsg ? (
                  <div className={dashStyles.usersSuccessToast} role="status" aria-live="polite">
                    ✓ {usersSuccessMsg}
                  </div>
                ) : null}

                <div className={`${styles.card} ${styles.cardWide}`}>
                  {usersLoading ? <DetailPanelSkeleton /> : null}
                  {!usersLoading ? (
                    <table className={styles.table}>
                      <thead>
                        <tr>
                          <th className={styles.th}>Full name</th>
                          <th className={styles.th}>Email</th>
                          <th className={styles.th}>Role</th>
                          <th className={styles.th}>Subscription</th>
                          <th className={styles.th}>Status</th>
                          <th className={styles.th}>Projects</th>
                          <th className={styles.th}>Details</th>
                          <th className={styles.th}>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {users.map((u) => {
                          const isDirty = !!userEdits[u.id];
                          return (
                            <tr key={u.id} className={isDirty ? dashStyles.usersDirtyRow : undefined}>
                              <td className={styles.td}>
                                <input
                                  className={styles.inputSmall}
                                  value={u.full_name || ""}
                                  onChange={(e) => updateUserField(u.id, "full_name", e.target.value)}
                                  placeholder="—"
                                  aria-label="Full name"
                                />
                              </td>
                              <td className={`${styles.td} ${styles.tdMuted}`}>{u.email}</td>
                              <td className={styles.td}>
                                <select
                                  className={styles.select}
                                  value={u.role}
                                  onChange={(e) => updateUserField(u.id, "role", e.target.value)}
                                  aria-label="Role"
                                >
                                  <option value="user">User</option>
                                  <option value="admin">Admin</option>
                                </select>
                              </td>
                              <td className={styles.td}>
                                <select
                                  className={styles.select}
                                  value={u.subscription_type || ""}
                                  onChange={(e) => updateUserField(u.id, "subscription_type", e.target.value)}
                                  aria-label="Subscription plan"
                                >
                                  <option value="">— Unassigned —</option>
                                  {plans.map((p) => (
                                    <option key={p.key} value={p.key}>
                                      {p.name || p.key}
                                    </option>
                                  ))}
                                </select>
                              </td>
                              <td className={styles.td}>
                                <span className={styles.pill}>{u.account_status || "active"}</span>
                              </td>
                              <td className={styles.td}>
                                <div className={dashStyles.workspaceCell}>
                                  <span className={styles.muted}>{u.total_projects ?? 0}</span>
                                  <button className={styles.miniBtn} type="button" onClick={() => openUserWorkspace(u.id)}>
                                    Open
                                  </button>
                                </div>
                              </td>
                              <td className={styles.td}>
                                <button className={styles.miniBtn} type="button" onClick={() => viewUserDetails(u.id)}>
                                  View details
                                </button>
                              </td>
                              <td className={styles.td}>
                                <button className={`${styles.miniBtn} ${styles.miniDanger}`} type="button" onClick={() => promptDeleteUser(u)}>
                                  Deactivate
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  ) : null}
                </div>

                {/* Leave confirmation modal */}
                {showUsersLeaveModal ? (
                  <div className={styles.modalOverlay} role="dialog" aria-modal="true" aria-labelledby="users-leave-title" aria-describedby="users-leave-desc">
                    <div className={styles.modal} ref={usersLeaveModalTrapRef}>
                      <h2 id="users-leave-title" className={styles.modalTitle}>Unsaved changes</h2>
                      <p id="users-leave-desc" className={styles.modalBody} style={{ color: "var(--aa-ink)" }}>
                        You have {usersDirtyCount} unsaved {usersDirtyCount === 1 ? "change" : "changes"}. Leaving this page will discard all modifications.
                      </p>
                      <div className={styles.modalActions}>
                        <button
                          type="button"
                          className={styles.button}
                          onClick={() => setShowUsersLeaveModal(false)}
                          autoFocus
                        >
                          Continue editing
                        </button>
                        <button
                          type="button"
                          className={`${styles.miniBtn} ${styles.miniDanger}`}
                          onClick={() => {
                            setShowUsersLeaveModal(false);
                            setUserEdits({});
                            usersLeavePending?.();
                            setUsersLeavePending(null);
                          }}
                        >
                          Discard changes
                        </button>
                      </div>
                    </div>
                  </div>
                ) : null}
              </>
            ) : null}

            {section === "limits" && isAdmin ? (
              <>
                <div className={styles.intro}>
                  <div className={styles.sectionHead}>
                    <div>
                      <h1 style={{ margin: 0 }}>System limitations</h1>
                      <p style={{ marginBottom: 0 }}>
                        Edit plan limits below, then save all changes together.
                      </p>
                    </div>
                    {plansDirty ? (
                      <button
                        className={styles.button}
                        type="button"
                        onClick={saveAllPlans}
                        disabled={plansSaving || plansLoading}
                      >
                        {plansSaving ? "Saving…" : "Save changes"}
                      </button>
                    ) : null}
                  </div>
                </div>

                <div className={`${styles.card} ${styles.cardWide}`}>
                  <div className={styles.sectionHead}>
                    <div>
                      <h2 style={{ margin: 0 }}>Create new plan</h2>
                      <div className={styles.muted}>Key must be unique (letters/numbers/underscore).</div>
                    </div>
                    <button className={styles.button} type="button" onClick={createPlan} disabled={!newPlanKey.trim()}>
                      Create
                    </button>
                  </div>

                  <div className={dashStyles.planCreateGrid}>
                    <label className={styles.label}>
                      Plan key
                      <input className={styles.input} value={newPlanKey} onChange={(e) => setNewPlanKey(e.target.value)} placeholder="e.g. pro" />
                    </label>
                    <label className={styles.label}>
                      Plan name
                      <input className={styles.input} value={newPlanName} onChange={(e) => setNewPlanName(e.target.value)} placeholder="e.g. Pro Plan" />
                    </label>
                    <label className={styles.label}>
                      Max projects
                      <input
                        className={styles.input}
                        type="number"
                        min={0}
                        value={newPlanMaxProjects}
                        onChange={(e) => setNewPlanMaxProjects(Number(e.target.value || 0))}
                      />
                    </label>
                    <label className={styles.label}>
                      Max articles / day
                      <input className={styles.input} type="number" min={0} value={newPlanMaxArticlesPerDay} onChange={(e) => setNewPlanMaxArticlesPerDay(Number(e.target.value || 0))} />
                    </label>
                    <label className={styles.label}>
                      Max articles / month
                      <input className={styles.input} type="number" min={0} value={newPlanMaxArticlesPerMonth} onChange={(e) => setNewPlanMaxArticlesPerMonth(Number(e.target.value || 0))} />
                    </label>
                    <label className={styles.label}>
                      Plan cost (monthly)
                      <input className={styles.input} type="number" min={0} step="0.01" value={newPlanCostMonthly} onChange={(e) => setNewPlanCostMonthly(Number(e.target.value || 0))} />
                    </label>
                    <label className={styles.label}>
                      Default plan for new users
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <input type="checkbox" checked={newPlanIsDefault} onChange={(e) => setNewPlanIsDefault(e.target.checked)} />
                        <span className={styles.muted} style={{ fontSize: 12 }}>
                          New registrations will get this plan.
                        </span>
                      </div>
                    </label>
                    <label className={styles.label}>
                      Trial Period
                      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                        <input
                          type="checkbox"
                          checked={newPlanIsTrialPlan}
                          onChange={(e) => setNewPlanIsTrialPlan(e.target.checked)}
                        />
                        <span className={styles.muted} style={{ fontSize: 12 }}>
                          Trial period time (in days):
                        </span>
                        <input
                          className={styles.input}
                          style={{ width: 140 }}
                          type="number"
                          min={1}
                          value={newPlanTrialPeriodDays}
                          onChange={(e) => setNewPlanTrialPeriodDays(Number(e.target.value || 1))}
                          disabled={!newPlanIsTrialPlan}
                        />
                      </div>
                      <span className={styles.muted} style={{ fontSize: 12 }}>
                        Only one plan can be the self-expiring trial plan. Trial starts at account creation.
                      </span>
                    </label>
                    <label className={styles.label}>
                      Enable Export Articles
                      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                        <input type="checkbox" checked={newPlanAllowExport} onChange={(e) => setNewPlanAllowExport(e.target.checked)} />
                        <span className={styles.muted} style={{ fontSize: 12 }}>
                          Monthly export limit:
                        </span>
                        <input
                          className={styles.input}
                          style={{ width: 140 }}
                          type="number"
                          min={0}
                          value={newPlanMaxExportPerMonth}
                          onChange={(e) => setNewPlanMaxExportPerMonth(Number(e.target.value || 0))}
                          disabled={!newPlanAllowExport}
                        />
                      </div>
                    </label>
                    <label className={styles.label}>
                      Enable Schedule feature
                      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                        <input type="checkbox" checked={newPlanAllowScheduling} onChange={(e) => setNewPlanAllowScheduling(e.target.checked)} />
                        <span className={styles.muted} style={{ fontSize: 12 }}>
                          Monthly schedule limit:
                        </span>
                        <input
                          className={styles.input}
                          style={{ width: 140 }}
                          type="number"
                          min={0}
                          value={newPlanMaxScheduledPerMonth}
                          onChange={(e) => setNewPlanMaxScheduledPerMonth(Number(e.target.value || 0))}
                          disabled={!newPlanAllowScheduling}
                        />
                      </div>
                    </label>
                    <label className={styles.label}>
                      Cluster Planner / month
                      <input
                        className={styles.input}
                        type="number"
                        min={0}
                        value={newPlanMaxClusterPlansPerMonth}
                        onChange={(e) => setNewPlanMaxClusterPlansPerMonth(Number(e.target.value || 0))}
                      />
                    </label>
                    <label className={styles.label}>
                      Custom Curations / month
                      <input
                        className={styles.input}
                        type="number"
                        min={0}
                        value={newPlanMaxCustomResearchPerMonth}
                        onChange={(e) => setNewPlanMaxCustomResearchPerMonth(Number(e.target.value || 0))}
                      />
                    </label>
                    <label className={styles.label}>
                      Max Context links
                      <input
                        className={styles.input}
                        type="number"
                        min={0}
                        value={newPlanMaxContextLinks}
                        onChange={(e) => setNewPlanMaxContextLinks(Number(e.target.value || 0))}
                      />
                    </label>
                    <label className={styles.label}>
                      Featured image regenerations / article
                      <input
                        className={styles.input}
                        type="number"
                        min={0}
                        value={newPlanMaxArticleImageRegenerations}
                        onChange={(e) => setNewPlanMaxArticleImageRegenerations(Number(e.target.value || 0))}
                      />
                      <span className={styles.muted} style={{ fontSize: 12 }}>
                        0 means unlimited.
                      </span>
                    </label>
                  </div>
                </div>

                <div className={`${styles.card} ${styles.cardWide}`}>
                  {plansLoading ? <FormFieldsSkeleton fields={5} /> : null}
                  {!plansLoading ? (
                    <div className={dashStyles.stackGrid}>
                      {plans.map((p) => (
                        <div key={p.key} className={styles.subtleCard}>
                          <div className={`${styles.sectionHead} ${dashStyles.planRowHead}`}>
                            <div>
                              <div className={dashStyles.planTitle}>{p.name || p.key}</div>
                              <div className={styles.muted}>Key: {p.key}</div>
                            </div>
                            {plansFingerprint([p]) !== plansFingerprint(savedPlans.filter((x) => x.key === p.key)) ? (
                              <span className={styles.muted} style={{ fontSize: 12, fontWeight: 800 }}>
                                Unsaved changes
                              </span>
                            ) : null}
                          </div>

                          <div className={dashStyles.planEditGrid}>
                            <label className={styles.label}>
                              Plan name
                              <input
                                className={styles.input}
                                value={p.name || ""}
                                onChange={(e) => updatePlanDraft(p.key, { name: e.target.value })}
                              />
                            </label>
                            <label className={styles.label}>
                              Default for new users
                              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                <input
                                  type="checkbox"
                                  checked={Boolean(p.is_default)}
                                  onChange={(e) => updateDefaultPlanDraft(p.key, e.target.checked)}
                                />
                                <span className={styles.muted} style={{ fontSize: 12 }}>
                                  One default at a time.
                                </span>
                              </div>
                            </label>
                            <label className={styles.label}>
                              Trial Period
                              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                                <input
                                  type="checkbox"
                                  checked={Boolean(p.is_trial_plan)}
                                  onChange={(e) => updateTrialPlanDraft(p.key, e.target.checked)}
                                />
                                <span className={styles.muted} style={{ fontSize: 12 }}>
                                  Trial period time (in days):
                                </span>
                                <input
                                  className={styles.input}
                                  style={{ width: 140 }}
                                  type="number"
                                  min={1}
                                  value={Number(p.trial_period_days ?? 14)}
                                  onChange={(e) =>
                                    updatePlanDraft(p.key, { trial_period_days: Number(e.target.value || 1) })
                                  }
                                  disabled={!p.is_trial_plan}
                                />
                              </div>
                            </label>
                            <label className={styles.label}>
                              Cost (monthly)
                              <input
                                className={styles.input}
                                type="number"
                                min={0}
                                step="0.01"
                                value={Number(p.cost_monthly ?? 0)}
                                onChange={(e) => updatePlanDraft(p.key, { cost_monthly: Number(e.target.value || 0) })}
                              />
                            </label>
                            <label className={styles.label}>
                              Max projects
                              <input
                                className={styles.input}
                                type="number"
                                min={0}
                                value={p.max_projects ?? 0}
                                onChange={(e) => updatePlanDraft(p.key, { max_projects: Number(e.target.value || 0) })}
                              />
                            </label>
                            <label className={styles.label}>
                              Max articles / day
                              <input
                                className={styles.input}
                                type="number"
                                min={0}
                                value={p.max_articles_per_day ?? 0}
                                onChange={(e) => updatePlanDraft(p.key, { max_articles_per_day: Number(e.target.value || 0) })}
                              />
                            </label>
                            <label className={styles.label}>
                              Max articles / month
                              <input
                                className={styles.input}
                                type="number"
                                min={0}
                                value={p.max_articles_per_month ?? 0}
                                onChange={(e) => updatePlanDraft(p.key, { max_articles_per_month: Number(e.target.value || 0) })}
                              />
                            </label>
                            <label className={styles.label}>
                              Export Articles
                              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                                <input
                                  type="checkbox"
                                  checked={Boolean(p.allow_export)}
                                  onChange={(e) => updatePlanDraft(p.key, { allow_export: e.target.checked })}
                                />
                                <span className={styles.muted} style={{ fontSize: 12 }}>
                                  Limit / month:
                                </span>
                                <input
                                  className={styles.input}
                                  style={{ width: 140 }}
                                  type="number"
                                  min={0}
                                  value={p.max_export_per_month ?? 0}
                                  onChange={(e) => updatePlanDraft(p.key, { max_export_per_month: Number(e.target.value || 0) })}
                                  disabled={!p.allow_export}
                                />
                              </div>
                            </label>
                            <label className={styles.label}>
                              Schedule feature
                              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                                <input
                                  type="checkbox"
                                  checked={Boolean(p.allow_scheduling)}
                                  onChange={(e) => updatePlanDraft(p.key, { allow_scheduling: e.target.checked })}
                                />
                                <span className={styles.muted} style={{ fontSize: 12 }}>
                                  Limit / month:
                                </span>
                                <input
                                  className={styles.input}
                                  style={{ width: 140 }}
                                  type="number"
                                  min={0}
                                  value={p.max_scheduled_per_month ?? 0}
                                  onChange={(e) => updatePlanDraft(p.key, { max_scheduled_per_month: Number(e.target.value || 0) })}
                                  disabled={!p.allow_scheduling}
                                />
                              </div>
                            </label>
                            <label className={styles.label}>
                              Cluster Planner / month
                              <input
                                className={styles.input}
                                type="number"
                                min={0}
                                value={p.max_cluster_plans_per_month ?? 0}
                                onChange={(e) => updatePlanDraft(p.key, { max_cluster_plans_per_month: Number(e.target.value || 0) })}
                              />
                            </label>
                            <label className={styles.label}>
                              Custom Curations / month
                              <input
                                className={styles.input}
                                type="number"
                                min={0}
                                value={p.max_custom_research_per_month ?? 0}
                                onChange={(e) => updatePlanDraft(p.key, { max_custom_research_per_month: Number(e.target.value || 0) })}
                              />
                            </label>
                            <label className={styles.label}>
                              Max Context links
                              <input
                                className={styles.input}
                                type="number"
                                min={0}
                                value={p.max_context_links ?? 0}
                                onChange={(e) => updatePlanDraft(p.key, { max_context_links: Number(e.target.value || 0) })}
                              />
                            </label>
                            <label className={styles.label}>
                              Featured image regenerations / article
                              <input
                                className={styles.input}
                                type="number"
                                min={0}
                                value={p.max_article_image_regenerations ?? 0}
                                onChange={(e) => updatePlanDraft(p.key, { max_article_image_regenerations: Number(e.target.value || 0) })}
                              />
                              <span className={styles.muted} style={{ fontSize: 12 }}>
                                0 means unlimited.
                              </span>
                            </label>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
                {plansDirty ? (
                  <div className={`${styles.card} ${styles.cardWide}`}>
                    <div
                      className={styles.row}
                      style={{ justifyContent: "space-between", alignItems: "center" }}
                    >
                      <span className={styles.muted} style={{ fontSize: 13 }}>
                        You have unsaved changes in plan limits.
                      </span>
                      <button
                        className={styles.button}
                        type="button"
                        onClick={saveAllPlans}
                        disabled={plansSaving || plansLoading}
                      >
                        {plansSaving ? "Saving…" : "Save changes"}
                      </button>
                    </div>
                  </div>
                ) : null}
              </>
            ) : null}

            {section === "profile" ? (
              <>
                <div className={styles.intro}>
                  <h1>User profile</h1>
                  <p>Update your personal details (email is read-only).</p>
                </div>

                <div className={`${styles.card} ${styles.cardWide}`}>
                  {profileLoading ? <FormFieldsSkeleton fields={4} /> : null}
                  {profile ? (
                    <div className={dashStyles.profileGrid}>
                      <label className={styles.label}>
                        Full name
                        <input className={styles.input} value={profile.full_name || ""} onChange={(e) => setProfile((p) => (p ? { ...p, full_name: e.target.value } : p))} />
                      </label>
                      <label className={styles.label}>
                        Phone
                        <input className={styles.input} value={profile.phone || ""} onChange={(e) => setProfile((p) => (p ? { ...p, phone: e.target.value } : p))} />
                      </label>
                      <div className={styles.label}>
                        <div className={dashStyles.flexBetween}>
                          <span>Timezone</span>
                          <button
                            type="button"
                            className={`${styles.btnSecondary} ${dashStyles.autoDetectBtn}`}
                            onClick={() => setProfile((p) => (p ? { ...p, timezone: normalizeTimeZoneId(browserTimeZone || "UTC") } : p))}
                            title="Auto-detect your current timezone"
                          >
                            Auto-detect
                          </button>
                        </div>
                        <select
                          className={styles.input}
                          value={profile.timezone || ""}
                          onChange={(e) => setProfile((p) => (p ? { ...p, timezone: e.target.value } : p))}
                        >
                          {timeZoneOptions.map((tz) => (
                            <option key={tz} value={tz}>
                              {tz}
                            </option>
                          ))}
                        </select>
                        <div className={`${styles.muted} ${dashStyles.tzHelper}`}>
                          <div>
                            <strong>Current time</strong> in this timezone:{" "}
                            <span>{formatWallClockInTz(profile.timezone, profileClockTick)}</span>
                          </div>
                          <div className={dashStyles.tzHelperSpacer}>
                            <strong>UTC</strong> (server reference):{" "}
                            <span>{formatWallClockInTz("UTC", profileClockTick)}</span>
                          </div>
                        </div>
                      </div>
                      <label className={styles.label}>
                        Email (read-only)
                        <input className={styles.input} value={profile.email} readOnly />
                      </label>
                      <label className={styles.label}>
                        Current plan
                        <input className={styles.input} value={profile.subscription_type || "—"} readOnly />
                      </label>
                      <label className={styles.label}>
                        Joined on
                        <input className={styles.input} value={profile.created_at || "—"} readOnly />
                      </label>
                    </div>
                  ) : null}

                  <div className={`${styles.row} ${dashStyles.rowEnd}`}>
                    <button className={styles.button} type="button" onClick={saveProfile} disabled={!profile}>
                      Save profile
                    </button>
                  </div>
                </div>
              </>
            ) : null}
          </section>
        </div>
      </main>

      {showAddProject ? (
        <>
          <button type="button" className={styles.modalBackdrop} aria-label="Close" onClick={closeAddProject} />
          <div ref={addProjectTrapRef} className={styles.modalPanel} role="dialog" aria-modal="true" aria-label="Add project">
            <div className={styles.modalHead}>
              <h3 className={styles.modalTitle}>
                {addProjectStep === "form" ? "Add project" : "Which platform is your site on?"}
              </h3>
              <button type="button" className={styles.iconButton} aria-label="Close" onClick={closeAddProject}>
                <Icon.X className={styles.icon20} />
              </button>
            </div>

            <div className={styles.modalBody}>
              {addProjectStep === "form" ? (
                <>
                  <label className={styles.label}>
                    Project name
                    <input className={styles.input} value={name} onChange={(e) => setName(e.target.value)} />
                  </label>
                  <label className={styles.label}>
                    Website URL
                    <input
                      className={styles.input}
                      value={website}
                      onChange={(e) => setWebsite(e.target.value)}
                      placeholder="https://example.com or my-store.myshopify.com"
                    />
                  </label>
                </>
              ) : (
                <>
                  <p className={styles.muted} style={{ fontSize: 13, lineHeight: 1.5, margin: "0 0 16px" }}>
                    Choose how this project connects. Shopify projects only show Shopify settings; WordPress
                    projects only show WordPress settings.
                  </p>
                  <div className={styles.platformPickerGrid}>
                    <div className={styles.platformPickerCard}>
                      <div className={styles.platformPickerTitle}>WordPress</div>
                      <div className={styles.muted} style={{ fontSize: 12, lineHeight: 1.45 }}>
                        Plugin + application password. Use the button below: Create WordPress project.
                      </div>
                    </div>
                    <div className={styles.platformPickerCard}>
                      <div className={styles.platformPickerTitle}>Shopify</div>
                      <div className={styles.muted} style={{ fontSize: 12, lineHeight: 1.45 }}>
                        Connect with your shop URL + Admin API token (custom app). Use the button below: Create Shopify project.
                      </div>
                    </div>
                  </div>
                </>
              )}
              {error ? <p className={styles.error} style={{ marginTop: 12 }}>{error}</p> : null}
            </div>

            <div className={styles.modalFooter}>
              {addProjectStep === "platform" ? (
                <button type="button" className={styles.btnSecondary} onClick={() => setAddProjectStep("form")}>
                  Back
                </button>
              ) : (
                <button type="button" className={styles.btnSecondary} onClick={closeAddProject}>
                  Cancel
                </button>
              )}
              {addProjectStep === "form" ? (
                <button
                  className={styles.button}
                  type="button"
                  onClick={() => {
                    if (!name.trim()) return;
                    setAddProjectStep("platform");
                  }}
                  disabled={!name.trim()}
                >
                  Next
                </button>
              ) : (
                <>
                  <button
                    className={styles.btnSecondary}
                    type="button"
                    disabled={creating}
                    onClick={() => void createProjectWithPlatform("wordpress")}
                  >
                    {creating ? "Creating…" : "Create WordPress project"}
                  </button>
                  <button
                    className={styles.button}
                    type="button"
                    disabled={creating}
                    onClick={() => void createProjectWithPlatform("shopify")}
                  >
                    {creating ? "Creating…" : "Create Shopify project"}
                  </button>
                </>
              )}
            </div>
          </div>
        </>
      ) : null}

      {showShopifyConnect && shopifyProject ? (
        <>
          <button type="button" className={styles.modalBackdrop} aria-label="Close" onClick={closeShopifyConnect} />
          <div ref={shopifyConnectTrapRef} className={styles.modalPanel} role="dialog" aria-modal="true" aria-label="Connect Shopify store">
            <div className={styles.modalHead}>
              <h3 className={styles.modalTitle}>Connect Shopify — {shopifyProject.name}</h3>
              <button type="button" className={styles.iconButton} aria-label="Close" onClick={closeShopifyConnect}>
                <Icon.X className={styles.icon20} />
              </button>
            </div>
            <div className={styles.modalBody}>
              <div className={styles.muted} style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 12 }}>
                Enter your store URL and Developer Dashboard <strong>Client ID</strong> + <strong>Client secret</strong> (
                <code>shpss_…</code>). Riviso exchanges them for an API token automatically.
              </div>
              <ShopifyManualConnectGuide defaultOpen />
              <label className={styles.label} style={{ marginTop: 14 }}>
                Shopify store URL
                <input
                  className={styles.input}
                  value={shopifyShopUrl}
                  onChange={(e) => setShopifyShopUrl(e.target.value)}
                  placeholder="brandname.myshopify.com"
                />
              </label>
              <label className={styles.label}>
                Client ID
                <input
                  className={styles.input}
                  value={shopifyClientId}
                  onChange={(e) => setShopifyClientId(e.target.value)}
                  placeholder="Developer Dashboard → Settings"
                  autoComplete="off"
                />
              </label>
              <label className={styles.label}>
                Client secret
                <input
                  className={styles.input}
                  type="password"
                  value={shopifyClientSecret}
                  onChange={(e) => setShopifyClientSecret(e.target.value)}
                  placeholder="shpss_…"
                  autoComplete="off"
                />
              </label>
              <div className={styles.row} style={{ marginTop: 14 }}>
                <button
                  className={styles.button}
                  type="button"
                  disabled={
                    shopifyConnecting ||
                    !shopifyShopUrl.trim() ||
                    !shopifyClientId.trim() ||
                    !shopifyClientSecret.trim()
                  }
                  onClick={async () => {
                    setShopifyVerify(null);
                    setShopifyConnecting(true);
                    try {
                      const shop = shopifyShopUrl.trim();
                      const res = await api.connectShopify(shopifyProject.id, {
                        shop,
                        client_id: shopifyClientId.trim(),
                        client_secret: shopifyClientSecret.trim(),
                      });
                      setShopifyVerify({ ok: res.ok, message: res.message });
                      if (res.ok) {
                        setShopifyClientSecret("");
                        await refreshProjectInList(shopifyProject.id);
                      }
                    } catch (e) {
                      setShopifyVerify({
                        ok: false,
                        message: e instanceof Error ? e.message : "Connection failed",
                      });
                    } finally {
                      setShopifyConnecting(false);
                    }
                  }}
                >
                  {shopifyConnecting ? "Connecting…" : "Connect store"}
                </button>
              </div>
              {shopifyVerify ? (
                <div
                  className={shopifyVerify.ok ? styles.muted : styles.error}
                  style={{ fontSize: 13, marginTop: 12, whiteSpace: "pre-wrap" }}
                >
                  {shopifyVerify.message}
                </div>
              ) : null}
            </div>
            <div className={styles.modalFooter}>
              <button type="button" className={styles.btnSecondary} onClick={closeShopifyConnect}>
                Cancel
              </button>
              <button
                className={styles.button}
                type="button"
                disabled={!shopifyVerify?.ok}
                onClick={() => {
                  closeShopifyConnect();
                  router.push(`/projects/${shopifyProject.id}?tab=project_settings`);
                }}
              >
                Continue
              </button>
            </div>
          </div>
        </>
      ) : null}

      {showWpConnect && wpProject ? (
        <>
          <button type="button" className={styles.modalBackdrop} aria-label="Close" onClick={closeWpConnect} />
          <div ref={wpConnectTrapRef} className={styles.modalPanel} role="dialog" aria-modal="true" aria-label="Connect WordPress" aria-describedby="wp-connect-desc">
            <div className={styles.modalHead}>
              <h3 className={styles.modalTitle}>Connect your WordPress site</h3>
              <button type="button" className={styles.iconButton} aria-label="Close" onClick={closeWpConnect}>
                <Icon.X className={styles.icon20} />
              </button>
            </div>
            <div className={styles.modalBody}>
              <div id="wp-connect-desc" className={styles.muted} style={{ fontSize: 13, lineHeight: 1.5 }}>
                Next, connect your WordPress website so we can publish generated articles. Add your WordPress username and
                an Application Password (Users &rarr; Profile &rarr; Application Passwords).
              </div>

              <label className={styles.label}>
                WordPress site URL
                <input className={styles.input} value={wpSettings?.wp_site_url || wpProject.website_url || ""} readOnly />
              </label>

              <label className={styles.label}>
                WordPress username
                <input className={styles.input} value={wpUsername} onChange={(e) => setWpUsername(e.target.value)} placeholder="e.g. admin" />
              </label>

              <label className={styles.label}>
                Application password
                <input className={styles.input} value={wpAppPassword} onChange={(e) => setWpAppPassword(e.target.value)} placeholder="xxxx xxxx xxxx xxxx" />
              </label>

              <div className={styles.row}>
                <button
                  className={styles.btnSecondary}
                  type="button"
                  onClick={async () => {
                    setWpPluginError(null);
                    try {
                      await downloadWordpressPlugin(wpSettings?.plugin_download_url);
                    } catch (e) {
                      setWpPluginError(e instanceof Error ? e.message : "Could not download plugin.");
                    }
                  }}
                >
                  Download plugin
                </button>
                <button
                  className={styles.button}
                  type="button"
                  disabled={wpVerifying || !wpUsername.trim() || !wpAppPassword.trim()}
                  onClick={async () => {
                    setWpVerify(null);
                    setWpVerifying(true);
                    try {
                      await api.updateProjectSettings(wpProject.id, { wp_username: wpUsername, wp_app_password: wpAppPassword });
                      const res = await api.verifyWordpress(wpProject.id, { wp_username: wpUsername, wp_app_password: wpAppPassword });
                      setWpVerify(res);
                    } catch (e) {
                      setWpVerify({ ok: false, status: "error", message: e instanceof Error ? e.message : "Verify failed" });
                    } finally {
                      setWpVerifying(false);
                    }
                  }}
                >
                  {wpVerifying ? "Verifying…" : "Verify"}
                </button>
              </div>

              {wpPluginError ? (
                <div role="alert" className={styles.error} style={{ fontSize: 13, marginTop: 8 }}>
                  {wpPluginError}
                </div>
              ) : null}

              {wpVerify ? (
                <div className={wpVerify.ok ? styles.muted : styles.error} style={{ fontSize: 13, whiteSpace: "pre-wrap" }}>
                  {wpVerify.message}
                </div>
              ) : null}
            </div>
            <div className={styles.modalFooter}>
              <button type="button" className={styles.btnSecondary} onClick={closeWpConnect}>
                Cancel
              </button>
              <button
                className={styles.button}
                type="button"
                disabled={!wpVerify?.ok}
                onClick={() => {
                  closeWpConnect();
                  router.push(`/projects/${wpProject.id}`);
                }}
              >
                Continue
              </button>
            </div>
          </div>
        </>
      ) : null}

      {userDetailsLoading || userDetails ? (
        <>
          <button
            type="button"
            className={styles.modalBackdrop}
            aria-label="Close"
            onClick={() => {
              setUserDetails(null);
              setUserDetailsLoading(false);
            }}
          />
          <div ref={userDetailsTrapRef} className={styles.modalPanel} role="dialog" aria-modal="true" aria-label="User details">
            <div className={styles.modalHead}>
              <h3 className={styles.modalTitle}>User details</h3>
              <div className={dashStyles.modalHeadActions}>
                {userDetails ? (
                  <button type="button" className={styles.button} onClick={() => openUserWorkspace(userDetails.user.id)}>
                    Browse workspace
                  </button>
                ) : null}
                <button
                  type="button"
                  className={styles.btnSecondary}
                  onClick={() => {
                    setUserDetails(null);
                    setUserDetailsLoading(false);
                  }}
                >
                  Close
                </button>
              </div>
            </div>

            <div className={styles.modalBody}>
              {userDetailsLoading ? <DetailPanelSkeleton /> : null}
              {userDetails ? (
                <>
                  <div className={styles.subtleCard}>
                    <div className={styles.muted} style={{ fontSize: 12, marginBottom: 8 }}>
                      Profile
                    </div>
                    <table className={styles.table}>
                      <tbody>
                        <tr>
                          <td className={styles.td}>User email</td>
                          <td className={styles.td}>{userDetails.user.email}</td>
                        </tr>
                        <tr>
                          <td className={styles.td}>Full name</td>
                          <td className={styles.td}>{userDetails.user.full_name || "—"}</td>
                        </tr>
                        <tr>
                          <td className={styles.td}>Phone no</td>
                          <td className={styles.td}>{userDetails.user.phone || "—"}</td>
                        </tr>
                        <tr>
                          <td className={styles.td}>Address</td>
                          <td className={styles.td}>{userDetails.user.address || "—"}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>

                  <div className={styles.subtleCard}>
                    <div className={styles.muted} style={{ fontSize: 12, marginBottom: 8 }}>
                      Stats
                    </div>
                    <table className={styles.table}>
                      <thead>
                        <tr>
                          <th className={styles.th}>Total projects</th>
                          <th className={styles.th}>Total articles</th>
                          <th className={styles.th}>Total pending</th>
                          <th className={styles.th}>Total active</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr>
                          <td className={styles.td}>
                            <button
                              type="button"
                              className={dashStyles.linkishButton}
                              onClick={() => openUserWorkspace(userDetails.user.id)}
                              title="Open projects and articles"
                            >
                              {userDetails.stats.total_projects}
                            </button>
                          </td>
                          <td className={styles.td}>{userDetails.stats.total_articles}</td>
                          <td className={styles.td}>{userDetails.stats.total_pending_articles}</td>
                          <td className={styles.td}>{userDetails.stats.total_active_articles}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </>
              ) : null}
            </div>
          </div>
        </>
      ) : null}

      {userWorkspaceLoading || userWorkspace ? (
        <>
          <button type="button" className={styles.modalBackdrop} aria-label="Close workspace" onClick={closeUserWorkspace} />
          <div ref={workspaceTrapRef} className={`${styles.modalPanel} ${dashStyles.workspaceModal}`} role="dialog" aria-modal="true" aria-label="User workspace">
            <div className={styles.modalHead}>
              <h3 className={styles.modalTitle}>
                {userWorkspace ? `Workspace — ${userWorkspace.email}` : userWorkspaceLoading ? "Loading workspace…" : "Workspace"}
              </h3>
              <button type="button" className={styles.btnSecondary} onClick={closeUserWorkspace}>
                Close
              </button>
            </div>
            <div className={`${styles.modalBody} ${dashStyles.workspaceModalBody}`}>
              {userWorkspaceLoading ? <DetailPanelSkeleton /> : null}
              {userWorkspace ? (
                <>
                  <div className={dashStyles.workspaceSection}>
                    <div className={styles.muted} style={{ fontSize: 12, marginBottom: 8 }}>
                      Projects ({userWorkspace.projects.length})
                    </div>
                    {userWorkspace.projects.length === 0 ? (
                      <div className={styles.muted}>No projects for this user.</div>
                    ) : (
                      <div className={dashStyles.tableScroll}>
                        <table className={styles.table}>
                          <thead>
                            <tr>
                              <th className={styles.th}>Name</th>
                              <th className={styles.th}>Website</th>
                              <th className={styles.th}>Articles</th>
                              <th className={styles.th}>Open</th>
                            </tr>
                          </thead>
                          <tbody>
                            {userWorkspace.projects.map((p) => (
                              <tr key={p.id}>
                                <td className={styles.td}>{p.name || "—"}</td>
                                <td className={`${styles.td} ${styles.tdMuted}`}>
                                  {p.website_url ? (
                                    <a href={p.website_url} target="_blank" rel="noreferrer">
                                      {p.website_url}
                                    </a>
                                  ) : (
                                    "—"
                                  )}
                                </td>
                                <td className={styles.td}>{p.article_count}</td>
                                <td className={styles.td}>
                                  <Link className={`${styles.miniBtn} ${styles.miniPrimary}`} href={`/projects/${p.id}`}>
                                    Open
                                  </Link>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>

                  <div className={dashStyles.workspaceSection}>
                    <div className={styles.muted} style={{ fontSize: 12, marginBottom: 8 }}>
                      Recent articles (newest first, up to 1500)
                    </div>
                    {userWorkspace.articles.length === 0 ? (
                      <div className={styles.muted}>No articles loaded.</div>
                    ) : (
                      <div className={dashStyles.tableScroll}>
                        <table className={styles.table}>
                          <thead>
                            <tr>
                              <th className={styles.th}>Project</th>
                              <th className={styles.th}>Title</th>
                              <th className={styles.th}>Status</th>
                              <th className={styles.th}>Created</th>
                              <th className={styles.th}>Actions</th>
                            </tr>
                          </thead>
                          <tbody>
                            {userWorkspace.articles.map((a) => (
                              <tr key={`${a.project_id}:${a.id}`}>
                                <td className={`${styles.td} ${styles.tdMuted}`}>{a.project_name}</td>
                                <td className={styles.td}>{a.title}</td>
                                <td className={styles.td}>{a.status}</td>
                                <td className={`${styles.td} ${styles.tdMuted}`}>{a.created_at || "—"}</td>
                                <td className={styles.td}>
                                  <div className={dashStyles.workspaceCell}>
                                    <Link className={styles.miniBtn} href={`/projects/${a.project_id}/articles/${a.id}`}>
                                      Edit
                                    </Link>
                                    {a.wp_link ? (
                                      <a className={styles.miniBtn} href={a.wp_link} target="_blank" rel="noreferrer">
                                        WP
                                      </a>
                                    ) : null}
                                  </div>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                    {userWorkspace.articles_truncated ? (
                      <div className={styles.muted} style={{ fontSize: 12, marginTop: 10 }}>
                        Listing is truncated. Totals appear in Manage users stats; download or reporting exports are not included here.
                      </div>
                    ) : null}
                  </div>
                </>
              ) : null}
            </div>
          </div>
        </>
      ) : null}

      {deleteUserTarget ? (
        <>
          <button type="button" className={styles.modalBackdrop} aria-label="Cancel" onClick={() => setDeleteUserTarget(null)} />
          <div
            ref={deleteUserTrapRef}
            className={styles.modalPanel}
            role="dialog"
            aria-modal="true"
            aria-label="Confirm deactivation"
            aria-describedby="delete-user-desc"
          >
            <div className={styles.modalHead}>
              <h3 className={styles.modalTitle}>Deactivate user?</h3>
              <button type="button" className={styles.iconButton} aria-label="Cancel" onClick={() => setDeleteUserTarget(null)}>
                <Icon.X className={styles.icon20} />
              </button>
            </div>
            <div className={styles.modalBody}>
              <p id="delete-user-desc" className={styles.muted} style={{ margin: 0 }}>
                Deactivating <strong>{deleteUserTarget.name}</strong> will mark their account as deleted. Their projects and articles are retained for account history.
              </p>
              {error ? <p className={styles.error} style={{ marginTop: 10 }}>{error}</p> : null}
            </div>
            <div className={styles.modalFooter}>
              <button type="button" className={styles.btnSecondary} onClick={() => setDeleteUserTarget(null)}>
                Cancel
              </button>
              <button type="button" className={styles.btnDanger} onClick={() => void confirmDeleteUser()}>
                Deactivate user
              </button>
            </div>
          </div>
        </>
      ) : null}

      {showTutorial ? <TutorialStepperModal onClose={() => setShowTutorial(false)} /> : null}
    </div>
  );
}


