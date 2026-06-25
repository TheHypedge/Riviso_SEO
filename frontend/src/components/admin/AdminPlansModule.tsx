"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import s from "./AdminPlansModule.module.css";
import { api } from "@/lib/api";
import type { AdminUserPublic, PlanPublic } from "@/lib/api";

// ─── Comparison table feature config ──────────────────────────────────────────
const COMPARE_ROWS: { label: string; get: (p: PlanPublic) => { text: string; kind: "unlim" | "lim" | "yes" | "no" | "plain" } }[] = [
  { label: "Max Projects", get: (p) => limitCell(p.max_projects) },
  { label: "Articles / Day", get: (p) => limitCell(p.max_articles_per_day) },
  { label: "Articles / Month", get: (p) => limitCell(p.max_articles_per_month) },
  { label: "Schedule", get: (p) => boolCell(p.allow_scheduling !== false) },
  { label: "Schedules / Month", get: (p) => p.allow_scheduling !== false ? limitCell(p.max_scheduled_per_month) : { text: "—", kind: "plain" } },
  { label: "Export", get: (p) => boolCell(p.allow_export !== false) },
  { label: "Exports / Month", get: (p) => p.allow_export !== false ? limitCell(p.max_export_per_month) : { text: "—", kind: "plain" } },
  { label: "Bulk Upload", get: (p) => boolCell(p.allow_bulk_upload !== false) },
  { label: "Cluster Planner / Month", get: (p) => limitCell(p.max_cluster_plans_per_month) },
  { label: "Custom Curations / Month", get: (p) => limitCell(p.max_custom_research_per_month) },
  { label: "Context Links", get: (p) => limitCell(p.max_context_links) },
  { label: "Writing Prompts", get: (p) => limitCell(p.max_writing_prompts) },
  { label: "Image Prompts", get: (p) => limitCell(p.max_image_prompts) },
  { label: "Image Regen / Article", get: (p) => limitCell(p.max_article_image_regenerations) },
];

// Card feature rows (subset shown on plan card)
const CARD_FEATURES: { label: string; get: (p: PlanPublic) => { text: string; badgeKind: "unlimited" | "limited" | "included" | "disabled" } }[] = [
  { label: "Projects", get: (p) => limitBadge(p.max_projects) },
  { label: "Articles / Month", get: (p) => limitBadge(p.max_articles_per_month) },
  { label: "Articles / Day", get: (p) => limitBadge(p.max_articles_per_day) },
  { label: "Schedule", get: (p) => p.allow_scheduling !== false ? (isUnlim(p.max_scheduled_per_month) ? { text: "Unlimited", badgeKind: "unlimited" } : { text: `${p.max_scheduled_per_month}/mo`, badgeKind: "limited" }) : { text: "Disabled", badgeKind: "disabled" } },
  { label: "Export", get: (p) => p.allow_export !== false ? (isUnlim(p.max_export_per_month) ? { text: "Unlimited", badgeKind: "unlimited" } : { text: `${p.max_export_per_month}/mo`, badgeKind: "limited" }) : { text: "Disabled", badgeKind: "disabled" } },
  { label: "Cluster Planner", get: (p) => limitBadge(p.max_cluster_plans_per_month) },
  { label: "Custom Curations", get: (p) => limitBadge(p.max_custom_research_per_month) },
  { label: "Context Links", get: (p) => limitBadge(p.max_context_links) },
];

// ─── Helpers ───────────────────────────────────────────────────────────────────
function isUnlim(v: number | null | undefined): boolean {
  return v === null || v === undefined || v === 0;
}

function fmtLimit(v: number | null | undefined): string {
  if (isUnlim(v)) return "Unlimited";
  return (v as number).toLocaleString();
}

function limitCell(v: number | null | undefined): { text: string; kind: "unlim" | "lim" | "yes" | "no" | "plain" } {
  if (isUnlim(v)) return { text: "Unlimited", kind: "unlim" };
  return { text: (v as number).toLocaleString(), kind: "lim" };
}

function boolCell(v: boolean): { text: string; kind: "unlim" | "lim" | "yes" | "no" | "plain" } {
  return v ? { text: "✓", kind: "yes" } : { text: "✗", kind: "no" };
}

