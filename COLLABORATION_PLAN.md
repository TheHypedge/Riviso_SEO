# Project Collaboration & Sharing — Implementation Plan

> **Status**: 🚧 In progress  
> **Date**: 2026-06-25  
> **Branch**: `main`

---

## Overview

Full project collaboration system: invite users by email, role-based access (Admin/Editor/Viewer), shared-project discovery, subscription inheritance from project owner, in-app notifications, activity timeline.

---

## Phase 1 — Backend Data Layer (`storage.py`)

- [ ] **1.1** `_normalize_collaborator_dict(d)` — field validation for `project_collaborators` docs  
- [ ] **1.2** `get_project_collaborators(project_id)` → list of active collaborator records  
- [ ] **1.3** `get_collaborator(collaborator_id)` → dict|None  
- [ ] **1.4** `get_collaborator_for_user(project_id, user_id)` → dict|None  
- [ ] **1.5** `insert_collaborator(data)` → None  
- [ ] **1.6** `patch_collaborator_fields(collaborator_id, updates)` → bool  
- [ ] **1.7** `delete_collaborator(collaborator_id)` → bool  
- [ ] **1.8** `get_projects_shared_with_user(user_id)` → list of `{project_id, role, joined_at}`  
- [ ] **1.9** `_normalize_invitation_dict(d)` — field validation for `project_invitations` docs  
- [ ] **1.10** `get_pending_invitations_for_email(email)` → list  
- [ ] **1.11** `get_pending_invitations_for_user_id(user_id)` → list  
- [ ] **1.12** `get_invitation(invitation_id)` → dict|None  
- [ ] **1.13** `get_invitation_by_token(token)` → dict|None  
- [ ] **1.14** `get_project_invitations(project_id)` → list (all statuses)  
- [ ] **1.15** `insert_invitation(data)` → None  
- [ ] **1.16** `patch_invitation_fields(invitation_id, updates)` → bool  
- [ ] **1.17** `get_notifications_for_user(user_id, *, unread_only, limit)` → list  
- [ ] **1.18** `get_unread_notification_count(user_id)` → int  
- [ ] **1.19** `insert_notification(data)` → None  
- [ ] **1.20** `mark_notification_read(notification_id, user_id)` → bool  
- [ ] **1.21** `mark_all_notifications_read(user_id)` → int  
- [ ] **1.22** `insert_activity(data)` → None  
- [ ] **1.23** `get_project_activity(project_id, *, limit)` → list  
- [ ] **1.24** `get_project_member_context(project_id, user_id)` → `{has_access, is_owner, role, owner_user_id, owner_subscription_type}` — central auth function  
- [ ] **1.25** `load_shared_projects_listing(user_id)` → list of project dicts (shared with user) with lightweight projection  

---

## Phase 2 — Backend Schemas

- [ ] **2.1** Create `backend/app/schemas/collaboration.py`:
  - `CollaboratorRole` enum (`admin`, `editor`, `viewer`)
  - `InvitationStatus` enum
  - `CollaboratorPublic` model
  - `InvitationPublic` model
  - `MembersResponse` model
  - `InviteRequest` model
  - `ChangeRoleRequest` model
  - `NotificationPublic` model
  - `ActivityRecord` model
  - `ProjectMemberContext` dataclass
- [ ] **2.2** Extend `backend/app/schemas/projects.py` `ProjectPublic`:
  - `is_shared: bool = False`
  - `your_role: str | None = None`
  - `owner_name: str | None = None`
  - `member_count: int = 0`

---

## Phase 3 — New Backend Route Files

- [ ] **3.1** Create `backend/app/api/routes/project_collaboration.py`:
  - `GET /{project_id}/collaboration/members` — list members + pending invites
  - `POST /{project_id}/collaboration/invite` — invite user by email
  - `PATCH /{project_id}/collaboration/members/{collab_id}/role` — change role
  - `DELETE /{project_id}/collaboration/members/{collab_id}` — remove collaborator
  - `POST /{project_id}/collaboration/invitations/{invite_id}/resend` — resend email
  - `DELETE /{project_id}/collaboration/invitations/{invite_id}` — cancel invitation
  - `GET /{project_id}/collaboration/activity` — activity timeline

