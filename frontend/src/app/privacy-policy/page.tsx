import Link from "next/link";

import { LegalPageLayout } from "@/components/legal/LegalPageLayout";
import { ENTITY_NAME, GRIEVANCE_EMAIL, PRIVACY_EMAIL, REGISTERED_ADDRESS, SUPPORT_EMAIL } from "@/lib/legalContent";

export const metadata = { title: "Privacy Policy — Riviso" };

export default function PrivacyPolicyPage() {
  return (
    <LegalPageLayout
      title="Privacy Policy"
      summary={
        <span>
          In short: we collect what&apos;s needed to run your projects and publish your content, we encrypt the
          credentials you connect (WordPress, Shopify, Google), we never sell your data, and you can export or
          permanently delete your account at any time. If you&apos;re looking for India-specific rights under the
          Digital Personal Data Protection Act, see our <Link href="/data-privacy-policy">Data Privacy Policy</Link>.
        </span>
      }
    >
      <p>
        This Privacy Policy explains how {ENTITY_NAME} (&ldquo;<strong>Riviso</strong>&rdquo;, &ldquo;we&rdquo;,
        &ldquo;us&rdquo;, &ldquo;our&rdquo;) collects, uses, discloses, and protects information when you use the
        Riviso application, website, and related services (the &ldquo;Service&rdquo;). It applies to visitors,
        registered users, and their end customers where relevant. By using the Service you agree to the practices
        described here. If you do not agree, please do not use the Service.
      </p>
      <p>
        This policy is written to be accurate to how Riviso actually works today. Where a feature or integration is
        optional (for example, connecting WordPress or Google Search Console), the related data collection only
        happens if you choose to enable it.
      </p>

      <h2>1. Information we collect</h2>

      <h3>1.1 Account information</h3>
      <ul>
        <li>Email address, and password (stored only as a salted Argon2id hash — we never store or can recover your plain-text password).</li>
        <li>Optional profile details you provide: full name, phone number, timezone.</li>
        <li>Subscription/plan tier and usage counters (e.g. articles generated this month) used to enforce your plan&apos;s limits.</li>
      </ul>

      <h3>1.2 Project and integration data</h3>
      <p>You choose what to connect. We only collect the following when you set it up:</p>
      <ul>
        <li><strong>WordPress:</strong> site URL, WordPress username, and an Application Password you generate in your own WordPress admin. The Application Password is encrypted at rest and used only to publish/update posts you initiate.</li>
        <li><strong>Shopify:</strong> your store domain and the OAuth access token / API credentials Shopify issues when you authorize the connection. Encrypted at rest; used only for the store actions you initiate (e.g. publishing a blog article).</li>
        <li><strong>Google Search Console:</strong> if you connect a property, we request read/management access (the Google &ldquo;webmasters&rdquo; scope) to show performance data and, where you request it, to submit a URL for indexing after you publish. OAuth tokens are encrypted at rest. Our use of Google user data complies with the <a href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank" rel="noreferrer">Google API Services User Data Policy</a>, including its Limited Use requirements.</li>
        <li>Website URL and platform choice for projects you create, including projects you choose to leave unconnected while trying Riviso out.</li>
      </ul>

      <h3>1.3 Content you create</h3>
      <ul>
        <li>Article drafts, titles, metadata, and generated or uploaded images.</li>
        <li>Prompts and prompt templates you write or customize (writing prompts, image prompts).</li>
        <li>Keywords, topic clusters, and research inputs you provide or that our tools derive from a website you connect.</li>
      </ul>

      <h3>1.4 Technical and usage data</h3>
      <ul>
        <li>IP address, browser/device information, and request metadata — used transiently for security, rate-limiting, and abuse prevention, not for advertising.</li>
        <li>Application logs and error reports (see &ldquo;Third-party processors&rdquo; below regarding our error-monitoring provider).</li>
        <li>Authentication session identifiers stored in secure, HTTP-only cookies (see our <Link href="/cookie-policy">Cookie Policy</Link>).</li>
      </ul>

      <h2>2. How we use information</h2>
      <ul>
        <li>To provide the Service: generating, editing, scheduling, and publishing content you request.</li>
        <li>To operate integrations you enable (WordPress, Shopify, Google Search Console) strictly for the actions you initiate.</li>
        <li>To send transactional email: email verification codes, password reset links, and account/plan notifications.</li>
        <li>To enforce plan limits and prevent abuse of the Service.</li>
        <li>To maintain, secure, debug, and improve the Service (including via the error-monitoring tool described below).</li>
        <li>To comply with legal obligations and respond to lawful requests.</li>
      </ul>
      <p>We do not sell your personal information, and we do not use your account or content data to train third-party AI models beyond what is strictly needed to generate the content you request in the moment.</p>

      <h2>3. AI-generated content</h2>
      <p>
        Riviso uses OpenAI&apos;s API to generate article text and images from the prompts, keywords, and settings you
        provide. The text/prompts sent to generate your content are transmitted to OpenAI for that purpose under
        OpenAI&apos;s own API data-use terms, which (at the time of writing) do not use API-submitted content to train
        their models by default. You are responsible for reviewing AI-generated content before publishing it — see
        our <Link href="/disclaimer">Disclaimer</Link>.
      </p>

      <h2>4. Third-party processors</h2>
      <p>We use a small number of service providers to operate Riviso. Each only receives the data necessary to perform its function:</p>
      <table>
        <thead>
          <tr>
            <th>Provider</th>
            <th>Purpose</th>
            <th>Data involved</th>
          </tr>
        </thead>
        <tbody>
          <tr><td>OpenAI</td><td>Article/image generation</td><td>Prompts, keywords, generation settings you submit</td></tr>
          <tr><td>Google (Search Console API)</td><td>Performance data, indexing requests</td><td>OAuth token, the property you connect</td></tr>
          <tr><td>WordPress (your own site)</td><td>Publishing content you request</td><td>Application Password, published content</td></tr>
          <tr><td>Shopify (your own store)</td><td>Publishing content you request</td><td>OAuth token, published content</td></tr>
          <tr><td>MongoDB Atlas</td><td>Primary database hosting</td><td>All account, project, and content data described above</td></tr>
          <tr><td>Hosting providers (Vercel, our VPS host)</td><td>Running the application</td><td>Request/traffic data necessary to serve the Service</td></tr>
          <tr><td>Sentry</td><td>Error monitoring / crash reporting</td><td>Technical error context (e.g. stack traces); we configure it to avoid sending passwords or credentials</td></tr>
          <tr><td>Email delivery (SMTP provider)</td><td>Verification and account emails</td><td>Your email address and the message content</td></tr>
        </tbody>
      </table>
      <p>These providers are contractually or by policy restricted to using data only to provide their service to us, not for their own independent purposes.</p>

      <h2>5. Data security</h2>
      <ul>
        <li>Passwords are hashed with Argon2id — never stored or logged in plain text.</li>
        <li>Sensitive connection credentials (WordPress application passwords, Shopify tokens, Google OAuth tokens) are encrypted at rest.</li>
        <li>Authentication uses short-lived, HTTP-only, secure session cookies rather than tokens exposed to page scripts.</li>
        <li>Outbound requests you configure (e.g. to a WordPress/Shopify URL) are checked against known internal/private network ranges to prevent server-side request forgery.</li>
        <li>No method of transmission or storage is 100% secure; we work to protect your information but cannot guarantee absolute security.</li>
      </ul>

      <h2>6. Data retention</h2>
      <p>
        We retain your account and project data for as long as your account is active. If you deactivate your
        account, your projects and articles are retained so you can reactivate later with your data intact. If you
        permanently delete your account (available any time from your Profile settings, or by emailing{" "}
        {SUPPORT_EMAIL}), we erase your projects, articles, scheduled jobs, and subscription records. Some records
        may be retained where required by law (e.g. billing/tax records, security logs) for the period required by
        the applicable regulation.
      </p>

      <h2>7. Your rights</h2>
      <p>
        Depending on where you live, you may have rights to access, correct, export, or delete your personal data,
        to object to or restrict certain processing, and to withdraw consent at any time. You can exercise most of
        these directly in the app (Profile settings), or by contacting {PRIVACY_EMAIL}. Indian users: see our{" "}
        <Link href="/data-privacy-policy">Data Privacy Policy</Link> for Digital Personal Data Protection Act, 2023
        specific rights and our <Link href="/grievance-redressal">Grievance Redressal</Link> process. EU/UK users
        have rights under the General Data Protection Regulation (GDPR); California residents have rights under the
        CCPA/CPRA, including the right to know, delete, and opt out of the sale of personal information — we do not
        sell personal information as defined by the CCPA.
      </p>

      <h2>8. International data transfers</h2>
      <p>
        Our infrastructure and service providers may process data outside your home country (for example, our
        database and hosting providers may operate servers in other regions). Where we transfer personal data
        internationally, we rely on the transfer mechanisms recognized under applicable law (such as standard
        contractual clauses under GDPR) and take steps to ensure an equivalent level of protection.
      </p>

      <h2>9. Children&apos;s privacy</h2>
      <p>Riviso is not directed at children and is not intended for use by anyone under 18. We do not knowingly collect personal data from children. If you believe a child has provided us data, contact {SUPPORT_EMAIL} and we will delete it.</p>

      <h2>10. Changes to this policy</h2>
      <p>We may update this Privacy Policy from time to time. Material changes will be reflected by updating the effective date above; continued use of the Service after a change constitutes acceptance of the revised policy.</p>

      <h2>11. Contact us</h2>
      <p>
        Questions about this policy or your data: <strong>{SUPPORT_EMAIL}</strong>.<br />
        Grievance Officer (India): <strong>{GRIEVANCE_EMAIL}</strong> — see{" "}
        <Link href="/grievance-redressal">Grievance Redressal</Link> for details.
        <br />
        Registered address: <em>{REGISTERED_ADDRESS}</em>
      </p>
    </LegalPageLayout>
  );
}
