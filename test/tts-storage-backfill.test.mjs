import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { auditStorageFiles, runCli } from "../scripts/tts-storage-backfill.ts";

const temporaryDirectories = [];
const afterMs = Date.parse("2026-08-01T00:00:00Z");
const beforeMs = Date.parse("2026-09-01T00:00:00Z");

function applicationUp({
  receivedAt = "2026-08-05T01:00:00.000Z",
  correlation = "gs:uplink:test-1",
  sessionKey = "session-a",
  frameCounter = 1,
  channel1 = 120,
  channel2 = 30,
} = {}) {
  return {
    end_device_ids: {
      device_id: "ltc2-lb",
      application_ids: { application_id: "sauna" },
      dev_eui: "A84041A47C61C1E2",
    },
    correlation_ids: [correlation],
    received_at: receivedAt,
    uplink_message: {
      session_key_id: sessionKey,
      f_port: 2,
      f_cnt: frameCounter,
      decoded_payload: {
        BatV: 3.6,
        Temp_Channel1: channel1,
        Temp_Channel2: channel2,
      },
      rx_metadata: [{ rssi: -65, snr: 8 }],
    },
  };
}

async function storageFile(lines) {
  const directory = await mkdtemp(join(tmpdir(), "sauna-backfill-test-"));
  temporaryDirectories.push(directory);
  const file = join(directory, "page-001.ndjson");
  await writeFile(file, `${lines.map((line) => JSON.stringify(line)).join("\n\n")}\n`, "utf8");
  return { directory, file };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("TTS storage backfill audit", () => {
  it("accepts the storage result wrapper and rejects other parser wrappers", async () => {
    const accepted = await storageFile([{ result: applicationUp() }]);
    const acceptedAudit = await auditStorageFiles([accepted.file], { afterMs, beforeMs, expectedCount: 1 });
    expect(acceptedAudit.canReplay).toBe(true);
    expect(acceptedAudit.envelopes).toEqual([applicationUp()]);

    const rejected = await storageFile([{ data: applicationUp() }]);
    const rejectedAudit = await auditStorageFiles([rejected.file], { afterMs, beforeMs, expectedCount: 1 });
    expect(rejectedAudit.canReplay).toBe(false);
    expect(rejectedAudit.manifest.records[0]).toMatchObject({
      status: "error",
      reason: expect.stringContaining("{result: ApplicationUp}"),
    });
  });

  it("rejects conflicting normalized data for the same message key", async () => {
    const { file } = await storageFile([
      { result: applicationUp() },
      { result: applicationUp({ channel1: 200 }) },
    ]);
    const audit = await auditStorageFiles([file], { afterMs, beforeMs, expectedCount: 2 });
    expect(audit.canReplay).toBe(false);
    expect(audit.envelopes).toHaveLength(0);
    expect(audit.manifest.records).toContainEqual(expect.objectContaining({
      status: "error",
      reason: "Message key conflicts with different normalized data",
    }));
  });

  it("rejects the same physical packet under different message keys", async () => {
    const { file } = await storageFile([
      { result: applicationUp({ correlation: "gs:uplink:one" }) },
      { result: applicationUp({ correlation: "as:up:two" }) },
    ]);
    const audit = await auditStorageFiles([file], { afterMs, beforeMs, expectedCount: 2 });
    expect(audit.canReplay).toBe(false);
    expect(audit.manifest.records).toContainEqual(expect.objectContaining({
      status: "error",
      reason: "Physical packet tuple appears under multiple message keys",
    }));
  });

  it("rejects distinct messages tied at the same device timestamp", async () => {
    const { file } = await storageFile([
      { result: applicationUp({ correlation: "gs:uplink:one", sessionKey: "one", frameCounter: 1 }) },
      { result: applicationUp({ correlation: "gs:uplink:two", sessionKey: "two", frameCounter: 2 }) },
    ]);
    const audit = await auditStorageFiles([file], { afterMs, beforeMs, expectedCount: 2 });
    expect(audit.canReplay).toBe(false);
    expect(audit.manifest.records).toContainEqual(expect.objectContaining({
      status: "error",
      reason: expect.stringContaining("same received_at timestamp"),
    }));
  });

  it("sorts valid envelopes strictly oldest-first", async () => {
    const { file } = await storageFile([
      { result: applicationUp({ receivedAt: "2026-08-05T01:10:00Z", correlation: "gs:uplink:3", frameCounter: 3 }) },
      { result: applicationUp({ receivedAt: "2026-08-05T01:00:00Z", correlation: "gs:uplink:1", frameCounter: 1 }) },
      { result: applicationUp({ receivedAt: "2026-08-05T01:05:00Z", correlation: "gs:uplink:2", frameCounter: 2 }) },
    ]);
    const audit = await auditStorageFiles([file], { afterMs, beforeMs, expectedCount: 3 });
    expect(audit.canReplay).toBe(true);
    expect(audit.envelopes.map((envelope) => envelope.received_at)).toEqual([
      "2026-08-05T01:00:00Z",
      "2026-08-05T01:05:00Z",
      "2026-08-05T01:10:00Z",
    ]);
  });

  it("reconciles an alternate-key live row by exact timestamp, frame counter, and raw channels", async () => {
    const archived = applicationUp({ correlation: undefined });
    delete archived.correlation_ids;
    const { file } = await storageFile([{ result: archived }]);
    const audit = await auditStorageFiles([file], {
      afterMs,
      beforeMs,
      expectedCount: 1,
      liveBaselineRows: [{
        message_key: "gs:uplink:live-key",
        application_id: "sauna",
        device_id: "ltc2-lb",
        dev_eui: "A84041A47C61C1E2",
        received_at: archived.received_at,
        frame_counter: archived.uplink_message.f_cnt,
        temp_channel_1_c: archived.uplink_message.decoded_payload.Temp_Channel1,
        temp_channel_2_c: archived.uplink_message.decoded_payload.Temp_Channel2,
      }],
    });

    expect(audit.canReplay).toBe(true);
    expect(audit.envelopes).toHaveLength(0);
    expect(audit.manifest.summary.live_overlaps).toBe(1);
    expect(audit.manifest.records[0]).toMatchObject({
      status: "live_overlap",
      live_message_key: "gs:uplink:live-key",
    });
  });

  it("rejects a live physical-event match whose raw channel values differ", async () => {
    const archived = applicationUp();
    const { file } = await storageFile([{ result: archived }]);
    const audit = await auditStorageFiles([file], {
      afterMs,
      beforeMs,
      expectedCount: 1,
      liveBaselineRows: [{
        message_key: "gs:uplink:live-key",
        application_id: "sauna",
        device_id: "ltc2-lb",
        dev_eui: "A84041A47C61C1E2",
        received_at: archived.received_at,
        frame_counter: archived.uplink_message.f_cnt,
        temp_channel_1_c: 999,
        temp_channel_2_c: archived.uplink_message.decoded_payload.Temp_Channel2,
      }],
    });

    expect(audit.canReplay).toBe(false);
    expect(audit.manifest.records).toContainEqual(expect.objectContaining({
      status: "error",
      reason: expect.stringContaining("different raw channel values"),
    }));
  });

  it("rejects a live message key that names a different archive event", async () => {
    const archived = applicationUp({ correlation: "gs:uplink:shared" });
    const { file } = await storageFile([{ result: archived }]);
    const audit = await auditStorageFiles([file], {
      afterMs,
      beforeMs,
      expectedCount: 1,
      liveBaselineRows: [{
        message_key: "gs:uplink:shared",
        application_id: "sauna",
        device_id: "ltc2-lb",
        dev_eui: "A84041A47C61C1E2",
        received_at: "2026-08-05T02:00:00.000Z",
        frame_counter: 2,
        temp_channel_1_c: 120,
        temp_channel_2_c: 30,
      }],
    });

    expect(audit.canReplay).toBe(false);
    expect(audit.manifest.records).toContainEqual(expect.objectContaining({
      status: "error",
      reason: "Live message key conflicts with a different archive event",
    }));
  });

  it("reports frame-counter reuse without treating it as a duplicate", async () => {
    const { file } = await storageFile([
      { result: applicationUp({ receivedAt: "2026-08-05T01:00:00Z", correlation: "gs:uplink:1", frameCounter: 7 }) },
      { result: applicationUp({ receivedAt: "2026-08-06T01:00:00Z", correlation: "gs:uplink:2", frameCounter: 7 }) },
    ]);
    const audit = await auditStorageFiles([file], { afterMs, beforeMs, expectedCount: 2 });
    expect(audit.canReplay).toBe(true);
    expect(audit.envelopes).toHaveLength(2);
    expect(audit.manifest.summary.frame_counter_reuse_groups).toBe(1);
    expect(audit.manifest.validation.frame_counter_only_deduplication).toBe("unsafe and not used");
  });

  it("defaults to dry-run output and never calls fetch", async () => {
    const { directory } = await storageFile([{ result: applicationUp() }]);
    const manifest = join(directory, "manifest.json");
    const replayOutput = join(directory, "replay.jsonl");
    let fetchCalls = 0;
    let stdout = "";
    const exitCode = await runCli([
      "--input-dir", directory,
      "--manifest", manifest,
      "--replay-output", replayOutput,
      "--after", "2026-08-01T00:00:00Z",
      "--before", "2026-09-01T00:00:00Z",
      "--expected-count", "1",
    ], {
      env: {},
      stdout: { write: (chunk) => { stdout += chunk; } },
      stderr: { write: () => {} },
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error("fetch must not be called during a dry run");
      },
    });

    expect(exitCode).toBe(0);
    expect(fetchCalls).toBe(0);
    expect(stdout).toContain("Dry run complete");
    expect(JSON.parse(await readFile(manifest, "utf8"))).toMatchObject({
      summary: { replay_envelopes: 1, errors: 0 },
    });
    const replayLine = (await readFile(replayOutput, "utf8")).trim();
    expect(JSON.parse(replayLine)).toEqual(applicationUp());
  });

  it("removes stale replay output when a later dry-run validation fails", async () => {
    const { directory } = await storageFile([{ data: applicationUp() }]);
    const manifest = join(directory, "manifest.json");
    const replayOutput = join(directory, "replay.jsonl");
    await writeFile(replayOutput, "stale unsafe output\n", "utf8");
    let fetchCalls = 0;
    const exitCode = await runCli([
      "--input-dir", directory,
      "--manifest", manifest,
      "--replay-output", replayOutput,
      "--after", "2026-08-01T00:00:00Z",
      "--before", "2026-09-01T00:00:00Z",
      "--expected-count", "1",
    ], {
      env: {},
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error("fetch must not be called during a failed dry run");
      },
    });

    expect(exitCode).toBe(1);
    expect(fetchCalls).toBe(0);
    await expect(readFile(replayOutput, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
