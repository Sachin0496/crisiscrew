import { describe, expect, it } from "vitest";
import { ConfigError, DEFAULT_EMBEDDING_MODEL, loadConfig, wiringReport } from "./config";

describe("loadConfig", () => {
  it("defaults every port to sandbox (voice off) so it runs with no keys", () => {
    const config = loadConfig({});
    expect(config.port).toBe(8787);
    expect(config.switches).toEqual({
      tickets: "sandbox",
      deployments: "sandbox",
      payments: "sandbox",
      metrics: "sandbox",
      orders: "sandbox",
      voice: "off",
      llm: "template",
      embeddings: "local",
      credits: "sandbox",
      translate: "off",
    });
    expect(config.embeddingsModel).toBe(DEFAULT_EMBEDDING_MODEL);
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
  it("reports every port as sandbox with its planned live adapters", () => {
    const report = wiringReport(loadConfig({}));
    // Only the local embedding model is live: it is real computation on this machine, not simulated data.
    expect(report.liveCount).toBe(1);
    expect(report.ports).toHaveLength(10);
    expect(report.ports.find((p) => p.port === "tickets")).toMatchObject({ mode: "sandbox", planned: ["freshdesk"] });
    expect(report.ports.find((p) => p.port === "voice")).toMatchObject({ mode: "off", planned: ["elevenlabs"] });
    expect(report.ports.find((p) => p.port === "embeddings")).toMatchObject({ mode: "live", adapter: "local" });
  });
});
