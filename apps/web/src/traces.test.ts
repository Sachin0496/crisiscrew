import type { Span, TraceDetail, TraceSummary, WorkflowGraph } from "@crisiscrew/contracts";
import { describe, expect, it } from "vitest";
import { defaultTrace, duration, layout, nodeStates, spanRows, timing } from "./traces";

const span = (id: string, parentId: string | null, over: Partial<Span> = {}): Span => ({
  id,
  traceId: "t",
  parentId,
  name: id,
  kind: "node",
  startedAt: 0,
  endedAt: 10,
  status: "ok",
  ...over,
});

const incidentGraph: WorkflowGraph = {
  name: "incident",
  title: "Incident response",
  description: "",
  nodes: ["__start__", "open_incident", "investigate", "assess_impact", "file_engineering", "brief_engineering", "recover", "__end__"].map((id) => ({
    id,
    label: id,
    actor: "commander",
    description: "",
    kind: id.startsWith("__") ? (id === "__start__" ? "start" : "end") : "node",
  })),
  edges: [
    { from: "__start__", to: "open_incident", conditional: false },
    { from: "open_incident", to: "investigate", conditional: true },
    { from: "open_incident", to: "assess_impact", conditional: true },
    { from: "open_incident", to: "file_engineering", conditional: true },
    { from: "open_incident", to: "__end__", conditional: true },
    { from: "investigate", to: "brief_engineering", conditional: false },
    { from: "assess_impact", to: "brief_engineering", conditional: false },
    { from: "file_engineering", to: "brief_engineering", conditional: false },
    { from: "brief_engineering", to: "recover", conditional: false },
    { from: "recover", to: "__end__", conditional: false },
  ],
};

describe("span tree", () => {
  it("orders spans depth-first in start order and rolls the worst status up to every ancestor", () => {
    const rows = spanRows([
      span("root", null, { kind: "workflow" }),
      span("investigate", "root"),
      span("act", "root"),
      span("get_payment_health", "investigate", { kind: "tool" }),
      span("issue_recovery_credit", "act", { kind: "tool", status: "denied" }),
    ]);
    expect(rows.map((r) => `${"-".repeat(r.depth)}${r.span.id}:${r.worst}`)).toEqual([
      "root:denied",
      "-investigate:ok",
      "--get_payment_health:ok",
      "-act:denied",
      "--issue_recovery_credit:denied",
    ]);
    expect(rows[3]!.ancestors).toEqual(["root"]);
  });

  it("keeps an orphan span visible as a root", () => {
    expect(spanRows([span("a", "missing")]).map((r) => r.depth)).toEqual([0]);
  });
});

describe("graph", () => {
  it("lays the incident workflow out in columns: the three parallel branches share one", () => {
    const { at, cols, maxRows } = layout(incidentGraph);
    expect(cols).toBe(6);
    expect(maxRows).toBe(3);
    expect([at.investigate!.col, at.assess_impact!.col, at.file_engineering!.col]).toEqual([2, 2, 2]);
    expect(at.brief_engineering!.col).toBe(3);
    expect(at.__end__!.col).toBe(5);
  });

  it("marks which nodes ran in a trace and which have a problem under them", () => {
    const detail: TraceDetail = {
      trace: {} as TraceSummary,
      spans: [
        span("root", null, { kind: "workflow", name: "incident" }),
        span("n1", "root", { name: "open_incident" }),
        span("n2", "root", { name: "investigate" }),
        span("g", "n2", { kind: "guard", name: "prompt_guard", status: "flagged" }),
      ],
    };
    const states = nodeStates(detail, incidentGraph);
    expect(states.open_incident).toMatchObject({ ran: true, worst: "ok" });
    expect(states.investigate).toMatchObject({ ran: true, worst: "flagged", spanId: "n2" });
    expect(states.recover).toMatchObject({ ran: false, worst: null });
  });
});

describe("helpers", () => {
  it("places spans on the trace timeline and formats durations", () => {
    expect(timing(span("a", null, { startedAt: 50, endedAt: 100 }), 0, 200)).toEqual({ left: 0.25, width: 0.25 });
    expect(duration(0.4)).toBe("<1 ms");
    expect(duration(350)).toBe("350 ms");
    expect(duration(2_345)).toBe("2.35 s");
  });

  it("opens the latest trace that needs attention first", () => {
    const t = (id: string, status: TraceSummary["status"], workflow: TraceSummary["workflow"] = "ticket") => ({ id, status, workflow }) as TraceSummary;
    expect(defaultTrace([t("a", "attention"), t("b", "ok", "incident"), t("c", "ok")])?.id).toBe("a");
    expect(defaultTrace([t("a", "ok", "incident"), t("b", "ok")])?.id).toBe("a");
  });
});
