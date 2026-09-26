import { normalizeDomain, type McpServerConfig } from "@crisiscrew/adapters";
import { z } from "zod";
import { MOCK, mockPorts, type Identity, type MockPorts, type PortMode, type PortName, type WiringReport } from "@crisiscrew/contracts";
import { randomBytes } from "node:crypto";
import { MODELS_DIR } from "./paths";

/** The embedding model chosen by calibration (docs/calibration.md): best separation, smallest download. */
export const DEFAULT_EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";

export class ConfigError extends Error {
  override name = "ConfigError";
}

type PortSpec = {
  env: string;
  /** Every value the design allows; the first is the default. */
  options: string[];
  /** Values that actually work today. The rest are designed but not wired. */
  wired: string[];
  mode: (value: string, config: Config) => PortMode;
  detail: (value: string, config: Config) => string;
};

const sandboxMode = () => "sandbox" as const;
/** A Freshworks or Vobiz adapter that's switched on: live, or mock when INTEGRATIONS=mock points it at apps/mock. */
const external = (on: boolean, config: Config): PortMode => (!on ? "sandbox" : config.integrations === "mock" ? "mock" : "live");
const named = (product: string, config: Config) => (config.integrations === "mock" ? `Mock ${product}` : product);
const hostOf = (url: string) => new URL(url).hostname;

function ticketsDetail(value: string, config: Config): string {
  const { freshdesk } = config;
  if (value !== "freshdesk" || !freshdesk) return "Scenario replay and tickets typed into the UI";
  const ingest = freshdesk.ingest === "webhook" ? "webhook ingest" : `polled every ${freshdesk.pollSeconds} s`;
  const writes = freshdesk.actions === "mcp" ? "Freshdesk's MCP server" : "the REST API";
  return `${named("Freshdesk", config)} (${freshdesk.domain}): ${ingest}; notes and replies through ${writes}. Replays and typed tickets stay in the sandbox`;
}

