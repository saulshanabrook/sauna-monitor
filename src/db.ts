import { advanceDetector, calculateRates } from "./analytics";
import type { NormalizedReading, RateSample, RuntimeConfig } from "./types";

export interface CurrentReadingRow {
  observed_at_ms: number;
  received_at: string;
  sauna_temp_c: number | null;
  stovepipe_temp_c: number | null;
  sauna_rate_c_per_min: number | null;
  stovepipe_rate_c_per_min: number | null;
  battery_v: number | null;
  rssi_dbm: number | null;
  snr_db: number | null;
}

export interface HistoryAggregateRow {
  bucket_ms: number;
  point_ms: number;
  sauna_avg_c: number | null;
  sauna_min_c: number | null;
  sauna_max_c: number | null;
  stovepipe_avg_c: number | null;
  stovepipe_min_c: number | null;
  stovepipe_max_c: number | null;
  sauna_rate_avg_c_per_min: number | null;
  stovepipe_rate_avg_c_per_min: number | null;
}

export interface SessionRow {
  id: number;
  started_at_ms: number;
  ended_at_ms: number | null;
  peak_sauna_c: number | null;
  peak_stovepipe_c: number | null;
  max_stovepipe_rate_c_per_min: number | null;
  sample_count: number;
  complete: number;
}

interface DetectorStateRow {
  updated_at_ms: number;
  start_candidate_at_ms: number | null;
  start_candidate_count: number;
  open_session_id: number | null;
}

interface OpenSessionRow {
  id: number;
  last_hot_at_ms: number;
}

function bindable(value: number | string | null | undefined): number | string | null {
  return value === undefined ? null : value;
}

export async function insertReading(db: D1Database, reading: NormalizedReading): Promise<boolean> {
  const result = await db.prepare(`
    INSERT INTO readings (
      message_key, observed_at_ms, received_at, inserted_at_ms,
      application_id, device_id, dev_eui, session_key_id, f_port, frame_counter,
      temp_channel_1_c, temp_channel_2_c, sauna_temp_c, stovepipe_temp_c,
      battery_v, rssi_dbm, snr_db
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(message_key) DO NOTHING
  `).bind(
    reading.messageKey,
    reading.observedAtMs,
    reading.receivedAt,
    Date.now(),
    reading.applicationId,
    reading.deviceId,
    bindable(reading.devEui),
    bindable(reading.sessionKeyId),
    bindable(reading.fPort),
    bindable(reading.frameCounter),
    bindable(reading.tempChannel1C),
    bindable(reading.tempChannel2C),
    bindable(reading.saunaTempC),
    bindable(reading.stovepipeTempC),
    bindable(reading.batteryV),
    bindable(reading.rssiDbm),
    bindable(reading.snrDb),
  ).run();
  return Number(result.meta.changes ?? 0) > 0;
}

async function calculateAndStoreRates(
  db: D1Database,
  reading: NormalizedReading,
  config: RuntimeConfig,
): Promise<{ saunaRateCPerMin: number | null; stovepipeRateCPerMin: number | null }> {
  const windowStart = reading.observedAtMs - config.rateWindowMinutes * 60_000;
  const result = await db.prepare(`
    SELECT observed_at_ms, sauna_temp_c, stovepipe_temp_c
    FROM readings
    WHERE device_id = ? AND observed_at_ms BETWEEN ? AND ?
    ORDER BY observed_at_ms ASC
  `).bind(reading.deviceId, windowStart, reading.observedAtMs).all<{
    observed_at_ms: number;
    sauna_temp_c: number | null;
    stovepipe_temp_c: number | null;
  }>();
  const samples: RateSample[] = result.results.map((row) => ({
    observedAtMs: row.observed_at_ms,
    saunaTempC: row.sauna_temp_c,
    stovepipeTempC: row.stovepipe_temp_c,
  }));
  const rates = calculateRates(
    samples,
    config.rateMinSpanMinutes,
    config.expectedIntervalSeconds * 2.5 * 1_000,
  );
  await db.prepare(`
    UPDATE readings
    SET sauna_rate_c_per_min = ?, stovepipe_rate_c_per_min = ?
    WHERE message_key = ?
  `).bind(
    bindable(rates.saunaRateCPerMin),
    bindable(rates.stovepipeRateCPerMin),
    reading.messageKey,
  ).run();
  return rates;
}

