import type { Metadata } from "next";
import { Geist, Geist_Mono, Inter, Cormorant_Garamond } from "next/font/google";
import Script from "next/script";
import "./globals.css";
import { GlobalLoadingProvider } from "@/components/GlobalLoadingProvider";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Claude design system substitutes (licensed fonts are not public).
const uiSans = Inter({
  variable: "--font-ui-sans",
  subsets: ["latin"],
});

const displaySerif = Cormorant_Garamond({
  variable: "--font-display-serif",
  subsets: ["latin"],
  weight: ["400", "500"],
});

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL?.trim() || "https://riviso.com";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "Riviso — SEO content operations",
    template: "%s · Riviso",
  },
  description:
    "Riviso is the SEO content operations platform for keyword research, AI article generation, scheduling, and WordPress publishing.",
  applicationName: "Riviso",
  openGraph: {
    type: "website",
    siteName: "Riviso",
    title: "Riviso — SEO content operations",
    description:
      "Plan, generate, and publish SEO-optimized articles to WordPress on a schedule, with built-in guardrails and Search Console integration.",
    url: SITE_URL,
  },
  twitter: {
    card: "summary_large_image",
    title: "Riviso — SEO content operations",
    description:
      "Plan, generate, and publish SEO-optimized articles to WordPress on a schedule.",
  },
  robots: {
    index: true,
    follow: true,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${uiSans.variable} ${displaySerif.variable}`}
      suppressHydrationWarning
    >
      <body suppressHydrationWarning>
        {/* Some browser extensions inject DOM nodes before hydration (e.g. ChatGPT Translate).
            Removing them early prevents a client/server mismatch crash while remaining a safe no-op. */}
        <Script id="aa-extension-cleanup" strategy="beforeInteractive">
          {`(function () {
            try {
              var ids = ["chatgpt_translate_widget_root"];
              for (var i = 0; i < ids.length; i++) {
                var el = document.getElementById(ids[i]);
                if (el && el.parentNode) el.parentNode.removeChild(el);
              }
            } catch (e) {}
          })();`}
        </Script>
        <GlobalLoadingProvider>{children}</GlobalLoadingProvider>
      </body>
    </html>
  );
}
