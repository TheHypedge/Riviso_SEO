"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";

import styles from "@/app/page.module.css";
import { ApiError, api } from "@/lib/api";

function ResetPasswordForm() {
  const router = useRouter();
  const params = useSearchParams();
  const token = params.get("token") || "";
  const email = params.get("email") || "";

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const pw = password || "";
  const pwRules = useMemo(
    () => ({
      length: pw.length >= 8,
      lower: /[a-z]/.test(pw),
      upper: /[A-Z]/.test(pw),
      number: /\d/.test(pw),
      special: /[^A-Za-z0-9]/.test(pw),
    }),
    [pw],
  );
  const isStrongPassword = Object.values(pwRules).every(Boolean);

  // Invalid link — token or email missing
  if (!token || !email) {
    return (
      <div className={styles.authCard}>
        <div className={styles.authCardTitle}>Invalid reset link</div>
        <div className={styles.authCardSub}>
          This password reset link is invalid or has expired. Request a new one from the login page.
        </div>
        <div style={{ marginTop: 20 }}>
          <Link href="/" className={`${styles.button} ${styles.authButton}`} style={{ display: "block", textAlign: "center" }}>
            Back to login
          </Link>
        </div>
      </div>
    );
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!isStrongPassword) {
      setError("Please choose a stronger password.");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    setError(null);
    setLoading(true);
    try {
      const res = await api.resetPassword(email, token, password);
      if (res.ok !== false) {
        setSuccess(true);
        // Redirect to login after a short delay so the user can read the message
        setTimeout(() => router.push("/"), 2500);
      } else {
        setError(res.message || "Password reset failed. The link may have expired.");
      }
    } catch (err) {
      if (err instanceof ApiError) {
        const detail = err.detail;
        setError(
          (typeof detail === "string" ? detail : null) ||
            (detail && typeof detail === "object" && "message" in detail
              ? String((detail as { message: string }).message)
              : null) ||
            err.message ||
            "Password reset failed. The link may have expired.",
        );
      } else {
        setError(err instanceof Error ? err.message : "Password reset failed.");
      }
    } finally {
      setLoading(false);
    }
  }

  if (success) {
    return (
      <div className={styles.authCard}>
        <div className={styles.authCardTitle}>Password updated</div>
        <div className={styles.authCardSub}>
          Your password has been updated successfully. Redirecting to login…
        </div>
        <p className={styles.authInfo} style={{ marginTop: 16 }}>
          You can now sign in with your new password.
        </p>
        <div style={{ marginTop: 20 }}>
          <Link href="/" className={`${styles.button} ${styles.authButton}`} style={{ display: "block", textAlign: "center" }}>
            Go to login
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.authCard}>
      <div className={styles.authCardTitle}>Reset your password</div>
      <div className={styles.authCardSub}>
        Resetting password for <strong style={{ color: "rgba(255,255,255,0.9)" }}>{email}</strong>. Choose a strong new password.
      </div>

      <form className={styles.authForm} onSubmit={onSubmit}>
        <label className={`${styles.label} ${styles.authFieldLabel} ${styles.authField}`}>
          New password
          <div className={styles.authPasswordWrap}>
            <input
              className={`${styles.input} ${styles.authInput} ${styles.authPasswordInput}`}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              type={showPassword ? "text" : "password"}
              autoComplete="new-password"
              placeholder="Create a new password"
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

        <label className={`${styles.label} ${styles.authFieldLabel} ${styles.authField}`}>
          Confirm new password
          <input
            className={`${styles.input} ${styles.authInput}`}
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            type="password"
            autoComplete="new-password"
            placeholder="Re-enter your new password"
            required
          />
        </label>

        <div className={styles.authChecklist} aria-label="Password requirements">
          {[
            [pwRules.length, "At least 8 characters"],
            [pwRules.upper, "One uppercase letter (A–Z)"],
            [pwRules.lower, "One lowercase letter (a–z)"],
            [pwRules.number, "One number (0–9)"],
            [pwRules.special, "One special character (!@#$…)"],
          ].map(([ok, label]) => (
            <div key={label as string} className={styles.authCheckRow}>
              <span className={`${styles.authCheckIcon} ${ok ? styles.authCheckOn : ""}`}>
                {ok ? "✓" : "•"}
              </span>
              {label as string}
            </div>
          ))}
        </div>

        {error ? <p className={`${styles.error} ${styles.authError}`}>{error}</p> : null}

        <button
          className={`${styles.button} ${styles.authButton}`}
          type="submit"
          disabled={loading || !isStrongPassword || password !== confirmPassword}
        >
          {loading ? "Updating password…" : "Set new password"}
        </button>
      </form>

      <div style={{ marginTop: 12, textAlign: "center" }}>
        <Link href="/" className={styles.authForgotLink}>
          Back to login
        </Link>
      </div>
    </div>
  );
}

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
            Choose a strong password to keep your Riviso workspace safe.
          </p>
        </section>

        <section className={styles.authRight}>
          <div className={styles.authMobileTop}>
            <div className={styles.authMobileBrand} aria-label="Riviso">
              <span className={styles.authMobileLogo} aria-hidden="true">
                <Image src="/riviso-logo.png" alt="" width={28} height={28} priority className={styles.authMobileLogoImg} />
              </span>
              <span className={styles.authMobileBrandText}>Riviso</span>
            </div>
          </div>
          {/* Suspense required because useSearchParams() requires it in App Router */}
          <Suspense fallback={<div className={styles.authCard}><div className={styles.authCardSub}>Loading…</div></div>}>
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
