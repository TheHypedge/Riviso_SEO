"""
Fire-and-forget transactional email dispatch (I3.11).

Primary sender: pure-Python smtplib (email_smtp.py) — no Node dependency,
immediate SMTP errors surfaced in logs, works in any Python container.

Fallback: Node subprocess (`npx tsx sendCli.ts`) when SMTP env vars are absent
but the Node email dir exists. This allows a smooth rollout: keep the Node path
working on older deploys while new deployments set SMTP_HOST/USER/PASS.
"""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
from pathlib import Path

log = logging.getLogger(__name__)

_EMAIL_DIR = Path(__file__).resolve().parents[2] / "email"


# ---------------------------------------------------------------------------
# Node subprocess fallback (kept for backward compatibility)
# ---------------------------------------------------------------------------
def _email_cli_cmd(kind: str, to: str, payload: str) -> list[str]:
    npx = shutil.which("npx") or "npx"
    send_script = _EMAIL_DIR / "sendCli.ts"
    return [npx, "--yes", "tsx", str(send_script), kind, to, payload]


async def _run_email_node(kind: str, to: str, payload: str) -> None:
    to_clean = (to or "").strip()
    if not to_clean:
        return
    if not (_EMAIL_DIR / "emailService.ts").is_file():
        log.warning("Email service missing at %s; email not sent", _EMAIL_DIR)
        return
    cmd = _email_cli_cmd(kind, to_clean, payload)
    env = os.environ.copy()
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=str(_EMAIL_DIR),
            env=env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _stdout, stderr = await proc.communicate()
        if proc.returncode != 0:
            err = (stderr or b"").decode("utf-8", errors="ignore").strip()
            smtp_pass = (os.environ.get("SMTP_PASS") or "").strip()
            safe = err.replace(smtp_pass, "[redacted]") if smtp_pass else err
            log.error("Email dispatch (node) failed kind=%s to=%s detail=%s", kind, to_clean, safe[:500])
    except Exception:
        log.exception("Email subprocess failed kind=%s", kind)


# ---------------------------------------------------------------------------
# Python SMTP dispatcher — primary path
# ---------------------------------------------------------------------------
def _smtp_configured() -> bool:
    # Delegate to email_smtp which reads from Settings (loaded via pydantic-settings
    # from backend/.env) rather than os.environ, which only contains vars from the
    # root .env file loaded by database.py's load_dotenv().
    try:
        from app.services.email_smtp import _smtp_configured as _smtp_check
        return _smtp_check()
    except Exception:
        return bool(
            (os.environ.get("SMTP_HOST") or "").strip()
            and (os.environ.get("SMTP_USER") or "").strip()
            and (os.environ.get("SMTP_PASS") or "").strip()
        )


async def _send_smtp(kind: str, to_clean: str, payload: str) -> None:
    from app.services.email_smtp import (
        send_password_reset_email,
        send_plan_notification_email,
        send_verification_email,
    )
    if kind == "verification":
        await send_verification_email(to_clean, payload)
    elif kind == "password_reset":
        await send_password_reset_email(to_clean, payload)
    elif kind == "plan_notification":
        await send_plan_notification_email(to_clean, payload)
    else:
        raise ValueError(f"Unknown email kind: {kind!r}")


async def _run_email(kind: str, to: str, payload: str) -> None:
    to_clean = (to or "").strip()
    if not to_clean:
        return

    if _smtp_configured():
        # Attempt with one retry on transient failures.
        for attempt in range(2):
            try:
                await _send_smtp(kind, to_clean, payload)
                log.info("Email sent kind=%s to=%s attempt=%d", kind, to_clean, attempt + 1)
                return
            except Exception:
                if attempt == 0:
                    log.warning("SMTP attempt 1 failed kind=%s to=%s — retrying in 5s", kind, to_clean)
                    await asyncio.sleep(5)
                else:
                    log.exception("SMTP retry failed kind=%s to=%s", kind, to_clean)
        return

    # Fall back to Node subprocess when SMTP is not configured via env.
    await _run_email_node(kind, to_clean, payload)


# ---------------------------------------------------------------------------
# Public fire-and-forget helpers (callers unchanged)
# ---------------------------------------------------------------------------
def dispatch_verification_email(*, to: str, token: str) -> None:
    asyncio.create_task(_run_email("verification", to, token))


def dispatch_password_reset_email(*, to: str, token: str) -> None:
    asyncio.create_task(_run_email("password_reset", to, token))


def dispatch_plan_notification_email(*, to: str, plan_name: str) -> None:
    asyncio.create_task(_run_email("plan_notification", to, plan_name))


def dispatch_invitation_email(
    *,
    to: str,
    invited_by_name: str,
    project_name: str,
    project_website_url: str,
    role: str,
    accept_url: str,
) -> None:
    import json
    asyncio.create_task(
        _run_invitation_email(to, invited_by_name, project_name, project_website_url, role, accept_url)
    )


async def _run_invitation_email(
    to: str,
    invited_by: str,
    project_name: str,
    project_url: str,
    role: str,
    accept_url: str,
) -> None:
    to_clean = (to or "").strip()
    if not to_clean:
        return
    if _smtp_configured():
        from app.services.email_smtp import send_invitation_email
        try:
            await send_invitation_email(to_clean, invited_by, project_name, project_url, role, accept_url)
            log.info("Invitation email sent to=%s project=%s", to_clean, project_name)
        except Exception:
            log.exception("Invitation email failed to=%s", to_clean)
    else:
        log.warning("SMTP not configured; invitation email not sent to=%s", to_clean)


async def notify_plan_event(*, email: str, plan_name: str, event: str) -> None:
    """Wrapper for admin/subscription managers. ``event`` reserved for future variants."""
    _ = event
    await _run_email("plan_notification", email, plan_name)
