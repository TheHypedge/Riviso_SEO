"use client";

import { useState } from "react";

import styles from "@/app/page.module.css";
import AuthorSelect from "@/components/AuthorSelect";
import InnerImageCountField from "@/components/InnerImageCountField";
import { ShopifyProductMapPicker } from "@/components/shopify/ShopifyProductMapPicker";
import { WordPressPageMapPicker } from "@/components/wordpress/WordPressPageMapPicker";
import type { AuthorFields, PromptListResponse, WordpressCategory, WordpressPostType } from "@/lib/api";
import type { MappedShopifyProduct, ShopifyCatalogProduct } from "@/lib/shopifyProductMapping";
import { useFocusTrap } from "@/lib/useFocusTrap";
import type { MappedWordPressPage, SiteMapEntry } from "@/lib/wordpressPageMapping";

export type BulkGenerateValues = {
  writingPromptId: string;
  imagePromptId: string;
  generateImage: boolean;
  innerImageCount: number;
  postType: string;
  wpStatus: "draft" | "publish";
  /** Empty = keep each article's existing category. */
  categoryIds: number[];
  mappedPages: MappedWordPressPage[];
  mappedProducts: MappedShopifyProduct[];
  /** Null = keep each article's author (else the project default). */
  author: AuthorFields | null;
};

type Props = {
  projectId: string;
  count: number;
  isShopify: boolean;
  writingPrompts: PromptListResponse | null;
  imagePrompts: PromptListResponse | null;
  wpTypes: WordpressPostType[];
  cats: WordpressCategory[];
  defaults: { postType: string; wpStatus: "draft" | "publish" };
  innerImagesLeft?: number | null;
  siteMapEntries: SiteMapEntry[];
  siteMapLoading: boolean;
  internalLinkAware: boolean;
  shopifyProductAware?: boolean;
  /** Project Settings deep links for the automatic-mapping switches. */
  wpSettingsHref?: string;
  shopifySettingsHref?: string;
  shopifyProducts: ShopifyCatalogProduct[];
  shopifyLoading: boolean;
  shopifyScopes: string[];
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (values: BulkGenerateValues) => void;
};

