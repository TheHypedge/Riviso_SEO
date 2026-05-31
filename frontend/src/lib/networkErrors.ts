import { ApiError } from "@/lib/api";

/** True when the browser could not complete the request (offline, DNS, refused connection, etc.). */
export function isNetworkError(e: unknown): boolean {
  if (e instanceof ApiError && e.status === 0) return true;
  if (!(e instanceof Error)) return false;
  const msg = e.message.toLowerCase();
  return (
    msg.includes("failed to fetch") ||
    msg.includes("networkerror") ||
    msg.includes("network error") ||
    msg.includes("load failed") ||
    msg.includes("could not reach the server") ||
    (e.name === "TypeError" && msg.includes("fetch"))
  );
}

export function isAuthError(e: unknown): boolean {
  return e instanceof ApiError && (e.status === 401 || e.status === 403);
}

export function isDatabaseUnavailable(e: unknown): boolean {
  if (!(e instanceof ApiError) || e.status !== 503) return false;
  const detail = e.detail;
  if (detail && typeof detail === "object" && "code" in detail) {
    return (detail as { code?: unknown }).code === "database_unavailable";
  }
  return true;
}

export function connectionErrorMessage(e: unknown): string {
  if (isNetworkError(e)) {
    return "Could not reach the Riviso API. Check your Wi‑Fi, then confirm the backend is running (local: port 8000).";
  }
  if (isDatabaseUnavailable(e)) {
    return "Database is temporarily unavailable. Check your internet connection, wait a few seconds, then try again.";
  }
  if (e instanceof ApiError && e.status === 408) {
    return e.message;
  }
  if (e instanceof Error) {
    const msg = e.message.trim();
    if (/signal timed out|timeout/i.test(msg)) {
      return "Request timed out. The server may still be working — wait a moment and try again.";
    }
    if (msg) return msg;
  }
  return "Request failed. Try again.";
}
