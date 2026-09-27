import Link from "next/link";

import { LegalPageLayout } from "@/components/legal/LegalPageLayout";
import { ENTITY_NAME, GRIEVANCE_EMAIL, REGISTERED_ADDRESS, SUPPORT_EMAIL } from "@/lib/legalContent";

export const metadata = { title: "Data Privacy Policy — Riviso" };

export default function DataPrivacyPolicyPage() {
  return (
    <LegalPageLayout
      title="Data Privacy Policy"
      summary={
        <span>
          This page sets out how {ENTITY_NAME} handles your Personal Data as a <strong>Data Fiduciary</strong> under
          India&apos;s Digital Personal Data Protection Act, 2023 (&ldquo;DPDP Act&rdquo;), including your rights as
          a <strong>Data Principal</strong>. It complements — not replaces — our general{" "}
          <Link href="/privacy-policy">Privacy Policy</Link>.
        </span>
      }
    >
      <p>
        {ENTITY_NAME} acts as a Data Fiduciary in relation to the Personal Data of users (&ldquo;Data
        Principals&rdquo;) who register for and use Riviso. This policy explains the notice, consent, purpose
        limitation, and rights framework the DPDP Act requires, and how we implement it in practice.
      </p>

      <h2>1. Notice and consent</h2>
      <p>
        Before or at the time we collect your Personal Data (for example, when you register), we provide notice of
        what we collect and why, in plain language, including through the consent checkbox on our registration
        form and this policy. We process your Personal Data on the basis of:
      </p>
      <ul>
        <li><strong>Your consent</strong> — freely given, specific, informed, and unambiguous, for the purposes described in our <Link href="/privacy-policy">Privacy Policy</Link> (account creation, providing the Service, and the integrations you choose to enable).</li>
        <li><strong>Legitimate uses</strong> recognized under the DPDP Act, such as responding to a request you make (e.g. support), compliance with law, or purposes related to employment (not applicable to end users).</li>
      </ul>
      <p>You may withdraw consent at any time with the same ease with which it was given, by deactivating integrations in Project Settings, deleting your account, or contacting {SUPPORT_EMAIL}. Withdrawing consent does not affect the lawfulness of processing carried out before withdrawal, and may mean we can no longer provide the parts of the Service that depend on that data.</p>

      <h2>2. Purpose limitation</h2>
      <p>We collect and process Personal Data only for the specific, clearly stated purposes described in our <Link href="/privacy-policy">Privacy Policy</Link> — operating your account, generating and publishing content you request, and the integrations you enable — and not for unrelated purposes without fresh notice and consent.</p>

      <h2>3. Data minimisation and accuracy</h2>
      <p>We collect only the Personal Data reasonably necessary for the stated purposes (for example, we do not require a phone number to use core features). You can review and correct your account information at any time in Profile settings.</p>

      <h2>4. Your rights as a Data Principal</h2>
      <p>Under the DPDP Act, you have the right to:</p>
      <ul>
        <li><strong>Access</strong> a summary of your Personal Data and the processing activities we carry out on it.</li>
        <li><strong>Correction and updating</strong> of inaccurate or incomplete Personal Data.</li>
        <li><strong>Erasure</strong> of Personal Data that is no longer necessary for the purpose it was collected for — available directly from Profile settings (permanent account deletion) or by request.</li>
        <li><strong>Grievance redressal</strong> — see <Link href="/grievance-redressal">Grievance Redressal</Link> for our process and response timelines.</li>
        <li><strong>Nominate</strong> another individual to exercise these rights on your behalf in the event of your death or incapacity, by writing to {SUPPORT_EMAIL}.</li>
      </ul>
      <p>We aim to acknowledge rights requests within 24 hours and resolve them within 15 days, consistent with the timelines expected under the IT Rules 2021 and DPDP Act framework.</p>

      <h2>5. Data breach notification</h2>
      <p>In the event of a Personal Data breach that could affect you, we will notify the Data Protection Board of India and affected Data Principals as required under the DPDP Act, including the nature of the breach, its likely consequences, and the measures taken or proposed to address it.</p>

      <h2>6. Cross-border transfer</h2>
      <p>The DPDP Act permits transfer of Personal Data outside India except to countries specifically restricted by the Central Government. Where our service providers (e.g. cloud hosting, database, AI processing) operate outside India, we transfer data to them only to provide the Service, under contractual safeguards, and consistent with applicable law.</p>

      <h2>7. Significant Data Fiduciary status</h2>
      <p>{ENTITY_NAME} does not currently meet the volume/sensitivity thresholds that would classify it as a &ldquo;Significant Data Fiduciary&rdquo; under the DPDP Act. If that changes, we will appoint a Data Protection Officer and update this policy accordingly.</p>

      <h2>8. Grievance Officer</h2>
      <p>
        Grievance Officer: <strong>{GRIEVANCE_EMAIL}</strong>
        <br />
        Registered address: <em>{REGISTERED_ADDRESS}</em>
        <br />
        Full process and response timelines: <Link href="/grievance-redressal">Grievance Redressal</Link>.
      </p>

      <h2>9. Relationship to our general Privacy Policy</h2>
      <p>Where this Data Privacy Policy and our general <Link href="/privacy-policy">Privacy Policy</Link> both address a topic (for example, what data we collect), they are intended to be consistent; this page adds India-specific rights and terminology required under the DPDP Act. If you notice an inconsistency, please tell us at {SUPPORT_EMAIL} so we can correct it.</p>
    </LegalPageLayout>
  );
}