function limitBadge(v: number | null | undefined): { text: string; badgeKind: "unlimited" | "limited" | "included" | "disabled" } {
  if (isUnlim(v)) return { text: "Unlimited", badgeKind: "unlimited" };
  return { text: (v as number).toLocaleString(), badgeKind: "limited" };
}

function priceFmt(v: number | null | undefined): string {
  if (!v) return "Free";
  return `$${v.toFixed(2)}/mo`;
}

function emptyDraft(): Partial<PlanPublic> & { key: string } {
  return {
    key: "",
    name: "",
    cost_monthly: null,
    max_projects: null,
    max_articles_per_day: null,
    max_articles_per_month: null,
    allow_scheduling: true,
    max_scheduled_per_month: null,
    allow_export: true,
    max_export_per_month: null,
    allow_bulk_upload: true,
    max_cluster_plans_per_month: null,
    max_custom_research_per_month: null,
    max_context_links: null,
    max_writing_prompts: null,
    writing_prompt_char_limit: null,
    max_image_prompts: null,
    image_prompt_char_limit: null,
    max_article_image_regenerations: null,
    is_default: false,
    is_trial_plan: false,
    trial_period_days: 14,
  };
}

// ─── Sub-components ────────────────────────────────────────────────────────────

function FeatureBadge({ text, kind }: { text: string; kind: "unlimited" | "limited" | "included" | "disabled" }) {
  const cls = kind === "unlimited" ? s.fBadgeUnlimited
    : kind === "limited" ? s.fBadgeLimited
    : kind === "included" ? s.fBadgeIncluded
    : s.fBadgeDisabled;
  return <span className={`${s.fBadge} ${cls}`}>{text}</span>;
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      className={`${s.toggleSwitch} ${on ? s.toggleSwitchOn : ""}`}
      onClick={() => onChange(!on)}
    >
      <span className={`${s.toggleThumb} ${on ? s.toggleThumbOn : ""}`} />
    </button>
  );
}

function UnlimitedField({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number | null | undefined;
  onChange: (v: number | null) => void;
}) {
  const unlim = isUnlim(value);
  return (
    <div className={s.fieldLabel}>
      <span className={s.fieldLabelText}>{label}</span>
      <div className={s.unlimRow}>
        <div className={s.unlimChipGroup}>
          <button
            type="button"
            className={`${s.unlimChip} ${unlim ? s.unlimChipOnGreen : ""}`}
            onClick={() => onChange(null)}
          >
            Unlimited
          </button>
          <button
            type="button"
            className={`${s.unlimChip} ${!unlim ? s.unlimChipOn : ""}`}
            onClick={() => { if (unlim) onChange(10); }}
          >
            Set limit
          </button>
        </div>
        {!unlim && (
          <input
            type="number"
            className={s.limitInput}
            min={1}
            value={value ?? 1}
            onChange={(e) => onChange(Math.max(1, Number(e.target.value) || 1))}
          />
        )}
      </div>
      {hint && <span className={s.fieldHint}>{hint}</span>}
    </div>
  );
}

function AccordionSection({
  id,
  title,
  icon,
  open,
  onToggle,
  children,
}: {
  id: string;
  title: string;
  icon: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className={s.accordion}>
      <div className={s.accordionHeader} onClick={onToggle} aria-expanded={open}>
        <span className={s.accordionTitle}>
          <span>{icon}</span>
          {title}
        </span>
        <span className={`${s.accordionChevron} ${open ? s.accordionChevronOpen : ""}`}>▼</span>
      </div>
      <div className={`${s.accordionBody} ${open ? s.accordionBodyOpen : ""}`}>
        <div className={s.accordionContent}>{children}</div>
      </div>
    </div>
  );
}

