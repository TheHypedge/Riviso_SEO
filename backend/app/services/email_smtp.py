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
_BRAND_PRIMARY = "#6d5efc"
_BRAND_DARK = "#101218"
_BRAND_BG = "#0b0d14"
_BRAND_TEXT = "#eef2ff"
_BRAND_MUTED = "#9aa3b8"


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
    # Link goes to /reset-password?token=TOKEN&email=EMAIL so the dedicated
    # reset page can read both params without re-routing through /login.
    link = f"{frontend}/reset-password?token={quote(reset_token)}&email={quote(to)}"
    return _layout(
        "Reset your Riviso password",
        f"""<h1 style="margin:0 0 12px;font-size:24px;color:{_BRAND_TEXT};">Reset your password</h1>
<p style="color:{_BRAND_MUTED};margin:0 0 20px;">This link is valid for <strong style="color:{_BRAND_TEXT};">1 hour</strong>. If you did not request a password reset, you can safely ignore this email.</p>
<a href="{link}" style="display:inline-block;padding:14px 22px;border-radius:10px;background:{_BRAND_PRIMARY};color:#fff;text-decoration:none;font-weight:700;font-size:16px;">Set new password</a>
<p style="color:{_BRAND_MUTED};margin:20px 0 0;font-size:13px;">Button not working? Copy and paste this link into your browser:<br/><span style="color:{_BRAND_TEXT};word-break:break-all;">{link}</span></p>""",
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
