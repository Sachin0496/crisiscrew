import { describe, expect, it } from "vitest";
import { ConfigError, DEFAULT_EMBEDDING_MODEL, loadConfig, wiringReport } from "./config";

describe("loadConfig", () => {
  it("defaults every port to sandbox (voice off) so it runs with no keys", () => {
    const config = loadConfig({});
    expect(config.port).toBe(8787);
    expect(config.switches).toEqual({
      tickets: "sandbox",
      incidents: "sandbox",
      deployments: "sandbox",
      payments: "sandbox",
      metrics: "sandbox",
      orders: "sandbox",
      voice: "off",
      llm: "template",
      embeddings: "local",
      credits: "sandbox",
      translate: "off",
      classifier: "embeddings",
      guard: "heuristic",
      tracing: "local",
    });
    expect(config.embeddingsModel).toBe(DEFAULT_EMBEDDING_MODEL);
    expect(config).toMatchObject({ freshdesk: null, freshservice: null, laya: null, lakera: null, langsmith: null, egress: [], rateLimitPerMinute: 120 });
  });

  it("switches Laya on, self-hosted by default, and allow-lists only its host", () => {
    const config = loadConfig({ CLASSIFIER: "laya" });
    expect(config.laya).toEqual({ baseUrl: "http://localhost:8000", apiKey: null, model: null });
    expect(config.egress).toEqual(["localhost:8000"]);
    expect(loadConfig({ CLASSIFIER: "laya", LAYA_URL: "https://api.laya.studio/", LAYA_API_KEY: "lsk_live_x", LAYA_MODEL: "multilingual" }).laya).toEqual({
      baseUrl: "https://api.laya.studio",
      apiKey: "lsk_live_x",
      model: "multilingual",
    });
    expect(() => loadConfig({ CLASSIFIER: "laya", LAYA_MODEL: "gpt" })).toThrow(/LAYA_MODEL must be one of english, multilingual, typed-decisions/);
    expect(() => loadConfig({ CLASSIFIER: "laya", LAYA_URL: "file:///etc/passwd" })).toThrow(/LAYA_URL must be an http or https URL/);
  });

  it("switches Lakera and LangSmith on with their keys, and accepts LangSmith's own LANGSMITH_TRACING switch", () => {
    expect(() => loadConfig({ PROMPT_GUARD: "lakera" })).toThrow("PROMPT_GUARD=lakera needs LAKERA_API_KEY; see .env.example");
    expect(loadConfig({ PROMPT_GUARD: "lakera", LAKERA_API_KEY: "lk" }).egress).toEqual(["api.lakera.ai"]);
    expect(() => loadConfig({ TRACING: "langsmith" })).toThrow("TRACING=langsmith needs LANGSMITH_API_KEY; see .env.example");
    const ls = loadConfig({ LANGSMITH_TRACING: "true", LANGSMITH_API_KEY: "lsv2_x" });
    expect(ls.switches.tracing).toBe("langsmith");
    expect(ls.langsmith).toEqual({ apiKey: "lsv2_x", project: "crisiscrew", endpoint: "https://api.smith.langchain.com" });
    expect(ls.egress).toEqual(["api.smith.langchain.com"]);
    expect(loadConfig({ LANGSMITH_TRACING: "true", TRACING: "local" }).switches.tracing).toBe("local");
  });

  it("refuses to start when it's reachable from outside without both tokens (security scenario 8)", () => {
    expect(() => loadConfig({ PUBLIC_BASE_URL: "https://crisiscrew.example" })).toThrow(/PUBLIC_BASE_URL is set.*set ADMIN_TOKEN and APPROVER_TOKEN/);
    expect(() => loadConfig({ CRISISCREW_ENV: "production", ADMIN_TOKEN: "a" })).toThrow(/CRISISCREW_ENV=production.*set APPROVER_TOKEN,/);
    expect(loadConfig({ PUBLIC_BASE_URL: "https://crisiscrew.example", ADMIN_TOKEN: "a", APPROVER_TOKEN: "b" }).publicBaseUrl).toBe("https://crisiscrew.example");
  });

  it("switches Freshdesk on with its keys, and refuses without them", () => {
    const keys = { TICKETS: "freshdesk", FRESHDESK_DOMAIN: "https://Acme.freshdesk.com/", FRESHDESK_API_KEY: "fd-key", FRESHDESK_WEBHOOK_SECRET: "s" };
    expect(loadConfig(keys).freshdesk).toEqual({ domain: "acme.freshdesk.com", apiKey: "fd-key", webhookSecret: "s", ingest: "webhook", pollSeconds: 15, actions: "rest" });
    expect(() => loadConfig({ TICKETS: "freshdesk" })).toThrow("TICKETS=freshdesk needs FRESHDESK_DOMAIN and FRESHDESK_API_KEY; see .env.example");
    expect(() => loadConfig({ ...keys, FRESHDESK_WEBHOOK_SECRET: "" })).toThrow(/FRESHDESK_INGEST=webhook needs FRESHDESK_WEBHOOK_SECRET/);
    expect(loadConfig({ ...keys, FRESHDESK_WEBHOOK_SECRET: "", FRESHDESK_INGEST: "poll", FRESHDESK_ACTIONS: "mcp" }).freshdesk).toMatchObject({ ingest: "poll", actions: "mcp" });
    expect(() => loadConfig({ ...keys, FRESHDESK_ACTIONS: "graphql" })).toThrow(/FRESHDESK_ACTIONS must be one of rest, mcp/);
  });

  it("switches Freshservice on with its keys and requester, and names what's missing", () => {
    const config = loadConfig({ INCIDENTS: "freshservice", FRESHSERVICE_DOMAIN: "acme", FRESHSERVICE_API_KEY: "fs", FRESHSERVICE_REQUESTER_EMAIL: "ops@acme.test" });
    expect(config.freshservice).toEqual({ domain: "acme.freshservice.com", apiKey: "fs", requesterEmail: "ops@acme.test", workspaceId: null });
    expect(() => loadConfig({ INCIDENTS: "freshservice", FRESHSERVICE_DOMAIN: "acme" })).toThrow(
      "INCIDENTS=freshservice needs FRESHSERVICE_API_KEY, FRESHSERVICE_REQUESTER_EMAIL; see .env.example",
    );
  });

  it("refuses to start with a live adapter that isn't wired yet, naming it", () => {
    expect(() => loadConfig({ DEPLOYMENTS: "github" })).toThrow(ConfigError);
    expect(() => loadConfig({ DEPLOYMENTS: "github" })).toThrow(/DEPLOYMENTS=github.*not wired yet/);
    expect(() => loadConfig({ VOICE: "elevenlabs" })).toThrow(/not wired yet/);
  });

  it("rejects a value that is not an option at all", () => {
    expect(() => loadConfig({ TICKETS: "zendesk" })).toThrow(/TICKETS must be one of sandbox, freshdesk/);
  });

  it("uses the MCP tokens it is given and generates the rest", () => {
    const config = loadConfig({ MCP_TOKEN_OPERATOR: "operator-secret" });
    expect(config.mcpTokens.operator).toBe("operator-secret");
    expect(config.mcpTokens.pattern).toMatch(/^[0-9a-f]{32}$/);
    expect(config.generatedTokens).toContain("pattern");
    expect(config.generatedTokens).not.toContain("operator");
  });

  it("reads numbers and optional tokens", () => {
    const config = loadConfig({ PORT: "9000", SANDBOX_LATENCY_MS: "0", ADMIN_TOKEN: "a", APPROVER_TOKEN: "" });
    expect(config).toMatchObject({ port: 9000, sandboxLatencyMs: 0, adminToken: "a", approverToken: null });
  });
});

