"use client";

import styles from "./trialUpgrade.module.css";
import type { SubscriptionStatusPublic } from "@/lib/api";

export function TrialUpgradeModal({ status }: { status: SubscriptionStatusPublic | null }) {
  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-labelledby="trial-upgrade-title">
      <div className={styles.modal}>
        <p className={styles.eyebrow}>Beta access ended</p>
        <h2 id="trial-upgrade-title" className={styles.title}>
          Upgrade to keep using Riviso
        </h2>
        <p className={styles.body}>
          Your {status?.plan_name || status?.plan_key || "beta"} trial has expired. Content generation, scheduling,
          and publishing are locked until you upgrade your plan.
        </p>
        <div className={styles.actions}>
          <a className={styles.primaryBtn} href="mailto:support@riviso.com?subject=Riviso%20plan%20upgrade">
            Contact sales to upgrade
          </a>
        </div>
        <p className={styles.hint}>Need help? Email support@riviso.com and we will restore access after upgrade.</p>
      </div>
    </div>
  );
}
