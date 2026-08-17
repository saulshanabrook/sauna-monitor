import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { View, Warn, logger, parse } from "vega";
import embed from "vega-embed";
import { compile } from "vega-lite";

vi.mock("vega-embed", () => ({
  default: vi.fn(async () => ({ view: null })),
}));

class FakeClassList {
  add() {}
  remove() {}
  toggle() { return false; }
}

class FakeElement {
  classList = new FakeClassList();
  clientWidth = 0;
  dataset = {};
  className = "";
  hidden = false;
  offsetHeight = 0;
  offsetWidth = 0;
  style = {};
  textContent = "";
  value = "f";

  addEventListener() {}
  append() {}
  querySelector() { return null; }
  replaceChildren() {}
  querySelectorAll() { return []; }
}

function jsonResponse(value) {
  return {
    ok: true,
    json: async () => value,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("frontend Content Security Policy", () => {
  it("renders every Vega chart through the AST interpreter", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-08-17T15:40:00Z"));
    let resizeCharts;
    class FakeResizeObserver {
      constructor(callback) { resizeCharts = callback; }
      observe() {}
    }
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    let colorSchemeChange;
    const colorSchemeQuery = {
      matches: true,
      addEventListener: (_type, listener) => { colorSchemeChange = listener; },
    };
    const elements = new Map();
    const fakeDocument = {
      body: new FakeElement(),
      title: "",
      createElement: () => new FakeElement(),
      getElementById: (id) => {
        const existing = elements.get(id);
        if (existing) return existing;
        const created = new FakeElement();
        elements.set(id, created);
        return created;
      },
    };
    vi.stubGlobal("window", {
      addEventListener() {},
      removeEventListener() {},
      matchMedia: () => colorSchemeQuery,
      localStorage: {
        getItem: () => null,
        setItem() {},
      },
    });
    const historyCharts = fakeDocument.getElementById("history-charts");
    const chartCanvas = new FakeElement();
    const chartView = {
      resize: vi.fn(),
      runAsync: vi.fn(async () => {
        if (historyCharts.clientWidth === 1_080) {
          chartCanvas.offsetWidth = 1_178;
          chartCanvas.offsetHeight = 1_234;
        } else {
          chartCanvas.offsetWidth = 528;
          chartCanvas.offsetHeight = 1_238;
        }
        return chartView;
      }),
    };
    chartView.resize.mockReturnValue(chartView);
    embed.mockResolvedValueOnce({ view: chartView });
    historyCharts.clientWidth = 366;
    chartCanvas.offsetWidth = 528;
    chartCanvas.offsetHeight = 1_238;
    historyCharts.querySelector = (selector) => selector === "canvas" ? chartCanvas : null;
    vi.stubGlobal("document", fakeDocument);
    vi.stubGlobal("setInterval", vi.fn());
    vi.stubGlobal("fetch", vi.fn(async (input) => {
      const url = String(input);
      if (url.startsWith("/api/current")) {
        return jsonResponse({
          site_name: "Sauna Time",
          time_zone: "America/New_York",
          rate_window_minutes: 15,
          status: "live",
          expected_interval_seconds: 300,
          stale_after_seconds: 1_200,
          session_active: true,
          current: {
            observed_at: "2026-08-17T15:40:00.000Z",
            age_seconds: 0,
            sauna: { c: 48.89, f: 120, rate_c_per_min: 0.222, rate_f_per_min: 0.4 },
            stovepipe: { c: 159.9, f: 319.82, rate_c_per_min: -0.809, rate_f_per_min: -1.457 },
            battery_v: 3.612,
            signal: { rssi_dbm: -79, snr_db: 14.2 },
          },
        });
      }
      if (url.startsWith("/api/history")) {
        return jsonResponse({
          range: "3h",
          bucket_seconds: 300,
          unit: "f",
          temperature_unit: "°F",
          rate_unit: "°F/min",
          points: [
            { ts: "2026-08-16T20:05:36.935Z", series: "Sauna air", temp: 184.1, temp_min: 184.1, temp_max: 184.1, rate: -0.036, segment: 0 },
            { ts: "2026-08-16T20:10:36.935Z", series: "Sauna air", temp: 182, temp_min: 180, temp_max: 184, rate: -0.02, segment: 0 },
            { ts: "2026-08-16T20:05:36.935Z", series: "Stovepipe", temp: 319.82, temp_min: 319.82, temp_max: 319.82, rate: -1.457, segment: 0 },
          ],
        });
      }
      return jsonResponse({
        timezone: "America/New_York",
        active: true,
        months: [{
          month: "2026-08",
          label: "Aug 2026",
          sessions: 3,
          total_hours: 21.3,
          average_duration_minutes: 427,
          partial: true,
          complete_sessions: 2,
        }],
      });
    }));

    await import("../frontend/app");

    await vi.waitFor(() => expect(embed).toHaveBeenCalledTimes(1));
    const [target, spec, options] = embed.mock.calls[0];
    expect(target).toBe(elements.get("history-charts"));
    expect(options).toMatchObject({
      actions: false,
      renderer: "canvas",
      ast: true,
    });
    expect(spec.config.axis.gridColor).toBe("#2b1705");
    expect(spec.config.axis.labelColor).toBe("#f7941d");
    expect(spec.vconcat[0].layer[0].mark.color).toBe("#f7941d");
    expect(spec.vconcat[0].layer.find((layer) => layer.mark?.type === "rule").mark.color)
      .toBe("#ffb347");
    expect(chartCanvas.style.transformOrigin).toBe("top left");
    expect(chartCanvas.style.transform).toBe(`scale(${366 / 528})`);
    expect(Number.parseFloat(historyCharts.style.height)).toBeCloseTo(1_238 * 366 / 528);
    expect(resizeCharts).toBeTypeOf("function");
    historyCharts.clientWidth = 1_080;
    resizeCharts();
    await vi.waitFor(() => expect(chartView.runAsync).toHaveBeenCalledTimes(1));
    expect(chartView.resize).toHaveBeenCalledTimes(1);
    expect(chartCanvas.style.transform).toBe(`scale(${1_080 / 1_178})`);
    expect(Number.parseFloat(historyCharts.style.height)).toBeCloseTo(1_234 * 1_080 / 1_178);
    historyCharts.clientWidth = 366;
    resizeCharts();
    await vi.waitFor(() => expect(chartView.runAsync).toHaveBeenCalledTimes(2));
    expect(chartCanvas.style.transform).toBe(`scale(${366 / 528})`);
    expect(Number.parseFloat(historyCharts.style.height)).toBeCloseTo(1_238 * 366 / 528);
    expect(fetch).toHaveBeenCalledWith(
      "/api/history?range=3h&unit=f",
      expect.objectContaining({ headers: { Accept: "application/json" } }),
    );
    expect(spec.vconcat).toHaveLength(4);
    expect(elements.get("sauna-temp").textContent).toBe("120");
    expect(elements.get("pipe-temp").textContent).toBe("320");
    expect(elements.get("heat-state-label").textContent).toBe("HOT IN");
    expect(elements.get("heat-state").textContent).toBe("2H 30M");
    expect(elements.get("heat-detail-label").textContent).toBe("ESTIMATED HOT");
    expect(elements.get("heat-detail").textContent).toBe("2:10 PM");
    expect(elements.get("heat-detail-row").hidden).toBe(false);
    expect(elements.has("heat-basis")).toBe(false);
    expect(elements.has("heat-basis-row")).toBe(false);
    expect(spec.vconcat.map((chart) => chart.title)).toEqual([
      "Air",
      "Air change",
      "Stovepipe",
      "Stovepipe change",
    ]);
    expect(spec.vconcat[0].layer[0].encoding.y.field).toBe("temp_max");
    expect(spec.vconcat[2].layer[0].encoding.y.field).toBe("temp_max");
    expect(spec.vconcat[1].layer[1].encoding.y.field).toBe("rate_per_hour");
    expect(spec.vconcat[3].layer[1].encoding.y.field).toBe("rate_per_hour");
    const selectionLayer = spec.vconcat[0].layer.find((layer) => layer.params);
    expect(selectionLayer.params[0]).toMatchObject({
      name: "linked_hover",
      select: { type: "point", fields: ["ts"], on: "mousemove, click", nearest: true, clear: false },
    });
    expect(selectionLayer.encoding).toEqual(expect.objectContaining({
      x: expect.objectContaining({ field: "ts" }),
    }));
    expect(selectionLayer.encoding.y).toBeUndefined();
    expect(spec.vconcat.every((chart) => chart.layer.every((layer) =>
      layer.encoding?.tooltip === undefined
    ))).toBe(true);
    expect(spec.vconcat.map((chart) => chart.layer
      .filter((layer) => layer.mark?.type === "text")
      .map((layer) => layer.encoding.text.field)
    )).toEqual([
      ["ts", "temperature_readout"],
      ["ts", "rate_readout"],
      ["ts", "temperature_readout"],
      ["ts", "rate_readout"],
    ]);
    expect(spec.vconcat.every((chart) => chart.layer
      .filter((layer) => layer.mark?.type === "text")
      .every((layer) =>
        layer.encoding.x.field === "ts" &&
        layer.mark.align.expr === "datum.readout_align" &&
        layer.mark.dx.expr === "datum.readout_dx"
      )
    )).toBe(true);
    expect(spec.vconcat.every((chart) => chart.layer.some((layer) =>
      layer.mark?.type === "rule" && layer.encoding?.opacity?.condition?.param === "linked_hover"
    ))).toBe(true);

    const compiled = compile(spec).spec;
    const linkedSignals = compiled.marks.flatMap((mark) =>
      (mark.signals ?? []).filter((signal) => signal.name === "linked_hover_tuple")
    );
    expect(linkedSignals).toHaveLength(4);
    for (const signal of linkedSignals) {
      const eventTypes = signal.on.flatMap((update) => update.events.map((event) => event.type));
      expect(eventTypes).toEqual(["mousemove", "click"]);
    }
    const warnings = [];
    const runtimeLogger = logger(Warn, "warn", (_method, _level, messages) => {
      warnings.push(messages.join(" "));
    });
    await new View(parse(compiled), { logger: runtimeLogger, renderer: "none" }).runAsync();
    expect(warnings.filter((warning) => warning.includes("Infinite extent"))).toEqual([]);
    for (const chart of spec.vconcat) {
      expect(chart.layer.filter((layer) => layer.mark?.type === "text").every((layer) =>
        layer.mark.stroke === undefined && layer.mark.strokeWidth === undefined
      )).toBe(true);
      expect(chart.layer.find((layer) => layer.mark?.type === "line").encoding.y.scale.padding).toBe(18);
    }
    const saunaValues = spec.data.values.filter((point) => point.series === "Sauna air");
    expect(saunaValues[0].rate_per_hour).toBeCloseTo(-2.16);
    expect(saunaValues[0].temperature_readout).toBe("184.1 °F");
    expect(saunaValues[0].rate_readout).toBe("-2.2 °F/hour");
    expect(saunaValues[1].temperature_readout).toBe("180.0–184.0 °F");
    expect(saunaValues.map((point) => [point.readout_align, point.readout_dx])).toEqual([
      ["left", 10],
      ["right", -10],
    ]);

    expect(colorSchemeChange).toBeTypeOf("function");
    colorSchemeQuery.matches = false;
    colorSchemeChange({ matches: false });
    await vi.waitFor(() => expect(embed).toHaveBeenCalledTimes(2));
    const lightSpec = embed.mock.calls[1][1];
    expect(lightSpec.config.axis.gridColor).toBe("#adb5aa");
    expect(lightSpec.vconcat[0].layer[0].mark.color).toBe("#0c1516");
  });

  it("keeps only the requested controls and separate sensor charts", () => {
    const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
    const css = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
    const ranges = [...html.matchAll(/data-range="([^"]+)"/g)].map((match) => match[1]);

    expect(html).toContain('id="history-charts"');
    expect(html).toContain('class="instrument-ledger"');
    expect(html).toContain('<p class="instrument-label">Air</p>');
    expect(html).toContain('for="target-temp">Air target</label>');
    expect(html).toContain('<p class="instrument-label">Stovepipe</p>');
    expect(html).toContain('id="target-temp"');
    expect(html).toContain('value="180"');
    expect(html).toContain('id="heat-state"');
    expect(html).not.toContain('id="heat-basis"');
    expect(html).not.toContain('id="heat-basis-row"');
    expect(html).not.toContain(">Trend<");
    expect(css).toContain(".status-row[hidden] { display: none; }");
    expect(html).not.toContain('id="theme-controls"');
    expect(html).not.toContain("data-theme=");
    expect(css).toContain("@media (prefers-color-scheme: dark)");
    expect(css).toContain("--lcd-background: linear-gradient(");
    expect(css).toContain("#f5d9e4 0%");
    expect(css).toContain("#e5dbf1 100%");
    expect(css).toContain("--lcd-background: #030201");
    expect(css).toContain("--lcd: #030201");
    expect(css).toContain("--ink: #f7941d");
    expect(css).toContain("--focus: #ffb347");
    expect(html).not.toContain('<p class="instrument-label">Sauna air</p>');
    expect(html).not.toContain('class="current-grid"');
    expect(html).not.toContain('class="heat-summary"');
    expect(ranges).toEqual(["1h", "3h", "12h", "24h", "7d", "30d", "all"]);
    expect(html).toContain('data-range="1h" aria-pressed="false"');
    expect(html).toContain('data-range="3h" aria-pressed="true"');
    expect(html).toContain('data-range="24h" aria-pressed="false"');
    expect(html).not.toContain("<h1");
    expect(html).not.toContain("<h2");
    expect(html).not.toContain('id="sauna-rate"');
    expect(html).not.toContain('id="pipe-rate"');
    expect(html).not.toContain('id="temperature-chart"');
    expect(html).not.toContain('id="sauna-temperature-chart"');
    expect(html).not.toContain('id="stovepipe-temperature-chart"');
    expect(html).not.toContain('id="status-badge"');
    expect(html).not.toContain('id="unit-select"');
    expect(html).not.toContain('id="session-state"');
    expect(html).not.toContain('id="sessions-chart"');
    expect(html.toLowerCase()).not.toContain("live conditions");
    expect(html).not.toContain("Informational monitoring only.");
    expect(html).not.toContain("The current month is partial and is not a safety record.");
  });

  it("allows the embedded DSEG fonts through the Content Security Policy", () => {
    const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
    const css = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");

    expect(css).toContain('src: url("data:font/woff2;base64,');
    expect(html).toMatch(/font-src 'self' data:/);
  });

  it("preserves Vega canvas coordinates when fitting charts to narrow screens", () => {
    const css = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");

    expect(css).not.toMatch(/\.vega-embed canvas\s*\{[^}]*max-width/s);
  });
});
