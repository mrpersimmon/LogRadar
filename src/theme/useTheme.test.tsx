import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useTheme } from "./useTheme";

beforeEach(() => { localStorage.clear(); document.documentElement.removeAttribute("data-theme"); });

describe("useTheme", () => {
  it("defaults to dark and toggles to light (sets data-theme)", () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    act(() => result.current.toggle());
    expect(result.current.theme).toBe("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });
  it("persists to localStorage", () => {
    const { result } = renderHook(() => useTheme());
    act(() => result.current.toggle());
    expect(localStorage.getItem("logradar-theme")).toBe("light");
  });
});