async function getOpenSession(db: D1Database, deviceId: string): Promise<OpenSessionRow | null> {
  return db.prepare(`
    SELECT id, last_hot_at_ms
    FROM sessions
    WHERE device_id = ? AND ended_at_ms IS NULL
    ORDER BY id DESC
    LIMIT 1
  `).bind(deviceId).first<OpenSessionRow>();
}

async function updateSessionMetrics(
  db: D1Database,
  sessionId: number,
  reading: NormalizedReading,
  stovepipeRateCPerMin: number | null,
  lastHotAtMs: number | null,
  endAtMs: number | null,
): Promise<void> {
  await db.prepare(`
    UPDATE sessions
    SET
      peak_sauna_c = CASE
        WHEN ? IS NULL THEN peak_sauna_c
        WHEN peak_sauna_c IS NULL OR ? > peak_sauna_c THEN ?
        ELSE peak_sauna_c
      END,
      peak_stovepipe_c = CASE
        WHEN ? IS NULL THEN peak_stovepipe_c
        WHEN peak_stovepipe_c IS NULL OR ? > peak_stovepipe_c THEN ?
        ELSE peak_stovepipe_c
      END,
      max_stovepipe_rate_c_per_min = CASE
        WHEN ? IS NULL THEN max_stovepipe_rate_c_per_min
        WHEN max_stovepipe_rate_c_per_min IS NULL OR ? > max_stovepipe_rate_c_per_min THEN ?
        ELSE max_stovepipe_rate_c_per_min
      END,
      last_hot_at_ms = COALESCE(?, last_hot_at_ms),
      ended_at_ms = COALESCE(?, ended_at_ms),
      complete = CASE WHEN ? IS NULL THEN complete ELSE 1 END,
      sample_count = sample_count + 1
    WHERE id = ?
  `).bind(
    bindable(reading.saunaTempC), bindable(reading.saunaTempC), bindable(reading.saunaTempC),
    bindable(reading.stovepipeTempC), bindable(reading.stovepipeTempC), bindable(reading.stovepipeTempC),
    bindable(stovepipeRateCPerMin), bindable(stovepipeRateCPerMin), bindable(stovepipeRateCPerMin),
    bindable(lastHotAtMs), bindable(endAtMs), bindable(endAtMs), sessionId,
  ).run();
}

async function updateSessionDetector(
  db: D1Database,
  reading: NormalizedReading,
  stovepipeRateCPerMin: number | null,
  config: RuntimeConfig,
): Promise<void> {
  const stateRow = await db.prepare(`
    SELECT updated_at_ms, start_candidate_at_ms, start_candidate_count, open_session_id
    FROM detector_state
    WHERE device_id = ?
  `).bind(reading.deviceId).first<DetectorStateRow>();
  let openSession = await getOpenSession(db, reading.deviceId);
  const openSessionId = stateRow?.open_session_id ?? openSession?.id ?? null;
  if (openSessionId !== null && openSession?.id !== openSessionId) {
    openSession = await db.prepare(`
      SELECT id, last_hot_at_ms FROM sessions WHERE id = ? AND ended_at_ms IS NULL
    `).bind(openSessionId).first<OpenSessionRow>();
  }

  const transition = advanceDetector(
    {
      active: openSession !== null,
      updatedAtMs: stateRow?.updated_at_ms ?? null,
      candidateAtMs: stateRow?.start_candidate_at_ms ?? null,
      candidateCount: stateRow?.start_candidate_count ?? 0,
      lastHotAtMs: openSession?.last_hot_at_ms ?? null,
    },
    reading.observedAtMs,
    reading.stovepipeTempC,
    config.session,
  );
  if (transition.ignoredOutOfOrder) return;

  let nextOpenSessionId = openSession?.id ?? null;
  if (transition.startAtMs !== null) {
    const peaks = await db.prepare(`
      SELECT
        MAX(sauna_temp_c) AS peak_sauna_c,
        MAX(stovepipe_temp_c) AS peak_stovepipe_c,
        MAX(stovepipe_rate_c_per_min) AS max_rate,
        COUNT(*) AS sample_count
      FROM readings
      WHERE device_id = ? AND observed_at_ms BETWEEN ? AND ?
    `).bind(reading.deviceId, transition.startAtMs, reading.observedAtMs).first<{
      peak_sauna_c: number | null;
      peak_stovepipe_c: number | null;
      max_rate: number | null;
      sample_count: number;
    }>();
    const created = await db.prepare(`
      INSERT INTO sessions (
        device_id, started_at_ms, last_hot_at_ms,
        peak_sauna_c, peak_stovepipe_c, max_stovepipe_rate_c_per_min, sample_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      RETURNING id
    `).bind(
      reading.deviceId,
      transition.startAtMs,
      transition.next.lastHotAtMs ?? reading.observedAtMs,
      bindable(peaks?.peak_sauna_c),
      bindable(peaks?.peak_stovepipe_c),
      bindable(peaks?.max_rate),
      peaks?.sample_count ?? config.session.requiredStartSamples,
    ).first<{ id: number }>();
    nextOpenSessionId = created?.id ?? null;
  } else if (openSession) {
    await updateSessionMetrics(
      db,
      openSession.id,
      reading,
      stovepipeRateCPerMin,
      transition.next.lastHotAtMs,
      transition.endAtMs,
    );
    if (transition.endAtMs !== null) nextOpenSessionId = null;
  }

  await db.prepare(`
    INSERT INTO detector_state (
      device_id, updated_at_ms, start_candidate_at_ms, start_candidate_count, open_session_id
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(device_id) DO UPDATE SET
      updated_at_ms = excluded.updated_at_ms,
      start_candidate_at_ms = excluded.start_candidate_at_ms,
      start_candidate_count = excluded.start_candidate_count,
      open_session_id = excluded.open_session_id
  `).bind(
    reading.deviceId,
    transition.next.updatedAtMs ?? reading.observedAtMs,
    bindable(transition.next.candidateAtMs),
    transition.next.candidateCount,
    bindable(transition.next.active ? nextOpenSessionId : null),
  ).run();
}

