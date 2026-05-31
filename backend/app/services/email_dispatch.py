"""Fire-and-forget transactional email dispatch via Nodemailer (backend/email)."""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
from pathlib import Path

log = logging.getLogger(__name__)

_EMAIL_DIR = Path(__file__).resolve().parents[2] / "email"


def _email_cli_cmd(kind: str, to: str, payload: str) -> list[str]:
    npx = shutil.which("npx") or "npx"
    send_script = _EMAIL_DIR / "sendCli.ts"
    return [npx, "--yes", "tsx", str(send_script), kind, to, payload]


async def _run_email(kind: str, to: str, payload: str) -> None:
    to_clean = (to or "").strip()
    if not to_clean:
        return
    if not (_EMAIL_DIR / "emailService.ts").is_file():
        log.warning("Email service missing at %s", _EMAIL_DIR)
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
            log.error("Email dispatch failed kind=%s to=%s detail=%s", kind, to_clean, safe[:500])
    except Exception:
        log.exception("Email subprocess failed kind=%s", kind)


def dispatch_verification_email(*, to: str, token: str) -> None:
    asyncio.create_task(_run_email("verification", to, token))


def dispatch_password_reset_email(*, to: str, token: str) -> None:
    asyncio.create_task(_run_email("password_reset", to, token))


def dispatch_plan_notification_email(*, to: str, plan_name: str) -> None:
    asyncio.create_task(_run_email("plan_notification", to, plan_name))


async def notify_plan_event(*, email: str, plan_name: str, event: str) -> None:
    """
    Wrapper for admin/limitation or subscription managers.

    ``event`` is reserved for future template variants (upgrade, trial_expired, etc.).
    """
    _ = event
    await _run_email("plan_notification", email, plan_name)
