import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";

const BRAND = {
  primary: "#6d5efc",
  dark: "#101218",
  text: "#eef2ff",
  muted: "#9aa3b8",
};

function env(name: string, fallback = ""): string {
  return (process.env[name] || fallback).trim();
}

function smtpConfigured(): boolean {
  return Boolean(env("SMTP_HOST") && env("SMTP_USER") && env("SMTP_PASS"));
}

let transporter: Transporter | null = null;

function smtpSecureForPort(port: number): boolean {
  const flag = env("SMTP_SECURE").toLowerCase();
  if (flag === "true") return true;
  if (flag === "false") return false;
  return port === 465;
}

function getTransporter(): Transporter {
  if (transporter) return transporter;
  const host = env("SMTP_HOST");
  const port = Number(env("SMTP_PORT", "587"));
  const user = env("SMTP_USER");
  const pass = env("SMTP_PASS");
  if (!host || !user || !pass) {
    throw new Error("SMTP is not configured (SMTP_HOST, SMTP_USER, SMTP_PASS required).");
  }
  const secure = smtpSecureForPort(port);
  // Hostinger: port 587 uses STARTTLS (secure=false); port 465 uses implicit TLS (secure=true).
  const requireTLS = !secure && port !== 25;

  transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    requireTLS,
    auth: { user, pass },
    tls: {
      minVersion: "TLSv1.2",
      servername: host,
    },
  });
  return transporter;
}

function fromAddress(): string {
  return env("SMTP_FROM", env("SMTP_USER"));
}

function layout(title: string, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html lang="en">
  <head><meta charset="utf-8" /><title>${title}</title></head>
  <body style="margin:0;padding:0;background:#0b0d14;font-family:Inter,Arial,sans-serif;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#0b0d14;padding:32px 16px;">
      <tr><td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="background:${BRAND.dark};border-radius:14px;border:1px solid rgba(255,255,255,0.08);overflow:hidden;">
          <tr><td style="padding:28px 32px 8px;">
            <div style="font-size:22px;font-weight:700;color:${BRAND.text};">Riviso</div>
            <div style="font-size:13px;color:${BRAND.muted};margin-top:4px;">SEO content operations</div>
          </td></tr>
          <tr><td style="padding:8px 32px 28px;color:${BRAND.text};line-height:1.6;font-size:15px;">
            ${bodyHtml}
          </td></tr>
          <tr><td style="padding:16px 32px;background:rgba(255,255,255,0.03);color:${BRAND.muted};font-size:12px;">
            You received this email because of activity on your Riviso account.
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

async function sendHtml(to: string, subject: string, html: string): Promise<void> {
  if (!smtpConfigured()) {
    throw new Error("SMTP is not configured.");
  }
  const tx = getTransporter();
  await tx.sendMail({
    from: fromAddress(),
    to,
    subject,
    html,
  });
}

export async function sendVerificationEmail(to: string, token: string): Promise<void> {
  const code = (token || "").trim();
  const html = layout(
    "Verify your Riviso email",
    `<h1 style="margin:0 0 12px;font-size:24px;color:${BRAND.text};">Verify your email</h1>
     <p style="color:${BRAND.muted};margin:0 0 20px;">Enter this verification code in Riviso to activate your account. It expires in 15 minutes.</p>
     <div style="display:inline-block;padding:14px 22px;border-radius:10px;background:${BRAND.primary};color:#fff;font-size:28px;font-weight:700;letter-spacing:0.25em;">${code}</div>`,
  );
  await sendHtml(to, "Verify your Riviso account", html);
}

export async function sendPasswordResetEmail(to: string, token: string): Promise<void> {
  const resetToken = (token || "").trim();
  const frontend = env("FRONTEND_BASE_URL", "http://localhost:3000").replace(/\/$/, "");
  const link = `${frontend}/login?reset=${encodeURIComponent(resetToken)}&email=${encodeURIComponent(to)}`;
  const html = layout(
    "Reset your Riviso password",
    `<h1 style="margin:0 0 12px;font-size:24px;color:${BRAND.text};">Reset your password</h1>
     <p style="color:${BRAND.muted};margin:0 0 20px;">This link is valid for 1 hour. If you did not request a reset, you can ignore this email.</p>
     <a href="${link}" style="display:inline-block;padding:12px 18px;border-radius:10px;background:${BRAND.primary};color:#fff;text-decoration:none;font-weight:700;">Reset password</a>
     <p style="color:${BRAND.muted};margin:20px 0 0;font-size:13px;">Or use this token: <strong style="color:${BRAND.text};">${resetToken}</strong></p>`,
  );
  await sendHtml(to, "Reset your Riviso password", html);
}

export async function sendPlanNotificationEmail(to: string, planName: string): Promise<void> {
  const plan = (planName || "your plan").trim();
  const html = layout(
    "Riviso plan update",
    `<h1 style="margin:0 0 12px;font-size:24px;color:${BRAND.text};">Plan update</h1>
     <p style="color:${BRAND.muted};margin:0;">Your Riviso workspace is now associated with <strong style="color:${BRAND.text};">${plan}</strong>.</p>
     <p style="color:${BRAND.muted};margin:16px 0 0;">Sign in to review your updated limits and trial status.</p>`,
  );
  await sendHtml(to, `Riviso plan update — ${plan}`, html);
}
