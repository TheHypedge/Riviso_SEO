import Link from "next/link";

import { LegalPageLayout } from "@/components/legal/LegalPageLayout";
import { SUPPORT_EMAIL } from "@/lib/legalContent";

export const metadata = { title: "Cookie Policy — Riviso" };

export default function CookiePolicyPage() {
  return (
    <LegalPageLayout
      title="Cookie Policy"
      summary={
        <span>
          Riviso uses only the cookies and local storage strictly necessary to keep you signed in and remember your
          display preference. We do not use advertising, tracking, or third-party analytics cookies.
        </span>
      }
    >
      <p>This Cookie Policy explains what cookies and similar technologies (such as browser local storage) Riviso uses, and why.</p>

      <h2>1. Strictly necessary cookies</h2>
      <p>These are required for the Service to function and cannot be switched off without breaking login. They do not require consent under most data protection laws because the Service cannot work without them, but we disclose them here for transparency.</p>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Purpose</th>
            <th>Type</th>
            <th>Duration</th>
          </tr>
        </thead>
        <tbody>
          <tr><td><code>aa_access</code></td><td>Authenticates your session so you stay signed in</td><td>HTTP-only, secure, first-party</td><td>Up to 1 hour</td></tr>
          <tr><td><code>aa_refresh</code></td><td>Silently renews your session without re-entering your password</td><td>HTTP-only, secure, first-party</td><td>Up to 30 days</td></tr>
        </tbody>
      </table>
      <p>Both cookies are HTTP-only (not readable by page scripts) and marked Secure and SameSite to reduce the risk of theft via cross-site scripting or cross-site request forgery.</p>

      <h2>2. Local storage (not a cookie, same purpose)</h2>
      <table>
        <thead>
          <tr>
            <th>Key</th>
            <th>Purpose</th>
          </tr>
        </thead>
        <tbody>
          <tr><td><code>riviso-theme</code></td><td>Remembers whether you chose light or dark mode, so it&apos;s applied instantly on your next visit.</td></tr>
          <tr><td>Session marker</td><td>A non-sensitive flag recording that you&apos;re signed in, used only to decide whether to show the app or the login screen — it holds no token or personal data itself.</td></tr>
        </tbody>
      </table>
      <p>Local storage stays on your device and is never transmitted to us; it is not a tracking mechanism.</p>

      <h2>3. What we do <em>not</em> use</h2>
      <ul>
        <li>No advertising or ad-retargeting cookies.</li>
        <li>No third-party analytics cookies (e.g. Google Analytics) at this time.</li>
        <li>No cross-site tracking or fingerprinting.</li>
      </ul>
      <p>We do use Sentry for error monitoring, which may process technical request data to help us diagnose crashes — see our <Link href="/privacy-policy">Privacy Policy</Link> for detail. This does not set an advertising or tracking cookie.</p>

      <h2>4. Managing cookies</h2>
      <p>Because our cookies are strictly necessary for authentication, blocking them in your browser will prevent you from staying signed in. You can still clear cookies at any time through your browser settings; you will simply need to log in again. If we ever introduce optional analytics or advertising cookies in the future, we will update this policy and the consent banner shown on the site to let you accept or decline them before they are set.</p>

      <h2>5. Changes to this policy</h2>
      <p>We will update this page if the cookies or local storage we use change. Check the effective date above for the latest revision.</p>

      <h2>6. Contact</h2>
      <p>Questions about our use of cookies: <strong>{SUPPORT_EMAIL}</strong>.</p>
    </LegalPageLayout>
  );
}
