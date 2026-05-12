from __future__ import annotations

from pydantic import BaseModel


class ProfilePublic(BaseModel):
    id: str
    email: str
    full_name: str | None = None
    phone: str | None = None
    timezone: str | None = None
    subscription_type: str | None = None
    account_status: str | None = None
    created_at: str | None = None


class ProfileUpdate(BaseModel):
    full_name: str | None = None
    phone: str | None = None
    timezone: str | None = None

