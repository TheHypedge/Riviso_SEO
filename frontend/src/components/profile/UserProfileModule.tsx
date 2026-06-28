"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import s from "./UserProfileModule.module.css";
import { api } from "@/lib/api";
import type { ProfilePublic } from "@/lib/api";
import { useSubscription } from "@/components/subscription/SubscriptionProvider";
import { useFocusTrap } from "@/lib/useFocusTrap";

// ── Prefs (localStorage) ──────────────────────────────────────────────────────
type Prefs = {
  notif_articles: boolean;
  notif_research: boolean;
  notif_publishing: boolean;
  marketing_updates: boolean;
  marketing_newsletters: boolean;
  weekly_summary: boolean;
};

const PREFS_KEY = "rvs_user_prefs";

const DEFAULT_PREFS: Prefs = {
  notif_articles: true,
  notif_research: true,
  notif_publishing: true,
  marketing_updates: false,
  marketing_newsletters: false,
  weekly_summary: false,
};

function loadPrefs(): Prefs {
  try {
    const raw = typeof window !== "undefined" ? localStorage.getItem(PREFS_KEY) : null;
    if (!raw) return { ...DEFAULT_PREFS };
    return { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<Prefs>) };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

function savePrefs(p: Prefs) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch {}
}

// ── Avatar ────────────────────────────────────────────────────────────────────
function avatarInitials(name: string | null | undefined, email: string): string {
  const src = (name || email || "U").trim();
  const parts = src.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  return src.slice(0, 2).toUpperCase();
}

const AVATAR_COLORS = ["#6e5fe6", "#d97757", "#5db872", "#7090c8", "#c64545", "#d4a017"];
function avatarColor(str: string): string {
  let h = 0;
  for (const ch of (str || "U")) h = ((h * 31) + ch.charCodeAt(0)) | 0;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}

// ── Date helpers ──────────────────────────────────────────────────────────────
function fmtDate(raw: string | null | undefined): string {
  if (!raw) return "—";
  try {
    const d = new Date(raw.includes("T") ? raw : `${raw}T00:00:00Z`);
    return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
  } catch { return raw; }
}

function fmtMemberSince(raw: string | null | undefined): string {
  if (!raw) return "—";
  try {
    const d = new Date(raw.includes("T") ? raw : `${raw}T00:00:00Z`);
    return d.toLocaleDateString("en-US", { year: "numeric", month: "short", timeZone: "UTC" });
  } catch { return raw; }
}

// ── Timezone helpers ──────────────────────────────────────────────────────────
function normalizeTimeZoneId(tz: string): string {
  const raw = (tz || "").trim();
  if (!raw) return "";
  if (raw === "Asia/Calcutta") return "Asia/Kolkata";
  return raw;
}

function fmtWallClock(tz: string | null | undefined): string {
  const z = ((tz || "").trim() || "UTC");
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: z, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    }).format(new Date()).replace(",", "");
  } catch { return "—"; }
}

function trialProgress(startDate: string | null | undefined, endDate: string | null | undefined): number {
  if (!startDate || !endDate) return 0;
  const ss = Date.parse(startDate.includes("T") ? startDate : `${startDate}T00:00:00Z`);
  const ee = Date.parse(endDate.includes("T") ? endDate : `${endDate}T00:00:00Z`);
  if (!Number.isFinite(ss) || !Number.isFinite(ee) || ee <= ss) return 0;
  return Math.min(100, Math.max(0, ((Date.now() - ss) / (ee - ss)) * 100));
}

// ── Toggle ────────────────────────────────────────────────────────────────────
function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      className={`${s.toggle} ${on ? s.toggleOn : ""}`}
      onClick={() => onChange(!on)}
    >
      <span className={`${s.toggleThumb} ${on ? s.toggleThumbOn : ""}`} />
    </button>
  );
}

const UPGRADE_HREF = "mailto:support@riviso.com?subject=Riviso%20plan%20upgrade";

