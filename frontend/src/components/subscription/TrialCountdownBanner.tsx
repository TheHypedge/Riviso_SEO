"use client";

import { useEffect, useMemo, useState } from "react";
import s from "./trialCountdown.module.css";
import type { SubscriptionStatusPublic } from "@/lib/api";

// ── Constants ──────────────────────────────────────────────────────────────────
const DISMISS_KEY = "rvs_trial_banner_dismiss";
const WELCOME_KEY = "rvs_trial_welcome_seen";

const UPGRADE_HREF = "mailto:support@riviso.com?subject=Riviso%20plan%20upgrade";

const FEATURES = [
  "Unlimited Article Generation",
  "AI Cluster Planner",
  "Context Links & Internal Linking",
  "AI Research & Custom Curations",
  "Article Scheduler",
  "WordPress Publishing",
  "Shopify Publishing",
  "Bulk Upload & Export",
  "GSC Performance Analytics",
  "Custom AI Image Generation",
];

const UPGRADE_FEATURES = [
  "AI Writer (unlimited articles)",
  "Scheduler",
  "Cluster Planner",
  "WordPress & Shopify Publishing",
  "Unlimited Projects",
];

// ── Types ──────────────────────────────────────────────────────────────────────
type Phase = "normal" | "warn" | "amber" | "urgent" | "expired";

// ── LocalStorage helpers ───────────────────────────────────────────────────────
function getDismissDate(): string | null {
  try {
    const raw = typeof window !== "undefined" ? localStorage.getItem(DISMISS_KEY) : null;
    if (!raw) return null;
    return (JSON.parse(raw) as { date?: string }).date ?? null;
  } catch {
    return null;
  }
}

function saveDismiss(remainingDays: number): void {
  try {
    const today = new Date().toISOString().split("T")[0];
    localStorage.setItem(DISMISS_KEY, JSON.stringify({ date: today, remainingDays }));
  } catch {}
}

function hasSeenWelcome(): boolean {
  try {
    return typeof window !== "undefined" && !!localStorage.getItem(WELCOME_KEY);
  } catch {
    return false;
  }
}

function markWelcomeSeen(): void {
  try {
    localStorage.setItem(WELCOME_KEY, "1");
  } catch {}
}

// ── Visibility decision ────────────────────────────────────────────────────────
function shouldShowBanner(remainingDays: number): boolean {
  if (remainingDays <= 7) return true; // always show close to expiry
  const dismissedDate = getDismissDate();
  if (!dismissedDate) return true;
  const today = new Date().toISOString().split("T")[0];
  return dismissedDate !== today; // show again next day
}

// ── Time helpers ───────────────────────────────────────────────────────────────
function remainingFromEnd(trialEndDate: string | null | undefined) {
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
    totalMinutes,
  };
}

function trialProgress(startDate: string | null | undefined, endDate: string | null | undefined): number {
  if (!startDate || !endDate) return 0;
  const s = Date.parse(startDate.includes("T") ? startDate : `${startDate}T00:00:00Z`);
  const e = Date.parse(endDate.includes("T") ? endDate : `${endDate}T00:00:00Z`);
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return 0;
  return Math.min(100, Math.max(0, ((Date.now() - s) / (e - s)) * 100));
}

// ── Formatting ─────────────────────────────────────────────────────────────────
function fmtCountdown(days: number, hours: number, minutes: number, isExpired: boolean): string {
  if (isExpired) return "Trial Expired";
  if (days >= 2) return `${days} Days Remaining`;
  if (days === 1 && hours > 0) return `${days} Day ${hours} Hours Remaining`;
  if (days === 1) return `${days} Day Remaining`;
  if (hours >= 1) return `${hours} Hours Remaining`;
  return `${Math.max(1, minutes)} Minutes Remaining`;
}

function phaseFrom(days: number, isExpired: boolean): Phase {
  if (isExpired) return "expired";
  if (days <= 1) return "urgent";
  if (days <= 3) return "amber";
  if (days <= 7) return "warn";
  return "normal";
}

function phaseMessage(days: number, isExpired: boolean): string {
  if (isExpired) return "Your trial has ended. Upgrade your subscription to regain access.";
  if (days <= 1) return "Today is your final trial day. Upgrade now to keep all your projects active.";
  if (days <= 3) return "Premium access will expire shortly. Upgrade today to continue generating content.";
  if (days <= 7) return "Your free trial ends soon. Upgrade now to avoid interruption.";
  return "You currently have access to all Premium features.";
}