/** Articles tab → Actions → Generate articles: the same options as every other generate form. */
export default function BulkGenerateModal(p: Props) {
  const trapRef = useFocusTrap(true);
  const [v, setV] = useState<BulkGenerateValues>(() => ({
    writingPromptId: p.writingPrompts?.default_id || "",
    imagePromptId: p.imagePrompts?.default_id || "",
    generateImage: true,
    innerImageCount: 0,
    postType: p.defaults.postType || "posts",
    wpStatus: p.defaults.wpStatus === "publish" ? "publish" : "draft",
    categoryIds: [],
    mappedPages: [],
    mappedProducts: [],
    author: null,
  }));
  const set = <K extends keyof BulkGenerateValues>(k: K, val: BulkGenerateValues[K]) => setV((s) => ({ ...s, [k]: val }));
  const freeCats = p.cats.filter((c) => !v.categoryIds.includes(c.id));

  return (
    <>
      <button type="button" className={styles.modalBackdrop} aria-label="Close" onClick={p.busy ? undefined : p.onCancel} />
      <div ref={trapRef} className={styles.modalPanel} role="dialog" aria-modal="true" aria-label="Generate articles">
        <div className={styles.modalHead}>
          <h3 className={styles.modalTitle}>
            Generate {p.count} article{p.count === 1 ? "" : "s"}
          </h3>
        </div>
        <div className={styles.modalBody}>
          <p className={styles.muted} style={{ margin: 0, lineHeight: 1.55 }}>
            Each selected article is written with these settings and queued in the background. Progress shows in the list.
          </p>
          <label className={styles.label}>
            Writing prompt
            <select className={styles.input} value={v.writingPromptId} onChange={(e) => set("writingPromptId", e.target.value)}>
              <option value="">Project default</option>
              {(p.writingPrompts?.items || []).map((x) => (
                <option key={x.id} value={x.id}>{x.name || x.id}</option>
              ))}
            </select>
          </label>
          <label className={styles.label} style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
            <input type="checkbox" checked={v.generateImage} onChange={(e) => set("generateImage", e.target.checked)} />
            Generate featured image
          </label>
          <label className={styles.label} style={{ opacity: v.generateImage ? 1 : 0.5 }}>
            Image prompt
            <select
              className={styles.input}
              value={v.imagePromptId}
              disabled={!v.generateImage}
              onChange={(e) => set("imagePromptId", e.target.value)}
            >
              <option value="">Project default</option>
              {(p.imagePrompts?.items || []).map((x) => (
                <option key={x.id} value={x.id}>{x.name || x.id}</option>
              ))}
            </select>
          </label>
          <InnerImageCountField value={v.innerImageCount} onChange={(n) => set("innerImageCount", n)} monthRemaining={p.innerImagesLeft} />
          <AuthorSelect projectId={p.projectId} value={v.author} onChange={(a) => set("author", a)} label="Publish as (author)" />

          {!p.isShopify ? (
            <>
              <label className={styles.label}>
                WordPress post type
                <select className={styles.input} value={v.postType} onChange={(e) => set("postType", e.target.value)}>
                  <option value="posts">Posts</option>
                  <option value="pages">Pages</option>
                  {p.wpTypes
                    .filter((t) => t.rest_base && !["posts", "pages"].includes(t.rest_base))
                    .map((t) => (
                      <option key={t.rest_base} value={t.rest_base}>{t.name || t.rest_base}</option>
                    ))}
                </select>
              </label>
              <label className={styles.label}>
                WordPress status
                <select className={styles.input} value={v.wpStatus} onChange={(e) => set("wpStatus", e.target.value as "draft" | "publish")}>
                  <option value="draft">Draft</option>
                  <option value="publish">Publish</option>
                </select>
                <span className={styles.muted} style={{ fontSize: 12, marginTop: 6, display: "block" }}>
                  Publish posts each article live to WordPress as soon as it is generated. Draft keeps it in Riviso to review first.
                </span>
              </label>
              <label className={styles.label}>
                Category
                <select
                  className={styles.input}
                  value=""
                  disabled={!freeCats.length}
                  onChange={(e) => {
                    const id = Number(e.target.value);
                    if (id > 0) set("categoryIds", [...v.categoryIds, id]);
                  }}
                >
                  <option value="">{p.cats.length ? "+ Add a category…" : "No WordPress categories loaded"}</option>
                  {freeCats.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
                {v.categoryIds.length ? (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
                    {v.categoryIds.map((id) => (
                      <button
                        key={id}
                        type="button"
                        className={styles.chipOption}
                        data-selected="true"
                        data-removable="true"
                        aria-label={`Remove category “${p.cats.find((c) => c.id === id)?.name || id}”`}
                        onClick={() => set("categoryIds", v.categoryIds.filter((x) => x !== id))}
                      >
                        {p.cats.find((c) => c.id === id)?.name || `#${id}`}
                      </button>
                    ))}
                  </div>
                ) : null}
                <span className={styles.muted} style={{ fontSize: 12, marginTop: 6, display: "block" }}>
                  Leave empty to keep each article&apos;s existing category.
                </span>
              </label>
              <WordPressPageMapPicker
                entries={p.siteMapEntries}
                value={v.mappedPages}
                onChange={(next) => set("mappedPages", next)}
                loading={p.siteMapLoading}
                internalLinkAwareEnabled={p.internalLinkAware}
                settingsHref={p.wpSettingsHref}
              />
            </>
          ) : (
            <ShopifyProductMapPicker
              products={p.shopifyProducts}
              value={v.mappedProducts}
              onChange={(next) => set("mappedProducts", next)}
              loading={p.shopifyLoading}
              grantedScopes={p.shopifyScopes}
              autoSettingsHref={p.shopifyProductAware ? undefined : p.shopifySettingsHref}
            />
          )}
          {p.error ? <p className={styles.error} role="alert" style={{ margin: 0 }}>{p.error}</p> : null}
        </div>
        <div className={styles.modalFooter}>
          <button type="button" className={styles.btnSecondary} onClick={p.onCancel} disabled={p.busy}>
            Cancel
          </button>
          <button type="button" className={styles.button} onClick={() => p.onSubmit(v)} disabled={p.busy}>
            {p.busy ? "Queuing…" : `Generate ${p.count} article${p.count === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
    </>
  );
}
