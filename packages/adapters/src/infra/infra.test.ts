import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { mcpInfraHealth } from "./health";
import { McpToolClient, type McpServerConfig } from "./mcp-client";
import { parseAlarms, parsePods } from "./parse";

const TABLE = `NAMESPACE   APIVERSION   KIND   NAME                      READY   STATUS             RESTARTS      AGE
shop        v1           Pod    checkout-7d9f-abcde       0/1     CrashLoopBackOff   14 (2m ago)   3h
shop        v1           Pod    checkout-7d9f-fghij       0/1     CrashLoopBackOff   12 (1m ago)   3h
shop        v1           Pod    checkout-7d9f-klmno       1/1     Running            0             3h`;

const ALARMS = JSON.stringify({
  metric_alarms: [
    { alarm_name: "checkout-service-memory-high", state_value: "ALARM", metric_name: "MemoryUtilization", state_updated_timestamp: "2026-09-25T08:20:00Z", dimensions: [{ name: "Service", value: "checkout-service" }] },
    { alarm_name: "search-cpu", state_value: "ALARM", metric_name: "CPUUtilization", dimensions: [{ name: "Service", value: "search-service" }] },
  ],
  composite_alarms: [],
});

describe("infrastructure parsers", () => {
  it("reads pods from a kubectl-style table: ready, restarts and crash loops", () => {
    expect(parsePods(TABLE)).toEqual({ ready: 1, total: 3, restarts: 26, crashLooping: 2 });
  });

  it("reads pods from a JSON pod list or array", () => {
    const pod = (ready: boolean, restartCount: number, reason?: string) => ({
      status: { containerStatuses: [{ ready, restartCount, ...(reason ? { state: { waiting: { reason } } } : {}) }] },
    });
    expect(parsePods(JSON.stringify({ items: [pod(true, 0), pod(false, 9, "CrashLoopBackOff")] }))).toEqual({ ready: 1, total: 2, restarts: 9, crashLooping: 1 });
    expect(parsePods(JSON.stringify([pod(true, 1)]))).toEqual({ ready: 1, total: 1, restarts: 1, crashLooping: 0 });
  });

  it("returns null for a shape it can't read, rather than guessing", () => {
    expect(parsePods("apiVersion: v1\nkind: PodList\nitems: []")).toBeNull();
    expect(parseAlarms("ALARM checkout-service", "checkout-service")).toBeNull();
  });

  it("keeps only the alarms that name the service, with when they started", () => {
    expect(parseAlarms(ALARMS, "checkout-service")).toEqual([{ name: "checkout-service-memory-high", since: Date.parse("2026-09-25T08:20:00Z"), metric: "MemoryUtilization" }]);
    expect(parseAlarms(ALARMS, "auth-service")).toEqual([]);
  });
});

/** An MCP server in this process with the given tools, and a client connected to it. */
function serve(config: McpServerConfig, tools: Record<string, (args: Record<string, unknown>) => string | Promise<string>>) {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const client = new McpToolClient(config, () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const server = new McpServer({ name: config.name, version: "1.0.0" });
    for (const [name, run] of Object.entries(tools)) {
      server.registerTool(name, { inputSchema: { namespace: z.string().optional(), labelSelector: z.string().optional() } }, async (args) => {
        calls.push({ tool: name, args });
        return { content: [{ type: "text", text: await run(args) }] };
      });
    }
    void server.connect(serverSide);
    return clientSide;
  });
  return { client, calls };
}

describe("infrastructure health over MCP", () => {
  it("asks Kubernetes for the service's pods by label and CloudWatch for active alarms, naming each source", async () => {
    const kube = serve({ name: "k8s-prod", kind: "kubernetes", namespace: "shop", labelSelector: "app.kubernetes.io/name={service}" }, { pods_list_in_namespace: () => TABLE });
    const cloud = serve({ name: "cloudwatch", kind: "cloudwatch" }, { get_active_alarms: () => ALARMS });
    const port = mcpInfraHealth([kube.client, cloud.client]);
    const health = await port.health("checkout-service", 0);
    expect(health).toMatchObject({
      service: "checkout-service",
      pods: { ready: 1, total: 3, restarts: 26, crashLooping: 2 },
      alarms: [{ name: "checkout-service-memory-high" }],
      checks: expect.arrayContaining([
        { source: "mcp:k8s-prod", kind: "pods", checked: true, detail: "1/3 ready" },
        { source: "mcp:cloudwatch", kind: "alarms", checked: true, detail: "1 active" },
      ]),
    });
    expect(kube.calls).toEqual([{ tool: "pods_list_in_namespace", args: { namespace: "shop", labelSelector: "app.kubernetes.io/name=checkout-service" } }]);
    expect(port).toMatchObject({ mode: "live", adapter: "mcp:k8s-prod+cloudwatch" });
  });

  it("reports a server that fails, times out or answers in an unreadable shape as not checked, and leaves its part out", async () => {
    const broken = serve({ name: "k8s-dead", kind: "kubernetes" }, { pods_list_in_namespace: () => Promise.reject(new Error("connection refused")) });
    const slow = serve({ name: "cw-slow", kind: "cloudwatch", timeoutMs: 500 }, { get_active_alarms: () => new Promise<string>((resolve) => setTimeout(() => resolve(ALARMS), 2_000)) });
    const health = await mcpInfraHealth([broken.client, slow.client]).health("checkout-service", 0);
    expect(health.pods).toBeUndefined();
    expect(health.alarms).toBeUndefined();
    expect(health.checks.map((c) => `${c.source}:${c.kind}:${c.checked}`).sort()).toEqual(["mcp:cw-slow:alarms:false", "mcp:k8s-dead:pods:false"]);
    expect(health.checks.find((c) => c.source === "mcp:k8s-dead")?.detail).toMatch(/k8s-dead unreachable: .*connection refused/);

    const yaml = serve({ name: "k8s-yaml", kind: "kubernetes" }, { pods_list_in_namespace: () => "items: []" });
    const odd = await mcpInfraHealth([yaml.client]).health("checkout-service", 0);
    expect(odd.checks).toEqual([{ source: "mcp:k8s-yaml", kind: "pods", checked: false, detail: "pods returned in a format CrisisCrew can't read" }]);
  });
});
