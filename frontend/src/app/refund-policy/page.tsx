import Link from "next/link";

import { LegalPageLayout } from "@/components/legal/LegalPageLayout";
import { SUPPORT_EMAIL } from "@/lib/legalContent";

export const metadata = { title: "Refund & Cancellation Policy — Riviso" };

export default function RefundPolicyPage() {
  return (
    <LegalPageLayout
      title="Refund & Cancellation Policy"
      summary={
        <span>
          Riviso currently starts every account on a free trial plan. This policy describes how cancellations and
          refunds work today, and the terms that will govern any paid subscription we introduce.
        </span>
      }
    >
      <h2>1. Current plan</h2>
      <p>
        New Riviso accounts start on a free trial plan (currently 14 days) with usage limits described in your
        account&apos;s plan details. You are not charged to create an account or use the trial plan. If we
        introduce paid subscription tiers, this policy will apply to them, and we will notify existing users before
        any change that affects billing.
      </p>

      <h2>2. Cancelling a subscription</h2>
      <p>
        You may cancel a paid subscription at any time from your account settings, or by emailing {SUPPORT_EMAIL}.
        Cancellation stops future billing; it does not automatically delete your account or data — see our{" "}
        <Link href="/privacy-policy">Privacy Policy</Link> for how to permanently delete your account.
      </p>

      <h2>3. Refunds</h2>
      <ul>
        <li>Amounts already charged for the current billing period are generally non-refundable once the period has started, except as required by applicable consumer protection law.</li>
        <li>If you believe you were charged in error (e.g. a duplicate charge or a charge after you cancelled), contact {SUPPORT_EMAIL} within 30 days of the charge and we will investigate and issue a refund where appropriate.</li>
        <li>We do not offer partial refunds for unused time within a billing period unless required by law in your jurisdiction.</li>
      </ul>

      <h2>4. Downgrades and plan changes</h2>
      <p>If you downgrade your plan, the new limits apply from your next billing cycle; content and data created under a higher plan are retained subject to the storage limits of your new plan.</p>

      <h2>5. Payment processing</h2>
      <p>
        Riviso does not directly store your full payment card details. When paid billing is enabled, payments will
        be processed by a PCI-DSS compliant third-party payment processor, and that processor&apos;s own terms and
        privacy practices will apply to the payment transaction itself.
      </p>

      <h2>6. Chargebacks</h2>
      <p>Please contact us at {SUPPORT_EMAIL} before initiating a chargeback with your bank or card issuer — most billing concerns can be resolved directly and faster this way.</p>

      <h2>7. Changes to this policy</h2>
      <p>We may update this policy as our billing model evolves (for example, when paid plans launch). Material changes will be reflected by updating the effective date above.</p>

      <h2>8. Contact</h2>
      <p>Billing and refund questions: <strong>{SUPPORT_EMAIL}</strong>.</p>
    </LegalPageLayout>
  );
}
