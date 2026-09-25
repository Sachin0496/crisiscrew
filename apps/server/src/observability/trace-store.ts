import type { Span, TraceDetail, TraceSummary } from "@crisiscrew/contracts";
import type { TraceSink } from "@crisiscrew/core";

type Entry = { summary: TraceSummary; spans: Span[] };

/**
 * The recent workflow traces with every span, in the order the spans
 * started, for the Traces page (GET /api/traces/:id). Kept in memory and
 * capped: the oldest traces go first, and a runaway trace keeps its first
 * spans. The event stream only carries summaries; the spans are fetched here.
 */
export class TraceStore implements TraceSink {
  private readonly traces = new Map<string, Entry>();

  constructor(
    private readonly cap = 400,
    private readonly spanCap = 2_000,
  ) {}

  spanStarted(span: Span, trace: TraceSummary): void {
    const entry = this.entry(trace);
    // The tracer updates the same span object when it ends, so the stored one stays current.
    if (entry.spans.length < this.spanCap) entry.spans.push(span);
  }

  spanEnded(_span: Span, trace: TraceSummary): void {
    this.entry(trace);
  }

  traceChanged(trace: TraceSummary): void {
    this.entry(trace);
  }

  list(sessionId?: string): TraceSummary[] {
    return [...this.traces.values()].map((e) => e.summary).filter((t) => !sessionId || t.sessionId === sessionId);
  }

  get(id: string): TraceDetail | null {
    const entry = this.traces.get(id);
    return entry ? { trace: entry.summary, spans: entry.spans } : null;
  }

  private entry(trace: TraceSummary): Entry {
    let entry = this.traces.get(trace.id);
    if (!entry) {
      entry = { summary: { ...trace }, spans: [] };
      this.traces.set(trace.id, entry);
      while (this.traces.size > this.cap) this.traces.delete(this.traces.keys().next().value!);
    } else {
      entry.summary = { ...trace, ...(trace.firstProblem ? { firstProblem: { ...trace.firstProblem } } : {}) };
    }
    return entry;
  }
}
