"use client";

import styles from "@/app/page.module.css";

export const MAX_INNER_IMAGES = 5;

export function clampInnerImageCount(v: unknown): number {
  return Math.max(0, Math.min(MAX_INNER_IMAGES, Math.trunc(Number(v) || 0)));
}

/** "No. of inner article image" input shared by every generate/schedule form. */
export default function InnerImageCountField({
  value,
  onChange,
  monthRemaining,
  hint = "0–5. Placed between sections: data charts where the article has real figures, otherwise images in the selected image prompt's style.",
}: {
  value: number;
  onChange: (next: number) => void;
  /** Plan quota left this month; omit or null when unlimited/unknown. */
  monthRemaining?: number | null;
  hint?: string;
}) {
  return (
    <label className={styles.label}>
      No. of inner article image
      <input
        type="number"
        className={styles.input}
        min={0}
        max={MAX_INNER_IMAGES}
        step={1}
        value={value}
        onChange={(e) => onChange(clampInnerImageCount(e.target.value))}
      />
      <div className={styles.muted} style={{ fontSize: 12, marginTop: 6 }}>
        {hint}
        {typeof monthRemaining === "number" ? ` ${Math.max(0, monthRemaining)} left this month.` : ""}
      </div>
    </label>
  );
}
