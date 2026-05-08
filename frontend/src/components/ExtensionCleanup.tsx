"use client";

import { useEffect } from "react";

/**
 * Defensive cleanup of DOM nodes that browser extensions inject into
 * ``<body>`` during page load (e.g. ChatGPT-Translate's widget root). On the
 * very first paint these nodes can race with React's hydration and cause a
 * mismatch warning.
 *
 * The previous implementation lived in ``app/layout.tsx`` as a
 * ``<Script strategy="beforeInteractive">`` block. React 19 / Next.js 16
 * began emitting a hard warning about ``<script>`` children inside React
 * components ("Scripts inside React components are never executed…") whenever
 * the layout re-reconciles. We don't actually need pre-hydration removal:
 * ``<body suppressHydrationWarning>`` is already set in the root layout, which
 * is the supported way to tolerate extension-injected nodes during
 * hydration. So we move the cleanup to ``useEffect`` (runs after hydration)
 * purely as a "don't leave that widget hanging around" hygiene step.
 */
const _EXTENSION_NODE_IDS = ["chatgpt_translate_widget_root"];

export default function ExtensionCleanup(): null {
  useEffect(() => {
    try {
      for (const id of _EXTENSION_NODE_IDS) {
        const el = document.getElementById(id);
        if (el && el.parentNode) {
          el.parentNode.removeChild(el);
        }
      }
    } catch {
      // Cleanup is purely best-effort; if a different extension blocks DOM
      // access we don't want to crash the app over it.
    }
  }, []);

  return null;
}
