import { describe, expect, it } from "vitest";
import {
  calculateRates,
  celsiusRateToFahrenheit,
  historyBucketMs,
  historyRange,
  linearRegressionRate,
} from "../src/analytics";

const minute = 60_000;

describe("linearRegressionRate", () => {
  it("calculates a known one-degree-per-minute ramp", () => {
    const rate = linearRegressionRate([
      { observedAtMs: 0, value: 20 },
      { observedAtMs: 5 * minute, value: 25 },
      { observedAtMs: 10 * minute, value: 30 },
    ], 8);
    expect(rate).toBeCloseTo(1, 10);
  });

  it("uses actual irregular timestamps", () => {
    const rate = linearRegressionRate([
      { observedAtMs: 0, value: 20 },
      { observedAtMs: 2 * minute, value: 21 },
      { observedAtMs: 7 * minute, value: 23.5 },
    ], 7);
    expect(rate).toBeCloseTo(0.5, 10);
  });

  it("returns null before three samples or enough span", () => {
    expect(linearRegressionRate([
      { observedAtMs: 0, value: 20 },
      { observedAtMs: 10 * minute, value: 30 },
    ], 8)).toBeNull();
    expect(linearRegressionRate([
      { observedAtMs: 0, value: 20 },
      { observedAtMs: 2 * minute, value: 21 },
      { observedAtMs: 4 * minute, value: 22 },
    ], 8)).toBeNull();
  });

  it("does not add 32 when converting a rate", () => {
    expect(celsiusRateToFahrenheit(2)).toBe(3.6);
  });
});

describe("calculateRates", () => {
  it("keeps the two channels independent", () => {
    const rates = calculateRates([
      { observedAtMs: 0, saunaTempC: null, stovepipeTempC: 20 },
      { observedAtMs: 5 * minute, saunaTempC: null, stovepipeTempC: 30 },
      { observedAtMs: 10 * minute, saunaTempC: null, stovepipeTempC: 40 },
    ], 8, 12 * minute);
    expect(rates.saunaRateCPerMin).toBeNull();
    expect(rates.stovepipeRateCPerMin).toBeCloseTo(2, 10);
  });

  it("drops old samples across a long telemetry gap", () => {
    const rates = calculateRates([
      { observedAtMs: 0, saunaTempC: 20, stovepipeTempC: 20 },
      { observedAtMs: 5 * minute, saunaTempC: 25, stovepipeTempC: 25 },
      { observedAtMs: 30 * minute, saunaTempC: 100, stovepipeTempC: 100 },
    ], 8, 12 * minute);
    expect(rates.saunaRateCPerMin).toBeNull();
  });
});

describe("historyBucketMs", () => {
  it("keeps common views bounded", () => {
    expect(historyBucketMs("1h", 60 * minute, 5 * minute)).toBe(5 * minute);
    expect(historyBucketMs("3h", 3 * 60 * minute, 5 * minute)).toBe(5 * minute);
    expect(historyBucketMs("12h", 12 * 60 * minute, 5 * minute)).toBe(5 * minute);
    expect(historyBucketMs("24h", 24 * 60 * minute, 5 * minute)).toBe(5 * minute);
    expect(historyBucketMs("30d", 30 * 24 * 60 * minute, 5 * minute)).toBe(60 * minute);
  });

  it("recognizes every dashboard range", () => {
    expect(historyRange("1h")).toEqual({ name: "1h", durationMs: 60 * minute });
    expect(historyRange("3h")).toEqual({ name: "3h", durationMs: 3 * 60 * minute });
    expect(historyRange("12h")).toEqual({ name: "12h", durationMs: 12 * 60 * minute });
    expect(historyRange("24h")).toEqual({ name: "24h", durationMs: 24 * 60 * minute });
    expect(historyRange("7d")).toEqual({ name: "7d", durationMs: 7 * 24 * 60 * minute });
    expect(historyRange("30d")).toEqual({ name: "30d", durationMs: 30 * 24 * 60 * minute });
    expect(historyRange("all")).toEqual({ name: "all", durationMs: null });
  });
});
