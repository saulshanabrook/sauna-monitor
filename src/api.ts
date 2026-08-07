import {
  celsiusRateToFahrenheit,
  celsiusToFahrenheit,
  historyBucketMs,
  historyRange,
  round,
} from "./analytics";
import {
  getCurrentReading,
  getHistory,
  getOldestReadingTime,
  getSessionRows,
  hasOpenSession,
} from "./db";
import type { HistoryAggregateRow, SessionRow } from "./db";
import type { RuntimeConfig } from "./types";

type TemperatureUnit = "c" | "f";

function temperature(value: number | null, unit: TemperatureUnit): number | null {
  if (value === null) return null;
  return round(unit === "f" ? celsiusToFahrenheit(value) : value, 2);
}

function rate(value: number | null, unit: TemperatureUnit): number | null {
  if (value === null) return null;
  return round(unit === "f" ? celsiusRateToFahrenheit(value) : value, 3);
}

function monthParts(date: Date, timeZone: string): { year: number; month: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(date);
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  return { year, month };
}

function monthKeyFromDate(date: Date, timeZone: string): string {
  const { year, month } = monthParts(date, timeZone);
  return `${year}-${String(month).padStart(2, "0")}`;
}

function monthLabel(year: number, month: number): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    year: "numeric",
    month: "short",
  }).format(new Date(Date.UTC(year, month - 1, 15)));
}

function requestedUnit(url: URL): TemperatureUnit {
  return url.searchParams.get("unit")?.toLowerCase() === "c" ? "c" : "f";
}

export async function currentResponse(db: D1Database, config: RuntimeConfig): Promise<unknown> {
  const row = await getCurrentReading(db);
  if (!row) {
    return {
      site_name: config.siteName,
      current: null,
      status: "offline",
      expected_interval_seconds: config.expectedIntervalSeconds,
      stale_after_seconds: config.staleAfterSeconds,
      session_active: false,
    };
  }

  const ageSeconds = Math.max(0, Math.floor((Date.now() - row.observed_at_ms) / 1_000));
  const status = ageSeconds <= config.expectedIntervalSeconds * 2
    ? "live"
    : ageSeconds <= config.staleAfterSeconds
      ? "delayed"
      : "stale";
  return {
    site_name: config.siteName,
    status,
    expected_interval_seconds: config.expectedIntervalSeconds,
    stale_after_seconds: config.staleAfterSeconds,
    session_active: await hasOpenSession(db),
    current: {
      observed_at: new Date(row.observed_at_ms).toISOString(),
      age_seconds: ageSeconds,
      sauna: {
        c: round(row.sauna_temp_c, 2),
        f: temperature(row.sauna_temp_c, "f"),
        rate_c_per_min: round(row.sauna_rate_c_per_min, 3),
        rate_f_per_min: rate(row.sauna_rate_c_per_min, "f"),
      },
      stovepipe: {
        c: round(row.stovepipe_temp_c, 2),
        f: temperature(row.stovepipe_temp_c, "f"),
        rate_c_per_min: round(row.stovepipe_rate_c_per_min, 3),
        rate_f_per_min: rate(row.stovepipe_rate_c_per_min, "f"),
      },
      battery_v: round(row.battery_v, 3),
      signal: {
        rssi_dbm: round(row.rssi_dbm, 1),
        snr_db: round(row.snr_db, 1),
      },
    },
  };
}

interface LongHistoryPoint {
  ts: string;
  series: "Sauna air" | "Stovepipe";
  temp: number;
  temp_min: number;
  temp_max: number;
  rate: number | null;
  segment: number;
}

function historyPoints(
  rows: HistoryAggregateRow[],
  unit: TemperatureUnit,
  maximumGapMs: number,
): LongHistoryPoint[] {
  const output: LongHistoryPoint[] = [];
  const segment = { sauna: 0, stovepipe: 0 };
  const previous = { sauna: null as number | null, stovepipe: null as number | null };

  const add = (
    key: "sauna" | "stovepipe",
    series: "Sauna air" | "Stovepipe",
    row: HistoryAggregateRow,
    averageC: number | null,
    minimumC: number | null,
    maximumC: number | null,
    rateC: number | null,
  ): void => {
    if (averageC === null || minimumC === null || maximumC === null) return;
    if (previous[key] !== null && row.point_ms - previous[key]! > maximumGapMs) segment[key] += 1;
    previous[key] = row.point_ms;
    output.push({
      ts: new Date(row.point_ms).toISOString(),
      series,
      temp: temperature(averageC, unit)!,
      temp_min: temperature(minimumC, unit)!,
      temp_max: temperature(maximumC, unit)!,
      rate: rate(rateC, unit),
      segment: segment[key],
    });
  };

  for (const row of rows) {
    add(
      "sauna", "Sauna air", row,
      row.sauna_avg_c, row.sauna_min_c, row.sauna_max_c, row.sauna_rate_avg_c_per_min,
    );
    add(
      "stovepipe", "Stovepipe", row,
      row.stovepipe_avg_c, row.stovepipe_min_c, row.stovepipe_max_c,
      row.stovepipe_rate_avg_c_per_min,
    );
  }
  return output;
}

