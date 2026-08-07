import embed, { type VisualizationSpec } from "vega-embed";
import type { Config } from "vega-lite";

type Unit = "f" | "c";
type Status = "live" | "delayed" | "stale" | "offline";

interface Measurement {
  c: number | null;
  f: number | null;
  rate_c_per_min: number | null;
  rate_f_per_min: number | null;
}

interface CurrentPayload {
  site_name: string;
  status: Status;
  expected_interval_seconds: number;
  stale_after_seconds: number;
  session_active: boolean;
  current: null | {
    observed_at: string;
    age_seconds: number;
    sauna: Measurement;
    stovepipe: Measurement;
    battery_v: number | null;
    signal: { rssi_dbm: number | null; snr_db: number | null };
  };
}

interface HistoryPoint {
  ts: string;
  series: "Sauna air" | "Stovepipe";
  temp: number;
  temp_min: number;
  temp_max: number;
  rate: number | null;
  segment: number;
}

interface HistoryPayload {
  range: string;
  bucket_seconds: number;
  unit: Unit;
  temperature_unit: string;
  rate_unit: string;
  points: HistoryPoint[];
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

interface SessionsPayload {
  timezone: string;
  active: boolean;
  months: MonthSummary[];
}

const state: {
  unit: Unit;
  range: string;
  current: CurrentPayload | null;
  lastObservedAt: string | null;
} = {
  unit: "f",
  range: "24h",
  current: null,
  lastObservedAt: null,
};

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing element #${id}`);
  return found as T;
}

const ui = {
  siteName: element("site-name"),
  statusBadge: element("status-badge"),
  statusText: element("status-text"),
  unitSelect: element<HTMLSelectElement>("unit-select"),
  error: element("error-banner"),
  saunaTemp: element("sauna-temp"),
  saunaUnit: element("sauna-unit"),
  saunaRate: element("sauna-rate"),
  pipeTemp: element("pipe-temp"),
  pipeUnit: element("pipe-unit"),
  pipeRate: element("pipe-rate"),
  heatingRate: element("heating-rate"),
  sessionState: element("session-state"),
  lastUpdated: element("last-updated"),
  battery: element("battery"),
  temperatureChart: element("temperature-chart"),
  rateChart: element("rate-chart"),
  sessionsChart: element("sessions-chart"),
  sessionSummary: element("session-summary"),
  rangeControls: element("range-controls"),
};

const chartConfig: Config = {
  background: "transparent",
  view: { stroke: null },
  axis: {
    domainColor: "#6f6257",
    gridColor: "#443a32",
    labelColor: "#bcae9f",
    titleColor: "#d9cec2",
    tickColor: "#6f6257",
    labelFont: "system-ui",
    titleFont: "system-ui",
    titleFontWeight: 600,
  },
  legend: {
    labelColor: "#d9cec2",
    labelFont: "system-ui",
    orient: "top",
    direction: "horizontal",
    title: null,
  },
  style: { "guide-label": { font: "system-ui" }, "guide-title": { font: "system-ui" } },
};

const seriesScale = {
  domain: ["Sauna air", "Stovepipe"],
  range: ["#f3b562", "#ee6c4d"],
};

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
  return response.json() as Promise<T>;
}

function setError(message: string | null): void {
  ui.error.hidden = message === null;
  ui.error.textContent = message ?? "";
}

function formatNumber(value: number | null, digits = 1): string {
  return value === null || !Number.isFinite(value) ? "—" : value.toFixed(digits);
}

function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds} seconds ago`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)} minutes ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)} hours ago`;
  return `${Math.floor(seconds / 86_400)} days ago`;
}

function displayedMeasurement(measurement: Measurement): { temp: number | null; rate: number | null } {
  return state.unit === "f"
    ? { temp: measurement.f, rate: measurement.rate_f_per_min }
    : { temp: measurement.c, rate: measurement.rate_c_per_min };
}

function statusForAge(ageSeconds: number, current: CurrentPayload): Status {
  if (ageSeconds <= current.expected_interval_seconds * 2) return "live";
  if (ageSeconds <= current.stale_after_seconds) return "delayed";
  return "stale";
}

