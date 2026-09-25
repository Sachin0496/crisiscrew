import { CachedEmbedder } from "@crisiscrew/adapters";
import type { Approval, CrisisState, ImpactGraph, WiringReport } from "@crisiscrew/contracts";
import { describe, expect, it } from "vitest";
import { DEFAULT_EMBEDDING_MODEL, loadConfig, type Config } from "../config";
import { EMBEDDING_CACHE_DIR } from "../paths";
import { Runtime } from "../runtime";
import { loadPolicy, loadScenarios } from "../scenarios";
import { createApp } from "./app";
import type { TicketImpact } from "./impact";

async function setup(env: Record<string, string> = {}) {
  const config: Config = loadConfig({ SANDBOX_LATENCY_MS: "0", ...env });
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

function replayDone(runtime: Runtime): Promise<void> {
  return new Promise((resolve) => {
    const off = runtime.bus.subscribe((e) => {
      if (e.type === "replay.finished") {
        off();
        resolve();
      }
    });
  });
}

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

describe("HTTP API", () => {
  it("reports health and which approvals need a token", async () => {
    const { app } = await setup({ APPROVER_TOKEN: "sign" });
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, auth: { admin: false, approver: true } });
  });

  it("reports wiring: every port, the live adapters it can switch to, and the planned ones", async () => {
    const { app } = await setup();
    const report = (await (await app.request("/api/wiring")).json()) as WiringReport;
    expect(report.ports).toHaveLength(14);
    expect(report.ports.find((p) => p.port === "tickets")?.available).toEqual(["freshdesk"]);
    expect(report.ports.find((p) => p.port === "classifier")?.available).toEqual(["laya"]);
    expect(report.ports.find((p) => p.port === "guard")?.available).toEqual(["lakera"]);
    expect(report.ports.find((p) => p.port === "deployments")?.planned).toEqual(["github"]);
  });

  it("starts a replay and serves its state", async () => {
    const { app, runtime } = await setup();
    const done = replayDone(runtime);
    const res = await app.request("/api/replay", json({ scenario: "two-card-complaints", speed: 500 }));
    expect(res.status).toBe(200);
    await done;
    const state = (await (await app.request("/api/state")).json()) as CrisisState;
    expect(state.session.scenarioId).toBe("two-card-complaints");
    expect(state.ticketOrder).toHaveLength(2);
  });

  it("returns 404 for an unknown scenario and 400 for a bad body", async () => {
    const { app } = await setup();
    expect((await app.request("/api/replay", json({ scenario: "nope" }))).status).toBe(404);
    expect((await app.request("/api/replay", json({ speed: 2 }))).status).toBe(400);
  });

  it("requires the admin token for replays when one is set", async () => {
    const { app } = await setup({ ADMIN_TOKEN: "s3cret" });
    expect((await app.request("/api/replay", json({ scenario: "two-card-complaints" }))).status).toBe(401);
    expect((await app.request("/api/replay", json({ scenario: "two-card-complaints" }, { authorization: "Bearer wrong" }))).status).toBe(401);
    expect((await app.request("/api/replay", json({ scenario: "two-card-complaints" }, { authorization: "Bearer s3cret" }))).status).toBe(200);
  });

  it("takes a human decision once, and refuses a second one, a bad body or an unknown approval", async () => {
    const { app, runtime } = await setup({ APPROVER_TOKEN: "sign" });
    const done = replayDone(runtime);
    await app.request("/api/replay", json({ scenario: "checkout-v4.21.7", speed: 500 }));
    await done;
    const auth = { authorization: "Bearer sign" };
    expect((await app.request("/api/approvals/APR-001", json({ decision: "approve" }))).status).toBe(401);
    expect((await app.request("/api/approvals/APR-001", json({ decision: "modify" }, auth))).status).toBe(400);
    expect((await app.request("/api/approvals/APR-999", json({ decision: "approve" }, auth))).status).toBe(404);
    const ok = await app.request("/api/approvals/APR-001", json({ decision: "approve", note: "go" }, auth));
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as Approval).status).toBe("approved");
    expect((await app.request("/api/approvals/APR-001", json({ decision: "reject" }, auth))).status).toBe(409);
  });

  it("accepts a typed ticket into the current session", async () => {
    const { app } = await setup();
    const res = await app.request("/api/tickets", json({ customerName: "A Judge", body: "My checkout keeps loading forever." }));
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ source: "manual", customerName: "A Judge", customerRef: "walk-in:a-judge", channel: "chat" });
  });

  it("ties a typed ticket to a known customer, so their payments count as evidence", async () => {
    const { app } = await setup();
    const directory = (await (await app.request("/api/customers")).json()) as { ref: string; name: string; email?: string }[];
    expect(directory).toContainEqual({ ref: "c-priya", name: "Priya K.", email: "priya.k@example.com", tier: "standard" });
    const res = await app.request("/api/tickets", json({ customerName: "priya k.", body: "My checkout keeps loading forever." }));
    expect(await res.json()).toMatchObject({ customerRef: "c-priya", customerName: "Priya K." });
  });

  it("serves an incident's impact graph and a ticket's impact after a replay", async () => {
    const { app, runtime } = await setup();
    const done = replayDone(runtime);
    await app.request("/api/replay", json({ scenario: "checkout-v4.21.7", speed: 500 }));
    await done;
    const graph = (await (await app.request("/api/incidents/INC-2026-001/graph")).json()) as ImpactGraph;
    expect(graph.nodes.filter((n) => n.kind === "customer")).toHaveLength(23);
    expect(graph.edges).toContainEqual(expect.objectContaining({ from: "customer:c-priya", to: "ticket:T-1004", kind: "reported" }));
    expect((await app.request("/api/incidents/INC-404/graph")).status).toBe(404);

    const impact = (await (await app.request("/api/tickets/T-1004/impact")).json()) as TicketImpact;
    expect(impact).toMatchObject({
      tracked: true,
      incident: { id: "INC-2026-001", status: "awaiting_approval", coverage: { confirmed: 23, recovered: 21 } },
      customer: { ref: "c-priya", confidence: "confirmed", complained: true, state: "recovered" },
    });
    expect(impact.tracked && impact.consoleUrl).toMatch(/\/#\/customers\/c-priya$/);
    expect(await (await app.request("/api/tickets/T-9999/impact")).json()).toMatchObject({ tracked: false });
  });

  it("serves the audit log with its verification, and the permission matrix", async () => {
    const { app } = await setup();
    const audit = await (await app.request("/api/audit")).json();
    expect(audit).toMatchObject({ verify: { ok: true } });
    const policy = (await (await app.request("/api/policy")).json()) as { identities: { identity: string; tools: { name: string; allowed: boolean }[] }[]; tools: { name: string; levels: number[] }[] };
    expect(policy.identities.find((i) => i.identity === "pattern")?.tools.filter((t) => t.allowed)).toHaveLength(2);
    expect(policy.tools.find((t) => t.name === "issue_recovery_credit")?.levels).toEqual([2, 3]);
  });

  it("streams events over SSE, starting after the given sequence number", async () => {
    const { app } = await setup();
    const res = await app.request("/api/stream?since=0");
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    await reader.cancel();
    const text = new TextDecoder().decode(value);
    expect(text).toContain("session.started");
    expect(text).toMatch(/^id: 1$/m);
  });

  it("lists scenarios", async () => {
    const { app } = await setup();
    const list = (await (await app.request("/api/scenarios")).json()) as { id: string }[];
    expect(list.map((s) => s.id)).toContain("checkout-v4.21.7");
  });
});
