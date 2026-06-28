"""
Pure-Python SMTP email sender (I3.11).

Replaces the `npx tsx sendCli.ts` Node subprocess so the backend container
has no Node dependency. Uses only stdlib `smtplib` + `email` modules run in a
thread (asyncio-safe, non-blocking).

Config (env vars):
    SMTP_HOST     required
    SMTP_PORT     default 587
    SMTP_USER     required
    SMTP_PASS     required
    SMTP_FROM     optional — defaults to SMTP_USER
    SMTP_SECURE   optional — "true" forces SSL; "false" forces STARTTLS;
                  auto-detected from port otherwise (465 → SSL, else STARTTLS)
    FRONTEND_BASE_URL  used for password-reset link (default http://localhost:3000)
"""

from __future__ import annotations

import logging
import os
import smtplib
import ssl
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

_log = logging.getLogger("riviso.email")

# ---------------------------------------------------------------------------
# Brand constants — keep in sync with backend/email/emailService.ts
# ---------------------------------------------------------------------------
_BRAND_PRIMARY = "#d97757"   # ember — Riviso action colour
_BRAND_PRIMARY_DARK = "#c86a4c"
_BRAND_DARK = "#121214"     # void-elevated
_BRAND_BG = "#0b0b0d"       # void
_BRAND_TEXT = "#faf9f5"     # on-dark
_BRAND_MUTED = "#a09d96"    # on-dark-soft


# ---------------------------------------------------------------------------
# HTML layout
# ---------------------------------------------------------------------------
def _layout(title: str, body_html: str) -> str:
    return f"""<!DOCTYPE html>
<html lang="en">
  <head><meta charset="utf-8" /><title>{title}</title></head>
  <body style="margin:0;padding:0;background:{_BRAND_BG};font-family:Inter,Arial,sans-serif;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:{_BRAND_BG};padding:32px 16px;">
      <tr><td align="center">
        <table width="560" cellpadding="0" cellspacing="0"
               style="background:{_BRAND_DARK};border-radius:14px;border:1px solid rgba(255,255,255,0.08);overflow:hidden;">
          <tr><td style="padding:28px 32px 8px;">
            <div style="font-size:22px;font-weight:700;color:{_BRAND_TEXT};">Riviso</div>
            <div style="font-size:13px;color:{_BRAND_MUTED};margin-top:4px;">SEO content operations</div>
          </td></tr>
          <tr><td style="padding:8px 32px 28px;color:{_BRAND_TEXT};line-height:1.6;font-size:15px;">
            {body_html}
          </td></tr>
          <tr><td style="padding:16px 32px;background:rgba(255,255,255,0.03);color:{_BRAND_MUTED};font-size:12px;">
            You received this email because of activity on your Riviso account.
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>"""


# ---------------------------------------------------------------------------
# Template builders
# ---------------------------------------------------------------------------
def _verification_html(code: str) -> str:
    return _layout(
        "Verify your Riviso email",
        f"""<h1 style="margin:0 0 12px;font-size:24px;color:{_BRAND_TEXT};">Verify your email</h1>
<p style="color:{_BRAND_MUTED};margin:0 0 20px;">Enter this verification code in Riviso to activate your account. It expires in 15 minutes.</p>
<div style="display:inline-block;padding:14px 22px;border-radius:10px;background:{_BRAND_PRIMARY};color:#fff;font-size:28px;font-weight:700;letter-spacing:0.25em;">{code}</div>""",
    )