function refreshCurrentDisplay(): void {
  const payload = state.current;
  const unitLabel = state.unit === "f" ? "°F" : "°C";
  const rateLabel = state.unit === "f" ? "°F/min" : "°C/min";
  ui.saunaUnit.textContent = unitLabel;
  ui.pipeUnit.textContent = unitLabel;
  if (!payload?.current) {
    ui.statusBadge.className = "status-badge status-offline";
    ui.statusText.textContent = "Waiting for data";
    ui.saunaTemp.textContent = "—";
    ui.pipeTemp.textContent = "—";
    ui.heatingRate.textContent = "—";
    return;
  }

  const ageSeconds = Math.max(0, Math.floor((Date.now() - Date.parse(payload.current.observed_at)) / 1_000));
  const status = statusForAge(ageSeconds, payload);
  const statusLabel = status === "live" ? "Live" : status === "delayed" ? "Delayed" : "Stale";
  ui.statusBadge.className = `status-badge status-${status}`;
  ui.statusText.textContent = `${statusLabel} · ${formatAge(ageSeconds)}`;
  document.body.classList.toggle("is-stale", status === "stale");

  const sauna = displayedMeasurement(payload.current.sauna);
  const pipe = displayedMeasurement(payload.current.stovepipe);
  ui.saunaTemp.textContent = formatNumber(sauna.temp, 1);
  ui.pipeTemp.textContent = formatNumber(pipe.temp, 1);
  ui.saunaRate.textContent = sauna.rate === null
    ? "Collecting 15-minute trend…"
    : `${sauna.rate >= 0 ? "+" : ""}${formatNumber(sauna.rate, 2)} ${rateLabel}`;
  ui.pipeRate.textContent = pipe.rate === null
    ? "Collecting 15-minute trend…"
    : `${pipe.rate >= 0 ? "+" : ""}${formatNumber(pipe.rate, 2)} ${rateLabel}`;
  ui.heatingRate.textContent = pipe.rate === null
    ? "Collecting…"
    : `${pipe.rate >= 0 ? "+" : ""}${formatNumber(pipe.rate, 2)} ${rateLabel}`;
  ui.sessionState.textContent = payload.session_active
    ? "Sauna heating session active"
    : "No active heating session";
  ui.lastUpdated.textContent = `Last reading ${formatAge(ageSeconds)}`;
  ui.battery.textContent = `Battery ${formatNumber(payload.current.battery_v, 2)} V`;
}

async function loadCurrent(): Promise<boolean> {
  const payload = await fetchJson<CurrentPayload>("/api/current");
  const changed = payload.current?.observed_at !== state.lastObservedAt;
  state.current = payload;
  state.lastObservedAt = payload.current?.observed_at ?? null;
  ui.siteName.textContent = payload.site_name;
  document.title = payload.site_name;
  refreshCurrentDisplay();
  return changed;
}

function timeAxisFormat(): string {
  if (state.range === "24h") return "%a %I:%M %p";
  if (state.range === "7d") return "%a %m/%d";
  if (state.range === "30d" || state.range === "90d") return "%b %d";
  return "%b %Y";
}

function emptyChart(target: HTMLElement, message: string): void {
  target.replaceChildren();
  target.classList.add("chart-empty");
  const paragraph = document.createElement("p");
  paragraph.textContent = message;
  target.append(paragraph);
}

async function renderTemperatureChart(payload: HistoryPayload): Promise<void> {
  if (payload.points.length === 0) {
    emptyChart(ui.temperatureChart, "No temperature history yet");
    return;
  }
  ui.temperatureChart.classList.remove("chart-empty");
  const spec: VisualizationSpec = {
    $schema: "https://vega.github.io/schema/vega-lite/v6.json",
    width: "container",
    height: 300,
    autosize: { type: "fit", contains: "padding", resize: true },
    data: { values: payload.points },
    layer: [
      {
        mark: { type: "area", opacity: 0.12 },
        encoding: {
          x: { field: "ts", type: "temporal", axis: { title: null, format: timeAxisFormat(), labelOverlap: true } },
          y: { field: "temp_min", type: "quantitative", title: `Temperature (${payload.temperature_unit})`, scale: { zero: false } },
          y2: { field: "temp_max" },
          color: { field: "series", type: "nominal", scale: seriesScale },
          detail: [{ field: "series" }, { field: "segment" }],
        },
      },
      {
        mark: { type: "line", strokeWidth: 2.4, interpolate: "linear" },
        encoding: {
          x: { field: "ts", type: "temporal", axis: { title: null, format: timeAxisFormat(), labelOverlap: true } },
          y: { field: "temp", type: "quantitative", title: `Temperature (${payload.temperature_unit})`, scale: { zero: false } },
          color: { field: "series", type: "nominal", scale: seriesScale },
          detail: [{ field: "series" }, { field: "segment" }],
          tooltip: [
            { field: "ts", type: "temporal", title: "Time", format: "%b %d, %Y %I:%M %p" },
            { field: "series", type: "nominal", title: "Sensor" },
            { field: "temp", type: "quantitative", title: payload.temperature_unit, format: ".1f" },
            { field: "temp_min", type: "quantitative", title: "Minimum", format: ".1f" },
            { field: "temp_max", type: "quantitative", title: "Maximum", format: ".1f" },
          ],
        },
      },
    ],
    config: chartConfig,
  };
  await embed(ui.temperatureChart, spec, { actions: false, renderer: "canvas" });
}

