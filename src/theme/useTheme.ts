import { useState, useEffect } from "react";
export type Theme = "dark" | "light";
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem("logradar-theme") as Theme) || "dark");
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("logradar-theme", theme);
  }, [theme]);
  const toggle = () => setTheme((t) => (t === "dark" ? "light" : "dark"));
  return { theme, toggle };
}