- [ ] **3.2** Create `backend/app/api/routes/invitations.py`:
  - `GET /api/invitations` — list my pending invitations
  - `POST /api/invitations/{invite_id}/accept` — accept
  - `POST /api/invitations/{invite_id}/decline` — decline

- [ ] **3.3** Create `backend/app/api/routes/notifications.py`:
  - `GET /api/notifications` — list notifications
  - `GET /api/notifications/count` — unread count (lightweight poll)
  - `PATCH /api/notifications/{id}/read` — mark single read
  - `POST /api/notifications/read-all` — mark all read

---

## Phase 4 — Router Registration

- [ ] **4.1** Register `project_collaboration.router` in `backend/app/api/router.py`
- [ ] **4.2** Register `invitations.router` in `backend/app/api/router.py`
- [ ] **4.3** Register `notifications.router` in `backend/app/api/router.py`

---

## Phase 5 — Auth Dependency

- [ ] **5.1** Add `require_project_member` dependency to `backend/app/core/deps.py` — returns `ProjectMemberContext` dataclass with `{role, is_owner, owner_user_id, owner_subscription_type}`; raises 404 if no access; takes optional `min_role` param

---

## Phase 6 — Email: Invitation Template

- [ ] **6.1** Add `_invitation_html(invited_by, project_name, project_url, role, accept_url)` template builder in `backend/app/services/email_smtp.py`
- [ ] **6.2** Add `send_invitation_email(to, invited_by, project_name, project_url, role, accept_url)` async function
- [ ] **6.3** Add `invitation` kind handler in `backend/app/services/email_dispatch.py`
- [ ] **6.4** Add `dispatch_invitation_email(*, to, invited_by_name, project_name, project_website_url, role, accept_url)` fire-and-forget helper

---

## Phase 7 — Modify Existing Backend Routes

- [ ] **7.1** `projects.py` — `list_projects`: fetch shared projects + annotate with `is_shared`, `your_role`, `owner_name`
- [ ] **7.2** `projects.py` — `get_project`: allow collaborators (not owner-only)
- [ ] **7.3** `projects.py` — `get_article_quota`: use owner's subscription when caller is collaborator
- [ ] **7.4** `projects.py` — `get_project_feature_limits`: use owner's subscription when caller is collaborator
- [ ] **7.5** `projects.py` — `delete_project`: explicitly gate to owner only (collaborators get 403)
- [ ] **7.6** `auth.py` — on new user registration, call `get_pending_invitations_for_email` and stamp `invited_user_id` on matching pending invites

---

## Phase 8 — Frontend API Layer (`frontend/src/lib/api.ts`)

- [ ] **8.1** Add TypeScript types: `CollaboratorRole`, `InvitationStatus`, `CollaboratorPublic`, `InvitationPublic`, `MembersResponse`, `NotificationPublic`, `ActivityRecord`
- [ ] **8.2** Extend `ProjectPublic` type with `is_shared`, `your_role`, `owner_name`, `member_count`
- [ ] **8.3** Add collaboration API functions: `getProjectMembers`, `inviteCollaborator`, `changeCollaboratorRole`, `removeCollaborator`, `resendInvitation`, `cancelInvitation`, `getProjectActivity`
- [ ] **8.4** Add invitation API functions: `getMyInvitations`, `acceptInvitation`, `declineInvitation`
- [ ] **8.5** Add notification API functions: `getNotifications`, `getUnreadNotificationCount`, `markNotificationRead`, `markAllNotificationsRead`
- [ ] **8.6** Add `_cacheNotificationCount` (30s TTL) for the unread count poll

---

## Phase 9 — Frontend: Dashboard (`dashboard/page.tsx`)

