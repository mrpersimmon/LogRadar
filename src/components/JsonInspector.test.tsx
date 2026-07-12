// JsonInspector — inline JSON tree expand. The CRITICAL behavior under test:
// parse a JSON log line into an expandable field tree (keys blue / strings teal
// / numbers amber / type tags faint / ▾▸ fold), and highlight search-hit terms
// inside the JSON string values. Tree rendering is ported from the `.jtree`
// section of `.superpowers/brainstorm/28981-1783828764/content/json-inspector.html`
// (braces / k / col / s / n / typ / twist / collapsed / mark.jhit), restyled
// with ③a's premium CSS-variable tokens (no hardcoded colors).

import { describe, it, expect } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { JsonInspector } from "./JsonInspector";

// The brief's canonical line: top-level string + string + nested object{id:number}.
const LINE = '{"event":"db_error","code":"ECONNREFUSED","user":{"id":42}}';

describe("JsonInspector", () => {
  it("parses the JSON line and renders the .jtree field tree", () => {
    const { container } = render(<JsonInspector line={LINE} />);
    expect(container.querySelector(".jtree")).not.toBeNull();
    const text = container.querySelector(".jtree")!.textContent ?? "";
    // top-level keys + values render (root expanded by default)
    expect(text).toContain("event");
    expect(text).toContain("db_error");
    expect(text).toContain("code");
    expect(text).toContain("ECONNREFUSED");
    expect(text).toContain("user");
  });

  it("colors keys (.k/info) and string values (.s/scan)", () => {
    const { container } = render(<JsonInspector line={LINE} />);
    const keys = Array.from(container.querySelectorAll(".k"));
    expect(keys.some((el) => el.textContent === "event")).toBe(true);
    const strs = Array.from(container.querySelectorAll(".s"));
    expect(strs.some((el) => el.textContent?.includes("db_error"))).toBe(true);
  });

  it("highlights the hit term within a JSON string value (mark.jhit)", () => {
    const { container } = render(<JsonInspector line={LINE} hits={["refused"]} />);
    const mark = container.querySelector("mark.jhit");
    expect(mark).not.toBeNull();
    // ECONNREFUSED contains "REFUSED" -> the matching substring is highlighted
    expect(mark!.textContent?.toLowerCase()).toContain("refused");
  });

  it("expands a nested object on click to reveal id: 42 (number colored .n)", () => {
    const { container } = render(<JsonInspector line={LINE} />);
    const jtree = container.querySelector(".jtree")!;
    // user is a nested object -> collapsed by default; id/42 NOT yet rendered
    expect(jtree.textContent).toContain("user");
    expect(jtree.textContent).not.toContain("42");
    // click the user twist to expand
    const twist = container.querySelector('[data-key="user"]') as HTMLElement;
    expect(twist).not.toBeNull();
    fireEvent.click(twist);
    // now id + 42 are visible; 42 is colored as a number (.n), id as a key (.k)
    const after = container.querySelector(".jtree")!.textContent ?? "";
    expect(after).toContain("id");
    expect(after).toContain("42");
    expect(
      Array.from(container.querySelectorAll(".n")).some(
        (el) => el.textContent === "42",
      ),
    ).toBe(true);
    expect(
      Array.from(container.querySelectorAll(".k")).some(
        (el) => el.textContent === "id",
      ),
    ).toBe(true);
  });

  it("renders non-JSON lines as plain text without crashing", () => {
    const { container } = render(<JsonInspector line="not json at all {{" />);
    expect(container.querySelector(".jtree")).toBeNull();
    expect(container.textContent).toContain("not json at all");
  });
});
