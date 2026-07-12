// Recents store (Task 3 ④a) — the most-recently-opened log file paths persist to
// localStorage under `logradar-recents` as a JSON string array. `addRecent`
// prepends (most-recent-first), dedupes (removes any prior occurrence), and caps
// at 20. `getRecents` reads them back and must be defensive: a missing key,
// malformed JSON, a non-array payload, or non-string entries all collapse to
// `[]` rather than throwing — localStorage is user-tamperable, so the store
// never lets a corrupt entry crash the WelcomePage mount that reads it.

import { describe, it, expect, beforeEach } from "vitest";
import { getRecents, addRecent } from "./recents";

beforeEach(() => {
  localStorage.clear();
});

describe("getRecents", () => {
  it("returns [] when nothing is stored", () => {
    expect(getRecents()).toEqual([]);
  });

  it("returns the stored paths in stored order", () => {
    localStorage.setItem("logradar-recents", JSON.stringify(["a.log", "b.log"]));
    expect(getRecents()).toEqual(["a.log", "b.log"]);
  });

  it("returns [] for malformed JSON", () => {
    localStorage.setItem("logradar-recents", "{not json");
    expect(getRecents()).toEqual([]);
  });

  it("returns [] for a non-array payload", () => {
    localStorage.setItem("logradar-recents", JSON.stringify({ path: "x" }));
    expect(getRecents()).toEqual([]);
  });

  it("filters out non-string entries", () => {
    localStorage.setItem(
      "logradar-recents",
      JSON.stringify(["a.log", 7, null, "b.log", true]),
    );
    expect(getRecents()).toEqual(["a.log", "b.log"]);
  });
});

describe("addRecent", () => {
  it("adds a new path to the front (most-recent-first)", () => {
    addRecent("a.log");
    addRecent("b.log");
    expect(getRecents()).toEqual(["b.log", "a.log"]);
  });

  it("dedupes — re-adding a path moves it to the front, no duplicates", () => {
    addRecent("a.log");
    addRecent("b.log");
    addRecent("c.log");
    // re-add b.log → bumps to front; a.log + c.log shift down, no dup
    addRecent("b.log");
    expect(getRecents()).toEqual(["b.log", "c.log", "a.log"]);
    expect(getRecents().filter((p) => p === "b.log")).toHaveLength(1);
  });

  it("caps the list at 20 (oldest beyond cap dropped)", () => {
    for (let i = 0; i < 25; i++) addRecent(`f${i}.log`);
    const recents = getRecents();
    expect(recents).toHaveLength(20);
    // most-recent-first → f24 (last added) is at the front
    expect(recents[0]).toBe("f24.log");
    // f0..f4 are the 5 oldest beyond the cap → dropped; f5 is the oldest kept
    expect(recents[19]).toBe("f5.log");
    expect(recents).not.toContain("f0.log");
    expect(recents).not.toContain("f4.log");
    expect(recents).toContain("f5.log");
  });

  it("persists across reads (writes to localStorage)", () => {
    addRecent("only.log");
    // A fresh read (simulating a new mount) sees the persisted value
    expect(getRecents()).toEqual(["only.log"]);
    expect(JSON.parse(localStorage.getItem("logradar-recents")!)).toEqual([
      "only.log",
    ]);
  });
});
