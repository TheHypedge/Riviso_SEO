"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import styles from "../../../../page.module.css";
import editorStyles from "./articleEditor.module.css";
import projectsDark from "../../../projectsDark.module.css";
import {
  api,
  ApiError,
  ArticleDetail,
  ClusterLinkContext,
  clearAuth,
  getAccessToken,
  invalidateArticleDetailCache,
  PromptListResponse,
} from "@/lib/api";
import { ArticleEditorSkeleton } from "@/components/ArticleEditorSkeleton";
import { ArticleReadonlyBody } from "@/components/ArticleReadonlyBody";
import { LazyArticleImage } from "@/components/LazyArticleImage";
import { readArticleEditorCache, writeArticleEditorCache } from "@/lib/articleEditorCache";
import { articleEditorPath, formatArticleLoadError } from "@/lib/articlePaths";
import { connectionErrorMessage, isDatabaseUnavailable } from "@/lib/networkErrors";
import {
  canPushWordPressUpdate,
  formatWordPressRestStatus,
  isArticleLiveOnWordPress,
  isWordPressPostTrashed,
  parseWpPostId,
  shouldShowWordPressPublish,
  shouldShowWordPressUpdate,
} from "@/lib/articleEditorWordpress";
import { resolveProjectPlatform } from "@/lib/projectPlatform";
import { runWithArticlePipelineMonitor } from "@/lib/pipelineStream";
import { ShopifyProductMapPicker } from "@/components/shopify/ShopifyProductMapPicker";
import { WordPressPageMapPicker } from "@/components/wordpress/WordPressPageMapPicker";
import type { MappedShopifyProduct } from "@/lib/shopifyProductMapping";
import type { MappedWordPressPage } from "@/lib/wordpressPageMapping";
import { resolveFeaturedImageFileForWordPress } from "@/lib/featuredImageFile";
import { formatShopifyBlogOptionLabel, SHOPIFY_BLOG_CHANNEL_HELP } from "@/lib/shopifyBlogLabel";


const ArticleRichEditor = dynamic(
  () => import("@/components/ArticleRichEditor").then((m) => m.ArticleRichEditor),
  {
    ssr: false,
    loading: () => <ArticleEditorSkeleton bodyOnly />,
  },
);

function kwToString(keywords?: string[] | null) {
  return (keywords || []).filter(Boolean).join(", ");
}

function kwFromString(raw: string) {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 10);
}

const META_TITLE_MAX = 60;
const META_DESC_MAX = 120;

function clampChars(s: string, max: number) {
  const t = (s || "").trim();
  if (!t) return "";
  return t.length <= max ? t : t.slice(0, max).trim();
}

function statusDotClass(status: string): string {
  const s = (status || "").trim().toLowerCase();
  if (s === "published") return editorStyles.statusDotPublished;
  if (s === "draft") return editorStyles.statusDotDraft;
  if (s === "pending" || s === "scheduled") return editorStyles.statusDotPending;
  return editorStyles.statusDotNeutral;
}

type ContextTab = "seo" | "media" | "publish" | "ai" | "settings";
const CONTEXT_TABS: { key: ContextTab; label: string; icon: string }[] = [
  { key: "seo", label: "SEO", icon: "⬡" },
  { key: "media", label: "Media", icon: "▣" },
  { key: "publish", label: "Publish", icon: "⬆" },
  { key: "ai", label: "AI", icon: "✦" },
  { key: "settings", label: "Settings", icon: "⚙" },
];

function computeSeoScore(metrics: {
  metaTitleLen: number; metaTitleMax: number;
  metaDescLen: number; metaDescMax: number;
  headingCount: number; wordCount: number;
  focusKeyphrase: string; body: string;
}): { total: number; readability: number; structure: number; keywords: number; meta: number } {
  const metaTitleScore = metrics.metaTitleLen >= metrics.metaTitleMax * 0.5 && metrics.metaTitleLen <= metrics.metaTitleMax ? 100 : metrics.metaTitleLen > 0 ? 50 : 0;
  const metaDescScore = metrics.metaDescLen >= metrics.metaDescMax * 0.4 && metrics.metaDescLen <= metrics.metaDescMax ? 100 : metrics.metaDescLen > 0 ? 50 : 0;
  const meta = Math.round((metaTitleScore + metaDescScore) / 2);
  const structure = Math.min(100, metrics.headingCount >= 4 ? 100 : metrics.headingCount >= 2 ? 75 : metrics.headingCount >= 1 ? 40 : 0);
  const readability = Math.min(100, metrics.wordCount >= 300 ? 85 + Math.min(15, Math.floor(metrics.wordCount / 200)) : metrics.wordCount >= 100 ? 60 : metrics.wordCount > 0 ? 30 : 0);
  const kw = metrics.focusKeyphrase.trim();
  const bodyLower = metrics.body.toLowerCase();
  const kwCount = kw ? bodyLower.split(kw.toLowerCase()).length - 1 : 0;
  const keywords = !kw ? 0 : kwCount >= 3 ? 100 : kwCount >= 1 ? 60 : 20;
  const total = Math.round(meta * 0.25 + structure * 0.25 + readability * 0.25 + keywords * 0.25);
  return { total, readability, structure, keywords, meta };
}

function slugFromTitle(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "untitled";
}

