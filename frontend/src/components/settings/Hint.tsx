"use client";

import type { ReactNode } from "react";

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/Tooltip";

import s from "./settingsCard.module.css";

/** Hover/focus help. Defaults to a small "i" button; pass `trigger` to wrap your own element. */
export function Hint({ label, children, trigger }: { label: string; children: ReactNode; trigger?: ReactNode }) {
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          {trigger ?? (
            <button type="button" className={s.infoBtn} aria-label={label}>
              i
            </button>
          )}
        </TooltipTrigger>
        <TooltipContent className="max-w-[300px] px-3 py-2.5 text-left font-normal leading-relaxed">{children}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
