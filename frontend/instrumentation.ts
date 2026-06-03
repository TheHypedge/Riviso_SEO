/**
 * Server/edge Sentry init (I5.1).
 *
 * No-ops unless SENTRY_DSN / NEXT_PUBLIC_SENTRY_DSN is set. The dynamic import is
 * guarded so the app builds and runs even if `@sentry/nextjs` is not installed.
 * PII is off by default to keep user data out of the error backend.
 */
export async function register() {
  const dsn = process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN;
  if (!dsn) return;
  try {
    const Sentry = await import("@sentry/nextjs");
    Sentry.init({
      dsn,
      environment: process.env.NEXT_PUBLIC_ENVIRONMENT || process.env.NODE_ENV,
      tracesSampleRate: Number(process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE || "0"),
      sendDefaultPii: false,
    });
  } catch {
    // @sentry/nextjs not installed — error tracking stays disabled.
  }
}

export async function onRequestError(...args: unknown[]) {
  try {
    const Sentry = await import("@sentry/nextjs");
    // captureRequestError exists in modern @sentry/nextjs; ignore if not.
    (Sentry as { captureRequestError?: (...a: unknown[]) => void }).captureRequestError?.(...args);
  } catch {
    // no-op
  }
}
