"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";

import styles from "@/app/page.module.css";
import { ApiError, api } from "@/lib/api";

// ─── Token validation states ─────────────────────────────────────────────────

type TokenStatus = "checking" | "valid" | "expired" | "invalid";

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

// ─── Skeleton card shown while validating the token ──────────────────────────

function CheckingCard() {
  return (
    <div className={styles.authCard}>
      <div
        style={{
          height: 24,
          width: "60%",
          borderRadius: 6,
          background: "rgba(255,255,255,0.06)",
          marginBottom: 12,
          animation: "pulse 1.5s ease-in-out infinite",
        }}
      />
      <div
        style={{
          height: 16,
          width: "85%",
          borderRadius: 6,
          background: "rgba(255,255,255,0.04)",
          animation: "pulse 1.5s ease-in-out infinite",
        }}
      />
    </div>
  );
}

// ─── Invalid / expired / used states ─────────────────────────────────────────

function ErrorCard({ status }: { status: "expired" | "invalid" }) {
  const isExpired = status === "expired";
  return (
    <div className={styles.authCard}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginBottom: 12,
        }}
      >
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 36,
            height: 36,
            borderRadius: "50%",
            background: "rgba(198,69,69,0.12)",
            border: "1px solid rgba(198,69,69,0.3)",
            color: "#c64545",
            fontSize: 18,
            flexShrink: 0,
          }}
        >
          ✕
        </span>
        <div className={styles.authCardTitle} style={{ margin: 0 }}>
          {isExpired ? "Reset Link Expired" : "Invalid Reset Link"}
        </div>
      </div>

      <div className={styles.authCardSub}>
        {isExpired
          ? "This password reset link has expired. Reset links are valid for 1 hour. Please request a new one."
          : "This password reset link is invalid or has already been used. Please request a new link."}
      </div>

      <div style={{ marginTop: 24, display: "flex", flexDirection: "column", gap: 10 }}>
        <Link
          href="/forgot-password"
          className={`${styles.button} ${styles.authButton}`}
          style={{ display: "block", textAlign: "center" }}
        >
          {isExpired ? "Send New Reset Link" : "Request New Link"}
        </Link>
        <div style={{ textAlign: "center" }}>
          <Link href="/" className={styles.authForgotLink}>
            Back to Login
          </Link>
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
  const router = useRouter();
  const params = useSearchParams();
  const token = (params.get("token") || "").trim();

  const [tokenStatus, setTokenStatus] = useState<TokenStatus>("checking");
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
        if (!cancelled)
          setTokenStatus(r.valid ? "valid" : ((r.reason as TokenStatus) ?? "invalid"));
      })
      .catch(() => {
        if (!cancelled) setTokenStatus("invalid");
      });
    return () => {
      cancelled = true;
    };
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
        // If the token was already used / expired during form submission
        if (
          msg.toLowerCase().includes("expired") ||
          msg.toLowerCase().includes("invalid")
        ) {
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
  if (tokenStatus === "expired") return <ErrorCard status="expired" />;
  if (tokenStatus === "invalid") return <ErrorCard status="invalid" />;
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