function PlanCard({
  plan,
  userCount,
  onEdit,
  onDuplicate,
}: {
  plan: PlanPublic;
  userCount: number;
  onEdit: () => void;
  onDuplicate: () => void;
}) {
  return (
    <div className={s.planCard}>
      <div className={s.planCardTop}>
        <div className={s.planCardNameWrap}>
          <div className={s.planCardName}>{plan.name || plan.key}</div>
          <div className={s.planCardKey}>{plan.key}</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
          <div className={s.planBadgeRow}>
            {plan.is_default && <span className={`${s.planBadge} ${s.planBadgeDefault}`}>Default</span>}
            {plan.is_trial_plan && <span className={`${s.planBadge} ${s.planBadgeTrial}`}>Trial</span>}
          </div>
          <div className={s.planPrice}>
            <span className={s.planPriceAmount}>{priceFmt(plan.cost_monthly)}</span>
          </div>
        </div>
      </div>

      <div className={s.featureRows}>
        {CARD_FEATURES.map((f) => {
          const { text, badgeKind } = f.get(plan);
          return (
            <div key={f.label} className={s.featureRow}>
              <span className={s.featureRowLabel}>{f.label}</span>
              <FeatureBadge text={text} kind={badgeKind} />
            </div>
          );
        })}
      </div>

      <div className={s.planCardFooter}>
        <span className={s.userCountChip}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>
            <path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>
          </svg>
          {userCount} {userCount === 1 ? "user" : "users"}
        </span>
        <div className={s.cardBtns}>
          <button type="button" className={s.cardDupBtn} onClick={onDuplicate} title="Duplicate plan">
            Copy
          </button>
          <button type="button" className={s.cardEditBtn} onClick={onEdit}>
            Edit
          </button>
        </div>
      </div>
    </div>
  );
}

