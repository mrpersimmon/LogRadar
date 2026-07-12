import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useView, type View } from "./router";

describe("useView", () => {
  it("defaults to 'welcome'", () => {
    const { result } = renderHook(() => useView());
    expect(result.current.view).toBe("welcome");
  });

  it("setView updates the current view", () => {
    const { result } = renderHook(() => useView());
    act(() => result.current.setView("main"));
    expect(result.current.view).toBe("main");
  });

  it("transitions through the full view state machine", () => {
    const { result } = renderHook(() => useView());
    const transitions: View[] = ["split", "export", "workspace", "welcome"];
    for (const v of transitions) {
      act(() => result.current.setView(v));
      expect(result.current.view).toBe(v);
    }
  });

  it("keeps a stable setView identity across renders", () => {
    const { result, rerender } = renderHook(() => useView());
    const first = result.current.setView;
    rerender();
    expect(result.current.setView).toBe(first);
  });
});
