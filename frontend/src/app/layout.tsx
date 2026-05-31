import type { Metadata } from "next";
import { Geist, Geist_Mono, Inter, Cormorant_Garamond } from "next/font/google";
import "./globals.css";
import ExtensionCleanup from "@/components/ExtensionCleanup";
import { AppProviders } from "@/components/AppProviders";
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
    images: [
      {
        url: "/riviso-logo.png",
        width: 512,
        height: 512,
        alt: "Riviso",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Riviso — SEO content operations",
    description:
      "Plan, generate, and publish SEO-optimized articles to WordPress on a schedule.",
    images: ["/riviso-logo.png"],
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
        {/*
          Browser extensions (e.g. ChatGPT-Translate) inject siblings into
          <body> before React hydrates. ``suppressHydrationWarning`` on
          <body> is the supported way to tolerate them during hydration;
          ``ExtensionCleanup`` removes the known offenders post-hydration as
          a hygiene step. This replaces the previous inline
          <Script strategy="beforeInteractive"> which tripped React 19's
          "Scripts inside React components are never executed" warning.
        */}
        <ExtensionCleanup />
        <GlobalLoadingProvider>
          <AppProviders>{children}</AppProviders>
        </GlobalLoadingProvider>
      </body>
    </html>
  );
}
