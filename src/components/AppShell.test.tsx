import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { AppShell } from "./AppShell";

describe("AppShell", () => {
  it("renders the brand wordmark + theme toggle + children", () => {
    render(<AppShell><p>page content</p></AppShell>);
    expect(screen.getByText("LogRadar")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Toggle theme" })).toBeTruthy();
    expect(screen.getByText("page content")).toBeTruthy();
  });
});