const PORTS: Record<PortName, PortSpec> = {
  tickets: {
    env: "TICKETS",
    options: ["sandbox", "freshdesk"],
    wired: ["sandbox", "freshdesk"],
    mode: (v, c) => external(v === "freshdesk", c),
    detail: ticketsDetail,
  },
  incidents: {
    env: "INCIDENTS",
    options: ["sandbox", "freshservice"],
    wired: ["sandbox", "freshservice"],
    mode: (v, c) => external(v === "freshservice", c),
    detail: (v, c) =>
      v === "freshservice" && c.freshservice
        ? `${named("Freshservice", c)} (${c.freshservice.domain}): an incident for each CrisisCrew incident, with notes, filed as ${c.freshservice.requesterEmail}`
        : "Engineering incidents kept in memory",
  },
  deployments: { env: "DEPLOYMENTS", options: ["sandbox", "github"], wired: ["sandbox"], mode: sandboxMode, detail: () => "The scenario's release history" },
  payments: { env: "PAYMENTS", options: ["sandbox", "razorpay-status"], wired: ["sandbox"], mode: sandboxMode, detail: () => "The scenario's gateway status" },
  metrics: { env: "METRICS", options: ["sandbox"], wired: ["sandbox"], mode: sandboxMode, detail: () => "Error rates simulated from the scenario's releases" },
  orders: { env: "ORDERS", options: ["sandbox"], wired: ["sandbox"], mode: sandboxMode, detail: () => "The scenario's customers and payment attempts" },
  telephony: {
    env: "TELEPHONY",
    options: ["sandbox", "vobiz"],
    wired: ["sandbox", "vobiz"],
    mode: (v, c) => external(v === "vobiz", c),
    detail: (v, c) =>
      v === "vobiz" && c.vobiz
        ? `${named("Vobiz", c)}: calls from ${c.vobiz.from}, with callbacks to ${c.vobiz.callbackBaseUrl}/api/webhooks/vobiz${c.vobiz.sarvam ? "; on-call pages stream both ways, voiced by Sarvam (saaras:v3 hears, bulbul:v3 speaks)" : ""}${c.vobiz.allowedNumbers.length ? `; only ${c.vobiz.allowedNumbers.length} allowed ${c.vobiz.allowedNumbers.length === 1 ? "number" : "numbers"}` : ""}`
        : "Calls are simulated: they ring, and are answered, missed or busy, the same way on every replay",
  },
  oncall: {
    env: "ONCALL",
    options: ["sandbox", "freshservice"],
    wired: ["sandbox", "freshservice"],
    mode: (v, c) => external(v === "freshservice", c),
    detail: (v, c) =>
      v === "freshservice" && c.oncall
        ? `${named("Freshservice", c)} on-call (${c.oncall.domain}): schedule ${c.oncall.defaultScheduleId}${Object.keys(c.oncall.schedules).length ? ` and ${Object.keys(c.oncall.schedules).length} per service` : ""}`
        : "The scenario's on-call roster",
  },
  alerts: {
    env: "ALERTS",
    options: ["sandbox", "freshservice"],
    wired: ["sandbox", "freshservice"],
    mode: (v, c) => external(v === "freshservice", c),
    detail: (v, c) =>
      v === "freshservice" && c.alerts
        ? `${named("Freshservice", c)} Alert Management (${c.alerts.domain}): ${c.alerts.ingest === "poll" ? `polled every ${c.alerts.pollSeconds} s` : "webhook"}; ${c.alerts.rules.length} service ${c.alerts.rules.length === 1 ? "rule" : "rules"}`
        : "The scenario's alert timeline, and alerts posted to /api/alerts",
  },
  infra: {
    env: "INFRA",
    options: ["sandbox", "mcp"],
    wired: ["sandbox", "mcp"],
    mode: (v) => (v === "mcp" ? "live" : "sandbox"),
    detail: (v, c) =>
      v === "mcp" && c.infra
        ? `MCP servers: ${c.infra.servers.map((s) => `${s.name} (${s.kind === "kubernetes" ? "pods" : "alarms"})`).join(", ")}`
        : "The scenario's pods and alarms; a service it doesn't describe is healthy",
  },
  voice: { env: "VOICE", options: ["off", "elevenlabs"], wired: ["off"], mode: () => "off", detail: () => "Voice scripts are prepared; no audio is generated" },
  llm: { env: "LLM", options: ["template", "anthropic"], wired: ["template"], mode: () => "off", detail: () => "Fixed templates; no language model is called" },
  embeddings: {
    env: "EMBEDDINGS",
    options: ["local", "hash"],
    wired: ["local", "hash"],
    mode: (v) => (v === "local" ? "live" : "sandbox"),
    detail: (v, c) => (v === "local" ? `${c.embeddingsModel}, running on this machine` : "Word hashing, for tests only: cannot match different wordings"),
  },
  classifier: {
    env: "CLASSIFIER",
    options: ["embeddings", "laya"],
    wired: ["embeddings", "laya"],
    mode: () => "live",
    detail: (v, c) =>
      v === "laya" && c.laya
        ? `Laya at ${hostOf(c.laya.baseUrl)}${c.laya.model ? ` (${c.laya.model} checkpoint)` : " (its router picks the checkpoint)"}: failure, question or request, and the product area. The built-in classifier answers if Laya doesn't`
        : "Built in: each ticket is labeled failure, question or request against the embedding prototypes",
  },
  guard: {
    env: "PROMPT_GUARD",
    options: ["heuristic", "lakera"],
    wired: ["heuristic", "lakera"],
    mode: () => "live",
    detail: (v) =>
      v === "lakera"
        ? "Lakera Guard, layered over the built-in rules: tickets and text in tool outputs are screened before any model could read them"
        : "Built in: rule-based screening of tickets and text in tool outputs, with a reason for every flag",
  },
  tracing: {
    env: "TRACING",
    options: ["local", "langsmith"],
    wired: ["local", "langsmith"],
    mode: () => "live",
    detail: (v, c) =>
      v === "langsmith" && c.langsmith
        ? `LangSmith project "${c.langsmith.project}" at ${hostOf(c.langsmith.endpoint)}, redacted, plus the Traces page`
        : "The Traces page: every LangGraph workflow run, node and tool call, kept in memory",
  },
  credits: { env: "CREDITS", options: ["sandbox", "dodo"], wired: ["sandbox"], mode: sandboxMode, detail: () => "An in-memory ledger" },
  translate: { env: "TRANSLATE", options: ["off", "sarvam"], wired: ["off"], mode: () => "off", detail: () => "Tickets are embedded as written" },
  autofix: {
    env: "AUTOFIX",
    options: ["off", "mock"],
    wired: ["off", "mock"],
    mode: (v) => (v === "mock" ? "mock" : "off"),
    detail: (v, c) =>
      v === "mock" && c.autofix
        ? `Fix Agent: mock GitHub (${hostOf(c.autofix.githubBase)}), a recorded OpenCode session replayed on a real git checkout with real tests, mock Google Docs and Slack`
        : "The Fix Agent is off: P1 incidents get a rollback request, not a pull request",
  },
};

