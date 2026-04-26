import Link from "next/link";

export default function PrivacyPolicyPage() {
  return (
    <div style={{ minHeight: "100vh", background: "#07070a", color: "#fff", padding: "40px 16px" }}>
      <div style={{ width: "min(900px, 100%)", margin: "0 auto" }}>
        <div style={{ marginBottom: 18 }}>
          <Link href="/" style={{ color: "rgba(255,255,255,0.75)", textDecoration: "none", fontWeight: 700 }}>
            ← Home
          </Link>
        </div>

        <h1 style={{ margin: "0 0 10px", fontSize: 36, letterSpacing: "-0.02em" }}>Privacy Policy</h1>
        <div style={{ color: "rgba(255,255,255,0.65)", fontSize: 13, marginBottom: 18 }}>
          Effective date: {new Date().toISOString().slice(0, 10)}
        </div>

        <div style={{ color: "rgba(255,255,255,0.78)", lineHeight: 1.7, fontSize: 14 }}>
          <p>
            This Privacy Policy explains how Auto Articles (“we”, “us”) collects, uses, and protects information when you use
            the application.
          </p>

          <h2 style={{ marginTop: 22, fontSize: 18 }}>Information we collect</h2>
          <ul>
            <li>Account information such as email address and profile settings (e.g. timezone).</li>
            <li>Project configuration you provide (e.g. WordPress settings, optional Search Console property selection).</li>
            <li>Content you create or generate inside the app (article drafts, metadata, images).</li>
          </ul>

          <h2 style={{ marginTop: 22, fontSize: 18 }}>How we use information</h2>
          <ul>
            <li>To provide the core functionality: generating, scheduling, and publishing content.</li>
            <li>To connect integrations you enable (e.g. WordPress, Google Search Console OAuth).</li>
            <li>To maintain security, prevent abuse, and troubleshoot issues.</li>
          </ul>

          <h2 style={{ marginTop: 22, fontSize: 18 }}>Third‑party services</h2>
          <p>
            If you connect third‑party services (e.g. Google OAuth / Search Console), we store tokens as required to keep the
            integration working. You can disconnect at any time by removing the integration or revoking access from your Google
            account.
          </p>

          <h2 style={{ marginTop: 22, fontSize: 18 }}>Contact</h2>
          <p>
            If you have questions about this policy, contact us at <span style={{ fontWeight: 800 }}>support@riviso.com</span>.
          </p>
        </div>
      </div>
    </div>
  );
}