export async function processDerivedData(
  db: D1Database,
  reading: NormalizedReading,
  config: RuntimeConfig,
): Promise<void> {
  const rates = await calculateAndStoreRates(db, reading, config);
  await updateSessionDetector(db, reading, rates.stovepipeRateCPerMin, config);
}

export async function getCurrentReading(db: D1Database): Promise<CurrentReadingRow | null> {
  return db.prepare(`
    SELECT
      observed_at_ms, received_at, sauna_temp_c, stovepipe_temp_c,
      sauna_rate_c_per_min, stovepipe_rate_c_per_min,
      battery_v, rssi_dbm, snr_db
    FROM readings
    ORDER BY observed_at_ms DESC
    LIMIT 1
  `).first<CurrentReadingRow>();
}

export async function getOldestReadingTime(db: D1Database): Promise<number | null> {
  const row = await db.prepare(`SELECT MIN(observed_at_ms) AS oldest FROM readings`).first<{
    oldest: number | null;
  }>();
  return row?.oldest ?? null;
}

export async function getHistory(
  db: D1Database,
  fromMs: number,
  toMs: number,
  bucketMs: number,
): Promise<HistoryAggregateRow[]> {
  const result = await db.prepare(`
    SELECT
      CAST(observed_at_ms / ? AS INTEGER) * ? AS bucket_ms,
      CAST(AVG(observed_at_ms) AS INTEGER) AS point_ms,
      AVG(sauna_temp_c) AS sauna_avg_c,
      MIN(sauna_temp_c) AS sauna_min_c,
      MAX(sauna_temp_c) AS sauna_max_c,
      AVG(stovepipe_temp_c) AS stovepipe_avg_c,
      MIN(stovepipe_temp_c) AS stovepipe_min_c,
      MAX(stovepipe_temp_c) AS stovepipe_max_c,
      AVG(sauna_rate_c_per_min) AS sauna_rate_avg_c_per_min,
      AVG(stovepipe_rate_c_per_min) AS stovepipe_rate_avg_c_per_min
    FROM readings
    WHERE observed_at_ms >= ? AND observed_at_ms < ?
    GROUP BY bucket_ms
    ORDER BY bucket_ms ASC
  `).bind(bucketMs, bucketMs, fromMs, toMs).all<HistoryAggregateRow>();
  return result.results;
}

export async function getSessionRows(db: D1Database, sinceMs: number): Promise<SessionRow[]> {
  const result = await db.prepare(`
    SELECT
      id, started_at_ms, ended_at_ms, peak_sauna_c, peak_stovepipe_c,
      max_stovepipe_rate_c_per_min, sample_count, complete
    FROM sessions
    WHERE started_at_ms >= ?
    ORDER BY started_at_ms ASC
  `).bind(sinceMs).all<SessionRow>();
  return result.results;
}

export async function hasOpenSession(db: D1Database): Promise<boolean> {
  const row = await db.prepare(`
    SELECT 1 AS present FROM sessions WHERE ended_at_ms IS NULL LIMIT 1
  `).first<{ present: number }>();
  return row?.present === 1;
}
