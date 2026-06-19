"use client";

import Image from "next/image";
import Link from "next/link";
import styles from "../app/page.module.css";
import sidebarStyles from "./ProjectSidebar.module.css";
import { ProjectTabIcon, SidebarBackIcon, type ProjectTabKey } from "./ProjectTabIcon";

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
  | "project_settings";

const TAB_LABELS: Record<TabKey, string> = {
  overview: "Overview",
  articles: "Articles",
  products: "Products",
  research: "Research",
  scheduled_articles: "Scheduled Articles",
  prompts: "Prompts",
  context_links: "Context links",
  tools: "Tools",
  performance: "Performance & Analysis",
  project_settings: "Project Settings",
};

const DEFAULT_TAB_ORDER: TabKey[] = [
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
];

export type ProjectSidebarProps = {
  projectId: string;
  projects: Array<{ id: string; name: string }>;
  email: string;
  plan: string;
  activeTab: string;
  onTabClick: (tab: string) => void;
  onProjectSwitch: (projectId: string) => void;
  hideTabs?: string[];
  mobileOpen?: boolean;
  onMobileClose?: () => void;
};

export function ProjectSidebar({
  projectId,
  projects,
  email,
  plan,
  activeTab,
  onTabClick,
  onProjectSwitch,
  hideTabs,
  mobileOpen,
  onMobileClose,
}: ProjectSidebarProps) {
  const hideSet = hideTabs ? new Set(hideTabs) : null;
  const visibleTabs = DEFAULT_TAB_ORDER.filter((k) => !hideSet || !hideSet.has(k));

  const projectList = projects.length > 0 ? projects : [{ id: projectId, name: "Current project" }];
  const currentName =
    (projectList.find((p) => p.id === projectId)?.name || "").trim() || "Current project";

  return (
    <>
      {mobileOpen ? (
        <button
          type="button"
          className={sidebarStyles.overlay}
          onClick={onMobileClose}
          aria-label="Close navigation"
        />
      ) : null}
      <aside
        className={`${sidebarStyles.sidebar} ${mobileOpen ? sidebarStyles.sidebarOpen : ""}`}
        aria-label="Project navigation"
      >
        <button
          type="button"
          className={sidebarStyles.mobileClose}
          onClick={onMobileClose}
          aria-label="Close navigation"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" className={sidebarStyles.mobileCloseIcon}>
            <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>

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

          <div className={styles.projectSwitcherBlock}>
            <label
              className={styles.sidebarTitle}
              htmlFor="aa-sidebar-project-switcher"
              style={{ marginBottom: 8 }}
            >
              CURRENT PROJECT
            </label>
            <div className={styles.projectSwitcherField}>
              <select
                id="aa-sidebar-project-switcher"
                className={styles.projectSwitcher}
                value={projectId}
                onChange={(e) => onProjectSwitch(e.target.value)}
                aria-label="Switch project"
                title={currentName}
              >
                {projectList.map((p) => (
                  <option key={p.id} value={p.id}>
                    {(p.name || "").trim() || "Untitled project"}
                  </option>
                ))}
              </select>
              <span className={styles.projectSwitcherChevron} aria-hidden="true">
                ▾
              </span>
            </div>
          </div>

          <div className={styles.sidebarDivider} aria-hidden="true" />

          <div className={styles.sidebarTitle}>SECTIONS</div>
          <div className={styles.navGroup} role="navigation" aria-label="Project sections">
            {visibleTabs.map((k) => (
              <button
                key={k}
                type="button"
                className={`${styles.navItem} ${activeTab === k ? styles.navItemActive : ""}`}
                onClick={() => {
                  onTabClick(k);
                  onMobileClose?.();
                }}
              >
                <ProjectTabIcon tab={k as ProjectTabKey} className={styles.navItemIcon} />
                <span className={styles.navItemLabel}>{TAB_LABELS[k]}</span>
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
              {(email || "U").charAt(0).toUpperCase()}
            </div>
            <div className={styles.sidebarAccountMeta}>
              <div className={styles.sidebarAccountEmail} title={email || "Signed in"}>
                {email || "Signed in"}
              </div>
              <div className={styles.sidebarAccountPlan}>Plan: {plan}</div>
            </div>
          </Link>
        </div>
      </aside>
    </>
  );
}

export { sidebarStyles as ProjectSidebarStyles };
