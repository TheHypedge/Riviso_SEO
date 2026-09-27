"use client";

import { useEffect, useState } from "react";

import { api, type PlanSummary } from "@/lib/api";
import { connectionErrorMessage } from "@/lib/networkErrors";

function formatInr(rupees: number): string {
  return `₹${rupees.toLocaleString("en-IN")}`;
}

/** Read-only plan card list for choosing what to buy -- the same "feature list" concept
 * as AdminPlansModule's card view, simplified for an end-user picker rather than an
 * admin comparison table. */
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
    return <p className="text-sm text-danger">{error}</p>;
  }
  if (!plans) {
    return <p className="text-sm text-ink-secondary">Loading plans…</p>;
  }
  if (plans.length === 0) {
    return <p className="text-sm text-ink-secondary">No plans are available for purchase right now.</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      {plans.map((plan) => (
        <button
          key={plan.key}
          type="button"
          onClick={() => onSelect(plan)}
          className="flex items-center justify-between gap-3 rounded-sm border border-border bg-surface p-3.5 text-left transition-colors duration-150 hover:border-border-strong hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
        >
          <div>
            <div className="font-sans text-sm font-semibold text-ink">{plan.name}</div>
            <div className="mt-0.5 font-sans text-xs text-ink-secondary">
              {plan.max_projects ? `${plan.max_projects} projects` : "Unlimited projects"}
              {plan.max_articles_per_month ? ` · ${plan.max_articles_per_month} articles/mo` : ""}
            </div>
          </div>
          <div className="font-sans text-base font-bold text-ink">
            {formatInr(plan.cost_monthly)}
            <span className="text-xs font-normal text-ink-secondary">/mo</span>
          </div>
        </button>
      ))}
    </div>
  );
}
