import type { Span, SpanActor, SpanStatus, TraceDetail, TraceSummary, WorkflowGraph } from "@crisiscrew/contracts";
import type { Tone } from "./format";

/** How each span status reads, most serious first. */
export const SPAN_STATUS: Record<SpanStatus, { label: string; tone: Tone }> = {
  error: { label: "Error", tone: "danger" },
  denied: { label: "Refused", tone: "danger" },
  flagged: { label: "Flagged", tone: "warning" },
  warning: { label: "Fell back", tone: "warning" },
  running: { label: "Running", tone: "accent" },
  ok: { label: "OK", tone: "neutral" },
};

export const TRACE_STATUS: Record<TraceSummary["status"], { label: string; tone: Tone }> = {
  running: { label: "Running", tone: "accent" },
  ok: { label: "OK", tone: "success" },
  attention: { label: "Needs attention", tone: "warning" },
  error: { label: "Error", tone: "danger" },
};

export const ACTOR_LABELS: Record<SpanActor, string> = {
  pattern: "Pattern Agent",
  commander: "Commander",
  investigator: "Investigator",
  recovery: "Recovery Agent",
  handoff: "Handoff Agent",
  issue_creator: "Issue Creator",
  operator: "MCP client",
  system: "Engine",
};

const RANK: Record<SpanStatus, number> = { ok: 0, running: 1, warning: 2, flagged: 3, denied: 4, error: 5 };

/** The more serious of two statuses. */
export function worse(a: SpanStatus | null, b: SpanStatus | null): SpanStatus | null {
  if (a === null) return b;
  if (b === null) return a;
  return RANK[b] > RANK[a] ? b : a;
}

export const isProblemStatus = (s: SpanStatus | null) => s === "error" || s === "denied" || s === "flagged" || s === "warning";

export type SpanRow = {
  span: Span;
  depth: number;
  childCount: number;
  /** The most serious status in the span and everything under it. */
  worst: SpanStatus;
  /** The ids of every ancestor, so a collapsed row can hide its subtree. */
  ancestors: string[];
};

/** Spans as a tree in the order they started: depth, child counts, and the worst status under each. */
export function spanRows(spans: Span[]): SpanRow[] {
  const ids = new Set(spans.map((s) => s.id));
  const children = new Map<string | null, Span[]>();
  for (const s of spans) {
    const parent = s.parentId && ids.has(s.parentId) ? s.parentId : null;
    children.set(parent, [...(children.get(parent) ?? []), s]);
  }
  const worstOf = new Map<string, SpanStatus>();
  const settle = (s: Span): SpanStatus => {
    let w: SpanStatus = s.status;
    for (const c of children.get(s.id) ?? []) w = worse(w, settle(c))!;
    worstOf.set(s.id, w);
    return w;
  };
  for (const root of children.get(null) ?? []) settle(root);
  const rows: SpanRow[] = [];
  const walk = (s: Span, depth: number, ancestors: string[]) => {
    const kids = children.get(s.id) ?? [];
    rows.push({ span: s, depth, childCount: kids.length, worst: worstOf.get(s.id) ?? s.status, ancestors });
    for (const c of kids) walk(c, depth + 1, [...ancestors, s.id]);
  };
  for (const root of children.get(null) ?? []) walk(root, 0, []);
  return rows;
}

/** Where a span sits on the trace's timeline, as fractions of the whole, for the waterfall bars. */
export function timing(span: Span, start: number, end: number): { left: number; width: number } {
  const total = Math.max(1, end - start);
  const from = Math.min(Math.max(span.startedAt - start, 0), total);
  const to = Math.min(Math.max((span.endedAt ?? end) - start, from), total);
  return { left: from / total, width: Math.max((to - from) / total, 0.004) };
}

export function duration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return "–";
  if (ms < 1) return "<1 ms";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export type NodeState = { ran: boolean; runs: number; worst: SpanStatus | null; active?: boolean; spanId?: string };

