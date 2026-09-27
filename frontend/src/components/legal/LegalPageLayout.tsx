import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";

import styles from "./legal.module.css";
import { LEGAL_EFFECTIVE_DATE, LEGAL_PAGES } from "@/lib/legalContent";

export function LegalPageLayout({
  title,
  summary,
  children,
}: {
  title: string;
  /** One or two lines shown in a callout right under the title -- a plain-
   * language "what this page means for you" summary, not a legal disclaimer. */
  summary?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={styles.page}>
      <div className={styles.shell}>
        <div className={styles.header}>
          <Link href="/" aria-label="Riviso — home" className={styles.brand}>
            <Image src="/riviso-logo.png" alt="" width={28} height={28} priority />
            <span>Riviso</span>
          </Link>
          <Link href="/" className={styles.homeLink}>
            ← Home
          </Link>
        </div>

        <h1 className={styles.title}>{title}</h1>
        <div className={styles.meta}>Effective date: {LEGAL_EFFECTIVE_DATE}</div>

        {summary ? <div className={styles.summaryNote}>{summary}</div> : null}

        <div className={styles.body}>{children}</div>

        <nav className={styles.crossNav} aria-label="Other legal pages">
          {LEGAL_PAGES.map((p) => (
            <Link key={p.href} href={p.href}>
              {p.label}
            </Link>
          ))}
        </nav>
      </div>
    </div>
  );
}
