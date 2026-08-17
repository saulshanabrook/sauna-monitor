import { describe, expect, it } from "vitest";
import { projectHeatStatus, type HeatStatusInput } from "../frontend/heat-status";

const nowMs = Date.parse("2026-08-17T15:40:00Z");
const base: HeatStatusInput = {
  currentF: 120,
  observedAtMs: nowMs,
  nowMs,
  rateFPerMin: 0.4,
  sessionActive: true,
  sourceStatus: "live",
  targetF: 180,
  timeZone: "America/New_York",
};

describe("heat status projection", () => {
  it("shows hot at or above the selected target", () => {
    expect(projectHeatStatus({ ...base, currentF: 180 })).toEqual({
      state: "hot",
      headline: "HOT",
      detail: "",
    });
  });

  it("shows a rounded duration and local target time while heating", () => {
    expect(projectHeatStatus(base)).toEqual({
      state: "eta",
      headline: "2H 30M",
      detail: "2:10 PM",
    });
  });

  it("accounts for time elapsed since the sensor reading", () => {
    expect(projectHeatStatus({ ...base, nowMs: nowMs + 4 * 60_000 })).toEqual({
      state: "eta",
      headline: "2H 30M",
      detail: "2:10 PM",
    });
  });

  it("withholds unstable or distant estimates", () => {
    expect(projectHeatStatus({ ...base, rateFPerMin: 0.01 })).toEqual({
      state: "warming",
      headline: "WARMING",
      detail: "CALCULATING",
    });
    expect(projectHeatStatus({ ...base, currentF: 100, rateFPerMin: 0.1 })).toEqual({
      state: "warming",
      headline: "WARMING",
      detail: "CALCULATING",
    });
  });

  it("distinguishes heating, cooling, idle, and unavailable states", () => {
    expect(projectHeatStatus({ ...base, rateFPerMin: 0 })).toMatchObject({
      state: "heating",
      headline: "HEATING",
    });
    expect(projectHeatStatus({ ...base, rateFPerMin: -0.1 })).toEqual({
      state: "cooling",
      headline: "COOLING",
      detail: "",
    });
    expect(projectHeatStatus({ ...base, rateFPerMin: null, sessionActive: false })).toEqual({
      state: "idle",
      headline: "NOT HEATING",
      detail: "",
    });
    expect(projectHeatStatus({ ...base, sourceStatus: "stale" })).toEqual({
      state: "unavailable",
      headline: "—",
      detail: "UNAVAILABLE",
    });
  });
});
