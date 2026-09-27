import Link from "next/link";

import { LegalPageLayout } from "@/components/legal/LegalPageLayout";
import { ENTITY_NAME, SUPPORT_EMAIL } from "@/lib/legalContent";

export const metadata = { title: "Terms & Conditions — Riviso" };

export default function TermsPage() {
  return (
    <LegalPageLayout
      title="Terms & Conditions"
      summary={
        <span>
          You own the content you create in Riviso. You&apos;re responsible for reviewing AI-generated content
          before publishing it, and for complying with the third-party platforms (WordPress, Shopify, Google) you
          connect. We don&apos;t guarantee search rankings, traffic, or indexing outcomes.
        </span>
      }
    >
      <p>
        These Terms & Conditions (&ldquo;Terms&rdquo;) govern your access to and use of the Riviso application,
        website, and related services (the &ldquo;Service&rdquo;), operated by {ENTITY_NAME} (&ldquo;we&rdquo;,
        &ldquo;us&rdquo;). By creating an account or using the Service, you agree to these Terms. If you are using
        the Service on behalf of an organization, you represent that you have authority to bind that organization.
      </p>

      <h2>1. Eligibility and accounts</h2>
      <ul>
        <li>You must be at least 18 years old to use the Service.</li>
        <li>You are responsible for maintaining the confidentiality of your login credentials and for all activity under your account.</li>
        <li>You must provide accurate information when registering and keep it up to date.</li>
      </ul>

      <h2>2. Your content</h2>
      <ul>
        <li>You retain ownership of the content you create, upload, or generate using the Service (&ldquo;Your Content&rdquo;).</li>
        <li>You grant us a limited license to host, process, and transmit Your Content solely to provide the Service to you (e.g. sending it to our AI provider to generate text/images, or publishing it to a website you connect).</li>
        <li>You are solely responsible for Your Content, including its accuracy, legality, and compliance with any platform (WordPress, Shopify) or third-party rights (copyright, trademark, defamation) it may implicate.</li>
        <li>AI-generated drafts are a starting point. Review and edit generated content before publishing — see our <Link href="/disclaimer">Disclaimer</Link>.</li>
      </ul>

      <h2>3. Plans, usage limits, and billing</h2>
      <ul>
        <li>Your plan determines limits such as the number of articles, prompts, audits, or checks available per period.</li>
        <li>We may change plan features, limits, or pricing; where we do, we will provide notice through the app or by email before changes take effect for existing subscriptions.</li>
        <li>Refunds and cancellations are governed by our <Link href="/refund-policy">Refund & Cancellation Policy</Link>.</li>
      </ul>

      <h2>4. Connecting third-party integrations</h2>
      <p>
        When you connect WordPress, Shopify, Google Search Console, or any other third-party service, you authorize
        us to act on your behalf strictly for the actions you request (for example, publishing an article you
        approved, or requesting indexing after a live publish). You are responsible for complying with that
        third-party&apos;s own terms of service. We are not responsible for the availability, accuracy, or behavior
        of third-party platforms or APIs.
      </p>

      <h2>5. Acceptable use</h2>
      <p>You agree not to:</p>
      <ul>
        <li>Use the Service to generate or publish content that is unlawful, defamatory, infringing, hateful, or fraudulent.</li>
        <li>Attempt to gain unauthorized access to the Service, other accounts, or our infrastructure.</li>
        <li>Interfere with or disrupt the integrity or performance of the Service (e.g. excessive automated requests outside documented limits).</li>
        <li>Reverse-engineer, scrape, or resell the Service without our written permission.</li>
        <li>Use the Service to violate any applicable law, including data protection and consumer protection laws.</li>
      </ul>

      <h2>6. No guarantee of outcomes</h2>
      <p>
        Riviso helps you produce and publish content faster. We do not guarantee search engine rankings, indexing,
        organic traffic, or any specific business outcome. Automated actions that depend on third-party APIs
        (including Google Search Console URL inspection/indexing requests) are best-effort and subject to that
        third party&apos;s availability, policies, and decisions, which are outside our control.
      </p>

      <h2>7. Intellectual property</h2>
      <p>
        The Service itself — including its software, design, branding, and underlying technology — is owned by{" "}
        {ENTITY_NAME} and protected by intellectual property laws. These Terms do not grant you any rights to our
        trademarks, logos, or brand assets except as needed to use the Service as intended.
      </p>

      <h2>8. Termination</h2>
      <p>
        You may deactivate or permanently delete your account at any time from your Profile settings. We may
        suspend or terminate your access if you violate these Terms, misuse the Service, or where required by law.
        Upon permanent deletion, your data is erased as described in our <Link href="/privacy-policy">Privacy Policy</Link>.
      </p>

      <h2>9. Disclaimers and limitation of liability</h2>
      <p>
        The Service is provided &ldquo;as is&rdquo; and &ldquo;as available&rdquo; without warranties of any kind,
        express or implied, to the fullest extent permitted by law. To the maximum extent permitted by applicable
        law, {ENTITY_NAME} shall not be liable for any indirect, incidental, special, consequential, or punitive
        damages, or any loss of profits, revenue, data, or goodwill, arising from your use of the Service. Nothing
        in these Terms limits liability that cannot be limited under applicable law (including certain consumer
        protection rights in India, the EU, or elsewhere).
      </p>

      <h2>10. Governing law</h2>
      <p>
        These Terms are governed by the laws of India, without regard to conflict-of-law principles, unless a
        mandatory local consumer-protection law requires otherwise for users located outside India. Courts located
        in India shall have exclusive jurisdiction over disputes arising from these Terms, subject to any mandatory
        rights you have under your local law.
      </p>

      <h2>11. Changes to these Terms</h2>
      <p>We may update these Terms from time to time. We will reflect changes by updating the effective date above. Continued use of the Service after a change constitutes acceptance of the revised Terms.</p>

      <h2>12. Contact</h2>
      <p>Questions about these Terms: <strong>{SUPPORT_EMAIL}</strong>.</p>
    </LegalPageLayout>
  );
}
