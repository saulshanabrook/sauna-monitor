import { describe, expect, it } from "vitest";
import { canApplyObservedAt } from "../frontend/current-reading";

describe("current reading freshness", () => {
  const initial = "2026-08-17T18:00:00.000Z";

  it("accepts the first API result and readings at least as recent as the HTML", () => {
    expect(canApplyObservedAt(null, null)).toBe(true);
    expect(canApplyObservedAt(initial, initial)).toBe(true);
    expect(canApplyObservedAt(initial, "2026-08-17T18:05:00.000Z")).toBe(true);
  });

  it("preserves the embedded reading when the API is empty, invalid, or older", () => {
    expect(canApplyObservedAt(initial, null)).toBe(false);
    expect(canApplyObservedAt(initial, "not-a-timestamp")).toBe(false);
    expect(canApplyObservedAt(initial, "2026-08-17T17:55:00.000Z")).toBe(false);
  });
});
