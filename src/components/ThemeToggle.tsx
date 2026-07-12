import { useTheme } from "../theme/useTheme";
export function ThemeToggle() {
  const { theme, toggle } = useTheme();
  return (
    <button className="theme-toggle" onClick={toggle} aria-label="Toggle theme">
      {theme === "dark" ? "🌙" : "☀️"} {theme === "dark" ? "Dark" : "Light"}
    </button>
  );
}
