"use client";

import { useEffect, useState } from "react";

import styles from "@/app/page.module.css";
import { api, type ProjectSettings, type WordpressAuthorsResponse } from "@/lib/api";

type Props = {
  projectId: string;
  platform: "wordpress" | "shopify";
  settings: ProjectSettings;
  /** Receives only the author fields of the saved settings (other form edits stay untouched). */
  onSaved: (patch: Pick<ProjectSettings, "default_wp_author_id" | "default_wp_author_name" | "shopify_authors" | "default_shopify_author">) => void;
  onMessage: (message: string, tone: "success" | "error") => void;
};

/** Project Settings -> default post author. Saves on change, like the other switches on this page. */
export default function DefaultAuthorSetting({ projectId, platform, settings, onSaved, onMessage }: Props) {
  const [wp, setWp] = useState<WordpressAuthorsResponse | null>(null);
  const [loading, setLoading] = useState(platform === "wordpress");
  const [saving, setSaving] = useState(false);
  const [newName, setNewName] = useState("");

  const refresh = () => {
    setLoading(true);
    api
      .getWordpressAuthors(projectId, { refresh: true })
      .then(setWp)
      .catch(() => onMessage("Couldn't load WordPress authors. Check the WordPress connection.", "error"))
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    if (platform !== "wordpress") return;
    let live = true;
    api
      .getWordpressAuthors(projectId)
      .then((r) => live && setWp(r))
      .catch(() => live && onMessage("Couldn't load WordPress authors. Check the WordPress connection.", "error"))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per project; onMessage is a fresh closure each render
  }, [projectId, platform]);

  async function save(patch: Parameters<typeof api.updateProjectSettings>[1]) {
    setSaving(true);
    try {
      const saved = await api.updateProjectSettings(projectId, patch);
      onSaved({
        default_wp_author_id: saved.default_wp_author_id ?? null,
        default_wp_author_name: saved.default_wp_author_name ?? null,
        shopify_authors: saved.shopify_authors || [],
        default_shopify_author: saved.default_shopify_author ?? null,
      });
      onMessage("Default author saved", "success");
    } catch (e) {
      onMessage(e instanceof Error ? e.message : "Could not save the default author", "error");
    } finally {
      setSaving(false);
    }
  }

  if (platform === "shopify") {
    const names = settings.shopify_authors || [];
    const add = () => {
      const n = newName.trim().replace(/\s+/g, " ");
      if (!n || names.some((x) => x.toLowerCase() === n.toLowerCase())) return;
      setNewName("");
      void save({ shopify_authors: [...names, n], ...(names.length ? {} : { default_shopify_author: n }) });
    };
    return (
      <div id="default-author" className={styles.label} style={{ display: "grid", gap: 8 }}>
        <span>Authors</span>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {names.map((n) => (
            <button
              key={n}
              type="button"
              className={styles.chipOption}
              data-selected="true"
              data-removable="true"
              disabled={saving}
              aria-label={`Remove author “${n}”`}
              onClick={() => void save({ shopify_authors: names.filter((x) => x !== n) })}
            >
              {n}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            className={styles.input}
            placeholder="Add an author name"
            value={newName}
            maxLength={200}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
          />
          <button type="button" className={styles.btnSecondary} onClick={add} disabled={saving || !newName.trim() || names.length >= 20}>
            Add
          </button>
        </div>
        <label className={styles.label}>
          Default author
          <select
            className={styles.input}
            value={settings.default_shopify_author || ""}
            disabled={saving || !names.length}
            onChange={(e) => void save({ default_shopify_author: e.target.value })}
          >
            <option value="">Store default</option>
            {names.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </label>
        <span className={styles.muted} style={{ fontSize: 12 }}>
          Shown as the article author on your Shopify blog. Every generate, schedule and publish form pre-selects the default; you can change it per article.
        </span>
      </div>
    );
  }

  const authors = wp?.authors || [];
  const current = wp?.current;
  return (
    <div id="default-author" className={styles.label} style={{ display: "grid", gap: 6 }}>
      <span>Default author</span>
      <div style={{ display: "flex", gap: 8 }}>
        <select
          className={styles.input}
          value={settings.default_wp_author_id || 0}
          disabled={saving || loading}
          onChange={(e) => {
            const id = Number(e.target.value);
            const a = authors.find((x) => x.id === id);
            void save({ default_wp_author_id: id, default_wp_author_name: a?.name || "" });
          }}
        >
          <option value={0}>{current ? `Connected user (${current.name})` : "Connected WordPress user"}</option>
          {settings.default_wp_author_id && !authors.some((a) => a.id === settings.default_wp_author_id) ? (
            <option value={settings.default_wp_author_id}>{settings.default_wp_author_name || `User #${settings.default_wp_author_id}`}</option>
          ) : null}
          {authors.map((a) => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>
        <button type="button" className={styles.btnSecondary} onClick={refresh} disabled={loading} aria-label="Reload WordPress authors">
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>
      <span className={styles.muted} style={{ fontSize: 12 }}>
        {wp && !wp.can_assign
          ? "The connected WordPress user can only publish as themself. Reconnect with an Editor or Administrator to publish as other authors."
          : "Used whenever an article has no author chosen. Every generate, schedule and publish form pre-selects it; you can change it per article."}
      </span>
    </div>
  );
}
