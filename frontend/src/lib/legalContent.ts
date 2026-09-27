/** Single source of truth for facts repeated across every legal page, so a
 * correction (address, officer name, effective date) never has to be hunted
 * down across seven separate files.
 *
 * REGISTERED_ADDRESS and GRIEVANCE_OFFICER_NAME are explicit placeholders —
 * fill them in before these pages are relied on for real compliance. Indian
 * IT Rules 2021 (Rule 5) requires a published Grievance Officer with a name
 * and contact; a title-only listing is a reasonable interim state but should
 * be completed once someone is formally designated. */

export const ENTITY_NAME = "Riviso";
export const APP_NAME = "Riviso";
export const PRIMARY_DOMAIN = "riviso.com";
export const APP_DOMAIN = "app.riviso.com";

export const SUPPORT_EMAIL = "support@riviso.com";
export const GRIEVANCE_EMAIL = "grievance@riviso.com";
export const PRIVACY_EMAIL = "support@riviso.com";

export const GRIEVANCE_OFFICER_NAME: string | null = null; // e.g. "Jane Doe" once designated
export const GRIEVANCE_OFFICER_TITLE = "Grievance Officer";
export const REGISTERED_ADDRESS = "[Registered business address to be added]";

/** IST-anchored dates so "effective date" doesn't silently drift with a
 * viewer's timezone on the day of publication. */
export const LEGAL_EFFECTIVE_DATE = "27 September 2026";

export const LEGAL_PAGES: { href: string; label: string }[] = [
  { href: "/privacy-policy", label: "Privacy Policy" },
  { href: "/data-privacy-policy", label: "Data Privacy Policy (DPDP Act)" },
  { href: "/terms", label: "Terms & Conditions" },
  { href: "/cookie-policy", label: "Cookie Policy" },
  { href: "/disclaimer", label: "Disclaimer" },
  { href: "/refund-policy", label: "Refund & Cancellation Policy" },
  { href: "/grievance-redressal", label: "Grievance Redressal" },
];
