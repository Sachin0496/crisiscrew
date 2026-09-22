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
  detail: (value: string, config: { embeddingsModel: string }) => string;
};

const sandboxMode = () => "sandbox" as const;

const PORTS: Record<PortName, PortSpec> = {
  tickets: { env: "TICKETS", options: ["sandbox", "freshdesk"], wired: ["sandbox"], mode: sandboxMode, detail: () => "Scenario replay and tickets typed into the UI" },
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
};

const MCP_IDENTITIES: Identity[] = ["pattern", "commander", "investigator", "recovery", "handoff", "operator"];

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
  };
}

/** What is live, what is sandbox, and which live adapters are designed but not wired. Shown by GET /api/wiring and the UI badge. */
export function wiringReport(config: Config): WiringReport {
  const ports = (Object.entries(PORTS) as [PortName, PortSpec][]).map(([port, spec]) => {
    const value = config.switches[port];
    return {
      port,
      mode: spec.mode(value),
      adapter: value,
      detail: spec.detail(value, config),
      planned: spec.options.filter((o) => !spec.wired.includes(o)),
    };
  });
  return { ports, liveCount: ports.filter((p) => p.mode === "live").length };
}
