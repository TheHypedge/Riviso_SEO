"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import styles from "../../../../page.module.css";
import editorStyles from "./articleEditor.module.css";
import projectsDark from "../../../projectsDark.module.css";
import {
  api,
  ApiError,
  ArticleDetail,
  clearAuth,
  getAccessToken,
  PromptListResponse,
} from "@/lib/api";
import { ArticleReadonlyBody } from "@/components/ArticleReadonlyBody";
import { articleEditorPath, formatArticleLoadError } from "@/lib/articlePaths";
import {
  canPushWordPressUpdate,
  isArticleLiveOnWordPress,
  parseWpPostId,
  shouldShowWordPressPublish,
  shouldShowWordPressUpdate,
} from "@/lib/articleEditorWordpress";

const ArticleRichEditor = dynamic(
  () => import("@/components/ArticleRichEditor").then((m) => m.ArticleRichEditor),
  {
    ssr: false,
    loading: () => (
      <div className={styles.muted} style={{ padding: 16 }}>
        Loading editor…
      </div>
    ),
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

  // ``loading`` value isn't rendered directly — the global loading provider
  // shows the typewriter overlay instead — but ``setLoading`` is wired up so
  // we can re-enable a local skeleton later without touching call sites.
  const [, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [errorCanRetry, setErrorCanRetry] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);

  const [article, setArticle] = useState<ArticleDetail | null>(null);
  const [projectSettings, setProjectSettings] = useState<import("@/lib/api").ProjectSettings | null>(null);
  const [writingPrompts, setWritingPrompts] = useState<PromptListResponse | null>(
    null,
  );
  const [imagePrompts, setImagePrompts] = useState<PromptListResponse | null>(
    null,
  );
  const [promptsLoading, setPromptsLoading] = useState(false);
  const [wpMetaLoading, setWpMetaLoading] = useState(false);

  // Editable fields
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
  const [editorBaseline, setEditorBaseline] = useState<EditorBaseline | null>(null);
  const [leaveConfirmOpen, setLeaveConfirmOpen] = useState(false);
  const [pendingLeaveHref, setPendingLeaveHref] = useState<string | null>(null);

  const articleStatus = (article?.status || "").trim().toLowerCase();
  const wpPostId = useMemo(() => parseWpPostId(article?.wp_post_id), [article?.wp_post_id]);
  const wpLink = (article?.wp_link || "").trim();
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
  const editorLocked = articleStatus === "published" && !isLiveOnWordPress;

  // WordPress publish options
  const [wpPostTypes, setWpPostTypes] = useState<{ rest_base: string; name: string; taxonomies: string[] }[]>([]);
  const [wpCategories, setWpCategories] = useState<{ id: number; name: string }[]>([]);
  const [wpPostType, setWpPostType] = useState("posts");
  const [wpStatus, setWpStatus] = useState<"draft" | "publish">("draft");
  const [wpCategoryIds, setWpCategoryIds] = useState<number[]>([]);

  // Regenerate confirmation
  const [showRegenConfirm, setShowRegenConfirm] = useState(false);
  const [showImageRegenModal, setShowImageRegenModal] = useState(false);
  const [regenPromptSource, setRegenPromptSource] = useState<"saved" | "custom">("saved");
  const [regenPromptId, setRegenPromptId] = useState("");
  const [regenCustomPrompt, setRegenCustomPrompt] = useState("");
  const [websiteConnectionModal, setWebsiteConnectionModal] = useState(false);
  const [imageRegenBusy, setImageRegenBusy] = useState(false);
  const [wpUpdateBusy, setWpUpdateBusy] = useState(false);
  const [liveUrlCopied, setLiveUrlCopied] = useState(false);
  const websiteConnected = (projectSettings?.wp_verified_status || "").trim().toLowerCase() === "connected";

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
    if (!token) {
      router.replace("/login");
      return;
    }
    if (!editorPath) return;
    (async () => {
      setError(null);
      setErrorCanRetry(false);
      setNotice(null);
      setLoading(true);
      try {
        const a = await api.getArticle(params.projectId, params.articleId);

        setArticle(a);
        setTitle(a.title || "");
        setKeywords(kwToString(a.keywords));
        setFocus(a.focus_keyphrase || "");
        setBody(a.article || "");
        setMetaTitle(a.meta_title || "");
        setMetaDesc(a.meta_description || "");
        setGeneratedImageUrl(a.image_url || "");
        setEditorBaseline(baselineFromArticle(a));
        if (a.wp_rest_base) setWpPostType(a.wp_rest_base);

        if (a.has_featured_image && !a.image_url) {
          void api
            .getArticleFeaturedImage(params.projectId, params.articleId)
            .then((img) => {
              const url = img.image_url || "";
              setGeneratedImageUrl(url);
              setEditorBaseline((prev) => (prev ? { ...prev, imageUrl: url } : prev));
            })
            .catch(() => {
              /* image optional for editing text */
            });
        }

        void Promise.allSettled([
          api.listWritingPrompts(params.projectId),
          api.listImagePrompts(params.projectId),
          api.getProjectSettings(params.projectId),
        ]).then(([wpRes, ipRes, settingsRes]) => {
          const wp = wpRes.status === "fulfilled" ? wpRes.value : null;
          const ip = ipRes.status === "fulfilled" ? ipRes.value : null;
          if (settingsRes.status === "fulfilled") setProjectSettings(settingsRes.value);
          if (wp) {
            setWritingPrompts(wp);
            setWritingPromptId(wp.default_id || "");
          }
          if (ip) {
            setImagePrompts(ip);
            setImagePromptId(ip.default_id || "");
          }
          if (!wp) setWritingPromptId("");
          if (!ip) setImagePromptId("");
        });
      } catch (e) {
        if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
          clearAuth();
          router.replace("/login");
          return;
        }
        const info = formatArticleLoadError(e);
        setError(info.message);
        setErrorCanRetry(info.canRetry);
      } finally {
        setLoading(false);
      }
    })();
  }, [editorPath, params.articleId, params.projectId, router, token, loadAttempt]);

  // Background prefetch (non-blocking) for better perceived performance.
  useEffect(() => {
    if (!token) return;
    const prefetch = () => {
      // Fire-and-forget: keep editor responsive.
      void ensurePromptsLoaded();
      // WP meta is heavier and often unused; prefetch slightly later.
      setTimeout(() => void ensureWpMetaLoaded(), 900);
    };
    // Prefer idle time; fallback to short delay.
    const w = window as unknown as { requestIdleCallback?: (cb: () => void, opts?: { timeout?: number }) => number; cancelIdleCallback?: (id: number) => void };
    const idleId = typeof w.requestIdleCallback === "function" ? w.requestIdleCallback(prefetch, { timeout: 2000 }) : null;
    const t = idleId ? null : window.setTimeout(prefetch, 900);
    return () => {
      if (idleId && typeof w.cancelIdleCallback === "function") w.cancelIdleCallback(idleId);
      if (t) window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.projectId, token]);

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

  async function ensureWpMetaLoaded() {
    if (wpMetaLoading) return;
    if (wpPostTypes.length || wpCategories.length) return;
    setWpMetaLoading(true);
    try {
      const [types, cats, ps] = await Promise.all([
        api.wordpressPostTypes(params.projectId, { timeoutMs: 8000 }),
        api.wordpressCategories(params.projectId, { timeoutMs: 8000 }),
        api.getProjectSettingsWithOpts(params.projectId, { timeoutMs: 8000 }),
      ]);
      setWpPostTypes(types);
      setWpCategories(cats);
      if (types.find((t) => t.rest_base === "posts")) setWpPostType("posts");
      setWpPostType((ps.default_wp_rest_base || "posts") as string);
      setWpStatus(((ps.default_wp_status || "draft") as "draft" | "publish"));
      setWpCategoryIds((ps.default_wp_category_ids || []) as number[]);
    } catch {
      // ignore
    } finally {
      setWpMetaLoading(false);
    }
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

  async function generate() {
    await ensurePromptsLoaded();
    if (!websiteConnected) {
      setWebsiteConnectionModal(true);
      return;
    }
    const alreadyGenerated =
      !!(body || "").trim() || !!(metaTitle || "").trim() || !!(metaDesc || "").trim() || !!generatedImageUrl;
    if (alreadyGenerated) {
      setShowRegenConfirm(true);
      return;
    }
    return doGenerate();
  }

  async function doGenerate() {
    if (!websiteConnected) {
      setWebsiteConnectionModal(true);
      return;
    }
    setError(null);
    setNotice(null);
    try {
      // Progressive status messages for the global loader overlay.
      const setLoadingLines = (lines: string[] | null) => {
        if (typeof window === "undefined") return;
        window.dispatchEvent(new CustomEvent("aa:loadingStatus", { detail: { lines } }));
      };

      const timers: number[] = [];
      setLoadingLines(["Article Generation in progress"]);
      timers.push(
        window.setTimeout(() => setLoadingLines(["Article Generation in progress", "Article is now getting prepared"]), 900),
      );
      if (generateImage) {
        timers.push(
          window.setTimeout(
            () =>
              setLoadingLines([
                "Article generation is completed.",
                "Now Article Image generation is in progress.",
              ]),
            2200,
          ),
        );
        timers.push(
          window.setTimeout(() => setLoadingLines(["Now Article Image generation is in progress.", "Article Image is getting prepared."]), 3800),
        );
      }

      const res = await api.generateArticle(params.projectId, params.articleId, {
        writing_prompt_id: writingPromptId || null,
        image_prompt_id: imagePromptId || null,
        focus_keyphrase: focus || null,
        generate_image: generateImage,
      });
      if (res.generated?.article) setBody(res.generated.article);
      if (res.generated?.meta_title !== undefined) setMetaTitle(clampChars(res.generated.meta_title || "", META_TITLE_MAX));
      if (res.generated?.meta_description !== undefined) setMetaDesc(clampChars(res.generated.meta_description || "", META_DESC_MAX));
      if (res.generated?.image_url) setGeneratedImageUrl(res.generated.image_url);
      const refreshed = await api.getArticle(params.projectId, params.articleId);
      setArticle(refreshed);
      setTitle(refreshed.title || title);
      setKeywords(kwToString(refreshed.keywords));
      setFocus(refreshed.focus_keyphrase || focus);
      setNotice(`${res.status}: ${res.message}${res.generated?.image_url ? `\nImage: ${res.generated.image_url}` : ""}`);

      setLoadingLines(
        generateImage
          ? ["All tasks are completed."]
          : ["Article generation is completed.", "All tasks are completed."],
      );
      window.setTimeout(() => setLoadingLines(null), 900);
      timers.forEach((t) => window.clearTimeout(t));
    } catch (e) {
      if (showWebsiteConnectionErrorIfNeeded(e)) return;
      if (e instanceof ApiError && e.status === 408) {
        setError(e.message);
        return;
      }
      setError(e instanceof Error ? e.message : "Generate request failed");
    }
  }

  function openImageRegenModal() {
    setError(null);
    if (!websiteConnected) {
      setWebsiteConnectionModal(true);
      return;
    }
    const canRegenImage = !!(generatedImageUrl || article?.has_featured_image);
    if (!canRegenImage) {
      setError("Generate an article image first, then you can regenerate it.");
      return;
    }
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
    if (!websiteConnected) {
      setWebsiteConnectionModal(true);
      return;
    }
    setError(null);
    setNotice(null);
    setImageRegenBusy(true);
    const setLoadingLines = (lines: string[] | null) => {
      if (typeof window === "undefined") return;
      window.dispatchEvent(new CustomEvent("aa:loadingStatus", { detail: { lines } }));
    };
    try {
      setLoadingLines(["Featured image regeneration is in progress."]);
      const res = await api.regenerateArticleImage(params.projectId, params.articleId, {
        image_prompt_id: opts?.custom_image_prompt ? null : (opts?.image_prompt_id ?? imagePromptId) || null,
        custom_image_prompt: opts?.custom_image_prompt?.trim() || null,
      });
      const regenImageUrl = res.image_url || "";
      if (regenImageUrl) setGeneratedImageUrl(regenImageUrl);
      const refreshed = await api.getArticle(params.projectId, params.articleId);
      setArticle(refreshed);
      setGeneratedImageUrl((prev) => regenImageUrl || refreshed.image_url || prev);
      setNotice(`${res.status}: ${res.message}. Use Update article to push the new image to WordPress.`);
      setShowImageRegenModal(false);
      setLoadingLines(["Featured image regenerated.", "All tasks are completed."]);
      window.setTimeout(() => setLoadingLines(null), 900);
    } catch (e) {
      if (showWebsiteConnectionErrorIfNeeded(e)) return;
      if (e instanceof ApiError && e.detail && typeof e.detail === "object" && !Array.isArray(e.detail)) {
        const d = e.detail as Record<string, unknown>;
        if (d.code === "image_regeneration_limit_reached") {
          setError(typeof d.message === "string" ? d.message : "Featured image regeneration limit reached for this article.");
          return;
        }
      }
      setError(e instanceof Error ? e.message : "Featured image regeneration failed");
    } finally {
      window.setTimeout(() => setLoadingLines(null), 900);
      setImageRegenBusy(false);
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
    hasPendingChanges: hasPendingWpChanges,
    busy: wpUpdateBusy,
  });

  const imageRegenUsed = article?.featured_image_regeneration_count ?? 0;
  const imageRegenUnlimited = article?.featured_image_regeneration_unlimited ?? true;
  const imageRegenLimit = article?.featured_image_regeneration_limit ?? 0;
  const imageRegenRemaining = article?.featured_image_regeneration_remaining;
  const imageRegenExhausted = !imageRegenUnlimited && (imageRegenRemaining ?? 0) <= 0;
  const canRegenerateFeaturedImage =
    !!(generatedImageUrl || article?.has_featured_image) && !imageRegenExhausted;

  async function publishToLiveSite() {
    if (!websiteConnected) {
      setWebsiteConnectionModal(true);
      return;
    }
    setError(null);
    setNotice(null);
    try {
      if (isDirty) {
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
          baselineFromFields({ title, keywords, focus, body, metaTitle, metaDesc, imageUrl: generatedImageUrl }),
        );
      }
      const res = await api.publishArticleToLiveSite(params.projectId, params.articleId, {
        image_file: generateImage ? null : uploadedImageFile,
        post_type: wpPostType,
        wp_status: wpStatus,
        category_ids: wpCategoryIds,
      });
      const refreshed = await api.getArticle(params.projectId, params.articleId);
      setArticle(refreshed);
      const syncedImageUrl = refreshed.image_url || generatedImageUrl;
      setGeneratedImageUrl(syncedImageUrl);
      setEditorBaseline(baselineFromArticle(refreshed, syncedImageUrl));
      if (refreshed.wp_rest_base) setWpPostType(refreshed.wp_rest_base);
      setNotice(`${res.status}: ${res.message}${res.wp_link ? `\n${res.wp_link}` : ""}`);
    } catch (e) {
      if (showWebsiteConnectionErrorIfNeeded(e)) return;
      if (e instanceof ApiError && e.status === 408) {
        setError(e.message);
        return;
      }
      setError(e instanceof Error ? e.message : "Publish to live site failed");
    }
  }

  async function updateWordPressPost() {
    if (!websiteConnected) {
      setWebsiteConnectionModal(true);
      return;
    }
    if (!showUpdateWordPress) return;
    setError(null);
    setNotice(null);
    setWpUpdateBusy(true);
    try {
      if (isDirty) {
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
          baselineFromFields({ title, keywords, focus, body, metaTitle, metaDesc, imageUrl: generatedImageUrl }),
        );
      }
      const res = await api.updateArticleOnWordPress(params.projectId, params.articleId, {
        image_file: generateImage ? null : uploadedImageFile,
        post_type: wpPostType,
        wp_status: wpStatus,
        category_ids: wpCategoryIds,
      });
      const refreshed = await api.getArticle(params.projectId, params.articleId);
      setArticle(refreshed);
      const syncedImageUrl = refreshed.image_url || generatedImageUrl;
      setGeneratedImageUrl(syncedImageUrl);
      setEditorBaseline(baselineFromArticle(refreshed, syncedImageUrl));
      setNotice(`${res.status}: ${res.message}${res.wp_link ? `\n${res.wp_link}` : ""}`);
    } catch (e) {
      if (showWebsiteConnectionErrorIfNeeded(e)) return;
      if (e instanceof ApiError && e.status === 408) {
        setError(e.message);
        return;
      }
      setError(e instanceof Error ? e.message : "WordPress update failed");
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
              {showUpdateWordPress && hasPendingWpChanges ? (
                <span className={`${editorStyles.statusPill} ${editorStyles.statusWarn}`}>Unsynced changes</span>
              ) : null}
            </div>

            {isLiveOnWordPress && wpLink ? (
              <div className={editorStyles.liveUrlCard}>
                <span className={editorStyles.liveUrlLabel}>Live URL</span>
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
                </div>
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

        {showRegenConfirm ? (
          <div className={styles.modalBackdrop}>
            <div className={styles.modalPanel}>
              <div className={styles.modalHead}>
                <div className={styles.modalTitle}>The content is already generated</div>
              </div>
              <div className={styles.modalBody}>
                Are you sure you want to generate new content? <br />
                <strong>All the older content will be erased.</strong>
              </div>
              <div className={styles.modalFooter}>
                <button className={styles.btnSecondary} type="button" onClick={() => setShowRegenConfirm(false)}>
                  No
                </button>
                <button
                  className={styles.button}
                  type="button"
                  onClick={async () => {
                    setShowRegenConfirm(false);
                    setBody("");
                    setMetaTitle("");
                    setMetaDesc("");
                    setGeneratedImageUrl("");
                    await doGenerate();
                  }}
                >
                  Yes, generate new
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {showImageRegenModal ? (
          <div className={styles.modalBackdrop} role="dialog" aria-modal="true" aria-label="Regenerate featured image">
            <div className={styles.modalPanel} style={{ maxWidth: 520 }}>
              <div className={styles.modalHead}>
                <h3 className={styles.modalTitle}>Regenerate featured image</h3>
                <button
                  type="button"
                  className={styles.iconButton}
                  aria-label="Close"
                  onClick={() => setShowImageRegenModal(false)}
                >
                  ×
                </button>
              </div>
              <div className={styles.modalBody} style={{ display: "grid", gap: 14 }}>
                <p className={styles.muted} style={{ margin: 0, fontSize: 13, lineHeight: 1.5 }}>
                  Choose a saved image prompt or enter a one-time custom prompt. Custom prompts are not saved to your
                  project prompt list.
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
                    {(imagePrompts?.items || []).length ? (
                      imagePrompts!.items.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name || p.id}
                        </option>
                      ))
                    ) : (
                      <option value="">No image prompts — add one in project settings</option>
                    )}
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
              </div>
              <div className={styles.modalFooter}>
                <button className={styles.btnSecondary} type="button" onClick={() => setShowImageRegenModal(false)}>
                  Cancel
                </button>
                <button
                  className={styles.button}
                  type="button"
                  disabled={
                    imageRegenBusy ||
                    (regenPromptSource === "saved" && !regenPromptId) ||
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
                  {imageRegenBusy ? "Regenerating…" : "Regenerate image"}
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
              {!editorLocked && !writingPrompts && !imagePrompts ? (
                <div className={styles.row}>
                  <button className={styles.btnSecondary} type="button" onClick={ensurePromptsLoaded} disabled={promptsLoading}>
                    {promptsLoading ? "Loading prompts…" : "Load prompts"}
                  </button>
                  <div className={styles.muted} style={{ fontSize: 12 }}>
                    Loaded on demand to keep this page fast.
                  </div>
                </div>
              ) : null}

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

              <div className={editorStyles.fieldActions}>
                <button className={styles.button} type="button" onClick={generate} disabled={editorLocked}>
                  Generate
                </button>
                <button className={styles.button} type="button" onClick={save} disabled={editorLocked}>
                  Save
                </button>
              </div>
            </div>

            <div className={editorStyles.sectionCard}>
              <h2 className={editorStyles.sectionTitle}>SEO</h2>
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
            </div>

          </div>

          <div className={editorStyles.contentCol}>
            <div className={`${editorStyles.contentCard} ${styles.articleEditorCard}`}>
              <h2 className={editorStyles.sectionTitlePrimary}>Article content</h2>
              <div className={editorStyles.contentCardBody}>
                {editorLocked ? (
                  <ArticleReadonlyBody markdown={body} />
                ) : (
                  <ArticleRichEditor value={body} onChange={setBody} />
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
              <h2 className={editorStyles.sectionTitle}>Featured image</h2>
              <div className={styles.articleImageFrame}>
                {generateImage ? (
                  generatedImageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={generatedImageUrl} alt="Generated preview" className={styles.articleImage} />
                  ) : (
                    <div className={editorStyles.imagePlaceholder}>
                      Image will be generated using the selected (or default) image prompt.
                      <div style={{ marginTop: 6 }}>Once ready, it will appear here.</div>
                    </div>
                  )
                ) : uploadedImagePreview ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={uploadedImagePreview} alt="Uploaded preview" className={styles.articleImage} />
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
                    onClick={openImageRegenModal}
                    disabled={imageRegenBusy || !canRegenerateFeaturedImage}
                    title={
                      !canRegenerateFeaturedImage
                        ? imageRegenExhausted
                          ? "The max featured image regeneration limit is exhausted for this article."
                          : "Generate an article image first."
                        : "Regenerate only the featured image using a saved or one-time custom prompt."
                    }
                  >
                    {imageRegenBusy ? "Regenerating image…" : "Regenerate featured image"}
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
                  <h2 className={editorStyles.sectionTitlePrimary}>WordPress</h2>
                  <p className={editorStyles.wpCardDesc}>
                    {isScheduledArticle
                      ? "This article is scheduled. Update is available after it is published live on WordPress."
                      : showUpdateWordPress
                        ? "Push edits to your live WordPress post when you change text or the featured image."
                        : showPublishWordPress
                          ? "Publish when the article is ready (draft or pending — not yet live on WordPress)."
                          : "WordPress actions depend on article status."}
                  </p>
                </div>
                <div className={editorStyles.wpActions}>
                  {showUpdateWordPress ? (
                    <button
                      className={`${styles.button} ${canUpdateWordPress ? styles.wpUpdateButtonActive : ""}`}
                      type="button"
                      onClick={updateWordPressPost}
                      disabled={!canUpdateWordPress}
                      title={
                        !hasPendingWpChanges
                          ? "Edit the article or regenerate the featured image to enable update"
                          : !websiteConnected
                            ? "Connect WordPress in project settings"
                            : "Save changes to your live WordPress post"
                      }
                    >
                      {wpUpdateBusy ? "Updating…" : "Update article"}
                    </button>
                  ) : null}
                  {showPublishWordPress ? (
                    <button className={styles.button} type="button" onClick={publishToLiveSite} disabled={!canPublish}>
                      Publish
                    </button>
                  ) : null}
                </div>
              </div>
              {showUpdateWordPress && hasPendingWpChanges && !canUpdateWordPress && websiteConnected ? (
                <div className={styles.muted} style={{ fontSize: 12, marginTop: 10 }}>
                  Add a title and body content to enable update.
                </div>
              ) : null}

              {!editorLocked && !wpPostTypes.length && !wpCategories.length ? (
                <div className={styles.row} style={{ paddingTop: 10 }}>
                  <button className={styles.btnSecondary} type="button" onClick={ensureWpMetaLoaded} disabled={wpMetaLoading}>
                    {wpMetaLoading ? "Loading…" : "Load WordPress settings"}
                  </button>
                  <div className={styles.muted} style={{ fontSize: 12 }}>
                    Optional. Defaults will be used if not loaded.
                  </div>
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
            </div>
          </div>
          </div>
        </section>
      </main>
    </div>
  );
}

