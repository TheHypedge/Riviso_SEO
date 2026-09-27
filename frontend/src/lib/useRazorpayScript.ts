import { useCallback, useState } from "react";

type RazorpayInstance = {
  open: () => void;
  on: (event: string, handler: (response: unknown) => void) => void;
};

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => RazorpayInstance;
  }
}

const RAZORPAY_SCRIPT_SRC = "https://checkout.razorpay.com/v1/checkout.js";
const LOAD_TIMEOUT_MS = 15_000;
const LOAD_ERROR_MESSAGE = "Couldn't load the payment provider — check your connection and try again.";

let loadPromise: Promise<void> | null = null;

/** Injects checkout.js on first use (not globally on every page load), dedupes across
 * repeated calls/StrictMode double-invokes, and fails with a clear, connection-flavored
 * message on timeout rather than leaving the caller waiting indefinitely. */
function loadRazorpayScript(): Promise<void> {
  if (typeof window === "undefined") return Promise.reject(new Error(LOAD_ERROR_MESSAGE));
  if (window.Razorpay) return Promise.resolve();
  if (loadPromise) return loadPromise;

  loadPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${RAZORPAY_SCRIPT_SRC}"]`);
    if (existing && window.Razorpay) {
      resolve();
      return;
    }
    const script = existing ?? document.createElement("script");
    const timer = window.setTimeout(() => reject(new Error(LOAD_ERROR_MESSAGE)), LOAD_TIMEOUT_MS);
    script.addEventListener(
      "load",
      () => {
        window.clearTimeout(timer);
        if (window.Razorpay) resolve();
        else reject(new Error(LOAD_ERROR_MESSAGE));
      },
      { once: true },
    );
    script.addEventListener(
      "error",
      () => {
        window.clearTimeout(timer);
        reject(new Error(LOAD_ERROR_MESSAGE));
      },
      { once: true },
    );
    if (!existing) {
      script.src = RAZORPAY_SCRIPT_SRC;
      script.async = true;
      document.head.appendChild(script);
    }
  }).catch((e) => {
    loadPromise = null; // don't cache a permanent failure -- allow the next call to retry
    throw e;
  });

  return loadPromise;
}

export function useRazorpayScript() {
  const [state, setState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  const ensureLoaded = useCallback(async (): Promise<boolean> => {
    setState("loading");
    setError(null);
    try {
      await loadRazorpayScript();
      setState("ready");
      return true;
    } catch (e) {
      setState("error");
      setError(e instanceof Error ? e.message : LOAD_ERROR_MESSAGE);
      return false;
    }
  }, []);

  return { state, error, ensureLoaded };
}
