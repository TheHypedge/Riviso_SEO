"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import styles from "../page.module.css";
import dashStyles from "./dashboard.module.css";
import {
  AdminUserDetails,
  AdminUserPublic,
  AdminWorkspaceResponse,
  api,
  clearAuth,
  getAccessToken,
  GscStatus,
  PlanPublic,
  ProfilePublic,
  ProjectPublic,
  ProjectSettings,
  WordpressVerifyResponse,
} from "@/lib/api";

type DashSection = "projects" | "users" | "limits" | "profile";

export default function DashboardPage() {
  const router = useRouter();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [meEmail, setMeEmail] = useState<string>("");
  const [projects, setProjects] = useState<ProjectPublic[]>([]);
  const [name, setName] = useState("");
  const [website, setWebsite] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [section, setSection] = useState<DashSection>("projects");
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
  const [plansLoading, setPlansLoading] = useState(false);
  const [profile, setProfile] = useState<ProfilePublic | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileClockTick, setProfileClockTick] = useState(0);
  const [gsc, setGsc] = useState<GscStatus | null>(null);
  const [gscConnecting, setGscConnecting] = useState(false);
  const [showGscCongrats, setShowGscCongrats] = useState(false);
  const [gscMsg, setGscMsg] = useState<string | null>(null);

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
  const [newPlanCostMonthly, setNewPlanCostMonthly] = useState<number>(0);
  const [newPlanIsDefault, setNewPlanIsDefault] = useState<boolean>(false);

  const token = useMemo(() => getAccessToken(), []);

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
        const items = await api.listProjects();
        setProjects(items);
        try {
          const gs = await api.gscStatus();
          setGsc(gs);
        } catch {
          setGsc(null);
        }
      } catch (e) {
        clearAuth();
        router.replace("/login");
      } finally {
        setLoading(false);
      }
    })();
  }, [router, token]);

  useEffect(() => {
    // Handle OAuth callback redirect flags (best-effort).
    try {
      const url = new URL(window.location.href);
      const rawHash = (url.hash || "").replace(/^#/, "");
      const hashParams = new URLSearchParams(rawHash);
      const flag = (hashParams.get("gsc") || "").trim();
      const msg = (hashParams.get("msg") || "").trim();
      if (flag === "connected") {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setShowGscCongrats(true);
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setGscMsg(null);
        // refresh status
        api.gscStatus().then(setGsc).catch(() => {});
        url.hash = "";
        window.history.replaceState({}, "", url.toString());
      } else if (flag === "error") {
        setGscMsg(msg || "Google connect failed. Please try again.");
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
        if (section === "users") {
          setUsersLoading(true);
          const items = await api.adminListUsers();
          setUsers(items);
        } else if (section === "limits") {
          setPlansLoading(true);
          const items = await api.adminListPlans();
          setPlans(items);
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
  }, [browserTimeZone, section, token]);

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

  async function connectGoogleSearchConsole() {
    setError(null);
    setGscMsg(null);
    setGscConnecting(true);
    try {
      const res = await api.gscConnectUrl();
      if (res?.url) window.location.href = res.url;
      else throw new Error("No OAuth URL returned");
    } catch (e) {
      setGscMsg(e instanceof Error ? e.message : "Could not start Google connect");
    } finally {
      setGscConnecting(false);
    }
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
    if (!confirm("Delete this user? This only deletes the user row (projects/articles are not removed).")) return;
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
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save plan");
    }
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
            <div className={styles.sidebarTitle}>ADMIN</div>
            <div className={styles.navGroup}>
              <button
                type="button"
                className={`${styles.navItem} ${section === "projects" ? styles.navItemActive : ""}`}
                onClick={() => {
                  setSection("projects");
                  setMobileNavOpen(false);
                }}
              >
                Project management
              </button>
              <button
                type="button"
                className={`${styles.navItem} ${section === "users" ? styles.navItemActive : ""}`}
                onClick={() => {
                  setSection("users");
                  setMobileNavOpen(false);
                }}
              >
                Manage users
              </button>
              <button
                type="button"
                className={`${styles.navItem} ${section === "limits" ? styles.navItemActive : ""}`}
                onClick={() => {
                  setSection("limits");
                  setMobileNavOpen(false);
                }}
              >
                System limitations
              </button>
              <button
                type="button"
                className={`${styles.navItem} ${section === "profile" ? styles.navItemActive : ""}`}
                onClick={() => {
                  setSection("profile");
                  setMobileNavOpen(false);
                }}
              >
                Settings / Profile
              </button>
            </div>

            <div className={styles.sidebarTitle}>ACCOUNT</div>
            <div className={styles.navGroup}>
              <button
                type="button"
                className={styles.navItem}
                onClick={() => {
                  setMobileNavOpen(false);
                  logout();
                }}
              >
                Logout
              </button>
              <button
                type="button"
                className={styles.navItem}
                onClick={connectGoogleSearchConsole}
                disabled={gscConnecting}
              >
                <span className={dashStyles.navItemRow}>
                  <span>{gscConnecting ? "Connecting Google…" : "Connect Google (Search Console)"}</span>
                  {gsc?.connected ? (
                    <span
                      className={dashStyles.connectedBadge}
                      title={gsc.email ? `Connected: ${gsc.email}` : "Connected"}
                    >
                      <span aria-hidden="true" className={dashStyles.connectedDot} />
                      Connected
                    </span>
                  ) : null}
                </span>
              </button>
              <button
                type="button"
                className={styles.navItem}
                onClick={() => alert("Tutorial will be wired next.")}
              >
                Watch tutorial
              </button>
            </div>

            <div className={styles.muted}>Signed in as {meEmail || "…"}</div>
          </aside>

          <section className={styles.contentCol}>
            {error ? <div className={styles.error}>{error}</div> : null}
            {gscMsg ? <div className={styles.error}>{gscMsg}</div> : null}

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
                      <div key={p.id} className={styles.projectCard}>
                        <div className={styles.projectCardTop}>
                          <div className={styles.projectTitle}>{p.name}</div>
                          <Link className={styles.btnSecondary} href={`/projects/${p.id}`}>
                            Open
                          </Link>
                        </div>
                        <div className={styles.muted}>{p.website_url || "—"}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            ) : null}

            {section === "users" ? (
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
                                  Delete
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

            {section === "limits" ? (
              <>
                <div className={styles.intro}>
                  <h1>System limitations</h1>
                  
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
                            <button className={`${styles.miniBtn} ${styles.miniPrimary}`} type="button" onClick={() => upsertPlan(p.key, p)}>
                              Save plan
                            </button>
                          </div>

                          <div className={dashStyles.planEditGrid}>
                            <label className={styles.label}>
                              Plan name
                              <input
                                className={styles.input}
                                value={p.name || ""}
                                onChange={(e) => setPlans((prev) => prev.map((x) => (x.key === p.key ? { ...x, name: e.target.value } : x)))}
                              />
                            </label>
                            <label className={styles.label}>
                              Default for new users
                              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                <input
                                  type="checkbox"
                                  checked={Boolean(p.is_default)}
                                  onChange={(e) => setPlans((prev) => prev.map((x) => (x.key === p.key ? { ...x, is_default: e.target.checked } : x)))}
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
                                onChange={(e) => setPlans((prev) => prev.map((x) => (x.key === p.key ? { ...x, cost_monthly: Number(e.target.value || 0) } : x)))}
                              />
                            </label>
                            <label className={styles.label}>
                              Max projects
                              <input
                                className={styles.input}
                                type="number"
                                min={0}
                                value={p.max_projects ?? 0}
                                onChange={(e) => setPlans((prev) => prev.map((x) => (x.key === p.key ? { ...x, max_projects: Number(e.target.value || 0) } : x)))}
                              />
                            </label>
                            <label className={styles.label}>
                              Max articles / day
                              <input
                                className={styles.input}
                                type="number"
                                min={0}
                                value={p.max_articles_per_day ?? 0}
                                onChange={(e) => setPlans((prev) => prev.map((x) => (x.key === p.key ? { ...x, max_articles_per_day: Number(e.target.value || 0) } : x)))}
                              />
                            </label>
                            <label className={styles.label}>
                              Max articles / month
                              <input
                                className={styles.input}
                                type="number"
                                min={0}
                                value={p.max_articles_per_month ?? 0}
                                onChange={(e) => setPlans((prev) => prev.map((x) => (x.key === p.key ? { ...x, max_articles_per_month: Number(e.target.value || 0) } : x)))}
                              />
                            </label>
                            <label className={styles.label}>
                              Export Articles
                              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                                <input
                                  type="checkbox"
                                  checked={Boolean(p.allow_export)}
                                  onChange={(e) => setPlans((prev) => prev.map((x) => (x.key === p.key ? { ...x, allow_export: e.target.checked } : x)))}
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
                                  onChange={(e) => setPlans((prev) => prev.map((x) => (x.key === p.key ? { ...x, max_export_per_month: Number(e.target.value || 0) } : x)))}
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
                                  onChange={(e) => setPlans((prev) => prev.map((x) => (x.key === p.key ? { ...x, allow_scheduling: e.target.checked } : x)))}
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
                                  onChange={(e) => setPlans((prev) => prev.map((x) => (x.key === p.key ? { ...x, max_scheduled_per_month: Number(e.target.value || 0) } : x)))}
                                  disabled={!p.allow_scheduling}
                                />
                              </div>
                            </label>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              </>
            ) : null}

            {section === "profile" ? (
              <>
                <div className={styles.intro}>
                  <h1>Settings / Profile</h1>
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

      {showGscCongrats ? (
        <>
          <button type="button" className={styles.modalBackdrop} aria-label="Close" onClick={() => setShowGscCongrats(false)} />
          <div className={styles.modalPanel} role="dialog" aria-modal="true" aria-label="Google Search Console connected">
            <div className={styles.modalHead}>
              <h3 className={styles.modalTitle}>Congratulations!</h3>
              <button type="button" className={styles.iconButton} aria-label="Close" onClick={() => setShowGscCongrats(false)}>
                <Icon.X className={styles.icon20} />
              </button>
            </div>
            <div className={styles.modalBody}>
              <div style={{ position: "relative", overflow: "hidden", borderRadius: 12, padding: 12, border: "1px solid var(--button-secondary-border)" }}>
                <div aria-hidden="true" style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
                  {Array.from({ length: 28 }).map((_, i) => (
                    <span
                      key={i}
                      style={{
                        position: "absolute",
                        left: `${(i * 37) % 100}%`,
                        top: `-12px`,
                        width: 8,
                        height: 14,
                        borderRadius: 2,
                        opacity: 0.9,
                        background: ["#7dd3fc", "#a78bfa", "#34d399", "#fbbf24", "#fb7185"][i % 5],
                        transform: `rotate(${(i * 23) % 180}deg)`,
                        animation: `aaConfettiFall ${1200 + (i % 7) * 130}ms linear ${i * 35}ms 1 both`,
                      }}
                    />
                  ))}
                </div>

                <div style={{ fontWeight: 800, marginBottom: 6 }}>
                  Google Search Console is connected{gsc?.email ? ` (${gsc.email})` : ""}.
                </div>
                <div className={styles.muted} style={{ fontSize: 13, lineHeight: 1.5 }}>
                  Go to <strong>Project settings</strong> and connect the Google Search Console property.
                </div>
              </div>
            </div>
            <div className={styles.modalFooter}>
              <button type="button" className={styles.button} onClick={() => setShowGscCongrats(false)}>
                OK
              </button>
            </div>
          </div>
          <style jsx global>{`
            @keyframes aaConfettiFall {
              0% {
                transform: translateY(0) rotate(0deg);
                opacity: 1;
              }
              100% {
                transform: translateY(220px) rotate(180deg);
                opacity: 0;
              }
            }
          `}</style>
        </>
      ) : null}

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
    </div>
  );
}


