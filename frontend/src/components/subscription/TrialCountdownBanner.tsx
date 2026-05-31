"use client";

import { useEffect, useMemo, useState } from "react";

import styles from "./trialCountdown.module.css";
import type { SubscriptionStatusPublic } from "@/lib/api";

function remainingFromTrialEnd(trialEndDate: string | null | undefined) {
  const raw = (trialEndDate || "").trim();
  if (!raw) return null;
  const endMs = Date.parse(raw.includes("T") ? raw : `${raw.replace(" ", "T")}Z`);
  if (!Number.isFinite(endMs)) return null;
  const diffMs = Math.max(0, endMs - Date.now());
  const totalMinutes = Math.floor(diffMs / 60_000);
  return {
    days: Math.floor(totalMinutes / (60 * 24)),
    hours: Math.floor((totalMinutes % (60 * 24)) / 60),
    minutes: totalMinutes % 60,
  };
}

export function TrialCountdownBanner({ status }: { status: SubscriptionStatusPublic }) {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!status.is_trial_plan || status.status !== "active") return;
    const id = window.setInterval(() => setTick((n) => n + 1), 60_000);
    return () => window.clearInterval(id);
  }, [status.is_trial_plan, status.status]);

  const remaining = useMemo(
    () => remainingFromTrialEnd(status.trial_end_date),
    [status.trial_end_date, tick],
  );

  if (!status.is_trial_plan || status.status !== "active") return null;

  const days = remaining?.days ?? status.remaining_days;
  const hours = remaining?.hours ?? status.remaining_hours;
  const minutes = remaining?.minutes ?? status.remaining_minutes;

  return (
    <div className={styles.banner} role="status">
      <strong>{status.plan_name || status.plan_key} trial</strong>
      <span>
        {days}d {hours}h {minutes}m remaining
      </span>
    </div>
  );
}
