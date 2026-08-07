import { describe, expect, it } from "vitest";
import { parseTtsUplink } from "../src/domain";

const channels = { saunaChannel: 1 as const, stovepipeChannel: 2 as const };

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    end_device_ids: {
      device_id: "ltc2-lb",
      application_ids: { application_id: "sauna" },
      dev_eui: "A8 40 41 A4 7C 61 C1 E2",
    },
    correlation_ids: ["gs:uplink:test-1"],
    received_at: "2026-08-05T01:29:24.000Z",
    uplink_message: {
      session_key_id: "session-a",
      f_port: 2,
      f_cnt: 42,
      decoded_payload: {
        BatV: 3.618,
        Data_time: "2099-01-01 00:00:00",
        Temp_Channel1: 25.2,
        Temp_Channel2: 250.4,
      },
      rx_metadata: [
        { rssi: -91, snr: 2 },
        { rssi: -55, snr: 9.5 },
      ],
    },
    ...overrides,
  };
}

describe("parseTtsUplink", () => {
  it("normalizes a decoded TTS uplink and uses received_at", () => {
    const parsed = parseTtsUplink(payload(), channels);
    expect(parsed.kind).toBe("reading");
    if (parsed.kind !== "reading") return;
    expect(parsed.reading).toMatchObject({
      applicationId: "sauna",
      deviceId: "ltc2-lb",
      devEui: "A84041A47C61C1E2",
      observedAtMs: Date.parse("2026-08-05T01:29:24.000Z"),
      saunaTempC: 25.2,
      stovepipeTempC: 250.4,
      batteryV: 3.618,
      rssiDbm: -55,
      snrDb: 9.5,
      messageKey: "gs:uplink:test-1",
    });
  });

  it("allows one probe to be missing", () => {
    const input = payload();
    const uplink = input.uplink_message as Record<string, unknown>;
    uplink.decoded_payload = { BatV: 3.6, Temp_Channel2: 120 };
    const parsed = parseTtsUplink(input, channels);
    expect(parsed.kind).toBe("reading");
    if (parsed.kind !== "reading") return;
    expect(parsed.reading.saunaTempC).toBeNull();
    expect(parsed.reading.stovepipeTempC).toBe(120);
  });

  it("ignores status uplinks without temperature", () => {
    const input = payload();
    const uplink = input.uplink_message as Record<string, unknown>;
    uplink.f_port = 5;
    uplink.decoded_payload = { BatV: 3.6 };
    expect(parseTtsUplink(input, channels)).toEqual({
      kind: "ignored",
      reason: "Uplink contained no temperature readings",
    });
  });

  it("supports downloaded live-data arrays and selects the temperature event", () => {
    const status = payload();
    const statusUplink = status.uplink_message as Record<string, unknown>;
    statusUplink.decoded_payload = { BatV: 3.6 };
    const decoded = payload({ correlation_ids: ["gs:uplink:test-2"] });
    const parsed = parseTtsUplink([{ data: status }, { data: decoded }], channels);
    expect(parsed.kind).toBe("reading");
    if (parsed.kind === "reading") expect(parsed.reading.messageKey).toBe("gs:uplink:test-2");
  });

  it("supports swapping the channel assignments", () => {
    const parsed = parseTtsUplink(payload(), { saunaChannel: 2, stovepipeChannel: 1 });
    expect(parsed.kind).toBe("reading");
    if (parsed.kind !== "reading") return;
    expect(parsed.reading.saunaTempC).toBe(250.4);
    expect(parsed.reading.stovepipeTempC).toBe(25.2);
  });

  it("rejects an invalid authoritative timestamp", () => {
    expect(() => parseTtsUplink(payload({ received_at: "not-a-time" }), channels)).toThrow(
      "valid received_at",
    );
  });
});

