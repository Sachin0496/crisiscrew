import { normalizeDomain } from "@crisiscrew/adapters";
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

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

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

export type LayaConfig = { baseUrl: string; apiKey: string | null; model: string | null };
export type LakeraConfig = { apiKey: string; projectId: string | null };
export type LangSmithConfig = { apiKey: string; project: string; endpoint: string };

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
  laya: LayaConfig | null;
  lakera: LakeraConfig | null;
  langsmith: LangSmithConfig | null;
  /** Hosts outbound model and tracing calls may reach; everything else is refused. */
  egress: string[];
  /** Requests per minute per client for each group of write endpoints; 0 turns limiting off. */
  rateLimitPerMinute: number;
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

const truthy = (value: string | null) => value !== null && ["true", "1", "yes"].includes(value.toLowerCase());

/** Reads and validates configuration from environment variables. See .env.example. */
export function loadConfig(input: Env): Config {
  // LangSmith's own switch (LANGSMITH_TRACING=true) means TRACING=langsmith, unless TRACING says otherwise.
  const env: Env = text(input, "TRACING") === null && (truthy(text(input, "LANGSMITH_TRACING")) || truthy(text(input, "LANGCHAIN_TRACING_V2"))) ? { ...input, TRACING: "langsmith" } : input;
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

  const publicBaseUrl = text(env, "PUBLIC_BASE_URL");
  const adminToken = text(env, "ADMIN_TOKEN");
  const approverToken = text(env, "APPROVER_TOKEN");
  // Open write routes are fine on a laptop, never on the internet: an exposed server refuses to start without both tokens.
  const exposedBy = publicBaseUrl ? "PUBLIC_BASE_URL is set" : text(env, "CRISISCREW_ENV") === "production" ? "CRISISCREW_ENV=production" : null;
  if (exposedBy && (!adminToken || !approverToken)) {
    const missing = [!adminToken && "ADMIN_TOKEN", !approverToken && "APPROVER_TOKEN"].filter(Boolean).join(" and ");
    throw new ConfigError(`${exposedBy}, so the server is reachable from outside: set ${missing}, or anyone could start replays, type tickets and approve credits; see .env.example`);
  }

  const laya = switches.classifier === "laya" ? layaConfig(env) : null;
  const lakera = switches.guard === "lakera" ? lakeraConfig(env) : null;
  const langsmith = switches.tracing === "langsmith" ? langsmithConfig(env) : null;
  const egress = [...new Set([laya && hostOf(laya.baseUrl), lakera && "api.lakera.ai", langsmith && hostOf(langsmith.endpoint)].filter((h): h is string => Boolean(h)))];

  return {
    port: int(env, "PORT", 8787),
    publicBaseUrl,
    adminToken,
    approverToken,
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
