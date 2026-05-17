"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { DashboardNavIcon } from "@/components/DashboardNavIcon";
import { TutorialStepperModal } from "@/components/TutorialStepperModal";
import styles from "../page.module.css";
import dashStyles from "./dashboard.module.css";
import {
  AdminUserDetails,
  AdminUserPublic,
  AdminWorkspaceResponse,
  api,
  clearAuth,
  getAccessToken,
  PlanPublic,
  ProfilePublic,
  ProjectPublic,
  ProjectSettings,
  WordpressVerifyResponse,
} from "@/lib/api";

type DashSection = "projects" | "users" | "limits" | "profile";

const DASH_SECTIONS = new Set<DashSection>(["projects", "users", "limits", "profile"]);

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
  const [name, setName] = useState("");
  const [website, setWebsite] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [projectMenuOpen, setProjectMenuOpen] = useState<string | null>(null);
  const [section, setSection] = useState<DashSection>(() => {
    if (typeof window === "undefined") return "projects";
    const params = new URLSearchParams(window.location.search);
    const raw = (params.get("section") || "projects") as DashSection;
    return DASH_SECTIONS.has(raw) ? raw : "projects";
  });
  const [showTutorial, setShowTutorial] = useState(false);
  const [showAddProject, setShowAddProject] = useState(false);
  const [showWpConnect, setShowWpConnect] = useState(false);
  const [wpProject, setWpProject] = useState<ProjectPublic | null>(null);
  const [wpSettings, setWpSettings] = useState<ProjectSettings | null>(null);
  const [wpUsername, setWpUsername] = useState("");
  const [wpAppPassword, setWpAppPassword] = useState("");
  const [wpVerify, setWpVerify] = useState<WordpressVerifyResponse | null>(null);
  const [wpVerifying, setWpVerifying] = useState(false);

  // Admin modules
  const [users, setUsers] = useState<AdminUserPublic[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
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

  const token = useMemo(() => getAccessToken(), []);
  const isAdmin = (meRole || "").trim().toLowerCase() === "admin";

  function canAccessSection(next: DashSection) {
    if (next === "users" || next === "limits") return isAdmin;
    return true;
  }

  function goSection(next: DashSection) {
    const target = canAccessSection(next) ? next : "projects";
    setSection(target);
    setMobileNavOpen(false);
    router.push(target === "projects" ? "/dashboard" : `/dashboard?section=${target}`);
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
    if (!token) {
      router.replace("/login");
      return;
    }
    (async () => {
      setError(null);
      setLoading(true);
      try {
        const me = await api.me();
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
        const items = await api.listProjects();
        setProjects(items);
      } catch {
        clearAuth();
        router.replace("/login");
      } finally {
        setLoading(false);
      }
    })();
  }, [router, token]);

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
          const items = await api.adminListUsers();
          setUsers(items);
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

  async function createProject() {
    setError(null);
    setCreating(true);
    try {
      const p = await api.createProject(name, website);
      setProjects((prev) => [p, ...prev]);
      setName("");
      setWebsite("");
      setShowAddProject(false);
      // Immediately begin WordPress connect flow for the new project.
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
    router.replace("/login");
  }

  async function saveUser(u: AdminUserPublic) {
    setError(null);
    try {
      const updated = await api.adminUpdateUser(u.id, {
        role: u.role,
        subscription_type: u.subscription_type || "",
        full_name: u.full_name || "",
        phone: u.phone || "",
        timezone: u.timezone || "",
      });
      setUsers((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save user");
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

  async function deleteUser(userId: string) {
    if (!confirm("Deactivate and mark this user as deleted? Their projects/articles stay retained for account history and retargeting.")) return;
    setError(null);
    try {
      await api.adminDeleteUser(userId);
      setUsers((prev) => prev.filter((u) => u.id !== userId));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete user");
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
            <div className={styles.sidebarNavMain}>
              <div className={styles.sidebarTitle}>{isAdmin ? "ADMIN" : "WORKSPACE"}</div>
              <div className={styles.navGroup}>
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

            <div className={styles.sidebarFooter}>
              <div className={styles.sidebarTitle}>ACCOUNT</div>
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
            {error ? <div className={styles.error}>{error}</div> : null}

            {section === "projects" ? (
              <>
                <div className={styles.intro}>
                  <h1>Projects</h1>
                  <p>Create and manage projects from your workspace.</p>
                </div>

                <div className={`${styles.card} ${styles.cardWide}`}>
                  <div className={dashStyles.cardHeaderRow}>
                    <div className={dashStyles.cardHeaderTitle}>Projects</div>
                    <div className={dashStyles.cardHeaderRight}>
                      <button
                        className={styles.button}
                        type="button"
                        onClick={() => {
                          setError(null);
                          setShowAddProject(true);
                        }}
                      >
                        + Add project
                      </button>
                      <div className={dashStyles.mutedCount}>{loading ? "Loading…" : `${projects.length} total`}</div>
                    </div>
                  </div>

                  {!loading && projects.length === 0 ? <p className={styles.muted}>No projects yet.</p> : null}

                  <div className={styles.grid}>
                    {projects.map((p) => (
                      <div
                        key={p.id}
                        className={styles.projectCard}
                        role="link"
                        tabIndex={0}
                        onClick={() => router.push(`/projects/${p.id}`)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            router.push(`/projects/${p.id}`);
                          }
                        }}
                        aria-label={`Open project ${p.name}`}
                      >
                        <div className={styles.projectCardTop}>
                          <div className={styles.projectTitle}>{p.name}</div>
                          <div className={styles.projectMenuWrap}>
                            <button
                              type="button"
                              className={styles.projectMenuButton}
                              aria-label={`Project actions for ${p.name}`}
                              aria-haspopup="menu"
                              aria-expanded={projectMenuOpen === p.id ? "true" : "false"}
                              onClick={(e) => {
                                e.stopPropagation();
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
                              </div>
                            ) : null}
                          </div>
                        </div>
                        <div className={styles.muted}>{p.website_url || "—"}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            ) : null}

            {section === "users" && isAdmin ? (
              <>
                <div className={styles.intro}>
                  <h1>Manage users</h1>
                  <p>View users, change roles, and change subscription plans.</p>
                </div>

                <div className={`${styles.card} ${styles.cardWide}`}>
                  {usersLoading ? <div className={styles.muted}>Loading users…</div> : null}
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
                        {users.map((u) => (
                          <tr key={u.id}>
                            <td className={styles.td}>
                              <input
                                className={styles.inputSmall}
                                value={u.full_name || ""}
                                onChange={(e) => setUsers((prev) => prev.map((x) => (x.id === u.id ? { ...x, full_name: e.target.value } : x)))}
                                placeholder="—"
                              />
                            </td>
                            <td className={`${styles.td} ${styles.tdMuted}`}>{u.email}</td>
                            <td className={styles.td}>
                              <select
                                className={styles.select}
                                value={u.role}
                                onChange={(e) => setUsers((prev) => prev.map((x) => (x.id === u.id ? { ...x, role: e.target.value } : x)))}
                              >
                                <option value="user">User</option>
                                <option value="admin">Admin</option>
                              </select>
                            </td>
                            <td className={styles.td}>
                              <input
                                className={styles.inputSmall}
                                value={u.subscription_type || ""}
                                onChange={(e) => setUsers((prev) => prev.map((x) => (x.id === u.id ? { ...x, subscription_type: e.target.value } : x)))}
                                placeholder="beta"
                              />
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
                              <div className={styles.row}>
                                <button className={`${styles.miniBtn} ${styles.miniPrimary}`} type="button" onClick={() => saveUser(u)}>
                                  Save
                                </button>
                                <button className={`${styles.miniBtn} ${styles.miniDanger}`} type="button" onClick={() => deleteUser(u.id)}>
                                  Deactivate
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : null}
                </div>
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
                      <h2 style={{ margin: 0, color: "#fff" }}>Create new plan</h2>
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
                  {plansLoading ? <div className={styles.muted}>Loading plans…</div> : null}
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
                  {profileLoading ? <div className={styles.muted}>Loading profile…</div> : null}
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
          <button
            type="button"
            className={styles.modalBackdrop}
            aria-label="Close"
            onClick={() => setShowAddProject(false)}
          />
          <div className={styles.modalPanel} role="dialog" aria-modal="true" aria-label="Add project">
            <div className={styles.modalHead}>
              <h3 className={styles.modalTitle}>Add project</h3>
              <button type="button" className={styles.iconButton} aria-label="Close" onClick={() => setShowAddProject(false)}>
                <Icon.X className={styles.icon20} />
              </button>
            </div>

            <div className={styles.modalBody}>
              <label className={styles.label}>
                Project name
                <input className={styles.input} value={name} onChange={(e) => setName(e.target.value)} />
              </label>
              <label className={styles.label}>
                Website URL
                <input className={styles.input} value={website} onChange={(e) => setWebsite(e.target.value)} />
              </label>
              {error ? <p className={styles.error}>{error}</p> : null}
            </div>

            <div className={styles.modalFooter}>
              <button type="button" className={styles.btnSecondary} onClick={() => setShowAddProject(false)}>
                Cancel
              </button>
              <button className={styles.button} type="button" onClick={createProject} disabled={creating || !name.trim()}>
                {creating ? "Creating…" : "Create"}
              </button>
            </div>
          </div>
        </>
      ) : null}

      {showWpConnect && wpProject ? (
        <>
          <button type="button" className={styles.modalBackdrop} aria-label="Close" onClick={() => setShowWpConnect(false)} />
          <div className={styles.modalPanel} role="dialog" aria-modal="true" aria-label="Connect WordPress">
            <div className={styles.modalHead}>
              <h3 className={styles.modalTitle}>Connect your WordPress site</h3>
              <button type="button" className={styles.iconButton} aria-label="Close" onClick={() => setShowWpConnect(false)}>
                <Icon.X className={styles.icon20} />
              </button>
            </div>
            <div className={styles.modalBody}>
              <div className={styles.muted} style={{ fontSize: 13, lineHeight: 1.5 }}>
                Next, connect your WordPress website so we can publish generated articles. Add your WordPress username and
                an Application Password (Users → Profile → Application Passwords).
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
                <a className={styles.btnSecondary} href={wpSettings?.plugin_download_url || "/api/wordpress/plugin/download"}>
                  Download plugin
                </a>
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

              {wpVerify ? (
                <div className={wpVerify.ok ? styles.muted : styles.error} style={{ fontSize: 13, whiteSpace: "pre-wrap" }}>
                  {wpVerify.message}
                </div>
              ) : null}
            </div>
            <div className={styles.modalFooter}>
              <button type="button" className={styles.btnSecondary} onClick={() => setShowWpConnect(false)}>
                Cancel
              </button>
              <button
                className={styles.button}
                type="button"
                disabled={!wpVerify?.ok}
                onClick={() => {
                  setShowWpConnect(false);
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
          <div className={styles.modalPanel} role="dialog" aria-modal="true" aria-label="User details">
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
              {userDetailsLoading ? <div className={styles.muted}>Loading…</div> : null}
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
          <div className={`${styles.modalPanel} ${dashStyles.workspaceModal}`} role="dialog" aria-modal="true" aria-label="User workspace">
            <div className={styles.modalHead}>
              <h3 className={styles.modalTitle}>
                {userWorkspace ? `Workspace — ${userWorkspace.email}` : userWorkspaceLoading ? "Loading workspace…" : "Workspace"}
              </h3>
              <button type="button" className={styles.btnSecondary} onClick={closeUserWorkspace}>
                Close
              </button>
            </div>
            <div className={`${styles.modalBody} ${dashStyles.workspaceModalBody}`}>
              {userWorkspaceLoading ? <div className={styles.muted}>Loading projects and articles…</div> : null}
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

      {showTutorial ? <TutorialStepperModal onClose={() => setShowTutorial(false)} /> : null}
    </div>
  );
}


