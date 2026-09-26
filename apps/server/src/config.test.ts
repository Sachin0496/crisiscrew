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
      infra: "sandbox",
      llm: "template",
      embeddings: "local",
      classifier: "embeddings",
      guard: "heuristic",
      tracing: "local",
      credits: "sandbox",
      translate: "off",
      autofix: "off",
    });
    expect(config.embeddingsModel).toBe(DEFAULT_EMBEDDING_MODEL);
    expect(config).toMatchObject({ freshdesk: null, freshservice: null, vobiz: null });
  });

  it("switches Freshdesk on with its keys, and refuses without them", () => {
    const keys = { TICKETS: "freshdesk", FRESHDESK_DOMAIN: "https://Acme.freshdesk.com/", FRESHDESK_API_KEY: "fd-key", FRESHDESK_WEBHOOK_SECRET: "s" };
    expect(loadConfig(keys).freshdesk).toEqual({ domain: "acme.freshdesk.com", apiKey: "fd-key", webhookSecret: "s", ingest: "webhook", pollSeconds: 15, actions: "rest", labels: false });
    expect(loadConfig({ ...keys, FRESHDESK_LABELS: "on" }).freshdesk?.labels).toBe(true);
    expect(() => loadConfig({ TICKETS: "freshdesk" })).toThrow("TICKETS=freshdesk needs FRESHDESK_DOMAIN and FRESHDESK_API_KEY; see .env.example");
    expect(() => loadConfig({ ...keys, FRESHDESK_WEBHOOK_SECRET: "" })).toThrow(/FRESHDESK_INGEST=webhook needs FRESHDESK_WEBHOOK_SECRET/);
    expect(loadConfig({ ...keys, FRESHDESK_WEBHOOK_SECRET: "", FRESHDESK_INGEST: "poll", FRESHDESK_ACTIONS: "mcp" }).freshdesk).toMatchObject({ ingest: "poll", actions: "mcp" });
    expect(() => loadConfig({ ...keys, FRESHDESK_ACTIONS: "graphql" })).toThrow(/FRESHDESK_ACTIONS must be one of rest, mcp/);
  });

  it("switches Freshservice on with its keys and requester, and names what's missing", () => {
    const config = loadConfig({ INCIDENTS: "freshservice", FRESHSERVICE_DOMAIN: "acme", FRESHSERVICE_API_KEY: "fs", FRESHSERVICE_REQUESTER_EMAIL: "ops@acme.test" });
    expect(config.freshservice).toEqual({ domain: "acme.freshservice.com", apiKey: "fs", requesterEmail: "ops@acme.test", workspaceId: null, groups: {} });
    const routed = loadConfig({ INCIDENTS: "freshservice", FRESHSERVICE_DOMAIN: "acme", FRESHSERVICE_API_KEY: "fs", FRESHSERVICE_REQUESTER_EMAIL: "ops@acme.test", FRESHSERVICE_GROUPS: "checkout-service=12, *=34" });
    expect(routed.freshservice?.groups).toEqual({ "checkout-service": 12, "*": 34 });
    expect(() => loadConfig({ INCIDENTS: "freshservice", FRESHSERVICE_DOMAIN: "acme", FRESHSERVICE_API_KEY: "fs", FRESHSERVICE_REQUESTER_EMAIL: "o@a.t", FRESHSERVICE_GROUPS: "checkout" })).toThrow(/service=groupId/);
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
      APPROVER_TOKEN: "approver",
    };
    expect(loadConfig(keys).vobiz).toEqual({
      authId: "MA123",
      authToken: "tok",
      from: "+918065551234",
      ringTimeoutSec: 30,
      timeLimitSec: 300,
      apiBase: "https://api.vobiz.ai",
      callbackBaseUrl: "https://crisis.example.com",
      sarvam: null,
      allowedNumbers: [],
    });
    expect(wiringReport(loadConfig(keys)).ports.find((p) => p.port === "telephony")).toMatchObject({ mode: "live", adapter: "vobiz" });
    expect(() => loadConfig({ ...keys, VOBIZ_AUTH_TOKEN: "", VOBIZ_FROM_NUMBER: "" })).toThrow("TELEPHONY=vobiz needs VOBIZ_AUTH_TOKEN, VOBIZ_FROM_NUMBER; see .env.example");
    expect(() => loadConfig({ ...keys, PUBLIC_BASE_URL: "http://localhost:8787" })).toThrow(/PUBLIC_BASE_URL.*https/);
    expect(() => loadConfig({ ...keys, ADMIN_TOKEN: "" })).toThrow(/ADMIN_TOKEN/);
    expect(() => loadConfig({ ...keys, VOBIZ_FROM_NUMBER: "reception" })).toThrow(/E\.164/);
  });

  it("offers the real-mode demo triggers only when their services are wired", () => {
    const fd = { TICKETS: "freshdesk", FRESHDESK_DOMAIN: "acme", FRESHDESK_API_KEY: "k", FRESHDESK_INGEST: "poll" };
    expect(loadConfig({}).demo).toEqual({ tickets: null, alert: null });
    expect(loadConfig(fd).demo.tickets).toEqual({ count: 17, gapMs: 4000 });
    expect(loadConfig({ ...fd, DEMO_TICKETS: "10", DEMO_TICKET_GAP_MS: "2000" }).demo.tickets).toEqual({ count: 10, gapMs: 2000 });
    const alert = { FRESHSERVICE_ALERT_WEBHOOK_URL: "https://acme.alerts.freshservice.com/integrations/1/alerts", FRESHSERVICE_ALERT_WEBHOOK_KEY: "auth-key abc" };
    expect(loadConfig(alert).demo.alert).toEqual({ url: alert.FRESHSERVICE_ALERT_WEBHOOK_URL, key: "abc", service: "checkout-service" });
    expect(() => loadConfig({ FRESHSERVICE_ALERT_WEBHOOK_URL: alert.FRESHSERVICE_ALERT_WEBHOOK_URL })).toThrow(/go together/);
    expect(() => loadConfig({ ...alert, FRESHSERVICE_ALERT_WEBHOOK_URL: "https://evil.example.com/x" })).toThrow(/alerts\.freshservice\.com/);
    expect(loadConfig({ CLASSIFIER: "laya-sim" }).switches.classifier).toBe("laya-sim");
  });

  it("voices on-call pages with Sarvam when asked, and calls only allowed numbers", () => {
    const keys = {
      TELEPHONY: "vobiz",
      VOBIZ_AUTH_ID: "MA123",
      VOBIZ_AUTH_TOKEN: "tok",
      VOBIZ_FROM_NUMBER: "+918065551234",
      PUBLIC_BASE_URL: "https://crisis.example.com",
      ADMIN_TOKEN: "admin",
      APPROVER_TOKEN: "approver",
      VOBIZ_VOICE: "sarvam",
      SARVAM_API_KEY: "sk",
      VOBIZ_ALLOWED_NUMBERS: "+91 98450 12345, +919876543210",
    };
    expect(loadConfig(keys).vobiz).toMatchObject({ sarvam: { apiKey: "sk", speaker: "priya" }, allowedNumbers: ["+91 98450 12345", "+919876543210"] });
    expect(wiringReport(loadConfig(keys)).ports.find((p) => p.port === "telephony")?.detail).toMatch(/Sarvam.*only 2 allowed numbers/);
    expect(() => loadConfig({ ...keys, SARVAM_API_KEY: "" })).toThrow(/VOBIZ_VOICE=sarvam needs SARVAM_API_KEY/);
    expect(() => loadConfig({ ...keys, VOBIZ_VOICE: "elevenlabs" })).toThrow(/VOBIZ_VOICE must be one of vobiz, sarvam/);
    expect(() => loadConfig({ ...keys, VOBIZ_ALLOWED_NUMBERS: "me" })).toThrow(/VOBIZ_ALLOWED_NUMBERS/);
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

  it("reads infrastructure MCP servers, and refuses a URL that isn't https or isn't on the allow-list", () => {
    const servers = (list: unknown[]) => ({ INFRA: "mcp", INFRA_MCP_SERVERS: JSON.stringify(list), INFRA_MCP_ALLOWED_HOSTS: "k8s-mcp.internal.example.com" });
    const k8s = { name: "k8s-prod", kind: "kubernetes", url: "https://k8s-mcp.internal.example.com/mcp", namespace: "shop" };
    const cw = { name: "cloudwatch", kind: "cloudwatch", command: "uvx", args: ["awslabs.cloudwatch-mcp-server@latest"] };
    expect(loadConfig(servers([k8s, cw])).infra).toEqual({ servers: [k8s, cw] });
    expect(wiringReport(loadConfig(servers([k8s]))).ports.find((p) => p.port === "infra")).toMatchObject({ mode: "live", adapter: "mcp" });
    expect(loadConfig(servers([{ ...k8s, url: "http://localhost:8080/mcp" }])).infra?.servers[0]?.url).toBe("http://localhost:8080/mcp");
    expect(() => loadConfig(servers([{ ...k8s, url: "http://k8s-mcp.internal.example.com/mcp" }]))).toThrow(/must use https/);
    expect(() => loadConfig(servers([{ ...k8s, url: "https://evil.example.net/mcp" }]))).toThrow(/evil.example.net isn't in INFRA_MCP_ALLOWED_HOSTS/);
    expect(() => loadConfig(servers([{ name: "both", kind: "kubernetes", url: k8s.url, command: "x" }]))).toThrow(/a url or a command, not both/);
    expect(() => loadConfig({ INFRA: "mcp" })).toThrow(/needs INFRA_MCP_SERVERS/);
    expect(() => loadConfig({ INFRA: "mcp", INFRA_MCP_SERVERS: "k8s" })).toThrow(/must be JSON/);
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

  it("requires separate admin and approver tokens when exposed publicly", () => {
    expect(() => loadConfig({ PUBLIC_BASE_URL: "https://crisis.example.com" })).toThrow(/ADMIN_TOKEN and APPROVER_TOKEN/);
    expect(() => loadConfig({ CRISISCREW_ENV: "production", ADMIN_TOKEN: "admin" })).toThrow(/APPROVER_TOKEN/);
    expect(loadConfig({ PUBLIC_BASE_URL: "https://crisis.example.com", ADMIN_TOKEN: "admin", APPROVER_TOKEN: "approver" })).toMatchObject({
      adminToken: "admin",
      approverToken: "approver",
    });
  });

  it("reads numbers and optional tokens", () => {
    const config = loadConfig({ PORT: "9000", SANDBOX_LATENCY_MS: "0", ADMIN_TOKEN: "a", APPROVER_TOKEN: "" });
    expect(config).toMatchObject({ port: 9000, sandboxLatencyMs: 0, adminToken: "a", approverToken: null });
  });
});

describe("INTEGRATIONS", () => {
  it("mock points Freshdesk, Freshservice and Vobiz at the local mock, whatever .env says", () => {
    const config = loadConfig({ INTEGRATIONS: "mock", FRESHDESK_DOMAIN: "acme", FRESHDESK_API_KEY: "real-key" });
    expect(config.switches).toMatchObject({ tickets: "freshdesk", incidents: "freshservice", oncall: "freshservice", alerts: "freshservice", telephony: "vobiz" });
    expect(config.freshdesk).toMatchObject({ domain: "localhost:8788", apiKey: "mock-freshdesk-key", ingest: "webhook" });
    expect(config.freshservice?.domain).toBe("localhost:8789");
    expect(config.vobiz).toMatchObject({ apiBase: "http://localhost:8790", callbackBaseUrl: "http://localhost:8787" });
    // No public URL, so no tokens are needed for a local mock demo.
    expect(config.adminToken).toBeNull();
    const report = wiringReport(config);
    expect(report.ports.find((p) => p.port === "tickets")).toMatchObject({ mode: "mock", adapter: "freshdesk" });
    expect(report.ports.find((p) => p.port === "telephony")?.detail).toMatch(/^Mock Vobiz/);
    expect(report.liveCount).toBe(4);
  });

  it("lets one port stay in the sandbox, and follows MOCK_PORT", () => {
    const config = loadConfig({ INTEGRATIONS: "mock", TELEPHONY: "sandbox", MOCK_PORT: "9100" });
    expect(config.switches.telephony).toBe("sandbox");
    expect(config.vobiz).toBeNull();
    expect(config.freshdesk?.domain).toBe("localhost:9100");
  });

  it("real switches the same ports on against the real services, and needs their keys", () => {
    expect(() => loadConfig({ INTEGRATIONS: "real" })).toThrow(/TICKETS=freshdesk needs FRESHDESK_DOMAIN/);
    expect(() => loadConfig({ INTEGRATIONS: "real", TICKETS: "sandbox", INCIDENTS: "sandbox", ONCALL: "sandbox", ALERTS: "sandbox", TELEPHONY: "vobiz" })).toThrow(/TELEPHONY=vobiz needs/);
    expect(() => loadConfig({ INTEGRATIONS: "mock", TICKETS: "zendesk" })).toThrow(/INTEGRATIONS=mock uses TICKETS=freshdesk/);
  });

  it("defaults to the sandbox", () => {
    expect(loadConfig({})).toMatchObject({ integrations: "sandbox", mock: null, freshdesk: null });
  });
});

describe("wiringReport", () => {
  it("reports every port as sandbox, with the live adapters available and the ones only planned", () => {
    const report = wiringReport(loadConfig({}));
    // The embedding model, built-in classifier, guard and local tracing run on this machine.
    expect(report.liveCount).toBe(4);
    expect(report.ports).toHaveLength(19);
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
    expect(report.liveCount).toBe(6);
    expect(report.ports.find((p) => p.port === "tickets")?.detail).toBe(
      "Freshdesk (acme.freshdesk.com): polled every 15 s; notes and replies through the REST API. Replays and typed tickets stay in the sandbox",
    );
  });
});
