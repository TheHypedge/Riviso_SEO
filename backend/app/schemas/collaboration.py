from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, Field


class CollaboratorRole(str, Enum):
    admin = "admin"
    editor = "editor"
    viewer = "viewer"


class InvitationStatus(str, Enum):
    pending = "pending"
    accepted = "accepted"
    declined = "declined"
    cancelled = "cancelled"
    expired = "expired"


class CollaboratorPublic(BaseModel):
    id: str
    project_id: str
    user_id: str
    user_name: str
    user_email: str
    user_avatar_initials: str
    role: str
    status: str
    invited_at: str
    joined_at: str | None = None


class InvitationPublic(BaseModel):
    id: str
    project_id: str
    project_name: str
    project_website_url: str | None = None
    invited_email: str
    invited_by_name: str
    role: str
    status: str
    created_at: str
    expires_at: str
    responded_at: str | None = None


class MembersResponse(BaseModel):
    collaborators: list[CollaboratorPublic]
    pending_invitations: list[InvitationPublic]


class InviteRequest(BaseModel):
    email: str = Field(min_length=1, max_length=500)
    role: CollaboratorRole


class ChangeRoleRequest(BaseModel):
    role: CollaboratorRole


class NotificationPublic(BaseModel):
    id: str
    type: str
    title: str
    body: str
    data: dict = Field(default_factory=dict)
    read: bool
    created_at: str


class NotificationCountResponse(BaseModel):
    count: int


class ActivityRecord(BaseModel):
    id: str
    actor_name: str
    action: str
    data: dict = Field(default_factory=dict)
    created_at: str
