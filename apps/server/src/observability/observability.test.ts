import { CachedEmbedder } from "@crisiscrew/adapters";
import type { Span, TraceDetail, TraceSummary, WorkflowGraph } from "@crisiscrew/contracts";
import { describe, expect, it } from "vitest";
import { DEFAULT_EMBEDDING_MODEL, loadConfig } from "../config";
import { createApp } from "../http/app";
import { EMBEDDING_CACHE_DIR } from "../paths";
import { Runtime } from "../runtime";
import { loadPolicy, loadScenarios } from "../scenarios";

async function setup(env: Record<string, string> = {}) {
  const config = loadConfig({ SANDBOX_LATENCY_MS: "0", MCP_TOKEN_PATTERN: "pattern-token", ...env });
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

async function replay(app: Awaited<ReturnType<typeof setup>>["app"], runtime: Runtime, scenario: string) {
  const done = new Promise<void>((resolve) => {
    const off = runtime.bus.subscribe((e) => {
      if (e.type === "replay.finished") {
        off();
        resolve();
      }
    });
  });
  await app.request("/api/replay", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scenario, speed: 500 }) });
  await done;
}

const get = async <T>(app: Awaited<ReturnType<typeof setup>>["app"], path: string) => (await (await app.request(path)).json()) as T;

describe("agent workflow traces", () => {
  it("records every workflow run of a replay: a trace per ticket, one for the incident, one per late complaint", async () => {
    const { app, runtime } = await setup();
    await replay(app, runtime, "checkout-v4.21.7");
    const { traces } = await get<{ traces: TraceSummary[] }>(app, "/api/traces");
    const count = (w: string) => traces.filter((t) => t.workflow === w).length;
    expect(count("ticket")).toBe(13);
    expect(count("incident")).toBe(1);
    expect(count("late_ticket")).toBe(4);
    expect(traces.every((t) => t.status === "ok")).toBe(true);
    const opener = traces.find((t) => t.outcome === "Opened INC-2026-001")!;
    const incident = traces.find((t) => t.workflow === "incident")!;
    // The incident trace links back to the ticket that opened it, and the state carries the same summaries.
    expect(incident).toMatchObject({ parentTraceId: opener.id, incidentId: "INC-2026-001" });
    expect(incident.outcome).toMatch(/^Cause: checkout-service v4\.21\.7\. 23 harmed/);
    expect(runtime.state().traces.map((t) => t.id).sort()).toEqual(traces.map((t) => t.id).sort());
  });

  it("serves the incident and recovery steps with policy-gate calls under the step that made them", async () => {
    const { app, runtime } = await setup();
    await replay(app, runtime, "checkout-v4.21.7");
    const { traces } = await get<{ traces: TraceSummary[] }>(app, "/api/traces");
    const detail = await get<TraceDetail>(app, `/api/traces/${traces.find((t) => t.workflow === "incident")!.id}`);
    const byId = new Map(detail.spans.map((s) => [s.id, s]));
    const parentName = (s: Span) => (s.parentId ? byId.get(s.parentId)?.name : null);
    const nodes = detail.spans.filter((s) => s.kind === "node").map((s) => s.name);
    expect(nodes).toEqual(expect.arrayContaining(["respond", "open_incident", "investigate", "assess_impact", "file_engineering", "recover"]));
    const health = detail.spans.find((s) => s.name === "get_payment_health")!;
    expect(health).toMatchObject({ kind: "tool", actor: "investigator", status: "ok" });
    expect(parentName(health)).toBe("investigate");
    const recovery = traces.find((t) => t.workflow === "recovery_pass")!;
    const recoveryDetail = await get<TraceDetail>(app, `/api/traces/${recovery.id}`);
    const recoveryById = new Map(recoveryDetail.spans.map((s) => [s.id, s]));
    expect(recoveryDetail.spans.filter((s) => s.kind === "node").map((s) => s.name)).toEqual(expect.arrayContaining(["plan_recovery", "reach_out", "request_approvals", "write_back", "settle"]));
    const credit = recoveryDetail.spans.find((s) => s.name === "issue_recovery_credit")!;
    expect(recoveryById.get(credit.parentId!)?.name).toBe("plan_recovery");
    expect(credit.meta).toMatchObject({ decision: "allowed", level: 2 });
    expect(recovery).toMatchObject({ parentTraceId: detail.trace.id });
  });

  it("describes the six workflow graphs used by the current incident flow", async () => {
    const { app } = await setup();
    const workflows = await get<WorkflowGraph[]>(app, "/api/workflows");
    expect(workflows.map((w) => w.name)).toEqual(["ticket", "incident", "recovery_pass", "late_ticket", "decision", "autofix"]);
    const incident = workflows.find((w) => w.name === "incident")!;
    const from = (id: string) => incident.edges.filter((e) => e.from === id).map((e) => `${e.to}${e.conditional ? "?" : ""}`);
    expect(from("__start__")).toEqual(["respond"]);
    expect(from("respond")).toEqual(["__end__"]);
    expect(incident.nodes.find((n) => n.id === "respond")).toMatchObject({ actor: "commander", label: "respond" });
  });

  it("pinpoints a refused MCP call: its own trace, marked for attention, with the refusal as the first problem", async () => {
    const { app } = await setup();
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer pattern-token" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "link_ticket_to_incident", arguments: { ticketId: "T-1001", incidentId: "INC-2026-001" } } }),
    });
    expect(res.status).toBe(200);
    const { traces } = await get<{ traces: TraceSummary[] }>(app, "/api/traces");
    const mcp = traces.find((t) => t.workflow === "mcp_call")!;
    expect(mcp).toMatchObject({ status: "attention", denied: 1, title: "MCP · link_ticket_to_incident" });
    expect(mcp.firstProblem).toMatchObject({ name: "link_ticket_to_incident", status: "denied", actor: "pattern", reason: "Pattern Agent is not allowed to call link_ticket_to_incident" });
  });

  it("answers 404 for a trace it doesn't have", async () => {
    const { app } = await setup();
    expect((await app.request("/api/traces/nope")).status).toBe(404);
  });
});

describe("HTTP guardrails", () => {
  it("rate-limits write routes per client, and says when to retry", async () => {
    const { app } = await setup({ RATE_LIMIT_PER_MINUTE: "2" });
    const post = () =>
      app.request("/api/tickets", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" }, body: JSON.stringify({ body: "My checkout keeps loading forever." }) });
    expect((await post()).status).toBe(201);
    expect((await post()).status).toBe(201);
    const third = await post();
    expect(third.status).toBe(429);
    expect(Number(third.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("rejects unknown fields in request bodies", async () => {
    const { app } = await setup();
    const res = await app.request("/api/tickets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "My checkout keeps loading forever.", priority: "urgent", creditInr: 5000 }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/unrecognized key/i);
  });
});
