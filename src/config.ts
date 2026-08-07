import type { ChannelMapping, DetectorConfig, Env, RuntimeConfig } from "./types";

function finitePositive(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function channel(value: string | undefined, fallback: 1 | 2): 1 | 2 {
  return value === "1" || value === "2" ? Number(value) as 1 | 2 : fallback;
}

export function normalizeEui(value: string | undefined | null): string | null {
  if (!value) return null;
  const normalized = value.replace(/[^a-fA-F0-9]/g, "").toUpperCase();
  return normalized.length > 0 ? normalized : null;
}

export function getRuntimeConfig(env: Env): RuntimeConfig {
  const saunaChannel = channel(env.SAUNA_CHANNEL, 1);
  const stovepipeChannel = channel(env.STOVEPIPE_CHANNEL, 2);
  if (saunaChannel === stovepipeChannel) {
    throw new Error("SAUNA_CHANNEL and STOVEPIPE_CHANNEL must be different");
  }

  const expectedIntervalSeconds = finitePositive(env.EXPECTED_INTERVAL_SECONDS, 300);
  const rateWindowMinutes = finitePositive(env.RATE_WINDOW_MINUTES, 15);
  const rateMinSpanMinutes = Math.min(
    rateWindowMinutes,
    finitePositive(env.RATE_MIN_SPAN_MINUTES, 8),
  );
  const staleAfterSeconds = Math.max(expectedIntervalSeconds * 4, 1_200);
  const startC = finitePositive(env.SESSION_START_PIPE_C, 75);
  const endC = finitePositive(env.SESSION_END_PIPE_C, 50);
  if (endC >= startC) {
    throw new Error("SESSION_END_PIPE_C must be lower than SESSION_START_PIPE_C");
  }

  const channels: ChannelMapping = { saunaChannel, stovepipeChannel };
  const session: DetectorConfig = {
    startC,
    endC,
    endHoldMs: finitePositive(env.SESSION_END_HOLD_MINUTES, 45) * 60_000,
    maxGapMs: expectedIntervalSeconds * 2.5 * 1_000,
    requiredStartSamples: 2,
  };

  return {
    channels,
    expectedIntervalSeconds,
    rateWindowMinutes,
    rateMinSpanMinutes,
    staleAfterSeconds,
    session,
    reportTimeZone: env.REPORT_TIME_ZONE || "America/New_York",
    siteName: env.SITE_NAME || "Sauna Monitor",
  };
}

