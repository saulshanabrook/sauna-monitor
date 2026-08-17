import embed, { type Result } from "vega-embed";
import type { Config, TopLevelSpec } from "vega-lite";
import { projectHeatStatus, type ReadingStatus } from "./heat-status";

type Unit = "f" | "c";
type DisplayTheme = "gray" | "amber-led";
type ColorSchemePreference = "system" | "light" | "dark";

interface Measurement {
  c: number | null;
  f: number | null;
  rate_c_per_min: number | null;
  rate_f_per_min: number | null;
}

interface CurrentPayload {
  site_name: string;
  time_zone: string;
  status: ReadingStatus;
  session_active: boolean;
  current: null | {
    observed_at: string;
    sauna: Measurement;
    stovepipe: Measurement;
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

const state: {
  range: string;
  current: CurrentPayload | null;
  lastObservedAt: string | null;
  targetF: number;
  theme: DisplayTheme;
  colorSchemePreference: ColorSchemePreference;
} = {
  range: "3h",
  current: null,
  lastObservedAt: null,
  targetF: 180,
  theme: "gray",
  colorSchemePreference: "system",
};

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing element #${id}`);
  return found as T;
}

const ui = {
  error: element("error-banner"),
  saunaTemp: element("sauna-temp"),
  pipeTemp: element("pipe-temp"),
  targetTemp: element<HTMLInputElement>("target-temp"),
  heatStateLabel: element("heat-state-label"),
  heatState: element("heat-state"),
  heatDetailRow: element("heat-detail-row"),
  heatDetailLabel: element("heat-detail-label"),
  heatDetail: element("heat-detail"),
  historyCharts: element("history-charts"),
  rangeControls: element("range-controls"),
  colorSchemeControls: element("color-scheme-controls"),
};

const TARGET_STORAGE_KEY = "sauna-time-target-f";
const COLOR_SCHEME_STORAGE_KEY = "sauna-time-color-scheme";
const TARGET_MIN_F = 100;
const TARGET_MAX_F = 220;

const chartPalettes: Record<DisplayTheme, {
  domain: string;
  grid: string;
  ink: string;
  zero: string;
  line: string;
  focus: string;
}> = {
  gray: {
    domain: "#737c76",
    grid: "#adb5aa",
    ink: "#1b2627",
    zero: "#828b84",
    line: "#0c1516",
    focus: "#2d3938",
  },
  "amber-led": {
    domain: "#713907",
    grid: "#2b1705",
    ink: "#f7941d",
    zero: "#713907",
    line: "#f7941d",
    focus: "#ffb347",
  },
};

try {
  const storedTarget = typeof window === "undefined"
    ? Number.NaN
    : Number(window.localStorage.getItem(TARGET_STORAGE_KEY));
  if (Number.isFinite(storedTarget) && storedTarget >= TARGET_MIN_F && storedTarget <= TARGET_MAX_F) {
    state.targetF = storedTarget;
  }
} catch {
  // Local storage can be unavailable in privacy-restricted browser contexts.
}
ui.targetTemp.value = String(state.targetF);

const colorSchemeQuery = typeof window === "undefined" || typeof window.matchMedia !== "function"
  ? null
  : window.matchMedia("(prefers-color-scheme: dark)");

try {
  const storedPreference = typeof window === "undefined"
    ? null
    : window.localStorage.getItem(COLOR_SCHEME_STORAGE_KEY);
  if (storedPreference === "light" || storedPreference === "dark") {
    state.colorSchemePreference = storedPreference;
  }
} catch {
  // Local storage can be unavailable in privacy-restricted browser contexts.
}

function applyColorScheme(preference: ColorSchemePreference, persist: boolean): void {
  const dark = preference === "dark" ||
    (preference === "system" && colorSchemeQuery?.matches === true);
  state.colorSchemePreference = preference;
  state.theme = dark ? "amber-led" : "gray";
  document.documentElement.dataset.colorScheme = dark ? "dark" : "light";
  for (const button of ui.colorSchemeControls.querySelectorAll<HTMLButtonElement>(
    "button[data-color-scheme]",
  )) {
    button.setAttribute("aria-pressed", String(button.dataset.colorScheme === preference));
  }
  if (!persist || typeof window === "undefined") return;
  try {
    if (preference === "system") {
      window.localStorage.removeItem(COLOR_SCHEME_STORAGE_KEY);
    } else {
      window.localStorage.setItem(COLOR_SCHEME_STORAGE_KEY, preference);
    }
  } catch {
    // Keep the control functional even when local storage is unavailable.
  }
}

applyColorScheme(state.colorSchemePreference, false);

function chartConfig(): Config {
  const palette = chartPalettes[state.theme];
  return {
    background: "transparent",
    view: { stroke: null },
    axis: {
      domainColor: palette.domain,
      gridColor: palette.grid,
      labelColor: palette.ink,
      titleColor: palette.ink,
      tickColor: palette.domain,
      labelFont: "DSEG14",
      titleFont: "DSEG14",
      titleFontWeight: 700,
    },
    title: {
      color: palette.ink,
      font: "DSEG14",
      fontSize: 15,
      fontWeight: 700,
      anchor: "start",
      offset: 14,
    },
    style: {
      "guide-label": { font: "DSEG14" },
      "guide-title": { font: "DSEG14" },
    },
  };
}

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

function refreshHeatDisplay(): void {
  const payload = state.current;
  const projection = projectHeatStatus({
    currentF: payload?.current?.sauna.f ?? null,
    observedAtMs: payload?.current ? Date.parse(payload.current.observed_at) : Number.NaN,
    nowMs: Date.now(),
    rateFPerMin: payload?.current?.sauna.rate_f_per_min ?? null,
    sessionActive: payload?.session_active ?? false,
    sourceStatus: payload?.status ?? "offline",
    targetF: state.targetF,
    timeZone: payload?.time_zone ?? "America/New_York",
  });
  const showingEta = projection.state === "eta";
  ui.heatStateLabel.textContent = showingEta ? "HOT IN" : "STATUS";
  ui.heatState.textContent = projection.headline;
  ui.heatState.dataset.state = projection.state;
  ui.heatDetailLabel.textContent = showingEta ? "ESTIMATED HOT" : "ESTIMATE";
  ui.heatDetail.textContent = projection.detail;
  ui.heatDetailRow.hidden = projection.detail.length === 0;
}

function refreshCurrentDisplay(): void {
  const payload = state.current;
  if (!payload?.current) {
    ui.saunaTemp.textContent = "—";
    ui.pipeTemp.textContent = "—";
    refreshHeatDisplay();
    return;
  }

  const sauna = payload.current.sauna;
  const pipe = payload.current.stovepipe;
  ui.saunaTemp.textContent = formatNumber(sauna.f, 0);
  ui.pipeTemp.textContent = formatNumber(pipe.f, 0);
  refreshHeatDisplay();
}

async function loadCurrent(): Promise<boolean> {
  const payload = await fetchJson<CurrentPayload>("/api/current");
  const changed = payload.current?.observed_at !== state.lastObservedAt;
  state.current = payload;
  state.lastObservedAt = payload.current?.observed_at ?? null;
  document.title = payload.site_name;
  refreshCurrentDisplay();
  return changed;
}

function timeAxisFormat(): string {
  if (["1h", "3h", "12h", "24h"].includes(state.range)) return "%I:%M %p";
  if (state.range === "7d") return "%a %m/%d";
  if (state.range === "30d") return "%b %d";
  return "%b %Y";
}

const LINKED_HOVER = "linked_hover";

interface LinkedChartOptions {
  title: string;
  series: HistoryPoint["series"];
  kind: "temperature" | "change";
  height: number;
}

type LinkedChartSpec = Extract<TopLevelSpec, { layer: unknown }>;

function linkedChart(payload: HistoryPayload, options: LinkedChartOptions): LinkedChartSpec {
  const palette = chartPalettes[state.theme];
  const temperature = options.kind === "temperature";
  const valueField = temperature ? "temp_max" : "rate_per_hour";
  const readoutField = temperature ? "temperature_readout" : "rate_readout";
  const x = {
    field: "ts",
    type: "temporal" as const,
    axis: { title: null, format: timeAxisFormat(), labelOverlap: true },
  };
  const y = {
    field: valueField,
    type: "quantitative" as const,
    title: temperature ? `Temperature (${payload.temperature_unit})` : "Change (°F/hour)",
    scale: { zero: !temperature, padding: 18 },
  };
  const selectedOpacity = {
    condition: { param: LINKED_HOVER, empty: false, value: 1 },
    value: 0,
  } as const;
  const layer: LinkedChartSpec["layer"] = [];

  if (!temperature) {
    layer.push({
      mark: { type: "rule", color: palette.zero, strokeDash: [5, 5] },
      encoding: { y: { datum: 0 } },
    });
  }

  layer.push(
    {
      mark: { type: "line", color: palette.line, strokeWidth: 2.2, interpolate: "linear" },
      encoding: { x, y, detail: { field: "segment" } },
    },
    {
      params: [{
        name: LINKED_HOVER,
        select: {
          type: "point",
          fields: ["ts"],
          on: "mousemove, click",
          nearest: true,
          clear: false,
          toggle: false,
        },
      }],
      mark: { type: "point", opacity: 0, size: 90 },
      encoding: { x },
    },
    {
      mark: { type: "rule", color: palette.focus, strokeWidth: 1.5 },
      encoding: { x, opacity: selectedOpacity },
    },
    {
      mark: { type: "point", color: palette.focus, filled: true, size: 60 },
      encoding: { x, y, opacity: selectedOpacity },
    },
    {
      mark: {
        type: "text",
        align: { expr: "datum.readout_align" },
        baseline: "top",
        color: palette.focus,
        dx: { expr: "datum.readout_dx" },
        dy: 6,
        font: "DSEG14",
        fontSize: 13,
      },
      encoding: {
        x,
        y: { value: 0 },
        text: { field: "ts", type: "temporal", format: "%b %d, %Y %I:%M %p" },
        opacity: selectedOpacity,
      },
    },
    {
      mark: {
        type: "text",
        align: { expr: "datum.readout_align" },
        baseline: "top",
        color: palette.focus,
        dx: { expr: "datum.readout_dx" },
        dy: 25,
        font: "DSEG14",
        fontSize: 15,
        fontWeight: 700,
      },
      encoding: {
        x,
        y: { value: 0 },
        text: { field: readoutField, type: "nominal" },
        opacity: selectedOpacity,
      },
    },
  );

  return {
    title: options.title,
    width: "container",
    height: options.height,
    transform: [
      { filter: { field: "series", equal: options.series } },
      ...(!temperature ? [{ filter: "isValid(datum.rate_per_hour)" }] : []),
    ],
    layer,
  };
}

let fittedChartContainerWidth: number | null = null;
let historyChartView: Result["view"] | null = null;

function fitChartCanvas(force = false): void {
  const canvas = ui.historyCharts.querySelector<HTMLCanvasElement>("canvas");
  if (
    !canvas ||
    canvas.offsetWidth <= 0 ||
    canvas.offsetHeight <= 0 ||
    ui.historyCharts.clientWidth <= 0
  ) return;

  const containerWidth = ui.historyCharts.clientWidth;
  if (!force && fittedChartContainerWidth === containerWidth) return;

  const scale = Math.min(1, containerWidth / canvas.offsetWidth);
  canvas.style.transformOrigin = "top left";
  canvas.style.transform = `scale(${scale})`;
  ui.historyCharts.style.height = `${canvas.offsetHeight * scale}px`;
  fittedChartContainerWidth = containerWidth;
}

const chartResizeObserver = typeof ResizeObserver === "undefined"
  ? null
  : new ResizeObserver(() => {
    if (
      ui.historyCharts.clientWidth <= 0 ||
      fittedChartContainerWidth === ui.historyCharts.clientWidth
    ) return;

    const view = historyChartView;
    if (!view) {
      fitChartCanvas();
      return;
    }
    void view.resize().runAsync().then(
      () => {
        if (view === historyChartView) fitChartCanvas(true);
      },
      () => {
        if (view === historyChartView) fitChartCanvas(true);
      },
    );
  });
chartResizeObserver?.observe(ui.historyCharts);

async function loadHistory(): Promise<void> {
  const payload = await fetchJson<HistoryPayload>(
    `/api/history?range=${encodeURIComponent(state.range)}&unit=f`,
  );
  if (payload.points.length === 0) {
    ui.historyCharts.textContent = "No history yet";
    ui.historyCharts.classList.add("chart-empty");
    return;
  }

  ui.historyCharts.classList.remove("chart-empty");
  const timestamps = payload.points
    .map((point) => Date.parse(point.ts))
    .filter(Number.isFinite);
  const firstTimestamp = Math.min(...timestamps);
  const lastTimestamp = Math.max(...timestamps);
  const readoutFlipTimestamp = firstTimestamp + (lastTimestamp - firstTimestamp) * 0.72;
  const values = payload.points.map((point) => {
    const ratePerHour = point.rate === null ? null : point.rate * 60;
    const readoutOnLeft = lastTimestamp > firstTimestamp && Date.parse(point.ts) >= readoutFlipTimestamp;
    return {
      ...point,
      rate_per_hour: ratePerHour,
      readout_align: readoutOnLeft ? "right" : "left",
      readout_dx: readoutOnLeft ? -10 : 10,
      temperature_readout: point.temp_min === point.temp_max
        ? `${point.temp_max.toFixed(1)} ${payload.temperature_unit}`
        : `${point.temp_min.toFixed(1)}–${point.temp_max.toFixed(1)} ${payload.temperature_unit}`,
      rate_readout: ratePerHour === null
        ? null
        : `${ratePerHour > 0 ? "+" : ""}${ratePerHour.toFixed(1)} °F/hour`,
    };
  });
  const spec: TopLevelSpec = {
    $schema: "https://vega.github.io/schema/vega-lite/v6.json",
    data: { values },
    vconcat: [
      linkedChart(payload, {
        title: "Air",
        series: "Sauna air",
        kind: "temperature",
        height: 260,
      }),
      linkedChart(payload, {
        title: "Air change",
        series: "Sauna air",
        kind: "change",
        height: 180,
      }),
      linkedChart(payload, {
        title: "Stovepipe",
        series: "Stovepipe",
        kind: "temperature",
        height: 260,
      }),
      linkedChart(payload, {
        title: "Stovepipe change",
        series: "Stovepipe",
        kind: "change",
        height: 180,
      }),
    ],
    spacing: 52,
    resolve: { scale: { x: "shared", y: "independent" } },
    config: chartConfig(),
  };
  const result = await embed(ui.historyCharts, spec, { actions: false, renderer: "canvas", ast: true });
  historyChartView = result.view;
  fitChartCanvas(true);
}

async function loadDashboard(): Promise<void> {
  setError(null);
  try {
    if ("fonts" in document) await document.fonts.ready;
    await Promise.all([loadCurrent(), loadHistory()]);
  } catch (error) {
    setError(error instanceof Error ? `Dashboard data could not be loaded: ${error.message}` : "Dashboard data could not be loaded");
  }
}

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

ui.colorSchemeControls.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>(
    "button[data-color-scheme]",
  );
  const preference = button?.dataset.colorScheme;
  if (
    preference !== "system" &&
    preference !== "light" &&
    preference !== "dark"
  ) return;
  const previousTheme = state.theme;
  applyColorScheme(preference, true);
  if (state.theme === previousTheme) return;
  void loadHistory().catch((error: unknown) => {
    setError(error instanceof Error ? error.message : "History could not be loaded");
  });
});

