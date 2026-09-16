"use client";

import { SubscriptionProvider } from "@/components/subscription/SubscriptionProvider";
import { ThemeProvider } from "@/components/ThemeProvider";

export function AppProviders({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
      <SubscriptionProvider>{children}</SubscriptionProvider>
    </ThemeProvider>
  );
}
