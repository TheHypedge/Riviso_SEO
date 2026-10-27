"use client";

import { useEffect, useState } from "react";

import projectsDark from "@/app/projects/projectsDark.module.css";
import { api, type ActivityRecord } from "@/lib/api";
import { formatDayMonYearTime } from "@/lib/dateFormat";

function describe(r: ActivityRecord): string {
  const d = r.data || {};
  const role = String(d.role || d.new_role || "");
  switch (r.action) {
    case "member_invited":
      return `invited ${String(d.invited_email || "a collaborator")}${role ? ` as ${role}` : ""}`;
    case "invite_accepted":
      return `joined the project${role ? ` as ${role}` : ""}`;
    case "role_changed":
      return `changed a member's role to ${role || "a new role"}`;
    case "member_removed":
      return "removed a member";
    default:
      return r.action.replaceAll("_", " ");
  }
}

/** Members-tab activity log (who invited/joined/changed roles/removed whom). */
export function ProjectActivityCard({ projectId }: { projectId: string }) {
  const [rows, setRows] = useState<ActivityRecord[] | null>(null);

  useEffect(() => {
    api.getProjectActivity(projectId).then(setRows).catch(() => setRows([]));
  }, [projectId]);

  return (
    <div className={projectsDark.membersCard}>
      <h2 className={projectsDark.membersSectionTitle}>Activity</h2>
      {rows === null ? (
        <p style={{ margin: 0, opacity: 0.7, fontSize: 13 }}>Loading…</p>
      ) : rows.length === 0 ? (
        <p style={{ margin: 0, opacity: 0.7, fontSize: 13 }}>No member activity yet.</p>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
          {rows.map((r) => (
            <li key={r.id} style={{ fontSize: 13, lineHeight: 1.5 }}>
              <strong>{r.actor_name || "Someone"}</strong> {describe(r)}
              <span style={{ opacity: 0.6 }}> · {formatDayMonYearTime(r.created_at)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