- [ ] **9.1** `projectFilter` state (`"all" | "owned" | "shared"`) + filter pill buttons above grid
- [ ] **9.2** Share modal state: `shareTargetProject`, `shareModalOpen`, `shareMembers`, `shareInviteEmail`, `shareInviteRole`, `shareInviteBusy`
- [ ] **9.3** Add "Share project" to project action menu (visible for owner/admin roles)
- [ ] **9.4** Share modal: invite form (email + role select) + members list (role change / remove) + pending invites (resend / cancel) — uses `useFocusTrap`
- [ ] **9.5** Shared project card: "Shared" badge, `Owner: {owner_name}`, role chip
- [ ] **9.6** Owned project card: "Owner: You" tag, member count chip (if `member_count > 0`)
- [ ] **9.7** Hide "Delete project" from menu for shared (non-owner) projects
- [ ] **9.8** Notification bell button in dashboard header area with unread count badge; dropdown panel with recent notifications list
- [ ] **9.9** CSS for all new dashboard components in `dashboard.module.css`

---

## Phase 10 — Frontend: Invitations Page

- [ ] **10.1** Create `frontend/src/app/invitations/page.tsx` — full invitations page
- [ ] **10.2** Create `frontend/src/app/invitations/invitations.module.css` — page styles
- [ ] **10.3** Invitation cards: project name, owner, website, role badge, date, Accept/Decline buttons
- [ ] **10.4** Handle `?token={token}` query param from email links (highlight matching invite)
- [ ] **10.5** Empty state: friendly message when no pending invitations
- [ ] **10.6** Post-accept redirect to the newly accessible project

---

## Phase 11 — Frontend: Notification Bell Component

- [ ] **11.1** Create `frontend/src/components/NotificationBell.tsx` — bell icon, badge, dropdown
- [ ] **11.2** Poll `getUnreadNotificationCount` every 30s via `setInterval` on mount
- [ ] **11.3** Dropdown: 10 most recent notifications, mark-read on click, "Mark all read" button
- [ ] **11.4** Link notifications to relevant pages (invitation → `/invitations`, project event → `/projects/{id}`)
- [ ] **11.5** Wire `NotificationBell` into the dashboard header

---

## Phase 12 — Frontend: Project Page Members Tab

- [ ] **12.1** Add `"members"` to `TabKey` type in `projects/[projectId]/page.tsx`
- [ ] **12.2** Add Members tab to sidebar navigation
- [ ] **12.3** Members tab content: owner row (pinned), collaborators list (role chip, change role, remove), pending invites (resend/cancel), invite form
- [ ] **12.4** Activity section: collapsible timeline showing 20 most recent project events
- [ ] **12.5** CSS for members tab in `page.module.css`

---

## Phase 13 — Deploy & Smoke Test

- [ ] **13.1** Run `docker compose down && docker compose up -d --build` on VPS
- [ ] **13.2** Verify backend health: `docker compose ps`
- [ ] **13.3** Test invite flow end-to-end (owner invites → user accepts → shared project appears)
- [ ] **13.4** Test role enforcement (viewer cannot trigger generation)
- [ ] **13.5** Test subscription inheritance (collaborator gets owner plan limits)
- [ ] **13.6** Test notification delivery (in-app + email)
- [ ] **13.7** Test removal (shared project disappears from collaborator's dashboard)

---

## Future / Deferred (architecture supports it, UI not wired)

- [ ] **F.1** Ownership transfer UI in Members tab  
- [ ] **F.2** Email-link invite landing for non-registered users (show preview + "Sign up to accept")  
- [ ] **F.3** Role-gated UI rendering (hide Generate buttons for Viewer role)  
- [ ] **F.4** Dedicated Activity tab in project page  
- [ ] **F.5** Sidebar nav badge for pending invitations count  

---

## Key Invariants

- All collaboration modals use `useFocusTrap` — no `window.confirm` / `window.alert`
- Z-index tokens only: `--z-dropdown`, `--z-modal-bg`, `--z-modal`, `--z-toast`
- New project fields (if any) added to both `_normalize_project_dict` AND `_apply_article_updates_dict`
- `docker compose` (V2, space) — never `docker-compose`
- Access checks: collaborators get owner's subscription plan limits but their own usage counters
- `list_projects` response shape is additive — new optional fields with defaults, existing clients unaffected