def _password_reset_html(to: str, reset_token: str) -> str:
    try:
        from app.core.config import settings as _s
        _raw_url = str(_s.frontend_base_url or "") if _s.frontend_base_url else ""
    except Exception:
        _raw_url = os.environ.get("FRONTEND_BASE_URL") or ""
    frontend = (_raw_url or "http://localhost:3000").rstrip("/")
    from urllib.parse import quote
    # Token-only link — email is never exposed in the URL.
    link = f"{frontend}/reset-password?token={quote(reset_token)}"
    return _layout(
        "Reset your Riviso password",
        f"""<h1 style="margin:0 0 8px;font-size:24px;font-weight:700;color:{_BRAND_TEXT};">Reset your password</h1>
<p style="color:{_BRAND_MUTED};margin:0 0 8px;font-size:14px;line-height:1.6;">A password reset was requested for <strong style="color:{_BRAND_TEXT};">{to}</strong>.</p>
<p style="color:{_BRAND_MUTED};margin:0 0 24px;font-size:14px;line-height:1.6;">Click the button below to set a new password. This link expires in <strong style="color:{_BRAND_TEXT};">1 hour</strong> and can only be used once.</p>
<a href="{link}" style="display:inline-block;padding:14px 28px;border-radius:8px;background:{_BRAND_PRIMARY};color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;letter-spacing:0.01em;">Set New Password</a>
<p style="color:{_BRAND_MUTED};margin:24px 0 0;font-size:13px;line-height:1.6;">If you didn't request this, you can safely ignore this email — your password won't change.</p>
<p style="color:{_BRAND_MUTED};margin:16px 0 0;font-size:12px;">Button not working? Copy this link into your browser:<br/><span style="color:{_BRAND_TEXT};word-break:break-all;">{link}</span></p>""",
    )


def _invitation_html(invited_by: str, project_name: str, project_url: str, role: str, accept_url: str) -> str:
    inviter = invited_by or "A teammate"
    proj = project_name or "a project"
    url_display = project_url or ""
    role_cap = (role or "collaborator").capitalize()
    role_desc = {
        "Admin": "full management rights (invite members, change settings, generate content)",
        "Editor": "create and edit content in this project",
        "Viewer": "view content and reports in this project",
    }.get(role_cap, "collaborate on this project")
    return _layout(
        f"{inviter} shared {proj} with you on Riviso",
        f"""<h1 style="margin:0 0 8px;font-size:24px;color:{_BRAND_TEXT};">Project access shared</h1>
<p style="color:{_BRAND_MUTED};margin:0 0 20px;font-size:15px;line-height:1.6;">
  <strong style="color:{_BRAND_TEXT};">{inviter}</strong> has shared the project
  <strong style="color:{_BRAND_TEXT};">{proj}</strong> with you on Riviso.
</p>
<table style="width:100%;border-collapse:collapse;margin:0 0 24px;border-radius:8px;overflow:hidden;border:1px solid rgba(255,255,255,0.08);">
  <tr><td style="padding:12px 16px;background:rgba(255,255,255,0.04);color:{_BRAND_MUTED};font-size:13px;width:80px;">Project</td>
      <td style="padding:12px 16px;background:rgba(255,255,255,0.02);color:{_BRAND_TEXT};font-size:13px;font-weight:600;">{proj}</td></tr>
  {f'<tr><td style="padding:12px 16px;background:rgba(255,255,255,0.04);color:{_BRAND_MUTED};font-size:13px;">Website</td><td style="padding:12px 16px;background:rgba(255,255,255,0.02);color:{_BRAND_TEXT};font-size:13px;">{url_display}</td></tr>' if url_display else ""}
  <tr><td style="padding:12px 16px;background:rgba(255,255,255,0.04);color:{_BRAND_MUTED};font-size:13px;">Your role</td>
      <td style="padding:12px 16px;background:rgba(255,255,255,0.02);color:{_BRAND_PRIMARY};font-size:13px;font-weight:700;">{role_cap}</td></tr>
  <tr><td style="padding:12px 16px;background:rgba(255,255,255,0.04);color:{_BRAND_MUTED};font-size:13px;">Access</td>
      <td style="padding:12px 16px;background:rgba(255,255,255,0.02);color:{_BRAND_TEXT};font-size:13px;">{role_desc}</td></tr>
</table>
<a href="{accept_url}" style="display:inline-block;padding:14px 28px;border-radius:10px;background:{_BRAND_PRIMARY};color:#fff;text-decoration:none;font-weight:700;font-size:16px;letter-spacing:0.01em;">Accept &amp; open project</a>
<p style="color:{_BRAND_MUTED};margin:24px 0 0;font-size:13px;line-height:1.6;">This invitation expires in 7 days. Sign in to your Riviso account to accept — the project will immediately appear in your dashboard.</p>""",
    )


def _plan_notification_html(plan_name: str) -> str:
    plan = (plan_name or "your plan").strip()
    return _layout(
        "Riviso plan update",
        f"""<h1 style="margin:0 0 12px;font-size:24px;color:{_BRAND_TEXT};">Plan update</h1>
<p style="color:{_BRAND_MUTED};margin:0;">Your Riviso workspace is now associated with <strong style="color:{_BRAND_TEXT};">{plan}</strong>.</p>
<p style="color:{_BRAND_MUTED};margin:16px 0 0;">Sign in to review your updated limits and trial status.</p>""",
    )


