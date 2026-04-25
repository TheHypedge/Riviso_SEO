"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import styles from "../../page.module.css";
import { api, ArticlePublic, BulkUploadRow, clearAccessToken, getAccessToken, PromptListResponse } from "@/lib/api";

type StatusFilter = "" | "pending" | "draft" | "scheduled" | "published";
type TabKey = "articles" | "scheduled_articles" | "configuration" | "prompts" | "context_links" | "tools" | "project_settings";

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

export default function ProjectPage() {
  const router = useRouter();
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;

  const token = useMemo(() => getAccessToken(), []);
  const [tab, setTab] = useState<TabKey>("articles");
  const [settings, setSettings] = useState<import("@/lib/api").ProjectSettings | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsVerify, setSettingsVerify] = useState<import("@/lib/api").WordpressVerifyResponse | null>(null);
  const [settingsVerifying, setSettingsVerifying] = useState(false);

  const [sName, setSName] = useState("");
  const [sUrl, setSUrl] = useState("");
  const [sWpUser, setSWpUser] = useState("");
  const [sWpPass, setSWpPass] = useState("");
  const [sWpDefaultPostType, setSWpDefaultPostType] = useState("posts");
  const [sWpDefaultStatus, setSWpDefaultStatus] = useState<"draft" | "publish">("draft");
  const [sWpDefaultCategoryIds, setSWpDefaultCategoryIds] = useState<number[]>([]);
  const [settingsPostTypes, setSettingsPostTypes] = useState<import("@/lib/api").WordpressPostType[]>([]);
  const [settingsCategories, setSettingsCategories] = useState<import("@/lib/api").WordpressCategory[]>([]);
  const settingsDirty = useMemo(() => {
    if (!settings) return false;
    return (
      sName.trim() !== (settings.name || "").trim() ||
      (sUrl || "") !== (settings.wp_site_url || settings.website_url || "") ||
      (sWpUser || "") !== (settings.wp_username || "") ||
      (sWpDefaultPostType || "") !== ((settings.default_wp_rest_base || "posts") as string) ||
      (sWpDefaultStatus || "") !== ((settings.default_wp_status || "draft") as string) ||
      JSON.stringify((sWpDefaultCategoryIds || []).slice().sort((a,b)=>a-b)) !==
        JSON.stringify(((settings.default_wp_category_ids || []) as number[]).slice().sort((a,b)=>a-b)) ||
      !!sWpPass.trim()
    );
  }, [sName, sUrl, sWpUser, sWpPass, settings, sWpDefaultPostType, sWpDefaultStatus, sWpDefaultCategoryIds]);
  const [articles, setArticles] = useState<ArticlePublic[]>([]);
  const [scheduledJobs, setScheduledJobs] = useState<import("@/lib/api").ScheduledJobPublic[]>([]);
  const [scheduledLoading, setScheduledLoading] = useState(false);
  const [title, setTitle] = useState("");
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
  const [bulkMode, setBulkMode] = useState<"root" | "change_status" | "schedule">("root");
  const [scheduleMin, setScheduleMin] = useState("");
  const [editJobMin, setEditJobMin] = useState("");
  const [bulkScheduleMin, setBulkScheduleMin] = useState("");
  const [bulkScheduleRows, setBulkScheduleRows] = useState<Array<{ id: string; title: string; when: string }>>([]);
  const [bulkScheduleWpStatus, setBulkScheduleWpStatus] = useState<"draft" | "publish">("draft");
  const [bulkSchedulePostType, setBulkSchedulePostType] = useState("posts");
  const [bulkScheduling, setBulkScheduling] = useState(false);

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
  const [showPromptModal, setShowPromptModal] = useState<null | { kind: "writing" | "image"; id: string }>(null);
  const [draftName, setDraftName] = useState("");
  const [draftText, setDraftText] = useState("");
  const [draftSetDefault, setDraftSetDefault] = useState(false);

  // Context links module state (staged edits; saved on demand)
  type LinkDraft = { id: string; label: string; url: string; isNew?: boolean };
  const [linksLoading, setLinksLoading] = useState(false);
  const [linksSaving, setLinksSaving] = useState(false);
  const [linkDrafts, setLinkDrafts] = useState<LinkDraft[]>([]);
  const [linkDeleted, setLinkDeleted] = useState<Set<string>>(new Set());
  const [showLinkModal, setShowLinkModal] = useState<null | { id: string }>(null);
  const [linkPhrase, setLinkPhrase] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
  const [linkSearch, setLinkSearch] = useState("");
  const [linkPage, setLinkPage] = useState(1);

  // Toolbar
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<StatusFilter>("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [dateOrder, setDateOrder] = useState<"desc" | "asc">("desc");
  const [page, setPage] = useState(1);
  const [profileTz, setProfileTz] = useState<string>("");

  // Bulk selection
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const selectedIds = useMemo(() => Object.keys(selected).filter((k) => selected[k]), [selected]);

  // Per-article actions
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [scheduleId, setScheduleId] = useState<string | null>(null);
  const [scheduleWhen, setScheduleWhen] = useState("");
  const [scheduleWpStatus, setScheduleWpStatus] = useState<"draft" | "publish">("draft");
  const [schedulePostType, setSchedulePostType] = useState("posts");
  const [wpDefaults, setWpDefaults] = useState<{ post_type: string; wp_status: "draft" | "publish" } | null>(null);
  const [wpTypesForSchedule, setWpTypesForSchedule] = useState<import("@/lib/api").WordpressPostType[]>([]);
  const [wpCatsForSchedule, setWpCatsForSchedule] = useState<import("@/lib/api").WordpressCategory[]>([]);
  const [scheduleWritingPrompts, setScheduleWritingPrompts] = useState<PromptListResponse | null>(null);
  const [scheduleImagePrompts, setScheduleImagePrompts] = useState<PromptListResponse | null>(null);
  const [scheduleWritingPromptId, setScheduleWritingPromptId] = useState<string>("");
  const [scheduleImagePromptId, setScheduleImagePromptId] = useState<string>("");

  const [editJob, setEditJob] = useState<null | import("@/lib/api").ScheduledJobPublic>(null);
  const [editJobWhen, setEditJobWhen] = useState("");
  const [editJobPostType, setEditJobPostType] = useState("posts");
  const [editJobStatus, setEditJobStatus] = useState<"draft" | "publish">("draft");
  const [editJobCats, setEditJobCats] = useState<number[]>([]);
  const [confirmCancelJob, setConfirmCancelJob] = useState<null | import("@/lib/api").ScheduledJobPublic>(null);
  const [confirmPostNowJob, setConfirmPostNowJob] = useState<null | import("@/lib/api").ScheduledJobPublic>(null);
  const [postNowBusy, setPostNowBusy] = useState(false);
  const [confirmClearScheduled, setConfirmClearScheduled] = useState(false);

  const pageSize = 10;

  useEffect(() => {
    if (!token) {
      router.replace("/login");
      return;
    }
    (async () => {
      setError(null);
      setLoading(true);
      try {
        const [list, ps, prof] = await Promise.all([api.listArticles(projectId), api.getProjectSettings(projectId), api.profileMe()]);
        setArticles(list);
        setProfileTz((prof?.timezone || "").trim());
        setWpDefaults({
          post_type: (ps.default_wp_rest_base || "posts") as string,
          wp_status: ((ps.default_wp_status || "draft") as "draft" | "publish"),
        });
        try {
          const [types, cats] = await Promise.all([api.wordpressPostTypes(projectId), api.wordpressCategories(projectId)]);
          setWpTypesForSchedule(types);
          setWpCatsForSchedule(cats);
        } catch {
          setWpTypesForSchedule([]);
          setWpCatsForSchedule([]);
        }

        // Prompts for scheduling (defaults pre-selected)
        try {
          const [wp, ip] = await Promise.all([api.listWritingPrompts(projectId), api.listImagePrompts(projectId)]);
          setScheduleWritingPrompts(wp);
          setScheduleImagePrompts(ip);
          setScheduleWritingPromptId(wp.default_id || "");
          setScheduleImagePromptId(ip.default_id || "");
        } catch {
          setScheduleWritingPrompts(null);
          setScheduleImagePrompts(null);
        }
      } catch {
        clearAccessToken();
        router.replace("/login");
      } finally {
        setLoading(false);
      }
    })();
  }, [projectId, router, token]);

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

  function dedupeScheduledJobs(rows: import("@/lib/api").ScheduledJobPublic[]) {
    const bestByArticle = new Map<string, import("@/lib/api").ScheduledJobPublic>();
    const score = (j: import("@/lib/api").ScheduledJobPublic) => {
      const s = (j as any).updated_at || (j as any).created_at || j.run_at || "";
      return typeof s === "string" ? s : "";
    };
    for (const j of rows || []) {
      const aid = (j.article_id || "").trim();
      if (!aid) continue;
      const cur = bestByArticle.get(aid);
      if (!cur) {
        bestByArticle.set(aid, j);
        continue;
      }
      if (score(j) > score(cur)) bestByArticle.set(aid, j);
    }
    const out = Array.from(bestByArticle.values());
    out.sort((a, b) => (b.run_at || "").localeCompare(a.run_at || ""));
    return out;
  }

  useEffect(() => {
    if (!token) return;
    if (tab !== "scheduled_articles") return;
    (async () => {
      setError(null);
      setScheduledLoading(true);
      try {
        const jobs = await api.listScheduledJobs(projectId);
        setScheduledJobs(dedupeScheduledJobs(jobs));
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load scheduled articles");
      } finally {
        setScheduledLoading(false);
      }
    })();
  }, [projectId, tab, token]);

  useEffect(() => {
    if (!token) return;
    if (tab !== "project_settings") return;
    (async () => {
      setError(null);
      setSettingsLoading(true);
      try {
        const s = await api.getProjectSettings(projectId);
        setSettings(s);
        setSName(s.name || "");
        setSUrl(s.wp_site_url || s.website_url || "");
        setSWpUser(s.wp_username || "");
        setSWpPass("");
        setSWpDefaultPostType((s.default_wp_rest_base || "posts") as string);
        setSWpDefaultStatus(((s.default_wp_status || "draft") as "draft" | "publish"));
        setSWpDefaultCategoryIds((s.default_wp_category_ids || []) as number[]);
        setSettingsVerify(null);

        // Load WP options for defaults if connected
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
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load project settings");
      } finally {
        setSettingsLoading(false);
      }
    })();
  }, [projectId, tab, token]);

  async function saveSettings() {
    if (!settings) return;
    setError(null);
    setSettingsSaving(true);
    try {
      const saved = await api.updateProjectSettings(projectId, {
        name: sName,
        wp_site_url: sUrl,
        wp_username: sWpUser,
        default_wp_rest_base: sWpDefaultPostType,
        default_wp_status: sWpDefaultStatus,
        default_wp_category_ids: sWpDefaultCategoryIds,
        ...(sWpPass.trim() ? { wp_app_password: sWpPass } : {}),
      });
      setSettings(saved);
      setSWpPass("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save settings");
    } finally {
      setSettingsSaving(false);
    }
  }

  async function verifySettings() {
    setSettingsVerify(null);
    setSettingsVerifying(true);
    try {
      const res = await api.verifyWordpress(projectId, {
        wp_site_url: sUrl,
        wp_username: sWpUser,
        ...(sWpPass.trim() ? { wp_app_password: sWpPass } : {}),
      });
      setSettingsVerify(res);
    } catch (e) {
      setSettingsVerify({ ok: false, status: "error", message: e instanceof Error ? e.message : "Verify failed" });
    } finally {
      setSettingsVerifying(false);
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
    queueMicrotask(() => {
      setPage(1);
      setSelected({});
    });
  }, [q, status, dateFrom, dateTo, projectId]);

  async function createArticle() {
    setError(null);
    setCreating(true);
    try {
      const a = await api.createArticle(projectId, title);
      setArticles((prev) => [a, ...prev]);
      setTitle("");
      setShowAddArticle(false);
    } catch (e) {
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
      const all = await api.listArticles(projectId);
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

      setBulkUploadRows(outRows);
      if (rowErrors.length) setBulkUploadErrors(rowErrors.slice(0, 30));
    } catch (e) {
      setBulkUploadErrors([e instanceof Error ? e.message : "Failed to read the uploaded Excel file."]);
    }
  }

  async function importBulkRows() {
    if (!bulkUploadRows.length) return;
    setError(null);
    setBulkUploading(true);
    try {
      const res = await api.bulkUploadArticles(projectId, bulkUploadRows);
      // fastest: refresh list (also ensures ordering latest->oldest)
      setArticles(await api.listArticles(projectId));
      setShowBulkUpload(false);
      setBulkUploadRows([]);
      setBulkUploadErrors([]);
      if (!res.created) setError("No articles were created from the uploaded file.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Bulk upload failed");
    } finally {
      setBulkUploading(false);
    }
  }

  const filtered = useMemo(() => {
    const qn = q.trim().toLowerCase();
    const df = parseDateOnly(dateFrom);
    const dt = parseDateOnly(dateTo);

    const out = articles.filter((a) => {
      if (status && (a.status || "").toLowerCase() !== status) return false;

      if (qn) {
        const hay = [
          a.title,
          a.focus_keyphrase || "",
          ...(a.keywords || []),
        ]
          .join(" ")
          .toLowerCase();
        if (!hay.includes(qn)) return false;
      }

      const ca = parseCreatedAt(a.created_at);
      if (df && ca && ca < df) return false;
      if (dt && ca) {
        // inclusive end date
        const end = new Date(dt.getTime() + 24 * 60 * 60 * 1000);
        if (ca >= end) return false;
      }
      return true;
    });

    const createdAtMs = (a: { created_at?: string | null }) => {
      const d = parseCreatedAt(a.created_at);
      return d ? d.getTime() : 0;
    };

    out.sort((a, b) => (dateOrder === "asc" ? createdAtMs(a) - createdAtMs(b) : createdAtMs(b) - createdAtMs(a)));
    return out;
  }, [articles, dateFrom, dateTo, q, status, dateOrder]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const pageClamped = Math.min(Math.max(1, page), totalPages);
  const pageItems = filtered.slice((pageClamped - 1) * pageSize, pageClamped * pageSize);

  const allOnPageSelected = pageItems.length > 0 && pageItems.every((a) => selected[a.id]);

  function toggleAllOnPage() {
    const next = { ...selected };
    const value = !allOnPageSelected;
    for (const a of pageItems) next[a.id] = value;
    setSelected(next);
  }

  function toggleOne(id: string) {
    setSelected((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  async function bulkDelete() {
    if (selectedIds.length === 0) return;
    if (!confirm(`Delete ${selectedIds.length} selected article(s)? This cannot be undone.`)) return;
    setError(null);
    try {
      await api.bulkDeleteArticles(projectId, selectedIds);
      setArticles((prev) => prev.filter((a) => !selectedIds.includes(a.id)));
      setSelected({});
    } catch (e) {
      setError(e instanceof Error ? e.message : "Bulk delete failed");
    }
  }

  async function deleteOne(articleId: string) {
    setError(null);
    try {
      await api.bulkDeleteArticles(projectId, [articleId]);
      setArticles((prev) => prev.filter((x) => x.id !== articleId));
      setSelected((prev) => {
        const next = { ...prev };
        delete next[articleId];
        return next;
      });
      setConfirmDeleteId(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    }
  }

  async function scheduleOne(articleId: string) {
    setError(null);
    try {
      const when = scheduleWhen.trim();
      if (!when) throw new Error("Please choose a schedule time");

      await api.scheduleArticle(projectId, articleId, {
        wp_scheduled_at: when,
        wp_status: scheduleWpStatus,
        post_type: schedulePostType,
        writing_prompt_id: scheduleWritingPromptId || null,
        image_prompt_id: scheduleImagePromptId || null,
        generate_image: true,
      });
      const list = await api.listArticles(projectId);
      setArticles(list);
      // Keep Scheduled Articles tab in sync (so reschedules show immediately on top)
      try {
        const jobs = await api.listScheduledJobs(projectId);
        setScheduledJobs(dedupeScheduledJobs(jobs));
      } catch {
        // ignore; scheduled tab can still refresh later
      }
      setScheduleId(null);
      setScheduleWhen("");
      setScheduleWpStatus("draft");
      setSchedulePostType("posts");
      setScheduleWritingPromptId(scheduleWritingPrompts?.default_id || "");
      setScheduleImagePromptId(scheduleImagePrompts?.default_id || "");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Schedule failed");
    }
  }

  async function postNowFromScheduledJob() {
    const j = confirmPostNowJob;
    if (!j) return;
    setError(null);
    setPostNowBusy(true);
    try {
      await api.publishArticleToLiveSite(projectId, j.article_id, {
        post_type: (j.post_type || "posts").trim() || "posts",
        wp_status: (String(j.wp_status || "draft").toLowerCase() === "publish" ? "publish" : "draft") as "draft" | "publish",
        category_ids: j.category_ids || [],
      });
      setArticles(await api.listArticles(projectId));
      setScheduledJobs(dedupeScheduledJobs(await api.listScheduledJobs(projectId)));
      setConfirmPostNowJob(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Post now failed");
    } finally {
      setPostNowBusy(false);
    }
  }

  async function bulkChangeStatus(newStatus: "pending" | "draft" | "published") {
    if (selectedIds.length === 0) return;
    setError(null);
    try {
      await api.bulkChangeStatus(projectId, selectedIds, newStatus);
      setArticles((prev) =>
        prev.map((a) => (selectedIds.includes(a.id) ? { ...a, status: newStatus } : a)),
      );
      setSelected({});
    } catch (e) {
      setError(e instanceof Error ? e.message : "Bulk status update failed");
    }
  }

  function bulkEdit() {
    if (selectedIds.length !== 1) return;
    const aid = selectedIds[0];
    router.push(`/projects/${projectId}/articles/${aid}`);
  }

  function bulkSchedule() {
    if (!selectedIds.length) return;
    const min = new Date(Date.now() + 5 * 60 * 1000);
    const minStr = toDatetimeLocalFromDateInProfileTz(min);
    setBulkScheduleMin(minStr);
    setBulkScheduleWpStatus(wpDefaults?.wp_status || "draft");
    setBulkSchedulePostType(wpDefaults?.post_type || "posts");
    setScheduleWritingPromptId(scheduleWritingPrompts?.default_id || "");
    setScheduleImagePromptId(scheduleImagePrompts?.default_id || "");
    setBulkScheduleRows(
      selectedIds.map((id) => ({
        id,
        title: articles.find((a) => a.id === id)?.title || "(Untitled)",
        when: minStr,
      })),
    );
    setBulkMode("schedule");
  }

  async function bulkScheduleSubmit() {
    if (!bulkScheduleRows.length) return;
    setError(null);
    setBulkScheduling(true);
    try {
      for (const r of bulkScheduleRows) {
        const when = (r.when || "").trim();
        if (!when) throw new Error("Please set date/time for all selected articles");
        await api.scheduleArticle(projectId, r.id, {
          wp_scheduled_at: when,
          wp_status: bulkScheduleWpStatus,
          post_type: bulkSchedulePostType,
          writing_prompt_id: scheduleWritingPromptId || null,
          image_prompt_id: scheduleImagePromptId || null,
          generate_image: true,
        });
      }

      setArticles(await api.listArticles(projectId));
      try {
        setScheduledJobs(dedupeScheduledJobs(await api.listScheduledJobs(projectId)));
      } catch {
        // ignore
      }
      setSelected({});
      setShowBulkPopup(false);
      setBulkMode("root");
      setBulkScheduleRows([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Bulk schedule failed");
    } finally {
      setBulkScheduling(false);
    }
  }

  function openPromptModal(kind: "writing" | "image", id: string) {
    const list = kind === "writing" ? wpDrafts : ipDrafts;
    const row = list.find((x) => x.id === id);
    setDraftName(row?.name || "");
    setDraftText(row?.text || "");
    const def = kind === "writing" ? wpDefault : ipDefault;
    setDraftSetDefault(!!id && def === id);
    setShowPromptModal({ kind, id });
  }

  function startAddPrompt(kind: "writing" | "image") {
    const tmpId = `new_${kind}_${Date.now()}`;
    if (kind === "writing") setWpDrafts((p) => [{ id: tmpId, name: "", text: "", isNew: true }, ...p]);
    else setIpDrafts((p) => [{ id: tmpId, name: "", text: "", isNew: true }, ...p]);
    openPromptModal(kind, tmpId);
  }

  function markDeletePrompt(kind: "writing" | "image", id: string) {
    if (!confirm("Delete this prompt? (Will apply when you click Save changes)")) return;
    if (kind === "writing") {
      setWpDrafts((p) => p.filter((x) => x.id !== id));
      setWpDeleted((s) => new Set([...Array.from(s), id]));
      if (wpDefault === id) setWpDefault("");
    } else {
      setIpDrafts((p) => p.filter((x) => x.id !== id));
      setIpDeleted((s) => new Set([...Array.from(s), id]));
      if (ipDefault === id) setIpDefault("");
    }
  }

  async function savePrompts() {
    setError(null);
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
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save prompts");
    } finally {
      setPromptsSaving(false);
    }
  }

  function openLinkModal(id: string) {
    const row = linkDrafts.find((x) => x.id === id);
    setLinkPhrase(row?.label || "");
    setLinkUrl(row?.url || "");
    setShowLinkModal({ id });
  }

  function startAddLink() {
    const tmpId = `new_link_${Date.now()}`;
    setLinkDrafts((p) => [{ id: tmpId, label: "", url: "", isNew: true }, ...p]);
    openLinkModal(tmpId);
  }

  function markDeleteLink(id: string) {
    if (!confirm("Delete this context link? (Will apply when you click Save changes)")) return;
    setLinkDrafts((p) => p.filter((x) => x.id !== id));
    setLinkDeleted((s) => new Set([...Array.from(s), id]));
  }

  async function saveContextLinks() {
    setError(null);
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
    return `${styles.statusPill} ${styles.statusNeutral}`;
  }

  function jobStateLabel(s: string) {
    const v = (s || "").toLowerCase();
    if (v === "scheduled") return "Scheduled";
    if (v === "content_generating") return "Generating content…";
    if (v === "image_generating") return "Generating image…";
    if (v === "ready_to_post") return "Article is ready to post";
    if (v === "posting") return "Posting in progress";
    if (v === "posted") return "Posted";
    if (v === "failed") return "Failed";
    if (v === "cancelled") return "Cancelled";
    return v || "unknown";
  }

  return (
    <div className={`${styles.page} ${styles.pageTop}`}>
      <main className={`${styles.main} ${styles.mainWide}`}>
        <div className={styles.intro}>
          <h1>Project</h1>
          <p>
            <Link href="/dashboard">← Back to dashboard</Link>
          </p>
        </div>

        <div className={styles.tabs} role="tablist" aria-label="Project sections">
          <button
            type="button"
            className={`${styles.tab} ${tab === "articles" ? styles.tabActive : ""}`}
            onClick={() => setTab("articles")}
          >
            Articles
          </button>
          <button
            type="button"
            className={`${styles.tab} ${tab === "scheduled_articles" ? styles.tabActive : ""}`}
            onClick={() => setTab("scheduled_articles")}
          >
            Scheduled Articles
          </button>
          <button
            type="button"
            className={`${styles.tab} ${tab === "configuration" ? styles.tabActive : ""}`}
            onClick={() => setTab("configuration")}
          >
            Configuration
          </button>
          <button
            type="button"
            className={`${styles.tab} ${tab === "prompts" ? styles.tabActive : ""}`}
            onClick={() => setTab("prompts")}
          >
            Prompts
          </button>
          <button
            type="button"
            className={`${styles.tab} ${tab === "context_links" ? styles.tabActive : ""}`}
            onClick={() => setTab("context_links")}
          >
            Context links
          </button>
          <button
            type="button"
            className={`${styles.tab} ${tab === "tools" ? styles.tabActive : ""}`}
            onClick={() => {
              if (!confirmLoseChanges()) return;
              setTab("tools");
            }}
          >
            Tools
          </button>
          <button
            type="button"
            className={`${styles.tab} ${tab === "project_settings" ? styles.tabActive : ""}`}
            onClick={() => {
              if (!confirmLoseChanges()) return;
              setTab("project_settings");
            }}
          >
            Project Settings
          </button>
        </div>

        {tab === "articles" ? (
          <>
            {showBulkPopup ? (
              <>
                <div className={styles.bulkBackdrop} onClick={() => setShowBulkPopup(false)} />
                <div className={styles.bulkPopup} role="dialog" aria-modal="true" aria-label="Bulk actions">
                  <div className={styles.bulkPopupHead}>
                    <div className={styles.bulkPopupTitle}>
                      <strong>Bulk actions</strong>
                      <span>{selectedIds.length} selected</span>
                    </div>
                    <button className={styles.bulkPopupClose} type="button" onClick={() => setShowBulkPopup(false)}>
                      Close
                    </button>
                  </div>
                  {bulkMode === "root" ? (
                    <div className={styles.bulkPopupActions} style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))" }}>
                      <button
                        className={styles.button}
                        type="button"
                        onClick={bulkEdit}
                        disabled={selectedIds.length !== 1}
                        title={selectedIds.length !== 1 ? "Select exactly 1 article to edit" : "Edit selected article"}
                      >
                        Edit article
                      </button>
                      <button className={styles.button} type="button" onClick={() => setBulkMode("change_status")}>
                        Change status
                      </button>
                      <button className={styles.button} type="button" onClick={bulkSchedule}>
                        Schedule articles
                      </button>
                      <button className={styles.button} type="button" onClick={bulkDelete}>
                        Delete articles
                      </button>
                    </div>
                  ) : bulkMode === "change_status" ? (
                    <>
                      <div className={styles.row} style={{ paddingTop: 12, justifyContent: "space-between", alignItems: "center" }}>
                        <div className={styles.muted} style={{ fontWeight: 700 }}>
                          Pick a status
                        </div>
                        <button type="button" className={styles.btnSecondary} onClick={() => setBulkMode("root")}>
                          Back
                        </button>
                      </div>
                      <div className={styles.bulkPopupActions} style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
                        <button className={styles.button} type="button" onClick={() => bulkChangeStatus("pending")}>
                          Pending
                        </button>
                        <button className={styles.button} type="button" onClick={() => bulkChangeStatus("draft")}>
                          Draft
                        </button>
                        <button className={styles.button} type="button" onClick={() => bulkChangeStatus("published")}>
                          Published
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className={styles.row} style={{ paddingTop: 12, justifyContent: "space-between", alignItems: "center" }}>
                        <div className={styles.muted} style={{ fontWeight: 700 }}>
                          Schedule {bulkScheduleRows.length} article(s) {profileTz ? <span style={{ fontWeight: 500 }}>(Timezone: {profileTz})</span> : null}
                        </div>
                        <button type="button" className={styles.btnSecondary} onClick={() => setBulkMode("root")} disabled={bulkScheduling}>
                          Back
                        </button>
                      </div>

                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, paddingTop: 10 }}>
                        <label className={styles.label}>
                          WordPress post type (applies to all)
                          <select className={styles.input} value={bulkSchedulePostType} onChange={(e) => setBulkSchedulePostType(e.target.value)} disabled={bulkScheduling}>
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
                          WordPress status (applies to all)
                          <select className={styles.input} value={bulkScheduleWpStatus} onChange={(e) => setBulkScheduleWpStatus(e.target.value as "draft" | "publish")} disabled={bulkScheduling}>
                            <option value="draft">Draft</option>
                            <option value="publish">Publish</option>
                          </select>
                        </label>
                      </div>

                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, paddingTop: 10 }}>
                        <label className={styles.label}>
                          Writing prompt (applies to all)
                          <select className={styles.input} value={scheduleWritingPromptId} onChange={(e) => setScheduleWritingPromptId(e.target.value)} disabled={bulkScheduling}>
                            <option value="">Use project default</option>
                            {(scheduleWritingPrompts?.items || []).map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.name || p.id}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className={styles.label}>
                          Image prompt (applies to all)
                          <select className={styles.input} value={scheduleImagePromptId} onChange={(e) => setScheduleImagePromptId(e.target.value)} disabled={bulkScheduling}>
                            <option value="">Use project default</option>
                            {(scheduleImagePrompts?.items || []).map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.name || p.id}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>

                      <div style={{ paddingTop: 10, maxHeight: 340, overflow: "auto", borderTop: "1px solid var(--button-secondary-border)", marginTop: 12 }}>
                        {bulkScheduleRows.map((r, idx) => (
                          <div key={r.id} style={{ display: "grid", gridTemplateColumns: "1fr 220px", gap: 10, padding: "10px 0", borderBottom: "1px solid var(--button-secondary-border)" }}>
                            <div style={{ minWidth: 0 }}>
                              <div style={{ fontWeight: 800, fontSize: 13, wordBreak: "break-word" }}>{idx + 1}. {r.title}</div>
                              <div className={styles.muted} style={{ fontSize: 12 }}>{r.id}</div>
                            </div>
                            <label className={styles.label} style={{ margin: 0 }}>
                              Date & time
                              <input
                                className={styles.input}
                                type="datetime-local"
                                value={r.when}
                                min={bulkScheduleMin || undefined}
                                step={60}
                                disabled={bulkScheduling}
                                onChange={(e) => {
                                  const v = e.target.value;
                                  setBulkScheduleRows((prev) => prev.map((x) => (x.id === r.id ? { ...x, when: v } : x)));
                                }}
                              />
                            </label>
                          </div>
                        ))}
                      </div>

                      {error ? <p className={styles.error} style={{ marginTop: 10 }}>{error}</p> : null}

                      <div className={styles.row} style={{ paddingTop: 12, justifyContent: "flex-end", gap: 10 }}>
                        <button type="button" className={styles.btnSecondary} onClick={() => setBulkMode("root")} disabled={bulkScheduling}>
                          Cancel
                        </button>
                        <button type="button" className={styles.button} onClick={bulkScheduleSubmit} disabled={bulkScheduling || !bulkScheduleRows.length}>
                          {bulkScheduling ? "Scheduling…" : "Schedule"}
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </>
            ) : null}

            <div className={`${styles.card} ${styles.cardWide}`}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                <h2 style={{ margin: 0 }}>Articles</h2>
                <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  <button
                    className={styles.btnSecondary}
                    type="button"
                    onClick={() => {
                      setError(null);
                      setBulkUploadErrors([]);
                      setBulkUploadRows([]);
                      setShowBulkUpload(true);
                    }}
                  >
                    Bulk Upload
                  </button>
                  <button
                    className={styles.btnSecondary}
                    type="button"
                    onClick={() => {
                      setError(null);
                      setExportFrom(dateFrom || "");
                      setExportTo(dateTo || "");
                      setExportStatus(status || "");
                      setShowExportArticles(true);
                    }}
                  >
                    Export Articles
                  </button>
                  <button
                    className={styles.button}
                    type="button"
                    onClick={() => {
                      setError(null);
                      setShowAddArticle(true);
                    }}
                  >
                    + Add article
                  </button>
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 180px 140px 140px 180px", gap: 10 }}>
                <label className={styles.label}>
                  Search
                  <input
                    className={styles.input}
                    placeholder="Search by title, keyphrase, keyword…"
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                  />
                </label>
                <label className={styles.label}>
                  Status
                  <select className={styles.input} value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
                    <option value="">All</option>
                    <option value="pending">Pending</option>
                    <option value="draft">Draft</option>
                    <option value="scheduled">Scheduled</option>
                    <option value="published">Published</option>
                  </select>
                </label>
                <label className={styles.label}>
                  From
                  <input className={styles.input} type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
                </label>
                <label className={styles.label}>
                  To
                  <input className={styles.input} type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
                </label>
                <label className={styles.label}>
                  Date order
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

              <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
                <button className={styles.button} type="button" onClick={() => { setQ(""); setStatus(""); setDateFrom(""); setDateTo(""); }}>
                  Clear filters
                </button>
                <div style={{ marginLeft: "auto", display: "flex", gap: 10, alignItems: "center" }}>
                  <span style={{ color: "#666", fontSize: 13 }}>{selectedIds.length} selected</span>
                  <button
                    className={`${styles.button} ${selectedIds.length ? styles.buttonHighlight : ""}`}
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

              <div className={`${styles.card} ${styles.cardWide}`} style={{ padding: 0 }}>
                <div style={{ display: "flex", gap: 12, alignItems: "center", padding: "12px 14px", borderBottom: "1px solid var(--button-secondary-border)" }}>
                  <input type="checkbox" checked={allOnPageSelected} onChange={toggleAllOnPage} />
                  <div style={{ fontSize: 12, color: "#666" }}>Title</div>
                  <div style={{ marginLeft: "auto", fontSize: 12, color: "#666" }}>Status</div>
                </div>

                {loading ? <div style={{ padding: 14 }}>Loading…</div> : null}
                {!loading && filtered.length === 0 ? <div style={{ padding: 14 }}>No articles match the current filters.</div> : null}

                {!loading
                  ? pageItems.map((a) => (
                      <div
                        key={a.id}
                        style={{
                          display: "flex",
                          gap: 12,
                          padding: "12px 14px",
                          borderBottom: "1px solid var(--button-secondary-border)",
                          alignItems: "flex-start",
                        }}
                      >
                        <input type="checkbox" checked={!!selected[a.id]} onChange={() => toggleOne(a.id)} />
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <Link
                            href={`/projects/${projectId}/articles/${a.id}`}
                            style={{ fontWeight: 800, wordBreak: "break-word", display: "inline-block" }}
                          >
                            {a.title || "(Untitled)"}
                          </Link>
                          <div style={{ marginTop: 4, fontSize: 12, color: "#666", lineHeight: 1.4 }}>
                            {a.focus_keyphrase ? (
                              <span style={{ marginRight: 10 }}>
                                <span style={{ color: "#999" }}>Focus:</span> {a.focus_keyphrase}
                              </span>
                            ) : null}
                            {a.keywords && a.keywords.length ? (
                              <span>
                                <span style={{ color: "#999" }}>Keywords:</span> {a.keywords.join(", ")}
                              </span>
                            ) : null}
                          </div>
                          <div style={{ marginTop: 4, fontSize: 12, color: "#777" }}>
                            <span>Updated {a.updated_at || a.created_at || "—"}</span>
                            <span> · Posted {a.posted_at || "—"}</span>
                            <span> · Sched {formatInProfileTz(a.wp_scheduled_at)}</span>
                            {a.wp_schedule_error ? <span style={{ color: "#ff4d4f" }}> · Schedule error</span> : null}
                          </div>

                          <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>
                            <Link href={`/projects/${projectId}/articles/${a.id}`} className={`${styles.miniBtn} ${styles.miniPrimary}`}>
                              Edit
                            </Link>
                            <button
                              type="button"
                              className={styles.miniBtn}
                              onClick={() => {
                                const min = new Date(Date.now() + 5 * 60 * 1000);
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
                              Schedule
                            </button>
                            <button type="button" className={`${styles.miniBtn} ${styles.miniDanger}`} onClick={() => setConfirmDeleteId(a.id)}>
                              Delete
                            </button>
                          </div>
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
                          <span style={{ fontSize: 12, color: "#666" }}>{(a.gsc_status || "").toLowerCase() === "inspected" ? "Inspection requested" : "Not requested"}</span>
                          <span className={statusPillClass(a.status)}>{(a.status || "pending").toUpperCase()}</span>
                        </div>
                      </div>
                    ))
                  : null}
              </div>

              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <button className={styles.button} type="button" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={pageClamped <= 1}>
                  Prev
                </button>
                <span style={{ fontSize: 13, color: "#666" }}>
                  Page {pageClamped} / {totalPages} · {filtered.length} item(s)
                </span>
                <button className={styles.button} type="button" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={pageClamped >= totalPages}>
                  Next
                </button>
              </div>
            </div>

            {confirmDeleteId ? (
              <div className={styles.modalBackdrop} role="dialog" aria-modal="true" aria-label="Confirm delete">
                <div className={styles.modalPanel}>
                  <div className={styles.modalHead}>
                    <h3 className={styles.modalTitle}>Delete article?</h3>
                    <button type="button" className={styles.btnSecondary} onClick={() => setConfirmDeleteId(null)}>
                      Close
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
                    <button type="button" className={styles.btnSecondary} onClick={() => setScheduleId(null)}>
                      Close
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
                        Times are interpreted in your profile timezone ({profileTz || "browser default"}). Minimum 5 minutes from now (enforced on save).
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

            {showAddArticle ? (
              <>
                <button type="button" className={styles.modalBackdrop} aria-label="Close" onClick={() => setShowAddArticle(false)} />
                <div className={styles.modalPanel} role="dialog" aria-modal="true" aria-label="Add article">
                  <div className={styles.modalHead}>
                    <h3 className={styles.modalTitle}>Add article</h3>
                    <button type="button" className={styles.btnSecondary} onClick={() => setShowAddArticle(false)}>
                      Close
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
                    <button type="button" className={styles.btnSecondary} onClick={() => (exporting ? null : setShowExportArticles(false))}>
                      Close
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
                  onClick={() => (bulkUploading ? null : setShowBulkUpload(false))}
                />
                <div className={styles.modalPanel} role="dialog" aria-modal="true" aria-label="Bulk upload articles">
                  <div className={styles.modalHead}>
                    <h3 className={styles.modalTitle}>Bulk Upload</h3>
                    <button type="button" className={styles.btnSecondary} onClick={() => (bulkUploading ? null : setShowBulkUpload(false))}>
                      Close
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

                    {bulkUploadRows.length ? (
                      <div style={{ marginTop: 12, fontSize: 12, color: "#666", lineHeight: 1.5 }}>
                        Columns validated and sanitized. Imported articles will be created with <b>Pending</b> status.
                      </div>
                    ) : null}

                    {error ? <p className={styles.error}>{error}</p> : null}
                  </div>
                  <div className={styles.modalFooter}>
                    <button type="button" className={styles.btnSecondary} onClick={() => setShowBulkUpload(false)} disabled={bulkUploading}>
                      Cancel
                    </button>
                    <button type="button" className={styles.button} onClick={importBulkRows} disabled={bulkUploading || !bulkUploadRows.length}>
                      {bulkUploading ? "Importing…" : "Import"}
                    </button>
                  </div>
                </div>
              </>
            ) : null}
          </>
        ) : null}

        {tab === "scheduled_articles" ? (
          <>
            <div className={`${styles.card} ${styles.cardWide}`}>
              <div className={styles.projectCardTop}>
                <div>
                  <h2 style={{ margin: 0 }}>Scheduled Articles</h2>
                  <p style={{ color: "#666", lineHeight: 1.5, margin: "6px 0 0" }}>
                    Articles queued to post to WordPress at a scheduled time.
                  </p>
                </div>
                <button className={styles.button} type="button" onClick={async () => {
                  setScheduledLoading(true);
                  try { setScheduledJobs(dedupeScheduledJobs(await api.listScheduledJobs(projectId))); } finally { setScheduledLoading(false); }
                }}>
                  Refresh
                </button>
                <button
                  className={styles.btnSecondary}
                  type="button"
                  onClick={() => setConfirmClearScheduled(true)}
                  style={{ marginLeft: 10 }}
                >
                  Clear all
                </button>
              </div>
              {scheduledLoading ? <div className={styles.muted}>Loading…</div> : null}
              {error ? <p className={styles.error}>{error}</p> : null}
            </div>

            <div className={`${styles.card} ${styles.cardWide}`} style={{ padding: 0 }}>
              <div style={{ display: "flex", gap: 12, alignItems: "center", padding: "12px 14px", borderBottom: "1px solid var(--button-secondary-border)" }}>
                <div style={{ fontSize: 12, color: "#666" }}>Article</div>
                <div style={{ marginLeft: "auto", fontSize: 12, color: "#666" }}>Schedule</div>
              </div>

              {scheduledJobs.length === 0 && !scheduledLoading ? (
                <div style={{ padding: 14, color: "#666" }}>No scheduled articles yet.</div>
              ) : null}

              {scheduledJobs.map((j) => {
                const jobState = (j.state || "").toLowerCase();
                const canPostNow = !["posted", "cancelled", "posting"].includes(jobState);
                return (
                <div
                  key={j.id}
                  style={{
                    display: "flex",
                    gap: 12,
                    padding: "12px 14px",
                    borderBottom: "1px solid var(--button-secondary-border)",
                    alignItems: "flex-start",
                  }}
                >
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <Link
                      href={`/projects/${projectId}/articles/${j.article_id}`}
                      style={{ fontWeight: 800, wordBreak: "break-word", display: "inline-block" }}
                    >
                      {articles.find((a) => a.id === j.article_id)?.title || "(Untitled article)"}
                    </Link>
                    <div style={{ marginTop: 6, display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <button
                        type="button"
                        className={styles.miniBtn}
                        onClick={() => {
                          setError(null);
                          setConfirmPostNowJob(j);
                        }}
                        disabled={!canPostNow}
                        title={canPostNow ? "Publish to WordPress now" : "Not available while posting or after posted/cancelled"}
                      >
                        Post Now
                      </button>
                      <button
                        type="button"
                        className={styles.miniBtn}
                        onClick={() => {
                          const min = new Date(Date.now() + 5 * 60 * 1000);
                          setEditJobMin(toDatetimeLocalFromDateInProfileTz(min));
                          setEditJob(j);
                          // Show schedule time in the user's profile timezone
                          setEditJobWhen(toDatetimeLocalInProfileTz(j.run_at || ""));
                          setEditJobPostType(j.post_type || "posts");
                          setEditJobStatus(((j.wp_status || "draft") as "draft" | "publish"));
                          setEditJobCats(j.category_ids || []);
                        }}
                        disabled={["posted", "cancelled"].includes((j.state || "").toLowerCase())}
                      >
                        Re-Schedule
                      </button>
                      <button
                        type="button"
                        className={`${styles.miniBtn} ${styles.miniDanger}`}
                        onClick={async () => {
                          setConfirmCancelJob(j);
                        }}
                        disabled={["posted", "cancelled"].includes((j.state || "").toLowerCase())}
                      >
                        Cancel
                      </button>
                      {j.wp_link ? (
                        <a className={styles.miniBtn} href={j.wp_link} target="_blank" rel="noreferrer">
                          View on WordPress
                        </a>
                      ) : null}
                    </div>
                    {j.last_error ? <div style={{ marginTop: 6, fontSize: 12, color: "#ff4d4f" }}>{j.last_error}</div> : null}
                  </div>

                  <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6, minWidth: 260 }}>
                    <div style={{ fontSize: 12, color: "#666" }}>
                      Time: <strong>{formatInProfileTz(j.run_at)}</strong>
                    </div>
                    <div style={{ fontSize: 12, color: "#666" }}>
                      Post type: <strong>{j.post_type || "posts"}</strong>
                    </div>
                    <div style={{ fontSize: 12, color: "#666" }}>
                      Status: <strong>{j.wp_status || "draft"}</strong>
                    </div>
                    <span className={styles.statusPill}>{jobStateLabel(j.state)}</span>
                  </div>
                </div>
                );
              })}
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
                    </label>
                    <label className={styles.label}>
                      WordPress post type
                      <select className={styles.input} value={editJobPostType} onChange={(e) => setEditJobPostType(e.target.value)}>
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
                      <select className={styles.input} value={editJobStatus} onChange={(e) => setEditJobStatus(e.target.value as "draft" | "publish")}>
                        <option value="draft">Draft</option>
                        <option value="publish">Publish</option>
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
                      onClick={async () => {
                        try {
                          setError(null);
                          if (!editJobWhen.trim()) throw new Error("Invalid schedule time");
                          await api.updateScheduledJob(projectId, editJob.id, {
                            // Backend interprets this as local time in the user's profile timezone and stores UTC.
                            run_at: editJobWhen,
                            post_type: editJobPostType,
                            wp_status: editJobStatus,
                            category_ids: editJobCats,
                          });
                          setScheduledJobs(dedupeScheduledJobs(await api.listScheduledJobs(projectId)));
                          setEditJob(null);
                        } catch (e) {
                          setError(e instanceof Error ? e.message : "Failed to update schedule");
                        }
                      }}
                    >
                      Save changes
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
                    <button type="button" className={styles.btnSecondary} onClick={() => setConfirmPostNowJob(null)} disabled={postNowBusy}>
                      Close
                    </button>
                  </div>
                  <div className={styles.modalBody}>
                    <p style={{ marginTop: 0 }}>
                      Are you sure you want to post it now? With this, the post will be published to the website now.
                    </p>
                    <div className={styles.muted} style={{ fontSize: 12 }}>
                      {articles.find((a) => a.id === confirmPostNowJob.article_id)?.title || "(Untitled article)"}
                    </div>
                    {error ? <p className={styles.error} style={{ marginTop: 10 }}>{error}</p> : null}
                  </div>
                  <div className={styles.modalFooter}>
                    <button type="button" className={styles.btnSecondary} onClick={() => setConfirmPostNowJob(null)} disabled={postNowBusy}>
                      No
                    </button>
                    <button type="button" className={styles.button} onClick={postNowFromScheduledJob} disabled={postNowBusy}>
                      {postNowBusy ? "Publishing…" : "Yes, post now"}
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
                      Are you sure you want to cancel this scheduled post?
                    </p>
                    <div className={styles.muted} style={{ fontSize: 12 }}>
                      {articles.find((a) => a.id === confirmCancelJob.article_id)?.title || "(Untitled article)"}
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
                          await api.cancelScheduledJob(projectId, confirmCancelJob.id);
                          setScheduledJobs(dedupeScheduledJobs(await api.listScheduledJobs(projectId)));
                          setConfirmCancelJob(null);
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

            {confirmClearScheduled ? (
              <div className={styles.modalBackdrop} role="dialog" aria-modal="true" aria-label="Clear scheduled articles">
                <div className={styles.modalPanel}>
                  <div className={styles.modalHead}>
                    <h3 className={styles.modalTitle}>Clear all scheduled articles</h3>
                    <button type="button" className={styles.btnSecondary} onClick={() => setConfirmClearScheduled(false)}>
                      Close
                    </button>
                  </div>
                  <div className={styles.modalBody}>
                    <p style={{ marginTop: 0 }}>
                      This will remove all scheduled jobs for this project so you can start fresh. Are you sure?
                    </p>
                  </div>
                  <div className={styles.modalFooter}>
                    <button type="button" className={styles.btnSecondary} onClick={() => setConfirmClearScheduled(false)}>
                      Cancel
                    </button>
                    <button
                      type="button"
                      className={`${styles.button} ${styles.miniDanger}`}
                      onClick={async () => {
                        try {
                          setError(null);
                          await api.clearScheduledJobs(projectId);
                          setScheduledJobs([]);
                          setConfirmClearScheduled(false);
                        } catch (e) {
                          setError(e instanceof Error ? e.message : "Failed to clear scheduled articles");
                        }
                      }}
                    >
                      Yes, clear all
                    </button>
                  </div>
                </div>
              </div>
            ) : null}
          </>
        ) : null}

        {tab === "configuration" ? (
          <div className={`${styles.card} ${styles.cardWide}`}>
            <h2>Configuration</h2>
            <p style={{ color: "#666", lineHeight: 1.5 }}>
              This will contain WordPress defaults, featured image settings, and Search Console settings (ported from the legacy page).
              Next step is to expose these project fields via the backend API and bind this form to them.
            </p>
          </div>
        ) : null}

        {tab === "prompts" ? (
          <>
            <div className={`${styles.card} ${styles.cardWide}`}>
              <div className={styles.projectCardTop}>
                <div>
                  <h2 style={{ margin: 0 }}>Prompts</h2>
                  <p style={{ color: "#666", lineHeight: 1.5, margin: "6px 0 0" }}>
                    Manage writing prompts and image prompts. Set defaults used by generation and scheduling.
                  </p>
                </div>
                <button className={styles.button} type="button" onClick={savePrompts} disabled={promptsSaving || promptsLoading}>
                  {promptsSaving ? "Saving…" : "Save changes"}
                </button>
              </div>
              {promptsLoading ? <div className={styles.muted}>Loading prompts…</div> : null}
              {error ? <p className={styles.error}>{error}</p> : null}
            </div>

            <div className={styles.twoCol}>
              <div className={`${styles.card} ${styles.cardWide}`}>
                <div className={styles.projectCardTop}>
                  <h2 style={{ margin: 0 }}>Article writing prompts</h2>
                  <button className={styles.btnSecondary} type="button" onClick={() => startAddPrompt("writing")}>
                    + Add new
                  </button>
                </div>
                <div className={styles.muted} style={{ fontSize: 12 }}>
                  Default is used when you generate or schedule unless you override on the article.
                </div>

                <div className={styles.list}>
                  {wpDrafts.length === 0 ? <div className={styles.muted}>No writing prompts yet.</div> : null}
                  {wpDrafts.map((p) => (
                    <div key={p.id} className={styles.listItem}>
                      <div className={styles.listItemTop}>
                        <div style={{ fontWeight: 900 }}>{p.name || "(Untitled prompt)"}</div>
                        <div className={styles.row}>
                          <button className={styles.miniBtn} type="button" onClick={() => openPromptModal("writing", p.id)}>
                            Edit
                          </button>
                          <button className={`${styles.miniBtn} ${styles.miniDanger}`} type="button" onClick={() => markDeletePrompt("writing", p.id)}>
                            Delete
                          </button>
                        </div>
                      </div>
                      <div className={styles.checkboxRow}>
                        <input
                          type="radio"
                          name="wp-default"
                          checked={wpDefault === p.id}
                          onChange={() => setWpDefault(p.id)}
                        />
                        Set as default
                      </div>
                      <div className={styles.monoSmall}>{(p.text || "").slice(0, 240)}{(p.text || "").length > 240 ? "…" : ""}</div>
                    </div>
                  ))}
                </div>
              </div>

              <div className={`${styles.card} ${styles.cardWide}`}>
                <div className={styles.projectCardTop}>
                  <h2 style={{ margin: 0 }}>Image prompts</h2>
                  <button className={styles.btnSecondary} type="button" onClick={() => startAddPrompt("image")}>
                    + Add new
                  </button>
                </div>
                <div className={styles.muted} style={{ fontSize: 12 }}>
                  Default is used when generating featured images unless overridden.
                </div>

                <div className={styles.list}>
                  {ipDrafts.length === 0 ? <div className={styles.muted}>No image prompts yet.</div> : null}
                  {ipDrafts.map((p) => (
                    <div key={p.id} className={styles.listItem}>
                      <div className={styles.listItemTop}>
                        <div style={{ fontWeight: 900 }}>{p.name || "(Untitled prompt)"}</div>
                        <div className={styles.row}>
                          <button className={styles.miniBtn} type="button" onClick={() => openPromptModal("image", p.id)}>
                            Edit
                          </button>
                          <button className={`${styles.miniBtn} ${styles.miniDanger}`} type="button" onClick={() => markDeletePrompt("image", p.id)}>
                            Delete
                          </button>
                        </div>
                      </div>
                      <div className={styles.checkboxRow}>
                        <input
                          type="radio"
                          name="ip-default"
                          checked={ipDefault === p.id}
                          onChange={() => setIpDefault(p.id)}
                        />
                        Set as default
                      </div>
                      <div className={styles.monoSmall}>{(p.text || "").slice(0, 240)}{(p.text || "").length > 240 ? "…" : ""}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {showPromptModal ? (
              <>
                <button type="button" className={styles.modalBackdrop} aria-label="Close" onClick={() => setShowPromptModal(null)} />
                <div className={styles.modalPanel} role="dialog" aria-modal="true" aria-label="Edit prompt">
                  <div className={styles.modalHead}>
                    <h3 className={styles.modalTitle}>
                      {showPromptModal.kind === "writing" ? "Article writing prompt" : "Image prompt"}
                    </h3>
                    <button type="button" className={styles.btnSecondary} onClick={() => setShowPromptModal(null)}>
                      Close
                    </button>
                  </div>
                  <div className={styles.modalBody}>
                    <label className={styles.label}>
                      Prompt name
                      <input className={styles.input} value={draftName} onChange={(e) => setDraftName(e.target.value)} />
                    </label>
                    <label className={styles.label}>
                      Actual prompt
                      <textarea className={styles.textarea} style={{ minHeight: 240 }} value={draftText} onChange={(e) => setDraftText(e.target.value)} />
                    </label>
                    <label className={styles.checkboxRow}>
                      <input
                        type="checkbox"
                        checked={draftSetDefault}
                        onChange={(e) => setDraftSetDefault(e.target.checked)}
                      />
                      Set as default for this project
                    </label>
                  </div>
                  <div className={styles.modalFooter}>
                    <button type="button" className={styles.btnSecondary} onClick={() => setShowPromptModal(null)}>
                      Cancel
                    </button>
                    <button
                      className={styles.button}
                      type="button"
                      onClick={() => {
                        const { kind, id } = showPromptModal;
                        if (kind === "writing") {
                          setWpDrafts((prev) => prev.map((x) => (x.id === id ? { ...x, name: draftName, text: draftText } : x)));
                          if (draftSetDefault) setWpDefault(id);
                        } else {
                          setIpDrafts((prev) => prev.map((x) => (x.id === id ? { ...x, name: draftName, text: draftText } : x)));
                          if (draftSetDefault) setIpDefault(id);
                        }
                        setShowPromptModal(null);
                      }}
                      disabled={!draftName.trim() || !draftText.trim()}
                    >
                      Save prompt
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
                  <h2 style={{ margin: 0 }}>Context links</h2>
                  <p style={{ color: "#666", lineHeight: 1.5, margin: "6px 0 0" }}>
                    Add exact phrases with links. When publishing to WordPress, matching phrases are linked on the live site (case-insensitive).
                  </p>
                </div>
                <div className={styles.row} style={{ justifyContent: "flex-end" }}>
                  <button className={styles.btnSecondary} type="button" onClick={startAddLink} disabled={linksLoading || linksSaving}>
                    + Add link
                  </button>
                  <button className={styles.button} type="button" onClick={saveContextLinks} disabled={linksLoading || linksSaving}>
                    {linksSaving ? "Saving…" : "Save changes"}
                  </button>
                </div>
              </div>
              {linksLoading ? <div className={styles.muted}>Loading links…</div> : null}
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
                                <button className={styles.miniBtn} type="button" onClick={() => openLinkModal(x.id)}>
                                  Edit
                                </button>
                                <button className={`${styles.miniBtn} ${styles.miniDanger}`} type="button" onClick={() => markDeleteLink(x.id)}>
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

            {showLinkModal ? (
              <>
                <button type="button" className={styles.modalBackdrop} aria-label="Close" onClick={() => setShowLinkModal(null)} />
                <div className={styles.modalPanel} role="dialog" aria-modal="true" aria-label="Context link">
                  <div className={styles.modalHead}>
                    <h3 className={styles.modalTitle}>Add / edit context link</h3>
                    <button type="button" className={styles.btnSecondary} onClick={() => setShowLinkModal(null)}>
                      Close
                    </button>
                  </div>
                  <div className={styles.modalBody}>
                    <label className={styles.label}>
                      Exact phrase
                      <input className={styles.input} value={linkPhrase} onChange={(e) => setLinkPhrase(e.target.value)} placeholder="e.g. Supreme Court Lawyers in Chandigarh" />
                    </label>
                    <label className={styles.label}>
                      Link
                      <input className={styles.input} value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} placeholder="https://example.com/page" />
                    </label>
                    <div className={styles.muted} style={{ fontSize: 12 }}>
                      Matching is case-insensitive. We’ll link the visible phrase text as it appears in the article.
                    </div>
                  </div>
                  <div className={styles.modalFooter}>
                    <button type="button" className={styles.btnSecondary} onClick={() => setShowLinkModal(null)}>
                      Cancel
                    </button>
                    <button
                      className={styles.button}
                      type="button"
                      onClick={() => {
                        const id = showLinkModal.id;
                        setLinkDrafts((prev) => prev.map((d) => (d.id === id ? { ...d, label: linkPhrase, url: linkUrl } : d)));
                        setShowLinkModal(null);
                      }}
                      disabled={!linkPhrase.trim() || !linkUrl.trim()}
                    >
                      Save link
                    </button>
                  </div>
                </div>
              </>
            ) : null}
          </>
        ) : null}

        {tab === "tools" ? (
          <div className={`${styles.card} ${styles.cardWide}`}>
            <h2>Tools</h2>
            <p style={{ color: "#666", lineHeight: 1.5 }}>
              This will contain Bulk upload, Search Console connect, and other integrations (mirrors “Tools / Integrations” from the legacy app).
            </p>
          </div>
        ) : null}

        {tab === "project_settings" ? (
          <>
            <div className={`${styles.card} ${styles.cardWide}`}>
              <div className={styles.projectCardTop}>
                <div>
                  <h2 style={{ margin: 0 }}>Project settings</h2>
                  <p style={{ color: "#666", lineHeight: 1.5, margin: "6px 0 0" }}>
                    Update display name, WordPress credentials, download the plugin, and verify your connection.
                  </p>
                </div>
                {settingsDirty ? (
                  <button className={styles.button} type="button" onClick={saveSettings} disabled={settingsSaving || settingsLoading}>
                    {settingsSaving ? "Saving…" : "Save"}
                  </button>
                ) : null}
              </div>
              {settingsLoading ? <div className={styles.muted}>Loading settings…</div> : null}
              {error ? <p className={styles.error}>{error}</p> : null}
            </div>

            {settings ? (
              <div className={`${styles.card} ${styles.cardWide}`}>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <label className={styles.label}>
                    Project display name
                    <input className={styles.input} value={sName} onChange={(e) => setSName(e.target.value)} />
                  </label>
                  <label className={styles.label}>
                    WordPress site URL
                    <input className={styles.input} value={sUrl} onChange={(e) => setSUrl(e.target.value)} placeholder="https://example.com" />
                  </label>
                  <label className={styles.label}>
                    WordPress username
                    <input className={styles.input} value={sWpUser} onChange={(e) => setSWpUser(e.target.value)} />
                  </label>
                  <label className={styles.label}>
                    Application password
                    <input className={styles.input} value={sWpPass} onChange={(e) => setSWpPass(e.target.value)} placeholder={settings.wp_app_password_set ? "•••••••••• (set)" : "xxxx xxxx xxxx xxxx"} />
                  </label>
                </div>

                <div style={{ marginTop: 14, borderTop: "1px solid var(--button-secondary-border)", paddingTop: 14 }}>
                  <div style={{ fontWeight: 900, marginBottom: 8 }}>WordPress defaults</div>
                  <div className={styles.muted} style={{ fontSize: 12, marginBottom: 10 }}>
                    These defaults will be pre-selected when publishing articles. You can still change them per article.
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
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
                </div>

                <div className={styles.row} style={{ justifyContent: "space-between", marginTop: 10 }}>
                  <a className={styles.btnSecondary} href={settings.plugin_download_url}>
                    Download plugin
                  </a>
                  <button className={styles.button} type="button" onClick={verifySettings} disabled={settingsVerifying || !sUrl.trim() || !sWpUser.trim()}>
                    {settingsVerifying ? "Verifying…" : "Verify connection"}
                  </button>
                </div>

                {settingsVerify ? (
                  <div className={settingsVerify.ok ? styles.muted : styles.error} style={{ fontSize: 13, marginTop: 8, whiteSpace: "pre-wrap" }}>
                    {settingsVerify.message}
                  </div>
                ) : null}
              </div>
            ) : null}
          </>
        ) : null}
      </main>
    </div>
  );
}