describe("wiringReport", () => {
  it("reports every port as sandbox, with the live adapters available and the ones only planned", () => {
    const report = wiringReport(loadConfig({}));
    // Live means real computation on this machine, not simulated data: the embedding model, and the built-in
    // classifier, prompt guard and tracing. The world the agents act on is the sandbox.
    expect(report.liveCount).toBe(4);
    expect(report.ports).toHaveLength(14);
    expect(report.ports.find((p) => p.port === "classifier")).toMatchObject({ mode: "live", adapter: "embeddings", available: ["laya"], env: "CLASSIFIER" });
    expect(report.ports.find((p) => p.port === "tracing")).toMatchObject({ adapter: "local", available: ["langsmith"] });
    expect(report.ports.find((p) => p.port === "tickets")).toMatchObject({ mode: "sandbox", available: ["freshdesk"], planned: [], env: "TICKETS" });
    expect(report.ports.find((p) => p.port === "incidents")).toMatchObject({ mode: "sandbox", available: ["freshservice"], planned: [] });
    expect(report.ports.find((p) => p.port === "voice")).toMatchObject({ mode: "off", available: [], planned: ["elevenlabs"] });
    expect(report.ports.find((p) => p.port === "embeddings")).toMatchObject({ mode: "live", adapter: "local" });
  });

  it("reports Freshdesk and Freshservice as live once they're switched on", () => {
    const report = wiringReport(
      loadConfig({
        TICKETS: "freshdesk",
        FRESHDESK_DOMAIN: "acme",
        FRESHDESK_API_KEY: "k",
        FRESHDESK_INGEST: "poll",
        INCIDENTS: "freshservice",
        FRESHSERVICE_DOMAIN: "acme",
        FRESHSERVICE_API_KEY: "k",
        FRESHSERVICE_REQUESTER_EMAIL: "ops@acme.test",
      }),
    );
    expect(report.liveCount).toBe(6);
    expect(report.ports.find((p) => p.port === "tickets")?.detail).toBe(
      "Freshdesk (acme.freshdesk.com): polled every 15 s; notes and replies through the REST API. Replays and typed tickets stay in the sandbox",
    );
  });
});
