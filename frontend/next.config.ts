import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  async rewrites() {
    const apiBase =
      process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/+$/, "") ??
      "http://127.0.0.1:8001";
    return [
      {
        source: "/api/:path*",
        destination: `${apiBase}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
