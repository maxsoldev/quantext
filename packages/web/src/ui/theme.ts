/** Light (the projector theme), dark, or the OS setting; kept in localStorage and stamped on <html>. */
export type Theme = "light" | "dark" | "system";

const KEY = "quantext.theme";

export function savedTheme(): Theme {
  const t = localStorage.getItem(KEY);
  return t === "light" || t === "dark" ? t : "system";
}

export function applyTheme(theme: Theme): void {
  if (theme === "system") {
    delete document.documentElement.dataset.theme;
    localStorage.removeItem(KEY);
  } else {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(KEY, theme);
  }
}
