"use client";

import Image from "next/image";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";


import styles from "@/app/page.module.css";
import { ApiError, api } from "@/lib/api";

// ─── Token validation states ─────────────────────────────────────────────────

type TokenStatus = "checking" | "valid" | "expired" | "invalid";
type ResendState = "idle" | "sending" | "sent" | "cooldown";

// ─── Password strength ────────────────────────────────────────────────────────

function usePasswordRules(pw: string) {
  return useMemo(
    () => ({
      length: pw.length >= 8,
      lower: /[a-z]/.test(pw),
      upper: /[A-Z]/.test(pw),
      number: /\d/.test(pw),
      special: /[^A-Za-z0-9]/.test(pw),
    }),
    [pw],
  );
}

// ─── Countdown hook ───────────────────────────────────────────────────────────

function useCountdown(seconds: number, active: boolean) {
  const [remaining, setRemaining] = useState(seconds);
  useEffect(() => {
    if (!active) { setRemaining(seconds); return; }
    setRemaining(seconds);
    const id = setInterval(() => setRemaining((s) => (s <= 1 ? 0 : s - 1)), 1000);
    return () => clearInterval(id);
  }, [seconds, active]);
  return remaining;
}

// ─── Skeleton card shown while validating the token ──────────────────────────

function CheckingCard() {
  return (
    <div className={styles.authCard}>
      <div style={{ height: 24, width: "60%", borderRadius: 6, background: "rgba(255,255,255,0.06)", marginBottom: 12, animation: "pulse 1.5s ease-in-out infinite" }} />
      <div style={{ height: 16, width: "85%", borderRadius: 6, background: "rgba(255,255,255,0.04)", animation: "pulse 1.5s ease-in-out infinite" }} />
    </div>
  );
}

// ─── Expired card — inline resend with countdown ──────────────────────────────

