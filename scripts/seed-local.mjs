const baseUrl = process.env.SAUNA_MONITOR_URL ?? "http://localhost:8787";
const username = process.env.WEBHOOK_USERNAME ?? "tts";
const password = process.env.WEBHOOK_PASSWORD ?? "development-only-change-me";
const intervalMinutes = 5;
const samples = 96;
const end = Date.now();
const start = end - (samples - 1) * intervalMinutes * 60_000;

function temperatures(elapsedMinutes) {
  const fireAge = elapsedMinutes - 90;
  if (fireAge < 0 || fireAge > 210) return { sauna: 24, pipe: 25 };
  if (fireAge <= 30) {
    return {
      sauna: 24 + fireAge * 0.7,
      pipe: 25 + fireAge * 7.8,
    };
  }
  if (fireAge <= 90) {
    return {
      sauna: 45 + (fireAge - 30) * 0.78,
      pipe: 259 - (fireAge - 30) * 0.65,
    };
  }
  if (fireAge <= 165) {
    return {
      sauna: 91.8 - (fireAge - 90) * 0.62,
      pipe: 220 - (fireAge - 90) * 2.35,
    };
  }
  return {
    sauna: Math.max(24, 45.3 - (fireAge - 165) * 0.47),
    pipe: Math.max(25, 43.8 - (fireAge - 165) * 0.42),
  };
}

let inserted = 0;
for (let index = 0; index < samples; index += 1) {
  const observedAt = start + index * intervalMinutes * 60_000;
  const { sauna, pipe } = temperatures(index * intervalMinutes);
  const body = {
    end_device_ids: {
      device_id: "ltc2-lb",
      application_ids: { application_id: "sauna" },
      dev_eui: "A84041A47C61C1E2",
    },
    correlation_ids: [`gs:uplink:local-seed-${observedAt}`],
    received_at: new Date(observedAt).toISOString(),
    uplink_message: {
      session_key_id: "local-seed-session",
      f_port: 2,
      f_cnt: index + 1,
      decoded_payload: {
        BatV: 3.62 - index * 0.0001,
        Temp_Channel1: Number(sauna.toFixed(1)),
        Temp_Channel2: Number(pipe.toFixed(1)),
      },
      rx_metadata: [{ rssi: -67, snr: 8.5 }],
    },
  };
  const response = await fetch(`${baseUrl}/api/ingest`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${username}:${password}`)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`Seed request ${index + 1} failed: ${response.status} ${await response.text()}`);
  }
  const result = await response.json();
  if (result.stored) inserted += 1;
}

console.log(`Seed complete: ${inserted} new readings sent to ${baseUrl}`);

