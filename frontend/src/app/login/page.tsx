"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

import styles from "../page.module.css";
import { api, setAccessToken, setRefreshToken } from "@/lib/api";

type AuthTab = "login" | "register";

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
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPhase("typing");
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLineIdx((i) => (i + 1) % Math.max(1, lines.length));
      return;
    }
    const t = setTimeout(() => setText(text.slice(0, -1)), deletingSpeed);
    return () => clearTimeout(t);
  }, [current, lines.length, phase, text]);

  return text;
}

export default function LoginPage() {
  const router = useRouter();
  const [tab, setTab] = useState<AuthTab>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const typed = useTypewriter([
    "Draft SEO-ready articles in minutes.",
    "Keep your tone consistent across every post.",
    "Generate outlines, drafts, and metadata fast.",
    "Publish to WordPress with one workflow.",
  ]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      if (tab === "register") {
        if (!isStrongPassword) throw new Error("Please choose a stronger password.");
        if (password !== confirmPassword) throw new Error("Passwords do not match.");
      }
      const tokens = tab === "login" ? await api.login(email, password) : await api.register(email, password);
      setAccessToken(tokens.access_token);
      setRefreshToken(tokens.refresh_token);
      router.push("/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : tab === "login" ? "Login failed" : "Register failed");
    } finally {
      setLoading(false);
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
          <div className={styles.authBrand}>Auto Articles</div>
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
          <div className={styles.authCard}>
            <div className={styles.authTabs} role="tablist" aria-label="Auth tabs">
              <button
                type="button"
                className={`${styles.authTab} ${tab === "login" ? styles.authTabActive : ""}`}
                onClick={() => {
                  setError(null);
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
                  setTab("register");
                }}
              >
                Register
              </button>
            </div>

            <div className={styles.authCardTitle}>{tab === "login" ? "Welcome back" : "Create your account"}</div>
            <div className={styles.authCardSub}>
              {tab === "login"
                ? "Sign in to manage projects, generate articles, and publish."
                : "Register to start creating projects and generating articles."}
            </div>

            <form
              className={styles.authForm}
              onSubmit={onSubmit}
            >
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
                />
              </label>

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

              {error ? <p className={`${styles.error} ${styles.authError}`}>{error}</p> : null}
              <button
                className={`${styles.button} ${styles.authButton}`}
                type="submit"
                disabled={
                  loading ||
                  (tab === "register" ? !isStrongPassword || password !== confirmPassword : false)
                }
              >
                {loading ? (tab === "login" ? "Signing in…" : "Creating…") : tab === "login" ? "Log in" : "Register"}
              </button>
            </form>
          </div>
        </section>
      </div>

      <div style={{ marginTop: 18, display: "flex", gap: 12, flexWrap: "wrap", justifyContent: "center" }}>
        <Link href="/privacy-policy" style={{ color: "rgba(255,255,255,0.72)", fontSize: 12, textDecoration: "none" }}>
          Privacy Policy
        </Link>
        <Link href="/terms" style={{ color: "rgba(255,255,255,0.72)", fontSize: 12, textDecoration: "none" }}>
          Terms & Conditions
        </Link>
      </div>
    </div>
  );
}