function ExpiredCard({ token, emailHint }: { token: string; emailHint: string | null }) {
  const [resendState, setResendState] = useState<ResendState>("idle");
  const [cooldownSecs, setCooldownSecs] = useState(120);
  const remaining = useCountdown(cooldownSecs, resendState === "cooldown");
  const timerDoneRef = useRef(false);

  useEffect(() => {
    if (resendState === "cooldown" && remaining === 0 && !timerDoneRef.current) {
      timerDoneRef.current = true;
      setResendState("idle");
    }
  }, [resendState, remaining]);

  async function handleResend() {
    if (resendState !== "idle") return;
    setResendState("sending");
    try {
      await api.resendReset(token);
      setResendState("sent");
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        const detail = err.detail as Record<string, unknown> | null;
        const secs = typeof detail?.retry_after_seconds === "number" ? detail.retry_after_seconds : 120;
        setCooldownSecs(secs);
        timerDoneRef.current = false;
        setResendState("cooldown");
      } else {
        // Fallback: still show sent state so user goes to check inbox
        setResendState("sent");
      }
    }
  }

  if (resendState === "sent") {
    return (
      <div className={styles.authCard}>
        <div style={{ textAlign: "center", marginBottom: 16 }}>
          <div style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 52, height: 52, borderRadius: "50%", background: "rgba(93,184,114,0.12)", border: "1px solid rgba(93,184,114,0.3)", color: "#5db872", fontSize: 24 }}>✓</div>
        </div>
        <div className={styles.authCardTitle} style={{ textAlign: "center" }}>New Link Sent</div>
        <div className={styles.authCardSub} style={{ textAlign: "center" }}>
          A fresh reset link has been sent{emailHint ? <> to <strong style={{ color: "rgba(250,249,245,0.9)" }}>{emailHint}</strong></> : ""}. Check your inbox and click the new link.
        </div>
        <div style={{ marginTop: 24 }}>
          <Link href="/" className={`${styles.button} ${styles.authButton}`} style={{ display: "block", textAlign: "center" }}>Back to Login</Link>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.authCard}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 36, height: 36, borderRadius: "50%", background: "rgba(212,160,23,0.12)", border: "1px solid rgba(212,160,23,0.3)", color: "#d4a017", fontSize: 18, flexShrink: 0 }}>⏱</span>
        <div className={styles.authCardTitle} style={{ margin: 0 }}>Reset Link Expired</div>
      </div>

      <div className={styles.authCardSub}>
        This password reset link has expired — links are valid for 1 hour.
        {emailHint && <> The link was sent to <strong style={{ color: "rgba(250,249,245,0.88)" }}>{emailHint}</strong>.</>}
      </div>

      <div style={{ marginTop: 20, padding: "14px 16px", background: "rgba(255,255,255,0.04)", borderRadius: 8, border: "1px solid rgba(255,255,255,0.08)" }}>
        <p style={{ margin: "0 0 12px", fontSize: 13, color: "var(--aa-on-dark-soft, #a09d96)", lineHeight: 1.5 }}>
          Click below to receive a new reset link{emailHint ? ` at ${emailHint}` : ""}.
        </p>
        {resendState === "cooldown" ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", background: "rgba(212,160,23,0.08)", borderRadius: 6, border: "1px solid rgba(212,160,23,0.2)" }}>
            <span style={{ color: "#d4a017", fontSize: 15 }}>⏳</span>
            <span style={{ fontSize: 13, color: "#d4a017" }}>
              Next link available in <strong>{remaining}s</strong>
            </span>
          </div>
        ) : (
          <button
            type="button"
            className={`${styles.button} ${styles.authButton}`}
            style={{ width: "100%" }}
            disabled={resendState === "sending"}
            onClick={() => void handleResend()}
          >
            {resendState === "sending" ? "Sending…" : "Resend Reset Link"}
          </button>
        )}
      </div>

      <div style={{ marginTop: 16, textAlign: "center" }}>
        <Link href="/forgot-password" className={styles.authForgotLink}>Use a different email</Link>
        <span style={{ margin: "0 8px", color: "rgba(160,157,150,0.4)" }}>·</span>
        <Link href="/" className={styles.authForgotLink}>Back to Login</Link>
      </div>
    </div>
  );
}

// ─── Invalid / already-used state ────────────────────────────────────────────

function InvalidCard() {
  return (
    <div className={styles.authCard}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 36, height: 36, borderRadius: "50%", background: "rgba(198,69,69,0.12)", border: "1px solid rgba(198,69,69,0.3)", color: "#c64545", fontSize: 18, flexShrink: 0 }}>✕</span>
        <div className={styles.authCardTitle} style={{ margin: 0 }}>Invalid Reset Link</div>
      </div>
      <div className={styles.authCardSub}>
        This password reset link is invalid or has already been used. If you need to reset your password, please request a new link.
      </div>
      <div style={{ marginTop: 24, display: "flex", flexDirection: "column", gap: 10 }}>
        <Link href="/forgot-password" className={`${styles.button} ${styles.authButton}`} style={{ display: "block", textAlign: "center" }}>
          Request New Link
        </Link>
        <div style={{ textAlign: "center" }}>
          <Link href="/" className={styles.authForgotLink}>Back to Login</Link>
        </div>
      </div>
    </div>
  );
}

// ─── Success state ────────────────────────────────────────────────────────────

function SuccessCard() {
  return (
    <div className={styles.authCard}>
      <div style={{ textAlign: "center", marginBottom: 16 }}>
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 52,
            height: 52,
            borderRadius: "50%",
            background: "rgba(93,184,114,0.12)",
            border: "1px solid rgba(93,184,114,0.3)",
            color: "#5db872",
            fontSize: 24,
          }}
        >
          ✓
        </div>
      </div>
      <div className={styles.authCardTitle} style={{ textAlign: "center" }}>
        Password Updated
      </div>
      <div className={styles.authCardSub} style={{ textAlign: "center" }}>
        Your password has been changed successfully. All previous sessions have
        been signed out for your security.
      </div>
      <div style={{ marginTop: 24 }}>
        <Link
          href="/?reset=success"
          className={`${styles.button} ${styles.authButton}`}
          style={{ display: "block", textAlign: "center" }}
        >
          Continue to Login
        </Link>
      </div>
    </div>
  );
}

