import { WORKFLOW_LABELS, type SpanActor, type WorkflowGraph, type WorkflowName } from "@crisiscrew/contracts";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import type { SpanEnd, TraceHead, Tracer } from "../trace/tracer";
import { traced, type NodeInfo } from "./node";

/** Runs an existing agent operation in a compiled LangGraph node and records its nested tool calls. */
export async function runWorkflow<T>(
  tracer: Tracer,
  head: TraceHead,
  node: string,
  info: NodeInfo,
  run: () => Promise<T>,
  end?: (result: T) => SpanEnd & { outcome?: string; incidentId?: string },
): Promise<T> {
  const State = Annotation.Root({ result: Annotation<T>() });
  const graph = new StateGraph(State)
    .addNode(node, traced(tracer, node, info, async () => ({ result: await run() })))
    .addEdge(START, node)
    .addEdge(node, END)
    .compile({ name: head.workflow });
  return tracer.trace(head, async () => (await graph.invoke({})).result!, end);
}

const definitions: { name: Exclude<WorkflowName, "mcp_call">; node: string; actor: SpanActor; description: string }[] = [
  { name: "ticket", node: "classify_and_correlate", actor: "pattern", description: "Screens, classifies and correlates a ticket, then opens or joins an incident when the gates pass." },
  { name: "incident", node: "respond", actor: "commander", description: "Investigates, assesses impact, files for engineering and begins recovery." },
  { name: "recovery_pass", node: "recover", actor: "recovery", description: "Plans and carries out recovery, outreach and approvals for confirmed customers." },
  { name: "late_ticket", node: "link_and_recover", actor: "recovery", description: "Links a later complaint and updates the customer's recovery." },
  { name: "decision", node: "settle_decision", actor: "handoff", description: "Carries out a human credit decision and updates coverage." },
];

/** The graph catalog shown on the Traces page. */
export function describeWorkflows(): WorkflowGraph[] {
  return definitions.map(({ name, node, actor, description }) => ({
    name,
    title: WORKFLOW_LABELS[name],
    description,
    nodes: [
      { id: START, label: "Start", actor: "system", description: "", kind: "start" },
      { id: node, label: node.replaceAll("_", " "), actor, description, kind: "node" },
      { id: END, label: "End", actor: "system", description: "", kind: "end" },
    ],
    edges: [
      { from: START, to: node, conditional: false },
      { from: node, to: END, conditional: false },
    ],
  }));
}
