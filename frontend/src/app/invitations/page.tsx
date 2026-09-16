"use client";
import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { api, InvitationPublic } from "@/lib/api";
import { useFocusTrap } from "@/lib/useFocusTrap";
import styles from "./invitations.module.css";

const ROLE_LABELS: Record<string, string> = {
  admin: "Admin",
  editor: "Editor",
  viewer: "Viewer",
};

function formatDate(iso: string): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  } catch { return ""; }
}

function daysUntilExpiry(iso: string): number | null {
  if (!iso) return null;
  try {
    const diff = new Date(iso).getTime() - Date.now();
    return Math.ceil(diff / 86400000);
  } catch { return null; }
}

type Toast = { message: string; tone: "success" | "error" };

function InvitationsContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const tokenParam = searchParams.get("token");

  const [invitations, setInvitations] = useState<InvitationPublic[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);

  // Decline confirmation modal
  const [declineTarget, setDeclineTarget] = useState<InvitationPublic | null>(null);
  const declineTrapRef = useFocusTrap(!!declineTarget);

  const showToast = (message: string, tone: "success" | "error") => {
    setToast({ message, tone });
    setTimeout(() => setToast(null), 4000);
  };

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        const data = await api.getMyInvitations();
        setInvitations(data);

        // If token param, find matching invitation and highlight it
        if (tokenParam) {
          try {
            const inv = await api.getInvitationByToken(tokenParam);
            if (inv) setHighlightId(inv.id);
          } catch {}
        }
      } catch {
        showToast("Failed to load invitations", "error");
      }
      setLoading(false);
    };
    void load();
  }, [tokenParam]);

  const handleAccept = async (inv: InvitationPublic) => {
    setActionBusy(inv.id);
    try {
      const result = await api.acceptInvitation(inv.id);
      setInvitations(prev => prev.filter(i => i.id !== inv.id));
      showToast(`You now have access to ${inv.project_name}`, "success");
      // Invalidate project list cache so the shared project appears immediately
      if (typeof window !== "undefined") {
        // Small delay then redirect to the project
        setTimeout(() => {
          if (result.project?.id) {
            router.push(`/projects/${result.project.id}`);
          } else {
            router.push("/dashboard");
          }
        }, 1200);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to accept invitation";
      showToast(msg, "error");
    }
    setActionBusy(null);
  };

  const handleDeclineConfirm = async () => {
    if (!declineTarget) return;
    const inv = declineTarget;
    setDeclineTarget(null);
    setActionBusy(inv.id);
    try {
      await api.declineInvitation(inv.id);
      setInvitations(prev => prev.filter(i => i.id !== inv.id));
      showToast("Invitation declined", "success");
    } catch {
      showToast("Failed to decline invitation", "error");
    }
    setActionBusy(null);
  };

  return (
    <div className={styles.page}>
      <nav className={styles.topNav}>
        <Link href="/dashboard" className={styles.backLink}>← Dashboard</Link>
      </nav>

      <div className={styles.content}>
        <header className={styles.header}>
          <h1 className={styles.heading}>Project Invitations</h1>
          <p className={styles.subheading}>
            Accept to join a project and collaborate with its team.
          </p>
        </header>

        {loading && (
          <div className={styles.loadingState}>
            <div className={styles.loadingSpinner} aria-label="Loading invitations" />
            <span>Loading invitations…</span>
          </div>
        )}

        {!loading && invitations.length === 0 && (
          <div className={styles.emptyState}>
            <div className={styles.emptyIcon} aria-hidden="true">
              <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
                <rect x="6" y="12" width="36" height="26" rx="4" stroke="currentColor" strokeWidth="2"/>
                <path d="M6 16l18 12 18-12" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/>
              </svg>
            </div>
            <h2 className={styles.emptyHeading}>No pending invitations</h2>
            <p className={styles.emptyBody}>
              When someone shares a project with you, you&apos;ll see it here.
            </p>
            <Link href="/dashboard" className={styles.emptyAction}>Go to dashboard →</Link>
          </div>
        )}

        {!loading && invitations.length > 0 && (
          <div className={styles.cardGrid}>
            {invitations.map(inv => {
              const daysLeft = daysUntilExpiry(inv.expires_at);
              const isHighlighted = inv.id === highlightId;
              const isBusy = actionBusy === inv.id;
              return (
                <article
                  key={inv.id}
                  className={`${styles.card} ${isHighlighted ? styles.cardHighlighted : ""}`}
                  aria-label={`Invitation to ${inv.project_name}`}
                >
                  <div className={styles.cardTop}>
                    <div className={styles.projectInfo}>
                      <h2 className={styles.projectName}>{inv.project_name}</h2>
                      {inv.project_website_url && (
                        <div className={styles.projectUrl}>{inv.project_website_url}</div>
                      )}
                    </div>
                    <span className={`${styles.roleBadge} ${styles[`role_${inv.role}`] || ""}`}>
                      {ROLE_LABELS[inv.role] ?? inv.role}
                    </span>
                  </div>

                  <div className={styles.meta}>
                    <div className={styles.metaRow}>
                      <span className={styles.metaLabel}>From</span>
                      <span className={styles.metaValue}>{inv.invited_by_name}</span>
                    </div>
                    <div className={styles.metaRow}>
                      <span className={styles.metaLabel}>Invited</span>
                      <span className={styles.metaValue}>{formatDate(inv.created_at)}</span>
                    </div>
                    {daysLeft !== null && (
                      <div className={styles.metaRow}>
                        <span className={styles.metaLabel}>Expires</span>
                        <span className={`${styles.metaValue} ${daysLeft <= 2 ? styles.expiryWarn : ""}`}>
                          {daysLeft <= 0 ? "Today" : `in ${daysLeft} day${daysLeft === 1 ? "" : "s"}`}
                        </span>
                      </div>
                    )}
                  </div>

                  <div className={styles.actions}>
                    <button
                      type="button"
                      className={styles.btnAccept}
                      disabled={isBusy}
                      onClick={() => void handleAccept(inv)}
                    >
                      {isBusy ? "Accepting…" : "Accept"}
                    </button>
                    <button
                      type="button"
                      className={styles.btnDecline}
                      disabled={isBusy}
                      onClick={() => setDeclineTarget(inv)}
                    >
                      Decline
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>

      {/* Decline confirmation modal */}
      {declineTarget && (
        <div className={styles.modalBackdrop} role="presentation">
          <div
            ref={declineTrapRef}
            className={styles.modal}
            role="dialog"
            aria-modal="true"
            aria-labelledby="decline-modal-title"
            aria-describedby="decline-modal-desc"
          >
            <h2 id="decline-modal-title" className={styles.modalTitle}>Decline invitation?</h2>
            <p id="decline-modal-desc" className={styles.modalBody}>
              You&apos;re about to decline the invitation to{" "}
              <strong>{declineTarget.project_name}</strong>. You can always be invited again.
            </p>
            <div className={styles.modalActions}>
              <button
                type="button"
                className={styles.btnGhost}
                onClick={() => setDeclineTarget(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className={styles.btnDanger}
                onClick={() => void handleDeclineConfirm()}
              >
                Decline invitation
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div
          className={`${styles.toast} ${styles[`toast_${toast.tone}`]}`}
          role="status"
          aria-live="polite"
        >
          {toast.message}
        </div>
      )}
    </div>
  );
}

export default function InvitationsPage() {
  return (
    <Suspense>
      <InvitationsContent />
    </Suspense>
  );
}
