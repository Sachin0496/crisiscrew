import { serve } from "@hono/node-server";
import {
  CachedEmbedder,
  FreshdeskClient,
  freshdeskMcpWriter,
  freshserviceIncidents,
  HashEmbedder,
  LocalEmbedder,
  restWriter,
  vobizTelephony,
} from "@crisiscrew/adapters";
import type { Embedder } from "@crisiscrew/core";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, loadConfig, wiringReport, type Config } from "./config";
import { createApp } from "./http/app";
import { DATA_DIR, EMBEDDING_CACHE_DIR, REPO_ROOT } from "./paths";
import { Runtime, type LiveAdapters } from "./runtime";
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

/** The live Freshworks adapters whose switches are on. Their keys stay here; nothing else sees them. */
function liveAdapters(): LiveAdapters {
  const live: LiveAdapters = {};
  if (config.freshdesk) {
    const { domain, apiKey, actions } = config.freshdesk;
    const client = new FreshdeskClient({ domain, apiKey });
    if (actions === "mcp") {
      const writer = freshdeskMcpWriter({ domain, apiKey });
      // Connect now, so the first note doesn't pay for the handshake; a failure shows here and on the first call, never silently.
      writer.connect().then(
        () => console.log(`[crisiscrew] connected to Freshdesk's MCP server at https://${domain}/mcp`),
        (error) => console.error(`[crisiscrew] Freshdesk MCP server: ${error instanceof Error ? error.message : String(error)}`),
      );
      live.freshdesk = { client, writer };
    } else {
      live.freshdesk = { client, writer: restWriter(client) };
    }
  }
  if (config.freshservice) {
    const { domain, apiKey, requesterEmail, workspaceId } = config.freshservice;
    live.incidents = freshserviceIncidents({ domain, apiKey, requesterEmail, ...(workspaceId !== null ? { workspaceId } : {}) });
  }
  if (config.vobiz && config.publicBaseUrl) {
    const { authId, authToken, from, ringTimeoutSec, timeLimitSec } = config.vobiz;
    live.telephony = vobizTelephony({ authId, authToken, from, publicBaseUrl: config.publicBaseUrl, ringTimeoutSec, timeLimitSec });
  }
  return live;
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
  live: liveAdapters(),
  onAudit: (entry, sessionId) => appendFileSync(join(auditDir, `${runStamp}-${sessionId}.jsonl`), `${JSON.stringify(entry)}\n`),
  onError: (error) => console.error("[crisiscrew]", error),
});
await runtime.start();

const app = createApp({ runtime, config, onError: (error) => console.error("[crisiscrew]", error) });
const server = serve({ fetch: app.fetch, port: config.port }, ({ port }) => {
  const wiring = wiringReport(config);
  const base = config.publicBaseUrl ?? `http://localhost:${port}`;
  const lines = [
    "",
    "CrisisCrew is running",
    `  UI and API   ${base}`,
    `  MCP          ${base}/mcp  (Streamable HTTP, bearer token per identity)`,
    `  Wiring       ${wiring.ports.map((p) => `${p.port}=${p.adapter}`).join("  ")}`,
    wiring.ports
      .filter((p) => p.mode === "live" && p.port !== "embeddings")
      .map((p) => `  Live         ${p.detail}`)
      .join("\n") || "               Freshworks adapters are off (sandbox); switch them on in .env.",
    `  Tokens       admin ${config.adminToken ? "set" : "not set (open, local demo)"}, approver ${config.approverToken ? "set" : "not set (open, local demo)"}`,
  ];
  if (config.freshdesk?.ingest === "webhook") lines.push(`  Freshdesk    webhook: POST ${base}/api/webhooks/freshdesk with header X-CrisisCrew-Secret`);
  if (config.vobiz) lines.push(`  Vobiz        callbacks: ${base}/api/webhooks/vobiz/:callId/:kind (signed); test call: POST ${base}/api/telephony/test-call`);
  if (config.generatedTokens.length > 0) {
    lines.push("  MCP tokens generated for this run (set MCP_TOKEN_* in .env to keep them):");
    for (const identity of config.generatedTokens) lines.push(`    ${identity.padEnd(13)} ${config.mcpTokens[identity]}`);
  }
  console.log(lines.join("\n"));
});

// The poll fallback for Freshdesk ingest: one poll at a time, errors reported, never fatal.
if (config.freshdesk?.ingest === "poll") {
  let polling = false;
  setInterval(() => {
    if (polling) return;
    polling = true;
    runtime
      .pollFreshdesk()
      .then((n) => n > 0 && console.log(`[crisiscrew] ingested ${n} Freshdesk ticket${n === 1 ? "" : "s"}`))
      .catch((error) => console.error("[crisiscrew] Freshdesk poll:", error instanceof Error ? error.message : error))
      .finally(() => (polling = false));
  }, config.freshdesk.pollSeconds * 1000);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close();
    process.exit(0);
  });
}
