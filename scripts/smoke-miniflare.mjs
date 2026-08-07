import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";

const workerScript = process.env.WORKER_BUNDLE ?? "/tmp/sauna-worker-dry-run/index.js";
const mf = new Miniflare({
  modules: true,
  script: await readFile(workerScript, "utf8"),
  compatibilityDate: "2026-08-04",
  d1Databases: ["DB"],
  bindings: {
    WEBHOOK_PASSWORD: "development-only-change-me",
    WEBHOOK_USERNAME: "tts",
    EXPECTED_APPLICATION_ID: "sauna",
    EXPECTED_DEV_EUI: "A84041A47C61C1E2",
    SAUNA_CHANNEL: "1",
    STOVEPIPE_CHANNEL: "2",
    EXPECTED_INTERVAL_SECONDS: "300",
    RATE_WINDOW_MINUTES: "15",
    RATE_MIN_SPAN_MINUTES: "8",
    SESSION_START_PIPE_C: "75",
    SESSION_END_PIPE_C: "50",
    SESSION_END_HOLD_MINUTES: "45",
    REPORT_TIME_ZONE: "America/New_York",
    SITE_NAME: "Smoke Test Sauna",
  },
  serviceBindings: {
    ASSETS: async () => new Response("asset"),
  },
});

try {
  const db = await mf.getD1Database("DB");
  const migration = await readFile(new URL("../migrations/0001_initial.sql", import.meta.url), "utf8");
  const statements = migration.split(";").map((statement) => statement.trim()).filter(Boolean);
  await db.batch(statements.map((statement) => db.prepare(statement)));
  const auth = `Basic ${btoa("tts:development-only-change-me")}`;
  const start = Date.now() - 15 * 60_000;
  for (let index = 0; index < 4; index += 1) {
    const response = await mf.dispatchFetch("http://local.test/api/ingest", {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        end_device_ids: {
          device_id: "ltc2-lb",
          application_ids: { application_id: "sauna" },
          dev_eui: "A84041A47C61C1E2",
        },
        correlation_ids: [`gs:uplink:smoke-${index}`],
        received_at: new Date(start + index * 5 * 60_000).toISOString(),
        uplink_message: {
          session_key_id: "smoke",
          f_port: 2,
          f_cnt: index,
          decoded_payload: {
            BatV: 3.62,
            Temp_Channel1: 25 + index * 2,
            Temp_Channel2: 70 + index * 15,
          },
          rx_metadata: [{ rssi: -65, snr: 8 }],
        },
      }),
    });
    if (!response.ok) throw new Error(`ingest failed: ${response.status} ${await response.text()}`);
  }

  const duplicate = await mf.dispatchFetch("http://local.test/api/ingest", {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify({
      end_device_ids: {
        device_id: "ltc2-lb",
        application_ids: { application_id: "sauna" },
        dev_eui: "A84041A47C61C1E2",
      },
      correlation_ids: ["gs:uplink:smoke-3"],
      received_at: new Date(start + 15 * 60_000).toISOString(),
      uplink_message: {
        f_port: 2,
        f_cnt: 3,
        decoded_payload: { Temp_Channel1: 31, Temp_Channel2: 115 },
      },
    }),
  });
  const duplicateResult = await duplicate.json();
  if (!duplicateResult.duplicate) throw new Error("duplicate was not suppressed");

  const unauthorized = await mf.dispatchFetch("http://local.test/api/ingest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (unauthorized.status !== 401) throw new Error(`expected 401, got ${unauthorized.status}`);

  const current = await (await mf.dispatchFetch("http://local.test/api/current")).json();
  const history = await (await mf.dispatchFetch("http://local.test/api/history?range=24h&unit=f")).json();
  const sessions = await (await mf.dispatchFetch("http://local.test/api/sessions?months=12")).json();
  if (current.current?.stovepipe?.rate_f_per_min === null) throw new Error("rate was not calculated");
  if (history.points.length !== 8) throw new Error(`expected 8 long-form points, got ${history.points.length}`);
  if (!sessions.active || !sessions.months.some((month) => month.sessions === 1)) {
    throw new Error("session detector did not create an active session");
  }
  console.log(JSON.stringify({ current, history_points: history.points.length, session_active: sessions.active }, null, 2));
} finally {
  await mf.dispose();
}
