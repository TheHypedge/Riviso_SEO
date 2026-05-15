import Image from "next/image";
import Link from "next/link";

export default function TermsPage() {
  return (
    <div style={{ minHeight: "100vh", background: "#07070a", color: "#fff", padding: "40px 16px" }}>
      <div style={{ width: "min(900px, 100%)", margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 18 }}>
          <Link href="/" aria-label="Riviso — home" style={{ display: "inline-flex", alignItems: "center", gap: 10, textDecoration: "none", color: "#fff" }}>
            <Image src="/riviso-logo.png" alt="" width={28} height={28} priority />
            <span style={{ fontWeight: 900, letterSpacing: "-0.02em", fontSize: 18 }}>Riviso</span>
          </Link>
          <Link href="/" style={{ color: "rgba(255,255,255,0.75)", textDecoration: "none", fontWeight: 700 }}>
            ← Home
          </Link>
        </div>

        <h1 style={{ margin: "0 0 10px", fontSize: 36, letterSpacing: "-0.02em" }}>Terms & Conditions</h1>
        <div style={{ color: "rgba(255,255,255,0.65)", fontSize: 13, marginBottom: 18 }}>
          Effective date: {new Date().toISOString().slice(0, 10)}
        </div>

        <div style={{ color: "rgba(255,255,255,0.78)", lineHeight: 1.7, fontSize: 14 }}>
          <p>
            By using Riviso, you agree to these Terms & Conditions. If you do not agree, do not use the service.
          </p>

          <h2 style={{ marginTop: 22, fontSize: 18 }}>Use of the service</h2>
          <ul>
            <li>You are responsible for content you generate and publish using the app.</li>
            <li>You must comply with third‑party platform policies (e.g. WordPress, Google).</li>
            <li>You must not misuse the service or attempt to disrupt it.</li>
          </ul>

          <h2 style={{ marginTop: 22, fontSize: 18 }}>Integrations</h2>
          <p>
            When you connect integrations, you authorize Riviso to act on your behalf for the specific actions you enable
            (e.g. publishing to WordPress; requesting a Search Console URL inspection after a live publish).
          </p>

          <h2 style={{ marginTop: 22, fontSize: 18 }}>No guarantees</h2>
          <p>
            Automated actions (including Google Search Console URL inspection) are best‑effort and depend on third‑party APIs and
            availability. We do not guarantee indexing, rankings, traffic, or outcomes.
          </p>

          <h2 style={{ marginTop: 22, fontSize: 18 }}>Contact</h2>
          <p>
            Questions? Contact <span style={{ fontWeight: 800 }}>support@riviso.com</span>.
          </p>
        </div>
      </div>
    </div>
  );
}

