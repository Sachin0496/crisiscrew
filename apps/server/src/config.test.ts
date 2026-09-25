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
      telephony: "sandbox",
      oncall: "sandbox",
      alerts: "sandbox",
      llm: "template",
      embeddings: "local",
      credits: "sandbox",
      translate: "off",
    });
    expect(config.embeddingsModel).toBe(DEFAULT_EMBEDDING_MODEL);
    expect(config).toMatchObject({ freshdesk: null, freshservice: null, vobiz: null });
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

  it("switches Vobiz on only with its keys, a public https URL and an admin token", () => {
    const keys = {
      TELEPHONY: "vobiz",
      VOBIZ_AUTH_ID: "MA123",
      VOBIZ_AUTH_TOKEN: "tok",
      VOBIZ_FROM_NUMBER: "+918065551234",
      PUBLIC_BASE_URL: "https://crisis.example.com",
      ADMIN_TOKEN: "admin",
    };
    expect(loadConfig(keys).vobiz).toEqual({ authId: "MA123", authToken: "tok", from: "+918065551234", ringTimeoutSec: 30, timeLimitSec: 300 });
    expect(wiringReport(loadConfig(keys)).ports.find((p) => p.port === "telephony")).toMatchObject({ mode: "live", adapter: "vobiz" });
    expect(() => loadConfig({ ...keys, VOBIZ_AUTH_TOKEN: "", VOBIZ_FROM_NUMBER: "" })).toThrow("TELEPHONY=vobiz needs VOBIZ_AUTH_TOKEN, VOBIZ_FROM_NUMBER; see .env.example");
    expect(() => loadConfig({ ...keys, PUBLIC_BASE_URL: "http://localhost:8787" })).toThrow(/PUBLIC_BASE_URL.*https/);
    expect(() => loadConfig({ ...keys, ADMIN_TOKEN: "" })).toThrow(/needs ADMIN_TOKEN/);
    expect(() => loadConfig({ ...keys, VOBIZ_FROM_NUMBER: "reception" })).toThrow(/E\.164/);
  });

  it("reads Freshservice on-call schedules, per service or by default, and names what's missing", () => {
    const keys = { ONCALL: "freshservice", FRESHSERVICE_DOMAIN: "acme", FRESHSERVICE_API_KEY: "fs", FRESHSERVICE_ONCALL_SCHEDULE_ID: "8569" };
    expect(loadConfig({ ...keys, FRESHSERVICE_ONCALL_SCHEDULES: "checkout-service=8570, auth-service=8571" }).oncall).toEqual({
      domain: "acme.freshservice.com",
      apiKey: "fs",
      defaultScheduleId: 8569,
      schedules: { "checkout-service": 8570, "auth-service": 8571 },
    });
    expect(wiringReport(loadConfig(keys)).ports.find((p) => p.port === "oncall")).toMatchObject({ mode: "live", adapter: "freshservice" });
    expect(() => loadConfig({ ONCALL: "freshservice", FRESHSERVICE_DOMAIN: "acme" })).toThrow("ONCALL=freshservice needs FRESHSERVICE_API_KEY, FRESHSERVICE_ONCALL_SCHEDULE_ID; see .env.example");
    expect(() => loadConfig({ ...keys, FRESHSERVICE_ONCALL_SCHEDULE_ID: "weekly" })).toThrow(/schedule id/);
    expect(() => loadConfig({ ...keys, FRESHSERVICE_ONCALL_SCHEDULES: "checkout-service" })).toThrow(/service=scheduleId/);
  });

  it("reads Freshservice Alert Management: poll by default, webhook only with its secret, and service rules", () => {
    const keys = { ALERTS: "freshservice", FRESHSERVICE_DOMAIN: "acme", FRESHSERVICE_API_KEY: "fs" };
    expect(loadConfig({ ...keys, FRESHSERVICE_ALERT_SERVICES: "checkout-5xx=checkout-service, auth=auth-service" }).alerts).toEqual({
      domain: "acme.freshservice.com",
      apiKey: "fs",
      ingest: "poll",
      pollSeconds: 30,
      rules: [
        { match: "checkout-5xx", service: "checkout-service" },
        { match: "auth", service: "auth-service" },
      ],
    });
    expect(() => loadConfig({ ...keys, FRESHSERVICE_ALERTS_INGEST: "webhook" })).toThrow(/needs FRESHSERVICE_WEBHOOK_SECRET/);
    expect(loadConfig({ ...keys, FRESHSERVICE_ALERTS_INGEST: "webhook", FRESHSERVICE_WEBHOOK_SECRET: "s" }).alerts?.ingest).toBe("webhook");
    expect(() => loadConfig({ ALERTS: "freshservice" })).toThrow("ALERTS=freshservice needs FRESHSERVICE_DOMAIN, FRESHSERVICE_API_KEY; see .env.example");
    expect(() => loadConfig({ ...keys, FRESHSERVICE_ALERT_SERVICES: "checkout" })).toThrow(/text=service pairs/);
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
    // Only the local embedding model is live: it is real computation on this machine, not simulated data.
    expect(report.liveCount).toBe(1);
    expect(report.ports).toHaveLength(14);
    expect(report.ports.find((p) => p.port === "oncall")).toMatchObject({ mode: "sandbox", available: ["freshservice"], env: "ONCALL" });
    expect(report.ports.find((p) => p.port === "telephony")).toMatchObject({ mode: "sandbox", available: ["vobiz"], planned: [], env: "TELEPHONY" });
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
    expect(report.liveCount).toBe(3);
    expect(report.ports.find((p) => p.port === "tickets")?.detail).toBe(
      "Freshdesk (acme.freshdesk.com): polled every 15 s; notes and replies through the REST API. Replays and typed tickets stay in the sandbox",
    );
  });
});