colorSchemeQuery?.addEventListener("change", () => {
  if (state.colorSchemePreference !== "system") return;
  const previousTheme = state.theme;
  applyColorScheme("system", false);
  if (state.theme === previousTheme) return;
  void loadHistory().catch((error: unknown) => {
    setError(error instanceof Error ? error.message : "History could not be loaded");
  });
});

ui.targetTemp.addEventListener("input", () => {
  const target = Number(ui.targetTemp.value);
  if (!Number.isFinite(target) || target < TARGET_MIN_F || target > TARGET_MAX_F) return;
  state.targetF = target;
  try {
    if (typeof window !== "undefined") window.localStorage.setItem(TARGET_STORAGE_KEY, String(target));
  } catch {
    // Keep the control functional even when local storage is unavailable.
  }
  refreshHeatDisplay();
});

ui.targetTemp.addEventListener("change", () => {
  const target = Number(ui.targetTemp.value);
  if (!Number.isFinite(target) || target < TARGET_MIN_F || target > TARGET_MAX_F) {
    ui.targetTemp.value = String(state.targetF);
  }
});

setInterval(() => {
  void loadCurrent().then((changed) => {
    if (changed) return loadHistory();
    return undefined;
  }).catch(() => {
    if (state.current) refreshCurrentDisplay();
  });
}, 60_000);

void loadDashboard();
