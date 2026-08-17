import { describe, expect, it } from "vitest";
import { initialDashboardSnapshot } from "../src/page";
import type { CurrentReadingRow } from "../src/db";

const reading: CurrentReadingRow = {
  observed_at_ms: Date.parse("2026-08-17T18:00:00.000Z"),
  received_at: "2026-08-17T18:00:00.000Z",
  sauna_temp_c: 54.72,
  stovepipe_temp_c: 259.11,
  sauna_rate_c_per_min: 0.1,
  stovepipe_rate_c_per_min: 0.2,
  battery_v: 3.6,
  rssi_dbm: -75,
  snr_db: 10,
};

describe("initial dashboard snapshot", () => {
  it("projects the latest reading into whole-degree Fahrenheit values", () => {
    expect(initialDashboardSnapshot(reading)).toEqual({
      observedAt: "2026-08-17T18:00:00.000Z",
      saunaF: "131",
      stovepipeF: "498",
    });
  });

  it("keeps a missing probe readable without inventing a value", () => {
    expect(initialDashboardSnapshot({ ...reading, sauna_temp_c: null })).toEqual({
      observedAt: "2026-08-17T18:00:00.000Z",
      saunaF: "—",
      stovepipeF: "498",
    });
  });

  it("returns no snapshot when the database has no reading", () => {
    expect(initialDashboardSnapshot(null)).toBeNull();
  });
});