# ---------------------------------------------------------------------------
# SMTP config helpers — read from Settings (loaded from backend/.env via
# pydantic-settings) so the values are available regardless of whether
# os.environ was patched by load_dotenv.
# ---------------------------------------------------------------------------
def _get_smtp_settings() -> dict:
    """Return SMTP config from the app Settings object."""
    try:
        from app.core.config import settings as _s
        return {
            "host": (_s.smtp_host or "").strip(),
            "port": int(_s.smtp_port or 587),
            "user": (_s.smtp_user or "").strip(),
            "password": (_s.smtp_pass or "").strip(),
            "from_addr": ((_s.smtp_from or _s.smtp_user) or "").strip(),
            "secure": (_s.smtp_secure or "").strip().lower(),
        }
    except Exception:
        # Fallback to os.environ if Settings import fails (e.g. standalone script)
        return {
            "host": (os.environ.get("SMTP_HOST") or "").strip(),
            "port": int(os.environ.get("SMTP_PORT") or "587"),
            "user": (os.environ.get("SMTP_USER") or "").strip(),
            "password": (os.environ.get("SMTP_PASS") or "").strip(),
            "from_addr": (os.environ.get("SMTP_FROM") or os.environ.get("SMTP_USER") or "").strip(),
            "secure": (os.environ.get("SMTP_SECURE") or "").strip().lower(),
        }


def _smtp_configured() -> bool:
    cfg = _get_smtp_settings()
    return bool(cfg["host"] and cfg["user"] and cfg["password"])


def _from_address() -> str:
    return _get_smtp_settings()["from_addr"]


def _send_html_sync(to: str, subject: str, html: str) -> None:
    """Blocking SMTP send — call via asyncio.to_thread to stay non-blocking."""
    cfg = _get_smtp_settings()
    if not (cfg["host"] and cfg["user"] and cfg["password"]):
        raise RuntimeError("SMTP is not configured (SMTP_HOST, SMTP_USER, SMTP_PASS required).")

    host = cfg["host"]
    port = cfg["port"]
    user = cfg["user"]
    password = cfg["password"]
    secure_flag = cfg["secure"]

    if secure_flag == "true":
        use_ssl = True
    elif secure_flag == "false":
        use_ssl = False
    else:
        use_ssl = port == 465

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = _from_address()
    msg["To"] = to
    msg.attach(MIMEText(html, "html", "utf-8"))

    ctx = ssl.create_default_context()

    if use_ssl:
        with smtplib.SMTP_SSL(host, port, context=ctx) as smtp:
            smtp.login(user, password)
            smtp.sendmail(_from_address(), [to], msg.as_string())
    else:
        with smtplib.SMTP(host, port) as smtp:
            smtp.ehlo()
            smtp.starttls(context=ctx)
            smtp.login(user, password)
            smtp.sendmail(_from_address(), [to], msg.as_string())


# ---------------------------------------------------------------------------
# Public async API (mirrors the three kinds from sendCli.ts)
# ---------------------------------------------------------------------------
async def send_verification_email(to: str, token: str) -> None:
    import asyncio
    html = _verification_html((token or "").strip())
    await asyncio.to_thread(_send_html_sync, to, "Verify your Riviso account", html)


async def send_password_reset_email(to: str, token: str) -> None:
    import asyncio
    html = _password_reset_html(to, (token or "").strip())
    await asyncio.to_thread(_send_html_sync, to, "Reset your Riviso password", html)


async def send_plan_notification_email(to: str, plan_name: str) -> None:
    import asyncio
    html = _plan_notification_html(plan_name)
    await asyncio.to_thread(_send_html_sync, to, f"Riviso plan update — {plan_name}", html)


async def send_invitation_email(
    to: str,
    invited_by: str,
    project_name: str,
    project_url: str,
    role: str,
    accept_url: str,
) -> None:
    import asyncio
    html = _invitation_html(invited_by, project_name, project_url, role, accept_url)
    subject = f"{invited_by or 'A teammate'} shared {project_name or 'a project'} with you on Riviso"
    await asyncio.to_thread(_send_html_sync, to, subject, html)
