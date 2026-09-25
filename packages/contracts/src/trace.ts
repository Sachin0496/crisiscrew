import type { AgentId } from "./domain";

/**
 * Agent workflow traces. Every workflow run (a LangGraph graph invocation) is
 * one trace; its nodes, policy-gate tool calls, guard checks and classifier
 * calls are spans inside it. The UI's Traces page and LangSmith show the
 * same spans, so a refused call or an error can be found in one click.
 */

/** The workflows CrisisCrew runs as LangGraph graphs, plus calls from external MCP clients. */
export type WorkflowName = "ticket" | "incident" | "late_ticket" | "recovery_pass" | "decision" | "mcp_call";

export const WORKFLOW_LABELS: Record<WorkflowName, string> = {
  ticket: "Ticket intake",
  incident: "Incident response",
  late_ticket: "Late complaint",
  recovery_pass: "Recovery pass",
  decision: "Human decision",
  mcp_call: "MCP call",
};

/** workflow: a graph run (or a nested one); node: one graph node; tool: one policy-gate call; guard and classifier: a check on untrusted text. */
export type SpanKind = "workflow" | "node" | "tool" | "guard" | "classifier";

/**
 * warning: it worked, but not as configured (e.g. the classifier fell back).
 * flagged: a guard found instruction-like text in untrusted input.
 * denied: the policy gate refused the call.
 */
export type SpanStatus = "running" | "ok" | "warning" | "flagged" | "denied" | "error";

/** Who performed a span: an agent, an external MCP client, or the engine itself. */
export type SpanActor = AgentId | "operator" | "system";

export type SpanMeta = Record<string, string | number | boolean | null>;

export type Span = {
  id: string;
  traceId: string;
  parentId: string | null;
  name: string;
  kind: SpanKind;
  actor?: SpanActor;
  startedAt: number;
  endedAt?: number;
  status: SpanStatus;
  /** Why the span isn't ok: the refusal, the error, the flag or the fallback. */
  reason?: string;
  input?: unknown;
  output?: unknown;
  meta?: SpanMeta;
};

export type TraceStatus = "running" | "ok" | "attention" | "error";

export type TraceProblem = { spanId: string; name: string; status: SpanStatus; reason: string; actor?: SpanActor };

export type TraceSummary = {
  id: string;
  sessionId: string;
  workflow: WorkflowName;
  title: string;
  incidentId?: string;
  ticketId?: string;
  approvalId?: string;
  /** The trace that started this one, e.g. the ticket trace that opened the incident. */
  parentTraceId?: string;
  startedAt: number;
  endedAt?: number;
  /** running, then ok; attention when something was refused, flagged or fell back; error when something failed. */
  status: TraceStatus;
  spanCount: number;
  toolCalls: number;
  denied: number;
  flagged: number;
  warnings: number;
  errors: number;
  /** One line on what the run achieved, e.g. "Opened INC-2026-001". */
  outcome?: string;
  /** The earliest span that wasn't ok: where to look first. */
  firstProblem?: TraceProblem;
};

export type TraceDetail = { trace: TraceSummary; spans: Span[] };

/** A workflow's LangGraph structure, read from the compiled graph, for drawing it. */
export type WorkflowGraph = {
  name: WorkflowName;
  title: string;
  description: string;
  nodes: { id: string; label: string; actor: SpanActor; description: string; kind: "start" | "end" | "node" }[];
  edges: { from: string; to: string; conditional: boolean }[];
};

/** Problem statuses, most serious first. */
export const PROBLEM_STATUSES: readonly SpanStatus[] = ["error", "denied", "flagged", "warning"];

export function isProblem(status: SpanStatus): boolean {
  return PROBLEM_STATUSES.includes(status);
}
