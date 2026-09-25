import { integrationIdOf, normalizeDomain, redactEndpoint } from "@crisiscrew/adapters";
import type { Identity, PortMode, PortName, WiringReport } from "@crisiscrew/contracts";
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
  mode: (value: string) => PortMode;
  detail: (value: string, config: Config) => string;
};

const sandboxMode = () => "sandbox" as const;

function ticketsDetail(value: string, { freshdesk }: Config): string {
  if (value !== "freshdesk" || !freshdesk) return "Scenario replay and tickets typed into the UI";
  const ingest = freshdesk.ingest === "webhook" ? "webhook ingest" : `polled every ${freshdesk.pollSeconds} s`;
  const writes = freshdesk.actions === "mcp" ? "Freshdesk's MCP server" : "the REST API";
  return `Freshdesk (${freshdesk.domain}): ${ingest}; notes and replies through ${writes}. Replays and typed tickets stay in the sandbox`;
}

const PORTS: Record<PortName, PortSpec> = {
  tickets: {
    env: "TICKETS",
    options: ["sandbox", "freshdesk"],
    wired: ["sandbox", "freshdesk"],
    mode: (v) => (v === "freshdesk" ? "live" : "sandbox"),
    detail: ticketsDetail,
  },
  incidents: {
    env: "INCIDENTS",
    options: ["sandbox", "freshservice"],
    wired: ["sandbox", "freshservice"],
    mode: (v) => (v === "freshservice" ? "live" : "sandbox"),
    detail: (v, c) =>
      v === "freshservice" && c.freshservice
        ? `Freshservice (${c.freshservice.domain}): an incident for each CrisisCrew incident, with notes, filed as ${c.freshservice.requesterEmail}`
        : "Engineering incidents kept in memory",
  },
  deployments: { env: "DEPLOYMENTS", options: ["sandbox", "github"], wired: ["sandbox"], mode: sandboxMode, detail: () => "The scenario's release history" },
  payments: { env: "PAYMENTS", options: ["sandbox", "razorpay-status"], wired: ["sandbox"], mode: sandboxMode, detail: () => "The scenario's gateway status" },
  metrics: { env: "METRICS", options: ["sandbox"], wired: ["sandbox"], mode: sandboxMode, detail: () => "Error rates simulated from the scenario's releases" },
  alerts: {
    env: "ALERTS",
    options: ["sandbox", "freshservice-ams"],
    wired: ["sandbox", "freshservice-ams"],
    mode: (v) => (v === "freshservice-ams" ? "live" : "sandbox"),
    detail: (v, c) =>
      v === "freshservice-ams" && c.alerts
        ? `Freshservice Alert Management (integration ${c.alerts.integrationId ?? "?"}): incidents are pushed to ${c.alerts.redactedEndpoint}; alerts post in on ${c.alerts.webhookPath}`
        : "Alerts simulated from the scenario's releases",
  },
  orders: { env: "ORDERS", options: ["sandbox"], wired: ["sandbox"], mode: sandboxMode, detail: () => "The scenario's customers and payment attempts" },
  voice: { env: "VOICE", options: ["off", "elevenlabs"], wired: ["off"], mode: () => "off", detail: () => "Voice scripts are prepared; no audio is generated" },
  llm: { env: "LLM", options: ["template", "anthropic"], wired: ["template"], mode: () => "off", detail: () => "Fixed templates; no language model is called" },
  embeddings: {
    env: "EMBEDDINGS",
    options: ["local", "hash"],
    wired: ["local", "hash"],
    mode: (v) => (v === "local" ? "live" : "sandbox"),
    detail: (v, c) => (v === "local" ? `${c.embeddingsModel}, running on this machine` : "Word hashing, for tests only: cannot match different wordings"),
  },
  credits: { env: "CREDITS", options: ["sandbox", "dodo"], wired: ["sandbox"], mode: sandboxMode, detail: () => "An in-memory ledger" },
  translate: { env: "TRANSLATE", options: ["off", "sarvam"], wired: ["off"], mode: () => "off", detail: () => "Tickets are embedded as written" },
};

const MCP_IDENTITIES: Identity[] = ["pattern", "commander", "investigator", "recovery", "handoff", "operator"];

