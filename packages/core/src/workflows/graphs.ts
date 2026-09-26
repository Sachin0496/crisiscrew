import { WORKFLOW_LABELS, type SpanActor, type WorkflowGraph, type WorkflowName } from "@crisiscrew/contracts";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import type { SpanEnd, TraceHead, Tracer } from "../trace/tracer";
import { traced, type NodeInfo } from "./node";

/** Runs an agent operation in a compiled LangGraph node and records its nested work. */
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

type Stage = { id: string; label: string; actor: SpanActor; description: string };
type Link = [from: string, to: string, conditional?: boolean];

/** The observable agent stages inside each compiled workflow wrapper. IDs match trace span names. */
function runtimeGraph(name: Exclude<WorkflowName, "mcp_call">, description: string, stages: Stage[], links: Link[]): WorkflowGraph {
  return {
    name,
    title: WORKFLOW_LABELS[name],
    description,
    nodes: [
      { id: START, label: "Start", actor: "system", description: "", kind: "start" },
      ...stages.map((stage) => ({ ...stage, kind: "node" as const })),
      { id: END, label: "End", actor: "system", description: "", kind: "end" },
    ],
    edges: links.map(([from, to, conditional = false]) => ({ from, to, conditional })),
  };
}

/** Runtime stages shown in Traces. The compiled graph wraps these operations in one entry node. */
export function describeWorkflows(): WorkflowGraph[] {
  return [
    runtimeGraph("ticket", "Screen, classify and correlate a ticket before deciding whether to open or join an incident.", [
      { id: "prompt_guard", label: "Screen text", actor: "system", description: "Check the incoming ticket for untrusted instructions." },
      { id: "classify_ticket", label: "Classify ticket", actor: "pattern", description: "Embed the ticket and classify its product area and failure signal." },
      { id: "correlate_reports", label: "Correlate reports", actor: "pattern", description: "Find similar reports and evaluate the incident gates or an open incident match." },
    ], [
      [START, "prompt_guard"], ["prompt_guard", "classify_ticket"], ["classify_ticket", "correlate_reports"], ["correlate_reports", END],
    ]),
    runtimeGraph("incident", "Open the incident, investigate and assess customer impact in parallel, then file for engineering and begin recovery.", [
      { id: "open_incident", label: "Open incident", actor: "commander", description: "Create the incident and set its initial importance." },
      { id: "investigate", label: "Investigate cause", actor: "investigator", description: "Check provider health, releases, error rates and infrastructure." },
      { id: "assess_impact", label: "Find affected", actor: "recovery", description: "Link reports and identify affected customers from payment evidence." },
      { id: "file_engineering", label: "File engineering", actor: "issue_creator", description: "Create the engineering incident with current findings." },
      { id: "recover", label: "Run recovery", actor: "commander", description: "Start the customer recovery pass." },
    ], [
      [START, "open_incident"], ["open_incident", "investigate"], ["open_incident", "assess_impact"],
      ["investigate", "file_engineering"], ["assess_impact", "file_engineering"], ["file_engineering", "recover"], ["recover", END],
    ]),
    runtimeGraph("late_ticket", "Link a later complaint, then update impact or run another recovery pass.", [
      { id: "link_ticket_to_incident", label: "Link complaint", actor: "recovery", description: "Link the new ticket to the existing incident." },
      { id: "update_impact", label: "Reassess impact", actor: "recovery", description: "Refresh affected customers before recovery has started." },
      { id: "start_recovery_pass", label: "Run recovery", actor: "recovery", description: "Update recovery after the new complaint arrives." },
    ], [
      [START, "link_ticket_to_incident"], ["link_ticket_to_incident", "update_impact", true],
      ["link_ticket_to_incident", "start_recovery_pass", true], ["update_impact", END], ["start_recovery_pass", END],
    ]),
    runtimeGraph("recovery_pass", "Reassess impact, plan each customer's recovery, act within authority, hand off outreach and approvals, then settle coverage.", [
      { id: "identify_affected_customers", label: "Find affected", actor: "recovery", description: "Rebuild the impact graph from payment attempts and tickets." },
      { id: "draft_customer_update", label: "Draft update", actor: "recovery", description: "Prepare the incident update and acknowledgement." },
      { id: "plan_recovery", label: "Plan recovery", actor: "recovery", description: "Choose each customer's actions and authority level." },
      { id: "act_within_authority", label: "Credits + notes", actor: "recovery", description: "Carry out approved actions within the agent's authority." },
      { id: "reach_out", label: "Contact customers", actor: "handoff", description: "Reply to complainants and proactively contact customers who stayed silent." },
      { id: "request_approvals", label: "Ask a human", actor: "handoff", description: "Request decisions for credits above agent authority." },
      { id: "write_back", label: "Write outcomes", actor: "handoff", description: "Record settled outcomes on customer tickets." },
      { id: "settle", label: "Settle coverage", actor: "commander", description: "Recompute recovery coverage and incident status." },
    ], [
      [START, "identify_affected_customers"], ["identify_affected_customers", "draft_customer_update"],
      ["draft_customer_update", "plan_recovery"], ["plan_recovery", "act_within_authority", true],
      ["act_within_authority", "reach_out"], ["plan_recovery", "reach_out", true],
      ["reach_out", "request_approvals"], ["request_approvals", "write_back"], ["write_back", "settle"], ["settle", END],
    ]),
    runtimeGraph("decision", "Carry out a human credit decision, write back and settle customer coverage.", [
      { id: "carry_out_decision", label: "Apply decision", actor: "handoff", description: "Issue, change or decline the exact approved customer credit." },
      { id: "write_back", label: "Write outcome", actor: "handoff", description: "Record the resulting action on the customer's ticket." },
      { id: "settle", label: "Settle coverage", actor: "commander", description: "Update recovery coverage and the incident status." },
    ], [
      [START, "carry_out_decision"], ["carry_out_decision", "write_back"], ["write_back", "settle"], ["settle", END],
    ]),
  ];
}
