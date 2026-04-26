"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import styles from "../../../../page.module.css";
import {
  api,
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
  const [uploadedImagePreview, setUploadedImagePreview] = useState<string>("");
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
    if (!uploadedImageFile) {
      setUploadedImagePreview("");
      return;
    }
    const url = URL.createObjectURL(uploadedImageFile);
    setUploadedImagePreview(url);
    return () => URL.revokeObjectURL(url);
  }, [uploadedImageFile]);

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
        const [a, wp, ip] = await Promise.all([
          api.getArticle(params.projectId, params.articleId),
          api.listWritingPrompts(params.projectId),
          api.listImagePrompts(params.projectId),
        ]);
        setArticle(a);
        setWritingPrompts(wp);
        setImagePrompts(ip);

        setTitle(a.title || "");
        setKeywords(kwToString(a.keywords));
        setFocus(a.focus_keyphrase || "");
        setBody(a.article || "");
        setMetaTitle(a.meta_title || "");
        setMetaDesc(a.meta_description || "");
        setGeneratedImageUrl(a.image_url || "");

        setWritingPromptId(wp.default_id || "");
        setImagePromptId(ip.default_id || "");

        // WordPress options (best effort)
        try {
          const [types, cats, ps] = await Promise.all([
            api.wordpressPostTypes(params.projectId),
            api.wordpressCategories(params.projectId),
            api.getProjectSettings(params.projectId),
          ]);
          setWpPostTypes(types);
          setWpCategories(cats);
          if (types.find((t) => t.rest_base === "posts")) setWpPostType("posts");
          setWpPostType((ps.default_wp_rest_base || "posts") as string);
          setWpStatus(((ps.default_wp_status || "draft") as "draft" | "publish"));
          setWpCategoryIds((ps.default_wp_category_ids || []) as number[]);
        } catch {
          // ignore; user may not have WP connected yet
        }
      } catch (e) {
        clearAuth();
        router.replace("/login");
      } finally {
        setLoading(false);
      }
    })();
  }, [params.articleId, params.projectId, router, token]);

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
      setError(e instanceof Error ? e.message : "Save failed");
    }
  }

  async function generate() {
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
      if (res.generated?.meta_title !== undefined) setMetaTitle(res.generated.meta_title || "");
      if (res.generated?.meta_description !== undefined) setMetaDesc(res.generated.meta_description || "");
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
      setError(e instanceof Error ? e.message : "Publish to live site failed");
    }
  }

  return (
    <div className={`${styles.page} ${styles.pageTop}`}>
      <main className={`${styles.main} ${styles.mainWide}`}>
        <div className={styles.intro}>
          <h1>Article</h1>
          <p>
            <Link href={`/projects/${params.projectId}`}>← Back to project</Link>
          </p>
        </div>

        <div className={styles.row}>
          <span className={styles.pill}>Status: {article?.status || "…"}</span>
          {article?.wp_scheduled_at ? (
            <span className={styles.pill}>Scheduled: {article.wp_scheduled_at}</span>
          ) : null}
          {article?.posted_at ? (
            <span className={styles.pill}>Posted: {article.posted_at}</span>
          ) : null}
        </div>

        {error ? <div className={`${styles.card} ${styles.cardWide}`}><p className={styles.error}>{error}</p></div> : null}
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
          <div className={`${styles.card} ${styles.cardWide}`}>
            <h2>Generate</h2>
            {loading ? <p>Loading…</p> : null}
            <label className={styles.label}>
              Writing prompt
              <select
                className={styles.input}
                value={writingPromptId}
                onChange={(e) => setWritingPromptId(e.target.value)}
                disabled={isPublished}
              >
                <option value="">Project default</option>
                {(writingPrompts?.items || []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            {writingPrompts?.default_id ? (
              <div className={styles.muted} style={{ fontSize: 12 }}>
                Default writing prompt:{" "}
                <strong>{writingPrompts.items.find((x) => x.id === writingPrompts.default_id)?.name || writingPrompts.default_id}</strong>
                {writingPromptId && writingPromptId !== writingPrompts.default_id ? (
                  <>
                    {" · "}
                    <button
                      type="button"
                      className={styles.btnSecondary}
                      style={{ padding: "6px 10px", fontSize: 12 }}
                      disabled={isPublished}
                      onClick={async () => {
                        try {
                          setError(null);
                          await api.setDefaultWritingPrompt(params.projectId, writingPromptId);
                          const wp = await api.listWritingPrompts(params.projectId);
                          setWritingPrompts(wp);
                          setNotice("Default writing prompt updated.");
                        } catch (e) {
                          setError(e instanceof Error ? e.message : "Failed to set default writing prompt");
                        }
                      }}
                    >
                      Set selected as default
                    </button>
                  </>
                ) : null}
              </div>
            ) : null}
            <label className={styles.label}>
              Image prompt
              <select
                className={styles.input}
                value={imagePromptId}
                onChange={(e) => setImagePromptId(e.target.value)}
                disabled={isPublished}
              >
                <option value="">Project default</option>
                {(imagePrompts?.items || []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            {imagePrompts?.default_id ? (
              <div className={styles.muted} style={{ fontSize: 12 }}>
                Default image prompt:{" "}
                <strong>{imagePrompts.items.find((x) => x.id === imagePrompts.default_id)?.name || imagePrompts.default_id}</strong>
                {imagePromptId && imagePromptId !== imagePrompts.default_id ? (
                  <>
                    {" · "}
                    <button
                      type="button"
                      className={styles.btnSecondary}
                      style={{ padding: "6px 10px", fontSize: 12 }}
                      disabled={isPublished}
                      onClick={async () => {
                        try {
                          setError(null);
                          await api.setDefaultImagePrompt(params.projectId, imagePromptId);
                          const ip = await api.listImagePrompts(params.projectId);
                          setImagePrompts(ip);
                          setNotice("Default image prompt updated.");
                        } catch (e) {
                          setError(e instanceof Error ? e.message : "Failed to set default image prompt");
                        }
                      }}
                    >
                      Set selected as default
                    </button>
                  </>
                ) : null}
              </div>
            ) : null}
            <label className={styles.label}>
              Focus keyphrase (Yoast)
              <input
                className={styles.input}
                value={focus}
                onChange={(e) => setFocus(e.target.value)}
                placeholder="Optional"
                disabled={isPublished}
              />
            </label>
            <label className={styles.label}>
              Generate image
              <select
                className={styles.input}
                value={generateImage ? "yes" : "no"}
                onChange={(e) => setGenerateImage(e.target.value === "yes")}
                disabled={isPublished}
              >
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

            <h2 style={{ marginTop: 6 }}>Fields</h2>
            <label className={styles.label}>
              Title
              <input
                className={styles.input}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                disabled={isPublished}
              />
            </label>
            <label className={styles.label}>
              Targeting keywords (comma-separated)
              <input
                className={styles.input}
                value={keywords}
                onChange={(e) => setKeywords(e.target.value)}
                disabled={isPublished}
              />
            </label>
            <label className={styles.label}>
              Meta title
              <input
                className={styles.input}
                value={metaTitle}
                onChange={(e) => setMetaTitle(e.target.value)}
                disabled={isPublished}
              />
            </label>
            <label className={styles.label}>
              Meta description
              <input
                className={styles.input}
                value={metaDesc}
                onChange={(e) => setMetaDesc(e.target.value)}
                disabled={isPublished}
              />
            </label>
          </div>

          <div className={`${styles.card} ${styles.cardWide}`}>
            <h2>Result</h2>
            <div style={{ display: "grid", gap: 10, marginBottom: 10 }}>
              <div
                style={{
                  border: "1px solid var(--button-secondary-border)",
                  borderRadius: 14,
                  overflow: "hidden",
                  background: "color-mix(in oklab, var(--foreground), var(--background) 10%)",
                  minHeight: 180,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {generateImage ? (
                  generatedImageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={generatedImageUrl}
                      alt="Generated preview"
                      style={{ width: "100%", height: "100%", objectFit: "cover" }}
                    />
                  ) : (
                    <div style={{ color: "#666", fontSize: 13, padding: 12, textAlign: "center" }}>
                      Image will be generated using the selected (or default) image prompt.
                      <div style={{ marginTop: 6, opacity: 0.9 }}>Once ready, it will appear here.</div>
                    </div>
                  )
                ) : uploadedImagePreview ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={uploadedImagePreview}
                    alt="Uploaded preview"
                    style={{ width: "100%", height: "100%", objectFit: "cover" }}
                  />
                ) : (
                  <div style={{ color: "#666", fontSize: 13, padding: 12, textAlign: "center" }}>
                    No image selected. Upload an image to include when publishing.
                  </div>
                )}
              </div>

              {!generateImage ? (
                <label className={styles.label}>
                  Upload image (used on publish)
                  <input
                    className={styles.input}
                    type="file"
                    accept="image/*"
                    disabled={isPublished}
                    onChange={(e) => setUploadedImageFile(e.target.files?.[0] || null)}
                  />
                </label>
              ) : null}
            </div>
            <textarea
              className={styles.textarea}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Article markdown/body…"
              disabled={isPublished}
            />
          </div>
        </div>

        <div className={`${styles.card} ${styles.cardWide}`} style={{ marginTop: 14 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <div>
              <div style={{ fontWeight: 900 }}>Publish to live site</div>
              <div className={styles.muted} style={{ fontSize: 12 }}>
                Enabled after content is ready. If you selected “Generate image: No”, upload an image first.
              </div>
            </div>
            <button className={styles.button} type="button" onClick={publishToLiveSite} disabled={!canPublish}>
              Publish To Live Site
            </button>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 12 }}>
            <label className={styles.label}>
              WordPress post type
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
              Publish as
              <select className={styles.input} value={wpStatus} onChange={(e) => setWpStatus(e.target.value as "draft" | "publish")} disabled={isPublished}>
                <option value="draft">Draft</option>
                <option value="publish">Publish</option>
              </select>
            </label>
          </div>

          <label className={styles.label} style={{ marginTop: 10 }}>
            WordPress categories
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
        </div>
      </main>
    </div>
  );
}

