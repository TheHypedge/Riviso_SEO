"use client";

import { useEffect, useState } from "react";

import { api, type PlanSummary } from "@/lib/api";
import { connectionErrorMessage } from "@/lib/networkErrors";

function formatInr(rupees: number): string {
  return `₹${rupees.toLocaleString("en-IN")}`;
}

export function CheckIcon() {
  return (
    <span className="mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-accent-tint text-accent">
      <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <path d="M2.5 6L5 8.5L9.5 3.5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

function planFeatures(plan: PlanSummary): string[] {
  const rows: string[] = [
    plan.max_projects ? `${plan.max_projects} projects` : "Unlimited projects",
    plan.max_articles_per_month ? `${plan.max_articles_per_month} articles / month` : "Unlimited articles",
  ];
  if (plan.allow_scheduling) rows.push("Scheduled publishing");
  if (plan.allow_export) rows.push("Bulk export");
  if (plan.allow_bulk_upload) rows.push("Bulk upload");
  return rows;
}

function PlanCardSkeleton() {
  return (
    <div className="flex animate-pulse flex-col gap-3 rounded-md border border-border bg-surface p-4">
      <div className="h-4 w-2/3 rounded-sm bg-surface-sunken" />
      <div className="h-7 w-1/2 rounded-sm bg-surface-sunken" />
      <div className="mt-1 flex flex-col gap-2">
        <div className="h-3 w-full rounded-sm bg-surface-sunken" />
        <div className="h-3 w-5/6 rounded-sm bg-surface-sunken" />
        <div className="h-3 w-4/6 rounded-sm bg-surface-sunken" />
      </div>
      <div className="mt-2 h-9 w-full rounded-sm bg-surface-sunken" />
    </div>
  );
}

/** Plan card grid for choosing what to buy. The middle-priced plan (by position, once
 * sorted cheapest-first -- matches how PlanPicker already renders) is marked "Most
 * popular" so the picker guides toward a default choice the way real pricing pages do,
 * without hardcoding a specific plan key that would silently stop working if an admin
 * renames or reorders plans in AdminPlansModule. */
export function PlanPicker({ onSelect }: { onSelect: (plan: PlanSummary) => void }) {
  const [plans, setPlans] = useState<PlanSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rows = await api.listAvailablePlans();
        if (!cancelled) setPlans(rows);
      } catch (e) {
        if (!cancelled) setError(connectionErrorMessage(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return <p className="font-sans text-sm text-danger">{error}</p>;
  }
  if (!plans) {
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <PlanCardSkeleton />
        <PlanCardSkeleton />
        <PlanCardSkeleton />
      </div>
    );
  }
  if (plans.length === 0) {
    return <p className="font-sans text-sm text-ink-secondary">No plans are available for purchase right now.</p>;
  }

  const recommendedIndex = plans.length >= 2 ? Math.floor((plans.length - 1) / 2) : -1;

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      {plans.map((plan, i) => {
        const recommended = i === recommendedIndex;
        return (
          <div
            key={plan.key}
            className={
              recommended
                ? "relative flex flex-col rounded-md border-2 border-accent bg-surface p-4 shadow-sm"
                : "relative flex flex-col rounded-md border border-border bg-surface p-4 transition-colors duration-150 hover:border-border-strong hover:shadow-xs"
            }
          >
            {recommended ? (
              <span className="absolute -top-2.5 left-4 rounded-full bg-accent px-2.5 py-0.5 font-sans text-[10px] font-semibold uppercase tracking-wide text-white">
                Most popular
              </span>
            ) : null}

            <div className="font-sans text-sm font-semibold text-ink">{plan.name}</div>
            <div className="mt-1 font-sans text-2xl font-bold text-ink">
              {formatInr(plan.cost_monthly)}
              <span className="text-xs font-normal text-ink-secondary"> /mo</span>
            </div>

            <ul className="mt-3 flex flex-1 flex-col gap-1.5">
              {planFeatures(plan).map((f) => (
                <li key={f} className="flex items-start gap-2 font-sans text-xs text-ink-secondary">
                  <CheckIcon />
                  <span>{f}</span>
                </li>
              ))}
            </ul>

            <button
              type="button"
              onClick={() => onSelect(plan)}
              className={
                recommended
                  ? "mt-4 inline-flex items-center justify-center rounded-sm border-0 bg-accent px-3.5 py-2 font-sans text-sm font-semibold text-white transition-colors duration-150 hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
                  : "mt-4 inline-flex items-center justify-center rounded-sm border border-border bg-surface px-3.5 py-2 font-sans text-sm font-semibold text-ink shadow-xs transition-colors duration-150 hover:border-border-strong hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
              }
            >
              Choose {plan.name}
            </button>
          </div>
        );
      })}
    </div>
  );
}
