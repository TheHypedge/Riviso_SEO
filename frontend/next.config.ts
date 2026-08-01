import type { NextConfig } from "next";

/**
 * Proxies browser requests to `/api/*` → `{apiBase}/api/*`.
 *
 * - Local dev: defaults to `http://127.0.0.1:8000`.
 * - Vercel/production: set **BACKEND_URL** (preferred, server-only) or **NEXT_PUBLIC_API_BASE_URL**
 *   to your **public** FastAPI origin (e.g. `https://api.riviso.com`). Do not leave the default —
 *   Vercel cannot reach `127.0.0.1:8000`.
 *
 * Pair with `getApiBaseUrl()` in `src/lib/api.ts`: when `NEXT_PUBLIC_API_BASE_URL` is unset, the
 * client uses the **same origin** (e.g. `https://riviso.com`) so login hits `/api/...` on the
 * frontend host and this rewrite forwards to your VPS.
 */
// S1.14: security headers applied to all frontend responses. HSTS is only
// emitted in production so local HTTP dev isn't forced onto HTTPS.
const isProduction = process.env.NODE_ENV === "production";

// F0.5: Content-Security-Policy. Deliberately permissive on script-src/style-src
// ('unsafe-inline') because Next.js App Router hydration relies on small inline
// scripts and no nonce-plumbing exists yet -- tightening to strict-dynamic + nonces
// is a follow-up, not a blocker for this pass. img-src allows any https: origin
// (plus data: for base64 previews) because article/featured images are fetched
// from arbitrary customer WordPress/Shopify sites, not a fixed set of domains.
// connect-src is scoped to self + Sentry's ingest hosts (Sentry no-ops without a
// DSN, so this is a no-op allowance when unconfigured). frame-ancestors 'none'
// backs up X-Frame-Options for browsers that honor CSP over the legacy header.
const cspDirectives = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  "connect-src 'self' https://*.ingest.sentry.io https://*.ingest.us.sentry.io https://*.sentry.io",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
  { key: "Permissions-Policy", value: "geolocation=(), microphone=(), camera=()" },
  { key: "Content-Security-Policy", value: cspDirectives },
  ...(isProduction
    ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" }]
    : []),
];

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
  async rewrites() {
    const raw = process.env.BACKEND_URL || process.env.NEXT_PUBLIC_API_BASE_URL || "";
    const apiBase = raw.trim().replace(/\/+$/, "") || "http://127.0.0.1:8000";
    return [
      {
        source: "/api/:path*",
        destination: `${apiBase}/api/:path*`,
      },
    ];
  },
};

// I5.1: wrap with Sentry's Next plugin (source maps upload, tunneling) only when
// the package is installed. Guarded require keeps `next build` working without it.
let exportedConfig: NextConfig = nextConfig;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { withSentryConfig } = require("@sentry/nextjs");
  exportedConfig = withSentryConfig(nextConfig, {
    silent: !process.env.CI,
    org: process.env.SENTRY_ORG,
    project: process.env.SENTRY_PROJECT,
    // Only attempt source-map upload when an auth token is present.
    authToken: process.env.SENTRY_AUTH_TOKEN,
    disableLogger: true,
  });
} catch {
  // @sentry/nextjs not installed — ship the plain config.
}

export default exportedConfig;
