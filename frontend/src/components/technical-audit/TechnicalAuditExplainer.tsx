"use client";

import { AuditDialog, type CssModule } from "./parts";

/**
 * "Learn about this audit". Static copy limited to what Google documents about PageSpeed
 * Insights / Lighthouse / CrUX, plus how Riviso computes its own Health Score.
 * Owner review requested before this ships (spec §9.10).
 */
export function TechnicalAuditExplainer({ open, onClose, styles }: { open: boolean; onClose: () => void; styles: CssModule }) {
  return (
    <AuditDialog open={open} onClose={onClose} title="About the Technical Audit" styles={styles}>
      <div className={styles.siteAuditExplainer}>
        <h4>What is measured</h4>
        <p>
          Riviso asks Google PageSpeed Insights to test your page. PageSpeed Insights runs Lighthouse, which loads the page and scores four categories:
          Performance, Accessibility, Best Practices and SEO. Every score, metric and finding on this screen comes from that response.
        </p>
        <h4>Lab data and real-user data</h4>
        <p>
          <strong>Lab data</strong> comes from a single Lighthouse test in a controlled environment. It is useful for finding and debugging problems, but
          it cannot measure Interaction to Next Paint, because that needs real people interacting with the page.
        </p>
        <p>
          <strong>Field data</strong> (real-user data) comes from the Chrome User Experience Report: measurements from real Chrome users over a recent
          period, reported at the 75th percentile. It is only available when a URL or its whole origin has enough traffic. When this URL has too little
          data, PageSpeed Insights may report the origin instead, and Riviso labels it as such.
        </p>
        <h4>Mobile and desktop</h4>
        <p>
          The mobile test emulates a mobile device on a slower connection; the desktop test emulates a desktop browser. Lighthouse scores each device
          separately, so the same page often scores differently on each.
        </p>
        <h4>Why scores vary between runs</h4>
        <p>Lab scores can change from run to run because of network conditions, server load, third-party scripts and other variability.</p>
        <h4>Riviso Technical Health Score</h4>
        <p>The average of the Performance, Accessibility and Best Practices scores for the selected device. The PageSpeed SEO score is not included.</p>
        <h4>Where files and details come from</h4>
        <p>
          The affected files, elements and estimated savings are Lighthouse&rsquo;s own findings. Riviso keeps up to 5 examples per finding; the full
          lists are available in PageSpeed Insights.
        </p>
      </div>
    </AuditDialog>
  );
}