// ─── Main reset form ──────────────────────────────────────────────────────────

function ResetPasswordForm() {
  const params = useSearchParams();
  const token = (params.get("token") || "").trim();

  const [tokenStatus, setTokenStatus] = useState<TokenStatus>("checking");
  const [emailHint, setEmailHint] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const pwRules = usePasswordRules(password);
  const isStrongPassword = Object.values(pwRules).every(Boolean);
  const passwordsMatch = password === confirmPassword && confirmPassword !== "";

  // Validate token on mount
  useEffect(() => {
    if (!token) {
      setTokenStatus("invalid");
      return;
    }
    let cancelled = false;
    api
      .validateResetToken(token)
      .then((r) => {
        if (cancelled) return;
        if (r.email_hint) setEmailHint(r.email_hint);
        setTokenStatus(r.valid ? "valid" : ((r.reason as TokenStatus) ?? "invalid"));
      })
      .catch(() => {
        if (!cancelled) setTokenStatus("invalid");
      });
    return () => { cancelled = true; };
  }, [token]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!isStrongPassword) {
      setError("Please choose a stronger password that meets all requirements.");
      return;
    }
    if (!passwordsMatch) {
      setError("Passwords do not match.");
      return;
    }
    setError(null);
    setLoading(true);
    try {
      const res = await api.resetPassword(token, password);
      if (res.ok !== false) {
        setSuccess(true);
      } else {
        setError(res.message || "Password reset failed. The link may have expired.");
      }
    } catch (err) {
      if (err instanceof ApiError) {
        const detail = err.detail;
        const msg =
          (typeof detail === "string" ? detail : null) ||
          (detail && typeof detail === "object" && "message" in detail
            ? String((detail as { message: string }).message)
            : null) ||
          err.message ||
          "Password reset failed. The link may have expired.";
        // Token expired or used while the form was open — switch to expired card
        if (msg.toLowerCase().includes("expired")) {
          setTokenStatus("expired");
          return;
        }
        if (msg.toLowerCase().includes("invalid")) {
          setTokenStatus("invalid");
          return;
        }
        setError(msg);
      } else {
        setError(err instanceof Error ? err.message : "Password reset failed.");
      }
    } finally {
      setLoading(false);
    }
  }

  // Render states
  if (tokenStatus === "checking") return <CheckingCard />;
  if (tokenStatus === "expired") return <ExpiredCard token={token} emailHint={emailHint} />;
  if (tokenStatus === "invalid") return <InvalidCard />;
  if (success) return <SuccessCard />;

  return (
    <div className={styles.authCard}>
      <div className={styles.authCardTitle}>Create a new password</div>
      <div className={styles.authCardSub}>
        Choose a strong password for your Riviso account. You'll be signed out
        of all other sessions once you save.
      </div>

      <form className={styles.authForm} onSubmit={onSubmit} noValidate>
        {/* New password */}
        <label className={`${styles.authFieldLabel} ${styles.authField}`}>
          New Password
          <div className={styles.authPasswordWrap}>
            <input
              className={`${styles.input} ${styles.authInput} ${styles.authPasswordInput}`}
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                if (error) setError(null);
              }}
              type={showPassword ? "text" : "password"}
              autoComplete="new-password"
              placeholder="Create a strong password"
              required
            />
            <button
              type="button"
              className={styles.authToggle}
              onClick={() => setShowPassword((v) => !v)}
              aria-label={showPassword ? "Hide password" : "Show password"}
            >
              {showPassword ? "×" : "👁"}
            </button>
          </div>
        </label>

        {/* Confirm password */}
        <label className={`${styles.authFieldLabel} ${styles.authField}`}>
          Confirm Password
          <div className={styles.authPasswordWrap}>
            <input
              className={`${styles.input} ${styles.authInput} ${styles.authPasswordInput}`}
              value={confirmPassword}
              onChange={(e) => {
                setConfirmPassword(e.target.value);
                if (error) setError(null);
              }}
              type={showConfirm ? "text" : "password"}
              autoComplete="new-password"
              placeholder="Re-enter your new password"
              required
            />
            <button
              type="button"
              className={styles.authToggle}
              onClick={() => setShowConfirm((v) => !v)}
              aria-label={showConfirm ? "Hide password" : "Show password"}
            >
              {showConfirm ? "×" : "👁"}
            </button>
          </div>
        </label>

        {/* Password requirements checklist */}
        <div className={styles.authChecklist} aria-label="Password requirements">
          {(
            [
              [pwRules.length, "At least 8 characters"],
              [pwRules.upper, "One uppercase letter (A–Z)"],
              [pwRules.lower, "One lowercase letter (a–z)"],
              [pwRules.number, "One number (0–9)"],
              [pwRules.special, "One special character (!@#$…)"],
            ] as [boolean, string][]
          ).map(([ok, label]) => (
            <div key={label} className={styles.authCheckRow}>
              <span className={`${styles.authCheckIcon} ${ok ? styles.authCheckOn : ""}`}>
                {ok ? "✓" : "•"}
              </span>
              {label}
            </div>
          ))}
          {confirmPassword.length > 0 ? (
            <div className={styles.authCheckRow}>
              <span
                className={`${styles.authCheckIcon} ${passwordsMatch ? styles.authCheckOn : ""}`}
              >
                {passwordsMatch ? "✓" : "•"}
              </span>
              Passwords match
            </div>
          ) : null}
        </div>

        {error ? (
          <p className={`${styles.error} ${styles.authError}`} role="alert">
            {error}
          </p>
        ) : null}

        <button
          className={`${styles.button} ${styles.authButton}`}
          type="submit"
          disabled={loading || !isStrongPassword || !passwordsMatch}
        >
          {loading ? "Updating password…" : "Update Password"}
        </button>
      </form>

      <div style={{ marginTop: 12, textAlign: "center" }}>
        <Link href="/" className={styles.authForgotLink}>
          Back to Login
        </Link>
      </div>
    </div>
  );
}

