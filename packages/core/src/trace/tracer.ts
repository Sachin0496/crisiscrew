import {
  isProblem,
  type Span,
  type SpanActor,
  type SpanKind,
  type SpanMeta,
  type SpanStatus,
  type TraceSummary,
  type WorkflowName,
} from "@crisiscrew/contracts";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { compact, redact } from "./redact";

/** Receives spans as they start and end. The Traces page's store and the LangSmith exporter are sinks. */
export interface TraceSink {
  spanStarted?(span: Span, trace: TraceSummary): void;
  spanEnded?(span: Span, trace: TraceSummary): void;
  /** The trace's summary changed: it started, ended, or found its first problem. */
  traceChanged?(trace: TraceSummary): void;
}

export type TraceHead = {
  workflow: WorkflowName;
  title: string;
  incidentId?: string;
  ticketId?: string;
  approvalId?: string;
  input?: unknown;
  actor?: SpanActor;
};

export type SpanSpec = { name: string; kind: SpanKind; actor?: SpanActor; input?: unknown; meta?: SpanMeta };

/** How a span ended. A span whose function throws ends with status "error". */
export type SpanEnd = { status?: SpanStatus; reason?: string; output?: unknown; meta?: SpanMeta };

type LiveTrace = { summary: TraceSummary; spans: Span[] };
type Frame = { trace: LiveTrace; span: Span };

export type TracerOptions = {
  sessionId: string;
  now: () => number;
  sinks?: TraceSink[];
  /** Applied to every input and output before it is stored or sent. Defaults to redact(). */
  scrub?: (value: unknown) => unknown;
};

const RANK: Record<SpanStatus, number> = { error: 0, denied: 1, flagged: 2, warning: 3, running: 9, ok: 9 };

/**
 * Records agent workflows as traces of nested spans. The current span
 * follows async context (AsyncLocalStorage), so a policy-gate call made
 * deep inside an agent lands under the graph node that made it, with no
 * plumbing through the agents.
 */
export class Tracer {
  private readonly als = new AsyncLocalStorage<Frame>();
  private readonly sinks: TraceSink[];
  private readonly scrub: (value: unknown) => unknown;

  constructor(private readonly options: TracerOptions) {
    this.sinks = options.sinks ?? [];
    this.scrub = options.scrub ?? redact;
  }

  addSink(sink: TraceSink): void {
    this.sinks.push(sink);
  }

  /** The trace and span the caller is running in, if any. */
  current(): { traceId: string; spanId: string } | undefined {
    const frame = this.als.getStore();
    return frame ? { traceId: frame.trace.summary.id, spanId: frame.span.id } : undefined;
  }

  /**
   * Runs `fn` as a new trace: one workflow run. A trace started from inside
   * another (the ticket that opens an incident) is linked to it, not nested,
   * because it outlives it.
   */
  async trace<T>(head: TraceHead, fn: () => Promise<T>, end?: (result: T) => SpanEnd & { outcome?: string; incidentId?: string }): Promise<T> {
    const parent = this.als.getStore();
    const id = randomUUID();
    const startedAt = this.options.now();
    const summary: TraceSummary = {
      id,
      sessionId: this.options.sessionId,
      workflow: head.workflow,
      title: head.title,
      ...(head.incidentId ? { incidentId: head.incidentId } : {}),
      ...(head.ticketId ? { ticketId: head.ticketId } : {}),
      ...(head.approvalId ? { approvalId: head.approvalId } : {}),
      ...(parent ? { parentTraceId: parent.trace.summary.id } : {}),
      startedAt,
      status: "running",
      spanCount: 0,
      toolCalls: 0,
      denied: 0,
      flagged: 0,
      warnings: 0,
      errors: 0,
    };
    const live: LiveTrace = { summary, spans: [] };
    const root = this.open(live, null, { name: head.workflow, kind: "workflow", actor: head.actor ?? "system", input: head.input });
    this.notifyTrace(live);
    return this.als.run({ trace: live, span: root }, async () => {
      try {
        const result = await fn();
        const ending = end?.(result) ?? {};
        if (ending.outcome) live.summary.outcome = ending.outcome;
        if (ending.incidentId) live.summary.incidentId = ending.incidentId;
        this.close(live, root, ending);
        return result;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        live.summary.outcome = `Failed: ${reason}`;
        this.close(live, root, { status: "error", reason });
        // A failure outside any node still counts, and is where to look.
        if (live.summary.errors === 0) {
          live.summary.errors = 1;
          live.summary.firstProblem = { spanId: root.id, name: root.name, status: "error", reason };
        }
        throw error;
      } finally {
        live.summary.endedAt = this.options.now();
        live.summary.status = traceStatus(live.summary, true);
        this.notifyTrace(live);
      }
    });
  }

