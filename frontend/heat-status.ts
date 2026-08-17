export type ReadingStatus = "live" | "delayed" | "stale" | "offline";

export interface HeatStatusInput {
  currentF: number | null;
  observedAtMs: number;
  nowMs: number;
  rateFPerMin: number | null;
  sessionActive: boolean;
  sourceStatus: ReadingStatus;
  targetF: number;
  timeZone: string;
}

export interface HeatStatus {
  state: "hot" | "eta" | "warming" | "heating" | "cooling" | "idle" | "unavailable";
  headline: string;
  detail: string;
}

const MIN_ETA_RATE_F_PER_MIN = 0.05;
const MIN_COOLING_RATE_F_PER_MIN = 0.02;
const MAX_ETA_MINUTES = 8 * 60;
const ETA_ROUNDING_MINUTES = 5;

function durationLabel(totalMinutes: number): string {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}M`;
  return minutes === 0 ? `${hours}H` : `${hours}H ${minutes}M`;
}

export function projectHeatStatus(input: HeatStatusInput): HeatStatus {
  if (
    input.sourceStatus !== "live" ||
    input.currentF === null ||
    !Number.isFinite(input.currentF) ||
    !Number.isFinite(input.targetF)
  ) {
    return { state: "unavailable", headline: "—", detail: "UNAVAILABLE" };
  }

  if (input.currentF >= input.targetF) {
    return { state: "hot", headline: "HOT", detail: "" };
  }

  if (
    input.rateFPerMin !== null &&
    Number.isFinite(input.rateFPerMin) &&
    input.rateFPerMin >= MIN_ETA_RATE_F_PER_MIN
  ) {
    const minutesFromReading = (input.targetF - input.currentF) / input.rateFPerMin;
    const projectedHotAtMs = input.observedAtMs + minutesFromReading * 60_000;
    const minutesRemaining = (projectedHotAtMs - input.nowMs) / 60_000;
    if (minutesRemaining > 0 && minutesRemaining <= MAX_ETA_MINUTES) {
      const roundedMinutes = Math.max(
        ETA_ROUNDING_MINUTES,
        Math.ceil(minutesRemaining / ETA_ROUNDING_MINUTES) * ETA_ROUNDING_MINUTES,
      );
      const roundingMs = ETA_ROUNDING_MINUTES * 60_000;
      const roundedHotAtMs = Math.ceil(projectedHotAtMs / roundingMs) * roundingMs;
      let hotTime: string;
      try {
        hotTime = new Intl.DateTimeFormat("en-US", {
          timeZone: input.timeZone,
          hour: "numeric",
          minute: "2-digit",
        }).format(new Date(roundedHotAtMs));
      } catch {
        hotTime = new Intl.DateTimeFormat("en-US", {
          hour: "numeric",
          minute: "2-digit",
        }).format(new Date(roundedHotAtMs));
      }
      return {
        state: "eta",
        headline: durationLabel(roundedMinutes),
        detail: hotTime,
      };
    }
  }

  if (input.rateFPerMin !== null && input.rateFPerMin > 0) {
    return { state: "warming", headline: "WARMING", detail: "CALCULATING" };
  }
  if (input.rateFPerMin !== null && input.rateFPerMin < -MIN_COOLING_RATE_F_PER_MIN) {
    return { state: "cooling", headline: "COOLING", detail: "" };
  }
  if (input.sessionActive) {
    return { state: "heating", headline: "HEATING", detail: "CALCULATING" };
  }
  return { state: "idle", headline: "NOT HEATING", detail: "" };
}