// ─── Page shell ───────────────────────────────────────────────────────────────

export default function ResetPasswordPage() {
  return (
    <div className={styles.authPage}>
      <div className={styles.authShell}>
        <section className={styles.authLeft}>
          <div className={styles.authBrand} aria-label="Riviso">
            <Image
              src="/riviso-logo.png"
              alt="Riviso"
              width={36}
              height={36}
              priority
              className={styles.authBrandLogo}
            />
            <span className={styles.authBrandText}>Riviso</span>
          </div>
          <h1 className={styles.authHero}>Secure your account.</h1>
          <p className={styles.authSub}>
            Create a strong new password to protect your Riviso workspace.
          </p>
        </section>

        <section className={styles.authRight}>
          <div className={styles.authMobileTop}>
            <div className={styles.authMobileBrand} aria-label="Riviso">
              <span className={styles.authMobileLogo} aria-hidden="true">
                <Image
                  src="/riviso-logo.png"
                  alt=""
                  width={28}
                  height={28}
                  priority
                  className={styles.authMobileLogoImg}
                />
              </span>
              <span className={styles.authMobileBrandText}>Riviso</span>
            </div>
          </div>
          <Suspense
            fallback={
              <div className={styles.authCard}>
                <div className={styles.authCardSub}>Loading…</div>
              </div>
            }
          >
            <ResetPasswordForm />
          </Suspense>
        </section>
      </div>

      <div className={styles.authFooter}>
        <Link href="/privacy-policy">Privacy Policy</Link>
        <Link href="/terms">Terms &amp; Conditions</Link>
      </div>
    </div>
  );
}
