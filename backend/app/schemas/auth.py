from __future__ import annotations

from pydantic import BaseModel, EmailStr, Field


class TokenPair(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=2000)


class RegisterRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=2000)


class RegisterPendingResponse(BaseModel):
    ok: bool = True
    requires_verification: bool = True
    message: str = "Verification email sent. Check your inbox to activate your account."
    email: EmailStr
    retry_after_seconds: int = 60


class ResendVerificationRequest(BaseModel):
    email: EmailStr


class ResendVerificationResponse(BaseModel):
    ok: bool = True
    message: str = "If that email is pending verification, a new code has been sent."
    retry_after_seconds: int = 60


class VerifyEmailRequest(BaseModel):
    email: EmailStr
    token: str = Field(min_length=4, max_length=128)


class VerifyEmailResponse(BaseModel):
    ok: bool = True
    message: str
    access_token: str | None = None
    refresh_token: str | None = None
    token_type: str = "bearer"


class CheckEmailRequest(BaseModel):
    email: EmailStr


class CheckEmailResponse(BaseModel):
    exists: bool


class ForgotPasswordRequest(BaseModel):
    email: EmailStr


class ForgotPasswordResponse(BaseModel):
    ok: bool = True
    message: str = "If that email is registered, a password reset link has been sent."


class ValidateResetTokenResponse(BaseModel):
    valid: bool
    reason: str | None = None  # "expired" | "invalid" | None when valid


class ResetPasswordRequest(BaseModel):
    token: str = Field(min_length=8, max_length=128)
    password: str = Field(min_length=8, max_length=2000)


class ResetPasswordResponse(BaseModel):
    ok: bool = True
    message: str = "Password updated successfully."


class UserPublic(BaseModel):
    id: str
    email: EmailStr
    role: str = "user"
    subscription_type: str | None = None
