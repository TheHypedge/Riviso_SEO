export type Theme = "light" | "dark";

export const THEME_STORAGE_KEY = "riviso-theme";

export function isTheme(v: unknown): v is Theme {
  return v === "light" || v === "dark";
}

/** Reads the user's persisted choice. Returns null if they've never toggled --
 * the app defaults to light in that case, it does not infer from OS preference
 * (a user's explicit choice, once made, is the only thing that should override
 * the app's own default). */
export function getStoredTheme(): Theme | null {
  if (typeof window === "undefined") return null;
  try {
    const v = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isTheme(v) ? v : null;
  } catch {
    return null;
  }
}

export function setStoredTheme(theme: Theme): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Private-browsing/storage-blocked -- the toggle still works for this
    // tab via React state, it just won't survive a reload. Not fatal.
  }
}

export function applyThemeAttribute(theme: Theme): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", theme);
}

/** Inlined verbatim into layout.tsx's <head> as a blocking script -- must run
 * before first paint so a returning dark-mode user never sees a light flash.
 * Kept in one place so the script text and the runtime helpers above can't
 * drift apart. */
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem("${THEME_STORAGE_KEY}");if(t==="dark")document.documentElement.setAttribute("data-theme","dark");}catch(e){}})();`;