export type FreshdeskConfig = {
  domain: string;
  apiKey: string;
  webhookSecret: string | null;
  ingest: "webhook" | "poll";
  pollSeconds: number;
  actions: "rest" | "mcp";
};

export type FreshserviceConfig = { domain: string; apiKey: string; requesterEmail: string; workspaceId: number | null };

/** Freshservice Alert Management: the integration endpoint CrisisCrew pushes to, and the secrets guarding its inbound webhook. */
export type AlertsConfig = {
  endpoint: string;
  /** The endpoint with its auth-key masked, for logs and the wiring report. */
  redactedEndpoint: string;
  integrationId: string | null;
  /** The path monitoring tools post alerts to, e.g. "/api/webhooks/alerts". */
  webhookPath: string;
  /** Shared secret required on the inbound webhook; null leaves it open (local demo). */
  webhookSecret: string | null;
};

export type Config = {
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
  alerts: AlertsConfig | null;
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

function freshserviceConfig(env: Env): FreshserviceConfig {
  const missing = ["FRESHSERVICE_DOMAIN", "FRESHSERVICE_API_KEY", "FRESHSERVICE_REQUESTER_EMAIL"].filter((k) => !text(env, k));
  if (missing.length > 0) throw new ConfigError(`INCIDENTS=freshservice needs ${missing.join(", ")}; see .env.example`);
  const workspace = text(env, "FRESHSERVICE_WORKSPACE_ID");
  return {
    domain: domain(env, "FRESHSERVICE_DOMAIN", "freshservice.com"),
    apiKey: text(env, "FRESHSERVICE_API_KEY")!,
    requesterEmail: text(env, "FRESHSERVICE_REQUESTER_EMAIL")!,
    workspaceId: workspace === null ? null : int(env, "FRESHSERVICE_WORKSPACE_ID", 0),
  };
}

function alertsConfig(env: Env): AlertsConfig {
  const endpoint = text(env, "FRESHSERVICE_ALERT_ENDPOINT");
  if (!endpoint) {
    throw new ConfigError("ALERTS=freshservice-ams needs FRESHSERVICE_ALERT_ENDPOINT (the integration URL with its auth-key); see .env.example");
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new ConfigError(`FRESHSERVICE_ALERT_ENDPOINT is not a URL: "${endpoint}"`);
  }
  if (!url.searchParams.get("auth-key")) {
    throw new ConfigError("FRESHSERVICE_ALERT_ENDPOINT must include its ?auth-key=..., or Freshservice answers 401 not_authorized");
  }
  if (!/^https:$/.test(url.protocol)) throw new ConfigError("FRESHSERVICE_ALERT_ENDPOINT must be https");
  const webhookPath = text(env, "ALERTS_WEBHOOK_PATH") ?? "/api/webhooks/alerts";
  if (!webhookPath.startsWith("/")) throw new ConfigError(`ALERTS_WEBHOOK_PATH must start with "/"; got "${webhookPath}"`);
  return {
    endpoint,
    redactedEndpoint: redactEndpoint(endpoint),
    integrationId: integrationIdOf(endpoint),
    webhookPath,
    webhookSecret: text(env, "ALERTS_WEBHOOK_SECRET"),
  };
}

/** Reads and validates configuration from environment variables. See .env.example. */
export function loadConfig(env: Env): Config {
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

  return {
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
    alerts: switches.alerts === "freshservice-ams" ? alertsConfig(env) : null,
  };
}

/** What is live, what is sandbox, and which live adapters are available or only designed. Shown by GET /api/wiring and the UI. */
export function wiringReport(config: Config): WiringReport {
  const ports = (Object.entries(PORTS) as [PortName, PortSpec][]).map(([port, spec]) => {
    const value = config.switches[port];
    return {
      port,
      mode: spec.mode(value),
      adapter: value,
      detail: spec.detail(value, config),
      available: spec.wired.filter((o) => o !== value && spec.mode(o) === "live"),
      planned: spec.options.filter((o) => !spec.wired.includes(o)),
      env: spec.env,
    };
  });
  return { ports, liveCount: ports.filter((p) => p.mode === "live").length };
}
