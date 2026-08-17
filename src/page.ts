import { celsiusToFahrenheit, round } from "./analytics";
import { getCurrentReading, type CurrentReadingRow } from "./db";
import type { Env } from "./types";

export interface InitialDashboardSnapshot {
  observedAt: string;
  saunaF: string;
  stovepipeF: string;
}

function wholeFahrenheit(valueC: number | null): string {
  if (valueC === null) return "—";
  const valueF = round(celsiusToFahrenheit(valueC), 2);
  return valueF === null ? "—" : valueF.toFixed(0);
}

export function initialDashboardSnapshot(
  reading: CurrentReadingRow | null,
): InitialDashboardSnapshot | null {
  if (reading === null) return null;
  return {
    observedAt: new Date(reading.observed_at_ms).toISOString(),
    saunaF: wholeFahrenheit(reading.sauna_temp_c),
    stovepipeF: wholeFahrenheit(reading.stovepipe_temp_c),
  };
}

export async function dashboardPage(request: Request, env: Env): Promise<Response> {
  const templateUrl = new URL("/index.html", request.url);
  const stylesUrl = new URL("/styles.css", request.url);
  const colorSchemeUrl = new URL("/color-scheme.js", request.url);
  const reading = getCurrentReading(env.DB).catch((error: unknown) => {
    console.error(
      "Initial dashboard reading unavailable",
      error instanceof Error ? error.message : "unknown error",
    );
    return null;
  });
  const [templateResponse, stylesResponse, colorSchemeResponse, currentReading] =
    await Promise.all([
      env.ASSETS.fetch(templateUrl),
      env.ASSETS.fetch(stylesUrl),
      env.ASSETS.fetch(colorSchemeUrl),
      reading,
    ]);
  if (!templateResponse.ok) return templateResponse;

  const [styles, colorScheme] = await Promise.all([
    stylesResponse.ok ? stylesResponse.text() : Promise.resolve(null),
    colorSchemeResponse.ok ? colorSchemeResponse.text() : Promise.resolve(null),
  ]);
  const snapshot = initialDashboardSnapshot(currentReading);
  let rewriter = new HTMLRewriter();

  if (colorScheme !== null) {
    rewriter = rewriter.on("#color-scheme-bootstrap", {
      element(element): void {
        element.removeAttribute("src");
        element.setInnerContent(colorScheme, { html: true });
      },
    });
  }
  if (styles !== null) {
    rewriter = rewriter.on("#app-styles", {
      element(element): void {
        element.replace(`<style id="app-styles">${styles}</style>`, { html: true });
      },
    });
  }
  if (snapshot !== null) {
    rewriter = rewriter
      .on("#instrument-ledger", {
        element(element): void {
          element.setAttribute("data-observed-at", snapshot.observedAt);
        },
      })
      .on("#sauna-temp", {
        element(element): void {
          element.setInnerContent(snapshot.saunaF);
        },
      })
      .on("#pipe-temp", {
        element(element): void {
          element.setInnerContent(snapshot.stovepipeF);
        },
      });
  }

  const transformed = rewriter.transform(templateResponse);
  const headers = new Headers(transformed.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.delete("Content-Length");
  headers.delete("CF-Cache-Status");
  headers.delete("ETag");
  headers.delete("Last-Modified");
  return new Response(transformed.body, {
    status: transformed.status,
    statusText: transformed.statusText,
    headers,
  });
}