const MCP_IDENTITIES: Identity[] = ["pattern", "commander", "investigator", "issue_creator", "recovery", "handoff", "operator"];

export type FreshdeskConfig = {
  domain: string;
  apiKey: string;
  webhookSecret: string | null;
  ingest: "webhook" | "poll";
  pollSeconds: number;
  actions: "rest" | "mcp";
};

export type FreshserviceConfig = { domain: string; apiKey: string; requesterEmail: string; workspaceId: number | null; groups: Record<string, number> };

export type VobizConfig = {
  authId: string;
  authToken: string;
  from: string;
  ringTimeoutSec: number;
  timeLimitSec: number;
  /** The Vobiz API; the mock's in mock mode. */
  apiBase: string;
  /** Where Vobiz calls back: PUBLIC_BASE_URL, or this server on localhost for the mock. */
  callbackBaseUrl: string;
  /** VOBIZ_VOICE=sarvam: conversational calls stream their audio and Sarvam hears and speaks them. Null: Vobiz's own voice. */
  sarvam: { apiKey: string; speaker: string } | null;
  /** VOBIZ_ALLOWED_NUMBERS: when set, the only numbers CrisisCrew may call. */
  allowedNumbers: string[];
};

/**
 * sandbox: every Freshworks and Vobiz port reads the scenario (the default).
 * mock:    they use their real adapters against apps/mock on localhost (`pnpm mock`).
 * real:    they use their real adapters against Freshdesk, Freshservice and Vobiz, with the keys below.
 */
export type IntegrationsMode = "sandbox" | "mock" | "real";

export type OnCallConfig = { domain: string; apiKey: string; defaultScheduleId: number; schedules: Record<string, number> };

export type AlertsConfig = {
  domain: string;
  apiKey: string;
  ingest: "poll" | "webhook";
  pollSeconds: number;
  rules: { match: string; service: string }[];
};

export type InfraConfig = { servers: McpServerConfig[] };

/** The Fix Agent's services (mock mode): the code host, Google Docs and Drive, Slack, the recorded coding session and where checkouts go. */
export type AutofixConfig = { githubBase: string; googleBase: string; slackBase: string; viewBase: string; repos: Record<string, string>; replayFile: string; workspaceRoot: string };

const McpServerSchema = z
  .object({
    name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/i, "letters, digits and dashes"),
    kind: z.enum(["kubernetes", "cloudwatch"]),
    url: z.string().url().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    namespace: z.string().optional(),
    labelSelector: z.string().optional(),
    timeoutMs: z.number().int().min(500).max(4_000).optional(),
  })
  .strict()
  .refine((s) => Boolean(s.url) !== Boolean(s.command), { message: "give a url or a command, not both" });

export type LayaConfig = { baseUrl: string; apiKey: string | null; model: string | null };
export type LakeraConfig = { apiKey: string; projectId: string | null };
export type LangSmithConfig = { apiKey: string; project: string; endpoint: string };

export type Config = {
  integrations: IntegrationsMode;
  /** The scenario whose world backs live sessions (LIVE_WORLD): the customers Freshdesk tickets are matched to. */
  liveWorld: string;
  autofix: AutofixConfig | null;
  /** The mock's ports, in mock mode. */
  mock: MockPorts | null;
  port: number;
  publicBaseUrl: string | null;
  adminToken: string | null;
  approverToken: string | null;
  sandboxLatencyMs: number;
  switches: Record<PortName, string>;
  embeddingsModel: string;
  embeddingsDir: string;
  embeddingsThreads: number;
  mcpTokens: Record<Identity, string>;
  generatedTokens: Identity[];
  freshdesk: FreshdeskConfig | null;
  freshservice: FreshserviceConfig | null;
  laya: LayaConfig | null;
  lakera: LakeraConfig | null;
  langsmith: LangSmithConfig | null;
  egress: string[];
  rateLimitPerMinute: number;
  vobiz: VobizConfig | null;
  oncall: OnCallConfig | null;
  alerts: AlertsConfig | null;
  infra: InfraConfig | null;
  /** Lets a Freshservice workflow acknowledge a page: POST /api/webhooks/freshservice/acknowledge with X-CrisisCrew-Secret. */
  freshserviceWebhookSecret: string | null;
};