function phaseClass(phase: Phase): string {
  if (phase === "warn") return s.phaseWarn;
  if (phase === "amber") return s.phaseAmber;
  if (phase === "urgent") return s.phaseUrgent;
  if (phase === "expired") return s.phaseExpired;
  return s.phaseNormal;
}

function phaseIcon(phase: Phase): string {
  if (phase === "expired") return "🔒";
  if (phase === "urgent") return "🚨";
  if (phase === "amber") return "⚠️";
  if (phase === "warn") return "⏳";
  return "⭐";
}

// ── Feature modal ──────────────────────────────────────────────────────────────
function FeatureModal({ onClose }: { onClose: () => void }) {
  return (
    <div className={s.featureOverlay} role="dialog" aria-modal="true" aria-label="Premium features" onClick={onClose}>
      <div className={s.featureCard} onClick={(e) => e.stopPropagation()}>
        <p className={s.featureCardTitle}>All Premium Features</p>
        <ul className={s.featureList} role="list">
          {FEATURES.map((f) => (
            <li key={f} className={s.featureItem}>
              <span className={s.featureCheck} aria-hidden="true">✓</span>
              {f}
            </li>
          ))}
        </ul>
        <button type="button" className={s.featureCloseBtn} onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

// ── Welcome modal ──────────────────────────────────────────────────────────────
function WelcomeModal({
  status,
  days,
  hours,
  minutes,
  progress,
  onClose,
  onExplore,
}: {
  status: SubscriptionStatusPublic;
  days: number;
  hours: number;
  minutes: number;
  progress: number;
  onClose: () => void;
  onExplore: () => void;
}) {
  const totalDays = useMemo(() => {
    if (!status.trial_start_date || !status.trial_end_date) return 14;
    const s = Date.parse(status.trial_start_date.includes("T") ? status.trial_start_date : `${status.trial_start_date}T00:00:00Z`);
    const e = Date.parse(status.trial_end_date.includes("T") ? status.trial_end_date : `${status.trial_end_date}T00:00:00Z`);
    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return 14;
    return Math.round((e - s) / (86400 * 1000));
  }, [status.trial_start_date, status.trial_end_date]);

  return (
    <div className={s.welcomeOverlay} role="dialog" aria-modal="true" aria-labelledby="welcome-title">
      <div className={s.welcomeCard}>
        <button type="button" className={s.welcomeCloseBtn} onClick={onClose} aria-label="Dismiss welcome">
          ✕
        </button>
        <div className={s.welcomeEyebrow}>
          <span>🎉</span>
          Welcome to Riviso Beta
        </div>
        <h2 id="welcome-title" className={s.welcomeTitle}>
          All premium features unlocked for {totalDays} days
        </h2>
        <p className={s.welcomeBody}>
          Explore AI Research, Cluster Planner, Content Generation, Scheduling, Publishing and every premium feature before choosing your plan.
        </p>
        <div className={s.welcomeCountdown} role="timer" aria-live="polite">
          ⏱ {fmtCountdown(days, hours, minutes, false)}
        </div>
        <div className={s.welcomeProgressWrap}>
          <div className={s.welcomeProgressTrack}>
            <div className={s.welcomeProgressFill} style={{ width: `${100 - progress}%` }} />
          </div>
          <div className={s.welcomeProgressMeta}>
            <span>Trial started</span>
            <span>{days} days left</span>
          </div>
        </div>
        <div className={s.welcomeActions}>
          <a href={UPGRADE_HREF} className={s.welcomeUpgradeBtn}>
            Upgrade Now
          </a>
          <button type="button" className={s.welcomeFeatureBtn} onClick={onExplore}>
            Explore Features
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Upgrade Required modal (exported for context) ──────────────────────────────
export function UpgradeRequiredModal({ onClose }: { onClose: () => void }) {
  return (
    <div
      className={s.upgradeOverlay}
      role="dialog"
      aria-modal="true"
      aria-labelledby="upgrade-required-title"
      onClick={onClose}
    >
      <div className={s.upgradeCard} onClick={(e) => e.stopPropagation()}>
        <button type="button" className={s.upgradeCloseBtn} onClick={onClose} aria-label="Close">
          ✕
        </button>
        <p className={s.upgradeCardEyebrow}>Beta Trial Ended</p>
        <h2 id="upgrade-required-title" className={s.upgradeCardTitle}>
          Upgrade Required
        </h2>
        <p className={s.upgradeCardBody}>
          Your Beta Trial has ended. Upgrade to continue using premium features.
        </p>
        <ul className={s.upgradeFeatureList} role="list">
          {UPGRADE_FEATURES.map((f) => (
            <li key={f} className={s.upgradeFeatureItem}>
              <span className={s.upgradeFeatureCheck} aria-hidden="true">✓</span>
              {f}
            </li>
          ))}
        </ul>
        <div className={s.upgradeCardActions}>
          <a href={UPGRADE_HREF} className={s.upgradeCardPrimaryBtn}>
            Upgrade Now
          </a>
          <button type="button" className={s.upgradeCardSecondaryBtn} onClick={onClose}>
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main banner ────────────────────────────────────────────────────────────────
export function TrialCountdownBanner({ status }: { status: SubscriptionStatusPublic }) {
  const [tick, setTick] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [showWelcome, setShowWelcome] = useState(false);
  const [showFeatures, setShowFeatures] = useState(false);

  // Tick every minute
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 60_000);
    return () => window.clearInterval(id);
  }, []);

  // Welcome: show once per device if active trial
  useEffect(() => {
    if (status.is_trial_plan && status.status === "active" && !hasSeenWelcome()) {
      setShowWelcome(true);
    }
  }, [status.is_trial_plan, status.status]);

  const isExpired = status.status === "trial_expired";

  const remaining = useMemo(
    () => remainingFromEnd(status.trial_end_date),
    [status.trial_end_date, tick],
  );

  const days = remaining?.days ?? status.remaining_days;
  const hours = remaining?.hours ?? status.remaining_hours;
  const minutes = remaining?.minutes ?? status.remaining_minutes;

  const phase = phaseFrom(days, isExpired);
  const progress = useMemo(
    () => trialProgress(status.trial_start_date, status.trial_end_date),
    [status.trial_start_date, status.trial_end_date, tick],
  );

  const countdownText = fmtCountdown(days, hours, minutes, isExpired);
  const msg = phaseMessage(days, isExpired);

  // Non-trial, non-expired users: never render
  if (!status.is_trial_plan && !isExpired) return null;

  // Active trial: respect dismiss, show welcome or banner
  const bannerVisible = isExpired || (!dismissed && shouldShowBanner(days));

  function handleDismiss() {
    if (isExpired) return; // expired cannot be dismissed
    markWelcomeSeen();
    setShowWelcome(false);
    setDismissed(true);
    saveDismiss(days);
  }

  function handleWelcomeClose() {
    markWelcomeSeen();
    setShowWelcome(false);
  }

  function handleExploreFromWelcome() {
    markWelcomeSeen();
    setShowWelcome(false);
    setShowFeatures(true);
  }

  return (
    <>
      {/* Welcome modal — shown once on first visit */}
      {showWelcome && (
        <WelcomeModal
          status={status}
          days={days}
          hours={hours}
          minutes={minutes}
          progress={progress}
          onClose={handleWelcomeClose}
          onExplore={handleExploreFromWelcome}
        />
      )}

      {/* Feature list modal */}
      {showFeatures && <FeatureModal onClose={() => setShowFeatures(false)} />}

      {/* Sticky top banner */}
      {bannerVisible && (
        <div className={`${s.bannerWrap} ${phaseClass(phase)}`} role="status" aria-live="polite">
          <div className={s.bannerInner}>
            <div className={s.bannerLeft}>
              <span className={s.bannerIcon} aria-hidden="true">{phaseIcon(phase)}</span>
              <span className={s.bannerLabel}>
                {isExpired ? "Trial Expired" : "Beta Trial"}
              </span>
            </div>

            <div className={s.bannerCenter}>
              <span className={s.bannerMsg}>{msg}</span>
              <span className={s.countdown} role="timer">{countdownText}</span>
              {!isExpired && (
                <div className={s.progressWrap} aria-hidden="true">
                  <div className={s.progressTrack}>
                    <div className={s.progressFill} style={{ width: `${Math.min(100, progress)}%` }} />
                  </div>
                  <div className={s.progressLabel}>{days}d left</div>
                </div>
              )}
            </div>

            <div className={s.bannerRight}>
              {!isExpired && (
                <button type="button" className={s.featureBtn} onClick={() => setShowFeatures(true)}>
                  Explore Features
                </button>
              )}
              <a href={UPGRADE_HREF} className={s.upgradeBtn}>
                {isExpired ? "Upgrade Now" : "Upgrade Plan"}
              </a>
              {!isExpired && (
                <button
                  type="button"
                  className={s.dismissBtn}
                  onClick={handleDismiss}
                  aria-label="Dismiss trial banner"
                >
                  ✕
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
