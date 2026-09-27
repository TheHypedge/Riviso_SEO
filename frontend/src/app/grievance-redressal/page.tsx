import Link from "next/link";

import { LegalPageLayout } from "@/components/legal/LegalPageLayout";
import {
  GRIEVANCE_EMAIL,
  GRIEVANCE_OFFICER_NAME,
  GRIEVANCE_OFFICER_TITLE,
  REGISTERED_ADDRESS,
  SUPPORT_EMAIL,
} from "@/lib/legalContent";

export const metadata = { title: "Grievance Redressal — Riviso" };

export default function GrievanceRedressalPage() {
  return (
    <LegalPageLayout
      title="Grievance Redressal"
      summary={
        <span>
          Published under Rule 3(2) of the Information Technology (Intermediary Guidelines and Digital Media Ethics
          Code) Rules, 2021 and the Digital Personal Data Protection Act, 2023. If you have a complaint about your
          data or content on Riviso, this is how to reach us and what to expect.
        </span>
      }
    >
      <h2>1. Who can file a grievance</h2>
      <p>
        Any user of Riviso, or any individual affected by content published through Riviso, may file a grievance
        regarding: the processing of their Personal Data, a privacy concern, or content hosted/published via the
        Service that they believe violates applicable law or our <Link href="/terms">Terms & Conditions</Link>.
      </p>

      <h2>2. Grievance Officer</h2>
      <table>
        <tbody>
          <tr><td>Designation</td><td>{GRIEVANCE_OFFICER_TITLE}</td></tr>
          {GRIEVANCE_OFFICER_NAME ? <tr><td>Name</td><td>{GRIEVANCE_OFFICER_NAME}</td></tr> : null}
          <tr><td>Email</td><td>{GRIEVANCE_EMAIL}</td></tr>
          <tr><td>Registered address</td><td><em>{REGISTERED_ADDRESS}</em></td></tr>
        </tbody>
      </table>
      {!GRIEVANCE_OFFICER_NAME ? (
        <p>
          <em>
            A named individual for this role will be published here once formally designated. Until then, all
            correspondence to the email above is treated as addressed to the Grievance Officer function.
          </em>
        </p>
      ) : null}

      <h2>3. How to file a grievance</h2>
      <p>
        Email {GRIEVANCE_EMAIL} with: your name and contact details, your account email (if applicable), a clear
        description of the issue, and, if relevant, the URL or location of the content in question. You may also
        use general support at {SUPPORT_EMAIL} for non-legal issues — we will route it to the Grievance Officer if
        appropriate.
      </p>

      <h2>4. Timelines</h2>
      <ul>
        <li><strong>Acknowledgement:</strong> within 24 hours of receipt.</li>
        <li><strong>Resolution:</strong> within 15 days of receipt, consistent with the timelines under the IT Rules, 2021 and the DPDP Act, 2023. Complex matters may take longer; we will keep you informed of progress.</li>
      </ul>

      <h2>5. What happens next</h2>
      <p>
        We will review your grievance, may request additional information to investigate it, and will communicate
        the outcome and any action taken (for example, correcting or deleting data, or reviewing content) directly
        to you. If you are not satisfied with the resolution, you retain any rights available to you under
        applicable law, including approaching the Data Protection Board of India (once operational) for Personal
        Data matters, or a competent court.
      </p>

      <h2>6. Related pages</h2>
      <p>
        See our <Link href="/privacy-policy">Privacy Policy</Link> and{" "}
        <Link href="/data-privacy-policy">Data Privacy Policy</Link> for how we handle Personal Data, and our{" "}
        <Link href="/terms">Terms & Conditions</Link> for acceptable use of the Service.
      </p>
    </LegalPageLayout>
  );
}