type Env = Record<string, string | undefined>;

function text(env: Env, key: string): string | null {
  const value = env[key]?.trim();
  return value ? value : null;
}

function int(env: Env, key: string, fallback: number): number {
  const value = text(env, key);
  if (value === null) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new ConfigError(`${key} must be a whole number, got "${value}"`);
  return n;
}

function oneOf<T extends string>(env: Env, key: string, options: readonly T[]): T {
  const value = text(env, key) ?? options[0]!;
  if (!options.includes(value as T)) throw new ConfigError(`${key} must be one of ${options.join(", ")}; got "${value}"`);
  return value as T;
}

function domain(env: Env, key: string, product: "freshdesk.com" | "freshservice.com"): string {
  try {
    return normalizeDomain(text(env, key) ?? "", product);
  } catch {
    throw new ConfigError(`${key} is empty`);
  }
}

function freshdeskConfig(env: Env): FreshdeskConfig {
  if (!text(env, "FRESHDESK_DOMAIN") || !text(env, "FRESHDESK_API_KEY")) {
    throw new ConfigError("TICKETS=freshdesk needs FRESHDESK_DOMAIN and FRESHDESK_API_KEY; see .env.example");
  }
  const ingest = oneOf(env, "FRESHDESK_INGEST", ["webhook", "poll"] as const);
  const webhookSecret = text(env, "FRESHDESK_WEBHOOK_SECRET");
  if (ingest === "webhook" && !webhookSecret) {
    throw new ConfigError("FRESHDESK_INGEST=webhook needs FRESHDESK_WEBHOOK_SECRET, so only your automation rule can post tickets; see .env.example");
  }
  return {
    domain: domain(env, "FRESHDESK_DOMAIN", "freshdesk.com"),
    apiKey: text(env, "FRESHDESK_API_KEY")!,
    webhookSecret,
    ingest,
    pollSeconds: Math.max(5, int(env, "FRESHDESK_POLL_SECONDS", 15)),
    actions: oneOf(env, "FRESHDESK_ACTIONS", ["rest", "mcp"] as const),
  };
}

/** FRESHSERVICE_GROUPS: service=groupId pairs, and "*" for every other service. */
function groupsOf(value: string | null): Record<string, number> {
  const groups: Record<string, number> = {};
  for (const pair of (value ?? "").split(",").map((p) => p.trim()).filter(Boolean)) {
    const [service, id] = pair.split("=").map((p) => p.trim());
    const n = Number(id);
    if (!service || !Number.isInteger(n) || n <= 0) throw new ConfigError(`FRESHSERVICE_GROUPS takes service=groupId pairs, got "${pair}"`);
    groups[service] = n;
  }
  return groups;
}

function freshserviceConfig(env: Env): FreshserviceConfig {
  const missing = ["FRESHSERVICE_DOMAIN", "FRESHSERVICE_API_KEY", "FRESHSERVICE_REQUESTER_EMAIL"].filter((k) => !text(env, k));
  if (missing.length > 0) throw new ConfigError(`INCIDENTS=freshservice needs ${missing.join(", ")}; see .env.example`);
  const workspace = text(env, "FRESHSERVICE_WORKSPACE_ID");
  return {
    domain: domain(env, "FRESHSERVICE_DOMAIN", "freshservice.com"),
    apiKey: text(env, "FRESHSERVICE_API_KEY")!,
    requesterEmail: text(env, "FRESHSERVICE_REQUESTER_EMAIL")!,
    workspaceId: workspace === null ? null : int(env, "FRESHSERVICE_WORKSPACE_ID", 0),
    groups: groupsOf(text(env, "FRESHSERVICE_GROUPS")),
  };
}

