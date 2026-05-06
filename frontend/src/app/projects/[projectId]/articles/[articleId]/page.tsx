"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import styles from "../../../../page.module.css";
import projectsDark from "../../projectsDark.module.css";
import {
  api,
  ApiError,
  ArticleDetail,
  clearAuth,
  getAccessToken,
  PromptListResponse,
} from "@/lib/api";

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

function seoMeter(len: number, max: number): { percent: number; state: "warning" | "excellent"; label: string } {
  if (!len) return { percent: 0, state: "warning", label: "Missing" };
  if (len > max) return { percent: 100, state: "warning", label: "Too long" };
  if (len < Math.max(20, Math.floor(max * 0.5))) return { percent: Math.max(6, Math.round((len / max) * 100)), state: "warning", label: "Too short" };
  return { percent: Math.round((len / max) * 100), state: "excellent", label: "Excellent" };
}

export default function ArticleEditPage() {
  const params = useParams<{ projectId: string; articleId: string }>();
  const router = useRouter();
  const token = useMemo(() => getAccessToken(), []);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [article, setArticle] = useState<ArticleDetail | null>(null);
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
  const isPublished = (article?.status || "").toLowerCase() === "published";

  // WordPress publish options
  const [wpPostTypes, setWpPostTypes] = useState<{ rest_base: string; name: string; taxonomies: string[] }[]>([]);
  const [wpCategories, setWpCategories] = useState<{ id: number; name: string }[]>([]);
  const [wpPostType, setWpPostType] = useState("posts");
  const [wpStatus, setWpStatus] = useState<"draft" | "publish">("draft");
  const [wpCategoryIds, setWpCategoryIds] = useState<number[]>([]);

  // Regenerate confirmation
  const [showRegenConfirm, setShowRegenConfirm] = useState(false);

  useEffect(() => {
    if (!uploadedImagePreview) return;
    return () => URL.revokeObjectURL(uploadedImagePreview);
  }, [uploadedImagePreview]);

  useEffect(() => {
    if (!token) {
      router.replace("/login");
      return;
    }
    (async () => {
      setError(null);
      setNotice(null);
      setLoading(true);
      try {
        const a = await api.getArticle(params.projectId, params.articleId);
        // Prompts are not required to *view/edit* the article; lazy-load them on demand.
        const wp = null;
        const ip = null;

        setArticle(a);
        if (wp) setWritingPrompts(wp);
        if (ip) setImagePrompts(ip);

        setTitle(a.title || "");
        setKeywords(kwToString(a.keywords));
        setFocus(a.focus_keyphrase || "");
        setBody(a.article || "");
        setMetaTitle(a.meta_title || "");
        setMetaDesc(a.meta_description || "");
        setGeneratedImageUrl(a.image_url || "");

        setWritingPromptId("");
        setImagePromptId("");

        // WordPress metadata is only required when the user publishes. Load on demand.
      } catch (e) {
        if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
          clearAuth();
          router.replace("/login");
          return;
        }
        setError(e instanceof Error ? e.message : "Failed to load article");
      } finally {
        setLoading(false);
      }
    })();
  }, [params.articleId, params.projectId, router, token]);

  async function ensurePromptsLoaded() {
    if (promptsLoading) return;
    if (writingPrompts && imagePrompts) return;
    setPromptsLoading(true);
    try {
      const [wpRes, ipRes] = await Promise.allSettled([
        api.listWritingPrompts(params.projectId),
        api.listImagePrompts(params.projectId),
      ]);
      const wp = wpRes.status === "fulfilled" ? wpRes.value : null;
      const ip = ipRes.status === "fulfilled" ? ipRes.value : null;
      if (wp) {
        setWritingPrompts(wp);
        if (!writingPromptId) setWritingPromptId(wp.default_id || "");
      }
      if (ip) {
        setImagePrompts(ip);
        if (!imagePromptId) setImagePromptId(ip.default_id || "");
      }
    } catch {
      // ignore
    } finally {
      setPromptsLoading(false);
    }
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
    const alreadyGenerated =
      !!(body || "").trim() || !!(metaTitle || "").trim() || !!(metaDesc || "").trim() || !!generatedImageUrl;
    if (alreadyGenerated) {
      setShowRegenConfirm(true);
      return;
    }
    return doGenerate();
  }

  async function doGenerate() {
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
      if (e instanceof ApiError && e.status === 408) {
        setError(e.message);
        return;
      }
      setError(e instanceof Error ? e.message : "Generate request failed");
    }
  }

  const canPublish =
    !isPublished &&
    !!title.trim() &&
    !!body.trim() &&
    (generateImage ? true : !!uploadedImageFile);

  async function publishToLiveSite() {
    setError(null);
    setNotice(null);
    try {
      const res = await api.publishArticleToLiveSite(params.projectId, params.articleId, {
        image_file: generateImage ? null : uploadedImageFile,
        post_type: wpPostType,
        wp_status: wpStatus,
        category_ids: wpCategoryIds,
      });
      setNotice(`${res.status}: ${res.message}${res.wp_link ? `\n${res.wp_link}` : ""}`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 408) {
        setError(e.message);
        return;
      }
      setError(e instanceof Error ? e.message : "Publish to live site failed");
    }
  }

  return (
    <div className={`${styles.page} ${styles.pageTop} ${projectsDark.projectsDark}`}>
      <main className={`${styles.main} ${styles.mainWide}`}>
        <section className={styles.contentCol}>
          <div className={styles.intro} style={{ paddingTop: 0 }}>
            <h1>Article</h1>
            <p>
              <Link href={`/projects/${params.projectId}`}>← Back to project</Link>
            </p>
          </div>

          <div className={styles.row}>
            <span className={styles.pill}>Status: {article?.status || "…"}</span>
            {article?.wp_scheduled_at ? <span className={styles.pill}>Scheduled: {article.wp_scheduled_at}</span> : null}
            {article?.posted_at ? <span className={styles.pill}>Posted: {article.posted_at}</span> : null}
          </div>

          {error ? (
            <div className={`${styles.card} ${styles.cardWide}`}>
              <p className={styles.error}>{error}</p>
            </div>
          ) : null}
          {notice ? (
            <div className={`${styles.card} ${styles.cardWide}`}>
              <p style={{ color: "#666", lineHeight: 1.5 }}>{notice}</p>
            </div>
          ) : null}

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

          <div className={styles.editorGrid}>
          <div className={styles.editorCol}>
            <div className={`${styles.card} ${styles.cardWide}`}>
              <h2>Prompts</h2>
              {!isPublished && !writingPrompts && !imagePrompts ? (
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
                <select className={styles.input} value={writingPromptId} onChange={(e) => setWritingPromptId(e.target.value)} disabled={isPublished}>
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
                <select className={styles.input} value={imagePromptId} onChange={(e) => setImagePromptId(e.target.value)} disabled={isPublished}>
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
                <input className={styles.input} value={focus} onChange={(e) => setFocus(e.target.value)} placeholder="Optional" disabled={isPublished} />
              </label>

              <label className={styles.label}>
                Generate image
                <select className={styles.input} value={generateImage ? "yes" : "no"} onChange={(e) => setGenerateImage(e.target.value === "yes")} disabled={isPublished}>
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </select>
              </label>

              <div className={styles.row}>
                <button className={styles.button} type="button" onClick={generate} disabled={isPublished}>
                  Generate
                </button>
                <button className={styles.button} type="button" onClick={save} disabled={isPublished}>
                  Save
                </button>
              </div>
            </div>

            <div className={`${styles.card} ${styles.cardWide}`}>
              <h2>SEO</h2>
              <label className={styles.label}>
                Title
                <input className={styles.input} value={title} onChange={(e) => setTitle(e.target.value)} disabled={isPublished} />
              </label>
              <label className={styles.label}>
                Meta title
                <input
                  className={styles.input}
                  value={metaTitle}
                  onChange={(e) => setMetaTitle(clampChars(e.target.value, META_TITLE_MAX))}
                  disabled={isPublished}
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
                  disabled={isPublished}
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

          <div className={styles.editorCol}>
            <div className={`${styles.card} ${styles.cardWide} ${styles.articleEditorCard}`}>
              <h2>Article content</h2>
              <textarea
                className={`${styles.textarea} ${styles.articleTextareaFull}`}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="Article markdown/body…"
                disabled={isPublished}
              />
            </div>
          </div>

          <div className={styles.editorCol}>
            <div className={`${styles.card} ${styles.cardWide}`}>
              <h2>Featured image</h2>
              <div className={styles.articleImageFrame}>
                {generateImage ? (
                  generatedImageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={generatedImageUrl} alt="Generated preview" className={styles.articleImage} />
                  ) : (
                    <div style={{ color: "#666", fontSize: 13, padding: 12, textAlign: "center" }}>
                      Image will be generated using the selected (or default) image prompt.
                      <div style={{ marginTop: 6, opacity: 0.9 }}>Once ready, it will appear here.</div>
                    </div>
                  )
                ) : uploadedImagePreview ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={uploadedImagePreview} alt="Uploaded preview" className={styles.articleImage} />
                ) : (
                  <div style={{ color: "#666", fontSize: 13, padding: 12, textAlign: "center" }}>No image selected.</div>
                )}
              </div>

              {!generateImage ? (
                <label className={styles.label} style={{ marginTop: 10 }}>
                  Upload image (used on publish)
                  <input className={styles.input} type="file" accept="image/*" disabled={isPublished} onChange={(e) => setUploadedImageFile(e.target.files?.[0] || null)} />
                </label>
              ) : null}
            </div>

            <div className={`${styles.card} ${styles.cardWide}`}>
              <h2>Tags</h2>
              <label className={styles.label}>
                Targeting keywords (comma-separated)
                <input className={styles.input} value={keywords} onChange={(e) => setKeywords(e.target.value)} disabled={isPublished} />
              </label>
              <div className={styles.muted} style={{ fontSize: 12 }}>
                Tip: keep this focused (5–10 keywords max).
              </div>
            </div>

            <div className={`${styles.card} ${styles.cardWide}`}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                <div>
                  <h2 style={{ margin: 0 }}>WordPress</h2>
                  <div className={styles.muted} style={{ fontSize: 12, marginTop: 4 }}>
                    Post to WordPress when content is ready.
                  </div>
                </div>
                <button className={styles.button} type="button" onClick={publishToLiveSite} disabled={!canPublish}>
                  Publish
                </button>
              </div>

              {!isPublished && !wpPostTypes.length && !wpCategories.length ? (
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
                      <select className={styles.input} value={wpPostType} onChange={(e) => setWpPostType(e.target.value)} disabled={isPublished}>
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
                      <select className={styles.input} value={wpStatus} onChange={(e) => setWpStatus(e.target.value as "draft" | "publish")} disabled={isPublished}>
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
                      disabled={isPublished}
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

