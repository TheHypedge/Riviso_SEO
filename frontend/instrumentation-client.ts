/**
 * Browser Sentry init (I5.1).
 *
 * No-ops unless NEXT_PUBLIC_SENTRY_DSN is set. Guarded dynamic import keeps the
 * client bundle working without `@sentry/nextjs` installed.
 */
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  import("@sentry/nextjs")
    .then((Sentry) => {
      Sentry.init({
        dsn,
        environment: process.env.NEXT_PUBLIC_ENVIRONMENT || process.env.NODE_ENV,
        tracesSampleRate: Number(process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE || "0"),
        replaysSessionSampleRate: 0,
        replaysOnErrorSampleRate: 0,
        sendDefaultPii: false,
      });
    })
    .catch(() => {
      // @sentry/nextjs not installed — error tracking stays disabled.
    });
}

export const onRouterTransitionStart = undefined;