function vobizConfig(env: Env, mock: MockPortsConfig | null): VobizConfig {
  const timing = {
    ringTimeoutSec: Math.max(10, int(env, "VOBIZ_RING_TIMEOUT_SEC", 30)),
    timeLimitSec: Math.max(30, int(env, "VOBIZ_TIME_LIMIT_SEC", 300)),
  };
  // The mock places no real calls and calls back on localhost, so it needs no public URL and no admin token.
  if (mock) {
    return {
      authId: MOCK.vobizAuthId,
      authToken: MOCK.vobizAuthToken,
      from: MOCK.vobizFrom,
      ...timing,
      apiBase: `http://localhost:${mock.vobiz}`,
      callbackBaseUrl: `http://localhost:${int(env, "PORT", 8787)}`,
      sarvam: null,
      allowedNumbers: [],
    };
  }
  const missing = ["VOBIZ_AUTH_ID", "VOBIZ_AUTH_TOKEN", "VOBIZ_FROM_NUMBER"].filter((k) => !text(env, k));
  if (missing.length > 0) throw new ConfigError(`TELEPHONY=vobiz needs ${missing.join(", ")}; see .env.example`);
  const base = text(env, "PUBLIC_BASE_URL");
  if (!base?.startsWith("https://")) {
    throw new ConfigError("TELEPHONY=vobiz needs PUBLIC_BASE_URL set to this server's public https:// URL, so Vobiz can fetch what each call says");
  }
  // A public server that can place real calls must not let anyone start them.
  if (!text(env, "ADMIN_TOKEN")) throw new ConfigError("TELEPHONY=vobiz needs ADMIN_TOKEN, so only an admin can place a test call");
  const from = text(env, "VOBIZ_FROM_NUMBER")!;
  if (!/^\+?[1-9]\d{7,14}$/.test(from.replace(/[\s()-]/g, ""))) throw new ConfigError("VOBIZ_FROM_NUMBER must be a phone number in E.164 format, e.g. +918065551234");
  const voice = oneOf(env, "VOBIZ_VOICE", ["vobiz", "sarvam"] as const);
  if (voice === "sarvam" && !text(env, "SARVAM_API_KEY")) throw new ConfigError("VOBIZ_VOICE=sarvam needs SARVAM_API_KEY; see .env.example");
  const allowedNumbers = (text(env, "VOBIZ_ALLOWED_NUMBERS") ?? "").split(",").map((n) => n.trim()).filter(Boolean);
  const bad = allowedNumbers.find((n) => !/^\+?[1-9]\d{7,14}$/.test(n.replace(/[\s()-]/g, "")));
  if (bad) throw new ConfigError(`VOBIZ_ALLOWED_NUMBERS: "${bad}" is not a phone number in E.164 format`);
  return {
    authId: text(env, "VOBIZ_AUTH_ID")!,
    authToken: text(env, "VOBIZ_AUTH_TOKEN")!,
    from,
    ...timing,
    apiBase: "https://api.vobiz.ai",
    callbackBaseUrl: base.replace(/\/+$/, ""),
    sarvam: voice === "sarvam" ? { apiKey: text(env, "SARVAM_API_KEY")!, speaker: text(env, "SARVAM_SPEAKER") ?? "priya" } : null,
    allowedNumbers,
  };
}

function oncallConfig(env: Env): OnCallConfig {
  const missing = ["FRESHSERVICE_DOMAIN", "FRESHSERVICE_API_KEY", "FRESHSERVICE_ONCALL_SCHEDULE_ID"].filter((k) => !text(env, k));
  if (missing.length > 0) throw new ConfigError(`ONCALL=freshservice needs ${missing.join(", ")}; see .env.example`);
  const id = (key: string, value: string) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) throw new ConfigError(`${key} must be a schedule id (a whole number), got "${value}"`);
    return n;
  };
  const schedules: Record<string, number> = {};
  for (const pair of (text(env, "FRESHSERVICE_ONCALL_SCHEDULES") ?? "").split(",").map((p) => p.trim()).filter(Boolean)) {
    const [service, schedule] = pair.split("=").map((p) => p.trim());
    if (!service || !schedule) throw new ConfigError(`FRESHSERVICE_ONCALL_SCHEDULES takes service=scheduleId pairs, got "${pair}"`);
    schedules[service] = id("FRESHSERVICE_ONCALL_SCHEDULES", schedule);
  }
  return {
    domain: domain(env, "FRESHSERVICE_DOMAIN", "freshservice.com"),
    apiKey: text(env, "FRESHSERVICE_API_KEY")!,
    defaultScheduleId: id("FRESHSERVICE_ONCALL_SCHEDULE_ID", text(env, "FRESHSERVICE_ONCALL_SCHEDULE_ID")!),
    schedules,
  };
}

