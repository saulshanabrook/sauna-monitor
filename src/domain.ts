import { normalizeEui } from "./config";
import type { ChannelMapping, NormalizedReading, ParseResult } from "./types";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getRecord(value: unknown): JsonRecord | null {
  return isRecord(value) ? value : null;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toInteger(value: unknown): number | null {
  const parsed = toFiniteNumber(value);
  return parsed !== null && Number.isInteger(parsed) ? parsed : null;
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function applicationUpCandidate(value: unknown): JsonRecord | null {
  if (!isRecord(value)) return null;
  if (isRecord(value.uplink_message)) return value;
  if (isRecord(value.data) && isRecord(value.data.uplink_message)) return value.data;
  if (isRecord(value.result) && isRecord(value.result.uplink_message)) return value.result;
  return null;
}

function unwrapApplicationUp(body: unknown): JsonRecord | null {
  if (Array.isArray(body)) {
    let fallback: JsonRecord | null = null;
    for (const entry of body) {
      const candidate = applicationUpCandidate(entry);
      if (!candidate) continue;
      fallback ??= candidate;
      const uplink = getRecord(candidate.uplink_message);
      const decoded = getRecord(uplink?.decoded_payload);
      if (decoded && (decoded.Temp_Channel1 !== undefined || decoded.Temp_Channel2 !== undefined)) {
        return candidate;
      }
    }
    return fallback;
  }
  return applicationUpCandidate(body);
}

function strongestReception(rxMetadata: unknown): { rssi: number | null; snr: number | null } {
  if (!Array.isArray(rxMetadata)) return { rssi: null, snr: null };
  let best: { rssi: number; snr: number | null } | null = null;
  for (const item of rxMetadata) {
    if (!isRecord(item)) continue;
    const rssi = toFiniteNumber(item.rssi);
    if (rssi === null) continue;
    if (best === null || rssi > best.rssi) {
      best = { rssi, snr: toFiniteNumber(item.snr) };
    }
  }
  return best ?? { rssi: null, snr: null };
}

function messageKey(
  up: JsonRecord,
  devEui: string | null,
  deviceId: string,
  sessionKeyId: string | null,
  frameCounter: number | null,
  receivedAt: string,
): string {
  const correlations = Array.isArray(up.correlation_ids)
    ? up.correlation_ids.filter((value): value is string => typeof value === "string")
    : [];
  const uplinkCorrelation = correlations.find((value) =>
    value.startsWith("gs:uplink:") || value.startsWith("as:up:"),
  );
  if (uplinkCorrelation) return uplinkCorrelation;
  return [devEui ?? deviceId, sessionKeyId ?? receivedAt, frameCounter ?? receivedAt].join(":");
}

export function parseTtsUplink(body: unknown, channels: ChannelMapping): ParseResult {
  const up = unwrapApplicationUp(body);
  if (!up) return { kind: "ignored", reason: "No application uplink was present" };

  const ids = getRecord(up.end_device_ids);
  const uplink = getRecord(up.uplink_message);
  if (!ids || !uplink) return { kind: "ignored", reason: "No uplink message was present" };

  const decoded = getRecord(uplink.decoded_payload);
  if (!decoded) return { kind: "ignored", reason: "Uplink had no decoded payload" };

  const tempChannel1C = toFiniteNumber(decoded.Temp_Channel1);
  const tempChannel2C = toFiniteNumber(decoded.Temp_Channel2);
  if (tempChannel1C === null && tempChannel2C === null) {
    return { kind: "ignored", reason: "Uplink contained no temperature readings" };
  }

  const receivedAt = toStringOrNull(up.received_at);
  const observedAtMs = receivedAt === null ? Number.NaN : Date.parse(receivedAt);
  if (!receivedAt || !Number.isFinite(observedAtMs)) {
    throw new TypeError("Uplink has no valid received_at timestamp");
  }

  const applicationIds = getRecord(ids.application_ids);
  const applicationId = toStringOrNull(applicationIds?.application_id);
  const deviceId = toStringOrNull(ids.device_id);
  if (!applicationId || !deviceId) {
    throw new TypeError("Uplink is missing its application or device identifier");
  }

  const devEui = normalizeEui(toStringOrNull(ids.dev_eui));
  const sessionKeyId = toStringOrNull(uplink.session_key_id);
  const fPort = toInteger(uplink.f_port);
  const frameCounter = toInteger(uplink.f_cnt);
  const reception = strongestReception(uplink.rx_metadata);
  const saunaTempC = channels.saunaChannel === 1 ? tempChannel1C : tempChannel2C;
  const stovepipeTempC = channels.stovepipeChannel === 1 ? tempChannel1C : tempChannel2C;

  const reading: NormalizedReading = {
    messageKey: messageKey(up, devEui, deviceId, sessionKeyId, frameCounter, receivedAt),
    observedAtMs,
    receivedAt,
    applicationId,
    deviceId,
    devEui,
    sessionKeyId,
    fPort,
    frameCounter,
    tempChannel1C,
    tempChannel2C,
    saunaTempC,
    stovepipeTempC,
    batteryV: toFiniteNumber(decoded.BatV),
    rssiDbm: reception.rssi,
    snrDb: reception.snr,
  };
  return { kind: "reading", reading };
}