/**
 * Which observable stages ran inside a workflow and whether their work had
 * a problem. The compiled graph has one wrapper node, so the map follows
 * its nested agent, tool and guard spans instead.
 */
export function nodeStates(detail: TraceDetail | null, graph: WorkflowGraph): Record<string, NodeState> {
  const states: Record<string, NodeState> = Object.fromEntries(graph.nodes.map((n) => [n.id, { ran: false, runs: 0, worst: null }]));
  if (!detail) return states;
  const rows = spanRows(detail.spans);
  const containers = detail.spans.filter((s) => s.kind === "workflow" && s.name === graph.name);
  const containerIds = new Set(containers.map((s) => s.id));
  for (const node of graph.nodes.filter((n) => n.kind === "node")) {
    const matching = rows.filter((row) => row.span.name === node.id && row.ancestors.some((id) => containerIds.has(id)));
    // A named stage can wrap a tool with the same name. Show the stage once.
    const preferred = matching.some((row) => row.span.kind === "node") ? matching.filter((row) => row.span.kind === "node") : matching;
    const st = states[node.id]!;
    for (const row of preferred) {
      st.ran = true;
      st.runs += 1;
      if (row.span.status === "running") st.active = true;
      st.worst = worse(st.worst, row.worst);
      if (!st.spanId || isProblemStatus(row.worst)) st.spanId = row.span.id;
    }
  }
  if (containers.length > 0) {
    states.__start__ = { ran: true, runs: 1, worst: "ok" };
    states.__end__ = { ran: containers.every((s) => Boolean(s.endedAt)), runs: 1, worst: "ok" };
  }
  return states;
}

/** Prefer a run still in progress; otherwise show the latest run that reached this workflow. */
export function latestWorkflowActivity(details: TraceDetail[], graph: WorkflowGraph): { detail: TraceDetail; states: Record<string, NodeState> } | null {
  const candidates = details.map((detail) => ({ detail, states: nodeStates(detail, graph) })).filter(({ states }) => Object.values(states).some((state) => state.ran));
  candidates.sort((a, b) => Number(Boolean(a.detail.trace.endedAt)) - Number(Boolean(b.detail.trace.endedAt)) || b.detail.trace.startedAt - a.detail.trace.startedAt);
  return candidates[0] ?? null;
}

export type Placement = { col: number; row: number; colSize: number };

/**
 * Layered layout for a small LangGraph DAG: a node's column is its longest
 * path from Start, and nodes in one column stack in the order the graph
 * lists them, centred.
 */
export function layout(graph: WorkflowGraph): { at: Record<string, Placement>; cols: number; maxRows: number } {
  const col: Record<string, number> = { __start__: 0 };
  // Longest path by relaxation: the graphs are small DAGs, so node-count rounds are plenty.
  for (let i = 0; i < graph.nodes.length; i++) {
    for (const e of graph.edges) {
      const c = (col[e.from] ?? -1) + 1;
      if (col[e.from] !== undefined && c > (col[e.to] ?? -1)) col[e.to] = c;
    }
  }
  for (const n of graph.nodes) col[n.id] ??= 0;
  const byCol = new Map<number, string[]>();
  for (const n of graph.nodes) byCol.set(col[n.id]!, [...(byCol.get(col[n.id]!) ?? []), n.id]);
  const at: Record<string, Placement> = {};
  for (const [c, ids] of byCol) ids.forEach((id, row) => (at[id] = { col: c, row, colSize: ids.length }));
  return { at, cols: Math.max(...Object.values(col)) + 1, maxRows: Math.max(...[...byCol.values()].map((ids) => ids.length)) };
}

/** Which trace to open first: the latest that needs attention, else the latest incident, else the latest of any. */
export function defaultTrace(traces: TraceSummary[]): TraceSummary | undefined {
  const newest = [...traces].reverse();
  return newest.find((t) => t.status === "error" || t.status === "attention") ?? newest.find((t) => t.workflow === "incident") ?? newest[0];
}