function alertsConfig(env: Env): AlertsConfig {
  const missing = ["FRESHSERVICE_DOMAIN", "FRESHSERVICE_API_KEY"].filter((k) => !text(env, k));
  if (missing.length > 0) throw new ConfigError(`ALERTS=freshservice needs ${missing.join(", ")}; see .env.example`);
  const ingest = oneOf(env, "FRESHSERVICE_ALERTS_INGEST", ["poll", "webhook"] as const);
  if (ingest === "webhook" && !text(env, "FRESHSERVICE_WEBHOOK_SECRET")) {
    throw new ConfigError("FRESHSERVICE_ALERTS_INGEST=webhook needs FRESHSERVICE_WEBHOOK_SECRET, so only your workflow can post alerts; see .env.example");
  }
  const rules = (text(env, "FRESHSERVICE_ALERT_SERVICES") ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((pair) => {
      const [match, service] = pair.split("=").map((p) => p.trim());
      if (!match || !service) throw new ConfigError(`FRESHSERVICE_ALERT_SERVICES takes text=service pairs, got "${pair}"`);
      return { match, service };
    });
  return {
    domain: domain(env, "FRESHSERVICE_DOMAIN", "freshservice.com"),
    apiKey: text(env, "FRESHSERVICE_API_KEY")!,
    ingest,
    pollSeconds: Math.max(10, int(env, "FRESHSERVICE_ALERTS_POLL_SECONDS", 30)),
    rules,
  };
}

/**
 * INFRA_MCP_SERVERS: a JSON array of servers. A server reached by URL must
 * use https (plain http only for localhost), and its host must be in
 * INFRA_MCP_ALLOWED_HOSTS, so a mistyped or injected URL can't send
 * CrisisCrew's credentials elsewhere.
 */
function infraConfig(env: Env): InfraConfig {
  const raw = text(env, "INFRA_MCP_SERVERS");
  if (!raw) throw new ConfigError("INFRA=mcp needs INFRA_MCP_SERVERS, a JSON array of MCP servers; see .env.example");
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ConfigError("INFRA_MCP_SERVERS must be JSON: an array of {name, kind, url or command, ...}");
  }
  const parsed = z.array(McpServerSchema).min(1).safeParse(json);
  if (!parsed.success) throw new ConfigError(`INFRA_MCP_SERVERS: ${parsed.error.issues.map((i) => `${i.path.join(".") || "servers"}: ${i.message}`).join("; ")}`);
  const allowed = new Set((text(env, "INFRA_MCP_ALLOWED_HOSTS") ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean));
  for (const server of parsed.data) {
    if (!server.url) continue;
    const url = new URL(server.url);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !local) throw new ConfigError(`INFRA_MCP_SERVERS: ${server.name} must use https (plain http is only for localhost)`);
    if (!local && !allowed.has(url.hostname.toLowerCase())) throw new ConfigError(`INFRA_MCP_SERVERS: ${server.name}'s host ${url.hostname} isn't in INFRA_MCP_ALLOWED_HOSTS`);
  }
  return { servers: parsed.data };
}

function url(env: Env, key: string, fallback: string): string {
  const value = text(env, key) ?? fallback;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("protocol");
    return value.replace(/\/+$/, "");
  } catch {
    throw new ConfigError(`${key} must be an http or https URL, got "${value}"`);
  }
}

function layaConfig(env: Env): LayaConfig {
  const model = text(env, "LAYA_MODEL");
  if (model && !["english", "multilingual", "typed-decisions"].includes(model)) {
    throw new ConfigError(`LAYA_MODEL must be one of english, multilingual, typed-decisions (or unset to let Laya's router pick); got "${model}"`);
  }
  return { baseUrl: url(env, "LAYA_URL", "http://localhost:8000"), apiKey: text(env, "LAYA_API_KEY"), model };
}

function lakeraConfig(env: Env): LakeraConfig {
  const apiKey = text(env, "LAKERA_API_KEY");
  if (!apiKey) throw new ConfigError("PROMPT_GUARD=lakera needs LAKERA_API_KEY; see .env.example");
  return { apiKey, projectId: text(env, "LAKERA_PROJECT_ID") };
}

function langsmithConfig(env: Env): LangSmithConfig {
  const apiKey = text(env, "LANGSMITH_API_KEY") ?? text(env, "LANGCHAIN_API_KEY");
  if (!apiKey) throw new ConfigError("TRACING=langsmith needs LANGSMITH_API_KEY; see .env.example");
  return {
    apiKey,
    project: text(env, "LANGSMITH_PROJECT") ?? text(env, "LANGCHAIN_PROJECT") ?? "crisiscrew",
    endpoint: url(env, "LANGSMITH_ENDPOINT", "https://api.smith.langchain.com"),
  };
}

