import { createHash, randomUUID } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { mkdir, readFile, rename, readdir, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { normalizeEui } from "../src/config";
import { parseTtsUplink } from "../src/domain";
import type { NormalizedReading } from "../src/types";

const EXPECTED_APPLICATION_ID = "sauna";
const EXPECTED_DEV_EUI = "A84041A47C61C1E2";
const CHANNELS = { saunaChannel: 2 as const, stovepipeChannel: 1 as const };
const DEFAULT_SAUNA_RANGE_C = { minimum: -40, maximum: 150 };
const DEFAULT_STOVEPIPE_RANGE_C = { minimum: -40, maximum: 600 };

type JsonRecord = Record<string, unknown>;

interface TemperatureRange {
  minimum: number;
  maximum: number;
}

export interface AuditOptions {
  afterMs: number;
  beforeMs: number;
  expectedCount: number;
  saunaRangeC?: TemperatureRange;
  stovepipeRangeC?: TemperatureRange;
  liveBaselineRows?: unknown[];
}

interface SourceSummary {
  file: string;
  sha256: string;
  json_lines: number;
  blank_lines: number;
}

interface AuditRecord {
  source_file: string;
  source_line: number;
  status: "valid" | "live_overlap" | "duplicate" | "ignored" | "error";
  reason?: string;
  duplicate_of?: { source_file: string; source_line: number };
  message_key?: string;
  live_message_key?: string;
  physical_packet_sha256?: string;
  observed_at?: string;
  application_id?: string;
  device_id?: string;
  dev_eui?: string | null;
  session_key_id?: string | null;
  f_port?: number | null;
  frame_counter?: number | null;
  temp_channel_1_c?: number | null;
  temp_channel_2_c?: number | null;
  sauna_temp_c?: number | null;
  stovepipe_temp_c?: number | null;
  battery_v?: number | null;
  rssi_dbm?: number | null;
  snr_db?: number | null;
}

interface ValidEntry {
  envelope: JsonRecord;
  reading: NormalizedReading;
  recordIndex: number;
  signature: string;
}

export interface AuditResult {
  manifest: {
    schema_version: 1;
    source_files: SourceSummary[];
    validation: {
      expected_application_id: string;
      expected_dev_eui: string;
      after_exclusive: string;
      before_exclusive: string;
      expected_storage_events: number;
      channel_mapping: { sauna: "Temp_Channel2"; stovepipe: "Temp_Channel1" };
      physical_identity: "dev_eui + device_id + exact received_at + frame_counter + raw channels";
      frame_counter_only_deduplication: "unsafe and not used";
      sauna_range_c: TemperatureRange;
      stovepipe_range_c: TemperatureRange;
    };
    summary: {
      storage_events: number;
      valid: number;
      live_overlaps: number;
      duplicates: number;
      ignored: number;
      errors: number;
      replay_envelopes: number;
      first_observed_at: string | null;
      last_observed_at: string | null;
      frame_counter_reuse_groups: number;
    };
    live_baseline: {
      supplied: boolean;
      rows: number;
      matched_archive_rows: number;
      unmatched_rows: number;
    };
    records: AuditRecord[];
  };
  envelopes: JsonRecord[];
  canReplay: boolean;
}

interface CliDependencies {
  env?: Record<string, string | undefined>;
  stdout?: { write(chunk: string): unknown };
  stderr?: { write(chunk: string): unknown };
  fetchImpl?: typeof fetch;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteTemperature(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function liveBaselineRows(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    if (value.every((entry) => isRecord(entry) && Array.isArray(entry.results))) {
      return value.flatMap((entry) => (entry as JsonRecord).results as unknown[]);
    }
    return value;
  }
  if (isRecord(value) && Array.isArray(value.results)) return value.results;
  throw new TypeError("Live baseline must be a JSON row array or Wrangler D1 JSON with results arrays");
}

function readingSignature(reading: NormalizedReading): string {
  return JSON.stringify({
    observedAtMs: reading.observedAtMs,
    receivedAt: reading.receivedAt,
    applicationId: reading.applicationId,
    deviceId: reading.deviceId,
    devEui: reading.devEui,
    sessionKeyId: reading.sessionKeyId,
    fPort: reading.fPort,
    frameCounter: reading.frameCounter,
    tempChannel1C: reading.tempChannel1C,
    tempChannel2C: reading.tempChannel2C,
    saunaTempC: reading.saunaTempC,
    stovepipeTempC: reading.stovepipeTempC,
    batteryV: reading.batteryV,
    rssiDbm: reading.rssiDbm,
    snrDb: reading.snrDb,
  });
}

function manifestRecord(
  sourceFile: string,
  sourceLine: number,
  reading: NormalizedReading,
  physicalPacketSha256: string | null,
): AuditRecord {
  return {
    source_file: sourceFile,
    source_line: sourceLine,
    status: "valid",
    message_key: reading.messageKey,
    physical_packet_sha256: physicalPacketSha256 ?? undefined,
    observed_at: reading.receivedAt,
    application_id: reading.applicationId,
    device_id: reading.deviceId,
    dev_eui: reading.devEui,
    session_key_id: reading.sessionKeyId,
    f_port: reading.fPort,
    frame_counter: reading.frameCounter,
    temp_channel_1_c: reading.tempChannel1C,
    temp_channel_2_c: reading.tempChannel2C,
    sauna_temp_c: reading.saunaTempC,
    stovepipe_temp_c: reading.stovepipeTempC,
    battery_v: reading.batteryV,
    rssi_dbm: reading.rssiDbm,
    snr_db: reading.snrDb,
  };
}

export async function auditStorageFiles(filePaths: string[], options: AuditOptions): Promise<AuditResult> {
  const saunaRangeC = options.saunaRangeC ?? DEFAULT_SAUNA_RANGE_C;
  const stovepipeRangeC = options.stovepipeRangeC ?? DEFAULT_STOVEPIPE_RANGE_C;
  if (!Number.isFinite(options.afterMs) || !Number.isFinite(options.beforeMs) ||
      options.afterMs >= options.beforeMs) {
    throw new TypeError("The audit timestamp bounds must be finite and increasing");
  }
  if (!Number.isInteger(options.expectedCount) || options.expectedCount < 0) {
    throw new TypeError("The expected storage event count must be a non-negative integer");
  }
  for (const [label, range] of [["sauna", saunaRangeC], ["stovepipe", stovepipeRangeC]] as const) {
    if (!Number.isFinite(range.minimum) || !Number.isFinite(range.maximum) || range.minimum >= range.maximum) {
      throw new TypeError(`The ${label} temperature range must be finite and increasing`);
    }
  }

  const sourceFiles: SourceSummary[] = [];
  const records: AuditRecord[] = [];
  const validEntries: ValidEntry[] = [];
  const seenMessageKeys = new Map<string, ValidEntry>();
  const seenPhysicalPackets = new Map<string, ValidEntry>();
  const seenDeviceTimestamps = new Map<string, ValidEntry>();
  const frameCounterOccurrences = new Map<string, Set<string>>();
  let storageEvents = 0;

  for (const filePath of [...filePaths].sort((left, right) => left.localeCompare(right))) {
    const sourceFile = basename(filePath);
    const input = createReadStream(filePath);
    const sourceHash = createHash("sha256");
    input.on("data", (chunk) => sourceHash.update(chunk));
    const lines = createInterface({ input, crlfDelay: Infinity });
    let sourceLine = 0;
    let jsonLines = 0;
    let blankLines = 0;

    for await (const line of lines) {
      sourceLine += 1;
      if (line.trim() === "") {
        blankLines += 1;
        continue;
      }
      jsonLines += 1;
      storageEvents += 1;
      let wrapper: unknown;
      try {
        wrapper = JSON.parse(line);
      } catch {
        records.push({
          source_file: sourceFile,
          source_line: sourceLine,
          status: "error",
          reason: "Line is not valid JSON",
        });
        continue;
      }
      if (!isRecord(wrapper) || !isRecord(wrapper.result) || !isRecord(wrapper.result.uplink_message)) {
        records.push({
          source_file: sourceFile,
          source_line: sourceLine,
          status: "error",
          reason: "Line must contain exactly one {result: ApplicationUp} storage wrapper",
        });
        continue;
      }

      const envelope = wrapper.result;
      const ids = isRecord(envelope.end_device_ids) ? envelope.end_device_ids : null;
      const applicationIds = ids && isRecord(ids.application_ids) ? ids.application_ids : null;
      const applicationId = typeof applicationIds?.application_id === "string"
        ? applicationIds.application_id
        : null;
      const deviceId = typeof ids?.device_id === "string" && ids.device_id.length > 0
        ? ids.device_id
        : null;
      const devEui = normalizeEui(typeof ids?.dev_eui === "string" ? ids.dev_eui : null);
      const receivedAt = typeof envelope.received_at === "string" ? envelope.received_at : null;
      const observedAtMs = receivedAt === null ? Number.NaN : Date.parse(receivedAt);
      if (applicationId !== EXPECTED_APPLICATION_ID) {
        records.push({
          source_file: sourceFile,
          source_line: sourceLine,
          status: "error",
          reason: "Unexpected or missing application identifier",
        });
        continue;
      }
      if (!deviceId) {
        records.push({
          source_file: sourceFile,
          source_line: sourceLine,
          status: "error",
          reason: "Missing device identifier",
        });
        continue;
      }
      if (devEui !== EXPECTED_DEV_EUI) {
        records.push({
          source_file: sourceFile,
          source_line: sourceLine,
          status: "error",
          reason: "Unexpected or missing device EUI",
        });
        continue;
      }
      if (!Number.isFinite(observedAtMs)) {
        records.push({
          source_file: sourceFile,
          source_line: sourceLine,
          status: "error",
          reason: "Missing or invalid received_at timestamp",
        });
        continue;
      }
      if (observedAtMs <= options.afterMs || observedAtMs >= options.beforeMs) {
        records.push({
          source_file: sourceFile,
          source_line: sourceLine,
          status: "error",
          reason: "received_at falls outside the exclusive audit bounds",
          observed_at: receivedAt!,
          device_id: deviceId,
        });
        continue;
      }

      const uplink = envelope.uplink_message;
      const decoded = isRecord(uplink.decoded_payload) ? uplink.decoded_payload : null;
      for (const field of ["Temp_Channel1", "Temp_Channel2"] as const) {
        if (decoded && Object.hasOwn(decoded, field) && finiteTemperature(decoded[field]) === null) {
          records.push({
            source_file: sourceFile,
            source_line: sourceLine,
            status: "error",
            reason: `${field} is present but is not a finite number`,
            observed_at: receivedAt!,
            device_id: deviceId,
          });
        }
      }
      if (records.at(-1)?.source_file === sourceFile && records.at(-1)?.source_line === sourceLine &&
          records.at(-1)?.status === "error") {
        continue;
      }

      let parsed;
      try {
        parsed = parseTtsUplink(wrapper, CHANNELS);
      } catch (error) {
        records.push({
          source_file: sourceFile,
          source_line: sourceLine,
          status: "error",
          reason: error instanceof Error ? error.message : "Uplink parsing failed",
        });
        continue;
      }
      if (parsed.kind === "ignored") {
        records.push({
          source_file: sourceFile,
          source_line: sourceLine,
          status: "ignored",
          reason: parsed.reason,
          observed_at: receivedAt!,
          application_id: applicationId,
          device_id: deviceId,
          dev_eui: devEui,
        });
        continue;
      }
      const reading = parsed.reading;
      if ((reading.saunaTempC !== null &&
           (reading.saunaTempC < saunaRangeC.minimum || reading.saunaTempC > saunaRangeC.maximum)) ||
          (reading.stovepipeTempC !== null &&
           (reading.stovepipeTempC < stovepipeRangeC.minimum ||
            reading.stovepipeTempC > stovepipeRangeC.maximum))) {
        records.push({
          ...manifestRecord(sourceFile, sourceLine, reading, null),
          status: "error",
          reason: "Temperature falls outside the configured plausible range",
        });
        continue;
      }

      const signature = readingSignature(reading);
      const existingMessage = seenMessageKeys.get(reading.messageKey);
      if (existingMessage) {
        const existingRecord = records[existingMessage.recordIndex]!;
        if (existingMessage.signature !== signature) {
          records.push({
            ...manifestRecord(sourceFile, sourceLine, reading, null),
            status: "error",
            reason: "Message key conflicts with different normalized data",
            duplicate_of: {
              source_file: existingRecord.source_file,
              source_line: existingRecord.source_line,
            },
          });
        } else {
          records.push({
            ...manifestRecord(sourceFile, sourceLine, reading, null),
            status: "duplicate",
            reason: "Exact normalized message-key duplicate",
            duplicate_of: {
              source_file: existingRecord.source_file,
              source_line: existingRecord.source_line,
            },
          });
        }
        continue;
      }

      const physicalPacketKey = reading.devEui !== null && reading.frameCounter !== null
        ? `${reading.devEui}\u0000${reading.deviceId}\u0000${reading.receivedAt}\u0000${reading.frameCounter}`
        : null;
      const physicalPacketSha256 = physicalPacketKey === null
        ? null
        : createHash("sha256").update(physicalPacketKey).digest("hex");
      const recordIndex = records.length;
      const entry: ValidEntry = { envelope, reading, recordIndex, signature };
      if (physicalPacketKey !== null) {
        const existingPhysical = seenPhysicalPackets.get(physicalPacketKey);
        if (existingPhysical) {
          const existingRecord = records[existingPhysical.recordIndex]!;
          records.push({
            ...manifestRecord(sourceFile, sourceLine, reading, physicalPacketSha256),
            status: "error",
            reason: "Physical packet tuple appears under multiple message keys",
            duplicate_of: {
              source_file: existingRecord.source_file,
              source_line: existingRecord.source_line,
            },
          });
          continue;
        }
      }
      const timestampKey = `${reading.deviceId}\u0000${reading.observedAtMs}`;
      const existingTimestamp = seenDeviceTimestamps.get(timestampKey);
      if (existingTimestamp) {
        const existingRecord = records[existingTimestamp.recordIndex]!;
        records.push({
          ...manifestRecord(sourceFile, sourceLine, reading, physicalPacketSha256),
          status: "error",
          reason: "Device has multiple distinct messages at the same received_at timestamp",
          duplicate_of: {
            source_file: existingRecord.source_file,
            source_line: existingRecord.source_line,
          },
        });
        continue;
      }

      records.push(manifestRecord(sourceFile, sourceLine, reading, physicalPacketSha256));
      validEntries.push(entry);
      seenMessageKeys.set(reading.messageKey, entry);
      if (physicalPacketKey !== null) seenPhysicalPackets.set(physicalPacketKey, entry);
      seenDeviceTimestamps.set(timestampKey, entry);
      if (reading.devEui !== null && reading.frameCounter !== null) {
        const counterKey = `${reading.devEui}\u0000${reading.deviceId}\u0000${reading.frameCounter}`;
        const timestamps = frameCounterOccurrences.get(counterKey) ?? new Set<string>();
        timestamps.add(reading.receivedAt);
        frameCounterOccurrences.set(counterKey, timestamps);
      }
    }
    sourceFiles.push({
      file: sourceFile,
      sha256: sourceHash.digest("hex"),
      json_lines: jsonLines,
      blank_lines: blankLines,
    });
  }

  if (storageEvents !== options.expectedCount) {
    records.push({
      source_file: "<all inputs>",
      source_line: 0,
      status: "error",
      reason: `Storage event count ${storageEvents} does not match expected count ${options.expectedCount}`,
    });
  }
  if (storageEvents === 0) {
    records.push({
      source_file: "<all inputs>",
      source_line: 0,
      status: "error",
      reason: "No storage events were found",
    });
  }

  const baselineRows = options.liveBaselineRows ?? [];
  const baselineByPhysicalPacket = new Map<string, {
    messageKey: string;
    tempChannel1C: number | null;
    tempChannel2C: number | null;
    rowNumber: number;
  }>();
  const baselineMessageKeys = new Map<string, number>();
  for (let index = 0; index < baselineRows.length; index += 1) {
    const rowNumber = index + 1;
    const row = baselineRows[index];
    if (!isRecord(row)) {
      records.push({
        source_file: "<live baseline>",
        source_line: rowNumber,
        status: "error",
        reason: "Live baseline row is not an object",
      });
      continue;
    }
    const messageKey = typeof row.message_key === "string" && row.message_key.length > 0
      ? row.message_key
      : null;
    const applicationId = typeof row.application_id === "string" ? row.application_id : null;
    const deviceId = typeof row.device_id === "string" && row.device_id.length > 0 ? row.device_id : null;
    const devEui = normalizeEui(typeof row.dev_eui === "string" ? row.dev_eui : null);
    const receivedAt = typeof row.received_at === "string" && Number.isFinite(Date.parse(row.received_at))
      ? row.received_at
      : null;
    const frameCounter = finiteTemperature(row.frame_counter);
    const tempChannel1C = row.temp_channel_1_c === null ? null : finiteTemperature(row.temp_channel_1_c);
    const tempChannel2C = row.temp_channel_2_c === null ? null : finiteTemperature(row.temp_channel_2_c);
    if (!messageKey || applicationId !== EXPECTED_APPLICATION_ID || !deviceId || devEui !== EXPECTED_DEV_EUI ||
        !receivedAt || frameCounter === null || !Number.isInteger(frameCounter) ||
        (row.temp_channel_1_c !== null && tempChannel1C === null) ||
        (row.temp_channel_2_c !== null && tempChannel2C === null) ||
        (tempChannel1C === null && tempChannel2C === null)) {
      records.push({
        source_file: "<live baseline>",
        source_line: rowNumber,
        status: "error",
        reason: "Live baseline row lacks the exact identity or finite raw-channel fields required for reconciliation",
      });
      continue;
    }
    const physicalPacketKey = `${devEui}\u0000${deviceId}\u0000${receivedAt}\u0000${frameCounter}`;
    const priorMessageRow = baselineMessageKeys.get(messageKey);
    if (priorMessageRow !== undefined) {
      records.push({
        source_file: "<live baseline>",
        source_line: rowNumber,
        status: "error",
        reason: "Live baseline repeats a message key",
        duplicate_of: { source_file: "<live baseline>", source_line: priorMessageRow },
      });
      continue;
    }
    if (baselineByPhysicalPacket.has(physicalPacketKey)) {
      records.push({
        source_file: "<live baseline>",
        source_line: rowNumber,
        status: "error",
        reason: "Live baseline contains multiple rows for the same exact physical event",
      });
      continue;
    }
    baselineMessageKeys.set(messageKey, rowNumber);
    baselineByPhysicalPacket.set(physicalPacketKey, {
      messageKey,
      tempChannel1C,
      tempChannel2C,
      rowNumber,
    });
  }

  let matchedBaselineRows = 0;
  const matchedBaselineKeys = new Set<string>();
  for (const [messageKey, rowNumber] of baselineMessageKeys) {
    const archiveEntry = seenMessageKeys.get(messageKey);
    if (!archiveEntry) continue;
    const reading = archiveEntry.reading;
    const archivePhysicalKey = reading.devEui !== null && reading.frameCounter !== null
      ? `${reading.devEui}\u0000${reading.deviceId}\u0000${reading.receivedAt}\u0000${reading.frameCounter}`
      : null;
    const baseline = archivePhysicalKey === null ? null : baselineByPhysicalPacket.get(archivePhysicalKey);
    if (!baseline || baseline.messageKey !== messageKey || baseline.tempChannel1C !== reading.tempChannel1C ||
        baseline.tempChannel2C !== reading.tempChannel2C) {
      const archiveRecord = records[archiveEntry.recordIndex]!;
      records.push({
        source_file: "<live baseline>",
        source_line: rowNumber,
        status: "error",
        reason: "Live message key conflicts with a different archive event",
        duplicate_of: { source_file: archiveRecord.source_file, source_line: archiveRecord.source_line },
      });
    }
  }
  for (const entry of validEntries) {
    const reading = entry.reading;
    if (reading.devEui === null || reading.frameCounter === null) continue;
    const physicalPacketKey =
      `${reading.devEui}\u0000${reading.deviceId}\u0000${reading.receivedAt}\u0000${reading.frameCounter}`;
    const baseline = baselineByPhysicalPacket.get(physicalPacketKey);
    if (!baseline) continue;
    const record = records[entry.recordIndex]!;
    matchedBaselineKeys.add(physicalPacketKey);
    if (baseline.tempChannel1C !== reading.tempChannel1C || baseline.tempChannel2C !== reading.tempChannel2C) {
      records.push({
        source_file: "<live baseline>",
        source_line: baseline.rowNumber,
        status: "error",
        reason: "Live/archive physical-event match has different raw channel values",
        duplicate_of: { source_file: record.source_file, source_line: record.source_line },
      });
      continue;
    }
    record.status = "live_overlap";
    record.reason = "Exact live/archive physical-event overlap; preserve the live representation";
    record.live_message_key = baseline.messageKey;
    matchedBaselineRows += 1;
  }

  validEntries.sort((left, right) =>
    left.reading.observedAtMs - right.reading.observedAtMs ||
    left.reading.deviceId.localeCompare(right.reading.deviceId) ||
    left.reading.messageKey.localeCompare(right.reading.messageKey));
  const errors = records.filter((record) => record.status === "error").length;
  const canReplay = errors === 0;
  const replayEntries = canReplay
    ? validEntries.filter((entry) => records[entry.recordIndex]!.status === "valid")
    : [];
  const firstEntry = replayEntries[0];
  const lastEntry = replayEntries.at(-1);

  return {
    manifest: {
      schema_version: 1,
      source_files: sourceFiles,
      validation: {
        expected_application_id: EXPECTED_APPLICATION_ID,
        expected_dev_eui: EXPECTED_DEV_EUI,
        after_exclusive: new Date(options.afterMs).toISOString(),
        before_exclusive: new Date(options.beforeMs).toISOString(),
        expected_storage_events: options.expectedCount,
        channel_mapping: { sauna: "Temp_Channel2", stovepipe: "Temp_Channel1" },
        physical_identity: "dev_eui + device_id + exact received_at + frame_counter + raw channels",
        frame_counter_only_deduplication: "unsafe and not used",
        sauna_range_c: saunaRangeC,
        stovepipe_range_c: stovepipeRangeC,
      },
      summary: {
        storage_events: storageEvents,
        valid: records.filter((record) => record.status === "valid").length,
        live_overlaps: records.filter((record) => record.status === "live_overlap").length,
        duplicates: records.filter((record) => record.status === "duplicate").length,
        ignored: records.filter((record) => record.status === "ignored").length,
        errors,
        replay_envelopes: replayEntries.length,
        first_observed_at: firstEntry?.reading.receivedAt ?? null,
        last_observed_at: lastEntry?.reading.receivedAt ?? null,
        frame_counter_reuse_groups: [...frameCounterOccurrences.values()]
          .filter((timestamps) => timestamps.size > 1).length,
      },
      live_baseline: {
        supplied: options.liveBaselineRows !== undefined,
        rows: baselineRows.length,
        matched_archive_rows: matchedBaselineRows,
        unmatched_rows: Math.max(0, baselineByPhysicalPacket.size - matchedBaselineKeys.size),
      },
      records,
    },
    envelopes: replayEntries.map((entry) => entry.envelope),
    canReplay,
  };
}

async function writeAtomically(filePath: string, contents: string): Promise<void> {
  const resolvedPath = resolve(filePath);
  await mkdir(dirname(resolvedPath), { recursive: true });
  const temporaryPath = `${resolvedPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporaryPath, resolvedPath);
  } catch (error) {
    await unlink(temporaryPath).catch((unlinkError: NodeJS.ErrnoException) => {
      if (unlinkError.code !== "ENOENT") throw unlinkError;
    });
    throw error;
  }
}

async function replaySequentially(
  envelopes: JsonRecord[],
  url: string,
  username: string,
  password: string,
  fetchImpl: typeof fetch,
): Promise<{ stored: number; duplicates: number }> {
  const parsedUrl = new URL(url);
  const localHttp = parsedUrl.protocol === "http:" &&
    (parsedUrl.hostname === "localhost" || parsedUrl.hostname === "127.0.0.1" || parsedUrl.hostname === "::1");
  if (parsedUrl.protocol !== "https:" && !localHttp) {
    throw new TypeError("Replay URL must use HTTPS, except for an explicit localhost URL");
  }
  if (parsedUrl.username || parsedUrl.password || parsedUrl.pathname !== "/api/ingest") {
    throw new TypeError("Replay URL must be a credential-free /api/ingest endpoint");
  }
  if (username.includes(":")) throw new TypeError("Replay username must not contain a colon");
  const authorization = `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
  let stored = 0;
  let duplicates = 0;
  for (let index = 0; index < envelopes.length; index += 1) {
    const response = await fetchImpl(parsedUrl, {
      method: "POST",
      headers: { Authorization: authorization, "Content-Type": "application/json" },
      body: JSON.stringify(envelopes[index]),
    });
    if (!response.ok) {
      throw new Error(`Replay stopped at envelope ${index + 1}: HTTP ${response.status}`);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new Error(`Replay stopped at envelope ${index + 1}: response was not JSON`);
    }
    if (!isRecord(body) || body.ok !== true) {
      throw new Error(`Replay stopped at envelope ${index + 1}: response did not confirm success`);
    }
    if (body.stored === true) stored += 1;
    else if (body.duplicate === true) duplicates += 1;
    else throw new Error(`Replay stopped at envelope ${index + 1}: event was not stored or deduplicated`);
  }
  return { stored, duplicates };
}

function usage(): string {
  return `Usage:
  npm run backfill:audit -- \\
    --input-dir <storage-pages-directory> \\
    --manifest <audit-manifest.json> \\
    --replay-output <oldest-first.ndjson> \\
    --after <exclusive-RFC3339-lower-bound> \\
    --before <exclusive-RFC3339-upper-bound> \\
    --expected-count <storage-count> [--live-baseline <d1-query.json>]

Defaults to audit/output only and makes no HTTP requests.

Optional live replay (sequential, oldest-first):
  supply --live-baseline, add --replay --acknowledge-derived-state-limitations, and set
  SAUNA_BACKFILL_INGEST_URL, SAUNA_BACKFILL_USERNAME, and exactly one of
  SAUNA_BACKFILL_PASSWORD or SAUNA_BACKFILL_PASSWORD_FD.
`;
}

export async function runCli(args: string[], dependencies: CliDependencies = {}): Promise<number> {
  const env = dependencies.env ?? process.env;
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const optionValues = new Map<string, string>();
  let replay = false;
  let acknowledgedDerivedLimitations = false;
  const valueOptions = new Set([
    "--input-dir", "--manifest", "--replay-output", "--after", "--before", "--expected-count",
    "--sauna-min-c", "--sauna-max-c", "--stovepipe-min-c", "--stovepipe-max-c", "--live-baseline",
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--help") {
      stdout.write(usage());
      return 0;
    }
    if (argument === "--replay") {
      replay = true;
      continue;
    }
    if (argument === "--acknowledge-derived-state-limitations") {
      acknowledgedDerivedLimitations = true;
      continue;
    }
    if (!valueOptions.has(argument)) throw new TypeError(`Unknown argument: ${argument}\n${usage()}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new TypeError(`Missing value for ${argument}\n${usage()}`);
    }
    optionValues.set(argument, value);
    index += 1;
  }
  const requiredOptions = ["--input-dir", "--manifest", "--replay-output", "--after", "--before", "--expected-count"];
  const missingOptions = requiredOptions.filter((name) => !optionValues.has(name));
  if (missingOptions.length > 0) {
    throw new TypeError(`Missing required options: ${missingOptions.join(", ")}\n${usage()}`);
  }

  const afterMs = Date.parse(optionValues.get("--after")!);
  const beforeMs = Date.parse(optionValues.get("--before")!);
  const expectedCount = Number(optionValues.get("--expected-count"));
  const saunaRangeC = {
    minimum: Number(optionValues.get("--sauna-min-c") ?? DEFAULT_SAUNA_RANGE_C.minimum),
    maximum: Number(optionValues.get("--sauna-max-c") ?? DEFAULT_SAUNA_RANGE_C.maximum),
  };
  const stovepipeRangeC = {
    minimum: Number(optionValues.get("--stovepipe-min-c") ?? DEFAULT_STOVEPIPE_RANGE_C.minimum),
    maximum: Number(optionValues.get("--stovepipe-max-c") ?? DEFAULT_STOVEPIPE_RANGE_C.maximum),
  };
  const inputDirectory = resolve(optionValues.get("--input-dir")!);
  const filePaths = (await readdir(inputDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ndjson"))
    .map((entry) => join(inputDirectory, entry.name));
  if (filePaths.length === 0) throw new Error("Input directory contains no .ndjson files");
  const manifestPath = resolve(optionValues.get("--manifest")!);
  const replayOutputPath = resolve(optionValues.get("--replay-output")!);
  if (manifestPath === replayOutputPath || filePaths.includes(manifestPath) || filePaths.includes(replayOutputPath)) {
    throw new Error("Manifest and replay output must be distinct and must not overwrite an input page");
  }

  if (replay && !acknowledgedDerivedLimitations) {
    throw new Error("--replay also requires --acknowledge-derived-state-limitations");
  }
  if (replay && !optionValues.has("--live-baseline")) {
    throw new Error("--replay requires --live-baseline so archive/live overlaps cannot create alternate-key duplicates");
  }
  let replayCredentials: { url: string; username: string; password: string } | null = null;
  if (replay) {
    const url = env.SAUNA_BACKFILL_INGEST_URL;
    const username = env.SAUNA_BACKFILL_USERNAME;
    const passwordFromEnvironment = env.SAUNA_BACKFILL_PASSWORD;
    const passwordFd = env.SAUNA_BACKFILL_PASSWORD_FD;
    if (!url || !username || (!passwordFromEnvironment && !passwordFd) ||
        (passwordFromEnvironment !== undefined && passwordFd !== undefined)) {
      throw new Error("Replay credentials are incomplete or specify both password sources");
    }
    let password = passwordFromEnvironment;
    if (passwordFd !== undefined) {
      const fd = Number(passwordFd);
      if (!Number.isInteger(fd) || fd < 0) throw new Error("SAUNA_BACKFILL_PASSWORD_FD must be a file descriptor");
      password = readFileSync(fd, "utf8").replace(/\r?\n$/, "");
    }
    if (!password) throw new Error("Replay password must not be empty");
    replayCredentials = { url, username, password };
  }

  const baselinePath = optionValues.get("--live-baseline");
  const baselineRows = baselinePath === undefined
    ? undefined
    : liveBaselineRows(JSON.parse(await readFile(resolve(baselinePath), "utf8")));
  const result = await auditStorageFiles(filePaths, {
    afterMs,
    beforeMs,
    expectedCount,
    saunaRangeC,
    stovepipeRangeC,
    liveBaselineRows: baselineRows,
  });
  await writeAtomically(manifestPath, `${JSON.stringify(result.manifest, null, 2)}\n`);
  const summary = result.manifest.summary;
  stdout.write(
    `Audit: ${summary.storage_events} events, ${summary.valid} valid, ${summary.live_overlaps} live overlaps, ` +
    `${summary.duplicates} duplicates, ` +
    `${summary.ignored} ignored, ${summary.errors} errors.\nManifest: ${manifestPath}\n`,
  );
  if (!result.canReplay) {
    await unlink(replayOutputPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    stderr.write("Validation failed; no replay output was written and no HTTP requests were made.\n");
    return 1;
  }

  const replayLines = result.envelopes.map((envelope) => JSON.stringify(envelope)).join("\n");
  await writeAtomically(replayOutputPath, replayLines.length > 0 ? `${replayLines}\n` : "");
  stdout.write(`Replay output: ${replayOutputPath} (${result.envelopes.length} envelopes, oldest-first)\n`);
  if (!replay) {
    stdout.write("Dry run complete; no HTTP requests were made.\n");
    return 0;
  }

  stderr.write(
    "Replay requested after explicit acknowledgement: the current Worker does not rebuild derived data for existing or out-of-order rows.\n",
  );
  const replayResult = await replaySequentially(
    result.envelopes,
    replayCredentials!.url,
    replayCredentials!.username,
    replayCredentials!.password,
    fetchImpl,
  );
  stdout.write(`Replay complete: ${replayResult.stored} stored, ${replayResult.duplicates} duplicates.\n`);
  return 0;
}
