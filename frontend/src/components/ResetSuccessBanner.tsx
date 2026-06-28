"use client";

import { useSearchParams } from "next/navigation";

export default function ResetSuccessBanner() {
  const params = useSearchParams();
  if (params.get("reset") !== "success") return null;

  return (
    <div
      role="status"
      style={{
        position: "fixed",
        top: 16,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 9999,
        background: "rgba(93,184,114,0.15)",
        border: "1px solid rgba(93,184,114,0.4)",
        borderRadius: 8,
        padding: "12px 20px",
        color: "#5db872",
        fontSize: 14,
        fontWeight: 500,
        maxWidth: "90vw",
        textAlign: "center",
        pointerEvents: "none",
      }}
    >
      Password updated successfully. Please sign in with your new password.
    </div>
  );
}