type MockPortsConfig = MockPorts;

/** The ports INTEGRATIONS switches together, and the adapter each one uses outside the sandbox. */
const EXTERNAL_SWITCHES: Record<string, string> = { TICKETS: "freshdesk", INCIDENTS: "freshservice", ONCALL: "freshservice", ALERTS: "freshservice", TELEPHONY: "vobiz" };

/**
 * INTEGRATIONS=mock or real switches the Freshworks and Vobiz ports on
 * together. A port set explicitly to sandbox stays sandbox, so one service
 * can be left out. In mock mode the domains, keys and secrets are the
 * mock's, whatever .env says: mock mode can never write to a real account.
 */
function withIntegrations(env: Env): { env: Env; integrations: IntegrationsMode; mock: MockPortsConfig | null } {
  const integrations = oneOf(env, "INTEGRATIONS", ["sandbox", "mock", "real"] as const);
  if (integrations === "sandbox") return { env, integrations, mock: null };
  const switches: Env = {};
  for (const [key, adapter] of Object.entries(EXTERNAL_SWITCHES)) {
    const given = text(env, key);
    if (given && given !== "sandbox" && given !== adapter) throw new ConfigError(`INTEGRATIONS=${integrations} uses ${key}=${adapter} (or sandbox to leave it out); got "${given}"`);
    switches[key] = given === "sandbox" ? "sandbox" : adapter;
  }
  if (integrations === "real") return { env: { ...env, ...switches }, integrations, mock: null };
  const mock = mockPorts(int(env, "MOCK_PORT", MOCK.defaultPort));
  return {
    integrations,
    mock,
    env: {
      ...env,
      ...switches,
      AUTOFIX: text(env, "AUTOFIX") === "off" ? "off" : "mock",
      LIVE_WORLD: text(env, "LIVE_WORLD") ?? "checkout-autofix",
      FRESHDESK_DOMAIN: `localhost:${mock.freshdesk}`,
      FRESHDESK_API_KEY: MOCK.freshdeskApiKey,
      FRESHDESK_INGEST: "webhook",
      FRESHDESK_WEBHOOK_SECRET: MOCK.webhookSecret,
      FRESHDESK_ACTIONS: "rest",
      FRESHSERVICE_DOMAIN: `localhost:${mock.freshservice}`,
      FRESHSERVICE_API_KEY: MOCK.freshserviceApiKey,
      FRESHSERVICE_REQUESTER_EMAIL: MOCK.requesterEmail,
      FRESHSERVICE_WORKSPACE_ID: undefined,
      FRESHSERVICE_ONCALL_SCHEDULE_ID: String(MOCK.oncallScheduleId),
      FRESHSERVICE_ONCALL_SCHEDULES: undefined,
      FRESHSERVICE_ALERTS_INGEST: "webhook",
      FRESHSERVICE_WEBHOOK_SECRET: MOCK.webhookSecret,
    },
  };
}

const truthy = (value: string | null) => value !== null && ["true", "1", "yes"].includes(value.toLowerCase());

