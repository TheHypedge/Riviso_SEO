"use client";

import { useEffect, useState } from "react";

import styles from "@/app/page.module.css";
import { api, type AuthorFields, type ProjectSettings, type WordpressAuthorsResponse } from "@/lib/api";
import { resolveProjectPlatform } from "@/lib/projectPlatform";

type Props = {
  projectId: string;
  /** The article's / form's current choice; null or empty = nothing chosen yet (project default applies). */
  value?: AuthorFields | null;
  onChange: (next: AuthorFields) => void;
  disabled?: boolean;
  label?: string;
};

/**
 * Post author picker shared by every generate / schedule / publish form and the editor.
 * Pre-selects the article's author, else the project default, else the connected WordPress user,
 * so a post always has an author. Settings and the WordPress author list come from the api
 * caches (one request per project), so mounting several pickers costs no extra round-trips.
 */
export default function AuthorSelect({ projectId, value, onChange, disabled, label = "Author" }: Props) {
  const [settings, setSettings] = useState<ProjectSettings | null>(null);
  const [wp, setWp] = useState<WordpressAuthorsResponse | null>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let live = true;
    api
      .getProjectSettings(projectId)
      .then((s) => {
        if (!live) return;
        setSettings(s);
        if (resolveProjectPlatform({ settings: s }) !== "shopify") {
          api
            .getWordpressAuthors(projectId)
            .then((r) => live && setWp(r))
            .catch(() => live && setLoadError(true));
        }
      })
      .catch(() => live && setLoadError(true));
    return () => {
      live = false;
    };
  }, [projectId]);

  const isShopify = settings ? resolveProjectPlatform({ settings }) === "shopify" : false;
  const href = `/projects/${encodeURIComponent(projectId)}?tab=project_settings&settings=connection&focus=default-author`;
  const manage = (
    <a href={href} target="_blank" rel="noopener noreferrer" style={{ fontWeight: 700, textDecoration: "underline", color: "inherit" }}>
      Project Settings
    </a>
  );

  if (isShopify) {
    const names = settings?.shopify_authors || [];
    const selected = (value?.shopify_author || "").trim() || (settings?.default_shopify_author || "").trim() || names[0] || "";
    return (
      <label className={styles.label}>
        {label}
        <select className={styles.input} value={selected} disabled={disabled || !names.length} onChange={(e) => onChange({ shopify_author: e.target.value })}>
          {!names.length ? <option value="">Store default</option> : null}
          {names.map((n) => (
            <option key={n} value={n}>
              {n}
              {n === settings?.default_shopify_author ? " (project default)" : ""}
            </option>
          ))}
        </select>
        {!names.length ? (
          <span className={styles.muted} style={{ fontSize: 12, marginTop: 6, display: "block" }}>
            Add author names in {manage} to choose who each article is published by.
          </span>
        ) : null}
      </label>
    );
  }

  const authors = wp?.authors || [];
  const defaultId = settings?.default_wp_author_id || null;
  const selectedId = value?.wp_author_id || defaultId || wp?.current?.id || 0;
  const loading = !settings || (!wp && !loadError);
  const selectedMissing = Boolean(selectedId) && !!wp && !authors.some((a) => a.id === selectedId);

  return (
    <label className={styles.label}>
      {label}
      <select
        className={styles.input}
        value={selectedId || ""}
        disabled={disabled || loading || !authors.length}
        onChange={(e) => {
          const id = Number(e.target.value);
          const a = authors.find((x) => x.id === id);
          if (a) onChange({ wp_author_id: a.id, wp_author_name: a.name });
        }}
      >
        {loading ? <option value={selectedId || ""}>{value?.wp_author_name || settings?.default_wp_author_name || "Loading authors…"}</option> : null}
        {!loading && !authors.length ? (
          <option value={selectedId || ""}>{value?.wp_author_name || settings?.default_wp_author_name || "Connected WordPress user"}</option>
        ) : null}
        {selectedMissing ? <option value={selectedId}>{value?.wp_author_name || settings?.default_wp_author_name || `User #${selectedId}`} (not found on site)</option> : null}
        {authors.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
            {a.id === defaultId ? " (project default)" : a.id === wp?.current?.id ? " (connected user)" : ""}
          </option>
        ))}
      </select>
      {wp && !wp.can_assign && authors.length > 1 ? (
        <span className={styles.muted} style={{ fontSize: 12, marginTop: 6, display: "block" }}>
          The connected WordPress user can only publish as themself. Reconnect with an Editor or Administrator to publish as other authors.
        </span>
      ) : null}
      {loadError ? (
        <span className={styles.muted} style={{ fontSize: 12, marginTop: 6, display: "block" }}>
          Couldn&apos;t load WordPress authors. The post uses the default author from {manage}.
        </span>
      ) : null}
    </label>
  );
}
