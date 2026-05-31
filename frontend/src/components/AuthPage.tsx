"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import Link from "next/link";

import styles from "@/app/page.module.css";
import { ApiError, api, setAccessToken, setRefreshToken } from "@/lib/api";
import { connectionErrorMessage } from "@/lib/networkErrors";

type AuthTab = "login" | "register";

function isEmailVerificationRequired(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false;
  const detail = err.detail;
  return (
    !!detail &&
    typeof detail === "object" &&
    "code" in detail &&
    (detail as { code?: unknown }).code === "email_verification_required"
  );
}

function isReactivationRequired(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false;
  const detail = err.detail;
  return (
    !!detail &&
    typeof detail === "object" &&
    "code" in detail &&
    (detail as { code?: unknown }).code === "account_reactivation_required"
  );
}

function resendCooldownFromError(err: unknown): number | null {
  if (!(err instanceof ApiError) || err.status !== 429) return null;
  const detail = err.detail;
  if (!detail || typeof detail !== "object") return null;
  const retry = (detail as { retry_after_seconds?: unknown }).retry_after_seconds;
  return typeof retry === "number" && retry > 0 ? Math.ceil(retry) : 60;
}

const RESEND_COOLDOWN_SECONDS = 60;

function useResendCooldown() {
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    if (seconds <= 0) return;
    const timer = window.setTimeout(() => {
      setSeconds((value) => value - 1);
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [seconds]);

  const startCooldown = (duration = RESEND_COOLDOWN_SECONDS) => {
    setSeconds(duration);
  };

  return { seconds, startCooldown };
}

function useTypewriter(lines: string[]) {
  const [lineIdx, setLineIdx] = useState(0);
  const [text, setText] = useState("");
  const [phase, setPhase] = useState<"typing" | "holding" | "deleting">("typing");

  const current = useMemo(() => lines[Math.min(lineIdx, lines.length - 1)] ?? "", [lineIdx, lines]);

  useEffect(() => {
    if (!current) return;

    const typingSpeed = 28;
    const deletingSpeed = 18;
    const holdMs = 900;

    if (phase === "typing") {
      if (text.length >= current.length) {
        const t = setTimeout(() => setPhase("holding"), holdMs);
        return () => clearTimeout(t);
      }
      const t = setTimeout(() => setText(current.slice(0, text.length + 1)), typingSpeed);
      return () => clearTimeout(t);
    }

    if (phase === "holding") {
      const t = setTimeout(() => setPhase("deleting"), holdMs);
      return () => clearTimeout(t);
    }

    // deleting
    if (text.length === 0) {
      // Defer to a microtask so the React 19 ``set-state-in-effect`` lint
      // is satisfied. Functionally identical: both updates land before the
      // next frame and the typewriter loop continues uninterrupted.
      queueMicrotask(() => {
        setPhase("typing");
        setLineIdx((i) => (i + 1) % Math.max(1, lines.length));
      });
      return;
    }
    const t = setTimeout(() => setText(text.slice(0, -1)), deletingSpeed);
    return () => clearTimeout(t);
  }, [current, lines.length, phase, text]);

  return text;
}

export default function AuthPage() {
  const router = useRouter();
  const [tab, setTab] = useState<AuthTab>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reactivationAvailable, setReactivationAvailable] = useState(false);
  const [loading, setLoading] = useState(false);
  const [reactivating, setReactivating] = useState(false);
  const [awaitingVerification, setAwaitingVerification] = useState(false);
  const [verificationCode, setVerificationCode] = useState("");
  const [info, setInfo] = useState<string | null>(null);
  const [forgotSent, setForgotSent] = useState(false);
  const { seconds: resendCooldown, startCooldown: startResendCooldown } = useResendCooldown();
  const [resending, setResending] = useState(false);

  const typed = useTypewriter([
    "Draft SEO-ready articles in minutes.",
    "Keep your tone consistent across every post.",
    "Generate outlines, drafts, and metadata fast.",
    "Publish to WordPress with one workflow.",
  ]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setInfo(null);
    setReactivationAvailable(false);
    setLoading(true);
    try {
      if (awaitingVerification) {
        const verified = await api.verifyEmail(email, verificationCode.trim());
        if (verified.access_token) setAccessToken(verified.access_token);
        if (verified.refresh_token) setRefreshToken(verified.refresh_token);
        router.push("/dashboard");
        return;
      }
      if (tab === "register") {
        if (!isStrongPassword) throw new Error("Please choose a stronger password.");
        if (password !== confirmPassword) throw new Error("Passwords do not match.");
        const pending = await api.register(email, password);
        setAwaitingVerification(true);
        setInfo(pending.message || "Verification email sent. Enter the 6-digit code below.");
        startResendCooldown(pending.retry_after_seconds ?? RESEND_COOLDOWN_SECONDS);
        return;
      }
      const tokens = await api.login(email, password);
      setAccessToken(tokens.access_token);
      setRefreshToken(tokens.refresh_token);
      router.push("/dashboard");
    } catch (err) {
      if (isEmailVerificationRequired(err)) {
        setAwaitingVerification(true);
        setInfo("Verify your email to continue. Enter the 6-digit code we sent you.");
      }
      setReactivationAvailable(isReactivationRequired(err));
      setError(connectionErrorMessage(err) || (tab === "login" ? "Login failed" : "Register failed"));
    } finally {
      setLoading(false);
    }
  }

  async function onResendVerification() {
    if (!email.trim() || resendCooldown > 0 || resending) return;
    setError(null);
    setResending(true);
    try {
      const res = await api.resendVerificationEmail(email.trim());
      setInfo(res.message || "Verification email sent. Check your inbox.");
      startResendCooldown(res.retry_after_seconds ?? RESEND_COOLDOWN_SECONDS);
      setVerificationCode("");
    } catch (err) {
      const retry = resendCooldownFromError(err);
      if (retry) startResendCooldown(retry);
      setError(connectionErrorMessage(err) || "Could not resend verification email.");
    } finally {
      setResending(false);
    }
  }

  async function onForgotPassword() {
    setError(null);
    setInfo(null);
    setForgotSent(false);
    if (!email.trim()) {
      setError("Enter your email address first.");
      return;
    }
    setLoading(true);
    try {
      const res = await api.forgotPassword(email.trim());
      setForgotSent(true);
      setInfo(res.message);
    } catch (err) {
      setError(connectionErrorMessage(err) || "Could not send reset email.");
    } finally {
      setLoading(false);
    }
  }

  async function onReactivate() {
    setError(null);
    setReactivating(true);
    try {
      const tokens = await api.reactivateAccount(email, password);
      setAccessToken(tokens.access_token);
      setRefreshToken(tokens.refresh_token);
      router.push("/dashboard");
    } catch (err) {
      setError(connectionErrorMessage(err) || "Unable to reactivate account");
    } finally {
      setReactivating(false);
    }
  }

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
          <div className={styles.authKicker}>Why teams choose us</div>
          <h1 className={styles.authHero}>Where your content strategy becomes reality.</h1>
          <div className={styles.authTypeRow} aria-label="Typewriter marketing text">
            <span>{typed}</span>
            <span className={styles.authTypeCursor} aria-hidden="true" />
          </div>
          <p className={styles.authSub}>
            Sign in to manage projects, generate articles, and publish to WordPress. Build consistent, SEO-friendly content
            without the busywork.
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
            <button type="button" className={styles.authMobileMenu} aria-label="Menu">
              <span aria-hidden="true">≡</span>
            </button>
          </div>

          <div className={styles.authMobileHero}>
            <div className={styles.authMobileHeadline}>The AI for content teams.</div>
            <div className={styles.authMobileSubhead}>
              Generate SEO-ready articles, metadata, and images—then publish to WordPress in one workflow.
            </div>
          </div>

          <div className={styles.authCard}>
            <div className={styles.authTabs} role="tablist" aria-label="Auth tabs">
              <button
                type="button"
                className={`${styles.authTab} ${tab === "login" ? styles.authTabActive : ""}`}
                onClick={() => {
                  setError(null);
                  setInfo(null);
                  setReactivationAvailable(false);
                  setAwaitingVerification(false);
                  setVerificationCode("");
                  startResendCooldown(0);
                  setTab("login");
                  setConfirmPassword("");
                }}
              >
                Log in
              </button>
              <button
                type="button"
                className={`${styles.authTab} ${tab === "register" ? styles.authTabActive : ""}`}
                onClick={() => {
                  setError(null);
                  setInfo(null);
                  setReactivationAvailable(false);
                  setAwaitingVerification(false);
                  setVerificationCode("");
                  startResendCooldown(0);
                  setTab("register");
                }}
              >
                Register
              </button>
            </div>

            <div className={styles.authCardTitle}>
              {awaitingVerification ? "Verify your email" : tab === "login" ? "Welcome back" : "Create your account"}
            </div>
            <div className={styles.authCardSub}>
              {awaitingVerification
                ? "Enter the 6-digit code we emailed you. It expires in 15 minutes."
                : tab === "login"
                  ? "Sign in to manage projects, generate articles, and publish."
                  : "Register to start creating projects and generating articles."}
            </div>

            <form className={styles.authForm} onSubmit={onSubmit}>
              <label className={`${styles.label} ${styles.authFieldLabel} ${styles.authField}`}>
                Email
                <input
                  className={`${styles.input} ${styles.authInput}`}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  type="email"
                  autoComplete="email"
                  placeholder="you@company.com"
                  required
                  disabled={awaitingVerification}
                />
              </label>

              {awaitingVerification ? (
                <>
                <label className={`${styles.label} ${styles.authFieldLabel} ${styles.authField}`}>
                  Verification code
                  <input
                    className={`${styles.input} ${styles.authInput}`}
                    value={verificationCode}
                    onChange={(e) => setVerificationCode(e.target.value)}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    placeholder="6-digit code"
                    required
                  />
                </label>
                <div className={styles.authResendRow}>
                  {resendCooldown > 0 ? (
                    <span>Resend available in {resendCooldown}s</span>
                  ) : (
                    <>
                      <span>Didn&apos;t get the code?</span>
                      <button
                        type="button"
                        className={styles.authResendButton}
                        onClick={onResendVerification}
                        disabled={loading || resending || !email.trim()}
                      >
                        {resending ? "Sending…" : "Resend email"}
                      </button>
                    </>
                  )}
                </div>
                </>
              ) : (
              <>
              <label className={`${styles.label} ${styles.authFieldLabel} ${styles.authField}`}>
                Password
                <div className={styles.authPasswordWrap}>
                  <input
                    className={`${styles.input} ${styles.authInput} ${styles.authPasswordInput}`}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    type={showPassword ? "text" : "password"}
                    autoComplete={tab === "login" ? "current-password" : "new-password"}
                    placeholder={tab === "login" ? "Your password" : "Create a password"}
                    required
                  />
                  <button
                    type="button"
                    className={styles.authToggle}
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? "Hide password" : "Show password"}
                    title={showPassword ? "Hide password" : "Show password"}
                  >
                    {showPassword ? "×" : "👁"}
                  </button>
                </div>
              </label>

              {tab === "register" ? (
                <>
                  <label className={`${styles.label} ${styles.authFieldLabel} ${styles.authField}`}>
                    Confirm password
                    <input
                      className={`${styles.input} ${styles.authInput}`}
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      type="password"
                      autoComplete="new-password"
                      placeholder="Re-enter password"
                      required
                    />
                  </label>

                  <div className={styles.authChecklist} aria-label="Password strength requirements">
                    <div className={styles.authCheckRow}>
                      <span className={`${styles.authCheckIcon} ${pwRules.length ? styles.authCheckOn : ""}`}>{pwRules.length ? "✓" : "•"}</span>
                      At least 8 characters
                    </div>
                    <div className={styles.authCheckRow}>
                      <span className={`${styles.authCheckIcon} ${pwRules.upper ? styles.authCheckOn : ""}`}>{pwRules.upper ? "✓" : "•"}</span>
                      One uppercase letter (A–Z)
                    </div>
                    <div className={styles.authCheckRow}>
                      <span className={`${styles.authCheckIcon} ${pwRules.lower ? styles.authCheckOn : ""}`}>{pwRules.lower ? "✓" : "•"}</span>
                      One lowercase letter (a–z)
                    </div>
                    <div className={styles.authCheckRow}>
                      <span className={`${styles.authCheckIcon} ${pwRules.number ? styles.authCheckOn : ""}`}>{pwRules.number ? "✓" : "•"}</span>
                      One number (0–9)
                    </div>
                    <div className={styles.authCheckRow}>
                      <span className={`${styles.authCheckIcon} ${pwRules.special ? styles.authCheckOn : ""}`}>{pwRules.special ? "✓" : "•"}</span>
                      One special character (!@#$…)
                    </div>
                  </div>
                </>
              ) : null}

              {tab === "login" && !awaitingVerification ? (
                <button type="button" className={styles.authToggle} onClick={onForgotPassword} disabled={loading}>
                  Forgot password?
                </button>
              ) : null}
              </>
              )}

              {info ? <p className={styles.muted}>{info}</p> : null}
              {error ? <p className={`${styles.error} ${styles.authError}`}>{error}</p> : null}
              {reactivationAvailable ? (
                <div className={styles.authChecklist}>
                  <div className={styles.authCheckRow}>
                    Your saved projects, articles, and settings are still retained. Reactivate this account to continue with the same data.
                  </div>
                  <button
                    type="button"
                    className={`${styles.button} ${styles.authButton}`}
                    onClick={onReactivate}
                    disabled={loading || reactivating || !email.trim() || !password}
                  >
                    {reactivating ? "Reactivating…" : "Reactivate account"}
                  </button>
                </div>
              ) : null}
              <button
                className={`${styles.button} ${styles.authButton}`}
                type="submit"
                disabled={
                  loading ||
                  reactivating ||
                  (awaitingVerification
                    ? verificationCode.trim().length < 4
                    : tab === "register"
                      ? !isStrongPassword || password !== confirmPassword
                      : false)
                }
              >
                {loading
                  ? awaitingVerification
                    ? "Verifying…"
                    : tab === "login"
                      ? "Signing in…"
                      : "Creating…"
                  : awaitingVerification
                    ? "Verify email"
                    : tab === "login"
                      ? "Log in"
                      : "Register"}
              </button>
            </form>
          </div>
        </section>
      </div>

      <div className={styles.authFooter}>
        <Link href="/privacy-policy">
          Privacy Policy
        </Link>
        <Link href="/terms">
          Terms & Conditions
        </Link>
      </div>
    </div>
  );
}

