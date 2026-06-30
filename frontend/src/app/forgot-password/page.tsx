"use client";

import Image from "next/image";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";

import styles from "@/app/page.module.css";
import { ApiError, api } from "@/lib/api";

const RESEND_COOLDOWN_SECONDS = 120;

// ─── Email validation helpers ────────────────────────────────────────────────

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

// ─── Main form component (needs Suspense because of useSearchParams) ──────────

function ForgotPasswordForm() {
  const params = useSearchParams();
  const prefill = (params.get("email") || "").trim();

  const [email, setEmail] = useState(prefill);
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0); // seconds remaining before "Send again" is allowed
  const emailRef = useRef<HTMLInputElement>(null);
  const cooldownIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Focus the input on mount
  useEffect(() => {
    if (!prefill) emailRef.current?.focus();
  }, [prefill]);

  // Countdown ticker
  useEffect(() => {
    if (cooldown <= 0) {
      if (cooldownIntervalRef.current) clearInterval(cooldownIntervalRef.current);
      return;
    }
    cooldownIntervalRef.current = setInterval(() => {
      setCooldown((s) => {
        if (s <= 1) {
          if (cooldownIntervalRef.current) clearInterval(cooldownIntervalRef.current);
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => { if (cooldownIntervalRef.current) clearInterval(cooldownIntervalRef.current); };
  }, [cooldown]);

  function startCooldown(secs: number) {
    setCooldown(secs);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const trimmed = email.trim().toLowerCase();

    if (!trimmed) { setError("Please enter your email address."); return; }
    if (!isValidEmail(trimmed)) { setError("Please enter a valid email address."); return; }

    setLoading(true);

    try {
      // Step 1 — check if email is registered
      const check = await api.checkEmail(trimmed);
      if (!check.exists) {
        setError("No account found with this email address. Please check and try again, or create a new account.");
        setLoading(false);
        return;
      }

      // Step 2 — send the reset email
      await api.forgotPassword(trimmed);
      setSent(true);
      startCooldown(RESEND_COOLDOWN_SECONDS);
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        // Per-account cooldown active — still show sent state (email was already sent)
        const detail = err.detail as Record<string, unknown> | null;
        const secs = typeof detail?.retry_after_seconds === "number"
          ? detail.retry_after_seconds
          : RESEND_COOLDOWN_SECONDS;
        setSent(true);
        startCooldown(secs);
      } else {
        setError("Something went wrong. Please try again in a moment.");
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleSendAgain() {
    if (cooldown > 0) return;
    setSent(false);
    setError(null);
  }

  // ── Success state ────────────────────────────────────────────────────────
  if (sent) {
    return (
      <div className={styles.authCard}>
        <div style={{ textAlign: "center", marginBottom: 16 }}>
          <div style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 52, height: 52, borderRadius: "50%", background: "rgba(93,184,114,0.12)", border: "1px solid rgba(93,184,114,0.3)", fontSize: 24, marginBottom: 8 }}>✓</div>
        </div>
        <div className={styles.authCardTitle} style={{ textAlign: "center" }}>Check your inbox</div>
        <div className={styles.authCardSub} style={{ textAlign: "center" }}>
          A password reset link has been sent to{" "}
          <strong style={{ color: "rgba(250,249,245,0.9)" }}>{email.trim().toLowerCase()}</strong>.
          Click the link in the email to set a new password.
        </div>
        <p style={{ color: "var(--aa-on-dark-soft, #a09d96)", fontSize: 13, textAlign: "center", margin: "16px 0 0", lineHeight: 1.6 }}>
          The link expires in 1 hour. Check your spam folder if you don't see it.
        </p>
        <div style={{ marginTop: 24 }}>
          <Link href="/" className={`${styles.button} ${styles.authButton}`} style={{ display: "block", textAlign: "center" }}>
            Back to Login
          </Link>
        </div>
        <div style={{ marginTop: 12, textAlign: "center" }}>
          {cooldown > 0 ? (
            <span style={{ fontSize: 13, color: "var(--aa-on-dark-soft, #a09d96)" }}>
              Resend available in <strong style={{ color: "rgba(250,249,245,0.7)" }}>{cooldown}s</strong>
            </span>
          ) : (
            <button type="button" className={styles.authForgotLink} onClick={() => void handleSendAgain()}>
              Send again
            </button>
          )}
        </div>
      </div>
    );
  }

  // ── Form state ──────────────────────────────────────────────────────────
  return (
    <div className={styles.authCard}>
      <div className={styles.authCardTitle}>Reset your password</div>
      <div className={styles.authCardSub}>
        Enter the email address associated with your Riviso account and we'll
        send you a secure link to reset your password.
      </div>

      <form className={styles.authForm} onSubmit={handleSubmit} noValidate>
        <label className={`${styles.authFieldLabel} ${styles.authField}`}>
          Email Address
          <input
            ref={emailRef}
            className={`${styles.input} ${styles.authInput}`}
            type="email"
            value={email}
            onChange={(e) => { setEmail(e.target.value); if (error) setError(null); }}
            autoComplete="email"
            placeholder="you@example.com"
            disabled={loading}
            required
          />
        </label>

        {error ? (
          <p className={`${styles.error} ${styles.authError}`} role="alert">{error}</p>
        ) : null}

        <button type="submit" className={`${styles.button} ${styles.authButton}`} disabled={loading}>
          {loading ? "Checking…" : "Send Reset Link"}
        </button>
      </form>

      <div style={{ marginTop: 16, textAlign: "center" }}>
        <Link href="/" className={styles.authForgotLink}>← Back to Login</Link>
      </div>
    </div>
  );
}

// ─── Page shell (mirrors reset-password layout) ───────────────────────────────

export default function ForgotPasswordPage() {
  return (
    <div className={styles.authPage}>
      <div className={styles.authShell}>
        {/* Left panel — hero */}
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
          <h1 className={styles.authHero}>Regain access to your account.</h1>
          <p className={styles.authSub}>
            We'll send a secure one-time link to your registered email so you can
            set a new password and get back to work.
          </p>
        </section>

        {/* Right panel — form */}
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

          {/* Suspense required because ForgotPasswordForm uses useSearchParams */}
          <Suspense
            fallback={
              <div className={styles.authCard}>
                <div className={styles.authCardSub}>Loading…</div>
              </div>
            }
          >
            <ForgotPasswordForm />
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
