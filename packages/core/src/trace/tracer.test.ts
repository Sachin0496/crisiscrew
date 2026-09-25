import type { Span, TraceSummary } from "@crisiscrew/contracts";
import { describe, expect, it } from "vitest";
import { compact, redact, redactText } from "./redact";
import { Tracer, type TraceSink } from "./tracer";

function recorder() {
  const spans: Span[] = [];
  const traces = new Map<string, TraceSummary>();
  const sink: TraceSink = { spanStarted: (s) => spans.push(s), traceChanged: (t) => traces.set(t.id, t) };
  return { spans, traces, sink };
}

function tracer(sink: TraceSink) {
  let now = 1_000;
  return new Tracer({ sessionId: "S1", now: () => (now += 5), sinks: [sink] });
}

describe("Tracer", () => {
  it("nests spans by async context: node under workflow, tool under node, across awaits", async () => {
    const { spans, sink } = recorder();
    const t = tracer(sink);
    await t.trace({ workflow: "incident", title: "Incident INC-1" }, async () => {
      await t.span({ name: "investigate", kind: "node", actor: "investigator" }, async () => {
        await new Promise((r) => setTimeout(r, 1));
        await Promise.all([
          t.span({ name: "get_payment_health", kind: "tool", actor: "investigator" }, async () => "ok"),
          t.span({ name: "get_recent_deployments", kind: "tool", actor: "investigator" }, async () => "ok"),
        ]);
      });
    });
    const [root, node, ...tools] = spans;
    expect(root).toMatchObject({ kind: "workflow", parentId: null, status: "ok" });
    expect(node).toMatchObject({ name: "investigate", parentId: root!.id, status: "ok" });
    expect(tools.map((s) => s.parentId)).toEqual([node!.id, node!.id]);
    expect(new Set(spans.map((s) => s.traceId)).size).toBe(1);
  });

  it("links a trace started inside another instead of nesting it", async () => {
    const { traces, sink } = recorder();
    const t = tracer(sink);
    let child: Promise<unknown> = Promise.resolve();
    await t.trace({ workflow: "ticket", title: "Ticket T-1" }, async () => {
      child = t.trace({ workflow: "incident", title: "Incident INC-1" }, async () => "opened");
    });
    await child;
    const [ticket, incident] = [...traces.values()];
    expect(incident!.parentTraceId).toBe(ticket!.id);
    expect(ticket!.parentTraceId).toBeUndefined();
  });

  it("points at the most serious problem first, and marks the trace for attention or error", async () => {
    const { traces, sink } = recorder();
    const t = tracer(sink);
    await t.trace({ workflow: "recovery_pass", title: "Pass" }, async () => {
      t.record({ name: "laya", kind: "classifier", status: "warning", reason: "timed out" });
      await t.span({ name: "issue_recovery_credit", kind: "tool", actor: "pattern" }, async () => ({ ok: false }), () => ({ status: "denied", reason: "not allowed" }));
    });
    const summary = [...traces.values()][0]!;
    expect(summary).toMatchObject({ status: "attention", denied: 1, warnings: 1, errors: 0 });
    expect(summary.firstProblem).toMatchObject({ name: "issue_recovery_credit", status: "denied", reason: "not allowed", actor: "pattern" });
  });

  it("records a thrown error on the span that threw and on the trace, then rethrows", async () => {
    const { spans, traces, sink } = recorder();
    const t = tracer(sink);
    await expect(
      t.trace({ workflow: "incident", title: "Incident" }, () => t.span({ name: "settle", kind: "node" }, async () => Promise.reject(new Error("coverage exploded")))),
    ).rejects.toThrow("coverage exploded");
    expect(spans.find((s) => s.name === "settle")).toMatchObject({ status: "error", reason: "coverage exploded" });
    expect([...traces.values()][0]).toMatchObject({ status: "error", errors: 1, outcome: "Failed: coverage exploded", firstProblem: { name: "settle" } });
  });

  it("runs untraced outside any trace, so a bare call costs nothing", async () => {
    const { spans, sink } = recorder();
    const t = tracer(sink);
    expect(await t.span({ name: "get_incident", kind: "tool" }, async () => 42)).toBe(42);
    expect(spans).toHaveLength(0);
  });

  it("redacts inputs and outputs before any sink sees them", async () => {
    const { spans, sink } = recorder();
    const t = tracer(sink);
    await t.trace({ workflow: "ticket", title: "T", input: { email: "priya.k@example.com", apiKey: "abc", text: "call me on 9876543210" } }, async () => undefined);
    expect(spans[0]!.input).toEqual({ email: "p***@example.com", apiKey: "[redacted]", text: "call me on [phone]" });
  });
});

describe("redaction", () => {
  it("masks secrets, contact details, cards and IDs but keeps names, refs and hypothesis ids", () => {
    expect(redactText("Bearer abcdef0123456789xyz")).toBe("Bearer [redacted]");
    expect(redactText("key lsv2_pt_0123456789abcdef0123")).toBe("key [redacted key]");
    expect(redactText("upi priya@okaxis failed")).toBe("upi p***@okaxis failed");
    expect(redactText("card 4111 1111 1111 1111 declined")).toBe("card [card ••1111] declined");
    expect(redactText("+91 98765 43210")).toBe("[phone]");
    expect(redactText("PAN ABCDE1234F")).toBe("PAN [PAN]");
    expect(redactText("Ananya Iyer s03 deploy:checkout-service@4.21.7")).toBe("Ananya Iyer s03 deploy:checkout-service@4.21.7");
    expect(redact({ nested: [{ authorization: "x", note: "ok" }] })).toEqual({ nested: [{ authorization: "[redacted]", note: "ok" }] });
  });

  it("keeps payloads small: long strings clipped, long arrays cut with a count", () => {
    const out = compact({ text: "x".repeat(1000), list: Array.from({ length: 40 }, (_, i) => i), vec: new Float32Array(384) }) as Record<string, unknown>;
    expect((out.text as string).length).toBe(600);
    expect(out.list as unknown[]).toHaveLength(26);
    expect((out.list as unknown[]).at(-1)).toBe("… 15 more");
    expect(out.vec).toBe("[384 numbers]");
  });
});