function ComparisonTable({ plans }: { plans: PlanPublic[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={s.compareSection}>
      <div className={s.compareSectionHeader} onClick={() => setOpen((v) => !v)}>
        <span className={s.compareSectionTitle}>Plan Comparison</span>
        <span className={`${s.compareChevron} ${open ? s.compareChevronOpen : ""}`}>▼</span>
      </div>
      {open && (
        <div className={s.compareBody}>
          <div className={s.compareBodyInner}>
            <table className={s.compareTable}>
              <thead>
                <tr>
                  <th>Feature</th>
                  {plans.map((p) => <th key={p.key}>{p.name || p.key}</th>)}
                </tr>
              </thead>
              <tbody>
                {COMPARE_ROWS.map((row) => (
                  <tr key={row.label}>
                    <td>{row.label}</td>
                    {plans.map((p) => {
                      const cell = row.get(p);
                      const cls = cell.kind === "unlim" ? s.cUnlim
                        : cell.kind === "lim" ? s.cLim
                        : cell.kind === "yes" ? s.cYes
                        : cell.kind === "no" ? s.cNo
                        : "";
                      return <td key={p.key} className={cls}>{cell.text}</td>;
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Edit view ─────────────────────────────────────────────────────────────────
function EditView({
  draft,
  setDraft,
  isCreate,
  saving,
  error,
  openSections,
  onToggleSection,
  onSave,
  onCancel,
  existingKeys,
}: {
  draft: Partial<PlanPublic> & { key: string };
  setDraft: (patch: Partial<PlanPublic> & { key?: string }) => void;
  isCreate: boolean;
  saving: boolean;
  error: string | null;
  openSections: Set<string>;
  onToggleSection: (id: string) => void;
  onSave: () => void;
  onCancel: () => void;
  existingKeys: string[];
}) {
  const keyConflict = isCreate && existingKeys.includes((draft.key || "").trim().toLowerCase()) && (draft.key || "").trim() !== "";
  const keyInvalid = (draft.key || "").trim() !== "" && !/^[a-z0-9_]+$/.test((draft.key || "").trim());

  // Live preview data
  const previewName = (draft.name || "").trim() || "New Plan";
  const previewKey = (draft.key || "").trim() || "plan_key";

  return (
    <div>
      {/* Breadcrumb */}
      <div className={s.breadcrumb}>
        <button type="button" className={s.breadcrumbLink} onClick={onCancel}>
          ← Plans
        </button>
        <span className={s.breadcrumbSep}>/</span>
        <span className={s.breadcrumbCurrent}>{isCreate ? "Create New Plan" : `Edit: ${draft.name || draft.key}`}</span>
      </div>

      {error && <div className={s.errorBar}>{error}</div>}

      <div className={s.editLayout}>
        {/* ── Left: form ── */}
        <div className={s.editForm}>

          {/* Basic Information */}
          <AccordionSection id="basic" title="Basic Information" icon="📋" open={openSections.has("basic")} onToggle={() => onToggleSection("basic")}>
            <div className={s.fieldGrid}>
              <div className={s.fieldLabel}>
                <span className={s.fieldLabelText}>Plan Name *</span>
                <input
                  className={s.fieldInput}
                  placeholder="e.g. Pro Plan"
                  value={draft.name || ""}
                  onChange={(e) => setDraft({ name: e.target.value })}
                />
              </div>
              <div className={s.fieldLabel}>
                <span className={s.fieldLabelText}>Plan Key *{isCreate ? "" : " (locked)"}</span>
                {isCreate ? (
                  <input
                    className={`${s.fieldInput} ${keyConflict || keyInvalid ? s.fieldInputError : ""}`}
                    placeholder="e.g. pro"
                    value={draft.key || ""}
                    onChange={(e) => setDraft({ key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "") })}
                  />
                ) : (
                  <div className={s.fieldReadOnly}>
                    <span className={s.fieldKeyLock}>🔒</span>
                    {draft.key}
                  </div>
                )}
                {keyConflict && <span className={s.fieldHint} style={{ color: "#fca5a5" }}>Key already exists.</span>}
                {keyInvalid && <span className={s.fieldHint} style={{ color: "#fca5a5" }}>Only lowercase letters, numbers, underscore.</span>}
              </div>
              <div className={s.fieldLabel}>
                <span className={s.fieldLabelText}>Monthly Price ($)</span>
                <input
                  className={s.fieldInput}
                  type="number"
                  min={0}
                  step="0.01"
                  placeholder="0 = free"
                  value={draft.cost_monthly ?? ""}
                  onChange={(e) => setDraft({ cost_monthly: e.target.value ? Number(e.target.value) : null })}
                />
              </div>
              <div className={s.fieldLabel}>
                <span className={s.fieldLabelText}>Max Projects</span>
                <div className={s.unlimRow}>
                  <div className={s.unlimChipGroup}>
                    <button type="button" className={`${s.unlimChip} ${isUnlim(draft.max_projects) ? s.unlimChipOnGreen : ""}`} onClick={() => setDraft({ max_projects: null })}>Unlimited</button>
                    <button type="button" className={`${s.unlimChip} ${!isUnlim(draft.max_projects) ? s.unlimChipOn : ""}`} onClick={() => { if (isUnlim(draft.max_projects)) setDraft({ max_projects: 5 }); }}>Set limit</button>
                  </div>
                  {!isUnlim(draft.max_projects) && (
                    <input type="number" className={s.limitInput} min={1} value={draft.max_projects ?? 1} onChange={(e) => setDraft({ max_projects: Math.max(1, Number(e.target.value) || 1) })} />
                  )}
                </div>
              </div>
            </div>

            {/* Default / Trial toggles */}
            <div>
              <div className={s.toggleRow}>
                <div className={s.toggleInfo}>
                  <div className={s.toggleName}>Default Plan</div>
                  <div className={s.toggleDesc}>New user registrations automatically get this plan.</div>
                </div>
                <Toggle on={Boolean(draft.is_default)} onChange={(v) => setDraft({ is_default: v })} />
              </div>
              <div className={s.toggleRow}>
                <div className={s.toggleInfo}>
                  <div className={s.toggleName}>Trial Plan</div>
                  <div className={s.toggleDesc}>Self-expiring trial. Only one plan can be the trial plan.</div>
                </div>
                <Toggle on={Boolean(draft.is_trial_plan)} onChange={(v) => setDraft({ is_trial_plan: v })} />
              </div>
              {draft.is_trial_plan && (
                <div className={s.fieldGrid} style={{ marginTop: 12 }}>
                  <div className={s.fieldLabel}>
                    <span className={s.fieldLabelText}>Trial Duration (days)</span>
                    <input
                      className={s.fieldInput}
                      type="number"
                      min={1}
                      value={draft.trial_period_days ?? 14}
                      onChange={(e) => setDraft({ trial_period_days: Math.max(1, Number(e.target.value) || 1) })}
                    />
                  </div>
                </div>
              )}
            </div>
          </AccordionSection>

          {/* Articles */}
          <AccordionSection id="content" title="Article Generation" icon="✍️" open={openSections.has("content")} onToggle={() => onToggleSection("content")}>
            <div className={s.fieldGrid}>
              <UnlimitedField
                label="Articles / Day"
                hint="0 or Unlimited = no daily cap"
                value={draft.max_articles_per_day}
                onChange={(v) => setDraft({ max_articles_per_day: v })}
              />
              <UnlimitedField
                label="Articles / Month"
                hint="Resets at UTC month start"
                value={draft.max_articles_per_month}
                onChange={(v) => setDraft({ max_articles_per_month: v })}
              />
            </div>
          </AccordionSection>

          {/* Scheduling */}
          <AccordionSection id="schedule" title="Scheduling" icon="📅" open={openSections.has("schedule")} onToggle={() => onToggleSection("schedule")}>
            <div className={s.toggleRow}>
              <div className={s.toggleInfo}>
                <div className={s.toggleName}>Enable Scheduling</div>
                <div className={s.toggleDesc}>Allow users to schedule article publishing.</div>
              </div>
              <Toggle on={draft.allow_scheduling !== false} onChange={(v) => setDraft({ allow_scheduling: v })} />
            </div>
            {draft.allow_scheduling !== false && (
              <UnlimitedField
                label="Schedules / Month"
                value={draft.max_scheduled_per_month}
                onChange={(v) => setDraft({ max_scheduled_per_month: v })}
              />
            )}
          </AccordionSection>

          {/* Export */}
          <AccordionSection id="export" title="Export" icon="📤" open={openSections.has("export")} onToggle={() => onToggleSection("export")}>
            <div className={s.toggleRow}>
              <div className={s.toggleInfo}>
                <div className={s.toggleName}>Enable Export</div>
                <div className={s.toggleDesc}>Allow article bulk export (CSV/Excel).</div>
              </div>
              <Toggle on={draft.allow_export !== false} onChange={(v) => setDraft({ allow_export: v })} />
            </div>
            <div className={s.toggleRow}>
              <div className={s.toggleInfo}>
                <div className={s.toggleName}>Enable Bulk Upload</div>
                <div className={s.toggleDesc}>Allow bulk article import from spreadsheets.</div>
              </div>
              <Toggle on={draft.allow_bulk_upload !== false} onChange={(v) => setDraft({ allow_bulk_upload: v })} />
            </div>
            {draft.allow_export !== false && (
              <UnlimitedField
                label="Exports / Month"
                value={draft.max_export_per_month}
                onChange={(v) => setDraft({ max_export_per_month: v })}
              />
            )}
          </AccordionSection>

          {/* Research */}
          <AccordionSection id="research" title="Research & Context" icon="🔍" open={openSections.has("research")} onToggle={() => onToggleSection("research")}>
            <div className={s.fieldGrid}>
              <UnlimitedField
                label="Cluster Planner / Month"
                value={draft.max_cluster_plans_per_month}
                onChange={(v) => setDraft({ max_cluster_plans_per_month: v })}
              />
              <UnlimitedField
                label="Custom Curations / Month"
                value={draft.max_custom_research_per_month}
                onChange={(v) => setDraft({ max_custom_research_per_month: v })}
              />
              <UnlimitedField
                label="Context Links"
                hint="Per project"
                value={draft.max_context_links}
                onChange={(v) => setDraft({ max_context_links: v })}
              />
            </div>
          </AccordionSection>

          {/* Prompts & AI */}
          <AccordionSection id="ai" title="Prompts & AI" icon="🤖" open={openSections.has("ai")} onToggle={() => onToggleSection("ai")}>
            <div className={s.fieldGridThree}>
              <UnlimitedField
                label="Writing Prompts"
                hint="Per project"
                value={draft.max_writing_prompts}
                onChange={(v) => setDraft({ max_writing_prompts: v })}
              />
              <div className={s.fieldLabel}>
                <span className={s.fieldLabelText}>Writing Prompt Chars</span>
                <div className={s.unlimRow}>
                  <div className={s.unlimChipGroup}>
                    <button type="button" className={`${s.unlimChip} ${isUnlim(draft.writing_prompt_char_limit) ? s.unlimChipOnGreen : ""}`} onClick={() => setDraft({ writing_prompt_char_limit: null })}>Unlimited</button>
                    <button type="button" className={`${s.unlimChip} ${!isUnlim(draft.writing_prompt_char_limit) ? s.unlimChipOn : ""}`} onClick={() => { if (isUnlim(draft.writing_prompt_char_limit)) setDraft({ writing_prompt_char_limit: 4000 }); }}>Set limit</button>
                  </div>
                  {!isUnlim(draft.writing_prompt_char_limit) && (
                    <input type="number" className={s.limitInput} min={1} value={draft.writing_prompt_char_limit ?? 4000} onChange={(e) => setDraft({ writing_prompt_char_limit: Math.max(1, Number(e.target.value) || 1) })} />
                  )}
                </div>
              </div>
              <UnlimitedField
                label="Image Prompts"
                hint="Per project"
                value={draft.max_image_prompts}
                onChange={(v) => setDraft({ max_image_prompts: v })}
              />
              <div className={s.fieldLabel}>
                <span className={s.fieldLabelText}>Image Prompt Chars</span>
                <div className={s.unlimRow}>
                  <div className={s.unlimChipGroup}>
                    <button type="button" className={`${s.unlimChip} ${isUnlim(draft.image_prompt_char_limit) ? s.unlimChipOnGreen : ""}`} onClick={() => setDraft({ image_prompt_char_limit: null })}>Unlimited</button>
                    <button type="button" className={`${s.unlimChip} ${!isUnlim(draft.image_prompt_char_limit) ? s.unlimChipOn : ""}`} onClick={() => { if (isUnlim(draft.image_prompt_char_limit)) setDraft({ image_prompt_char_limit: 2000 }); }}>Set limit</button>
                  </div>
                  {!isUnlim(draft.image_prompt_char_limit) && (
                    <input type="number" className={s.limitInput} min={1} value={draft.image_prompt_char_limit ?? 2000} onChange={(e) => setDraft({ image_prompt_char_limit: Math.max(1, Number(e.target.value) || 1) })} />
                  )}
                </div>
              </div>
              <UnlimitedField
                label="Image Regen / Article"
                hint="0 or Unlimited = no cap per article"
                value={draft.max_article_image_regenerations}
                onChange={(v) => setDraft({ max_article_image_regenerations: v })}
              />
            </div>
          </AccordionSection>

          {/* Actions */}
          <div className={s.editFormActions}>
            <button type="button" className={s.btnPrimary} onClick={onSave} disabled={saving}>
              {saving ? "Saving…" : isCreate ? "Create Plan" : "Save Changes"}
            </button>
            <button type="button" className={s.btnSecondary} onClick={onCancel} disabled={saving}>
              Cancel
            </button>
          </div>
        </div>

        {/* ── Right: live preview ── */}
        <div className={s.previewWrap}>
          <div className={s.previewCard}>
            <div className={s.previewLabel}>Live Preview</div>
            <div className={s.previewPlanName}>{previewName}</div>
            <div className={s.previewPlanKey}>{previewKey}</div>
            <div className={s.previewPrice}>
              {priceFmt(draft.cost_monthly ?? null)}
              {draft.cost_monthly ? <span className={s.previewPriceSub}>/month</span> : null}
            </div>
            {(draft.is_default || draft.is_trial_plan) && (
              <div className={s.previewBadges}>
                {draft.is_default && <span className={`${s.planBadge} ${s.planBadgeDefault}`}>Default</span>}
                {draft.is_trial_plan && <span className={`${s.planBadge} ${s.planBadgeTrial}`}>Trial · {draft.trial_period_days ?? 14}d</span>}
              </div>
            )}
            <div className={s.previewDivider} />
            <div className={s.previewFeatures}>
              <div className={s.previewFRow}>
                <span className={s.previewFLabel}>Projects</span>
                <span className={s.previewFVal}>{fmtLimit(draft.max_projects)}</span>
              </div>
              <div className={s.previewFRow}>
                <span className={s.previewFLabel}>Articles / Day</span>
                <span className={s.previewFVal}>{fmtLimit(draft.max_articles_per_day)}</span>
              </div>
              <div className={s.previewFRow}>
                <span className={s.previewFLabel}>Articles / Month</span>
                <span className={s.previewFVal}>{fmtLimit(draft.max_articles_per_month)}</span>
              </div>
              <div className={s.previewFRow}>
                <span className={s.previewFLabel}>Schedule</span>
                <span className={s.previewFVal}>{draft.allow_scheduling !== false ? fmtLimit(draft.max_scheduled_per_month) + "/mo" : "Disabled"}</span>
              </div>
              <div className={s.previewFRow}>
                <span className={s.previewFLabel}>Export</span>
                <span className={s.previewFVal}>{draft.allow_export !== false ? "Included" : "Disabled"}</span>
              </div>
              <div className={s.previewFRow}>
                <span className={s.previewFLabel}>Cluster Planner</span>
                <span className={s.previewFVal}>{fmtLimit(draft.max_cluster_plans_per_month) + "/mo"}</span>
              </div>
              <div className={s.previewFRow}>
                <span className={s.previewFLabel}>Context Links</span>
                <span className={s.previewFVal}>{fmtLimit(draft.max_context_links)}</span>
              </div>
              <div className={s.previewFRow}>
                <span className={s.previewFLabel}>Writing Prompts</span>
                <span className={s.previewFVal}>{fmtLimit(draft.max_writing_prompts)}</span>
              </div>
              <div className={s.previewFRow}>
                <span className={s.previewFLabel}>Image Regen</span>
                <span className={s.previewFVal}>{fmtLimit(draft.max_article_image_regenerations)}/article</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Main component ────────────────────────────────────────────────────────────
export function AdminPlansModule({ users }: { users: AdminUserPublic[] }) {
  const [view, setView] = useState<"list" | "edit">("list");
  const [plans, setPlans] = useState<PlanPublic[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editKey, setEditKey] = useState<string | null>(null);
  const [draft, setDraft] = useState<Partial<PlanPublic> & { key: string }>(emptyDraft);
  const [openSections, setOpenSections] = useState<Set<string>>(new Set(["basic", "content"]));
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const loadPlans = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const items = await api.adminListPlans();
      setPlans(items.sort((a, b) => a.key.localeCompare(b.key)));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load plans");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadPlans(); }, [loadPlans]);

  // Per-plan user counts
  const usersByPlan = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const u of users) {
      const k = ((u.subscription_type || "beta")).toLowerCase().trim();
      counts[k] = (counts[k] || 0) + 1;
    }
    return counts;
  }, [users]);

  const defaultPlan = plans.find((p) => p.is_default);
  const trialPlan = plans.find((p) => p.is_trial_plan);
  const trialUserCount = trialPlan ? (usersByPlan[trialPlan.key] || 0) : 0;

  function patchDraft(patch: Partial<PlanPublic> & { key?: string }) {
    setDraft((d) => ({ ...d, ...patch }));
  }

  function toggleSection(id: string) {
    setOpenSections((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function startCreate() {
    setEditKey(null);
    setDraft(emptyDraft());
    setOpenSections(new Set(["basic", "content"]));
    setError(null);
    setView("edit");
  }

  function startEdit(p: PlanPublic) {
    setEditKey(p.key);
    setDraft({ ...emptyDraft(), ...p });
    setOpenSections(new Set(["basic", "content"]));
    setError(null);
    setView("edit");
  }

  function startDuplicate(p: PlanPublic) {
    setEditKey(null);
    setDraft({ ...emptyDraft(), ...p, key: "", name: `${p.name || p.key} (Copy)`, is_default: false, is_trial_plan: false });
    setOpenSections(new Set(["basic", "content"]));
    setError(null);
    setView("edit");
  }

  async function saveDraft() {
    const key = (draft.key || "").trim().toLowerCase();
    if (!key || !/^[a-z0-9_]+$/.test(key)) {
      setError("Plan key must be lowercase letters, numbers, or underscores.");
      return;
    }
    if (!(draft.name || "").trim()) {
      setError("Plan name is required.");
      return;
    }
    if (editKey === null && plans.some((p) => p.key === key)) {
      setError(`Plan key "${key}" already exists.`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const saved = await api.adminUpsertPlan(key, { ...draft, key });
      setPlans((prev) => {
        const exists = prev.some((p) => p.key === saved.key);
        const updated = exists ? prev.map((p) => (p.key === saved.key ? saved : p)) : [...prev, saved];
        return updated.sort((a, b) => a.key.localeCompare(b.key));
      });
      setSuccessMsg(editKey ? "Plan updated successfully." : "Plan created successfully.");
      setTimeout(() => setSuccessMsg(null), 4000);
      setView("list");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save plan");
    } finally {
      setSaving(false);
    }
  }

  // ── Render ──
  if (view === "edit") {
    return (
      <div className={s.wrap}>
        <EditView
          draft={draft}
          setDraft={patchDraft}
          isCreate={editKey === null}
          saving={saving}
          error={error}
          openSections={openSections}
          onToggleSection={toggleSection}
          onSave={saveDraft}
          onCancel={() => { setView("list"); setError(null); }}
          existingKeys={plans.map((p) => p.key)}
        />
      </div>
    );
  }

  return (
    <div className={s.wrap}>
      {/* ── Page header ── */}
      <div className={s.pageHeader}>
        <div className={s.pageHeaderLeft}>
          <h1 className={s.pageTitle}>Subscription &amp; Feature Management</h1>
          <p className={s.pageDesc}>Create plans, configure limits, manage features, and monitor subscriptions.</p>
        </div>
        <div className={s.headerActions}>
          <button type="button" className={s.btnPrimary} onClick={startCreate}>
            + New Plan
          </button>
        </div>
      </div>

      {error && <div className={s.errorBar}>{error}</div>}
      {successMsg && <div className={s.successBar}>{successMsg}</div>}

      {/* ── Overview stat cards ── */}
      <div className={s.statsRow}>
        <div className={s.statCard}>
          <div className={s.statLabel}>Total Plans</div>
          <div className={s.statValue}>{loading ? "—" : plans.length}</div>
          <div className={s.statSub}>Active subscription tiers</div>
        </div>
        <div className={s.statCard}>
          <div className={s.statLabel}>Default Plan</div>
          <div className={s.statValue}>{loading ? "—" : (defaultPlan?.name || defaultPlan?.key || "None")}</div>
          <div className={s.statSub}>Assigned to new registrations</div>
        </div>
        <div className={s.statCard}>
          <div className={s.statLabel}>Trial Plan</div>
          <div className={s.statValue}>{loading ? "—" : (trialPlan?.name || trialPlan?.key || "None")}</div>
          <div className={s.statSub}>{trialPlan ? `${trialPlan.trial_period_days ?? 14}-day trial · ${trialUserCount} users` : "No trial configured"}</div>
        </div>
        <div className={s.statCard}>
          <div className={s.statLabel}>Total Users</div>
          <div className={s.statValue}>{users.length}</div>
          <div className={s.statSub}>Across all plans</div>
        </div>
      </div>

      {/* ── Plan cards grid ── */}
      {loading ? (
        <div className={s.skeletonGrid}>
          {[1, 2, 3].map((i) => <div key={i} className={s.skeletonCard} />)}
        </div>
      ) : (
        <div className={s.plansGrid}>
          {plans.length === 0 ? (
            <div className={s.emptyState}>
              No plans found. Create your first plan to get started.
            </div>
          ) : (
            plans.map((p) => (
              <PlanCard
                key={p.key}
                plan={p}
                userCount={usersByPlan[p.key] || 0}
                onEdit={() => startEdit(p)}
                onDuplicate={() => startDuplicate(p)}
              />
            ))
          )}
        </div>
      )}

      {/* ── Comparison table ── */}
      {!loading && plans.length > 1 && <ComparisonTable plans={plans} />}
    </div>
  );
}
