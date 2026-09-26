import { serve } from "@hono/node-server";
import {
  allowListedFetch,
  CachedEmbedder,
  FreshdeskClient,
  freshdeskMcpWriter,
  freshserviceIncidents,
  freshserviceOnCall,
  FreshserviceAlertsClient,
  mcpInfraHealth,
  McpToolClient,
  HashEmbedder,
  LakeraGuard,
  LangSmithExporter,
  layeredGuard,
  LayaClassifier,
  LocalEmbedder,
  restWriter,
  sarvamSpeech,
  VOBIZ_STREAM_PATH,
  vobizTelephony,
  githubCodeHost,
  gitWorkspace,
  googleDocs,
  replayCodingAgent,
  teamKnowledge,
  type ReplaySession,
} from "@crisiscrew/adapters";
import { MOCK } from "@crisiscrew/contracts";
import { heuristicGuard, type Embedder, type PromptGuard, type TicketClassifier, type TraceSink } from "@crisiscrew/core";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import { WebSocketServer } from "ws";
import { isAbsolute, join } from "node:path";
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
    const { domain, apiKey, requesterEmail, workspaceId, groups } = config.freshservice;
    live.incidents = freshserviceIncidents({ domain, apiKey, requesterEmail, groups, ...(workspaceId !== null ? { workspaceId } : {}) });
  }
  if (config.infra) live.infra = mcpInfraHealth(config.infra.servers.map((server) => new McpToolClient(server)));
  if (config.alerts) {
    const { domain, apiKey, rules } = config.alerts;
    live.alerts = { client: new FreshserviceAlertsClient({ domain, apiKey }), rules };
  }
  if (config.oncall) {
    const { domain, apiKey, defaultScheduleId, schedules } = config.oncall;
    live.oncall = freshserviceOnCall({ domain, apiKey, defaultScheduleId, schedules });
  }
  if (config.vobiz) {
    const { authId, authToken, from, ringTimeoutSec, timeLimitSec, apiBase, callbackBaseUrl, sarvam, allowedNumbers } = config.vobiz;
    live.telephony = vobizTelephony({
      authId,
      authToken,
      from,
      publicBaseUrl: callbackBaseUrl,
      apiBase,
      ringTimeoutSec,
      timeLimitSec,
      allowedNumbers,
      ...(sarvam ? { speech: sarvamSpeech({ apiKey: sarvam.apiKey, speaker: sarvam.speaker }) } : {}),
    });
  }
  if (config.autofix) {
    const a = config.autofix;
    const at = (path: string) => (isAbsolute(path) ? path : join(REPO_ROOT, path));
    const session = JSON.parse(readFileSync(at(a.replayFile), "utf8")) as ReplaySession;
    live.fix = {
      codeHost: githubCodeHost({ apiBase: a.githubBase, token: MOCK.githubToken, repos: a.repos }),
      workspace: gitWorkspace({ root: at(a.workspaceRoot), author: { name: "CrisisCrew Fix Agent", email: "fix-agent@crisiscrew.dev" } }),
      coding: replayCodingAgent({ session, pace: Number(process.env.AUTOFIX_REPLAY_PACE) || 2.6 }),
      docs: googleDocs({ docsBase: a.googleBase, driveBase: a.googleBase, token: MOCK.googleToken, viewBase: a.viewBase }),
      knowledge: teamKnowledge({ slack: { apiBase: a.slackBase, token: MOCK.slackToken }, drive: { apiBase: a.googleBase, token: MOCK.googleToken } }),
    };
  }
  return live;
}

// CrisisCrew sends its own traces to LangSmith (graph → node → tool). LangChain's automatic tracer would
// post the same LangGraph runs a second time, so its switches are cleared once the config has read them.
for (const key of ["LANGSMITH_TRACING", "LANGSMITH_TRACING_V2", "LANGCHAIN_TRACING_V2", "LANGCHAIN_TRACING"]) delete process.env[key];

/** Every outbound model and tracing call goes through the egress allow-list. */
const egress = allowListedFetch(config.egress);
const policy = loadPolicy();

function promptGuard(): PromptGuard {
  if (!config.lakera) return heuristicGuard;
  return layeredGuard([new LakeraGuard({ ...config.lakera, projectId: config.lakera.projectId ?? undefined, fetch: egress }), heuristicGuard]);
}

function classifier(): TicketClassifier | null {
  if (!config.laya) return null;
  const { baseUrl, apiKey, model } = config.laya;
  const options = { baseUrl, ...(apiKey ? { apiKey } : {}), ...(model ? { model } : {}), fetch: egress };
  // Laya's first answers after it starts are slow. Warm it up now, with a generous timeout, so the
  // first tickets don't fall back; and say whether it answered, so a missing server shows at startup.
  const started = Date.now();
  new LayaClassifier({ ...options, timeoutMs: 60_000 }).classify("My payment failed at checkout.").then(
    (v) => console.log(`[crisiscrew] Laya answered in ${Date.now() - started} ms (${v.model ?? "routed"} checkpoint)`),
    (error) => console.error(`[crisiscrew] Laya: ${error instanceof Error ? error.message : String(error)}. Tickets use the built-in classifier until it answers; \`pnpm laya\` starts one`),
  );
  return new LayaClassifier({ ...options, timeoutMs: policy.classifier.timeoutMs });
}

