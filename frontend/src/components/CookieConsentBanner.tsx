"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import styles from "./CookieConsentBanner.module.css";

const STORAGE_KEY = "riviso-cookie-notice-ack";

/** Riviso only sets strictly-necessary authentication cookies (see
 * /cookie-policy) -- there's nothing optional to opt in/out of today, so this
 * is a one-time disclosure banner, not a granular preference center. If we
 * ever add non-essential cookies, this is the place to grow a real "manage
 * preferences" control before setting them. */
export function CookieConsentBanner() {
  // Must start false on both server and client (no `window` at SSR time) and
  // flip post-mount -- a lazy useState initializer would read localStorage
  // during the client's hydration pass while the server-rendered markup has
  // no way to know that value yet, producing a hydration mismatch. This is
  // the one case where a mount-only effect is the correct tool, not a lint
  // smell (same tradeoff already accepted elsewhere in this codebase for
  // other client-only-storage reads).
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    try {
      if (window.localStorage.getItem(STORAGE_KEY) !== "1") setVisible(true);
    } catch {
      // Storage blocked (private mode, etc.) -- fail closed to "don't show".
    }
  }, []);

  function dismiss() {
    setVisible(false);
    try {
      window.localStorage.setItem(STORAGE_KEY, "1");
    } catch {
      // Best-effort; nothing else to do if storage is unavailable.
    }
  }

  if (!visible) return null;

  return (
    <div role="region" aria-label="Cookie notice" className={styles.banner}>
      <p className={styles.text}>
        We use only essential cookies to keep you signed in — no advertising or tracking cookies.{" "}
        <Link href="/cookie-policy" className={styles.link}>
          Learn more
        </Link>
      </p>
      <button type="button" onClick={dismiss} className={styles.dismiss}>
        Got it
      </button>
    </div>
  );
}
