# Sauna Monitor

A low-maintenance Cloudflare Worker for the Dragino LTC2-LB sauna monitor. It receives decoded uplinks from The Things Stack, stores compact readings in D1, calculates smoothed temperature trends, infers heating sessions, and serves a public Vega-Lite dashboard.

## What it provides

- Authenticated `POST /api/ingest` endpoint for the TTS custom webhook
- Permanent compact readings in D1, with duplicate suppression
- Configurable Channel 1/Channel 2 mapping
- Current sauna-air and stovepipe temperatures
- Trailing 15-minute least-squares rates in °C/min and °F/min
- Responsive history with server-side downsampling and min/max peak preservation
- Configurable inferred sauna sessions and month-by-month counts
- Stale-data indication based on the expected transmission interval
- A bundled Vega/Vega-Lite dashboard with no runtime CDN dependency

The database stores Celsius and UTC timestamps. Fahrenheit and local-time presentation are derived at query/display time.

## Architecture

```text
LTC2-LB → LPS8N gateway → The Things Stack
                                   │ HTTPS JSON webhook
                                   ▼
                         Cloudflare Worker
                           ├─ D1 readings/sessions
                           ├─ public JSON APIs
                           └─ static Vega-Lite dashboard
```

## Deploy

Requirements: Node.js 22 or newer and a Cloudflare account.

```bash
npm install
npx wrangler login
npm run db:create
npm run db:migrate:remote
npm run deploy
npx wrangler secret put WEBHOOK_PASSWORD
```

For `WEBHOOK_PASSWORD`, use a random value and save it for the TTS setup:

```bash
openssl rand -base64 32
```

`db:create` asks Wrangler to create `sauna-monitor-db` and write its database ID into `wrangler.jsonc`. If Wrangler reports that the existing binding cannot be updated automatically, run `npx wrangler d1 create sauna-monitor-db`, then copy the returned `database_id` into the `DB` entry in `wrangler.jsonc`.

The deployment prints a public URL similar to:

```text
https://sauna-monitor.<your-workers-subdomain>.workers.dev
```

### Confirm the channel mapping

The supplied configuration assumes:

```text
Temp_Channel1 → sauna air
Temp_Channel2 → stovepipe
```

Before relying on the labels, warm one probe by hand and watch the decoded TTS values. If Channel 2 is the sauna-air probe, swap these values in `wrangler.jsonc` and redeploy:

```json
"SAUNA_CHANNEL": "2",
"STOVEPIPE_CHANNEL": "1"
```

## Configure The Things Stack

In the `sauna` application:

1. Open **Integrations → Webhooks → Add webhook → Custom webhook**.
2. Set **Webhook format** to `JSON`.
3. Set **Base URL** to the deployed Worker URL.
4. Set the **Uplink message path** to `/api/ingest`.
5. Enable only **Uplink message**.
6. Enable **Request authentication**.
7. Set username to `tts`.
8. Set password to the exact value stored as `WEBHOOK_PASSWORD`.
9. Leave **Downlink API key** blank.

Do not put the LTC2-LB AppKey in Cloudflare. It remains in The Things Stack.

The webhook can be tested by waiting for the next uplink, or by posting `samples/tts-uplink.json` with Basic authentication. The sample has an old timestamp, so it is intended for ingestion testing rather than the live display.

## Local development

```bash
cp .dev.vars.example .dev.vars
npm install
npm run db:migrate:local
npm run dev
```

In another terminal, load a synthetic heating cycle ending near the current time:

```bash
npm run seed:local
```

Then open <http://localhost:8787>. Re-running the seed is safe: its stable message identifiers suppress duplicates for the same generated timestamps.

Run all checks with:

```bash
npm run check
```

## Public APIs

- `GET /api/current` — latest temperatures, rates, battery, freshness and active-session state
- `GET /api/history?range=24h&unit=f` — long-form chart data; ranges are `24h`, `7d`, `30d`, `90d`, `1y`, or `all`
- `GET /api/sessions?months=12` — month-by-month inferred session totals
- `GET /api/health` — Worker/D1 health check

Only `/api/ingest` accepts writes, and it requires the webhook credentials.

## Rate calculation

Each new reading receives a slope calculated from valid samples in its trailing 15-minute window:

```text
slope = Σ((time - mean_time) × (temperature - mean_temperature))
        --------------------------------------------------------
                       Σ((time - mean_time)²)
```

Actual timestamps are used, so one missing transmission does not create a false five-minute assumption. At least three readings spanning eight minutes are required. A gap greater than 2.5 expected reporting intervals begins a new rate segment.

## Session detection and calibration

The defaults are deliberately analytics thresholds, not safety thresholds:

```text
Start: two consecutive stovepipe readings at or above 75°C
End: stovepipe below 50°C continuously for 45 minutes
```

Adjust these in `wrangler.jsonc` after recording several real fires:

- `SESSION_START_PIPE_C`
- `SESSION_END_PIPE_C`
- `SESSION_END_HOLD_MINUTES`

Raw readings remain intact, so the detector can be rebuilt later if the thresholds change. This initial version applies new thresholds to future readings; existing inferred session rows are not automatically rewritten.

## Other configuration

- `EXPECTED_INTERVAL_SECONDS`: currently `300` for five-minute uplinks
- `RATE_WINDOW_MINUTES`: trailing regression window
- `RATE_MIN_SPAN_MINUTES`: minimum time covered before displaying a rate
- `REPORT_TIME_ZONE`: month grouping, currently `America/New_York`
- `SITE_NAME`: public dashboard title
- `EXPECTED_APPLICATION_ID` and `EXPECTED_DEV_EUI`: reject authenticated data from another source

If the LTC2-LB is still transmitting every 20 minutes, change `EXPECTED_INTERVAL_SECONDS` to `1200`. Otherwise normal reports will appear stale.

## Exporting the long-term archive

D1 does not expire these rows automatically. Export a portable SQL snapshot whenever desired:

```bash
npx wrangler d1 export sauna-monitor-db --remote --output=sauna-monitor-backup.sql
```

A scheduled D1-to-R2 backup can be added later without changing the ingestion or dashboard design.

## Safety

This dashboard, its session detector, and its rate calculations are informational. Packet loss, battery failure, internet failure, gateway failure, configuration errors, or delayed readings can make it stale or incorrect. Do not use it as the stovepipe overfire alarm; keep that alarm local and independent.