async function renderRateChart(payload: HistoryPayload): Promise<void> {
  const rated = payload.points.filter((point) => point.rate !== null);
  if (rated.length === 0) {
    emptyChart(ui.rateChart, "Three readings over at least eight minutes are needed to calculate a trend");
    return;
  }
  ui.rateChart.classList.remove("chart-empty");
  const spec: VisualizationSpec = {
    $schema: "https://vega.github.io/schema/vega-lite/v6.json",
    width: "container",
    height: 220,
    autosize: { type: "fit", contains: "padding", resize: true },
    data: { values: rated },
    layer: [
      {
        mark: { type: "rule", color: "#74675c", strokeDash: [5, 5] },
        encoding: { y: { datum: 0 } },
      },
      {
        mark: { type: "line", strokeWidth: 2.2, interpolate: "linear" },
        encoding: {
          x: { field: "ts", type: "temporal", axis: { title: null, format: timeAxisFormat(), labelOverlap: true } },
          y: { field: "rate", type: "quantitative", title: `15-minute trend (${payload.rate_unit})` },
          color: { field: "series", type: "nominal", scale: seriesScale, legend: null },
          detail: [{ field: "series" }, { field: "segment" }],
          tooltip: [
            { field: "ts", type: "temporal", title: "Time", format: "%b %d, %Y %I:%M %p" },
            { field: "series", type: "nominal", title: "Sensor" },
            { field: "rate", type: "quantitative", title: payload.rate_unit, format: "+.2f" },
          ],
        },
      },
    ],
    config: chartConfig,
  };
  await embed(ui.rateChart, spec, { actions: false, renderer: "canvas" });
}

async function loadHistory(): Promise<void> {
  const payload = await fetchJson<HistoryPayload>(
    `/api/history?range=${encodeURIComponent(state.range)}&unit=${state.unit}`,
  );
  await Promise.all([renderTemperatureChart(payload), renderRateChart(payload)]);
}

async function loadSessions(): Promise<void> {
  const payload = await fetchJson<SessionsPayload>("/api/sessions?months=12");
  const total = payload.months.reduce((sum, month) => sum + month.sessions, 0);
  ui.sessionSummary.textContent = `${total} session${total === 1 ? "" : "s"} in the last 12 calendar months`;
  if (payload.months.every((month) => month.sessions === 0)) {
    emptyChart(ui.sessionsChart, "No inferred sauna sessions yet");
    return;
  }
  ui.sessionsChart.classList.remove("chart-empty");
  const spec: VisualizationSpec = {
    $schema: "https://vega.github.io/schema/vega-lite/v6.json",
    width: "container",
    height: 220,
    autosize: { type: "fit", contains: "padding", resize: true },
    data: { values: payload.months },
    mark: { type: "bar", cornerRadiusTopLeft: 4, cornerRadiusTopRight: 4 },
    encoding: {
      x: { field: "label", type: "ordinal", sort: { field: "month" }, axis: { title: null, labelAngle: -35 } },
      y: { field: "sessions", type: "quantitative", title: "Sessions", axis: { tickMinStep: 1 } },
      color: {
        condition: { test: "datum.partial", value: "#8a7060" },
        value: "#f3b562",
        legend: null,
      },
      tooltip: [
        { field: "label", type: "nominal", title: "Month" },
        { field: "sessions", type: "quantitative", title: "Sessions" },
        { field: "total_hours", type: "quantitative", title: "Inferred hours", format: ".1f" },
        { field: "average_duration_minutes", type: "quantitative", title: "Average minutes", format: ".0f" },
      ],
    },
    config: chartConfig,
  };
  await embed(ui.sessionsChart, spec, { actions: false, renderer: "canvas" });
}

async function loadDashboard(): Promise<void> {
  setError(null);
  try {
    await Promise.all([loadCurrent(), loadHistory(), loadSessions()]);
  } catch (error) {
    setError(error instanceof Error ? `Dashboard data could not be loaded: ${error.message}` : "Dashboard data could not be loaded");
  }
}

ui.unitSelect.addEventListener("change", () => {
  state.unit = ui.unitSelect.value === "c" ? "c" : "f";
  refreshCurrentDisplay();
  void loadHistory().catch((error: unknown) => {
    setError(error instanceof Error ? error.message : "History could not be loaded");
  });
});

ui.rangeControls.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-range]");
  if (!button?.dataset.range) return;
  state.range = button.dataset.range;
  for (const candidate of ui.rangeControls.querySelectorAll("button[data-range]")) {
    candidate.setAttribute("aria-pressed", String(candidate === button));
  }
  void loadHistory().catch((error: unknown) => {
    setError(error instanceof Error ? error.message : "History could not be loaded");
  });
});

setInterval(refreshCurrentDisplay, 30_000);
setInterval(() => {
  void loadCurrent().then((changed) => {
    if (changed) return Promise.all([loadHistory(), loadSessions()]);
    return undefined;
  }).catch(() => {
    if (state.current) refreshCurrentDisplay();
  });
}, 60_000);

void loadDashboard();
