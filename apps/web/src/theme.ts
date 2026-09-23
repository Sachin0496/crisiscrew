export type Theme = "light" | "dark";

const KEY = "crisiscrew.theme";

/** The viewer's saved choice; light unless they switched. */
export function storedTheme(): Theme {
  try {
    return localStorage.getItem(KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* storage can be blocked (private windows); the theme still applies for this visit */
  }
}
