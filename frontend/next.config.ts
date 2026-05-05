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
const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
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

export default nextConfig;