/** Reads and validates configuration from environment variables. See .env.example. */
export function loadConfig(input: Env): Config {
  const alias = ["true", "1", "yes"].includes((text(input, "LANGSMITH_TRACING") ?? text(input, "LANGCHAIN_TRACING_V2") ?? "").toLowerCase());
  const traced: Env = !text(input, "TRACING") && alias ? { ...input, TRACING: "langsmith" } : input;
  const { env, integrations, mock } = withIntegrations(traced);
  const switches = {} as Record<PortName, string>;
  for (const [port, spec] of Object.entries(PORTS) as [PortName, PortSpec][]) {
    const value = text(env, spec.env) ?? spec.options[0]!;
    if (!spec.options.includes(value)) throw new ConfigError(`${spec.env} must be one of ${spec.options.join(", ")}; got "${value}"`);
    if (!spec.wired.includes(value)) {
      throw new ConfigError(`${spec.env}=${value}: adapter "${value}" is not wired yet. Use ${spec.wired.join(" or ")}; see .env.example`);
    }
    switches[port] = value;
  }

  const mcpTokens = {} as Record<Identity, string>;
  const generatedTokens: Identity[] = [];
  for (const identity of MCP_IDENTITIES) {
    const given = text(env, `MCP_TOKEN_${identity.toUpperCase()}`);
    mcpTokens[identity] = given ?? randomBytes(16).toString("hex");
    if (!given) generatedTokens.push(identity);
  }

  const exposedBy = text(env, "PUBLIC_BASE_URL") ? "PUBLIC_BASE_URL is set" : text(env, "CRISISCREW_ENV") === "production" ? "CRISISCREW_ENV=production" : null;
  if (exposedBy && (!text(env, "ADMIN_TOKEN") || !text(env, "APPROVER_TOKEN"))) {
    const missing = [!text(env, "ADMIN_TOKEN") && "ADMIN_TOKEN", !text(env, "APPROVER_TOKEN") && "APPROVER_TOKEN"].filter(Boolean).join(" and ");
    throw new ConfigError(`${exposedBy}, so the server is reachable from outside: set ${missing}; see .env.example`);
  }

  const laya = switches.classifier === "laya" ? layaConfig(env) : null;
  const lakera = switches.guard === "lakera" ? lakeraConfig(env) : null;
  const langsmith = switches.tracing === "langsmith" ? langsmithConfig(env) : null;
  const egress = [...new Set([laya && hostOf(laya.baseUrl), lakera && "api.lakera.ai", langsmith && hostOf(langsmith.endpoint)].filter((h): h is string => Boolean(h)))];

  const autofix: AutofixConfig | null =
    switches.autofix === "mock" && mock
      ? {
          githubBase: `http://localhost:${mock.github}`,
          googleBase: `http://localhost:${mock.google}`,
          slackBase: `http://localhost:${mock.slack}`,
          viewBase: `http://localhost:${mock.freshdesk}/#/docs/`,
          repos: { ...MOCK.repos },
          replayFile: text(env, "AUTOFIX_REPLAY") ?? "apps/mock/fixtures/checkout-service.opencode.json",
          workspaceRoot: text(env, "AUTOFIX_WORKSPACES") ?? "data/workspaces",
        }
      : null;
  if (switches.autofix === "mock" && !mock) throw new ConfigError("AUTOFIX=mock needs INTEGRATIONS=mock: the Fix Agent's mock services come with the other mocks");

  return {
    integrations,
    mock,
    liveWorld: text(env, "LIVE_WORLD") ?? "checkout-v4.21.7",
    autofix,
    port: int(env, "PORT", 8787),
    publicBaseUrl: text(env, "PUBLIC_BASE_URL"),
    adminToken: text(env, "ADMIN_TOKEN"),
    approverToken: text(env, "APPROVER_TOKEN"),
    sandboxLatencyMs: int(env, "SANDBOX_LATENCY_MS", 350),
    switches,
    embeddingsModel: text(env, "EMBEDDINGS_MODEL") ?? DEFAULT_EMBEDDING_MODEL,
    embeddingsDir: text(env, "EMBEDDINGS_MODEL_DIR") ?? MODELS_DIR,
    embeddingsThreads: int(env, "EMBEDDINGS_THREADS", 2),
    mcpTokens,
    generatedTokens,
    freshdesk: switches.tickets === "freshdesk" ? freshdeskConfig(env) : null,
    freshservice: switches.incidents === "freshservice" ? freshserviceConfig(env) : null,
    laya,
    lakera,
    langsmith,
    egress,
    rateLimitPerMinute: int(env, "RATE_LIMIT_PER_MINUTE", 120),
    vobiz: switches.telephony === "vobiz" ? vobizConfig(env, mock) : null,
    oncall: switches.oncall === "freshservice" ? oncallConfig(env) : null,
    alerts: switches.alerts === "freshservice" ? alertsConfig(env) : null,
    infra: switches.infra === "mcp" ? infraConfig(env) : null,
    freshserviceWebhookSecret: text(env, "FRESHSERVICE_WEBHOOK_SECRET"),
  };
}

/** What is live, what is sandbox, and which live adapters are available or only designed. Shown by GET /api/wiring and the UI. */
export function wiringReport(config: Config): WiringReport {
  const ports = (Object.entries(PORTS) as [PortName, PortSpec][]).map(([port, spec]) => {
    const value = config.switches[port];
    return {
      port,
      mode: spec.mode(value, config),
      adapter: value,
      detail: spec.detail(value, config),
      available: spec.wired.filter((o) => o !== value && spec.mode(o, { ...config, integrations: "real" }) === "live"),
      planned: spec.options.filter((o) => !spec.wired.includes(o)),
      env: spec.env,
    };
  });
  return { ports, liveCount: ports.filter((p) => p.mode === "live").length };
}
