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

/**
 * New Relic Browser (RUM) init (I5.8).
 *
 * No-ops unless all three of NEXT_PUBLIC_NEW_RELIC_ACCOUNT_ID,
 * NEXT_PUBLIC_NEW_RELIC_LICENSE_KEY, NEXT_PUBLIC_NEW_RELIC_APP_ID are set.
 * Uses the `browser-agent` loader (New Relic's "Pro + SPA" feature set) so
 * client-side route changes between Next.js pages are tracked as separate
 * "route changes", not just the one initial document load. This npm-package
 * approach (vs. the copy/paste <script> snippet) ships as part of the bundle,
 * so it doesn't need a script-src CSP allowance — only connect-src for the
 * beacon (see next.config.ts).
 *
 * These are NOT the same secret class as NEXT_PUBLIC_SENTRY_DSN: New Relic's
 * browser license key is designed to be public (it's shipped in every
 * visitor's JS bundle) and can only submit RUM data, not read account data.
 * It is also NOT the same value as the backend's NEW_RELIC_LICENSE_KEY
 * (backend/.env) — New Relic issues a separate key per agent type (APM vs.
 * Browser); mixing them up silently breaks reporting on whichever side got
 * the wrong one.
 *
 * `init` below mirrors, field-for-field, the config New Relic's own
 * "Copy/Paste JavaScript" snippet generated for this Browser app (account
 * 8371903 / app 1589262849), so behavior matches what the New Relic UI
 * shows as this app's configured settings. One deviation:
 * `distributed_tracing.allowed_origins` is scoped to our own origins — the
 * generic snippet doesn't know Riviso proxies to arbitrary customer
 * WordPress/Shopify URLs, which must never get a trace header stamped on
 * them. Note session_replay is ON (10% sample, 100% on error) with
 * `mask_all_inputs` + `mask_text_selector: '*'` — every input and every
 * text node is masked in the recording, so no typed or displayed content
 * (article text, WP/Shopify credential fields, etc.) is visible in replay,
 * only DOM structure/layout and interaction timing.
 */
const nrAccountId = process.env.NEXT_PUBLIC_NEW_RELIC_ACCOUNT_ID;
const nrLicenseKey = process.env.NEXT_PUBLIC_NEW_RELIC_LICENSE_KEY;
const nrAppId = process.env.NEXT_PUBLIC_NEW_RELIC_APP_ID;

if (nrAccountId && nrLicenseKey && nrAppId) {
  import("@newrelic/browser-agent/loaders/browser-agent")
    .then(({ BrowserAgent }) => {
      new BrowserAgent({
        info: {
          licenseKey: nrLicenseKey,
          applicationID: nrAppId,
          sa: 1,
        },
        loader_config: {
          accountID: nrAccountId,
          trustKey: process.env.NEXT_PUBLIC_NEW_RELIC_TRUST_KEY || nrAccountId,
          agentID: nrAppId,
          licenseKey: nrLicenseKey,
          applicationID: nrAppId,
        },
        init: {
          browser_consent_mode: { enabled: false },
          privacy: { cookies_enabled: true },
          session_replay: {
            enabled: true,
            block_selector: "",
            mask_text_selector: "*",
            sampling_rate: 10.0,
            error_sampling_rate: 100.0,
            mask_all_inputs: true,
            collect_fonts: true,
            inline_images: false,
            fix_stylesheets: true,
            preload: false,
            mask_input_options: {},
          },
          distributed_tracing: {
            enabled: true,
            // Riviso-specific: only stamp trace headers on requests to our own
            // API, never on third-party calls a WordPress/Shopify editor field
            // might trigger (the generic snippet doesn't scope this).
            allowed_origins: [
              typeof window !== "undefined" ? window.location.origin : "",
              process.env.NEXT_PUBLIC_API_BASE_URL || "",
            ].filter(Boolean),
          },
          performance: { capture_measures: true },
          ajax: { deny_list: ["bam.nr-data.net"], capture_payloads: "none" },
        },
      });
    })
    .catch(() => {
      // @newrelic/browser-agent not installed — RUM stays disabled.
    });
}

export const onRouterTransitionStart = undefined;
