import type { NextConfig } from "next";

/** Browser builds use NEXT_PUBLIC_API_BASE_URL when calling the API directly; dev rewrites proxy /api to this host (default FastAPI :8000). */
const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  async rewrites() {
    const apiBase =
      process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/+$/, "") ??
      "http://127.0.0.1:8000";
    return [
      {
        source: "/api/:path*",
        destination: `${apiBase}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