// ── Main component ────────────────────────────────────────────────────────────
export function UserProfileModule() {
  const { status: subStatus, trialExpired, openUpgradeModal } = useSubscription();
  const router = useRouter();

  // Profile state
  const [profile, setProfile] = useState<ProfilePublic | null>(null);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<Partial<ProfilePublic>>({});
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<"success" | "error" | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Delete account state
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteConfirmEmail, setDeleteConfirmEmail] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const deleteTrapRef = useFocusTrap(showDeleteModal);

  // Clock tick for live timezone display
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, []);

  // Preferences (localStorage)
  const [prefs, setPrefs] = useState<Prefs>(() => loadPrefs());

  function setPref<K extends keyof Prefs>(key: K, val: Prefs[K]) {
    setPrefs((prev) => {
      const next = { ...prev, [key]: val };
      savePrefs(next);
      return next;
    });
  }

  // Timezone options
  const browserTimeZone = useMemo(() => {
    try { return normalizeTimeZoneId(Intl.DateTimeFormat().resolvedOptions().timeZone || ""); } catch { return ""; }
  }, []);

  const timeZoneOptions = useMemo(() => {
    const intlAny = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
    const raw = typeof intlAny.supportedValuesOf === "function" ? intlAny.supportedValuesOf("timeZone") : [];
    const list = Array.isArray(raw) && raw.length ? raw : [browserTimeZone, "UTC"].filter(Boolean);
    const uniq = [...new Set(list.filter(Boolean))];
    if (browserTimeZone && !uniq.includes(browserTimeZone)) uniq.unshift(browserTimeZone);
    if (!uniq.includes("UTC")) uniq.push("UTC");
    return uniq;
  }, [browserTimeZone]);

  // Load profile on mount
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const p = await api.profileMe();
      setProfile(p);
      setDraft({
        full_name: p.full_name || "",
        phone: p.phone || "",
        timezone: normalizeTimeZoneId(p.timezone || browserTimeZone || "") || null,
      });
    } catch {
      // silent — profile stays null
    } finally {
      setLoading(false);
    }
  }, [browserTimeZone]);

  useEffect(() => { void load(); }, [load]);

  const draftChanged = useMemo(() => {
    if (!profile) return false;
    return (
      (draft.full_name ?? "") !== (profile.full_name ?? "") ||
      (draft.phone ?? "") !== (profile.phone ?? "") ||
      (draft.timezone ?? "") !== (profile.timezone ?? "")
    );
  }, [draft, profile]);

  function cancelEdit() {
    if (!profile) return;
    setDraft({
      full_name: profile.full_name || "",
      phone: profile.phone || "",
      timezone: profile.timezone || "",
    });
    setSaveResult(null);
  }

  async function handleSave() {
    if (!profile || !draftChanged) return;
    setSaving(true);
    setSaveResult(null);
    try {
      const saved = await api.updateProfileMe({
        full_name: (draft.full_name || "").trim(),
        phone: (draft.phone || "").trim(),
        timezone: (draft.timezone || "").trim(),
      });
      setProfile(saved);
      setDraft({ full_name: saved.full_name || "", phone: saved.phone || "", timezone: saved.timezone || "" });
      setSaveResult("success");
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => setSaveResult(null), 4000);
    } catch {
      setSaveResult("error");
    } finally {
      setSaving(false);
    }
  }

  function openDeleteModal() {
    setDeleteConfirmEmail("");
    setDeleteError(null);
    setShowDeleteModal(true);
  }

  function closeDeleteModal() {
    if (deleting) return;
    setShowDeleteModal(false);
    setDeleteConfirmEmail("");
    setDeleteError(null);
  }

  async function handleDeleteAccount() {
    if (deleting) return;
    const expected = (profile?.email || "").trim().toLowerCase();
    if (deleteConfirmEmail.trim().toLowerCase() !== expected) {
      setDeleteError("Email does not match. Please type your exact email address.");
      return;
    }
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.deleteMe();
      // Clear local state, redirect to login
      localStorage.removeItem("rvs_trial_banner_dismiss");
      localStorage.removeItem("rvs_trial_welcome_seen");
      localStorage.removeItem("rvs_user_prefs");
      localStorage.removeItem("rvs_overview_filters");
      router.push("/?deleted=1");
    } catch {
      setDeleteError("Failed to delete account. Please try again or contact support.");
      setDeleting(false);
    }
  }

  // Derived subscription info
  const planKey = (profile?.subscription_type || "").toLowerCase().trim() || "beta";
  const planName = subStatus?.plan_name || subStatus?.plan_key || planKey;
  const isTrial = subStatus?.is_trial_plan ?? false;
  const isExpired = trialExpired;
  const remainingDays = subStatus?.remaining_days ?? 0;
  const remainingHours = subStatus?.remaining_hours ?? 0;

  const planStatusLabel = isExpired
    ? "Expired"
    : isTrial
    ? `${remainingDays}d ${remainingHours}h left`
    : (profile?.account_status === "active" ? "Active" : "Active");

  const planStatusCls = isExpired
    ? s.planStatusExpired
    : isTrial
    ? s.planStatusTrial
    : s.planStatusActive;

  const trialProg = useMemo(
    () => trialProgress(subStatus?.trial_start_date, subStatus?.trial_end_date),
    [subStatus?.trial_start_date, subStatus?.trial_end_date],
  );

  const isVerified = (profile?.account_status || "active") === "active";

  // ── Render ──
  if (loading) {
    return (
      <div className={s.wrap}>
        <div className={s.card}>
          <div className={s.summaryRow}>
            <div className={s.skeletonAvatar} />
            <div style={{ flex: 1 }}>
              <div className={s.skeletonLine} style={{ width: "40%" }} />
              <div className={s.skeletonLine} style={{ width: "60%" }} />
            </div>
          </div>
        </div>
        <div className={s.card}>
          <div className={s.skeletonLine} style={{ width: "30%" }} />
          <div className={s.skeletonLine} style={{ width: "80%" }} />
          <div className={s.skeletonLine} style={{ width: "60%" }} />
        </div>
      </div>
    );
  }

  const initials = avatarInitials(profile?.full_name, profile?.email || "");
  const color = avatarColor(profile?.email || "");

  return (
    <>
    <div className={s.wrap}>

      {/* ── Section 1: Profile Summary ── */}
      <div className={s.card}>
        <div className={s.summaryRow}>
          <div className={s.avatar} style={{ background: color }} aria-hidden="true">
            {initials}
          </div>

          <div className={s.summaryInfo}>
            <h1 className={s.summaryName}>
              {(profile?.full_name || "").trim() || "My Account"}
            </h1>
            <div className={s.summaryEmail}>
              {profile?.email}
              {isVerified
                ? <span className={s.verifiedBadge}>✓ Verified</span>
                : <span className={s.unverifiedBadge}>⚠ Unverified</span>
              }
            </div>
            <div className={s.summaryMeta}>
              <span className={s.summaryMetaItem}>
                <span aria-hidden="true">📅</span>
                Member since {fmtMemberSince(profile?.created_at)}
              </span>
              <span className={s.summaryMetaItem}>
                <span aria-hidden="true">🔖</span>
                {planName}
              </span>
            </div>
          </div>

          <div className={s.summaryRight}>
            <div className={s.planChip}>
              <span className={s.planName}>{planName}</span>
              <span className={`${s.planStatus} ${planStatusCls}`}>{planStatusLabel}</span>
            </div>
            {(isTrial || isExpired) && (
              <a
                href={UPGRADE_HREF}
                className={s.upgradeBtn}
                onClick={isExpired ? (e) => { e.preventDefault(); openUpgradeModal(); } : undefined}
              >
                Upgrade Plan
              </a>
            )}
          </div>
        </div>
      </div>

      {/* ── Two-column grid ── */}
      <div className={s.twoCol}>
        <div className={s.twoColLeft}>

          {/* ── Section 2: Personal Information ── */}
          <div className={s.card}>
            <div className={s.cardHeader}>
              <h2 className={s.cardTitle}>
                <span className={s.cardTitleIcon} aria-hidden="true">👤</span>
                Personal Information
              </h2>
            </div>

            <div className={s.fieldGrid}>
              {/* Full Name */}
              <label className={s.fieldLabel}>
                <span className={s.fieldLabelText}>Full Name</span>
                <input
                  className={s.fieldInput}
                  type="text"
                  value={draft.full_name ?? ""}
                  onChange={(e) => setDraft((d) => ({ ...d, full_name: e.target.value }))}
                  placeholder="Your full name"
                  autoComplete="name"
                />
              </label>

              {/* Phone */}
              <label className={s.fieldLabel}>
                <span className={s.fieldLabelText}>Phone</span>
                <input
                  className={s.fieldInput}
                  type="tel"
                  value={draft.phone ?? ""}
                  onChange={(e) => setDraft((d) => ({ ...d, phone: e.target.value }))}
                  placeholder="Optional"
                  autoComplete="tel"
                />
              </label>

              {/* Email (read-only) */}
              <div className={s.fieldLabel}>
                <span className={s.fieldLabelText}>
                  Email <span className={s.readOnlyTag}>Read Only</span>
                </span>
                <div className={s.fieldInputReadOnly}>{profile?.email}</div>
              </div>

              {/* Language */}
              <div className={s.fieldLabel}>
                <span className={s.fieldLabelText}>Language</span>
                <select className={s.selectInput} defaultValue="en" disabled>
                  <option value="en">English (US)</option>
                </select>
              </div>

              {/* Timezone (full width) */}
              <div className={`${s.fieldLabel} ${s.fieldFull}`}>
                <div className={s.tzRow}>
                  <span className={s.fieldLabelText}>Timezone</span>
                  <button
                    type="button"
                    className={s.autoDetectBtn}
                    onClick={() => setDraft((d) => ({ ...d, timezone: normalizeTimeZoneId(browserTimeZone || "UTC") }))}
                  >
                    Auto-detect
                  </button>
                </div>
                <select
                  className={s.selectInput}
                  value={draft.timezone ?? ""}
                  onChange={(e) => setDraft((d) => ({ ...d, timezone: e.target.value }))}
                >
                  {timeZoneOptions.map((tz) => (
                    <option key={tz} value={tz}>{tz}</option>
                  ))}
                </select>
                <div className={s.tzHint} aria-live="polite">
                  <span><strong>Local time:</strong> {fmtWallClock(draft.timezone || null)}</span>
                  <span><strong>UTC:</strong> {fmtWallClock("UTC")}</span>
                </div>
                <span style={{ display: "none" }}>{tick}</span>
              </div>
            </div>

            <div className={s.formActions}>
              <button
                type="button"
                className={s.btnPrimary}
                onClick={handleSave}
                disabled={saving || !draftChanged}
              >
                {saving ? "Saving…" : "Save Changes"}
              </button>
              {draftChanged && (
                <button type="button" className={s.btnSecondary} onClick={cancelEdit} disabled={saving}>
                  Cancel
                </button>
              )}
              {saveResult === "success" && (
                <span className={s.successMsg} role="status">✓ Saved successfully</span>
              )}
              {saveResult === "error" && (
                <span className={s.errorMsg} role="alert">Failed to save — try again</span>
              )}
            </div>
          </div>

          {/* ── Section 3: Subscription ── */}
          <div className={s.card}>
            <div className={s.cardHeader}>
              <h2 className={s.cardTitle}>
                <span className={s.cardTitleIcon} aria-hidden="true">💳</span>
                Subscription
              </h2>
            </div>

            <div className={s.subCard}>
              <div className={s.subInfo}>
                <p className={s.subPlanName}>{planName}</p>
                <div className={s.subRows}>
                  <div className={s.subRow}>
                    <span className={s.subRowLabel}>Status</span>
                    <span className={`${s.planStatus} ${planStatusCls}`}>{planStatusLabel}</span>
                  </div>
                  <div className={s.subRow}>
                    <span className={s.subRowLabel}>Member since</span>
                    <span className={s.subRowVal}>{fmtDate(profile?.created_at)}</span>
                  </div>
                  {isTrial && !isExpired && (
                    <div className={s.subRow}>
                      <span className={s.subRowLabel}>Trial ends</span>
                      <span className={s.subRowVal}>{fmtDate(subStatus?.trial_end_date)}</span>
                    </div>
                  )}
                </div>

                {isTrial && !isExpired && (
                  <div className={s.trialProgress}>
                    <div className={s.trialProgressTrack}>
                      <div className={s.trialProgressFill} style={{ width: `${100 - trialProg}%` }} />
                    </div>
                    <div className={s.trialProgressMeta}>
                      <span>Trial started</span>
                      <span>{remainingDays} days remaining</span>
                    </div>
                  </div>
                )}
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 8, flexShrink: 0 }}>
                {(isTrial || isExpired) && (
                  <a
                    href={UPGRADE_HREF}
                    className={s.upgradeBtn}
                    style={{ justifyContent: "center" }}
                    onClick={isExpired ? (e) => { e.preventDefault(); openUpgradeModal(); } : undefined}
                  >
                    {isExpired ? "Restore Access" : "Upgrade Plan"}
                  </a>
                )}
              </div>
            </div>

            {isExpired && (
              <p style={{ marginTop: 16, fontSize: 13, color: "#f08080", lineHeight: 1.5 }}>
                Your trial has expired. Upgrade to regain access to premium features.
              </p>
            )}
          </div>

        </div>

        <div className={s.twoColRight}>

          {/* ── Section 4: Preferences ── */}
          <div className={s.card}>
            <div className={s.cardHeader}>
              <h2 className={s.cardTitle}>
                <span className={s.cardTitleIcon} aria-hidden="true">🔔</span>
                Preferences
              </h2>
            </div>

            <div className={s.prefGroup}>
              <div className={s.prefGroupLabel}>Activity Notifications</div>
              <PrefRow
                name="Article Generation"
                desc="Notify when an article finishes generating"
                on={prefs.notif_articles}
                onChange={(v) => setPref("notif_articles", v)}
              />
              <PrefRow
                name="Research Complete"
                desc="Notify when AI research finishes"
                on={prefs.notif_research}
                onChange={(v) => setPref("notif_research", v)}
              />
              <PrefRow
                name="Publishing"
                desc="Notify when an article is published or scheduled"
                on={prefs.notif_publishing}
                onChange={(v) => setPref("notif_publishing", v)}
              />
            </div>

            <div className={s.prefGroup}>
              <div className={s.prefGroupLabel}>Email Preferences</div>
              <PrefRow
                name="Product Updates"
                desc="Feature releases and product announcements"
                on={prefs.marketing_updates}
                onChange={(v) => setPref("marketing_updates", v)}
              />
              <PrefRow
                name="Newsletter"
                desc="SEO tips, content strategy, and industry news"
                on={prefs.marketing_newsletters}
                onChange={(v) => setPref("marketing_newsletters", v)}
              />
              <PrefRow
                name="Weekly Summary"
                desc="A weekly digest of your account activity"
                on={prefs.weekly_summary}
                onChange={(v) => setPref("weekly_summary", v)}
              />
            </div>
          </div>

          {/* ── Section 5: Help & Support ── */}
          <div className={s.card} id="help-support">
            <div className={s.cardHeader}>
              <h2 className={s.cardTitle}>
                <span className={s.cardTitleIcon} aria-hidden="true">💬</span>
                Help &amp; Support
              </h2>
            </div>

            <div className={s.helpGrid}>
              <a href="mailto:support@riviso.com?subject=Riviso%20Support" className={s.helpCard} target="_blank" rel="noopener noreferrer">
                <span className={s.helpIcon}>📧</span>
                <div className={s.helpInfo}>
                  <div className={s.helpTitle}>Contact Support</div>
                  <div className={s.helpDesc}>Get help from the Riviso team</div>
                </div>
                <span className={s.helpArrow}>↗</span>
              </a>
              <a href="mailto:support@riviso.com?subject=Bug%20Report" className={s.helpCard} target="_blank" rel="noopener noreferrer">
                <span className={s.helpIcon}>🐛</span>
                <div className={s.helpInfo}>
                  <div className={s.helpTitle}>Report a Bug</div>
                  <div className={s.helpDesc}>Tell us what went wrong</div>
                </div>
                <span className={s.helpArrow}>↗</span>
              </a>
              <a href="mailto:support@riviso.com?subject=Feature%20Request" className={s.helpCard} target="_blank" rel="noopener noreferrer">
                <span className={s.helpIcon}>💡</span>
                <div className={s.helpInfo}>
                  <div className={s.helpTitle}>Request a Feature</div>
                  <div className={s.helpDesc}>Share your ideas with us</div>
                </div>
                <span className={s.helpArrow}>↗</span>
              </a>
              <a href="mailto:support@riviso.com?subject=Riviso%20plan%20upgrade" className={s.helpCard} target="_blank" rel="noopener noreferrer">
                <span className={s.helpIcon}>⬆️</span>
                <div className={s.helpInfo}>
                  <div className={s.helpTitle}>Upgrade Subscription</div>
                  <div className={s.helpDesc}>Upgrade or change your plan</div>
                </div>
                <span className={s.helpArrow}>↗</span>
              </a>
            </div>
          </div>

        </div>
      </div>

      {/* ── Section 6: Danger Zone ── */}
      <div className={s.dangerCard}>
        <div className={s.dangerHeader}>
          <div>
            <h2 className={s.dangerTitle}>Danger Zone</h2>
            <p className={s.dangerDesc}>
              Permanently delete your account and all associated data. This action cannot be undone.
            </p>
          </div>
          <button
            type="button"
            className={s.dangerBtn}
            onClick={openDeleteModal}
          >
            Delete Account
          </button>
        </div>
      </div>

    </div>

    {/* ── Delete confirmation modal ── */}
    {showDeleteModal && (
      <div className={s.modalBackdrop} role="dialog" aria-modal="true" aria-labelledby="delete-modal-title">
        <div className={s.modal} ref={deleteTrapRef}>
          <div className={s.modalHeader}>
            <h2 className={s.modalTitle} id="delete-modal-title">Delete Your Account</h2>
            <button
              type="button"
              className={s.modalClose}
              onClick={closeDeleteModal}
              aria-label="Close"
              disabled={deleting}
            >
              ✕
            </button>
          </div>

          <div className={s.modalBody}>
            <div className={s.deleteWarningBox}>
              <span className={s.deleteWarningIcon} aria-hidden="true">⚠</span>
              <div>
                <div className={s.deleteWarningTitle}>This will permanently delete:</div>
                <ul className={s.deleteWarningList}>
                  <li>Your account and profile data</li>
                  <li>All your projects and articles</li>
                  <li>All scheduled jobs and research data</li>
                  <li>Your subscription record</li>
                </ul>
              </div>
            </div>

            <label className={s.deleteConfirmLabel}>
              <span className={s.deleteConfirmLabelText}>
                Type your email address <strong>{profile?.email}</strong> to confirm:
              </span>
              <input
                className={s.deleteConfirmInput}
                type="email"
                value={deleteConfirmEmail}
                onChange={(e) => { setDeleteConfirmEmail(e.target.value); setDeleteError(null); }}
                placeholder={profile?.email || "your@email.com"}
                autoComplete="off"
                disabled={deleting}
              />
            </label>

            {deleteError && (
              <div className={s.deleteError} role="alert">{deleteError}</div>
            )}
          </div>

          <div className={s.modalFooter}>
            <button
              type="button"
              className={s.modalCancelBtn}
              onClick={closeDeleteModal}
              disabled={deleting}
            >
              Cancel
            </button>
            <button
              type="button"
              className={s.modalDeleteBtn}
              onClick={() => void handleDeleteAccount()}
              disabled={deleting || deleteConfirmEmail.trim().toLowerCase() !== (profile?.email || "").trim().toLowerCase()}
            >
              {deleting ? "Deleting…" : "Delete My Account"}
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  );
}

// ── PrefRow sub-component ─────────────────────────────────────────────────────
function PrefRow({ name, desc, on, onChange }: {
  name: string;
  desc: string;
  on: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className={s.prefRow}>
      <div className={s.prefRowInfo}>
        <div className={s.prefRowName}>{name}</div>
        <div className={s.prefRowDesc}>{desc}</div>
      </div>
      <Toggle on={on} onChange={onChange} label={name} />
    </div>
  );
}