function timeAgo(dateStr: string | undefined | null): string {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return "";
  const seconds = Math.floor((Date.now() - d.getTime()) / 1000);
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function noticeWithoutUrl(notice: string): string {
  return notice.replace(/\s*https?:\/\/\S+/g, "").trim();
}

function seoMeter(len: number, max: number): { percent: number; state: "warning" | "excellent"; label: string } {
  if (!len) return { percent: 0, state: "warning", label: "Missing" };
  if (len > max) return { percent: 100, state: "warning", label: "Too long" };
  if (len < Math.max(20, Math.floor(max * 0.5))) return { percent: Math.max(6, Math.round((len / max) * 100)), state: "warning", label: "Too short" };
  return { percent: Math.round((len / max) * 100), state: "excellent", label: "Excellent" };
}

type EditorBaseline = {
  title: string;
  keywords: string;
  focus: string;
  body: string;
  metaTitle: string;
  metaDesc: string;
  imageUrl: string;
};

function baselineFromFields(fields: {
  title: string;
  keywords: string;
  focus: string;
  body: string;
  metaTitle: string;
  metaDesc: string;
  imageUrl: string;
}): EditorBaseline {
  return {
    title: fields.title,
    keywords: fields.keywords,
    focus: fields.focus,
    body: fields.body,
    metaTitle: fields.metaTitle,
    metaDesc: fields.metaDesc,
    imageUrl: fields.imageUrl,
  };
}

function baselineFromArticle(a: ArticleDetail, imageUrl?: string): EditorBaseline {
  return baselineFromFields({
    title: a.title || "",
    keywords: kwToString(a.keywords),
    focus: a.focus_keyphrase || "",
    body: a.article || "",
    metaTitle: a.meta_title || "",
    metaDesc: a.meta_description || "",
    imageUrl: (imageUrl ?? a.image_url ?? "").trim(),
  });
}

export default function ArticleEditPage() {
  const params = useParams<{ projectId: string; articleId: string }>();
  const router = useRouter();
  const token = useMemo(() => getAccessToken(), []);
  const editorPath = useMemo(
    () => articleEditorPath(params.projectId, params.articleId),
    [params.projectId, params.articleId],
  );

  const [contentLoading, setContentLoading] = useState(true);
  const [bodyLoading, setBodyLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [errorCanRetry, setErrorCanRetry] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);

  const [article, setArticle] = useState<ArticleDetail | null>(null);
  const [projectSettings, setProjectSettings] = useState<import("@/lib/api").ProjectSettings | null>(null);
  const [shopifyStatus, setShopifyStatus] = useState<import("@/lib/api").ShopifyStatus | null>(null);
  const [shopifyCatalog, setShopifyCatalog] = useState<import("@/lib/api").ShopifyCatalog | null>(null);
  const [shopifyCatalogLoading, setShopifyCatalogLoading] = useState(false);
  const [mappedProductsForGenerate, setMappedProductsForGenerate] = useState<MappedShopifyProduct[]>([]);
  const [mappedPagesForGenerate, setMappedPagesForGenerate] = useState<MappedWordPressPage[]>([]);
  const [productMapBeforeGenerateOpen, setProductMapBeforeGenerateOpen] = useState(false);
  const [siteMapEntries, setSiteMapEntries] = useState<import("@/lib/api").SiteMapListResponse["entries"]>([]);
  const [siteMapLoading, setSiteMapLoading] = useState(false);
  const [clusterLinkContext, setClusterLinkContext] = useState<ClusterLinkContext | null>(null);
  const [clusterLinkLoading, setClusterLinkLoading] = useState(false);
  const [shopifyBlogId, setShopifyBlogId] = useState<number | null>(null);
  const [shopifyPublishNow, setShopifyPublishNow] = useState(false);
  const [shopifyPublishBusy, setShopifyPublishBusy] = useState(false);
  const [shopifyCatalogSyncing, setShopifyCatalogSyncing] = useState(false);
  const [writingPrompts, setWritingPrompts] = useState<PromptListResponse | null>(
    null,
  );
  const [imagePrompts, setImagePrompts] = useState<PromptListResponse | null>(
    null,
  );
  const [promptsLoading, setPromptsLoading] = useState(false);
  const [wpMetaLoading, setWpMetaLoading] = useState(false);
  const [wpMetaError, setWpMetaError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [keywords, setKeywords] = useState("");
  const [focus, setFocus] = useState("");
  const [body, setBody] = useState("");
  const [metaTitle, setMetaTitle] = useState("");
  const [metaDesc, setMetaDesc] = useState("");

  // Generation selections
  const [writingPromptId, setWritingPromptId] = useState<string>("");
  const [imagePromptId, setImagePromptId] = useState<string>("");
  const [generateImage, setGenerateImage] = useState(true);
  const [uploadedImageFile, setUploadedImageFile] = useState<File | null>(null);
  const uploadedImagePreview = useMemo(() => {
    if (!uploadedImageFile) return "";
    return URL.createObjectURL(uploadedImageFile);
  }, [uploadedImageFile]);
  const [generatedImageUrl, setGeneratedImageUrl] = useState<string>("");
  const [featuredImageLoading, setFeaturedImageLoading] = useState(false);
  const [featuredImageLoadFailed, setFeaturedImageLoadFailed] = useState(false);
  const featuredImageLoadRef = useRef<{ articleKey: string; state: "idle" | "loading" | "loaded" | "failed" }>({
    articleKey: "",
    state: "idle",
  });
  const prevArticleKeyRef = useRef<string | null>(null);
  const [editorBaseline, setEditorBaseline] = useState<EditorBaseline | null>(null);
  const [leaveConfirmOpen, setLeaveConfirmOpen] = useState(false);
  const [pendingLeaveHref, setPendingLeaveHref] = useState<string | null>(null);

  const articleStatus = (article?.status || "").trim().toLowerCase();
  const wpPostId = useMemo(() => parseWpPostId(article?.wp_post_id), [article?.wp_post_id]);
  const wpLink = (article?.wp_link || "").trim();
  const wpLastStatus = (article?.wp_last_wp_status || "").trim().toLowerCase();
  const isWpTrashed = isWordPressPostTrashed({ wpLastStatus: article?.wp_last_wp_status, wpLink });
  const wpEditorCtx = useMemo(
    () => ({
      articleStatus: article?.status || "",
      wpPostId,
      wpLink,
    }),
    [article?.status, wpLink, wpPostId],
  );
  const isLiveOnWordPress = isArticleLiveOnWordPress(wpEditorCtx);
  const showUpdateWordPress = shouldShowWordPressUpdate(wpEditorCtx);
  const showPublishWordPress = shouldShowWordPressPublish(wpEditorCtx);
  const isScheduledArticle = articleStatus === "scheduled";
  /** Only scheduled rows are read-only; draft/pending/generated content stays editable until live on WP. */
  const editorLocked = isScheduledArticle;

  // WordPress publish options
  const [wpPostTypes, setWpPostTypes] = useState<{ rest_base: string; name: string; taxonomies: string[] }[]>([]);
  const [wpCategories, setWpCategories] = useState<{ id: number; name: string }[]>([]);
  const [wpPostType, setWpPostType] = useState("posts");
  const [wpStatus, setWpStatus] = useState<"draft" | "publish">("draft");
  const [wpCategoryIds, setWpCategoryIds] = useState<number[]>([]);

  const effectiveWpStatus = useMemo((): "draft" | "publish" => {
    if (showUpdateWordPress) {
      const last = (article?.wp_last_wp_status || "").trim().toLowerCase();
      if (last === "publish" || last === "draft") return last;
      if (articleStatus === "published") return "publish";
    }
    return wpStatus;
  }, [article?.wp_last_wp_status, articleStatus, showUpdateWordPress, wpStatus]);

  // Regenerate confirmation
  const [showRegenConfirm, setShowRegenConfirm] = useState(false);
  const [regenImageChoice, setRegenImageChoice] = useState(true);
  const [showImageRegenModal, setShowImageRegenModal] = useState(false);
  const [regenPromptSource, setRegenPromptSource] = useState<"saved" | "custom">("saved");
  const [regenPromptId, setRegenPromptId] = useState("");
  const [regenCustomPrompt, setRegenCustomPrompt] = useState("");
  const [websiteConnectionModal, setWebsiteConnectionModal] = useState(false);
  const [imageRegenBusy, setImageRegenBusy] = useState(false);
  const [imageGenPhase, setImageGenPhase] = useState<"idle" | "generating" | "saving">("idle");
  const [wpPublishBusy, setWpPublishBusy] = useState(false);
  const [wpUpdateBusy, setWpUpdateBusy] = useState(false);
  const [wpSyncBusy, setWpSyncBusy] = useState(false);
  const [showWpSyncConfirm, setShowWpSyncConfirm] = useState(false);
  const [liveUrlCopied, setLiveUrlCopied] = useState(false);
  const wpAutoSyncKeyRef = useRef<string | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const projectPlatform = useMemo(
    () => (projectSettings ? resolveProjectPlatform({ settings: projectSettings }) : null),
    [projectSettings],
  );
  const isShopifyProject = projectPlatform === "shopify";
  const isWordPressProject = projectPlatform === "wordpress";
  const shopifyProductAware = Boolean(projectSettings?.shopify_product_aware_enabled);
  const wpInternalLinkAware = Boolean(projectSettings?.wp_internal_link_aware_enabled);
  const websiteConnected = isShopifyProject
    ? (projectSettings?.shopify_verified_status || "").toLowerCase() === "connected" &&
      !!(projectSettings?.shopify_verified_at || "").trim()
    : (projectSettings?.wp_verified_status || "").trim().toLowerCase() === "connected";

  const [editorRevision, setEditorRevision] = useState(0);
  const [contextTab, setContextTab] = useState<ContextTab>("seo");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [commandBarVisible, setCommandBarVisible] = useState(false);
  const titleHeroRef = useRef<HTMLDivElement>(null);

  const isPublishedArticle = articleStatus === "published";

  const hasGeneratedContent = useMemo(
    () =>
      !!(body || "").trim() ||
      !!(metaTitle || "").trim() ||
      !!(metaDesc || "").trim() ||
      !!generatedImageUrl ||
      !!(article?.generated_at || "").trim(),
    [article?.generated_at, body, generatedImageUrl, metaDesc, metaTitle],
  );

  const editorMetrics = useMemo(() => {
    const text = (body || "").trim();
    if (!text) return { words: 0, chars: 0, readingTime: "0 min", headings: 0 };
    const words = text.split(/\s+/).filter(Boolean).length;
    const chars = text.length;
    const minutes = Math.max(1, Math.ceil(words / 238));
    const headings = (text.match(/^#{1,6}\s/gm) || []).length;
    return { words, chars, readingTime: `${minutes} min`, headings };
  }, [body]);

  const seoScore = useMemo(() => computeSeoScore({
    metaTitleLen: metaTitle.length, metaTitleMax: META_TITLE_MAX,
    metaDescLen: metaDesc.length, metaDescMax: META_DESC_MAX,
    headingCount: editorMetrics.headings, wordCount: editorMetrics.words,
    focusKeyphrase: focus, body,
  }), [metaTitle.length, metaDesc.length, editorMetrics.headings, editorMetrics.words, focus, body]);

  const lastSavedLabel = useMemo(() => timeAgo(article?.updated_at), [article?.updated_at]);

  useEffect(() => {
    const hero = titleHeroRef.current;
    if (!hero) return;
    const observer = new IntersectionObserver(
      ([entry]) => setCommandBarVisible(!entry.isIntersecting),
      { threshold: 0 },
    );
    observer.observe(hero);
    return () => observer.disconnect();
  }, []);

  const isDirty = useMemo(() => {
    if (!editorBaseline) return false;
    return (
      title !== editorBaseline.title ||
      keywords !== editorBaseline.keywords ||
      focus !== editorBaseline.focus ||
      body !== editorBaseline.body ||
      metaTitle !== editorBaseline.metaTitle ||
      metaDesc !== editorBaseline.metaDesc
    );
  }, [editorBaseline, title, keywords, focus, body, metaTitle, metaDesc]);

  const isImageDirty = useMemo(() => {
    if (!editorBaseline) return false;
    return (generatedImageUrl || "").trim() !== (editorBaseline.imageUrl || "").trim();
  }, [editorBaseline, generatedImageUrl]);

  const hasPendingWpChanges = isDirty || isImageDirty;
  const hasUnsavedChanges = hasPendingWpChanges || !!uploadedImageFile;

  const requestNavigation = useCallback(
    (href: string) => {
      if (editorBaseline !== null && hasUnsavedChanges) {
        setPendingLeaveHref(href);
        setLeaveConfirmOpen(true);
        return;
      }
      router.push(href);
    },
    [editorBaseline, hasUnsavedChanges, router],
  );

  useEffect(() => {
    if (!editorBaseline || !hasUnsavedChanges) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [editorBaseline, hasUnsavedChanges]);

  useEffect(() => {
    if (!notice) return;
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setNotice(null), 5000);
    return () => {
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    };
  }, [notice]);

  function showWebsiteConnectionErrorIfNeeded(e: unknown) {
    if (e instanceof ApiError && e.detail && typeof e.detail === "object" && !Array.isArray(e.detail)) {
      const d = e.detail as Record<string, unknown>;
      if (d.code === "website_not_connected") {
        setWebsiteConnectionModal(true);
        return true;
      }
    }
    return false;
  }

  useEffect(() => {
    if (!uploadedImagePreview) return;
    return () => URL.revokeObjectURL(uploadedImagePreview);
  }, [uploadedImagePreview]);

  useEffect(() => {
    if (!token) return;
    if (!isShopifyProject) return;
    if (!projectSettings) return;
    let cancelled = false;
    void api
      .getShopifyStatus(params.projectId, { skipGlobalLoading: true })
      .then((st) => {
        if (!cancelled) setShopifyStatus(st);
      })
      .catch(() => {
        /* non-fatal */
      });
    return () => {
      cancelled = true;
    };
  }, [isShopifyProject, params.projectId, projectSettings, token]);

  useEffect(() => {
    if (!token) return;
    if (!isShopifyProject) return;
    let cancelled = false;
    setShopifyCatalogLoading(true);
    void api
      .getShopifyCatalog(params.projectId)
      .then((cat) => {
        if (cancelled) return;
        setShopifyCatalog(cat);
        const blogs = Array.isArray(cat?.blogs) ? cat.blogs : [];
        if (blogs.length && shopifyBlogId == null) {
          const first = blogs.find((b) => b && typeof b === "object" && "id" in b) as { id?: unknown } | undefined;
          const idNum = first && typeof first.id === "number" ? first.id : Number(first?.id);
          if (Number.isFinite(idNum)) setShopifyBlogId(idNum);
        }
      })
      .catch(() => {
        /* non-fatal */
      })
      .finally(() => {
        if (!cancelled) setShopifyCatalogLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isShopifyProject, params.projectId, shopifyBlogId, token]);

  useEffect(() => {
    if (!token) return;
    if (!isWordPressProject) return;
    let cancelled = false;
    setSiteMapLoading(true);
    void api
      .siteMapList(params.projectId)
      .then((res) => {
        if (cancelled) return;
        setSiteMapEntries(Array.isArray(res?.entries) ? res.entries : []);
      })
      .catch(() => {
        if (!cancelled) setSiteMapEntries([]);
      })
      .finally(() => {
        if (!cancelled) setSiteMapLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isWordPressProject, params.projectId, token]);

  const loadFeaturedImageFromApi = useCallback(
    async (opts?: { force?: boolean }) => {
      const articleKey = `${params.projectId}:${params.articleId}`;
      const shell = article;
      if (!shell?.has_featured_image && !opts?.force) return null;

      const inlineUrl = (shell?.image_url || "").trim();
      if (inlineUrl && !opts?.force) {
        setGeneratedImageUrl(inlineUrl);
        featuredImageLoadRef.current = { articleKey, state: "loaded" };
        return inlineUrl;
      }

      const loadRef = featuredImageLoadRef.current;
      if (!opts?.force) {
        if (loadRef.articleKey === articleKey && loadRef.state === "loaded") return null;
        if (loadRef.articleKey === articleKey && loadRef.state === "failed") return null;
        if (loadRef.articleKey === articleKey && loadRef.state === "loading") return null;
      }

      featuredImageLoadRef.current = { articleKey, state: "loading" };
      setFeaturedImageLoadFailed(false);
      setFeaturedImageLoading(true);
      try {
        const url = await api.resolveArticleFeaturedImageUrl(params.projectId, params.articleId, {
          skipGlobalLoading: true,
          fresh: !!opts?.force,
          maxAttempts: opts?.force ? 6 : 2,
        });
        if (!url) {
          featuredImageLoadRef.current = { articleKey, state: "failed" };
          setFeaturedImageLoadFailed(true);
          return null;
        }
        setGeneratedImageUrl(url);
        setEditorBaseline((prev) => (prev ? { ...prev, imageUrl: url } : prev));
        setArticle((prev) =>
          prev && prev.id === params.articleId ? { ...prev, image_url: url, has_featured_image: true } : prev,
        );
        featuredImageLoadRef.current = { articleKey, state: "loaded" };
        return url;
      } catch {
        featuredImageLoadRef.current = { articleKey, state: "failed" };
        setFeaturedImageLoadFailed(true);
        return null;
      } finally {
        setFeaturedImageLoading(false);
      }
    },
    [article?.has_featured_image, article?.image_url, params.articleId, params.projectId],
  );

  const hydrateEditorShell = useCallback(
    (a: ArticleDetail) => {
      const articleKey = `${params.projectId}:${params.articleId}`;
      setArticle(a);
      setTitle(a.title || "");
      setKeywords(kwToString(a.keywords));
      setFocus(a.focus_keyphrase || "");
      setMetaTitle(a.meta_title || "");
      setMetaDesc(a.meta_description || "");
      setGenerateImage(a.generate_image ?? true);
      const inlineImage = (a.image_url || "").trim();
      if (inlineImage) {
        setGeneratedImageUrl(inlineImage);
        featuredImageLoadRef.current = { articleKey, state: "loaded" };
      } else if (!a.has_featured_image) {
        setGeneratedImageUrl("");
        featuredImageLoadRef.current = { articleKey, state: "idle" };
        setFeaturedImageLoadFailed(false);
      }
      // Disk-backed image: keep any already-loaded URL; dedicated effect fetches once.
      // Post type is NOT synced from article.wp_rest_base here — ensureWpMetaLoaded
      // always sets it from the project's current default_wp_rest_base.
    },
    [params.projectId, params.articleId],
  );

  const applyArticleBody = useCallback(
    (bodyText: string, shell: ArticleDetail) => {
      const merged: ArticleDetail = { ...shell, article: bodyText };
      setArticle(merged);
      setBody(bodyText);
      setEditorBaseline(
        baselineFromFields({
          title: shell.title || "",
          keywords: kwToString(shell.keywords),
          focus: shell.focus_keyphrase || "",
          body: bodyText,
          metaTitle: shell.meta_title || "",
          metaDesc: shell.meta_description || "",
          imageUrl: shell.image_url || "",
        }),
      );
      setEditorRevision((r) => r + 1);
    },
    [],
  );

  const hydrateEditorFromArticle = useCallback(
    (a: ArticleDetail) => {
      hydrateEditorShell(a);
      applyArticleBody(a.article || "", a);
    },
    [applyArticleBody, hydrateEditorShell],
  );

  // Staged load: shell (meta/SEO) first, then body — no global blocking overlay.
  useEffect(() => {
    if (!token) {
      router.replace("/");
      return;
    }
    if (!editorPath) return;

    const ac = new AbortController();
    let cancelled = false;

    const stopLoading = () => {
      setContentLoading(false);
      setBodyLoading(false);
    };

    const cached = readArticleEditorCache(params.projectId, params.articleId);
    if (cached) {
      hydrateEditorFromArticle(cached);
      stopLoading();
    } else {
      setContentLoading(true);
      setBodyLoading(true);
    }

    (async () => {
      setError(null);
      setErrorCanRetry(false);
      setNotice(null);

      void api
        .getProjectSettings(params.projectId, { skipGlobalLoading: true, signal: ac.signal })
        .then((ps) => {
          if (!cancelled && ps) setProjectSettings(ps);
        })
        .catch(() => {
          /* non-blocking */
        });

      // Always fresh: true so the editor bypasses the 60-second in-memory API
      // cache and hits the network on every open. This prevents stale prefetch
      // results (stored on hover) from silently blocking a real load, which
      // caused the editor to show blank title/body when the cache held an
      // incomplete entry from a previous aborted or errored fetch.
      const fetchOpts = { skipGlobalLoading: true, signal: ac.signal, fresh: true } as const;

      try {
        const [shellResult, bodyResult] = await Promise.allSettled([
          api.getArticleEditorShell(params.projectId, params.articleId, fetchOpts),
          api.getArticleBody(params.projectId, params.articleId, fetchOpts),
        ]);

        if (cancelled || ac.signal.aborted) return;

        if (shellResult.status === "rejected") {
          throw shellResult.reason;
        }

        const shell = shellResult.value;
        hydrateEditorShell(shell);
        setContentLoading(false);

        if (bodyResult.status === "fulfilled") {
          applyArticleBody(bodyResult.value.article || "", shell);
          writeArticleEditorCache(params.projectId, params.articleId, {
            ...shell,
            article: bodyResult.value.article || "",
          });
          setBodyLoading(false);
          return;
        }

        // Shell loaded; body alone failed — show SEO and surface body error.
        const bodyErr = bodyResult.reason;
        if (!cancelled) {
          const info = formatArticleLoadError(bodyErr);
          setError(info.message);
          setErrorCanRetry(info.canRetry);
        }
        setBodyLoading(false);
      } catch (e) {
        if (cancelled || ac.signal.aborted) return;
        if (
          e instanceof ApiError &&
          e.status === 0 &&
          e.detail &&
          typeof e.detail === "object" &&
          (e.detail as { code?: string }).code === "aborted"
        ) {
          return;
        }

        if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
          clearAuth();
          router.replace("/");
          return;
        }

        // Do not chain a full-document fetch when Atlas is down (adds 30s+ of retries).
        const msg =
          e instanceof ApiError && (isDatabaseUnavailable(e) || e.status === 408)
            ? connectionErrorMessage(e)
            : formatArticleLoadError(e).message;
        const canRetry =
          e instanceof ApiError
            ? e.status === 503 || e.status === 408 || e.status === 0 || e.status >= 500
            : formatArticleLoadError(e).canRetry;

        if (!cached) {
          setError(msg);
          setErrorCanRetry(canRetry);
        } else {
          setNotice("Showing cached copy — live data could not be refreshed.");
          setErrorCanRetry(canRetry);
        }
      } finally {
        if (!cancelled && !ac.signal.aborted) {
          stopLoading();
        }
      }
    })();

    return () => {
      cancelled = true;
      ac.abort();
      stopLoading();
    };
  }, [
    applyArticleBody,
    editorPath,
    hydrateEditorFromArticle,
    hydrateEditorShell,
    params.articleId,
    params.projectId,
    router,
    token,
    loadAttempt,
  ]);

  // Keep publish status aligned with WordPress when editing a linked post.
  useEffect(() => {
    if (!isLiveOnWordPress || !article?.id) return;
    const last = (article.wp_last_wp_status || "").trim().toLowerCase();
    if (last === "publish" || last === "draft") {
      setWpStatus(last);
    } else if ((article.status || "").trim().toLowerCase() === "published") {
      setWpStatus("publish");
    }
  }, [article?.id, article?.status, article?.wp_last_wp_status, isLiveOnWordPress]);

  const needsWpMeta = isWordPressProject && websiteConnected;

  // Post type is sourced from the project's default_wp_rest_base (set in ensureWpMetaLoaded),
  // not from the article's stale wp_rest_base. This ensures that changing Post Type in Project
  // Settings takes effect immediately for all new publications.

  // Load WordPress post types + categories when Publish tab opens (lazy).
  useEffect(() => {
    if (contextTab !== "publish") return;
    if (!token || !needsWpMeta || !article?.id) return;
    if (wpPostTypes.length || wpCategories.length) return;
    void ensureWpMetaLoaded();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contextTab, token, needsWpMeta, article?.id, params.projectId, wpPostTypes.length, wpCategories.length]);

  // Reset featured-image fetch state when navigating to a different article (not on first mount).
  useEffect(() => {
    const articleKey = `${params.projectId}:${params.articleId}`;
    if (prevArticleKeyRef.current !== null && prevArticleKeyRef.current !== articleKey) {
      featuredImageLoadRef.current = { articleKey, state: "idle" };
      setFeaturedImageLoadFailed(false);
      setFeaturedImageLoading(false);
      setGeneratedImageUrl("");
    }
    prevArticleKeyRef.current = articleKey;
  }, [params.projectId, params.articleId]);

  // Load disk-backed featured image once per article (deduped via ref).
  useEffect(() => {
    if (!token || !article?.id || !article.has_featured_image) return;
    if ((article.image_url || "").trim()) return;
    void loadFeaturedImageFromApi();
  }, [article?.id, article?.has_featured_image, article?.image_url, loadFeaturedImageFromApi, token]);

  // Background: prompts — settings already loaded in staged shell effect.
  useEffect(() => {
    if (!token || !article?.id || editorLocked) return;
    if (writingPrompts && imagePrompts) return;

    let cancelled = false;
    const runBackground = () => {
      if (cancelled) return;
      void ensurePromptsLoaded();
    };

    const w = window as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout?: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    const idleId =
      typeof w.requestIdleCallback === "function"
        ? w.requestIdleCallback(runBackground, { timeout: 2500 })
        : null;
    const t = idleId == null ? window.setTimeout(runBackground, 400) : null;

    return () => {
      cancelled = true;
      if (idleId != null && typeof w.cancelIdleCallback === "function") w.cancelIdleCallback(idleId);
      if (t) window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [article?.id, editorLocked, params.articleId, params.projectId, token, writingPrompts, imagePrompts]);

  async function ensurePromptsLoaded(): Promise<PromptListResponse | null> {
    if (promptsLoading) return imagePrompts;
    const needWriting = !writingPrompts;
    const needImage = !imagePrompts;
    if (!needWriting && !needImage) return imagePrompts;
    setPromptsLoading(true);
    let loadedImagePrompts: PromptListResponse | null = imagePrompts;
    try {
      const [wpRes, ipRes] = await Promise.allSettled([
        needWriting ? api.listWritingPrompts(params.projectId) : Promise.resolve(writingPrompts),
        needImage ? api.listImagePrompts(params.projectId) : Promise.resolve(imagePrompts),
      ]);
      const wp = wpRes.status === "fulfilled" ? wpRes.value : null;
      const ip = ipRes.status === "fulfilled" ? ipRes.value : null;
      if (wp) {
        setWritingPrompts(wp);
        setWritingPromptId((prev) => prev || wp.default_id || "");
      }
      if (ip) {
        loadedImagePrompts = ip;
        setImagePrompts(ip);
        setImagePromptId((prev) => prev || ip.default_id || "");
      }
    } catch {
      // ignore
    } finally {
      setPromptsLoading(false);
    }
    return loadedImagePrompts;
  }

  async function ensureWpMetaLoaded(opts?: { force?: boolean }) {
    if (!isWordPressProject) return;
    if (wpMetaLoading) return;
    if (!opts?.force && (wpPostTypes.length || wpCategories.length)) return;
    setWpMetaLoading(true);
    setWpMetaError(null);
    const fetchOpts = { skipGlobalLoading: true, timeoutMs: 25_000 };
    try {
      const [typesRes, catsRes, psRes] = await Promise.allSettled([
        api.wordpressPostTypes(params.projectId, fetchOpts),
        api.wordpressCategories(params.projectId, fetchOpts),
        api.getProjectSettings(params.projectId, fetchOpts),
      ]);
      if (typesRes.status === "fulfilled") {
        setWpPostTypes(typesRes.value);
      }
      if (catsRes.status === "fulfilled") {
        setWpCategories(catsRes.value);
      }
      if (psRes.status === "fulfilled") {
        const ps = psRes.value;
        // Always use the project's current post type — changes in Project Settings
        // take effect immediately for all new publications regardless of what was
        // stored on the article from a previous publish.
        setWpPostType((ps.default_wp_rest_base || "posts") as string);
        if (!isLiveOnWordPress) {
          setWpStatus(((ps.default_wp_status || "draft") as "draft" | "publish"));
          setWpCategoryIds((ps.default_wp_category_ids || []) as number[]);
        }
      }
      if (typesRes.status === "rejected" && catsRes.status === "rejected") {
        setWpMetaError(
          "Could not load WordPress post types or categories (your host may block wp/v2). " +
            "You can still publish via the Riviso plugin — try Publish, or use project defaults below.",
        );
      } else if (typesRes.status === "rejected") {
        setWpPostTypes([{ rest_base: "posts", name: "Posts", taxonomies: ["category", "post_tag"] }]);
        setWpMetaError(null);
      } else if (catsRes.status === "rejected") {
        setWpCategories([]);
        setWpMetaError(null);
      }
    } catch (e) {
      setWpMetaError(connectionErrorMessage(e));
    } finally {
      setWpMetaLoading(false);
    }
  }

  async function persistEditorForWordPress(opts?: { skipGlobalLoading?: boolean }) {
    const updated = await api.updateArticle(
      params.projectId,
      params.articleId,
      {
        title,
        keywords: kwFromString(keywords),
        focus_keyphrase: focus,
        article: body,
        meta_title: metaTitle,
        meta_description: metaDesc,
      },
      opts?.skipGlobalLoading ? { skipGlobalLoading: true } : undefined,
    );
    setArticle(updated);
    setEditorBaseline(
      baselineFromFields({ title, keywords, focus, body, metaTitle, metaDesc, imageUrl: generatedImageUrl }),
    );
    return updated;
  }

  async function save() {
    setError(null);
    setNotice(null);
    try {
      const updated = await api.updateArticle(params.projectId, params.articleId, {
        title,
        keywords: kwFromString(keywords),
        focus_keyphrase: focus,
        article: body,
        meta_title: metaTitle,
        meta_description: metaDesc,
      });
      setArticle(updated);
      setEditorBaseline(
        baselineFromFields({
          title,
          keywords,
          focus,
          body,
          metaTitle,
          metaDesc,
          imageUrl: generatedImageUrl,
        }),
      );
      setNotice("Saved.");
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setError(e.message);
        return;
      }
      setError(e instanceof Error ? e.message : "Save failed");
    }
  }

  async function ensureClusterLinkContext(force = false): Promise<ClusterLinkContext | null> {
    if (!isWordPressProject) return null;
    if (!force && clusterLinkContext) return clusterLinkContext;
    if (clusterLinkLoading) return clusterLinkContext;
    setClusterLinkLoading(true);
    try {
      const res = await api.getArticleClusterLinkContext(params.projectId, params.articleId, {
        skipGlobalLoading: true,
      });
      const ctx = res.cluster_link_context ?? null;
      setClusterLinkContext(ctx);
      return ctx;
    } catch {
      return null;
    } finally {
      setClusterLinkLoading(false);
    }
  }

  function openPlatformMapBeforeGenerate() {
    if (isShopifyProject) {
      setMappedProductsForGenerate([]);
      void api
        .getShopifyCatalog(params.projectId)
        .then((cat) => setShopifyCatalog(cat))
        .catch(() => {
          /* optional — map modal still opens */
        });
    } else if (isWordPressProject) {
      setMappedPagesForGenerate([]);
      setSiteMapLoading(true);
      void api
        .siteMapList(params.projectId)
        .then((res) => setSiteMapEntries(Array.isArray(res?.entries) ? res.entries : []))
        .catch(() => setSiteMapEntries([]))
        .finally(() => setSiteMapLoading(false));
    }
    setProductMapBeforeGenerateOpen(true);
  }

  const isClusterArticle = Boolean(clusterLinkContext?.cluster_id || article?.topic_cluster_id);
  const clusterRoleLabel =
    clusterLinkContext?.role === "pillar"
      ? "pillar"
      : clusterLinkContext?.role === "cluster"
        ? "supporting cluster"
        : "cluster";

  async function startGenerateFlow(opts?: { regenerate?: boolean; generateImageOverride?: boolean }) {
    if (isShopifyProject || isWordPressProject) {
      if (isWordPressProject) {
        const ctx = await ensureClusterLinkContext();
        if (ctx?.auto_link_ready) {
          void doGenerate(undefined, undefined, { ...opts, skipPlatformMapping: true });
          return;
        }
      }
      openPlatformMapBeforeGenerate();
      if (isWordPressProject && !clusterLinkContext) {
        void ensureClusterLinkContext();
      }
      return;
    }
    void doGenerate(undefined, undefined, opts);
  }

  async function generate() {
    await ensurePromptsLoaded();
    // Shopify projects can generate/regenerate drafts without store OAuth.
    if (!isShopifyProject && !isWordPressProject && !websiteConnected) {
      setWebsiteConnectionModal(true);
      return;
    }
    if (hasGeneratedContent) {
      setRegenImageChoice(generateImage);
      setShowRegenConfirm(true);
      return;
    }
    startGenerateFlow();
  }

  async function doGenerate(
    mappedProductsOverride?: MappedShopifyProduct[],
    mappedPagesOverride?: MappedWordPressPage[],
    opts?: { regenerate?: boolean; skipPlatformMapping?: boolean; generateImageOverride?: boolean },
  ) {
    if (!isShopifyProject && !isWordPressProject && !websiteConnected) {
      setWebsiteConnectionModal(true);
      return;
    }
    setError(null);
    setNotice(null);
    try {
      await runWithArticlePipelineMonitor(
        params.projectId,
        params.articleId,
        async () => {
          const pickedProducts = isShopifyProject
            ? opts?.skipPlatformMapping
              ? undefined
              : mappedProductsOverride !== undefined
                ? mappedProductsOverride
                : mappedProductsForGenerate.length
                  ? mappedProductsForGenerate
                  : undefined
            : undefined;
          const pickedPages = isWordPressProject
            ? opts?.skipPlatformMapping
              ? undefined
              : mappedPagesOverride !== undefined
                ? mappedPagesOverride
                : mappedPagesForGenerate.length
                  ? mappedPagesForGenerate
                  : undefined
            : undefined;
          const res = await api.generateArticle(
            params.projectId,
            params.articleId,
            {
              writing_prompt_id: writingPromptId || null,
              image_prompt_id: imagePromptId || null,
              focus_keyphrase: focus || null,
              generate_image: opts?.generateImageOverride ?? generateImage,
              mapped_products: isShopifyProject ? pickedProducts : undefined,
              mapped_pages: isWordPressProject ? pickedPages : undefined,
            },
            {
              previousGeneratedAt: article?.generated_at ?? null,
              expectImage: opts?.generateImageOverride ?? generateImage,
              skipGlobalLoading: true,
            },
          );
          if (res.generated?.article) setBody(res.generated.article);
          if (res.generated?.meta_title !== undefined) setMetaTitle(clampChars(res.generated.meta_title || "", META_TITLE_MAX));
          if (res.generated?.meta_description !== undefined) setMetaDesc(clampChars(res.generated.meta_description || "", META_DESC_MAX));
          if (res.generated?.image_url) {
            setGeneratedImageUrl(res.generated.image_url);
          }
          const hydrated = "hydratedArticle" in res ? res.hydratedArticle : undefined;
          if (hydrated) {
            setArticle(hydrated);
            hydrateEditorFromArticle(hydrated);
            writeArticleEditorCache(params.projectId, params.articleId, hydrated);
          } else if (res.generated?.article) {
            invalidateArticleDetailCache(params.projectId, params.articleId);
            const refreshed = await api.refreshArticleEditorPayload(params.projectId, params.articleId, {
              skipGlobalLoading: true,
            });
            setArticle(refreshed);
            hydrateEditorFromArticle(refreshed);
            writeArticleEditorCache(params.projectId, params.articleId, refreshed);
            if (!res.generated?.image_url && refreshed.has_featured_image) {
              const url = (refreshed.image_url || "").trim();
              if (url) setGeneratedImageUrl(url);
            }
          }
          if ("image_warning" in res && res.image_warning) {
            setError(res.image_warning);
          }
          setNotice(
            opts?.regenerate
              ? `Regenerated: ${res.message}`
              : `${res.status}: ${res.message}${res.generated?.image_url ? `\nImage: ${res.generated.image_url}` : ""}`,
          );
        },
        {
          initialMessage: opts?.regenerate
            ? "Regenerating article — connecting to live pipeline stream…"
            : "Starting article generation — connecting to live pipeline stream…",
        },
      );
    } catch (e) {
      if (showWebsiteConnectionErrorIfNeeded(e)) return;
      if (e instanceof ApiError && e.status === 408) {
        setError(e.message);
        return;
      }
      setError(
        connectionErrorMessage(e) ||
          (opts?.regenerate ? "Regenerate request failed" : "Generate request failed"),
      );
    }
  }

  function openImageRegenModal() {
    setError(null);
    if (!generateImage) {
      setError('Enable "Generate image" (Yes) to create a featured image.');
      return;
    }
    if (!body.trim()) {
      setError("Generate article content first, then create the featured image.");
      return;
    }
    void ensurePromptsLoaded();
    setRegenPromptSource("saved");
    setRegenPromptId(
      imagePromptId || imagePrompts?.default_id || imagePrompts?.items?.[0]?.id || "",
    );
    setRegenCustomPrompt("");
    setShowImageRegenModal(true);
    void ensurePromptsLoaded().then((ip) => {
      const defaultId = ip?.default_id || ip?.items?.[0]?.id || "";
      if (defaultId) {
        setRegenPromptId((prev) => prev || defaultId);
      }
    });
  }

  async function regenerateFeaturedImage(opts?: { image_prompt_id?: string | null; custom_image_prompt?: string | null }) {
    const hasImgNow = !!(generatedImageUrl || article?.has_featured_image);
    const regenUnlimited = article?.featured_image_regeneration_unlimited ?? true;
    const regenRemaining = article?.featured_image_regeneration_remaining;
    const regenExhausted = !regenUnlimited && (regenRemaining ?? 0) <= 0;
    if (!generateImage) {
      setError('Enable "Generate image" (Yes) to create a featured image.');
      return;
    }
    if (!body.trim()) {
      setError("Generate article content first, then create the featured image.");
      return;
    }
    if (regenExhausted && hasImgNow) {
      setError("The max featured image regeneration limit is exhausted for this article.");
      return;
    }
    setError(null);
    setNotice(null);
    setImageRegenBusy(true);
    setImageGenPhase("generating");
    setShowImageRegenModal(false);
    try {
      await runWithArticlePipelineMonitor(
        params.projectId,
        params.articleId,
        async () => {
          const res = await api.regenerateArticleImage(
            params.projectId,
            params.articleId,
            {
              image_prompt_id: opts?.custom_image_prompt ? null : (opts?.image_prompt_id ?? imagePromptId) || null,
              custom_image_prompt: opts?.custom_image_prompt?.trim() || null,
            },
            {
              previousRegenCount: article?.featured_image_regeneration_count ?? 0,
              hadFeaturedImage: !!(generatedImageUrl || article?.has_featured_image),
              skipGlobalLoading: true,
            },
          );
          setImageGenPhase("saving");
          let regenImageUrl = res.image_url || "";
          if (regenImageUrl) {
          setGeneratedImageUrl(regenImageUrl);
          }
          const hydrated = "hydratedArticle" in res ? res.hydratedArticle : undefined;
          if (hydrated) {
          setArticle(hydrated);
          if (!regenImageUrl && hydrated.has_featured_image) {
          regenImageUrl = (hydrated.image_url || "").trim();
          }
          }
          if (regenImageUrl) {
          setGeneratedImageUrl(regenImageUrl);
          setEditorBaseline((prev) => (prev ? { ...prev, imageUrl: regenImageUrl } : prev));
          } else if (hydrated?.has_featured_image) {
          featuredImageLoadRef.current = {
          articleKey: `${params.projectId}:${params.articleId}`,
          state: "idle",
          };
          await loadFeaturedImageFromApi({ force: true });
          } else if (!hydrated?.has_featured_image) {
          setError(
          "Featured image was not saved. If the backend log shows a database timeout, check MongoDB connectivity and retry.",
          );
          return;
          }
          if (res.save_warning) {
          setError(res.save_warning);
          }
          setNotice(
            `${res.status}: ${res.message}${
              isWordPressProject ? " Use Update article to push the new image to WordPress." : ""
            }`,
          );
        },
        { initialMessage: "Generating featured image — connecting to live pipeline stream…" },
      );
    } catch (e) {
      if (showWebsiteConnectionErrorIfNeeded(e)) return;
      if (e instanceof ApiError && e.detail && typeof e.detail === "object" && !Array.isArray(e.detail)) {
        const d = e.detail as Record<string, unknown>;
        if (d.code === "image_regeneration_limit_reached") {
          setError(typeof d.message === "string" ? d.message : "Featured image regeneration limit reached for this article.");
          return;
        }
        const partialUrl = typeof d.image_url === "string" ? d.image_url : "";
        if (partialUrl) {
          setGeneratedImageUrl(partialUrl);
          setEditorBaseline((prev) => (prev ? { ...prev, imageUrl: partialUrl } : prev));
          setError(
            typeof d.message === "string"
              ? d.message
              : "Image was generated but could not be saved. Retry when the database is available.",
          );
          return;
        }
      }
      setError(connectionErrorMessage(e));
    } finally {
      setImageRegenBusy(false);
      setImageGenPhase("idle");
    }
  }

  const canPublish =
    showPublishWordPress &&
    !editorLocked &&
    !!title.trim() &&
    !!body.trim() &&
    (generateImage ? true : !!uploadedImageFile);

  const canUpdateWordPress = canPushWordPressUpdate({
    ctx: wpEditorCtx,
    websiteConnected,
    hasTitle: !!title.trim(),
    hasBody: !!body.trim(),
    busy: wpUpdateBusy || wpPublishBusy,
  });

  const wpPushBusy = wpPublishBusy || wpUpdateBusy;

  const imageRegenUsed = article?.featured_image_regeneration_count ?? 0;
  const imageRegenUnlimited = article?.featured_image_regeneration_unlimited ?? true;
  const imageRegenLimit = article?.featured_image_regeneration_limit ?? 0;
  const imageRegenRemaining = article?.featured_image_regeneration_remaining;
  const imageRegenExhausted = !imageRegenUnlimited && (imageRegenRemaining ?? 0) <= 0;
  const hasFeaturedImage = !!(generatedImageUrl || article?.has_featured_image);
  const showFeaturedImageSkeleton = imageRegenBusy || featuredImageLoading;
  const canFeaturedImageAction =
    generateImage &&
    hasGeneratedContent &&
    (!imageRegenExhausted || !hasFeaturedImage);

  function handleFeaturedImageButtonClick() {
    if (!canFeaturedImageAction) return;
    openImageRegenModal();
  }

  async function publishToLiveSite() {
    if (!websiteConnected) {
      setWebsiteConnectionModal(true);
      return;
    }
    if (wpPublishBusy || wpUpdateBusy) return;
    setError(null);
    setNotice(null);
    setWpPublishBusy(true);
    try {
      await runWithArticlePipelineMonitor(
        params.projectId,
        params.articleId,
        async () => {
          await persistEditorForWordPress({ skipGlobalLoading: true });
          // Let the backend resolve the auto-generated image from its stored URL —
          // avoids downloading a large file in the browser and 413-ing nginx.
          const wpImageFile = uploadedImageFile ?? null;
          const res = await api.publishArticleToLiveSite(params.projectId, params.articleId, {
            image_file: wpImageFile,
            post_type: wpPostType,
            wp_status: wpStatus,
            category_ids: wpCategoryIds,
          }, { skipGlobalLoading: true });
          const refreshed = await api.getArticle(params.projectId, params.articleId, { fresh: true, skipGlobalLoading: true });
          setArticle(refreshed);
          const syncedImageUrl = refreshed.image_url || generatedImageUrl;
          setGeneratedImageUrl(syncedImageUrl);
          setEditorBaseline(baselineFromArticle(refreshed, syncedImageUrl));
          // Do NOT reset wpPostType from article.wp_rest_base — keep the project default
          // so the Post Type selector reflects the project setting, not the historical value.
          setNotice(`${res.status}: ${res.message}${res.wp_link ? `\n${res.wp_link}` : ""}`);
        },
        { initialMessage: "Publishing to WordPress — connecting to live pipeline stream…" },
      );
    } catch (e) {
      if (showWebsiteConnectionErrorIfNeeded(e)) return;
      if (e instanceof ApiError && e.status === 408) {
        setError(e.message);
        return;
      }
      setError(connectionErrorMessage(e));
    } finally {
      setWpPublishBusy(false);
    }
  }

  async function updateWordPressPost() {
    if (!websiteConnected) {
      setWebsiteConnectionModal(true);
      return;
    }
    if (!showUpdateWordPress) return;
    if (wpPublishBusy || wpUpdateBusy) return;
    setError(null);
    setNotice(null);
    setWpUpdateBusy(true);
    try {
      await persistEditorForWordPress({ skipGlobalLoading: true });
      // For auto-generated images, pass null so the backend resolves the image
      // from its stored URL directly — avoids downloading a large file in the
      // browser and re-uploading it through nginx (which would 413 on big images).
      // Only send an image when the user explicitly uploaded one.
      const wpImageFile = uploadedImageFile ?? null;
      const res = await api.updateArticleOnWordPress(params.projectId, params.articleId, {
        image_file: wpImageFile,
        post_type: wpPostType,
        wp_status: effectiveWpStatus,
        category_ids: wpCategoryIds,
      });
      const refreshed = await api.getArticle(params.projectId, params.articleId, { fresh: true });
      setArticle(refreshed);
      const syncedImageUrl = refreshed.image_url || generatedImageUrl;
      setGeneratedImageUrl(syncedImageUrl);
      setEditorBaseline(baselineFromArticle(refreshed, syncedImageUrl));
      // Do NOT reset wpPostType from article.wp_rest_base — keep the project default.
      let noticeText = `${res.status}: ${res.message}${res.wp_link ? `\n${res.wp_link}` : ""}`;
      if (res.featured_image_uploaded === false && hasFeaturedImage) {
        noticeText += "\nFeatured image was not uploaded to WordPress — check upload permissions on your WP user.";
      }
      setNotice(noticeText);
    } catch (e) {
      if (showWebsiteConnectionErrorIfNeeded(e)) return;
      if (e instanceof ApiError && e.status === 408) {
        setError(e.message);
        return;
      }
      setError(connectionErrorMessage(e));
    } finally {
      setWpUpdateBusy(false);
    }
  }

  async function copyLiveUrl() {
    if (!wpLink) return;
    try {
      await navigator.clipboard.writeText(wpLink);
      setLiveUrlCopied(true);
      window.setTimeout(() => setLiveUrlCopied(false), 2000);
    } catch {
      /* clipboard unavailable */
    }
  }

  const applyWordPressSyncResult = useCallback(
    (synced: ArticleDetail, message: string, changes: string[]) => {
      hydrateEditorFromArticle(synced);
      writeArticleEditorCache(params.projectId, params.articleId, synced);
      const summary =
        changes.length && !changes.every((c) => c === "no content changes")
          ? `${message} Updated: ${changes.join(", ")}.`
          : message;
      setNotice(summary);
    },
    [hydrateEditorFromArticle, params.articleId, params.projectId],
  );

  async function syncFromWordPress(opts?: { silent?: boolean; force?: boolean }) {
    if (!isWordPressProject || !websiteConnected || !article?.id) return;
    if (!isLiveOnWordPress) return;
    if (wpSyncBusy) return;
    if (!opts?.force && hasPendingWpChanges) {
      setShowWpSyncConfirm(true);
      return;
    }

    setWpSyncBusy(true);
    if (!opts?.silent) setNotice(null);
    try {
      const res = await api.syncArticleFromWordPress(params.projectId, params.articleId);
      applyWordPressSyncResult(res.article, res.message, res.changes || []);
    } catch (e) {
      if (!opts?.silent) {
        if (showWebsiteConnectionErrorIfNeeded(e)) return;
        setError(e instanceof Error ? e.message : "WordPress sync failed");
      }
    } finally {
      setWpSyncBusy(false);
    }
  }

  useEffect(() => {
    wpAutoSyncKeyRef.current = null;
  }, [params.articleId, params.projectId]);

  // Pull latest permalink, body, and status from WordPress when opening a linked article.
  useEffect(() => {
    if (!token || !isWordPressProject || !websiteConnected || !article?.id) return;
    if (!isLiveOnWordPress) return;
    if (contentLoading || bodyLoading) return;
    if (hasPendingWpChanges) return;
    if (wpSyncBusy) return;

    const syncKey = `${params.projectId}:${params.articleId}`;
    if (wpAutoSyncKeyRef.current === syncKey) return;
    wpAutoSyncKeyRef.current = syncKey;

    void syncFromWordPress({ silent: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    token,
    isWordPressProject,
    websiteConnected,
    article?.id,
    isLiveOnWordPress,
    contentLoading,
    bodyLoading,
    hasPendingWpChanges,
    params.projectId,
    params.articleId,
  ]);

  async function copyArticleMarkdown() {
    const md = (body || "").trim();
    if (!md) return;
    try {
      await navigator.clipboard.writeText(md);
      setNotice("Copied article markdown to clipboard.");
    } catch {
      setNotice("Could not copy to clipboard (browser permission).");
    }
  }

  async function copyArticleTitleAndMarkdown() {
    const md = (body || "").trim();
    const t = (title || article?.title || "").trim();
    const payload = [t ? `# ${t}` : "", md].filter(Boolean).join("\n\n");
    if (!payload.trim()) return;
    try {
      await navigator.clipboard.writeText(payload);
      setNotice("Copied title + article markdown to clipboard.");
    } catch {
      setNotice("Could not copy to clipboard (browser permission).");
    }
  }

  async function syncShopifyCatalogFromEditor() {
    if (shopifyCatalogSyncing) return;
    setShopifyCatalogSyncing(true);
    setError(null);
    try {
      await api.syncShopifyCatalog(params.projectId);
      const cat = await api.getShopifyCatalog(params.projectId);
      setShopifyCatalog(cat);
      const blogs = Array.isArray(cat?.blogs) ? cat.blogs : [];
      if (blogs.length) {
        const first = blogs[0] as { id?: unknown };
        const idNum = typeof first.id === "number" ? first.id : Number(first.id);
        if (Number.isFinite(idNum)) setShopifyBlogId(idNum);
      }
      const st = await api.getShopifyStatus(params.projectId, { skipGlobalLoading: true });
      setShopifyStatus(st);
      setNotice("Shopify catalog synced.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Shopify sync failed");
    } finally {
      setShopifyCatalogSyncing(false);
    }
  }

  async function publishToShopify() {
    if (shopifyPublishBusy) return;
    if (!websiteConnected) {
      setWebsiteConnectionModal(true);
      return;
    }
    if (!title.trim() || !body.trim()) {
      setError("Add article title and body before posting to Shopify.");
      return;
    }
    setShopifyPublishBusy(true);
    setError(null);
    setNotice(null);
    try {
      await runWithArticlePipelineMonitor(
        params.projectId,
        params.articleId,
        async () => {
          const res = await api.publishArticleToShopify(
            params.projectId,
            params.articleId,
            {
              blog_id: shopifyBlogId,
              publish: shopifyPublishNow,
            },
            { skipGlobalLoading: true },
          );
          const refreshed = await api.getArticle(params.projectId, params.articleId, { fresh: true, skipGlobalLoading: true });
          setArticle(refreshed);
          setNotice(`${res.message}${res.shopify_link ? `\n${res.shopify_link}` : ""}`);
        },
        { initialMessage: "Publishing to Shopify — connecting to live pipeline stream…" },
      );
    } catch (e) {
      if (showWebsiteConnectionErrorIfNeeded(e)) return;
      if (e instanceof ApiError && e.detail && typeof e.detail === "object" && !Array.isArray(e.detail)) {
        const d = e.detail as Record<string, unknown>;
        if (typeof d.message === "string") {
          setError(d.message);
          return;
        }
      }
      setError(e instanceof Error ? e.message : "Shopify publish failed");
    } finally {
      setShopifyPublishBusy(false);
    }
  }

  const shopifyLink = (article?.shopify_link || "").trim();
  const shopifyCanPublish =
    websiteConnected &&
    Boolean(shopifyStatus?.can_publish ?? (shopifyStatus?.granted_scopes || []).includes("write_content")) &&
    !!title.trim() &&
    !!body.trim();
  const shopifyBlogsAvailable = (shopifyCatalog?.blogs || []).length > 0;
  const shopifyMissingPublishScopes = shopifyStatus?.missing_publish_scopes || [];

  const displayTitle = (title || article?.title || "Article").trim() || "Article";

  if (!editorPath) {
    return (
      <div className={`${styles.page} ${styles.pageTop} ${projectsDark.projectsDark}`}>
        <main className={`${styles.main} ${styles.mainWide}`}>
          <section className={styles.contentCol}>
            <div className={`${styles.card} ${styles.cardWide}`}>
              <p className={styles.error}>
                Invalid article link. Open the article from your project&apos;s Articles list.
              </p>
              <Link href={`/projects/${params.projectId}?tab=articles`} className={styles.button}>
                Back to articles
              </Link>
            </div>
          </section>
        </main>
      </div>
    );
  }

  const seoScoreColor = seoScore.total >= 70 ? "var(--aa-success)" : seoScore.total >= 40 ? "var(--aa-warning)" : "var(--aa-error)";
  const seoArcLength = (seoScore.total / 100) * 188.5;

  const articleSlug = useMemo(() => slugFromTitle(title || article?.title || ""), [title, article?.title]);
  const canonicalUrl = wpLink || (projectSettings?.website_url ? `${projectSettings.website_url.replace(/\/$/, "")}/${articleSlug}/` : "");

  return (
    <div className={`${styles.page} ${styles.pageTop} ${projectsDark.projectsDark}`}>
      <main className={`${styles.main} ${styles.mainWide}`} style={{ padding: 0 }}>

        {/* ── Title hero ── */}
        <div className={editorStyles.titleHero} ref={titleHeroRef}>
          <button
            type="button"
            className={editorStyles.titleBackLink}
            onClick={() => requestNavigation(`/projects/${params.projectId}?tab=articles`)}
          >
            ← Back to Articles
          </button>
          <h1 className={editorStyles.titleHeading}>{displayTitle}</h1>
          <div className={editorStyles.titleMeta}>
            <span className={editorStyles.statusDot}>
              <span className={`${editorStyles.statusDotIndicator} ${statusDotClass(article?.status || "")}`} />
              {article?.status ? article.status.charAt(0).toUpperCase() + article.status.slice(1) : "..."}
            </span>
            {isLiveOnWordPress ? (
              <span className={editorStyles.statusDot}>
                <span className={`${editorStyles.statusDotIndicator} ${editorStyles.statusDotSynced}`} />
                {isWpTrashed ? "Trashed" : "Synced"}
              </span>
            ) : null}
            {showUpdateWordPress && hasPendingWpChanges ? (
              <span className={editorStyles.statusDot}>
                <span className={`${editorStyles.statusDotIndicator} ${editorStyles.statusDotDraft}`} />
                Unsynced
              </span>
            ) : null}
            {seoScore.total > 0 ? (
              <span className={editorStyles.statusDot}>
                <span className={editorStyles.statusDotIndicator} style={{ background: seoScoreColor }} />
                SEO {seoScore.total}
              </span>
            ) : null}
            {lastSavedLabel ? (
              <span className={editorStyles.statusDot}>
                <span className={`${editorStyles.statusDotIndicator} ${editorStyles.statusDotNeutral}`} />
                {lastSavedLabel}
              </span>
            ) : null}
          </div>
        </div>

        {/* ── Sticky command bar (appears on scroll) ── */}
        <div className={`${editorStyles.commandBar} ${commandBarVisible ? editorStyles.commandBarVisible : ""}`}>
          <span className={editorStyles.commandBarTitle}>{displayTitle}</span>
          <div className={editorStyles.commandBarCenter}>
            <span className={editorStyles.statusDot}>
              <span className={`${editorStyles.statusDotIndicator} ${statusDotClass(article?.status || "")}`} />
              {article?.status ? article.status.charAt(0).toUpperCase() + article.status.slice(1) : "..."}
            </span>
            {isLiveOnWordPress ? (
              <span className={editorStyles.statusDot}>
                <span className={`${editorStyles.statusDotIndicator} ${editorStyles.statusDotSynced}`} />
                Synced
              </span>
            ) : null}
          </div>
          <div className={editorStyles.commandBarActions}>
            {isDirty ? (
              <button type="button" className={styles.btnSecondary} onClick={save} disabled={editorLocked}>
                Save draft
              </button>
            ) : null}
            {isShopifyProject ? (
              <button type="button" className={styles.button} onClick={() => void publishToShopify()} disabled={shopifyPublishBusy || !shopifyCanPublish || !shopifyBlogsAvailable}>
                {shopifyPublishBusy ? "Posting…" : article?.shopify_article_id ? "Update Shopify" : "Publish to Shopify"}
              </button>
            ) : showUpdateWordPress && hasPendingWpChanges ? (
              <button type="button" className={styles.button} onClick={() => void updateWordPressPost()} disabled={!canUpdateWordPress}>
                {wpUpdateBusy ? "Updating…" : "Update article"}
              </button>
            ) : showPublishWordPress ? (
              <button type="button" className={styles.button} onClick={publishToLiveSite} disabled={!canPublish || wpPushBusy}>
                {wpPublishBusy ? "Publishing…" : "Publish"}
              </button>
            ) : null}
          </div>
        </div>

        {error ? (
          <div className={`${editorStyles.banner} ${editorStyles.bannerError}`} role="alert">
            <p className={styles.error} style={{ margin: 0 }}>{error}</p>
            <div className={editorStyles.bannerActions}>
              <button type="button" className={styles.button} onClick={() => requestNavigation(`/projects/${params.projectId}?tab=articles`)}>
                Back to articles
              </button>
              {errorCanRetry ? (
                <button type="button" className={styles.btnSecondary} onClick={() => setLoadAttempt((n) => n + 1)}>
                  Retry
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        {/* ── Modals (unchanged, position: fixed) ── */}

        {productMapBeforeGenerateOpen ? (
          <div className={styles.modalBackdrop} role="dialog" aria-modal="true" aria-label={isShopifyProject ? "Map products before generation" : "Map pages before generation"}>
            <div className={styles.modalPanel}>
              <div className={styles.modalHead}>
                <h3 className={styles.modalTitle}>
                  {hasGeneratedContent
                    ? isShopifyProject ? "Map products before regenerate" : "Map pages before regenerate"
                    : isShopifyProject ? "Map products for this article" : "Map site pages for this article"}
                </h3>
                <button type="button" className={styles.iconButton} aria-label="Close" onClick={() => setProductMapBeforeGenerateOpen(false)}>×</button>
              </div>
              <div className={styles.modalBody}>
                {isWordPressProject && isClusterArticle && clusterLinkContext ? (
                  <div className={editorStyles.clusterContextCard}>
                    <div className={editorStyles.clusterContextTitle}>Topic cluster · {clusterRoleLabel} article</div>
                    {clusterLinkContext.auto_link_ready ? (
                      <p className={styles.muted} style={{ margin: 0 }}>
                        {clusterLinkContext.live_sibling_count} related article{clusterLinkContext.live_sibling_count === 1 ? "" : "s"} already live on WordPress — Riviso will link them automatically when you generate.
                      </p>
                    ) : (
                      <p className={styles.muted} style={{ margin: 0 }}>
                        Related cluster articles are not live on WordPress yet. Map published pages below, or skip to generate without internal links until siblings are published.
                      </p>
                    )}
                    {clusterLinkContext.siblings.length ? (
                      <ul style={{ margin: "8px 0 0", paddingLeft: 18 }}>
                        {clusterLinkContext.siblings.map((s) => (
                          <li key={s.slot_id} style={{ marginBottom: 4 }}>
                            <span style={{ fontWeight: 700 }}>{s.title || "Untitled"}</span>{" — "}
                            {s.is_live ? <span style={{ color: "rgba(120,200,140,0.95)" }}>Live</span> : <span style={{ color: "rgba(255,180,120,0.95)" }}>Not live</span>}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                ) : null}
                {isShopifyProject ? (
                  <ShopifyProductMapPicker products={shopifyCatalog?.products || []} value={mappedProductsForGenerate} onChange={setMappedProductsForGenerate} loading={shopifyCatalogLoading} grantedScopes={shopifyCatalog?.granted_scopes || []} />
                ) : (
                  <WordPressPageMapPicker entries={siteMapEntries || []} value={mappedPagesForGenerate} onChange={setMappedPagesForGenerate} loading={siteMapLoading} internalLinkAwareEnabled={wpInternalLinkAware} />
                )}
              </div>
              <div className={styles.modalFooter}>
                <button type="button" className={styles.btnSecondary} onClick={() => setProductMapBeforeGenerateOpen(false)}>Cancel</button>
                <button type="button" className={styles.btnSecondary} onClick={() => { setProductMapBeforeGenerateOpen(false); void doGenerate(undefined, undefined, { regenerate: hasGeneratedContent, skipPlatformMapping: true }); }}>
                  Skip — {hasGeneratedContent ? "regenerate" : "generate"} {isShopifyProject ? "without products" : "without mapped pages"}
                </button>
                <button type="button" className={styles.button} disabled={isShopifyProject ? !mappedProductsForGenerate.length : !mappedPagesForGenerate.length} onClick={() => {
                  if (isShopifyProject) { const picked = [...mappedProductsForGenerate]; setProductMapBeforeGenerateOpen(false); void doGenerate(picked, undefined, { regenerate: hasGeneratedContent }); }
                  else { const picked = [...mappedPagesForGenerate]; setProductMapBeforeGenerateOpen(false); void doGenerate(undefined, picked, { regenerate: hasGeneratedContent }); }
                }}>
                  {hasGeneratedContent ? "Regenerate" : "Generate"} with mapped {isShopifyProject ? "products" : "pages"}
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {showRegenConfirm ? (
          <div className={styles.modalBackdrop} role="dialog" aria-modal="true" aria-label="Regenerate article">
            <div className={styles.modalPanel}>
              <div className={styles.modalHead}><h3 className={styles.modalTitle}>Regenerate article?</h3></div>
              <div className={styles.modalBody} style={{ display: "grid", gap: 16 }}>
                <p style={{ margin: 0, lineHeight: 1.6, fontSize: 14, color: "var(--aa-ink)" }}>
                  Generate a fresh version of this article using the selected prompts. This will replace the current article content and SEO metadata. Any unsaved edits will be lost. Save your work before continuing.
                  {regenImageChoice && (<>{" "}<span style={{ opacity: 0.75 }}>A new featured image will also be generated and replace the current image.</span></>)}
                </p>
                <label className={styles.label}>
                  Writing prompt
                  <select className={styles.input} value={writingPromptId} onChange={(e) => setWritingPromptId(e.target.value)}>
                    <option value="">Project default</option>
                    {(writingPrompts?.items || []).map((p) => (<option key={p.id} value={p.id}>{p.name}</option>))}
                  </select>
                </label>
                <div style={{ display: "grid", gap: 8 }}>
                  <span className={styles.label} style={{ marginBottom: 0 }}>Featured image</span>
                  <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", fontSize: 14, color: "var(--aa-ink)" }}>
                    <input type="radio" name="regenImage" checked={regenImageChoice} onChange={() => setRegenImageChoice(true)} /> Generate a new image
                  </label>
                  <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", fontSize: 14, color: "var(--aa-ink)" }}>
                    <input type="radio" name="regenImage" checked={!regenImageChoice} onChange={() => setRegenImageChoice(false)} /> Keep existing image
                  </label>
                  <p className={styles.muted} style={{ fontSize: 12, margin: 0, lineHeight: 1.45 }}>
                    {regenImageChoice ? "A new featured image will be generated after the article is written." : "Your current featured image will remain unchanged. Only the article content will be regenerated."}
                  </p>
                </div>
                <label className={styles.label} style={{ opacity: regenImageChoice ? 1 : 0.45 }}>
                  Image prompt
                  <select className={styles.input} value={imagePromptId} onChange={(e) => setImagePromptId(e.target.value)} disabled={!regenImageChoice}>
                    <option value="">Project default</option>
                    {(imagePrompts?.items || []).map((p) => (<option key={p.id} value={p.id}>{p.name}</option>))}
                  </select>
                </label>
              </div>
              <div className={styles.modalFooter}>
                <button className={styles.btnSecondary} type="button" onClick={() => setShowRegenConfirm(false)}>Cancel</button>
                <button className={styles.button} type="button" onClick={() => { setShowRegenConfirm(false); startGenerateFlow({ regenerate: true, generateImageOverride: regenImageChoice }); }}>Regenerate</button>
              </div>
            </div>
          </div>
        ) : null}

        {showWpSyncConfirm ? (
          <div className={styles.modalBackdrop} role="dialog" aria-modal="true" aria-label="Sync from WordPress">
            <div className={styles.modalPanel}>
              <div className={styles.modalHead}><div className={styles.modalTitle}>Sync from WordPress?</div></div>
              <div className={styles.modalBody}>
                <p style={{ margin: 0, lineHeight: 1.55 }}>You have unsaved edits in Riviso. Syncing will replace the title, body, SEO fields, and live URL with the current version on WordPress.</p>
              </div>
              <div className={styles.modalFooter}>
                <button className={styles.btnSecondary} type="button" onClick={() => setShowWpSyncConfirm(false)}>Cancel</button>
                <button className={styles.button} type="button" onClick={() => { setShowWpSyncConfirm(false); void syncFromWordPress({ force: true }); }}>Sync and overwrite</button>
              </div>
            </div>
          </div>
        ) : null}

        {showImageRegenModal ? (
          <div className={styles.modalBackdrop} role="dialog" aria-modal="true" aria-label="Regenerate featured image">
            <div className={styles.modalPanel} style={{ maxWidth: 520 }}>
              <div className={styles.modalHead}>
                <h3 className={styles.modalTitle}>{hasFeaturedImage ? "Regenerate featured image" : "Generate featured image"}</h3>
                <button type="button" className={styles.iconButton} aria-label="Close" disabled={imageRegenBusy} onClick={() => setShowImageRegenModal(false)}>×</button>
              </div>
              <div className={styles.modalBody} style={{ display: "grid", gap: 14 }}>
                {imageRegenBusy ? (
                  <div className={editorStyles.imageGenerating} style={{ minHeight: 120 }}>
                    <div className={editorStyles.imageSpinner} aria-hidden="true" />
                    <div className={editorStyles.imageGeneratingTitle}>{imageGenPhase === "saving" ? "Saving featured image…" : "Generating with OpenAI…"}</div>
                    <div className={editorStyles.imageGeneratingHint}>{imageGenPhase === "saving" ? "Writing to storage." : "This usually takes 30–90 seconds. Please keep this tab open."}</div>
                  </div>
                ) : (
                  <>
                    <p className={styles.muted} style={{ margin: 0, fontSize: 13, lineHeight: 1.5 }}>Choose a saved image prompt or enter a one-time custom prompt. If no saved prompt is selected, Riviso uses your brand/niche defaults.</p>
                    <label className={styles.label} style={{ display: "flex", gap: 8, alignItems: "center", margin: 0 }}>
                      <input type="radio" name="regen-prompt-source" checked={regenPromptSource === "saved"} onChange={() => setRegenPromptSource("saved")} /> Use saved image prompt
                    </label>
                    {regenPromptSource === "saved" ? (
                      <select className={styles.input} value={regenPromptId} onChange={(e) => setRegenPromptId(e.target.value)}>
                        <option value="">Default (brand + niche)</option>
                        {(imagePrompts?.items || []).map((p) => (<option key={p.id} value={p.id}>{p.name || p.id}</option>))}
                      </select>
                    ) : null}
                    <label className={styles.label} style={{ display: "flex", gap: 8, alignItems: "center", margin: 0 }}>
                      <input type="radio" name="regen-prompt-source" checked={regenPromptSource === "custom"} onChange={() => setRegenPromptSource("custom")} /> Add custom prompt for regeneration
                    </label>
                    {regenPromptSource === "custom" ? (
                      <textarea className={styles.input} rows={5} value={regenCustomPrompt} onChange={(e) => setRegenCustomPrompt(e.target.value)} placeholder="Describe the image you want for this article only…" />
                    ) : null}
                  </>
                )}
              </div>
              <div className={styles.modalFooter}>
                <button className={styles.btnSecondary} type="button" disabled={imageRegenBusy} onClick={() => setShowImageRegenModal(false)}>Cancel</button>
                <button className={styles.button} type="button"
                  disabled={imageRegenBusy || (regenPromptSource === "custom" && regenCustomPrompt.trim().length > 0 && regenCustomPrompt.trim().length < 10) || (regenPromptSource === "custom" && !regenCustomPrompt.trim())}
                  onClick={() => void regenerateFeaturedImage(regenPromptSource === "custom" ? { custom_image_prompt: regenCustomPrompt.trim() } : { image_prompt_id: regenPromptId || null })}
                >
                  {imageRegenBusy ? (hasFeaturedImage ? "Regenerating…" : "Generating…") : (hasFeaturedImage ? "Regenerate image" : "Generate image")}
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {websiteConnectionModal ? (
          <div className={styles.modalBackdrop} role="dialog" aria-modal="true" aria-label="Website not connected">
            <div className={styles.modalPanel}>
              <div className={styles.modalHead}>
                <h3 className={styles.modalTitle}>Website not connected</h3>
                <button type="button" className={styles.iconButton} aria-label="Close" onClick={() => setWebsiteConnectionModal(false)}>×</button>
              </div>
              <div className={styles.modalBody}>Website is not connected for this project. Connect and verify WordPress in Project Settings to generate or publish articles.</div>
              <div className={styles.modalFooter}>
                <button className={styles.btnSecondary} type="button" onClick={() => router.push("/dashboard")}>Cancel</button>
                <button className={styles.button} type="button" onClick={() => router.push(`/projects/${params.projectId}?tab=project_settings`)}>Connect Website</button>
              </div>
            </div>
          </div>
        ) : null}

        {leaveConfirmOpen ? (
          <div className={styles.modalBackdrop} role="dialog" aria-modal="true" aria-labelledby="leave-unsaved-title">
            <div className={styles.modalPanel} style={{ maxWidth: 480 }}>
              <div className={styles.modalHead}><h3 id="leave-unsaved-title" className={styles.modalTitle}>Leave without saving?</h3></div>
              <div className={styles.modalBody} style={{ display: "grid", gap: 10 }}>
                <p style={{ margin: 0, lineHeight: 1.55, fontSize: 14, color: "var(--aa-ink)" }}>You have unsaved changes on this article. If you leave now, your edits will be lost and will not be pushed to WordPress.</p>
                <p className={styles.muted} style={{ margin: 0, fontSize: 13, lineHeight: 1.5 }}>Cancel to keep editing. Confirm to leave this page.</p>
              </div>
              <div className={styles.modalFooter}>
                <button className={styles.btnSecondary} type="button" onClick={() => { setLeaveConfirmOpen(false); setPendingLeaveHref(null); }}>Cancel</button>
                <button className={styles.button} type="button" onClick={() => { const href = pendingLeaveHref; setLeaveConfirmOpen(false); setPendingLeaveHref(null); if (href) router.push(href); }}>Confirm</button>
              </div>
            </div>
          </div>
        ) : null}

        {/* ── Two-column workspace ── */}
        <div className={`${editorStyles.editorLayout} ${sidebarCollapsed ? editorStyles.editorLayoutCollapsed : ""}`}>

          {/* Editor column */}
          <div className={editorStyles.editorCol}>
            <div className={editorStyles.editorColInner}>
              <div className={editorStyles.editorSurface}>
                <div className={editorStyles.editorBody}>
                  {bodyLoading ? (
                    <ArticleEditorSkeleton bodyOnly />
                  ) : editorLocked ? (
                    <ArticleReadonlyBody key={editorRevision} markdown={body} />
                  ) : (
                    <ArticleRichEditor key={editorRevision} contentRevision={editorRevision} value={body} onChange={setBody} />
                  )}
                </div>
                {showUpdateWordPress && hasPendingWpChanges ? (
                  <div className={editorStyles.contentHint}>
                    <span className={editorStyles.contentHintDot} />
                    {isDirty ? "Unsaved text changes. Update pushes everything live." : "Featured image changed. Update to push."}
                  </div>
                ) : null}
              </div>

              {/* Metrics footer */}
              <div className={editorStyles.metricsBar}>
                <span className={editorStyles.metricsItem}>
                  <span className={editorStyles.metricsValue}>{editorMetrics.words.toLocaleString()}</span> words
                </span>
                <span className={editorStyles.metricsSep} />
                <span className={editorStyles.metricsItem}>
                  <span className={editorStyles.metricsValue}>{editorMetrics.chars.toLocaleString()}</span> chars
                </span>
                <span className={editorStyles.metricsSep} />
                <span className={editorStyles.metricsItem}>
                  <span className={editorStyles.metricsValue}>{editorMetrics.readingTime}</span> read
                </span>
                <span className={editorStyles.metricsSep} />
                <span className={editorStyles.metricsItem}>
                  <span className={editorStyles.metricsValue}>{editorMetrics.headings}</span> headings
                </span>
                {focus ? (
                  <>
                    <span className={editorStyles.metricsSep} />
                    <span className={editorStyles.metricsItem}>
                      Focus: <span className={editorStyles.metricsValue}>{focus}</span>
                    </span>
                  </>
                ) : null}
                <span className={editorStyles.metricsSep} />
                <span className={editorStyles.metricsItem}>
                  SEO <span style={{ color: seoScoreColor, fontWeight: 700 }}>{seoScore.total}</span>
                </span>
                {lastSavedLabel ? (
                  <span className={editorStyles.metricsSaved}>Saved {lastSavedLabel}</span>
                ) : null}
              </div>
            </div>
          </div>

          {/* Context panel */}
          <div className={editorStyles.contextPanel}>
            <button
              type="button"
              className={editorStyles.panelCollapseBtn}
              onClick={() => setSidebarCollapsed((v) => !v)}
              aria-label={sidebarCollapsed ? "Expand panel" : "Collapse panel"}
            >
              {sidebarCollapsed ? "◀" : "▶"}
            </button>

            <div className={editorStyles.contextTabBar} role="tablist" aria-label="Context panel">
              {CONTEXT_TABS.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  role="tab"
                  aria-selected={contextTab === t.key}
                  aria-controls={`panel-${t.key}`}
                  id={`tab-${t.key}`}
                  className={`${editorStyles.contextTabBtn} ${contextTab === t.key ? editorStyles.contextTabBtnActive : ""}`}
                  onClick={() => { setContextTab(t.key); if (sidebarCollapsed) setSidebarCollapsed(false); }}
                >
                  <span className={editorStyles.contextTabIcon}>{t.icon}</span>
                  {t.label}
                </button>
              ))}
            </div>

            <div className={editorStyles.contextTabContent} role="tabpanel" id={`panel-${contextTab}`} aria-labelledby={`tab-${contextTab}`}>

              {/* ── SEO tab ── */}
              {contextTab === "seo" ? (
                contentLoading ? <ArticleEditorSkeleton /> : (
                  <>
                    {/* SEO Score ring */}
                    <div className={editorStyles.seoScoreCard}>
                      <div className={editorStyles.seoScoreRing}>
                        <svg viewBox="0 0 68 68">
                          <circle cx="34" cy="34" r="30" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="4" />
                          <circle cx="34" cy="34" r="30" fill="none" stroke={seoScoreColor} strokeWidth="4" strokeDasharray="188.5" strokeDashoffset={188.5 - seoArcLength} strokeLinecap="round" />
                        </svg>
                        <span className={editorStyles.seoScoreNumber}>{seoScore.total}</span>
                      </div>
                      <div className={editorStyles.seoScoreBreakdown}>
                        {([
                          { label: "Readability", value: seoScore.readability },
                          { label: "Structure", value: seoScore.structure },
                          { label: "Keywords", value: seoScore.keywords },
                          { label: "Meta", value: seoScore.meta },
                        ] as const).map((row) => (
                          <div key={row.label} className={editorStyles.seoScoreRow}>
                            <span className={editorStyles.seoScoreRowLabel}>{row.label}</span>
                            <div className={editorStyles.seoScoreRowTrack}>
                              <div className={editorStyles.seoScoreRowFill} style={{ width: `${row.value}%`, background: row.value >= 70 ? "var(--aa-success)" : row.value >= 40 ? "var(--aa-warning)" : "var(--aa-error)" }} />
                            </div>
                            <span className={editorStyles.seoScoreRowValue}>{row.value}</span>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className={editorStyles.panelSection}>
                      <h3 className={editorStyles.panelSectionTitle}>Title and focus</h3>
                      <label className={styles.label}>
                        Article title
                        <input className={styles.input} value={title} onChange={(e) => setTitle(e.target.value)} disabled={editorLocked} />
                      </label>
                      <label className={styles.label} style={{ marginTop: 10 }}>
                        Focus keyphrase
                        <input className={styles.input} value={focus} onChange={(e) => setFocus(e.target.value)} placeholder="e.g. FM contract handover" disabled={editorLocked} />
                      </label>
                    </div>
                    <div className={editorStyles.panelSection}>
                      <h3 className={editorStyles.panelSectionTitle}>Meta title</h3>
                      <input className={styles.input} value={metaTitle} onChange={(e) => setMetaTitle(clampChars(e.target.value, META_TITLE_MAX))} disabled={editorLocked} />
                      <div className={styles.seoMeterRow} aria-label="Meta title character meter">
                        <div className={styles.seoMeterMeta}>
                          <span className={styles.muted}>{metaTitle.length}/{META_TITLE_MAX}</span>
                          <span className={seoMeter(metaTitle.length, META_TITLE_MAX).state === "excellent" ? styles.seoOk : styles.seoWarn}>{seoMeter(metaTitle.length, META_TITLE_MAX).label}</span>
                        </div>
                        <div className={styles.seoMeterTrack}>
                          <div className={seoMeter(metaTitle.length, META_TITLE_MAX).state === "excellent" ? styles.seoMeterFillOk : styles.seoMeterFillWarn} style={{ width: `${seoMeter(metaTitle.length, META_TITLE_MAX).percent}%` }} />
                        </div>
                      </div>
                    </div>
                    <div className={editorStyles.panelSection}>
                      <h3 className={editorStyles.panelSectionTitle}>Meta description</h3>
                      <input className={styles.input} value={metaDesc} onChange={(e) => setMetaDesc(clampChars(e.target.value, META_DESC_MAX))} disabled={editorLocked} />
                      <div className={styles.seoMeterRow} aria-label="Meta description character meter">
                        <div className={styles.seoMeterMeta}>
                          <span className={styles.muted}>{metaDesc.length}/{META_DESC_MAX}</span>
                          <span className={seoMeter(metaDesc.length, META_DESC_MAX).state === "excellent" ? styles.seoOk : styles.seoWarn}>{seoMeter(metaDesc.length, META_DESC_MAX).label}</span>
                        </div>
                        <div className={styles.seoMeterTrack}>
                          <div className={seoMeter(metaDesc.length, META_DESC_MAX).state === "excellent" ? styles.seoMeterFillOk : styles.seoMeterFillWarn} style={{ width: `${seoMeter(metaDesc.length, META_DESC_MAX).percent}%` }} />
                        </div>
                      </div>
                    </div>
                    <div className={editorStyles.panelSection}>
                      <h3 className={editorStyles.panelSectionTitle}>Targeting keywords</h3>
                      <input className={styles.input} value={keywords} onChange={(e) => setKeywords(e.target.value)} disabled={editorLocked} placeholder="keyword one, keyword two…" />
                      <div className={styles.muted} style={{ fontSize: 11, marginTop: 4 }}>Comma-separated. 5-10 recommended.</div>
                    </div>
                  </>
                )
              ) : null}

              {/* ── Media tab ── */}
              {contextTab === "media" ? (
                <>
                  <div className={editorStyles.panelSection}>
                    <h3 className={editorStyles.panelSectionTitle}>Featured image</h3>
                    <div className={styles.articleImageFrame}>
                      {showFeaturedImageSkeleton ? (
                        <div className={editorStyles.imageSkeleton} aria-live="polite" aria-busy="true">
                          <div className={editorStyles.imageSkeletonShimmer} aria-hidden="true" />
                          <div className={editorStyles.imageSkeletonPulse} aria-hidden="true" />
                          <div className={editorStyles.imageSkeletonBars} aria-hidden="true"><span /><span /><span /></div>
                          <div className={editorStyles.imageSkeletonContent}>
                            <div className={editorStyles.imageSpinner} aria-hidden="true" />
                            <div className={editorStyles.imageGeneratingTitle}>{imageRegenBusy ? (imageGenPhase === "saving" ? "Saving…" : "Generating…") : "Loading…"}</div>
                            <div className={editorStyles.imageGeneratingHint}>{imageRegenBusy ? (imageGenPhase === "saving" ? "Writing to storage." : "30-90 seconds.") : "Retrieving from storage."}</div>
                          </div>
                        </div>
                      ) : generateImage ? (
                        generatedImageUrl ? (
                          <LazyArticleImage src={generatedImageUrl} alt="Generated preview" className={styles.articleImage} />
                        ) : featuredImageLoadFailed ? (
                          <div className={editorStyles.imagePlaceholder}>Could not load saved image. Regenerate to create a new one.</div>
                        ) : (
                          <div className={editorStyles.imagePlaceholder}>Image will be generated with your selected prompt.</div>
                        )
                      ) : uploadedImagePreview ? (
                        <LazyArticleImage src={uploadedImagePreview} alt="Uploaded preview" className={styles.articleImage} />
                      ) : (
                        <div className={editorStyles.imagePlaceholder}>No image selected.</div>
                      )}
                    </div>
                  </div>
                  <div className={editorStyles.panelSection}>
                    <h3 className={editorStyles.panelSectionTitle}>Image options</h3>
                    <label className={styles.label}>
                      Generate image
                      <select className={styles.input} value={generateImage ? "yes" : "no"} onChange={(e) => setGenerateImage(e.target.value === "yes")} disabled={editorLocked}>
                        <option value="yes">Yes</option>
                        <option value="no">No</option>
                      </select>
                    </label>
                    {!generateImage ? (
                      <label className={styles.label} style={{ marginTop: 8 }}>
                        Upload image
                        <input className={styles.input} type="file" accept="image/*" disabled={editorLocked} onChange={(e) => setUploadedImageFile(e.target.files?.[0] || null)} />
                      </label>
                    ) : null}
                    {generateImage ? (
                      <div style={{ marginTop: 10, display: "grid", gap: 6 }}>
                        <div className={editorStyles.imageMeta}>Regenerations: {imageRegenUsed}{imageRegenUnlimited ? " / unlimited" : ` / ${imageRegenLimit}`}</div>
                        <button className={styles.btnSecondary} type="button" onClick={handleFeaturedImageButtonClick} disabled={imageRegenBusy || !canFeaturedImageAction}>
                          {imageRegenBusy ? (hasFeaturedImage ? "Regenerating…" : "Generating…") : (hasFeaturedImage ? "Regenerate image" : "Generate image")}
                        </button>
                        {imageRegenExhausted ? <div className={styles.error} style={{ fontSize: 11 }}>Regeneration limit reached.</div> : null}
                      </div>
                    ) : null}
                  </div>
                </>
              ) : null}

              {/* ── Publish tab ── */}
              {contextTab === "publish" ? (
                <>
                  {isLiveOnWordPress && wpLink ? (
                    <div className={editorStyles.panelSection}>
                      <div className={`${editorStyles.liveUrlBar} ${isWpTrashed ? editorStyles.liveUrlBarTrashed : ""}`}>
                        <span className={editorStyles.liveUrlBarLabel}>{isWpTrashed ? "Trashed" : "Live"}</span>
                        <a href={wpLink} target="_blank" rel="noopener noreferrer" className={editorStyles.liveUrlBarHref} title={wpLink}>{wpLink}</a>
                        <div className={editorStyles.liveUrlBarActions}>
                          <button type="button" className={editorStyles.liveUrlBarBtn} onClick={() => void copyLiveUrl()}>{liveUrlCopied ? "Copied" : "Copy"}</button>
                          <a href={wpLink} target="_blank" rel="noopener noreferrer" className={editorStyles.liveUrlBarBtn}>Open ↗</a>
                          <button type="button" className={editorStyles.liveUrlBarBtn} onClick={() => void syncFromWordPress()} disabled={wpSyncBusy || !websiteConnected}>
                            {wpSyncBusy ? "Syncing…" : "Sync"}
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : null}

                  <div className={editorStyles.panelSection}>
                    <h3 className={editorStyles.panelSectionTitle}>{isShopifyProject ? "Shopify" : "WordPress"}</h3>
                    <p className={editorStyles.wpCardDesc}>
                      {isShopifyProject
                        ? shopifyLink ? "This article is on Shopify." : "Post directly to your Shopify blog."
                        : isScheduledArticle ? "Scheduled. Update available after publish."
                        : showUpdateWordPress ? "Push edits to your live post."
                        : showPublishWordPress ? "Publish when ready."
                        : "Connect WordPress to publish."}
                    </p>
                    <div className={editorStyles.wpActions}>
                      {isShopifyProject ? (
                        <>
                          <button className={styles.button} type="button" onClick={() => void publishToShopify()} disabled={shopifyPublishBusy || !shopifyCanPublish || !shopifyBlogsAvailable}>
                            {shopifyPublishBusy ? "Posting…" : shopifyPublishNow ? "Publish to Shopify" : "Save Shopify draft"}
                          </button>
                          <button className={styles.btnSecondary} type="button" onClick={copyArticleMarkdown} disabled={!body.trim()}>Copy markdown</button>
                        </>
                      ) : (
                        <>
                          {showUpdateWordPress ? (
                            <button className={styles.button} type="button" onClick={() => void updateWordPressPost()} disabled={!canUpdateWordPress}>{wpUpdateBusy ? "Updating…" : "Update article"}</button>
                          ) : showPublishWordPress ? (
                            <button className={styles.button} type="button" onClick={publishToLiveSite} disabled={!canPublish || wpPushBusy}>{wpPublishBusy ? "Publishing…" : "Publish article"}</button>
                          ) : null}
                        </>
                      )}
                    </div>
                  </div>

                  {isShopifyProject ? (
                    <div className={editorStyles.panelSection}>
                      <h3 className={editorStyles.panelSectionTitle}>Shopify settings</h3>
                      <div className={styles.muted} style={{ fontSize: 11, marginBottom: 8 }}>
                        Store: <strong>{(projectSettings?.shopify_shop || shopifyStatus?.shop || "Not set").toString()}</strong> · <strong>{websiteConnected ? "Connected" : "Not connected"}</strong>
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                        <label className={styles.label}>
                          Blog
                          <select className={styles.input} value={shopifyBlogId == null ? "" : String(shopifyBlogId)} onChange={(e) => setShopifyBlogId(e.target.value ? Number(e.target.value) : null)} disabled={!shopifyBlogsAvailable}>
                            <option value="">Select…</option>
                            {(shopifyCatalog?.blogs || []).map((b) => (<option key={String(b?.id)} value={String(b?.id || "")}>{formatShopifyBlogOptionLabel(b)}</option>))}
                          </select>
                        </label>
                        <label className={styles.label}>
                          Status
                          <select className={styles.input} value={shopifyPublishNow ? "publish" : "draft"} onChange={(e) => setShopifyPublishNow(e.target.value === "publish")}>
                            <option value="draft">Draft</option>
                            <option value="publish">Published</option>
                          </select>
                        </label>
                      </div>
                      {!shopifyBlogsAvailable ? (
                        <button type="button" className={styles.btnSecondary} style={{ marginTop: 8 }} onClick={() => void syncShopifyCatalogFromEditor()} disabled={shopifyCatalogSyncing || !websiteConnected}>
                          {shopifyCatalogSyncing ? "Syncing…" : "Sync blogs"}
                        </button>
                      ) : null}
                    </div>
                  ) : (
                    <div className={editorStyles.panelSection}>
                      <h3 className={editorStyles.panelSectionTitle}>WordPress settings</h3>
                      {wpMetaLoading && !wpPostTypes.length && !wpCategories.length ? (
                        <div className={editorStyles.wpMetaLoading}><div className={editorStyles.imageSpinner} aria-hidden="true" /><span>Loading…</span></div>
                      ) : wpMetaError && !wpPostTypes.length && !wpCategories.length ? (
                        <div style={{ display: "grid", gap: 6 }}>
                          <div className={styles.error} style={{ fontSize: 11 }}>{wpMetaError}</div>
                          <button className={styles.btnSecondary} type="button" onClick={() => void ensureWpMetaLoaded({ force: true })} disabled={wpMetaLoading}>Retry</button>
                        </div>
                      ) : wpPostTypes.length || wpCategories.length ? (
                        <>
                          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                            <label className={styles.label}>
                              Post type
                              <select className={styles.input} value={wpPostType} onChange={(e) => setWpPostType(e.target.value)} disabled={editorLocked}>
                                <option value="posts">Posts</option>
                                {wpPostTypes.filter((t) => t.rest_base && t.rest_base !== "posts").map((t) => (<option key={t.rest_base} value={t.rest_base}>{t.name || t.rest_base}</option>))}
                              </select>
                            </label>
                            <label className={styles.label}>
                              Status
                              <select className={styles.input} value={wpStatus} onChange={(e) => setWpStatus(e.target.value as "draft" | "publish")} disabled={editorLocked}>
                                <option value="draft">Draft</option>
                                <option value="publish">Publish</option>
                              </select>
                            </label>
                          </div>
                          <label className={styles.label} style={{ marginTop: 8 }}>
                            Categories
                            <select className={styles.input} multiple value={wpCategoryIds.map(String)} onChange={(e) => { const ids = Array.from(e.target.selectedOptions).map((o) => Number(o.value)).filter((n) => Number.isFinite(n)); setWpCategoryIds(ids); }} style={{ minHeight: 72 }} disabled={editorLocked}>
                              {wpCategories.map((c) => (<option key={c.id} value={c.id}>{c.name}</option>))}
                            </select>
                          </label>
                        </>
                      ) : (
                        <div className={styles.muted} style={{ fontSize: 11 }}>Using project defaults.</div>
                      )}
                    </div>
                  )}
                </>
              ) : null}

              {/* ── AI tab ── */}
              {contextTab === "ai" ? (
                contentLoading ? <ArticleEditorSkeleton /> : (
                  <>
                    <div className={editorStyles.panelSection}>
                      <h3 className={editorStyles.panelSectionTitle}>AI copilot</h3>
                      <div className={editorStyles.aiActionGrid}>
                        {([
                          { icon: "✦", label: "Generate article", action: () => void generate(), disabled: editorLocked },
                          { icon: "↻", label: hasGeneratedContent ? "Regenerate" : "Generate", action: () => void generate(), disabled: editorLocked },
                          { icon: "⊕", label: "Expand topic", action: () => void generate(), disabled: editorLocked || !hasGeneratedContent },
                          { icon: "✎", label: "Rewrite heading", action: () => void generate(), disabled: editorLocked || !hasGeneratedContent },
                          { icon: "☰", label: "Generate FAQ", action: () => void generate(), disabled: editorLocked || !hasGeneratedContent },
                          { icon: "⟡", label: "Add examples", action: () => void generate(), disabled: editorLocked || !hasGeneratedContent },
                        ]).map((cmd) => (
                          <button key={cmd.label} type="button" className={editorStyles.aiActionBtn} onClick={cmd.action} disabled={cmd.disabled}>
                            <span className={editorStyles.aiActionIcon}>{cmd.icon}</span>
                            {cmd.label}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className={editorStyles.panelSection}>
                      <h3 className={editorStyles.panelSectionTitle}>Prompt configuration</h3>
                      {!editorLocked && !writingPrompts && !imagePrompts ? (
                        <button className={styles.btnSecondary} type="button" onClick={ensurePromptsLoaded} disabled={promptsLoading} style={{ width: "100%" }}>
                          {promptsLoading ? "Loading…" : "Load prompts"}
                        </button>
                      ) : (
                        <>
                          <label className={styles.label}>
                            Writing prompt
                            <select className={styles.input} value={writingPromptId} onChange={(e) => setWritingPromptId(e.target.value)} disabled={editorLocked}>
                              <option value="">Project default</option>
                              {(writingPrompts?.items || []).map((p) => (<option key={p.id} value={p.id}>{p.name}</option>))}
                            </select>
                          </label>
                          <label className={styles.label}>
                            Image prompt
                            <select className={styles.input} value={imagePromptId} onChange={(e) => setImagePromptId(e.target.value)} disabled={editorLocked}>
                              <option value="">Project default</option>
                              {(imagePrompts?.items || []).map((p) => (<option key={p.id} value={p.id}>{p.name}</option>))}
                            </select>
                          </label>
                        </>
                      )}
                    </div>
                    <div className={editorStyles.panelSection}>
                      <div className={editorStyles.fieldActions} style={{ borderTop: "none", paddingTop: 0, marginTop: 0 }}>
                        <button className={styles.button} type="button" onClick={() => void generate()} disabled={editorLocked}>
                          {hasGeneratedContent ? "Regenerate article" : "Generate article"}
                        </button>
                        <button className={styles.btnSecondary} type="button" onClick={save} disabled={editorLocked}>Save</button>
                      </div>
                    </div>
                  </>
                )
              ) : null}

              {/* ── Settings tab ── */}
              {contextTab === "settings" ? (
                <>
                  <div className={editorStyles.panelSection}>
                    <h3 className={editorStyles.panelSectionTitle}>URL and identity</h3>
                    <div className={editorStyles.settingsField}>
                      <span className={editorStyles.settingsFieldLabel}>Slug</span>
                      <input className={editorStyles.settingsInput} value={articleSlug} disabled readOnly />
                    </div>
                    <div className={editorStyles.settingsField}>
                      <span className={editorStyles.settingsFieldLabel}>Canonical URL</span>
                      <input className={editorStyles.settingsInput} value={canonicalUrl} disabled readOnly />
                    </div>
                  </div>
                  <div className={editorStyles.panelSection}>
                    <h3 className={editorStyles.panelSectionTitle}>Schema and indexing</h3>
                    <div className={editorStyles.settingsField}>
                      <span className={editorStyles.settingsFieldLabel}>Schema type</span>
                      <select className={editorStyles.settingsInput} disabled defaultValue="Article">
                        <option>Article</option>
                        <option>BlogPosting</option>
                        <option>HowTo</option>
                        <option>FAQPage</option>
                      </select>
                    </div>
                    <div className={editorStyles.settingsToggle}>
                      <span className={editorStyles.settingsFieldLabel}>Open Graph tags</span>
                      <div className={`${editorStyles.settingsToggleTrack} ${editorStyles.settingsToggleTrackOn}`}>
                        <div className={editorStyles.settingsToggleThumb} />
                      </div>
                    </div>
                    <div className={editorStyles.settingsToggle}>
                      <span className={editorStyles.settingsFieldLabel}>Index / Follow</span>
                      <div className={`${editorStyles.settingsToggleTrack} ${editorStyles.settingsToggleTrackOn}`}>
                        <div className={editorStyles.settingsToggleThumb} />
                      </div>
                    </div>
                    <div className={editorStyles.settingsToggle}>
                      <span className={editorStyles.settingsFieldLabel}>Twitter card</span>
                      <div className={`${editorStyles.settingsToggleTrack} ${editorStyles.settingsToggleTrackOn}`}>
                        <div className={editorStyles.settingsToggleThumb} />
                      </div>
                    </div>
                  </div>
                </>
              ) : null}

            </div>
          </div>
        </div>

        {notice ? (
          <div className={editorStyles.toast} role="status" aria-live="polite">
            <div className={editorStyles.toastInner}>
              <span className={editorStyles.toastText}>{noticeWithoutUrl(notice)}</span>
              <button type="button" className={editorStyles.toastClose} aria-label="Dismiss" onClick={() => setNotice(null)}>×</button>
            </div>
          </div>
        ) : null}
      </main>
    </div>
  );
}