export async function historyResponse(
  db: D1Database,
  config: RuntimeConfig,
  url: URL,
): Promise<unknown> {
  const requestedRange = historyRange(url.searchParams.get("range"));
  const now = Date.now();
  const oldest = await getOldestReadingTime(db);
  const fromMs = requestedRange.durationMs === null
    ? oldest ?? now
    : Math.max(oldest ?? now - requestedRange.durationMs, now - requestedRange.durationMs);
  const spanMs = Math.max(0, now - fromMs);
  const bucketMs = historyBucketMs(
    requestedRange.name,
    spanMs,
    config.expectedIntervalSeconds * 1_000,
  );
  const unit = requestedUnit(url);
  const rows = oldest === null ? [] : await getHistory(db, fromMs, now + 1, bucketMs);
  return {
    range: requestedRange.name,
    from: new Date(fromMs).toISOString(),
    to: new Date(now).toISOString(),
    bucket_seconds: bucketMs / 1_000,
    unit,
    temperature_unit: unit === "f" ? "°F" : "°C",
    rate_unit: unit === "f" ? "°F/min" : "°C/min",
    points: historyPoints(
      rows,
      unit,
      Math.max(bucketMs * 2.5, config.expectedIntervalSeconds * 2.5 * 1_000),
    ),
  };
}

interface MonthSummary {
  month: string;
  label: string;
  sessions: number;
  total_hours: number;
  average_duration_minutes: number | null;
  partial: boolean;
  complete_sessions: number;
}

function buildMonthKeys(count: number, timeZone: string): Array<{ key: string; year: number; month: number }> {
  const current = monthParts(new Date(), timeZone);
  const currentIndex = current.year * 12 + current.month - 1;
  const output: Array<{ key: string; year: number; month: number }> = [];
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const index = currentIndex - offset;
    const year = Math.floor(index / 12);
    const month = ((index % 12) + 12) % 12 + 1;
    output.push({ key: `${year}-${String(month).padStart(2, "0")}`, year, month });
  }
  return output;
}

function summarizeSessions(
  rows: SessionRow[],
  count: number,
  timeZone: string,
): MonthSummary[] {
  const months = buildMonthKeys(count, timeZone);
  const currentKey = monthKeyFromDate(new Date(), timeZone);
  const byMonth = new Map<string, SessionRow[]>();
  for (const row of rows) {
    const key = monthKeyFromDate(new Date(row.started_at_ms), timeZone);
    const group = byMonth.get(key) ?? [];
    group.push(row);
    byMonth.set(key, group);
  }
  const now = Date.now();
  return months.map(({ key, year, month }) => {
    const sessions = byMonth.get(key) ?? [];
    const totalMinutes = sessions.reduce((sum, session) => {
      const end = session.ended_at_ms ?? now;
      return sum + Math.max(0, end - session.started_at_ms) / 60_000;
    }, 0);
    return {
      month: key,
      label: monthLabel(year, month),
      sessions: sessions.length,
      total_hours: round(totalMinutes / 60, 1) ?? 0,
      average_duration_minutes: sessions.length > 0 ? round(totalMinutes / sessions.length, 0) : null,
      partial: key === currentKey,
      complete_sessions: sessions.filter((session) => session.complete === 1).length,
    };
  });
}

export async function sessionsResponse(
  db: D1Database,
  config: RuntimeConfig,
  url: URL,
): Promise<unknown> {
  const rawMonths = Number(url.searchParams.get("months") ?? 12);
  const count = Number.isInteger(rawMonths) ? Math.min(36, Math.max(1, rawMonths)) : 12;
  const keys = buildMonthKeys(count, config.reportTimeZone);
  const first = keys[0];
  const sinceMs = first
    ? Date.UTC(first.year, first.month - 1, 1) - 2 * 24 * 60 * 60_000
    : Date.now();
  const rows = await getSessionRows(db, sinceMs);
  return {
    timezone: config.reportTimeZone,
    active: await hasOpenSession(db),
    months: summarizeSessions(rows, count, config.reportTimeZone),
  };
}

