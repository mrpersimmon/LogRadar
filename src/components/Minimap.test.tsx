// Minimap — the signature "signal trace" minimap. The CRITICAL behavior under
// test: render a vertical baseline strip (`.trace`) with one level-colored
// blip per `levelDistribution` entry, positioned at its relative line
// (`line/totalLines`), plus a teal viewport marker (`.sweep`) at the current
// `[viewportStart, viewportEnd)` range. Ported from the `.trace` element of
// `.superpowers/brainstorm/28981-1783828764/content/premium-redesign.html`
// (baseline + colored blips + scan window), using ③a's premium tokens (no
// hardcoded colors).

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Minimap } from "./Minimap";

describe("Minimap", () => {
  it("renders the trace container with a baseline + TRACE label", () => {
    const { container } = render(
      <Minimap
        levelDistribution={[]}
        viewportStart={0}
        viewportEnd={10}
        totalLines={100}
      />,
    );
    expect(container.querySelector(".trace")).not.toBeNull();
    expect(container.querySelector(".trace-label")?.textContent).toBe("TRACE");
  });

  it("renders a blip per level-distribution entry, colored by level", () => {
    const { container } = render(
      <Minimap
        levelDistribution={[
          { line: 100, level: "err", intensity: 14 },
          { line: 300, level: "warn", intensity: 5 },
          { line: 500, level: "info", intensity: 7 },
        ]}
        viewportStart={200}
        viewportEnd={240}
        totalLines={1000}
      />,
    );
    const blips = container.querySelectorAll(".blip");
    expect(blips.length).toBe(3);
    expect(blips[0].classList.contains("err")).toBe(true);
    expect(blips[1].classList.contains("warn")).toBe(true);
    expect(blips[2].classList.contains("info")).toBe(true);
  });

  it("positions each blip at its relative line (line/totalLines)", () => {
    const { container } = render(
      <Minimap
        levelDistribution={[{ line: 250, level: "err" }]}
        viewportStart={0}
        viewportEnd={40}
        totalLines={1000}
      />,
    );
    const blip = container.querySelector(".blip") as HTMLElement;
    // 250/1000 = 25%
    expect(blip.style.top).toBe("25%");
  });

  it("renders the teal viewport marker (sweep) at the viewport range", () => {
    const { container } = render(
      <Minimap
        levelDistribution={[]}
        viewportStart={200}
        viewportEnd={240}
        totalLines={1000}
      />,
    );
    const sweep = container.querySelector(".sweep") as HTMLElement;
    expect(sweep).not.toBeNull();
    // 200/1000 = 20%
    expect(sweep.style.top).toBe("20%");
    // viewport covers 40/1000 = 4% of the strip
    expect(parseFloat(sweep.style.height)).toBeCloseTo(4, 5);
  });

  it("clamps blip positions to 0..100% when line exceeds totalLines", () => {
    const { container } = render(
      <Minimap
        levelDistribution={[{ line: 2000, level: "err" }]}
        viewportStart={0}
        viewportEnd={10}
        totalLines={1000}
      />,
    );
    const blip = container.querySelector(".blip") as HTMLElement;
    // 2000/1000 = 200% → clamped to 100%
    expect(parseFloat(blip.style.top)).toBeLessThanOrEqual(100);
  });

  it("never divides by zero when totalLines is 0", () => {
    const { container } = render(
      <Minimap
        levelDistribution={[{ line: 5, level: "info" }]}
        viewportStart={0}
        viewportEnd={0}
        totalLines={0}
      />,
    );
    const blip = container.querySelector(".blip") as HTMLElement;
    expect(blip).not.toBeNull();
    expect(parseFloat(blip.style.top)).toBeLessThanOrEqual(100);
  });
});
