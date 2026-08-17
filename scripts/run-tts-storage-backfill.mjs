import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const buildResult = await build({
  entryPoints: [fileURLToPath(new URL("./tts-storage-backfill.ts", import.meta.url))],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  write: false,
});
const output = buildResult.outputFiles[0];
if (!output) throw new Error("Backfill utility build produced no output");
const moduleUrl = `data:text/javascript;base64,${Buffer.from(output.contents).toString("base64")}`;
const { runCli } = await import(moduleUrl);

try {
  process.exitCode = await runCli(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown backfill utility failure";
  process.stderr.write(`Backfill utility failed: ${message}\n`);
  process.exitCode = 1;
}