function traceSinks(): TraceSink[] {
  if (!config.langsmith) return [];
  let reported = false;
  return [
    new LangSmithExporter({
      ...config.langsmith,
      fetch: egress,
      // One line, not one per run: a wrong key or a blocked network shouldn't flood the console.
      onError: (error) => {
        if (reported) return;
        reported = true;
        console.error(`[crisiscrew] LangSmith: ${error instanceof Error ? error.message : String(error)} (further LangSmith errors are not shown)`);
      },
    }),
  ];
}

const auditDir = join(DATA_DIR, "audit");
mkdirSync(auditDir, { recursive: true });
const runStamp = new Date().toISOString().replace(/[:.]/g, "-");

const runtime = new Runtime({
  policy,
  scenarios: loadScenarios(),
  embedder: embedder(),
  latencyMs: config.sandboxLatencyMs,
  liveWorld: config.liveWorld,
  live: liveAdapters(),
  guard: promptGuard(),
  classifier: classifier(),
  traceSinks: traceSinks(),
  onAudit: (entry, sessionId) => appendFileSync(join(auditDir, `${runStamp}-${sessionId}.jsonl`), `${JSON.stringify(entry)}\n`),
  onError: (error) => console.error("[crisiscrew]", error),
  ...(config.publicBaseUrl ? { publicBaseUrl: config.publicBaseUrl } : {}),
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
    // External services only: the local model and the built-in classifier, guard and tracing are summarised below.
    wiring.ports
      .filter((p) => (p.mode === "live" || p.mode === "mock") && !["embeddings", "classifier:embeddings", "guard:heuristic", "tracing:local"].includes(p.port === "embeddings" ? p.port : `${p.port}:${p.adapter}`))
      .map((p) => (p.mode === "mock" ? `  Mock         ${p.detail.replace(/^Mock /, "")}` : `  Live         ${p.detail}`))
      .join("\n") || "               Freshworks adapters are off (sandbox); switch them on in .env.",
    `  Tokens       admin ${config.adminToken ? "set" : "not set (open, local demo)"}, approver ${config.approverToken ? "set" : "not set (open, local demo)"}`,
    `  Workflows    LangGraph; traces at ${base}/#/traces${config.langsmith ? ` and in LangSmith project "${config.langsmith.project}"` : ""}`,
    `  Guardrails   prompt guard: ${config.lakera ? "Lakera + built-in rules" : "built-in rules"}; classifier: ${config.laya ? `Laya at ${config.laya.baseUrl}` : "built-in"}${config.egress.length ? `; egress allow-list: ${config.egress.join(", ")}` : ""}`,
  ];
  if (config.freshdesk?.ingest === "webhook") lines.push(`  Freshdesk    webhook: POST ${base}/api/webhooks/freshdesk with header X-CrisisCrew-Secret`);
  if (config.vobiz) lines.push(`  Vobiz        callbacks: ${config.vobiz.callbackBaseUrl}/api/webhooks/vobiz/:callId/:kind (signed); test call: POST ${base}/api/telephony/test-call`);
  if (config.mock) lines.push(`  Mock         Freshdesk, Freshservice and Vobiz at http://localhost:${config.mock.freshdesk} (start it with \`pnpm mock\`)`);
  if (config.generatedTokens.length > 0) {
    lines.push("  MCP tokens generated for this run (set MCP_TOKEN_* in .env to keep them):");
    for (const identity of config.generatedTokens) lines.push(`    ${identity.padEnd(13)} ${config.mcpTokens[identity]}`);
  }
  console.log(lines.join("\n"));
});

// A streamed call's audio: Vobiz opens a WebSocket to the URL its answer XML named, with the call's own token.
if (config.vobiz?.sarvam) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
  (server as Server).on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const callId = VOBIZ_STREAM_PATH.exec(url.pathname)?.[1];
    const vobiz = runtime.vobiz;
    if (!callId || !vobiz) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      const conversation = vobiz.openStream(decodeURIComponent(callId), url.searchParams.get("token") ?? "", {
        send: (data) => ws.readyState === ws.OPEN && ws.send(data),
        close: () => ws.close(),
      });
      if (!conversation) return ws.close(1008, "unknown call or wrong token");
      ws.on("message", (data) => conversation.receive(data.toString()));
      ws.on("close", () => conversation.close());
      ws.on("error", (error) => console.error("[crisiscrew] Vobiz stream:", error.message));
    });
  });
}

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

// The poll for Freshservice alerts, the same way: one at a time, errors reported, never fatal.
if (config.alerts?.ingest === "poll") {
  let polling = false;
  setInterval(() => {
    if (polling) return;
    polling = true;
    runtime
      .pollFreshserviceAlerts()
      .then((n) => n > 0 && console.log(`[crisiscrew] ingested ${n} Freshservice alert${n === 1 ? "" : "s"}`))
      .catch((error) => console.error("[crisiscrew] Freshservice alert poll:", error instanceof Error ? error.message : error))
      .finally(() => (polling = false));
  }, config.alerts.pollSeconds * 1000);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close();
    process.exit(0);
  });
}
