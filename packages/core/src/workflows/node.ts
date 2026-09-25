import type { SpanActor } from "@crisiscrew/contracts";
import type { Tracer } from "../trace/tracer";

/** What each graph node is for, shown on the Traces page and in the workflow diagrams. */
export type NodeInfo = { label: string; actor: SpanActor; description: string };

/**
 * Wraps a LangGraph node so each run of it is a span: what it was given,
 * what it returned, and every tool call made inside it as child spans.
 * `show` picks the part of the state worth recording as the node's input.
 */
export function traced<S, U>(tracer: Tracer, name: string, info: NodeInfo, run: (state: S) => Promise<U>, show?: (state: S) => unknown) {
  return (state: S): Promise<U> =>
    tracer.span(
      { name, kind: "node", actor: info.actor, ...(show ? { input: show(state) } : {}), meta: { langgraph_node: name, label: info.label } },
      () => run(state),
      (output) => ({ output }),
    );
}

/** Runs a compiled graph as a nested workflow span inside the current node, like a LangGraph subgraph. */
export function nested<T>(tracer: Tracer, name: string, input: unknown, run: () => Promise<T>, outcome?: (result: T) => string): Promise<T> {
  return tracer.span({ name, kind: "workflow", actor: "system", input }, run, (result) => ({
    output: outcome ? { outcome: outcome(result) } : undefined,
  }));
}
