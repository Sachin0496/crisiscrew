import { Tracer } from "@crisiscrew/core";
import type { Client } from "langsmith";
import { describe, expect, it } from "vitest";
import { allowListedFetch, EgressError, hostAllowed } from "../egress";
import { LangSmithExporter } from "./langsmith";

type Posted = { id: string; name: string; run_type: string; parent_run_id?: string; trace_id?: string; inputs?: unknown; tags?: string[]; extra?: { metadata?: Record<string, unknown> } };
type Patched = { id: string; error?: string; outputs?: unknown; extra?: { metadata?: Record<string, unknown> } };

/** A fake LangSmith client: RunTree only calls createRun and updateRun. */
function fakeClient() {
  const created: Posted[] = [];
  const updated: Patched[] = [];
  const client = {
    createRun: async (run: Posted) => void created.push(run),
    updateRun: async (id: string, run: Omit<Patched, "id">) => void updated.push({ id, ...run }),
    awaitPendingTraceBatches: async () => undefined,
  } as unknown as Client;
  return { client, created, updated };
}

const settle = () => new Promise((r) => setTimeout(r, 10));

describe("LangSmith exporter", () => {
  it("sends each workflow as a run tree: the trace, its LangGraph nodes, and the tool calls under them", async () => {
    const { client, created, updated } = fakeClient();
    const exporter = new LangSmithExporter({ apiKey: "k", project: "crisiscrew", client });
    const tracer = new Tracer({ sessionId: "S2", now: () => Date.now(), sinks: [exporter] });
    await tracer.trace({ workflow: "incident", title: "Incident INC-2026-001", incidentId: "INC-2026-001", actor: "commander" }, () =>
      tracer.span({ name: "investigate", kind: "node", actor: "investigator" }, () =>
        tracer.span({ name: "get_payment_health", kind: "tool", actor: "investigator", input: { email: "priya.k@example.com" } }, async () => "ok"),
      ),
    );
    await settle();
    const [root, node, tool] = created;
    expect(root).toMatchObject({ name: "Incident INC-2026-001", run_type: "chain" });
    expect(root!.extra?.metadata).toMatchObject({ thread_id: "INC-2026-001", workflow: "incident", session_id: "S2" });
    expect(node).toMatchObject({ name: "investigate", parent_run_id: root!.id, trace_id: root!.id });
    expect(node!.extra?.metadata).toMatchObject({ langgraph_node: "investigate" });
    expect(tool).toMatchObject({ name: "get_payment_health", run_type: "tool", parent_run_id: node!.id, trace_id: root!.id });
    expect(tool!.tags).toEqual(expect.arrayContaining(["kind:tool", "agent:investigator"]));
    expect(JSON.stringify(tool!.inputs)).not.toContain("priya.k@example.com");
    expect(updated.map((u) => u.id).sort()).toEqual([root!.id, node!.id, tool!.id].sort());
  });

  it("marks a refused call as an error, so LangSmith's error filter finds where the run went wrong", async () => {
    const { client, updated } = fakeClient();
    const exporter = new LangSmithExporter({ apiKey: "k", project: "p", client });
    const tracer = new Tracer({ sessionId: "S1", now: () => Date.now(), sinks: [exporter] });
    await tracer.trace({ workflow: "mcp_call", title: "MCP call" }, () =>
      tracer.span({ name: "issue_recovery_credit", kind: "tool", actor: "pattern" }, async () => null, () => ({ status: "denied", reason: "Pattern Agent is not allowed to call issue_recovery_credit" })),
    );
    await settle();
    expect(updated.find((u) => u.error)?.error).toBe("Refused by the policy gate: Pattern Agent is not allowed to call issue_recovery_credit");
  });
});

describe("egress allow-list", () => {
  const allowed = ["api.smith.langchain.com", "api.laya.studio", "localhost:8000"];

  it("allows listed hosts, their subdomains and a listed loopback port", () => {
    expect(hostAllowed(new URL("https://api.smith.langchain.com/runs"), allowed)).toBe(true);
    expect(hostAllowed(new URL("https://eu.api.laya.studio/v1/systemone"), allowed)).toBe(true);
    expect(hostAllowed(new URL("http://localhost:8000/v1/systemone"), allowed)).toBe(true);
  });

  it("refuses other hosts, other loopback ports and private or metadata addresses", () => {
    expect(hostAllowed(new URL("https://evil.example/steal"), allowed)).toBe(false);
    expect(hostAllowed(new URL("http://localhost:6379/"), allowed)).toBe(false);
    expect(hostAllowed(new URL("http://169.254.169.254/latest/meta-data"), allowed)).toBe(false);
    expect(hostAllowed(new URL("https://api.laya.studio.evil.example/"), allowed)).toBe(false);
  });

  it("stops the request before it's sent, and refuses plain HTTP off loopback", async () => {
    let sent = 0;
    const guarded = allowListedFetch([...allowed, "plain.example"], (async () => {
      sent += 1;
      return new Response("{}");
    }) as unknown as typeof fetch);
    await expect(guarded("https://evil.example/x")).rejects.toBeInstanceOf(EgressError);
    await expect(guarded("http://plain.example/x")).rejects.toThrow(/use https/);
    await guarded("http://localhost:8000/v1/systemone");
    expect(sent).toBe(1);
  });

  it("checks each redirect before sending and strips credentials across origins", async () => {
    const seen: { url: string; authorization: string | null; redirect: Request["redirect"] }[] = [];
    const guarded = allowListedFetch(["api.laya.studio", "api.smith.langchain.com"], (async (request: Request, init?: RequestInit) => {
      seen.push({ url: request.url, authorization: request.headers.get("authorization"), redirect: init?.redirect ?? request.redirect });
      if (request.url.endsWith("/start")) return new Response(null, { status: 302, headers: { location: "https://api.smith.langchain.com/next" } });
      if (request.url.endsWith("/next")) return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } });
      return new Response("ok");
    }) as typeof fetch);

    await expect(guarded("https://api.laya.studio/start", { headers: { authorization: "Bearer secret" } })).rejects.toBeInstanceOf(EgressError);
    expect(seen).toEqual([
      { url: "https://api.laya.studio/start", authorization: "Bearer secret", redirect: "manual" },
      { url: "https://api.smith.langchain.com/next", authorization: null, redirect: "manual" },
    ]);
  });

  it("follows a safe relative redirect and honors manual mode", async () => {
    const seen: string[] = [];
    const guarded = allowListedFetch(allowed, (async (request: Request) => {
      seen.push(request.url);
      return request.url.endsWith("/start")
        ? new Response(null, { status: 307, headers: { location: "/done" } })
        : new Response("ok");
    }) as typeof fetch);
    expect((await guarded("https://api.laya.studio/start")).status).toBe(200);
    expect(seen).toEqual(["https://api.laya.studio/start", "https://api.laya.studio/done"]);
    expect((await guarded("https://api.laya.studio/start", { redirect: "manual" })).status).toBe(307);
    expect(seen).toHaveLength(3);
  });
});
