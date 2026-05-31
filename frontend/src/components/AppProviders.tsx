"use client";

import { SubscriptionProvider } from "@/components/subscription/SubscriptionProvider";

export function AppProviders({ children }: { children: React.ReactNode }) {
  return <SubscriptionProvider>{children}</SubscriptionProvider>;
}
