import type {
  DetectorConfig,
  DetectorState,
  DetectorTransition,
  RateSample,
} from "./types";

export function celsiusToFahrenheit(value: number): number {
  return value * 1.8 + 32;
}

export function celsiusRateToFahrenheit(value: number): number {
  return value * 1.8;
}

export function round(value: number | null, digits = 2): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

export function linearRegressionRate(
  samples: Array<{ observedAtMs: number; value: number | null }>,
  minimumSpanMinutes: number,
): number | null {
  const points = samples
    .filter((sample): sample is { observedAtMs: number; value: number } =>
      Number.isFinite(sample.observedAtMs) && sample.value !== null && Number.isFinite(sample.value),
    )
    .sort((left, right) => left.observedAtMs - right.observedAtMs);
  if (points.length < 3) return null;

  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return null;
  const spanMinutes = (last.observedAtMs - first.observedAtMs) / 60_000;
  if (spanMinutes < minimumSpanMinutes) return null;

  const xs = points.map((point) => (point.observedAtMs - last.observedAtMs) / 60_000);
  const meanX = xs.reduce((sum, value) => sum + value, 0) / xs.length;
  const meanY = points.reduce((sum, point) => sum + point.value, 0) / points.length;
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    const x = xs[index];
    if (!point || x === undefined) continue;
    numerator += (x - meanX) * (point.value - meanY);
    denominator += (x - meanX) ** 2;
  }
  return denominator > 0 ? numerator / denominator : null;
}

function contiguousSuffix(samples: RateSample[], maximumGapMs: number): RateSample[] {
  const sorted = [...samples].sort((left, right) => left.observedAtMs - right.observedAtMs);
  if (sorted.length < 2) return sorted;
  let start = sorted.length - 1;
  while (start > 0) {
    const current = sorted[start];
    const previous = sorted[start - 1];
    if (!current || !previous || current.observedAtMs - previous.observedAtMs > maximumGapMs) break;
    start -= 1;
  }
  return sorted.slice(start);
}

export function calculateRates(
  samples: RateSample[],
  minimumSpanMinutes: number,
  maximumGapMs: number,
): { saunaRateCPerMin: number | null; stovepipeRateCPerMin: number | null } {
  const contiguous = contiguousSuffix(samples, maximumGapMs);
  return {
    saunaRateCPerMin: linearRegressionRate(
      contiguous.map((sample) => ({ observedAtMs: sample.observedAtMs, value: sample.saunaTempC })),
      minimumSpanMinutes,
    ),
    stovepipeRateCPerMin: linearRegressionRate(
      contiguous.map((sample) => ({ observedAtMs: sample.observedAtMs, value: sample.stovepipeTempC })),
      minimumSpanMinutes,
    ),
  };
}

export function advanceDetector(
  state: DetectorState,
  observedAtMs: number,
  stovepipeTempC: number | null,
  config: DetectorConfig,
): DetectorTransition {
  if (state.updatedAtMs !== null && observedAtMs <= state.updatedAtMs) {
    return { next: state, startAtMs: null, endAtMs: null, ignoredOutOfOrder: true };
  }

  if (state.active) {
    let lastHotAtMs = state.lastHotAtMs;
    if (stovepipeTempC !== null && stovepipeTempC >= config.endC) {
      lastHotAtMs = observedAtMs;
    }
    const shouldEnd =
      stovepipeTempC !== null &&
      stovepipeTempC < config.endC &&
      lastHotAtMs !== null &&
      observedAtMs - lastHotAtMs >= config.endHoldMs;
    return {
      next: {
        active: !shouldEnd,
        updatedAtMs: observedAtMs,
        candidateAtMs: null,
        candidateCount: 0,
        lastHotAtMs: shouldEnd ? null : lastHotAtMs,
      },
      startAtMs: null,
      endAtMs: shouldEnd ? lastHotAtMs : null,
      ignoredOutOfOrder: false,
    };
  }

  if (stovepipeTempC === null || stovepipeTempC < config.startC) {
    return {
      next: {
        active: false,
        updatedAtMs: observedAtMs,
        candidateAtMs: null,
        candidateCount: 0,
        lastHotAtMs: null,
      },
      startAtMs: null,
      endAtMs: null,
      ignoredOutOfOrder: false,
    };
  }

  const continuesCandidate =
    state.candidateAtMs !== null &&
    state.updatedAtMs !== null &&
    observedAtMs - state.updatedAtMs <= config.maxGapMs;
  const candidateAtMs = continuesCandidate ? state.candidateAtMs : observedAtMs;
  const candidateCount = continuesCandidate ? state.candidateCount + 1 : 1;
  const starts = candidateCount >= config.requiredStartSamples;
  return {
    next: {
      active: starts,
      updatedAtMs: observedAtMs,
      candidateAtMs: starts ? null : candidateAtMs,
      candidateCount: starts ? 0 : candidateCount,
      lastHotAtMs: starts ? observedAtMs : null,
    },
    startAtMs: starts ? candidateAtMs : null,
    endAtMs: null,
    ignoredOutOfOrder: false,
  };
}

const RANGE_MILLISECONDS: Record<string, number | null> = {
  "1h": 60 * 60_000,
  "3h": 3 * 60 * 60_000,
  "12h": 12 * 60 * 60_000,
  "24h": 24 * 60 * 60_000,
  "7d": 7 * 24 * 60 * 60_000,
  "30d": 30 * 24 * 60 * 60_000,
  all: null,
};

const NICE_BUCKETS_MS = [
  5 * 60_000,
  15 * 60_000,
  60 * 60_000,
  3 * 60 * 60_000,
  6 * 60 * 60_000,
  12 * 60 * 60_000,
  24 * 60 * 60_000,
  7 * 24 * 60 * 60_000,
];

export function historyRange(value: string | null): { name: string; durationMs: number | null } {
  const name = value && Object.hasOwn(RANGE_MILLISECONDS, value) ? value : "24h";
  return { name, durationMs: RANGE_MILLISECONDS[name] ?? null };
}

export function historyBucketMs(rangeName: string, spanMs: number, expectedIntervalMs: number): number {
  const prescribed: Record<string, number> = {
    "1h": expectedIntervalMs,
    "3h": expectedIntervalMs,
    "12h": expectedIntervalMs,
    "24h": expectedIntervalMs,
    "7d": 15 * 60_000,
    "30d": 60 * 60_000,
  };
  if (rangeName !== "all") return Math.max(expectedIntervalMs, prescribed[rangeName] ?? expectedIntervalMs);
  const minimumBucket = Math.max(expectedIntervalMs, Math.ceil(spanMs / 1_500));
  return NICE_BUCKETS_MS.find((bucket) => bucket >= minimumBucket) ?? NICE_BUCKETS_MS.at(-1)!;
}
