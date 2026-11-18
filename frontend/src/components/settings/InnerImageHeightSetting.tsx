"use client";

import { useState } from "react";

import styles from "@/app/page.module.css";
import { api } from "@/lib/api";

/** Mirrors backend inner_images.DEFAULT_INNER_IMAGE_MAX_HEIGHT (used while a project hasn't chosen). */
export const DEFAULT_INNER_IMAGE_MAX_HEIGHT = 420;
const PRESETS = [300, 360, 420, 480, 560];

type Props = {
  projectId: string;
  value: number | null | undefined;
  onSaved: (height: number | null) => void;
  onMessage: (message: string, tone: "success" | "error") => void;
};

/** Project Settings -> height in-article AI illustrations are cropped to (saves on change). */
export default function InnerImageHeightSetting({ projectId, value, onSaved, onMessage }: Props) {
  const current = value ?? DEFAULT_INNER_IMAGE_MAX_HEIGHT;
  const [custom, setCustom] = useState(current > 0 && !PRESETS.includes(current) ? String(current) : "");
  const [saving, setSaving] = useState(false);
  const mode = current === 0 ? "0" : PRESETS.includes(current) && !custom ? String(current) : "custom";

  async function save(h: number) {
    setSaving(true);
    try {
      const saved = await api.updateProjectSettings(projectId, { inner_image_max_height: h });
      onSaved(saved.inner_image_max_height ?? null);
      onMessage(h ? `Inner images will be ${h}px tall` : "Inner images keep their original size", "success");
    } catch (e) {
      onMessage(e instanceof Error ? e.message : "Could not save the image height", "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div id="inner-image-height" style={{ display: "grid", gap: 8 }}>
      <label className={styles.label}>
        Default height of in-article images
        <select
          className={styles.input}
          value={mode}
          disabled={saving}
          onChange={(e) => {
            if (e.target.value === "custom") {
              setCustom(String(current || DEFAULT_INNER_IMAGE_MAX_HEIGHT));
              return;
            }
            setCustom("");
            void save(Number(e.target.value));
          }}
        >
          {PRESETS.map((h) => (
            <option key={h} value={h}>
              {h}px{h === DEFAULT_INNER_IMAGE_MAX_HEIGHT ? " (recommended)" : ""}
            </option>
          ))}
          <option value="custom">Custom…</option>
          <option value="0">Original size (no crop)</option>
        </select>
      </label>
      {mode === "custom" ? (
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            className={styles.input}
            type="number"
            min={200}
            max={1000}
            step={10}
            value={custom}
            aria-label="Custom image height in pixels"
            onChange={(e) => setCustom(e.target.value)}
          />
          <button
            type="button"
            className={styles.btnSecondary}
            disabled={saving || !(Number(custom) >= 200 && Number(custom) <= 1000)}
            onClick={() => void save(Math.round(Number(custom)))}
          >
            Save
          </button>
        </div>
      ) : null}
      <span className={styles.muted} style={{ fontSize: 12, lineHeight: 1.5 }}>
        AI illustrations are generated wide and cropped to this height, centred. In the editor you can still drag the
        bottom edge to crop more or less, and double-click an image to reposition what shows. Charts and diagrams always
        keep their full size so no data is cut off.
      </span>
    </div>
  );
}
