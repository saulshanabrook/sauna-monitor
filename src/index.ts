import { currentResponse, historyResponse, sessionsResponse } from "./api";
import { getRuntimeConfig, normalizeEui } from "./config";
import { insertReading, processDerivedData } from "./db";
import { parseTtsUplink } from "./domain";
import { dashboardPage } from "./page";
import type { Env } from "./types";

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const API_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

function json(data: unknown, status = 200, cacheControl = "no-store"): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...API_HEADERS, "Cache-Control": cacheControl },
  });
}

async function equalSecret(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const leftBytes = new Uint8Array(leftHash);
  const rightBytes = new Uint8Array(rightHash);
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index]! ^ rightBytes[index]!;
  }
  return difference === 0;
}

async function authenticateWebhook(request: Request, env: Env): Promise<boolean> {
  if (!env.WEBHOOK_PASSWORD) throw new HttpError(503, "Webhook authentication is not configured");
  const header = request.headers.get("Authorization") ?? request.headers.get("Authentication");
  if (!header?.startsWith("Basic ")) return false;
  let decoded: string;
  try {
    decoded = atob(header.slice(6));
  } catch {
    return false;
  }
  const separator = decoded.indexOf(":");
  if (separator < 0) return false;
  const username = decoded.slice(0, separator);
  const password = decoded.slice(separator + 1);
  const expectedUsername = env.WEBHOOK_USERNAME || "tts";
  const [usernameMatches, passwordMatches] = await Promise.all([
    equalSecret(username, expectedUsername),
    equalSecret(password, env.WEBHOOK_PASSWORD),
  ]);
  return usernameMatches && passwordMatches;
}

async function readJsonBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get("Content-Type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new HttpError(415, "Content-Type must be application/json");
  }
  const declaredLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > 131_072) {
    throw new HttpError(413, "Webhook payload is too large");
  }
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > 131_072) throw new HttpError(413, "Webhook payload is too large");
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpError(400, "Webhook body is not valid JSON");
  }
}

async function ingest(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
  }
  if (!await authenticateWebhook(request, env)) {
    return new Response("Unauthorized", {
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="TTS webhook"', "Cache-Control": "no-store" },
    });
  }

  const config = getRuntimeConfig(env);
  let parsed;
  try {
    parsed = parseTtsUplink(await readJsonBody(request), config.channels);
  } catch (error) {
    if (error instanceof TypeError) throw new HttpError(422, error.message);
    throw error;
  }
  if (parsed.kind === "ignored") {
    return json({ ok: true, stored: false, ignored: parsed.reason });
  }

  const expectedApplicationId = env.EXPECTED_APPLICATION_ID?.trim();
  if (expectedApplicationId && parsed.reading.applicationId !== expectedApplicationId) {
    throw new HttpError(403, "Unexpected application");
  }
  const expectedDevEui = normalizeEui(env.EXPECTED_DEV_EUI);
  if (expectedDevEui && parsed.reading.devEui !== expectedDevEui) {
    throw new HttpError(403, "Unexpected device");
  }

  const inserted = await insertReading(env.DB, parsed.reading);
  if (inserted) await processDerivedData(env.DB, parsed.reading, config);
  return json({ ok: true, stored: inserted, duplicate: !inserted });
}

async function api(request: Request, env: Env, url: URL): Promise<Response> {
  if (url.pathname === "/api/ingest") return ingest(request, env);
  if (request.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET" } });
  }
  const config = getRuntimeConfig(env);
  if (url.pathname === "/api/current") return json(await currentResponse(env.DB, config));
  if (url.pathname === "/api/history") {
    return json(await historyResponse(env.DB, config, url), 200, "public, max-age=60");
  }
  if (url.pathname === "/api/sessions") {
    return json(await sessionsResponse(env.DB, config, url), 200, "public, max-age=300");
  }
  if (url.pathname === "/api/health") {
    await env.DB.prepare("SELECT 1").first();
    return json({ ok: true });
  }
  return json({ error: "Not found" }, 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith("/api/")) return await api(request, env, url);
      if (
        request.method === "GET" &&
        (url.pathname === "/" || url.pathname === "/index.html")
      ) {
        return await dashboardPage(request, env);
      }
      return env.ASSETS.fetch(request);
    } catch (error) {
      if (!url.pathname.startsWith("/api/")) {
        console.error(
          "Dashboard page rendering failed",
          error instanceof Error ? error.message : "unknown error",
        );
        return env.ASSETS.fetch(request);
      }
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      console.error("Unhandled request failure", error instanceof Error ? error.message : "unknown error");
      return json({ error: "Internal server error" }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
