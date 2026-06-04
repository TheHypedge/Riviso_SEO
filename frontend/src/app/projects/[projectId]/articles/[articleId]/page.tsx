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
import { ArticleEditorIntegritySkeleton, ArticleEditorSkeleton } from "@/components/ArticleEditorSkeleton";
import { ArticleIntegrityBody } from "@/components/ArticleIntegrityBody";
import { IntegrityHumanizeCompare } from "@/components/IntegrityHumanizeCompare";
import { ArticleReadonlyBody } from "@/components/ArticleReadonlyBody";
import { LazyArticleImage } from "@/components/LazyArticleImage";
import { auditMarkdown, type IntegrityFlag, type IntegritySignal } from "@/lib/rivisoLinguistics";
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

function clampPct(n: number) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

function IntegrityRing({ value, label }: { value: number; label: string }) {
  const pct = clampPct(value);
  const r = 18;
  const c = 2 * Math.PI * r;
  const dash = (pct / 100) * c;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <svg width="44" height="44" viewBox="0 0 44 44" aria-label={label}>
        <circle cx="22" cy="22" r={r} fill="none" stroke="rgba(255,255,255,0.10)" strokeWidth="4" />
        <circle
          cx="22"
          cy="22"
          r={r}
          fill="none"
          stroke="rgba(217,119,87,0.95)"
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray={`${dash} ${c - dash}`}
          transform="rotate(-90 22 22)"
        />
      </svg>
      <div style={{ display: "grid", gap: 2 }}>
        <div
          style={{
            fontSize: 12,
            fontWeight: 800,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "rgba(255,255,255,0.62)",
          }}
        >
          {label}
        </div>
        <div style={{ fontSize: 16, fontWeight: 800, color: "rgba(255,255,255,0.94)" }}>{Math.round(pct)}%</div>
      </div>
    </div>
  );
}

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

