export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  WEBHOOK_PASSWORD?: string;
  WEBHOOK_USERNAME?: string;
  EXPECTED_APPLICATION_ID?: string;
  EXPECTED_DEV_EUI?: string;
  SAUNA_CHANNEL?: string;
  STOVEPIPE_CHANNEL?: string;
  EXPECTED_INTERVAL_SECONDS?: string;
  RATE_WINDOW_MINUTES?: string;
  RATE_MIN_SPAN_MINUTES?: string;
  SESSION_START_PIPE_C?: string;
  SESSION_END_PIPE_C?: string;
  SESSION_END_HOLD_MINUTES?: string;
  REPORT_TIME_ZONE?: string;
  SITE_NAME?: string;
}

export interface ChannelMapping {
  saunaChannel: 1 | 2;
  stovepipeChannel: 1 | 2;
}

export interface NormalizedReading {
  messageKey: string;
  observedAtMs: number;
  receivedAt: string;
  applicationId: string;
  deviceId: string;
  devEui: string | null;
  sessionKeyId: string | null;
  fPort: number | null;
  frameCounter: number | null;
  tempChannel1C: number | null;
  tempChannel2C: number | null;
  saunaTempC: number | null;
  stovepipeTempC: number | null;
  batteryV: number | null;
  rssiDbm: number | null;
  snrDb: number | null;
}

export type ParseResult =
  | { kind: "reading"; reading: NormalizedReading }
  | { kind: "ignored"; reason: string };

export interface RateSample {
  observedAtMs: number;
  saunaTempC: number | null;
  stovepipeTempC: number | null;
}

export interface DetectorState {
  active: boolean;
  updatedAtMs: number | null;
  candidateAtMs: number | null;
  candidateCount: number;
  lastHotAtMs: number | null;
}

export interface DetectorConfig {
  startC: number;
  endC: number;
  endHoldMs: number;
  maxGapMs: number;
  requiredStartSamples: number;
}

export interface DetectorTransition {
  next: DetectorState;
  startAtMs: number | null;
  endAtMs: number | null;
  ignoredOutOfOrder: boolean;
}

export interface RuntimeConfig {
  channels: ChannelMapping;
  expectedIntervalSeconds: number;
  rateWindowMinutes: number;
  rateMinSpanMinutes: number;
  staleAfterSeconds: number;
  session: DetectorConfig;
  reportTimeZone: string;
  siteName: string;
}

