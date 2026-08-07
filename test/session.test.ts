import { describe, expect, it } from "vitest";
import { advanceDetector } from "../src/analytics";
import type { DetectorConfig, DetectorState } from "../src/types";

const minute = 60_000;
const config: DetectorConfig = {
  startC: 75,
  endC: 50,
  endHoldMs: 45 * minute,
  maxGapMs: 12.5 * minute,
  requiredStartSamples: 2,
};

function idle(): DetectorState {
  return {
    active: false,
    updatedAtMs: null,
    candidateAtMs: null,
    candidateCount: 0,
    lastHotAtMs: null,
  };
}

describe("advanceDetector", () => {
  it("requires two consecutive hot readings", () => {
    const first = advanceDetector(idle(), 0, 80, config);
    expect(first.startAtMs).toBeNull();
    expect(first.next.candidateCount).toBe(1);
    const second = advanceDetector(first.next, 5 * minute, 95, config);
    expect(second.startAtMs).toBe(0);
    expect(second.next.active).toBe(true);
  });

  it("does not bridge a long gap between start candidates", () => {
    const first = advanceDetector(idle(), 0, 80, config);
    const second = advanceDetector(first.next, 20 * minute, 95, config);
    expect(second.startAtMs).toBeNull();
    expect(second.next.candidateAtMs).toBe(20 * minute);
  });

  it("uses hysteresis and a cooldown before ending", () => {
    const active: DetectorState = {
      active: true,
      updatedAtMs: 10 * minute,
      candidateAtMs: null,
      candidateCount: 0,
      lastHotAtMs: 10 * minute,
    };
    const briefDip = advanceDetector(active, 30 * minute, 45, config);
    expect(briefDip.next.active).toBe(true);
    expect(briefDip.endAtMs).toBeNull();
    const cooled = advanceDetector(briefDip.next, 60 * minute, 40, config);
    expect(cooled.next.active).toBe(false);
    expect(cooled.endAtMs).toBe(10 * minute);
  });

  it("ignores out-of-order readings for detector state", () => {
    const state = { ...idle(), updatedAtMs: 10 * minute };
    const result = advanceDetector(state, 5 * minute, 100, config);
    expect(result.ignoredOutOfOrder).toBe(true);
    expect(result.next).toBe(state);
  });
});