function statusPillClass(status: string): string {
  const s = (status || "").trim().toLowerCase();
  if (s === "published") return editorStyles.statusPublished;
  if (s === "draft") return editorStyles.statusDraft;
  if (s === "pending" || s === "scheduled") return editorStyles.statusPending;
  return editorStyles.statusNeutral;
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

  // Integrity dashboard
  const [integrityLoading, setIntegrityLoading] = useState(false);
  const [aiPct, setAiPct] = useState<number>(0);
  const [flaggedParagraphs, setFlaggedParagraphs] = useState<IntegrityFlag[]>([]);
  const [highlightAi, setHighlightAi] = useState(false);
  const [humanizeBusy, setHumanizeBusy] = useState(false);
  const [showIntegrityModal, setShowIntegrityModal] = useState(false);
  const [integrityOriginal, setIntegrityOriginal] = useState("");
  const [integrityHumanized, setIntegrityHumanized] = useState("");
  const [integrityRewritten, setIntegrityRewritten] = useState<
    { index: number; before: string; after: string }[]
  >([]);
  const [integrityAiBefore, setIntegrityAiBefore] = useState<number | null>(null);
  const [integrityAiAfter, setIntegrityAiAfter] = useState<number | null>(null);
  const [editorRevision, setEditorRevision] = useState(0);

  const flaggedIndices = useMemo(() => flaggedParagraphs.map((p) => p.index), [flaggedParagraphs]);
  const canHumanize = body.trim().length >= 40;
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

  const applyIntegrityResult = useCallback(
    (res: { ai_percentage: number; flagged_paragraphs?: IntegrityFlag[] }, opts?: { autoHighlight?: boolean }) => {
      setAiPct(clampPct(res.ai_percentage));
      const flags = (res.flagged_paragraphs || []) as IntegrityFlag[];
      setFlaggedParagraphs(flags);
      if (opts?.autoHighlight !== false && flags.length) setHighlightAi(true);
    },
    [],
  );

  useEffect(() => {
    const md = body.trim();
    if (!md) {
      setAiPct(0);
      setFlaggedParagraphs([]);
      return;
    }
    const timer = window.setTimeout(() => {
      applyIntegrityResult(auditMarkdown(md), { autoHighlight: false });
    }, 450);
    return () => window.clearTimeout(timer);
  }, [body, applyIntegrityResult]);

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
      if (hasUnsavedChanges) {
        setPendingLeaveHref(href);
        setLeaveConfirmOpen(true);
        return;
      }
      router.push(href);
    },
    [hasUnsavedChanges, router],
  );

  useEffect(() => {
    if (!hasUnsavedChanges) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [hasUnsavedChanges]);

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

  const applyStoredIntegrity = useCallback(
    (a: ArticleDetail) => {
      const storedPct = a.integrity_ai_percentage;
      const storedFlags = a.integrity_flagged_paragraphs;
      if (storedPct != null && Array.isArray(storedFlags) && storedFlags.length) {
        applyIntegrityResult(
          { ai_percentage: Number(storedPct), flagged_paragraphs: storedFlags as IntegrityFlag[] },
          { autoHighlight: true },
        );
        return;
      }
      setAiPct(0);
      setFlaggedParagraphs([]);
    },
    [applyIntegrityResult],
  );

  const scheduleIntegrityAudit = useCallback(
    (articleMd: string, a?: ArticleDetail | null) => {
      const md = articleMd.trim();
      if (!md) {
        setAiPct(0);
        setFlaggedParagraphs([]);
        return;
      }
      const run = () => {
        applyIntegrityResult(auditMarkdown(md), { autoHighlight: false });
        if (a) applyStoredIntegrity(a);
      };
      const w = window as unknown as {
        requestIdleCallback?: (cb: () => void, opts?: { timeout?: number }) => number;
      };
      if (typeof w.requestIdleCallback === "function") {
        w.requestIdleCallback(run, { timeout: 2500 });
      } else {
        window.setTimeout(run, 0);
      }
    },
    [applyIntegrityResult, applyStoredIntegrity],
  );

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
      applyStoredIntegrity(a);
    },
    [applyStoredIntegrity, params.projectId, params.articleId],
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
      scheduleIntegrityAudit(bodyText, shell);
    },
    [scheduleIntegrityAudit],
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

  // Auto-load WordPress post types + categories in the background (no manual click required).
  useEffect(() => {
    if (!token || !needsWpMeta || !article?.id) return;
    if (wpPostTypes.length || wpCategories.length) return;
    void ensureWpMetaLoaded();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, needsWpMeta, article?.id, params.projectId, wpPostTypes.length, wpCategories.length]);

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

  async function startGenerateFlow(opts?: { regenerate?: boolean }) {
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
      setShowRegenConfirm(true);
      return;
    }
    startGenerateFlow();
  }

  async function doGenerate(
    mappedProductsOverride?: MappedShopifyProduct[],
    mappedPagesOverride?: MappedWordPressPage[],
    opts?: { regenerate?: boolean; skipPlatformMapping?: boolean },
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
              generate_image: generateImage,
              mapped_products: isShopifyProject ? pickedProducts : undefined,
              mapped_pages: isWordPressProject ? pickedPages : undefined,
            },
            {
              previousGeneratedAt: article?.generated_at ?? null,
              expectImage: generateImage,
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
      setError("Enable “Generate image” (Yes) to create a featured image.");
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
      setError("Enable “Generate image” (Yes) to create a featured image.");
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

  async function runHumanization() {
    if (!body.trim()) return;
    setHumanizeBusy(true);
    setError(null);
    setNotice(null);
    try {
      await runWithArticlePipelineMonitor(
        params.projectId,
        params.articleId,
        async () => {
          const res = await api.humanizeArticleIntegrity(params.projectId, params.articleId, body, {
            timeoutMs: 120_000,
            skipGlobalLoading: true,
          });
          setIntegrityOriginal(res.original_markdown || body);
          setIntegrityHumanized(res.humanized_markdown || body);
          setIntegrityRewritten(res.rewritten || []);
          setIntegrityAiBefore(res.before?.ai_percentage ?? null);
          setIntegrityAiAfter(res.after?.ai_percentage ?? null);
          if (res.after) applyIntegrityResult(res.after);
          setHighlightAi(true);
          setShowIntegrityModal(true);
        },
        { initialMessage: "Running structural humanization — connecting to live pipeline stream…" },
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Humanization failed");
    } finally {
      setHumanizeBusy(false);
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

  return (
    <div className={`${styles.page} ${styles.pageTop} ${projectsDark.projectsDark}`}>
      <main className={`${styles.main} ${styles.mainWide}`}>
        <section className={`${styles.contentCol} ${editorStyles.pageShell}`}>
          <header className={editorStyles.pageHeader}>
            <div className={editorStyles.pageHeaderTop}>
              <div className={editorStyles.pageTitleBlock}>
                <p className={editorStyles.pageEyebrow}>Article editor</p>
                <h1 className={editorStyles.pageTitle}>{displayTitle}</h1>
                <button
                  type="button"
                  className={editorStyles.backLink}
                  onClick={() => requestNavigation(`/projects/${params.projectId}`)}
                >
                  ← Back to project
                </button>
              </div>
            </div>

            <div className={editorStyles.metaBar} aria-label="Article status">
              <span className={`${editorStyles.statusPill} ${statusPillClass(article?.status || "")}`}>
                {article?.status ? article.status.charAt(0).toUpperCase() + article.status.slice(1) : "…"}
              </span>
              {article?.posted_at ? (
                <span className={`${editorStyles.statusPill} ${editorStyles.statusNeutral}`}>
                  Posted {article.posted_at}
                </span>
              ) : null}
              {article?.wp_scheduled_at ? (
                <span className={`${editorStyles.statusPill} ${editorStyles.statusPending}`}>
                  Scheduled {article.wp_scheduled_at}
                </span>
              ) : null}
              {isLiveOnWordPress ? (
                <span className={`${editorStyles.statusPill} ${editorStyles.statusWp}`}>
                  {wpPostId ? `WordPress #${wpPostId}` : "Live on WordPress"}
                </span>
              ) : null}
              {isLiveOnWordPress && wpLastStatus && wpLastStatus !== "publish" ? (
                <span
                  className={`${editorStyles.statusPill} ${isWpTrashed ? editorStyles.statusTrash : editorStyles.statusNeutral}`}
                >
                  {formatWordPressRestStatus(article?.wp_last_wp_status)}
                </span>
              ) : null}
              {showUpdateWordPress && hasPendingWpChanges ? (
                <span className={`${editorStyles.statusPill} ${editorStyles.statusWarn}`}>Unsynced changes</span>
              ) : null}
              {isLiveOnWordPress && article?.wp_synced_at ? (
                <span className={`${editorStyles.statusPill} ${editorStyles.statusNeutral}`}>
                  Synced {article.wp_synced_at}
                </span>
              ) : null}
            </div>

            {isLiveOnWordPress && wpLink ? (
              <div
                className={`${editorStyles.liveUrlCard} ${isWpTrashed ? editorStyles.liveUrlCardTrashed : ""}`}
              >
                <span className={editorStyles.liveUrlLabel}>
                  {isWpTrashed ? "WordPress URL" : "Live URL"}
                </span>
                <a href={wpLink} target="_blank" rel="noopener noreferrer" className={editorStyles.liveUrlLink}>
                  {wpLink}
                </a>
                <div className={editorStyles.liveUrlActions}>
                  <button type="button" className={editorStyles.liveUrlBtn} onClick={() => void copyLiveUrl()}>
                    {liveUrlCopied ? "Copied" : "Copy link"}
                  </button>
                  <a
                    href={wpLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={editorStyles.liveUrlBtn}
                    style={{ textDecoration: "none", textAlign: "center" }}
                  >
                    Open live
                  </a>
                  <button
                    type="button"
                    className={editorStyles.liveUrlBtn}
                    onClick={() => void syncFromWordPress()}
                    disabled={wpSyncBusy || !websiteConnected}
                    title="Pull the latest title, body, SEO, and permalink from WordPress"
                  >
                    {wpSyncBusy ? "Syncing…" : "Sync from WordPress"}
                  </button>
                </div>
                {isWpTrashed ? (
                  <p className={editorStyles.liveUrlHint}>
                    This post is in the WordPress trash. Sync to refresh Riviso, or restore it in WordPress admin.
                  </p>
                ) : (
                  <p className={editorStyles.liveUrlHint}>
                    Changes made in WordPress are pulled here automatically when you open this article, or use Sync
                    from WordPress.
                  </p>
                )}
              </div>
            ) : null}
          </header>

          <div className={editorStyles.bannerStack}>
          {error ? (
            <div className={`${editorStyles.banner} ${editorStyles.bannerError}`} role="alert">
              <p className={styles.error} style={{ margin: 0 }}>
                {error}
              </p>
              <div className={editorStyles.bannerActions}>
                <button
                  type="button"
                  className={styles.button}
                  onClick={() => requestNavigation(`/projects/${params.projectId}?tab=articles`)}
                >
                  Back to articles
                </button>
                {errorCanRetry ? (
                  <button
                    type="button"
                    className={styles.btnSecondary}
                    onClick={() => setLoadAttempt((n) => n + 1)}
                  >
                    Retry
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
          {notice ? (
            <div className={`${editorStyles.banner} ${editorStyles.bannerSuccess}`} role="status">
              <p style={{ margin: 0, lineHeight: 1.55, color: "var(--aa-body-strong)" }}>
                {noticeWithoutUrl(notice)}
              </p>
            </div>
          ) : null}
          </div>

        {productMapBeforeGenerateOpen ? (
          <div
            className={styles.modalBackdrop}
            role="dialog"
            aria-modal="true"
            aria-label={isShopifyProject ? "Map products before generation" : "Map pages before generation"}
          >
            <div className={styles.modalPanel}>
              <div className={styles.modalHead}>
                <h3 className={styles.modalTitle}>
                  {hasGeneratedContent
                    ? isShopifyProject
                      ? "Map products before regenerate"
                      : "Map pages before regenerate"
                    : isShopifyProject
                      ? "Map products for this article"
                      : "Map site pages for this article"}
                </h3>
                <button
                  type="button"
                  className={styles.iconButton}
                  aria-label="Close"
                  onClick={() => setProductMapBeforeGenerateOpen(false)}
                >
                  ×
                </button>
              </div>
              <div className={styles.modalBody}>
                {isWordPressProject && isClusterArticle && clusterLinkContext ? (
                  <div
                    style={{
                      marginBottom: 12,
                      padding: "10px 12px",
                      borderRadius: 10,
                      border: "1px solid rgba(255,255,255,0.10)",
                      background: "rgba(255,255,255,0.03)",
                      fontSize: 12,
                      lineHeight: 1.55,
                    }}
                  >
                    <div style={{ fontWeight: 800, color: "rgba(255,255,255,0.92)", marginBottom: 6 }}>
                      Topic cluster · {clusterRoleLabel} article
                    </div>
                    {clusterLinkContext.auto_link_ready ? (
                      <p className={styles.muted} style={{ margin: 0 }}>
                        {clusterLinkContext.live_sibling_count} related article
                        {clusterLinkContext.live_sibling_count === 1 ? "" : "s"} already live on WordPress — Riviso
                        will link them automatically when you generate.
                      </p>
                    ) : (
                      <p className={styles.muted} style={{ margin: 0 }}>
                        Related cluster articles are not live on WordPress yet. Map published pages below, or skip to
                        generate without internal links until siblings are published.
                      </p>
                    )}
                    {clusterLinkContext.siblings.length ? (
                      <ul style={{ margin: "8px 0 0", paddingLeft: 18 }}>
                        {clusterLinkContext.siblings.map((s) => (
                          <li key={s.slot_id} style={{ marginBottom: 4 }}>
                            <span style={{ fontWeight: 700 }}>{s.title || "Untitled"}</span>
                            {" — "}
                            {s.is_live ? (
                              <span style={{ color: "rgba(120,200,140,0.95)" }}>Live</span>
                            ) : (
                              <span style={{ color: "rgba(255,180,120,0.95)" }}>Not live</span>
                            )}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                ) : null}
                {isShopifyProject ? (
                  <ShopifyProductMapPicker
                    products={shopifyCatalog?.products || []}
                    value={mappedProductsForGenerate}
                    onChange={setMappedProductsForGenerate}
                    loading={shopifyCatalogLoading}
                    grantedScopes={shopifyCatalog?.granted_scopes || []}
                  />
                ) : (
                  <WordPressPageMapPicker
                    entries={siteMapEntries || []}
                    value={mappedPagesForGenerate}
                    onChange={setMappedPagesForGenerate}
                    loading={siteMapLoading}
                    internalLinkAwareEnabled={wpInternalLinkAware}
                  />
                )}
              </div>
              <div className={styles.modalFooter}>
                <button
                  type="button"
                  className={styles.btnSecondary}
                  onClick={() => setProductMapBeforeGenerateOpen(false)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className={styles.btnSecondary}
                  onClick={() => {
                    setProductMapBeforeGenerateOpen(false);
                    void doGenerate(undefined, undefined, {
                      regenerate: hasGeneratedContent,
                      skipPlatformMapping: true,
                    });
                  }}
                >
                  Skip — {hasGeneratedContent ? "regenerate" : "generate"}{" "}
                  {isShopifyProject ? "without products" : "without mapped pages"}
                </button>
                <button
                  type="button"
                  className={styles.button}
                  disabled={isShopifyProject ? !mappedProductsForGenerate.length : !mappedPagesForGenerate.length}
                  onClick={() => {
                    if (isShopifyProject) {
                      const picked = [...mappedProductsForGenerate];
                      setProductMapBeforeGenerateOpen(false);
                      void doGenerate(picked, undefined, { regenerate: hasGeneratedContent });
                    } else {
                      const picked = [...mappedPagesForGenerate];
                      setProductMapBeforeGenerateOpen(false);
                      void doGenerate(undefined, picked, { regenerate: hasGeneratedContent });
                    }
                  }}
                >
                  {hasGeneratedContent ? "Regenerate" : "Generate"} with mapped{" "}
                  {isShopifyProject ? "products" : "pages"}
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {showRegenConfirm ? (
          <div className={styles.modalBackdrop} role="dialog" aria-modal="true" aria-label="Regenerate article">
            <div className={styles.modalPanel}>
              <div className={styles.modalHead}>
                <div className={styles.modalTitle}>Regenerate article?</div>
              </div>
              <div className={styles.modalBody}>
                <p style={{ margin: "0 0 16px", lineHeight: 1.55 }}>
                  This runs a fresh generation using your selected prompts. The current article body and meta will be replaced.{" "}
                  <strong>Save anything you need before continuing.</strong>
                </p>
                <label className={styles.label}>
                  Writing prompt
                  <select
                    className={styles.input}
                    value={writingPromptId}
                    onChange={(e) => setWritingPromptId(e.target.value)}
                  >
                    <option value="">Project default</option>
                    {(writingPrompts?.items || []).map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </label>
                <label className={styles.label}>
                  Image prompt
                  <select
                    className={styles.input}
                    value={imagePromptId}
                    onChange={(e) => setImagePromptId(e.target.value)}
                    disabled={!generateImage}
                  >
                    <option value="">Project default</option>
                    {(imagePrompts?.items || []).map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </label>

                {/* Featured image choice — prominent Yes/No */}
                <div style={{ marginTop: 14 }}>
                  <p style={{ fontSize: 13, fontWeight: 700, marginBottom: 10 }}>
                    Regenerate the Featured Image?
                  </p>
                  <div style={{ display: "flex", gap: 10 }}>
                    <button
                      type="button"
                      onClick={() => setGenerateImage(true)}
                      style={{
                        flex: 1, padding: "10px 0", borderRadius: 8, fontSize: 13,
                        cursor: "pointer", fontWeight: generateImage ? 700 : 400,
                        border: generateImage
                          ? "1.5px solid var(--aa-accent, #d97757)"
                          : "1px solid rgba(255,255,255,0.15)",
                        background: generateImage
                          ? "color-mix(in oklab, var(--aa-accent, #d97757) 14%, transparent)"
                          : "transparent",
                        color: "inherit",
                      }}
                    >
                      Yes — regenerate image
                    </button>
                    <button
                      type="button"
                      onClick={() => setGenerateImage(false)}
                      style={{
                        flex: 1, padding: "10px 0", borderRadius: 8, fontSize: 13,
                        cursor: "pointer", fontWeight: !generateImage ? 700 : 400,
                        border: !generateImage
                          ? "1.5px solid var(--aa-accent, #d97757)"
                          : "1px solid rgba(255,255,255,0.15)",
                        background: !generateImage
                          ? "color-mix(in oklab, var(--aa-accent, #d97757) 14%, transparent)"
                          : "transparent",
                        color: "inherit",
                      }}
                    >
                      No — keep existing image
                    </button>
                  </div>
                  {!generateImage && (
                    <p className={styles.muted} style={{ fontSize: 11, marginTop: 6 }}>
                      Your current featured image will not be changed.
                    </p>
                  )}
                </div>
              </div>
              <div className={styles.modalFooter}>
                <button className={styles.btnSecondary} type="button" onClick={() => setShowRegenConfirm(false)}>
                  Cancel
                </button>
                <button
                  className={styles.button}
                  type="button"
                  onClick={() => {
                    setShowRegenConfirm(false);
                    startGenerateFlow({ regenerate: true });
                  }}
                >
                  Regenerate
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {showWpSyncConfirm ? (
          <div className={styles.modalBackdrop} role="dialog" aria-modal="true" aria-label="Sync from WordPress">
            <div className={styles.modalPanel}>
              <div className={styles.modalHead}>
                <div className={styles.modalTitle}>Sync from WordPress?</div>
              </div>
              <div className={styles.modalBody}>
                <p style={{ margin: 0, lineHeight: 1.55 }}>
                  You have unsaved edits in Riviso. Syncing will replace the title, body, SEO fields, and live URL with
                  the current version on WordPress.
                </p>
              </div>
              <div className={styles.modalFooter}>
                <button className={styles.btnSecondary} type="button" onClick={() => setShowWpSyncConfirm(false)}>
                  Cancel
                </button>
                <button
                  className={styles.button}
                  type="button"
                  onClick={() => {
                    setShowWpSyncConfirm(false);
                    void syncFromWordPress({ force: true });
                  }}
                >
                  Sync and overwrite
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {showIntegrityModal ? (
          <div className={styles.modalBackdrop} role="dialog" aria-modal="true" aria-label="Integrity comparison">
            <div className={styles.modalPanel} style={{ maxWidth: 1100, width: "min(96vw, 1100px)" }}>
              <div className={styles.modalHead}>
                <h3 className={styles.modalTitle}>Review humanized changes</h3>
                <button type="button" className={styles.iconButton} aria-label="Close" onClick={() => setShowIntegrityModal(false)}>
                  ×
                </button>
              </div>
              <div className={styles.modalBody}>
                <p className={styles.muted} style={{ margin: "0 0 12px", fontSize: 13, lineHeight: 1.5 }}>
                  Green highlights show rewritten text. Click <strong>Apply to editor</strong> before copying the full
                  article so every paragraph is updated—not only the flagged sections.
                </p>
                <IntegrityHumanizeCompare
                  original={integrityOriginal || body}
                  humanized={integrityHumanized || body}
                  rewritten={integrityRewritten}
                  aiBefore={integrityAiBefore}
                  aiAfter={integrityAiAfter}
                />
              </div>
              <div className={styles.modalFooter}>
                <button className={styles.btnSecondary} type="button" onClick={() => setShowIntegrityModal(false)}>
                  Cancel
                </button>
                <button
                  className={styles.button}
                  type="button"
                  disabled={!integrityHumanized?.trim()}
                  onClick={() => {
                    const next = (integrityHumanized || "").trim();
                    if (!next) return;
                    setHighlightAi(false);
                    setBody(next);
                    setEditorRevision((k) => k + 1);
                    applyIntegrityResult(auditMarkdown(next), { autoHighlight: false });
                    setShowIntegrityModal(false);
                    setNotice("Humanized article applied to the editor.");
                    void api
                      .updateArticle(
                        params.projectId,
                        params.articleId,
                        {
                          title,
                          keywords: kwFromString(keywords),
                          focus_keyphrase: focus,
                          article: next,
                          meta_title: metaTitle,
                          meta_description: metaDesc,
                        },
                        { skipGlobalLoading: true, timeoutMs: 30_000 },
                      )
                      .then((updated) => {
                        setArticle(updated);
                        setEditorBaseline(
                          baselineFromFields({
                            title,
                            keywords,
                            focus,
                            body: next,
                            metaTitle,
                            metaDesc,
                            imageUrl: generatedImageUrl,
                          }),
                        );
                      })
                      .catch((e) => {
                        setEditorBaseline((prev) => (prev ? { ...prev, body: next } : prev));
                        if (e instanceof Error) setError(e.message);
                      });
                  }}
                >
                  Apply to editor
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {showImageRegenModal ? (
          <div className={styles.modalBackdrop} role="dialog" aria-modal="true" aria-label="Regenerate featured image">
            <div className={styles.modalPanel} style={{ maxWidth: 520 }}>
              <div className={styles.modalHead}>
                <h3 className={styles.modalTitle}>
                  {hasFeaturedImage ? "Regenerate featured image" : "Generate featured image"}
                </h3>
                <button
                  type="button"
                  className={styles.iconButton}
                  aria-label="Close"
                  disabled={imageRegenBusy}
                  onClick={() => setShowImageRegenModal(false)}
                >
                  ×
                </button>
              </div>
              <div className={styles.modalBody} style={{ display: "grid", gap: 14 }}>
                {imageRegenBusy ? (
                  <div className={editorStyles.imageGenerating} style={{ minHeight: 120 }}>
                    <div className={editorStyles.imageSpinner} aria-hidden="true" />
                    <div className={editorStyles.imageGeneratingTitle}>
                      {imageGenPhase === "saving" ? "Saving featured image…" : "Generating with OpenAI…"}
                    </div>
                    <div className={editorStyles.imageGeneratingHint}>
                      {imageGenPhase === "saving"
                        ? "Writing to storage."
                        : "This usually takes 30–90 seconds. Please keep this tab open."}
                    </div>
                  </div>
                ) : (
                  <>
                <p className={styles.muted} style={{ margin: 0, fontSize: 13, lineHeight: 1.5 }}>
                  Choose a saved image prompt or enter a one-time custom prompt. If no saved prompt is selected, Riviso
                  uses your brand/niche defaults. Custom prompts are not saved to your project prompt list.
                </p>
                <label className={styles.label} style={{ display: "flex", gap: 8, alignItems: "center", margin: 0 }}>
                  <input
                    type="radio"
                    name="regen-prompt-source"
                    checked={regenPromptSource === "saved"}
                    onChange={() => setRegenPromptSource("saved")}
                  />
                  Use saved image prompt
                </label>
                {regenPromptSource === "saved" ? (
                  <select
                    className={styles.input}
                    value={regenPromptId}
                    onChange={(e) => setRegenPromptId(e.target.value)}
                  >
                    <option value="">Default (brand + niche)</option>
                    {(imagePrompts?.items || []).map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name || p.id}
                      </option>
                    ))}
                  </select>
                ) : null}
                <label className={styles.label} style={{ display: "flex", gap: 8, alignItems: "center", margin: 0 }}>
                  <input
                    type="radio"
                    name="regen-prompt-source"
                    checked={regenPromptSource === "custom"}
                    onChange={() => setRegenPromptSource("custom")}
                  />
                  Add custom prompt for regeneration
                </label>
                {regenPromptSource === "custom" ? (
                  <textarea
                    className={styles.input}
                    rows={5}
                    value={regenCustomPrompt}
                    onChange={(e) => setRegenCustomPrompt(e.target.value)}
                    placeholder="Describe the image you want for this article only…"
                  />
                ) : null}
                  </>
                )}
              </div>
              <div className={styles.modalFooter}>
                <button className={styles.btnSecondary} type="button" disabled={imageRegenBusy} onClick={() => setShowImageRegenModal(false)}>
                  Cancel
                </button>
                <button
                  className={styles.button}
                  type="button"
                  disabled={
                    imageRegenBusy ||
                    (regenPromptSource === "custom" && regenCustomPrompt.trim().length > 0 && regenCustomPrompt.trim().length < 10) ||
                    (regenPromptSource === "custom" && !regenCustomPrompt.trim())
                  }
                  onClick={() =>
                    void regenerateFeaturedImage(
                      regenPromptSource === "custom"
                        ? { custom_image_prompt: regenCustomPrompt.trim() }
                        : { image_prompt_id: regenPromptId || null },
                    )
                  }
                >
                  {imageRegenBusy
                    ? hasFeaturedImage
                      ? "Regenerating…"
                      : "Generating…"
                    : hasFeaturedImage
                      ? "Regenerate image"
                      : "Generate image"}
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
                <button
                  type="button"
                  className={styles.iconButton}
                  aria-label="Close"
                  onClick={() => setWebsiteConnectionModal(false)}
                >
                  ×
                </button>
              </div>
              <div className={styles.modalBody}>
                Website is not connected for this project. Connect and verify WordPress in Project Settings to generate or publish articles.
              </div>
              <div className={styles.modalFooter}>
                <button className={styles.btnSecondary} type="button" onClick={() => router.push("/dashboard")}>
                  Cancel
                </button>
                <button className={styles.button} type="button" onClick={() => router.push(`/projects/${params.projectId}?tab=project_settings`)}>
                  Connect Website
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {leaveConfirmOpen ? (
          <div className={styles.modalBackdrop} role="dialog" aria-modal="true" aria-labelledby="leave-unsaved-title">
            <div className={styles.modalPanel} style={{ maxWidth: 480 }}>
              <div className={styles.modalHead}>
                <h3 id="leave-unsaved-title" className={styles.modalTitle}>
                  Leave without saving?
                </h3>
              </div>
              <div className={styles.modalBody} style={{ display: "grid", gap: 10 }}>
                <p style={{ margin: 0, lineHeight: 1.55, fontSize: 14 }}>
                  You have unsaved changes on this article. If you leave now, your edits will be lost and will not be
                  pushed to WordPress.
                </p>
                <p className={styles.muted} style={{ margin: 0, fontSize: 13, lineHeight: 1.5 }}>
                  Cancel to keep editing. Confirm to leave this page.
                </p>
              </div>
              <div className={styles.modalFooter}>
                <button
                  className={styles.btnSecondary}
                  type="button"
                  onClick={() => {
                    setLeaveConfirmOpen(false);
                    setPendingLeaveHref(null);
                  }}
                >
                  Cancel
                </button>
                <button
                  className={styles.button}
                  type="button"
                  onClick={() => {
                    const href = pendingLeaveHref;
                    setLeaveConfirmOpen(false);
                    setPendingLeaveHref(null);
                    if (href) router.push(href);
                  }}
                >
                  Confirm
                </button>
              </div>
            </div>
          </div>
        ) : null}

          <div className={editorStyles.editorLayout}>
          <div className={editorStyles.sidebarCol}>
            <div className={editorStyles.sectionCard}>
              <h2 className={editorStyles.sectionTitle}>Prompts</h2>
              {contentLoading ? (
                <ArticleEditorSkeleton />
              ) : null}
              {!contentLoading && !editorLocked && !writingPrompts && !imagePrompts ? (
                <div className={styles.row}>
                  <button className={styles.btnSecondary} type="button" onClick={ensurePromptsLoaded} disabled={promptsLoading}>
                    {promptsLoading ? "Loading prompts…" : "Load prompts"}
                  </button>
                  <div className={styles.muted} style={{ fontSize: 12 }}>
                    Loaded on demand to keep this page fast.
                  </div>
                </div>
              ) : null}

              {!contentLoading ? (
              <>
              <label className={styles.label}>
                Writing prompt
                <select className={styles.input} value={writingPromptId} onChange={(e) => setWritingPromptId(e.target.value)} disabled={editorLocked}>
                  <option value="">Project default</option>
                  {(writingPrompts?.items || []).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>

              <label className={styles.label}>
                Image prompt
                <select className={styles.input} value={imagePromptId} onChange={(e) => setImagePromptId(e.target.value)} disabled={editorLocked}>
                  <option value="">Project default</option>
                  {(imagePrompts?.items || []).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>

              <label className={styles.label}>
                Focus keyphrase (Yoast)
                <input className={styles.input} value={focus} onChange={(e) => setFocus(e.target.value)} placeholder="Optional" disabled={editorLocked} />
              </label>

              <label className={styles.label}>
                Generate image
                <select className={styles.input} value={generateImage ? "yes" : "no"} onChange={(e) => setGenerateImage(e.target.value === "yes")} disabled={editorLocked}>
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </select>
              </label>

              {isShopifyProject ? (
                <p className={styles.muted} style={{ fontSize: 12, lineHeight: 1.45, margin: "8px 0 0" }}>
                  {hasGeneratedContent ? (
                    <>
                      Use <strong>Regenerate</strong> to apply the latest guardrails and optionally remap active products.
                    </>
                  ) : (
                    <>
                      Click <strong>Generate</strong> to choose active products to weave into content and the featured image.
                    </>
                  )}
                </p>
              ) : isWordPressProject ? (
                <p className={styles.muted} style={{ fontSize: 12, lineHeight: 1.45, margin: "8px 0 0" }}>
                  {hasGeneratedContent ? (
                    <>
                      Use <strong>Regenerate</strong> to apply the latest guardrails and optionally remap synced site pages.
                    </>
                  ) : (
                    <>
                      Click <strong>Generate</strong> to map posts from your site map for internal links and optional hero-image
                      reference.
                    </>
                  )}
                </p>
              ) : hasGeneratedContent ? (
                <p className={styles.muted} style={{ fontSize: 12, lineHeight: 1.45, margin: "8px 0 0" }}>
                  <strong>Regenerate</strong> replaces this draft with new content using the latest human-writing guardrails.
                </p>
              ) : null}

              <div className={editorStyles.fieldActions}>
                {!hasGeneratedContent ? (
                  <button className={styles.button} type="button" onClick={() => void generate()} disabled={editorLocked}>
                    Generate
                  </button>
                ) : (
                  <button
                    className={styles.button}
                    type="button"
                    onClick={() => void generate()}
                    disabled={editorLocked}
                    title="Replace article with a new draft using latest human-writing guardrails"
                  >
                    Regenerate
                  </button>
                )}
                <button className={styles.button} type="button" onClick={save} disabled={editorLocked}>
                  Save
                </button>
              </div>
              </>
              ) : null}
            </div>

            <div className={editorStyles.sectionCard}>
              <h2 className={editorStyles.sectionTitle}>SEO</h2>
              {contentLoading ? (
                <ArticleEditorSkeleton />
              ) : (
              <>
              <label className={styles.label}>
                Title
                <input className={styles.input} value={title} onChange={(e) => setTitle(e.target.value)} disabled={editorLocked} />
              </label>
              <label className={styles.label}>
                Meta title
                <input
                  className={styles.input}
                  value={metaTitle}
                  onChange={(e) => setMetaTitle(clampChars(e.target.value, META_TITLE_MAX))}
                  disabled={editorLocked}
                />
              </label>
              <div className={styles.seoMeterRow} aria-label="Meta title character meter">
                <div className={styles.seoMeterMeta}>
                  <span className={styles.muted}>
                    {metaTitle.length}/{META_TITLE_MAX}
                  </span>
                  <span className={seoMeter(metaTitle.length, META_TITLE_MAX).state === "excellent" ? styles.seoOk : styles.seoWarn}>
                    {seoMeter(metaTitle.length, META_TITLE_MAX).label}
                  </span>
                </div>
                <div className={styles.seoMeterTrack}>
                  <div
                    className={seoMeter(metaTitle.length, META_TITLE_MAX).state === "excellent" ? styles.seoMeterFillOk : styles.seoMeterFillWarn}
                    style={{ width: `${seoMeter(metaTitle.length, META_TITLE_MAX).percent}%` }}
                  />
                </div>
              </div>
              <label className={styles.label}>
                Meta description
                <input
                  className={styles.input}
                  value={metaDesc}
                  onChange={(e) => setMetaDesc(clampChars(e.target.value, META_DESC_MAX))}
                  disabled={editorLocked}
                />
              </label>
              <div className={styles.seoMeterRow} aria-label="Meta description character meter">
                <div className={styles.seoMeterMeta}>
                  <span className={styles.muted}>
                    {metaDesc.length}/{META_DESC_MAX}
                  </span>
                  <span className={seoMeter(metaDesc.length, META_DESC_MAX).state === "excellent" ? styles.seoOk : styles.seoWarn}>
                    {seoMeter(metaDesc.length, META_DESC_MAX).label}
                  </span>
                </div>
                <div className={styles.seoMeterTrack}>
                  <div
                    className={seoMeter(metaDesc.length, META_DESC_MAX).state === "excellent" ? styles.seoMeterFillOk : styles.seoMeterFillWarn}
                    style={{ width: `${seoMeter(metaDesc.length, META_DESC_MAX).percent}%` }}
                  />
                </div>
              </div>
              </>
              )}
            </div>

          </div>

          <div className={editorStyles.contentCol}>
            <div className={`${editorStyles.contentCard} ${styles.articleEditorCard}`}>
              <h2 className={editorStyles.sectionTitlePrimary}>
                Article content
                {bodyLoading ? (
                  <span className={styles.muted} style={{ fontSize: 12, fontWeight: 500, marginLeft: 10 }}>
                    Loading body…
                  </span>
                ) : null}
              </h2>
              <div className={editorStyles.contentCardBody}>
                {bodyLoading ? (
                  <ArticleEditorSkeleton bodyOnly />
                ) : editorLocked ? (
                  highlightAi && body.trim() ? (
                    <ArticleIntegrityBody markdown={body} flaggedIndices={flaggedIndices} />
                  ) : (
                    <ArticleReadonlyBody key={editorRevision} markdown={body} />
                  )
                ) : (
                  <>
                    <ArticleRichEditor
                      key={editorRevision}
                      contentRevision={editorRevision}
                      value={body}
                      onChange={setBody}
                    />
                    {highlightAi && body.trim() ? (
                      <div className={styles.integrityHighlightPanel}>
                        <p className={styles.integrityHighlightBanner} style={{ marginTop: 12 }}>
                          Flagged passages below use the same layout as your article. Keep editing above; uncheck the
                          sidebar toggle to hide this preview.
                        </p>
                        <ArticleIntegrityBody markdown={body} flaggedIndices={flaggedIndices} />
                      </div>
                    ) : null}
                  </>
                )}
              </div>
              {showUpdateWordPress && hasPendingWpChanges ? (
                <p className={editorStyles.contentHint}>
                  {isDirty
                    ? "You have unsaved text changes. Update article saves locally and pushes everything live."
                    : "Featured image changed. Use Update article to push the new image to your site."}
                </p>
              ) : null}
            </div>
          </div>

          <div className={editorStyles.sidebarCol}>
            <div className={editorStyles.sectionCard}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                <h2 className={editorStyles.sectionTitle} style={{ marginBottom: 0 }}>
                  Integrity
                </h2>
                <button
                  type="button"
                  className={styles.btnSecondary}
                  onClick={() => {
                    setIntegrityLoading(true);
                    void api
                      .auditArticleIntegrity(params.projectId, params.articleId, body, { timeoutMs: 8_000 })
                      .then((res) => applyIntegrityResult(res))
                      .finally(() => setIntegrityLoading(false));
                  }}
                  disabled={integrityLoading || !body.trim()}
                  title={!body.trim() ? "Generate or add article content to audit integrity" : "Re-run integrity audit"}
                >
                  {integrityLoading ? "Auditing…" : "Re-audit"}
                </button>
              </div>

              {bodyLoading ? (
                <ArticleEditorIntegritySkeleton />
              ) : (
              <>
              <div style={{ display: "grid", gap: 12, marginTop: 14 }}>
                <IntegrityRing value={100 - aiPct} label="Human score" />
                <IntegrityRing value={aiPct} label="AI risk" />
              </div>

              <div style={{ marginTop: 14, display: "grid", gap: 10 }}>
                <label className={styles.label} style={{ display: "flex", alignItems: "center", gap: 10, margin: 0 }}>
                  <input
                    type="checkbox"
                    checked={highlightAi}
                    onChange={(e) => setHighlightAi(e.target.checked)}
                    disabled={!body.trim()}
                  />
                  Highlight AI-like content in article
                </label>

                {highlightAi && flaggedParagraphs.length ? (
                  <div style={{ display: "grid", gap: 10 }}>
                    {flaggedParagraphs.slice(0, 4).map((p) => (
                      <div key={p.index} style={{ padding: 10, borderRadius: 10, border: "1px solid rgba(255,255,255,0.10)", background: "rgba(217,119,87,0.06)" }}>
                        <div style={{ fontSize: 12, fontWeight: 800, color: "rgba(255,255,255,0.85)" }}>Paragraph {p.index + 1}</div>
                        <div style={{ fontSize: 12, color: "rgba(255,255,255,0.62)", marginTop: 6, lineHeight: 1.45 }}>{p.reason}</div>
                        {(p.signals as IntegritySignal[] | undefined)?.slice(0, 2).map((sig) => (
                          <div key={`${p.index}-${sig.label}`} style={{ marginTop: 8, fontSize: 11, lineHeight: 1.4, color: "rgba(255,255,255,0.55)" }}>
                            <strong style={{ color: "rgba(255,255,255,0.75)" }}>{sig.label}:</strong> {sig.detail}
                          </div>
                        ))}
                      </div>
                    ))}
                    {flaggedParagraphs.length > 4 ? (
                      <div className={styles.muted} style={{ fontSize: 12 }}>
                        +{flaggedParagraphs.length - 4} more flagged paragraphs
                      </div>
                    ) : null}
                  </div>
                ) : null}

                <button
                  type="button"
                  className={`${styles.button} ${canHumanize ? styles.wpUpdateButtonActive : ""}`}
                  onClick={() => void runHumanization()}
                  disabled={humanizeBusy || !body.trim() || !canHumanize}
                  title={
                    !canHumanize
                      ? "Add more article content to humanize"
                      : "Paraphrase the entire article (all industries)"
                  }
                >
                  {humanizeBusy ? "Humanizing…" : isPublishedArticle ? "Humanize →" : "Apply Structural Humanization"}
                </button>
                {isPublishedArticle && canHumanize ? (
                  <p className={styles.muted} style={{ fontSize: 12, margin: 0, lineHeight: 1.45 }}>
                    Works on published articles. Review changes in the comparison modal, apply to the editor, then use
                    Update article to push to WordPress.
                  </p>
                ) : null}
              </div>
              </>
              )}
            </div>

            <div className={editorStyles.sectionCard}>
              <h2 className={editorStyles.sectionTitle}>Featured image</h2>
              <div className={styles.articleImageFrame}>
                {showFeaturedImageSkeleton ? (
                  <div className={editorStyles.imageSkeleton} aria-live="polite" aria-busy="true">
                    <div className={editorStyles.imageSkeletonShimmer} aria-hidden="true" />
                    <div className={editorStyles.imageSkeletonPulse} aria-hidden="true" />
                    <div className={editorStyles.imageSkeletonBars} aria-hidden="true">
                      <span />
                      <span />
                      <span />
                    </div>
                    <div className={editorStyles.imageSkeletonContent}>
                      {imageRegenBusy ? (
                        <>
                          <div className={editorStyles.imageSpinner} aria-hidden="true" />
                          <div className={editorStyles.imageGeneratingTitle}>
                            {imageGenPhase === "saving" ? "Saving featured image…" : "Generating featured image…"}
                          </div>
                          <div className={editorStyles.imageGeneratingHint}>
                            {imageGenPhase === "saving"
                              ? "Writing to storage. You can keep editing the article."
                              : "OpenAI is creating your image (30–90s). The rest of the editor stays available."}
                          </div>
                        </>
                      ) : (
                        <>
                          <div className={editorStyles.imageSpinner} aria-hidden="true" />
                          <div className={editorStyles.imageGeneratingTitle}>Loading featured image…</div>
                          <div className={editorStyles.imageGeneratingHint}>
                            Retrieving your saved image from storage.
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                ) : generateImage ? (
                  generatedImageUrl ? (
                    <LazyArticleImage src={generatedImageUrl} alt="Generated preview" className={styles.articleImage} />
                  ) : featuredImageLoadFailed ? (
                    <div className={editorStyles.imagePlaceholder}>
                      Saved featured image could not be loaded.
                      <div style={{ marginTop: 6 }}>Use &ldquo;Regenerate featured image&rdquo; to create a new one.</div>
                    </div>
                  ) : (
                    <div className={editorStyles.imagePlaceholder}>
                      Image will be generated using the selected (or default) image prompt.
                      <div style={{ marginTop: 6 }}>Once ready, it will appear here.</div>
                    </div>
                  )
                ) : uploadedImagePreview ? (
                  <LazyArticleImage src={uploadedImagePreview} alt="Uploaded preview" className={styles.articleImage} />
                ) : (
                  <div className={editorStyles.imagePlaceholder}>No image selected.</div>
                )}
              </div>

              {!generateImage ? (
                <label className={styles.label} style={{ marginTop: 10 }}>
                  Upload image (used on publish)
                  <input className={styles.input} type="file" accept="image/*" disabled={editorLocked} onChange={(e) => setUploadedImageFile(e.target.files?.[0] || null)} />
                </label>
              ) : null}
              {generateImage ? (
                <div style={{ marginTop: 12, display: "grid", gap: 8 }}>
                  <div className={editorStyles.imageMeta}>
                    Featured image regenerations: {imageRegenUsed}
                    {imageRegenUnlimited ? " / unlimited" : ` / ${imageRegenLimit}`}
                    {!imageRegenUnlimited ? ` (${Math.max(0, imageRegenRemaining ?? 0)} remaining)` : ""}
                  </div>
                  <button
                    className={styles.btnSecondary}
                    type="button"
                    onClick={handleFeaturedImageButtonClick}
                    disabled={imageRegenBusy || !canFeaturedImageAction}
                    title={
                      !canFeaturedImageAction
                        ? imageRegenExhausted && hasFeaturedImage
                          ? "The max featured image regeneration limit is exhausted for this article."
                          : !hasGeneratedContent
                            ? "Generate article content first."
                            : "Enable “Generate image” (Yes) to create a featured image."
                        : hasFeaturedImage
                          ? "Regenerate only the featured image using a saved or one-time custom prompt."
                          : "Generate the featured image using a saved or one-time custom prompt."
                    }
                  >
                    {imageRegenBusy
                      ? hasFeaturedImage
                        ? "Regenerating image…"
                        : "Generating image…"
                      : hasFeaturedImage
                        ? "Regenerate featured image"
                        : "Generate featured image"}
                  </button>
                  {imageRegenExhausted ? (
                    <div className={styles.error} style={{ fontSize: 12 }}>
                      The max featured image regeneration limit is exhausted for this article.
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>

            <div className={editorStyles.sectionCard}>
              <h2 className={editorStyles.sectionTitle}>Tags</h2>
              <label className={styles.label}>
                Targeting keywords (comma-separated)
                <input className={styles.input} value={keywords} onChange={(e) => setKeywords(e.target.value)} disabled={editorLocked} />
              </label>
              <div className={styles.muted} style={{ fontSize: 12 }}>
                Tip: keep this focused (5–10 keywords max).
              </div>
            </div>

            <div className={editorStyles.sectionCard}>
              <div className={editorStyles.wpCardHead}>
                <div>
                  <h2 className={editorStyles.sectionTitlePrimary}>{isShopifyProject ? "Shopify" : "WordPress"}</h2>
                  <p className={editorStyles.wpCardDesc}>
                    {isShopifyProject
                      ? shopifyLink
                        ? "This article is on Shopify. Change content here and post again, or open the live link below."
                        : "Post directly to your Shopify blog as a draft or published article."
                      : isScheduledArticle
                        ? "This article is scheduled. Update is available after it is published live on WordPress."
                        : showUpdateWordPress
                          ? "Push edits to your live WordPress post when you change text or the featured image."
                          : showPublishWordPress
                            ? "Publish when the article is ready (draft or pending — not yet live on WordPress)."
                            : "WordPress actions depend on article status."}
                  </p>
                </div>
                <div className={editorStyles.wpActions}>
                  {isShopifyProject ? (
                    <>
                      <button
                        className={styles.button}
                        type="button"
                        onClick={() => void publishToShopify()}
                        disabled={shopifyPublishBusy || !shopifyCanPublish || !shopifyBlogsAvailable}
                        title={
                          !shopifyBlogsAvailable
                            ? "Sync catalog to load blogs first"
                            : !shopifyCanPublish
                              ? "Connect Shopify and grant write_content scope"
                              : shopifyPublishNow
                                ? "Publish live on Shopify"
                                : "Save as draft on Shopify"
                        }
                      >
                        {shopifyPublishBusy
                          ? "Posting…"
                          : shopifyPublishNow
                            ? "Publish to Shopify"
                            : "Save Shopify draft"}
                      </button>
                      <button className={styles.btnSecondary} type="button" onClick={copyArticleMarkdown} disabled={!body.trim()}>
                        Copy markdown
                      </button>
                      <button
                        className={styles.btnSecondary}
                        type="button"
                        onClick={copyArticleTitleAndMarkdown}
                        disabled={!body.trim() && !(title || article?.title || "").trim()}
                      >
                        Copy title + markdown
                      </button>
                    </>
                  ) : (
                    <>
                      {showUpdateWordPress ? (
                        <button
                          className={`${styles.button} ${canUpdateWordPress ? styles.wpUpdateButtonActive : ""}`}
                          type="button"
                          onClick={() => void updateWordPressPost()}
                          disabled={!canUpdateWordPress}
                          title={
                            !websiteConnected
                              ? "Connect WordPress in project settings"
                              : "Push the current article (title, body, SEO, image, categories) to WordPress"
                          }
                        >
                          {wpUpdateBusy ? "Updating…" : "Update"}
                        </button>
                      ) : showPublishWordPress ? (
                        <button
                          className={styles.button}
                          type="button"
                          onClick={publishToLiveSite}
                          disabled={!canPublish || wpPushBusy}
                          title={
                            !websiteConnected
                              ? "Connect WordPress in project settings"
                              : "Publish this article to WordPress"
                          }
                        >
                          {wpPublishBusy ? "Publishing…" : "Publish"}
                        </button>
                      ) : null}
                    </>
                  )}
                </div>
              </div>

              {isShopifyProject ? (
                <div style={{ marginTop: 12, display: "grid", gap: 10 }}>
                  {shopifyLink ? (
                    <div className={styles.muted} style={{ fontSize: 12, lineHeight: 1.5 }}>
                      Live on Shopify:{" "}
                      <a href={shopifyLink} target="_blank" rel="noreferrer" style={{ color: "rgba(217,119,87,0.95)" }}>
                        {shopifyLink}
                      </a>
                    </div>
                  ) : null}
                  <div className={styles.muted} style={{ fontSize: 12 }}>
                    Store: <strong>{(projectSettings?.shopify_shop || shopifyStatus?.shop || "Not set").toString()}</strong>
                    {" · "}
                    <strong>{websiteConnected ? "Connected" : "Not connected"}</strong>
                  </div>
                  {shopifyStatus?.setup_hint ? (
                    <div
                      style={{
                        fontSize: 12,
                        lineHeight: 1.5,
                        padding: "10px 12px",
                        borderRadius: 8,
                        border: "1px solid color-mix(in oklab, #e6b422, transparent 45%)",
                        background: "color-mix(in oklab, #e6b422 8%, transparent)",
                      }}
                    >
                      {shopifyStatus.setup_hint}
                      {shopifyStatus.needs_reauthorize ? (
                        <>
                          {" "}
                          <Link href={`/projects/${params.projectId}?tab=project_settings`}>Project settings → Shopify</Link>
                        </>
                      ) : null}
                    </div>
                  ) : null}
                  {(shopifyStatus?.granted_scopes || []).length > 0 ? (
                    <div className={styles.muted} style={{ fontSize: 11 }}>
                      Token: {(shopifyStatus?.granted_scopes || []).map((s) => (
                        <code key={s} style={{ marginRight: 6 }}>
                          {s}
                          {s === "read_products" || s === "write_content" ? " ✓" : ""}
                        </code>
                      ))}
                    </div>
                  ) : null}
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                    <label className={styles.label}>
                      Target blog
                      <select
                        className={styles.input}
                        value={shopifyBlogId == null ? "" : String(shopifyBlogId)}
                        onChange={(e) => setShopifyBlogId(e.target.value ? Number(e.target.value) : null)}
                        disabled={!shopifyBlogsAvailable}
                      >
                        <option value="">Select blog…</option>
                        {(shopifyCatalog?.blogs || []).map((b) => (
                          <option key={String(b?.id)} value={String(b?.id || "")}>
                            {formatShopifyBlogOptionLabel(b)}
                          </option>
                        ))}
                      </select>
                      <span className={styles.muted} style={{ fontSize: 11, display: "block", marginTop: 6, lineHeight: 1.45 }}>
                        {SHOPIFY_BLOG_CHANNEL_HELP}
                      </span>
                    </label>
                    <label className={styles.label}>
                      Post status
                      <select
                        className={styles.input}
                        value={shopifyPublishNow ? "publish" : "draft"}
                        onChange={(e) => setShopifyPublishNow(e.target.value === "publish")}
                      >
                        <option value="draft">Draft on Shopify</option>
                        <option value="publish">Published (live)</option>
                      </select>
                    </label>
                  </div>
                  {!shopifyBlogsAvailable ? (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                      <button
                        type="button"
                        className={styles.btnSecondary}
                        onClick={() => void syncShopifyCatalogFromEditor()}
                        disabled={shopifyCatalogSyncing || !websiteConnected}
                      >
                        {shopifyCatalogSyncing ? "Syncing…" : "Sync blogs from Shopify"}
                      </button>
                      <span className={styles.muted} style={{ fontSize: 12 }}>
                        Requires <code>read_content</code>
                        {shopifyMissingPublishScopes.includes("write_content") ? " and `write_content` to post" : ""}.
                      </span>
                    </div>
                  ) : null}
                  {shopifyProductAware ? (
                    <div className={styles.muted} style={{ fontSize: 12 }}>
                      Product-aware generation is on — map products when generating from Research or cluster modals.
                    </div>
                  ) : null}
                </div>
              ) : (
                <>
                  {showUpdateWordPress && hasPendingWpChanges ? (
                    <div className={styles.muted} style={{ fontSize: 12, marginTop: 10 }}>
                      You have unsaved edits in the editor — Update will push the latest content to WordPress.
                    </div>
                  ) : null}

                  {wpMetaLoading && !wpPostTypes.length && !wpCategories.length ? (
                    <div className={editorStyles.wpMetaLoading} style={{ marginTop: 12 }}>
                      <div className={editorStyles.imageSpinner} aria-hidden="true" />
                      <span>Loading WordPress settings…</span>
                    </div>
                  ) : null}

                  {wpMetaError && !wpPostTypes.length && !wpCategories.length ? (
                    <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
                      <div className={styles.error} style={{ fontSize: 12 }}>
                        {wpMetaError}
                      </div>
                      <button
                        className={styles.btnSecondary}
                        type="button"
                        onClick={() => void ensureWpMetaLoaded({ force: true })}
                        disabled={wpMetaLoading}
                      >
                        Retry WordPress settings
                      </button>
                    </div>
                  ) : null}

                  {!wpMetaLoading && !wpMetaError && !wpPostTypes.length && !wpCategories.length && websiteConnected ? (
                    <div className={styles.muted} style={{ fontSize: 12, marginTop: 10 }}>
                      Using project defaults for post type and categories until WordPress settings load.
                    </div>
                  ) : null}

                  {wpPostTypes.length || wpCategories.length ? (
                    <>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 12 }}>
                        <label className={styles.label}>
                          Post type
                          <select className={styles.input} value={wpPostType} onChange={(e) => setWpPostType(e.target.value)} disabled={editorLocked}>
                            <option value="posts">Posts</option>
                            {wpPostTypes
                              .filter((t) => t.rest_base && t.rest_base !== "posts")
                              .map((t) => (
                                <option key={t.rest_base} value={t.rest_base}>
                                  {t.name || t.rest_base}
                                </option>
                              ))}
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

                      <label className={styles.label} style={{ marginTop: 10 }}>
                        Categories
                        <select
                          className={styles.input}
                          multiple
                          value={wpCategoryIds.map(String)}
                          onChange={(e) => {
                            const ids = Array.from(e.target.selectedOptions).map((o) => Number(o.value)).filter((n) => Number.isFinite(n));
                            setWpCategoryIds(ids);
                          }}
                          style={{ minHeight: 120 }}
                          disabled={editorLocked}
                        >
                          {wpCategories.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                        </select>
                        <div className={styles.muted} style={{ fontSize: 12, marginTop: 6 }}>
                          Hold Cmd/Ctrl to select multiple categories.
                        </div>
                      </label>
                    </>
                  ) : (
                    <div className={styles.muted} style={{ fontSize: 12, marginTop: 12 }}>
                      Publishing will use defaults unless you load WordPress settings.
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
          </div>
        </section>
      </main>
    </div>
  );
}

