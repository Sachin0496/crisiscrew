import type { Span, SpanKind, TraceSummary } from "@crisiscrew/contracts";
import { redact, type TraceSink } from "@crisiscrew/core";
import { Client, RunTree } from "langsmith";

/**
 * Sends CrisisCrew's workflow traces to LangSmith, span for span: each
 * workflow run is a root run, each LangGraph node a child, each policy-gate
 * call, guard check and classifier call a grandchild. Every trace of one
 * incident shares a LangSmith thread (metadata thread_id = the incident), so
 * the whole story from the fourth complaint to the last approval reads as
 * one conversation. Refused calls and guard flags carry an error, so
 * LangSmith's error filter finds exactly where a run went wrong.
 *
 * Inputs and outputs are redacted before they leave the process (the tracer
 * already redacts; hideInputs/hideOutputs redact again, in case a span
 * didn't come through the tracer).
 */

export type LangSmithOptions = {
  apiKey: string;
  project: string;
  /** https://api.smith.langchain.com (US) or https://eu.api.smith.langchain.com. */
  endpoint?: string;
  /** The allow-listed fetch; the SDK's own otherwise. */
  fetch?: typeof fetch;
  /** Injected in tests. */
  client?: Client;
  onError?: (error: unknown) => void;
};

const RUN_TYPE: Record<SpanKind, string> = { workflow: "chain", node: "chain", tool: "tool", guard: "tool", classifier: "chain" };

type KV = Record<string, unknown>;

function asKV(value: unknown, key: string): KV {
  if (value === undefined || value === null) return {};
  return typeof value === "object" && !Array.isArray(value) ? (value as KV) : { [key]: value };
}

/** Why a span is marked as an error in LangSmith: failures, refusals and guard flags. Warnings are tags. */
function errorOf(span: Span): string | undefined {
  if (span.status === "error") return span.reason ?? "error";
  if (span.status === "denied") return `Refused by the policy gate: ${span.reason ?? "denied"}`;
  if (span.status === "flagged") return `Flagged by the prompt guard: ${span.reason ?? "flagged"}`;
  return undefined;
}

export class LangSmithExporter implements TraceSink {
  readonly client: Client;
  private readonly runs = new Map<string, RunTree>();
  private readonly project: string;
  private readonly onError: (error: unknown) => void;

  constructor(options: LangSmithOptions) {
    this.project = options.project;
    this.onError = options.onError ?? (() => undefined);
    this.client =
      options.client ??
      new Client({
        apiKey: options.apiKey,
        ...(options.endpoint ? { apiUrl: options.endpoint } : {}),
        ...(options.fetch ? { fetchImplementation: options.fetch } : {}),
        autoBatchTracing: true,
        omitTracedRuntimeInfo: true,
        hideInputs: (inputs) => redact(inputs) as KV,
        hideOutputs: (outputs) => redact(outputs) as KV,
      });
  }

  spanStarted(span: Span, trace: TraceSummary): void {
    const parent = span.parentId ? this.runs.get(span.parentId) : undefined;
    const root = span.parentId === null;
    const config = {
      id: span.id,
      name: root ? trace.title : span.name,
      run_type: RUN_TYPE[span.kind],
      inputs: asKV(span.input, "input"),
      start_time: Date.now(),
      project_name: this.project,
      client: this.client,
      tags: [`kind:${span.kind}`, ...(span.actor ? [`agent:${span.actor}`] : []), ...(root ? [`workflow:${trace.workflow}`] : [])],
      metadata: {
        session_id: trace.sessionId,
        thread_id: trace.incidentId ?? `session:${trace.sessionId}`,
        workflow: trace.workflow,
        ...(trace.incidentId ? { incident_id: trace.incidentId } : {}),
        ...(trace.ticketId ? { ticket_id: trace.ticketId } : {}),
        ...(trace.approvalId ? { approval_id: trace.approvalId } : {}),
        ...(span.kind === "node" ? { langgraph_node: span.name } : {}),
        ...span.meta,
      },
    };
    const run = parent ? parent.createChild(config) : new RunTree(config);
    this.runs.set(span.id, run);
    run.postRun().catch(this.onError);
  }

  spanEnded(span: Span, trace: TraceSummary): void {
    const run = this.runs.get(span.id);
    if (!run) return;
    const error = errorOf(span);
    if (span.status === "warning") run.tags = [...(run.tags ?? []), "warning"];
    const metadata = {
      status: span.status,
      ...(span.reason ? { reason: span.reason } : {}),
      ...(span.parentId === null && trace.incidentId ? { thread_id: trace.incidentId, incident_id: trace.incidentId } : {}),
      ...(span.parentId === null && trace.outcome ? { outcome: trace.outcome } : {}),
      ...span.meta,
    };
    run
      .end(asKV(span.output, "output"), error, Date.now(), metadata)
      .then(() => run.patchRun())
      .catch(this.onError);
    // A span ends after all its children (nodes await their work; follow-up workflows are separate traces).
    this.runs.delete(span.id);
  }

  /** Waits until every queued run has been sent: for the CLI and eval runs, before exiting. */
  async flush(): Promise<void> {
    await this.client.awaitPendingTraceBatches();
  }
}
