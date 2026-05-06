"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { getAccessToken } from "@/lib/api";

export default function Home() {
  const router = useRouter();

  useEffect(() => {
    const token = getAccessToken();
    router.replace(token ? "/dashboard" : "/login");
  }, [router]);

  // Keep it visually clean (no landing page) while redirecting.
  return <div style={{ minHeight: "100dvh", background: "#0b0b0d" }} />;
}