  /** Runs `fn` as a child of the current span. Outside any trace it runs untraced. */
  async span<T>(spec: SpanSpec, fn: () => Promise<T>, end?: (result: T) => SpanEnd): Promise<T> {
    const frame = this.als.getStore();
    if (!frame) return fn();
    const span = this.open(frame.trace, frame.span, spec);
    return this.als.run({ trace: frame.trace, span }, async () => {
      try {
        const result = await fn();
        this.close(frame.trace, span, end?.(result) ?? {});
        return result;
      } catch (error) {
        this.close(frame.trace, span, { status: "error", reason: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    });
  }

  /** Records a finished span in one step, for a check that has already happened (a guard verdict, a fallback). */
  record(spec: SpanSpec & SpanEnd): void {
    const frame = this.als.getStore();
    if (!frame) return;
    const span = this.open(frame.trace, frame.span, spec);
    this.close(frame.trace, span, spec);
  }

  private open(trace: LiveTrace, parent: Span | null, spec: SpanSpec): Span {
    const span: Span = {
      id: randomUUID(),
      traceId: trace.summary.id,
      parentId: parent?.id ?? null,
      name: spec.name,
      kind: spec.kind,
      ...(spec.actor ? { actor: spec.actor } : {}),
      startedAt: this.options.now(),
      status: "running",
      ...(spec.input !== undefined ? { input: this.clean(spec.input) } : {}),
      ...(spec.meta ? { meta: spec.meta } : {}),
    };
    trace.spans.push(span);
    trace.summary.spanCount += 1;
    if (span.kind === "tool") trace.summary.toolCalls += 1;
    for (const sink of this.sinks) sink.spanStarted?.(span, trace.summary);
    return span;
  }

  private close(trace: LiveTrace, span: Span, end: SpanEnd): void {
    span.endedAt = this.options.now();
    span.status = end.status ?? "ok";
    if (end.reason) span.reason = end.reason;
    if (end.output !== undefined) span.output = this.clean(end.output);
    if (end.meta) span.meta = { ...span.meta, ...end.meta };
    const s = trace.summary;
    let changed = false;
    // A workflow span fails because one of its nodes did; that node is the one counted.
    if (isProblem(span.status) && span.kind !== "workflow") {
      if (span.status === "denied") s.denied += 1;
      if (span.status === "flagged") s.flagged += 1;
      if (span.status === "warning") s.warnings += 1;
      if (span.status === "error") s.errors += 1;
      const current = s.firstProblem ? trace.spans.find((x) => x.id === s.firstProblem!.spanId) : undefined;
      // The most serious problem wins; among equals, the one that started first.
      if (!current || RANK[span.status] < RANK[current.status] || (RANK[span.status] === RANK[current.status] && span.startedAt < current.startedAt)) {
        s.firstProblem = { spanId: span.id, name: span.name, status: span.status, reason: span.reason ?? span.status, ...(span.actor ? { actor: span.actor } : {}) };
        changed = true;
      }
      const status = traceStatus(s, false);
      if (status !== s.status) {
        s.status = status;
        changed = true;
      }
    }
    for (const sink of this.sinks) sink.spanEnded?.(span, s);
    if (changed) this.notifyTrace(trace);
  }

  private notifyTrace(trace: LiveTrace): void {
    const snapshot = { ...trace.summary, ...(trace.summary.firstProblem ? { firstProblem: { ...trace.summary.firstProblem } } : {}) };
    for (const sink of this.sinks) sink.traceChanged?.(snapshot);
  }

  private clean(value: unknown): unknown {
    return compact(this.scrub(value));
  }
}

function traceStatus(s: TraceSummary, ended: boolean): TraceSummary["status"] {
  if (s.errors > 0) return "error";
  if (s.denied > 0 || s.flagged > 0 || s.warnings > 0) return "attention";
  return ended ? "ok" : "running";
}
