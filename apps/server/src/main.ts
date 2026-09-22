import { serve } from "@hono/node-server";
import { CachedEmbedder, HashEmbedder, LocalEmbedder } from "@crisiscrew/adapters";
import type { Embedder } from "@crisiscrew/core";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, loadConfig, wiringReport, type Config } from "./config";
import { createApp } from "./http/app";
import { DATA_DIR, EMBEDDING_CACHE_DIR, REPO_ROOT } from "./paths";
import { Runtime } from "./runtime";
import { loadPolicy, loadScenarios } from "./scenarios";

const envFile = join(REPO_ROOT, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

let config: Config;
try {
  config = loadConfig(process.env);
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(`\nCrisisCrew can't start: ${error.message}\n`);
    process.exit(1);
  }
  throw error;
}

/** Committed scenario cache (read-only) → this machine's runtime cache → the local model. */
function embedder(): Embedder {
  if (config.switches.embeddings === "hash") return new HashEmbedder();
  const model = new LocalEmbedder(config.embeddingsModel, { cacheDir: config.embeddingsDir, threads: config.embeddingsThreads, offline: false });
  const runtimeCache = new CachedEmbedder({ modelId: config.embeddingsModel, dir: join(DATA_DIR, "embeddings"), inner: model });
  return new CachedEmbedder({ modelId: config.embeddingsModel, dir: EMBEDDING_CACHE_DIR, inner: runtimeCache, readOnly: true });
}

const auditDir = join(DATA_DIR, "audit");
mkdirSync(auditDir, { recursive: true });
const runStamp = new Date().toISOString().replace(/[:.]/g, "-");

const runtime = new Runtime({
  policy: loadPolicy(),
  scenarios: loadScenarios(),
  embedder: embedder(),
  latencyMs: config.sandboxLatencyMs,
  liveWorld: "checkout-v4.21.7",
  onAudit: (entry, sessionId) => appendFileSync(join(auditDir, `${runStamp}-${sessionId}.jsonl`), `${JSON.stringify(entry)}\n`),
  onError: (error) => console.error("[crisiscrew]", error),
});
await runtime.start();

const app = createApp({ runtime, config });
const server = serve({ fetch: app.fetch, port: config.port }, ({ port }) => {
  const wiring = wiringReport(config);
  const base = config.publicBaseUrl ?? `http://localhost:${port}`;
  const lines = [
    "",
    "CrisisCrew is running",
    `  UI and API   ${base}`,
    `  MCP          ${base}/mcp  (Streamable HTTP, bearer token per identity)`,
    `  Wiring       ${wiring.ports.map((p) => `${p.port}=${p.adapter}`).join("  ")}`,
    "               Live adapters are not wired yet; see .env.example.",
    `  Tokens       admin ${config.adminToken ? "set" : "not set (open, local demo)"}, approver ${config.approverToken ? "set" : "not set (open, local demo)"}`,
  ];
  if (config.generatedTokens.length > 0) {
    lines.push("  MCP tokens generated for this run (set MCP_TOKEN_* in .env to keep them):");
    for (const identity of config.generatedTokens) lines.push(`    ${identity.padEnd(13)} ${config.mcpTokens[identity]}`);
  }
  console.log(lines.join("\n"));
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close();
    process.exit(0);
  });
}
