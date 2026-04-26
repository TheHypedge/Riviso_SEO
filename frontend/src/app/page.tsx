import Link from "next/link";

export default function Home() {
  return (
    <div style={{ minHeight: "100vh", background: "#07070a", color: "#fff", display: "flex", flexDirection: "column" }}>
      <main style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: "56px 16px" }}>
        <div style={{ width: "min(980px, 100%)", display: "grid", gap: 18 }}>
          <div style={{ fontWeight: 900, letterSpacing: "-0.02em", opacity: 0.95 }}>Auto Articles</div>
          <h1 style={{ margin: 0, fontSize: "clamp(32px, 4.5vw, 54px)", lineHeight: 1.05, letterSpacing: "-0.03em" }}>
            Create, schedule, and publish SEO-ready articles.
          </h1>
          <p style={{ margin: 0, maxWidth: 720, color: "rgba(255,255,255,0.75)", lineHeight: 1.6 }}>
            Generate content, publish to WordPress, and optionally request a Google Search Console URL inspection automatically after a live publish.
          </p>

          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 6 }}>
            <Link
              href="/login"
              style={{
                background: "linear-gradient(90deg, #ff2e88, #8a2eff, #2e9cff)",
                color: "#fff",
                padding: "12px 16px",
                borderRadius: 12,
                fontWeight: 900,
                textDecoration: "none",
              }}
            >
              Get started
            </Link>
            <Link
              href="/login"
              style={{
                border: "1px solid rgba(255,255,255,0.18)",
                background: "rgb(0, 0, 0)",
                color: "rgba(255,255,255,0.92)",
                padding: "12px 16px",
                borderRadius: 12,
                fontWeight: 800,
                textDecoration: "none",
              }}
            >
              Log in
            </Link>
          </div>
        </div>
      </main>

      <footer style={{ padding: "14px 16px", borderTop: "1px solid rgba(255,255,255,0.10)" }}>
        <div style={{ width: "min(980px, 100%)", margin: "0 auto", display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center" }}>
          <span style={{ color: "rgba(255,255,255,0.55)", fontSize: 12 }}>© {new Date().getFullYear()} Auto Articles</span>
          <span style={{ marginLeft: "auto", display: "flex", gap: 12, flexWrap: "wrap" }}>
            <Link href="/privacy-policy" style={{ color: "rgba(255,255,255,0.72)", fontSize: 12, textDecoration: "none" }}>
              Privacy Policy
            </Link>
            <Link href="/terms" style={{ color: "rgba(255,255,255,0.72)", fontSize: 12, textDecoration: "none" }}>
              Terms & Conditions
            </Link>
          </span>
        </div>
      </footer>
    </div>
  );
}
