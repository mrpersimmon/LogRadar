// SyntaxHighlighter — colors a log line's tokens. The CRITICAL behavior under
// test: parse a raw line like `14:22:01 ERROR db refused` into timestamp (dim)
// + level pip + colored level text + message, and wrap each occurrence of a
// hit term in `<mark class="hit">`. Line rendering is ported from the `.ln`
// section of `premium-redesign.html` (ts / lv.err / pip / mark.hit), restyled
// with ③a's premium CSS-variable tokens (no hardcoded colors).

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { SyntaxHighlighter } from "./SyntaxHighlighter";

describe("SyntaxHighlighter", () => {
  it("parses timestamp + level + message and colors each token", () => {
    const { container } = render(
      <SyntaxHighlighter line="14:22:01 ERROR db connection refused" />,
    );
    // timestamp is dim (rendered, in the .ts span)
    expect(container.querySelector(".ts")?.textContent).toBe("14:22:01");
    // level pip + colored level text
    const lv = container.querySelector(".lv.error");
    expect(lv).not.toBeNull();
    expect(lv?.querySelector(".pip")).not.toBeNull();
    expect(lv?.textContent).toContain("ERROR");
    // message remainder
    expect(container.querySelector(".msg")?.textContent).toContain(
      "db connection refused",
    );
  });

  it("highlights the hit term inside the message with mark.hit", () => {
    const { container } = render(
      <SyntaxHighlighter line="14:22:01 ERROR db refused" hits={["refused"]} />,
    );
    const mark = container.querySelector("mark.hit");
    expect(mark).not.toBeNull();
    expect(mark?.textContent).toBe("refused");
  });

  it("colors WARN and INFO by their level class", () => {
    const warn = render(<SyntaxHighlighter line="14:22:02 WARN retry timeout" />);
    expect(warn.container.querySelector(".lv.warn")).not.toBeNull();
    const info = render(<SyntaxHighlighter line="14:22:03 INFO pool ready" />);
    expect(info.container.querySelector(".lv.info")).not.toBeNull();
  });

  it("renders the message only when no timestamp/level is present", () => {
    const { container } = render(<SyntaxHighlighter line="just a message" />);
    expect(container.querySelector(".ts")).toBeNull();
    expect(container.querySelector(".lv")).toBeNull();
    expect(container.querySelector(".msg")?.textContent).toBe("just a message");
  });

  it("highlights multiple hit terms case-insensitively", () => {
    const { container } = render(
      <SyntaxHighlighter
        line="14:22:01 ERROR DB REFUSED timeout"
        hits={["refused", "timeout"]}
      />,
    );
    const marks = Array.from(container.querySelectorAll("mark.hit"));
    expect(marks.length).toBe(2);
    const texts = marks.map((m) => m.textContent);
    expect(texts).toContain("REFUSED");
    expect(texts).toContain("timeout");
  });
});
