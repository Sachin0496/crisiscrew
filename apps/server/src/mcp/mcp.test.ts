import { CachedEmbedder } from "@crisiscrew/adapters";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { DEFAULT_EMBEDDING_MODEL, loadConfig } from "../config";
import { createApp } from "../http/app";
import { EMBEDDING_CACHE_DIR } from "../paths";
import { Runtime } from "../runtime";
import { loadPolicy, loadScenarios } from "../scenarios";

async function setup() {
  const config = loadConfig({ MCP_TOKEN_OPERATOR: "op-token", MCP_TOKEN_PATTERN: "pattern-token", MCP_TOKEN_INVESTIGATOR: "inv-token" });
  const runtime = new Runtime({
    policy: loadPolicy(),
    scenarios: loadScenarios(),
    embedder: new CachedEmbedder({ modelId: DEFAULT_EMBEDDING_MODEL, dir: EMBEDDING_CACHE_DIR, inner: null }),
    latencyMs: 0,
    liveWorld: "checkout-v4.21.7",
  });
  await runtime.start();
  return { app: createApp({ runtime, config }), runtime };
}

async function connect(app: Awaited<ReturnType<typeof setup>>["app"], token: string) {
  const transport = new StreamableHTTPClientTransport(new URL("http://crisiscrew.test/mcp"), {
    fetch: async (url, init) => app.fetch(new Request(url, init)),
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "crisiscrew-test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

const text = (result: unknown) => ((result as { content: { text: string }[] }).content[0]?.text ?? "");

describe("MCP endpoint", () => {
  it("shows an external client only the read-only tools", async () => {
    const { app } = await setup();
    const client = await connect(app, "op-token");
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["get_incident", "get_payment_health", "get_recent_deployments", "get_service_status", "search_recent_tickets"].sort(),
    );
    await client.close();
  });

  it("runs an allowed tool through the policy gate", async () => {
    const { app, runtime } = await setup();
    const client = await connect(app, "inv-token");
    const result = await client.callTool({ name: "get_payment_health", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain("razorpay");
    expect(runtime.engineNow().audit.entries().at(-1)).toMatchObject({ identity: "investigator", tool: "get_payment_health", decision: "allowed" });
    await client.close();
  });

  it("refuses the read-only Pattern Agent a write and records the refusal", async () => {
    const { app, runtime } = await setup();
    const client = await connect(app, "pattern-token");
    const result = await client.callTool({ name: "link_ticket_to_incident", arguments: { incidentId: "INC-2026-001", ticketId: "T-1001" } });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/Refused by the CrisisCrew policy gate: Pattern Agent is not allowed to call link_ticket_to_incident/);
    expect(runtime.engineNow().audit.entries().at(-1)).toMatchObject({ identity: "pattern", tool: "link_ticket_to_incident", decision: "denied" });
    await client.close();
  });

  it("answers a GET with 405, since the server is stateless", async () => {
    const { app } = await setup();
    const res = await app.request("/mcp", { headers: { authorization: "Bearer op-token" } });
    expect(res.status).toBe(405);
  });

  it("rejects a request without a known token", async () => {
    const { app } = await setup();
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
  });
});
