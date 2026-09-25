import {
  WORKFLOW_LABELS,
  type AgentId,
  type Approval,
  type ClusterView,
  type GuardVerdict,
  type Ticket,
  type WorkflowGraph,
  type WorkflowName,
} from "@crisiscrew/contracts";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { briefEngineering, fileEngineering, linkLateTicket, openIncident, settle } from "../agents/commander";
import { carryOutDecision, requestApprovals } from "../agents/handoff";
import { investigate, type InvestigationSummary } from "../agents/investigator";
import type { AgentKit } from "../agents/kit";
import {
  actWithinAuthority,
  assessImpact,
  impactCounts,
  noteOutcomes,
  planPass,
  reassess,
  startRecovery,
  writeBack,
  type ImpactCounts,
  type PlanOutcome,
} from "../agents/recovery";
import { ticketText, type PatternEngine, type PatternResult } from "../correlation/pattern";
import { screenText } from "../guard/injection";
import type { ClassifierVerdict, PromptGuard, TicketClassifier } from "../ports";
import { Tracer } from "../trace/tracer";
import { nested, traced, type NodeInfo } from "./node";

/**
 * CrisisCrew's agent workflows as LangGraph graphs. Each is compiled once per
 * session and invoked per event: a ticket, an incident, a late complaint, a
 * human decision. The recovery pass is a subgraph the others run. Every
 * invocation is one trace; every node, tool call, guard check and
 * classifier call inside it is a span (see src/trace).
 *
 * The graphs decide the order; the agents' steps (src/agents) do the work,
 * and every action still goes through the policy gate.
 */

export type WorkflowDeps = {
  kit: AgentKit;
  pattern: PatternEngine;
  guard: PromptGuard;
  /** Laya or another decision model; null keeps the built-in embedding classifier. */
  classifier: TicketClassifier | null;
  nextIncidentId(): string;
  /** Registers an incident as being opened, so tickets that join it wait until it exists. */
  opening(incidentId: string): void;
  markOpened(incidentId: string): void;
  whenOpened(incidentId: string): Promise<void>;
  track(promise: Promise<unknown>): void;
  fail(agent: AgentId, error: unknown): void;
};

export const NODES: Record<Exclude<WorkflowName, "mcp_call">, Record<string, NodeInfo>> = {
  ticket: {
    screen: {
      label: "Screen for injection",
      actor: "system",
      description: "The prompt guard reads the ticket as untrusted data and flags instruction-like text. The ticket is processed either way, and a flag never grants authority.",
    },
    classify: {
      label: "Classify",
      actor: "pattern",
      description:
        "Embeds the ticket and labels it a failure report, question or request, with its product area. With Laya switched on, Laya answers and the built-in classifier is the fallback.",
    },
    correlate: {
      label: "Correlate",
      actor: "pattern",
      description: "Groups the ticket with the last 15 minutes of tickets by meaning and product area, then checks the four incident gates.",
    },
    open_incident: { label: "Alert the Commander", actor: "pattern", description: "Every gate passed: a new incident starts, and the incident workflow takes over." },
    join_incident: { label: "Join open incident", actor: "pattern", description: "The ticket matches an open incident: it's linked there and the customer's recovery is updated." },
    no_incident: { label: "No incident", actor: "pattern", description: "At least one gate refused. The reason is recorded." },
  },
  incident: {
    open_incident: { label: "Open incident", actor: "commander", description: "Opens the incident for the failure reports that passed every gate." },
    investigate: { label: "Investigate", actor: "investigator", description: "Checks the gateway, recent releases and error rates, and ranks causes by prior × likelihood ratios." },
    assess_impact: { label: "Find who was harmed", actor: "recovery", description: "Links the tickets and builds the Customer Impact Graph from payment attempts in the incident window." },
    file_engineering: { label: "File for engineering", actor: "commander", description: "Files the incident where engineering works: Freshservice, or its sandbox." },
    brief_engineering: { label: "Brief engineering", actor: "commander", description: "Adds the investigation to the engineering incident and moves the incident to recovery." },
    recover: { label: "Recovery pass", actor: "commander", description: "Runs the recovery pass: plan, act within authority, write back, ask a human for the rest, settle." },
  },
  recovery_pass: {
    reassess_impact: { label: "Reassess impact", actor: "recovery", description: "Rebuilds the impact graph from the latest evidence." },
    plan_recovery: { label: "Plan recovery", actor: "recovery", description: "Drafts the update once, then plans the actions each customer is still missing, each with its reason and authority level." },
    act_within_authority: { label: "Act within authority", actor: "recovery", description: "Carries out every planned action up to L2: updates through consented channels, notes, credits within limits." },
    write_back: { label: "Write back", actor: "recovery", description: "Leaves each settled customer's outcome on their ticket." },
    request_approvals: { label: "Ask a human", actor: "handoff", description: "Builds one approval per customer for any credit above the agents' authority." },
    settle: { label: "Settle", actor: "commander", description: "Sets the incident's status from Recovery Coverage: recovered only at 100%." },
  },
  late_ticket: {
    link_ticket: { label: "Link ticket", actor: "recovery", description: "Links a later complaint to the open incident." },
    recover: { label: "Recovery pass", actor: "recovery", description: "Recovery is under way, so a full pass updates this customer's plan." },
    reassess_impact: { label: "Reassess impact", actor: "recovery", description: "Before the root cause is known, only the impact graph is updated." },
  },
  decision: {
    carry_out_decision: { label: "Carry out decision", actor: "handoff", description: "Pays exactly the approved amount to exactly that customer, or records the rejection." },
    write_back: { label: "Write back", actor: "handoff", description: "Leaves the customer's outcome on their ticket." },
    settle: { label: "Settle", actor: "commander", description: "Recomputes Recovery Coverage and the incident's status." },
  },
};

const DESCRIPTIONS: Record<Exclude<WorkflowName, "mcp_call">, string> = {
  ticket: "Runs for every ticket: screen it, classify it, correlate it, and either open an incident, join one, or record why not.",
  incident: "Runs once per incident: open it, then investigate, find who was harmed and file for engineering in parallel, then recover.",
  recovery_pass: "One idempotent pass over an incident's customers. It runs after the root cause, after each later complaint and after each human decision.",
  late_ticket: "Runs for a complaint that matches an open incident.",
  decision: "Runs when a human approves, changes or rejects one customer's credit.",
};

type Labels = { ticketType?: string; surface: string; isFailure: boolean; source?: string; confidence?: number; fallback?: string };
type Settled = Awaited<ReturnType<typeof settle>>;

const TicketState = Annotation.Root({
  ticket: Annotation<Ticket>(),
  guardVerdict: Annotation<GuardVerdict | null>(),
  labels: Annotation<Labels | null>(),
  result: Annotation<PatternResult | null>(),
  incidentId: Annotation<string | null>(),
});

const IncidentState = Annotation.Root({
  incidentId: Annotation<string>(),
  cluster: Annotation<ClusterView>(),
  opened: Annotation<boolean>(),
  reason: Annotation<string | null>(),
  investigation: Annotation<InvestigationSummary | null>(),
  impact: Annotation<ImpactCounts | null>(),
  engineering: Annotation<string | null>(),
  briefed: Annotation<boolean>(),
  recovery: Annotation<Settled | null>(),
});

const RecoveryState = Annotation.Root({
  incidentId: Annotation<string>(),
  impact: Annotation<ImpactCounts | null>(),
  plan: Annotation<PlanOutcome | null>(),
  acted: Annotation<{ attempted: number; done: number; failed: number } | null>(),
  written: Annotation<{ notes: number; recovered: number; confirmed: number; waiting: number } | null>(),
  approvals: Annotation<string[]>(),
  settled: Annotation<Settled | null>(),
});

const LateState = Annotation.Root({
  incidentId: Annotation<string>(),
  ticketId: Annotation<string>(),
  linked: Annotation<boolean>(),
  impact: Annotation<ImpactCounts | null>(),
  recovery: Annotation<Settled | null>(),
});

const DecisionState = Annotation.Root({
  approval: Annotation<Approval>(),
  outcome: Annotation<string | null>(),
  notes: Annotation<number>(),
  settled: Annotation<Settled | null>(),
});

type TicketS = typeof TicketState.State;
type IncidentS = typeof IncidentState.State;
type RecoveryS = typeof RecoveryState.State;
type LateS = typeof LateState.State;
type DecisionS = typeof DecisionState.State;

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} didn't answer within ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Compiles every workflow for one session. The nodes close over `d`; nothing runs until a workflow is invoked. */
function compile(d: WorkflowDeps) {
  const kit = d.kit;
  const t = kit.tracer;
  const n = NODES;

  // --- Recovery pass (a subgraph) -------------------------------------------------
  const recovery = new StateGraph(RecoveryState)
    .addNode("reassess_impact", traced(t, "reassess_impact", n.recovery_pass.reassess_impact!, async (s: RecoveryS) => ({ impact: await reassess(kit, s.incidentId) })))
    .addNode("plan_recovery", traced(t, "plan_recovery", n.recovery_pass.plan_recovery!, async (s: RecoveryS) => ({ plan: await planPass(kit, s.incidentId) })))
    .addNode("act_within_authority", traced(t, "act_within_authority", n.recovery_pass.act_within_authority!, async (s: RecoveryS) => ({ acted: await actWithinAuthority(kit, s.incidentId) })))
    .addNode("write_back", traced(t, "write_back", n.recovery_pass.write_back!, async (s: RecoveryS) => ({ written: await writeBack(kit, s.incidentId) })))
    .addNode("request_approvals", traced(t, "request_approvals", n.recovery_pass.request_approvals!, async (s: RecoveryS) => ({ approvals: (await requestApprovals(kit, s.incidentId)).requested })))
    .addNode("settle", traced(t, "settle", n.recovery_pass.settle!, async (s: RecoveryS) => ({ settled: await settle(kit, s.incidentId) })))
    .addEdge(START, "reassess_impact")
    .addEdge("reassess_impact", "plan_recovery")
    // A plan that couldn't be made skips straight to approvals and settling, as before.
    .addConditionalEdges("plan_recovery", (s: RecoveryS) => (s.plan?.ok ? "act_within_authority" : "request_approvals"), ["act_within_authority", "request_approvals"])
    .addEdge("act_within_authority", "write_back")
    .addEdge("write_back", "request_approvals")
    .addEdge("request_approvals", "settle")
    .addEdge("settle", END)
    .compile({ name: "recovery_pass" });

  /** One recovery pass for an incident, one at a time per incident, as a nested span of the caller's node. */
  const recoveryPass = (incidentId: string): Promise<Settled | null> =>
    kit.serial(incidentId, () =>
      nested(t, "recovery_pass", { incidentId }, async () => (await recovery.invoke({ incidentId })).settled ?? null, (r) => (r ? `${r.status}: ${r.recovered}/${r.confirmed} recovered` : "not settled")),
    );

  // --- Incident response --------------------------------------------------------
  const incident = new StateGraph(IncidentState)
    .addNode(
      "open_incident",
      traced(
        t,
        "open_incident",
        n.incident.open_incident!,
        async (s: IncidentS) => {
          try {
            const r = await openIncident(kit, s.cluster, s.incidentId);
            return r.opened ? { opened: true, reason: null } : { opened: false, reason: r.reason };
          } finally {
            d.markOpened(s.incidentId);
          }
        },
        (s) => ({ incidentId: s.incidentId, tickets: s.cluster.reportTicketIds, surface: s.cluster.dominantSurface }),
      ),
    )
    .addNode("investigate", traced(t, "investigate", n.incident.investigate!, async (s: IncidentS) => ({ investigation: await investigate(kit, s.incidentId) })))
    .addNode("assess_impact", traced(t, "assess_impact", n.incident.assess_impact!, async (s: IncidentS) => ({ impact: await startRecovery(kit, s.incidentId) })))
    .addNode("file_engineering", traced(t, "file_engineering", n.incident.file_engineering!, async (s: IncidentS) => ({ engineering: (await fileEngineering(kit, s.incidentId)).record })))
    .addNode("brief_engineering", traced(t, "brief_engineering", n.incident.brief_engineering!, async (s: IncidentS) => ({ briefed: (await briefEngineering(kit, s.incidentId)).briefed })))
    .addNode("recover", traced(t, "recover", n.incident.recover!, async (s: IncidentS) => ({ recovery: await recoveryPass(s.incidentId) })))
    .addEdge(START, "open_incident")
    .addConditionalEdges("open_incident", (s: IncidentS) => (s.opened ? ["investigate", "assess_impact", "file_engineering"] : END), ["investigate", "assess_impact", "file_engineering", END])
    .addEdge(["investigate", "assess_impact", "file_engineering"], "brief_engineering")
    .addEdge("brief_engineering", "recover")
    .addEdge("recover", END)
    .compile({ name: "incident" });

  // --- Late complaint -----------------------------------------------------------
  const late = new StateGraph(LateState)
    .addNode("link_ticket", traced(t, "link_ticket", n.late_ticket.link_ticket!, async (s: LateS) => ({ linked: (await linkLateTicket(kit, s.incidentId, s.ticketId)).linked })))
    .addNode("recover", traced(t, "recover", n.late_ticket.recover!, async (s: LateS) => ({ recovery: await recoveryPass(s.incidentId) })))
    .addNode(
      "reassess_impact",
      traced(t, "reassess_impact", n.late_ticket.reassess_impact!, async (s: LateS) => {
        const impact = await kit.serial(s.incidentId, () => assessImpact(kit, s.incidentId));
        kit.setAgent("recovery", "idle", `Linked ${s.ticketId}; waiting for the root cause`);
        return { impact: impactCounts(impact) };
      }),
    )
    .addEdge(START, "link_ticket")
    // Once an update is drafted, recovery is under way: the customer gets a full pass.
    .addConditionalEdges("link_ticket", (s: LateS) => (kit.draftFor(s.incidentId) ? "recover" : "reassess_impact"), ["recover", "reassess_impact"])
    .addEdge("recover", END)
    .addEdge("reassess_impact", END)
    .compile({ name: "late_ticket" });

  // --- Human decision -----------------------------------------------------------
  const decision = new StateGraph(DecisionState)
    .addNode(
      "carry_out_decision",
      traced(
        t,
        "carry_out_decision",
        n.decision.carry_out_decision!,
        async (s: DecisionS) => ({ outcome: (await carryOutDecision(kit, s.approval)).outcome }),
        (s) => ({ approval: s.approval.id, customer: s.approval.customerName, decision: s.approval.status, amountInr: s.approval.approvedAmountInr ?? s.approval.amountInr }),
      ),
    )
    .addNode("write_back", traced(t, "write_back", n.decision.write_back!, async (s: DecisionS) => ({ notes: await noteOutcomes(kit, s.approval.incidentId, "handoff") })))
    .addNode("settle", traced(t, "settle", n.decision.settle!, async (s: DecisionS) => ({ settled: await settle(kit, s.approval.incidentId) })))
    .addEdge(START, "carry_out_decision")
    .addEdge("carry_out_decision", "write_back")
    .addEdge("write_back", "settle")
    .addEdge("settle", END)
    .compile({ name: "decision" });

  // --- Ticket intake ------------------------------------------------------------
  const screenTicket = async (ticket: Ticket): Promise<GuardVerdict> => {
    const text = ticketText(ticket);
    const checked = await t.span(
      { name: "prompt_guard", kind: "guard", actor: "system", input: { source: "ticket", text }, meta: { guard: d.guard.adapter } },
      async () => {
        try {
          return { verdict: await d.guard.screen(text) };
        } catch (error) {
          // A guard that can't answer never waves text through: the built-in rules screen it instead.
          return { verdict: screenText(text), fallback: message(error) };
        }
      },
      ({ verdict, fallback }) => ({
        status: verdict.flagged ? "flagged" : fallback ? "warning" : "ok",
        ...(verdict.flagged ? { reason: `instruction-like text in the ticket: ${verdict.reasons.join(", ")}` } : fallback ? { reason: `${d.guard.adapter} unavailable, built-in rules used: ${fallback}` } : {}),
        output: verdict,
      }),
    );
    if (checked.verdict.flagged) {
      kit.emit({ type: "guard.flagged", payload: { flag: { at: kit.now(), source: "ticket", ref: ticket.id, verdict: checked.verdict, excerpt: text.slice(0, 160) } } });
    }
    return checked.verdict;
  };

  const askClassifier = (classifier: TicketClassifier, text: string) =>
    t.span(
      { name: classifier.adapter, kind: "classifier", actor: "pattern", input: { text }, meta: { adapter: classifier.adapter, mode: classifier.mode } },
      async (): Promise<{ verdict?: ClassifierVerdict; fallback?: string }> => {
        try {
          return { verdict: await withTimeout(classifier.classify(text), kit.policy.classifier.timeoutMs, classifier.adapter) };
        } catch (error) {
          return { fallback: message(error) };
        }
      },
      (a) =>
        a.verdict
          ? { output: a.verdict, meta: { model: a.verdict.model ?? null, latencyMs: a.verdict.latencyMs } }
          : { status: "warning", reason: `fell back to the built-in classifier: ${a.fallback}` },
    );

  const ticket = new StateGraph(TicketState)
    .addNode(
      "screen",
      traced(t, "screen", n.ticket.screen!, async (s: TicketS) => ({ guardVerdict: await screenTicket(s.ticket) }), (s) => ({ ticketId: s.ticket.id, customer: s.ticket.customerName })),
    )
    .addNode(
      "classify",
      traced(
        t,
        "classify",
        n.ticket.classify!,
        async (s: TicketS) => {
          const text = ticketText(s.ticket);
          const [, answer] = await Promise.all([d.pattern.read(s.ticket), d.classifier ? askClassifier(d.classifier, text) : Promise.resolve(null)]);
          if (s.guardVerdict) d.pattern.noteGuard(s.ticket.id, { flagged: s.guardVerdict.flagged, reasons: s.guardVerdict.reasons });
          if (answer?.verdict) d.pattern.applyVerdict(s.ticket.id, answer.verdict, kit.policy.classifier);
          else if (answer?.fallback && d.classifier) d.pattern.noteFallback(s.ticket.id, d.classifier.adapter, answer.fallback);
          const signal = d.pattern.signalOf(s.ticket.id)!;
          const labels: Labels = {
            ...(signal.ticketType ? { ticketType: signal.ticketType } : {}),
            surface: signal.surface,
            isFailure: signal.isFailure,
            ...(signal.classifier?.source ? { source: signal.classifier.source } : {}),
            ...(signal.classifier?.confidence !== undefined ? { confidence: signal.classifier.confidence } : {}),
            ...(signal.classifier?.fallback ? { fallback: signal.classifier.fallback } : {}),
          };
          return { labels };
        },
        (s) => ({ ticketId: s.ticket.id }),
      ),
    )
    .addNode(
      "correlate",
      traced(
        t,
        "correlate",
        n.ticket.correlate!,
        async (s: TicketS) => {
          const result = d.pattern.correlate(s.ticket.id);
          kit.emit({ type: "signal.scored", payload: { signal: result.signal, nearest: result.nearest } });
          return { result };
        },
        (s) => ({ ticketId: s.ticket.id, labels: s.labels }),
      ),
    )
    .addNode(
      "open_incident",
      traced(t, "open_incident", n.ticket.open_incident!, async (s: TicketS) => {
        const incidentId = d.nextIncidentId();
        const cluster = { ...s.result!.candidate!, incidentId };
        kit.emit({ type: "cluster.updated", payload: { cluster } });
        d.pattern.attachIncident(incidentId, cluster.reportTicketIds);
        d.opening(incidentId);
        kit.setAgent("pattern", "done", `${cluster.reportTicketIds.length} failure reports describe one problem; alerted the Incident Commander`);
        d.track(
          runIncident(cluster, incidentId).catch((error) => {
            d.markOpened(incidentId);
            d.fail("commander", error);
          }),
        );
        return { incidentId };
      }),
    )
    .addNode(
      "join_incident",
      traced(t, "join_incident", n.ticket.join_incident!, async (s: TicketS) => {
        const incidentId = s.result!.joinIncidentId!;
        if (s.result!.candidate) kit.emit({ type: "cluster.updated", payload: { cluster: s.result!.candidate } });
        kit.setAgent("pattern", "done", `${s.ticket.id} matches ${incidentId}`);
        d.track(
          (async () => {
            await d.whenOpened(incidentId);
            await runLateTicket(incidentId, s.ticket.id);
          })().catch((error) => d.fail("recovery", error)),
        );
        return { incidentId };
      }),
    )
    .addNode(
      "no_incident",
      traced(t, "no_incident", n.ticket.no_incident!, async (s: TicketS) => {
        if (s.result!.candidate) kit.emit({ type: "cluster.updated", payload: { cluster: s.result!.candidate } });
        kit.setAgent("pattern", "idle", `${s.ticket.id}: no incident`);
        return {};
      }),
    )
    .addEdge(START, "screen")
    .addEdge("screen", "classify")
    .addEdge("classify", "correlate")
    .addConditionalEdges(
      "correlate",
      (s: TicketS) => (s.result?.fires && s.result.candidate ? "open_incident" : s.result?.joinIncidentId ? "join_incident" : "no_incident"),
      ["open_incident", "join_incident", "no_incident"],
    )
    .addEdge("open_incident", END)
    .addEdge("join_incident", END)
    .addEdge("no_incident", END)
    .compile({ name: "ticket" });

  // --- Runners: one trace per invocation ----------------------------------------
  function runIncident(cluster: ClusterView, incidentId: string) {
    return t.trace(
      {
        workflow: "incident",
        title: `Incident ${incidentId}`,
        incidentId,
        actor: "commander",
        input: { incidentId, tickets: cluster.reportTicketIds, surface: cluster.dominantSurface, cohesion: cluster.cohesion },
      },
      () => incident.invoke({ incidentId, cluster }),
      (s) => ({
        outcome: !s.opened
          ? `Not opened: ${s.reason}`
          : `${s.investigation?.rootCause ? `Cause: ${s.investigation.rootCause.label}. ` : ""}${s.impact ? `${s.impact.confirmed} harmed (${s.impact.silent} silent). ` : ""}${s.recovery ? `${s.recovery.recovered}/${s.recovery.confirmed} recovered${s.recovery.pending ? `, ${s.recovery.pending} waiting for a human` : ""}` : ""}`.trim(),
        output: { opened: s.opened, rootCause: s.investigation?.rootCause ?? null, impact: s.impact, recovery: s.recovery },
      }),
    );
  }

  function runLateTicket(incidentId: string, ticketId: string) {
    return t.trace(
      { workflow: "late_ticket", title: `Late complaint ${ticketId}`, incidentId, ticketId, actor: "recovery", input: { incidentId, ticketId } },
      () => late.invoke({ incidentId, ticketId }),
      (s) => ({
        outcome: `${s.linked ? "Linked" : "Not linked"} to ${incidentId}${s.recovery ? `; ${s.recovery.recovered}/${s.recovery.confirmed} recovered` : s.impact ? `; ${s.impact.confirmed} harmed so far` : ""}`,
        output: { linked: s.linked, impact: s.impact, recovery: s.recovery },
      }),
    );
  }

  return {
    runTicket(t0: Ticket) {
      return t.trace(
        {
          workflow: "ticket",
          title: `Ticket ${t0.id}`,
          ticketId: t0.id,
          actor: "pattern",
          input: { ticketId: t0.id, customer: t0.customerName, channel: t0.channel, text: ticketText(t0) },
        },
        () => ticket.invoke({ ticket: t0 }),
        (s) => {
          const r = s.result;
          const refused = r?.candidate?.gates.filter((g) => !g.pass).map((g) => g.reason) ?? [];
          const incidentId = s.incidentId ?? undefined;
          return {
            outcome: r?.fires ? `Opened ${incidentId}` : r?.joinIncidentId ? `Joined ${incidentId}` : `No incident${refused[0] ? `: ${refused[0]}` : ""}`,
            output: { labels: s.labels, decision: r?.fires ? "open" : r?.joinIncidentId ? "join" : "none", incidentId: incidentId ?? null, refused },
            ...(incidentId ? { incidentId } : {}),
          };
        },
      );
    },
    runDecision(approval: Approval) {
      return kit.serial(approval.incidentId, () =>
        t.trace(
          {
            workflow: "decision",
            title: `Decision ${approval.id} · ${approval.customerName}`,
            incidentId: approval.incidentId,
            approvalId: approval.id,
            actor: "handoff",
            input: { approval: approval.id, customer: approval.customerName, decision: approval.status, amountInr: approval.approvedAmountInr ?? approval.amountInr, by: approval.decidedBy ?? null },
          },
          () => decision.invoke({ approval }),
          (s) => ({
            outcome: `${approval.customerName}'s credit ${s.outcome ?? "handled"}${s.settled ? `; ${s.settled.recovered}/${s.settled.confirmed} recovered` : ""}`,
            output: { outcome: s.outcome, settled: s.settled },
          }),
        ),
      );
    },
    graphs: { ticket, incident, recovery_pass: recovery, late_ticket: late, decision },
  };
}

export type Workflows = ReturnType<typeof compile>;

export function createWorkflows(deps: WorkflowDeps): Workflows {
  return compile(deps);
}

/** The structure of every workflow, read from the compiled LangGraph graphs, for GET /api/workflows and the Traces page. */
export function describeWorkflows(): WorkflowGraph[] {
  const tracer = new Tracer({ sessionId: "catalog", now: () => 0 });
  const stub = { kit: { tracer } } as unknown as WorkflowDeps;
  const { graphs } = compile(stub);
  return (Object.keys(NODES) as (keyof typeof NODES)[]).map((name) => {
    const drawable = graphs[name].getGraph();
    const nodes = Object.values(drawable.nodes).map((node) => {
      const id = node.id;
      if (id === START) return { id, label: "Start", actor: "system" as const, description: "", kind: "start" as const };
      if (id === END) return { id, label: "End", actor: "system" as const, description: "", kind: "end" as const };
      const info = NODES[name][id];
      return { id, label: info?.label ?? id, actor: info?.actor ?? ("system" as const), description: info?.description ?? "", kind: "node" as const };
    });
    const edges = drawable.edges.map((e) => ({ from: e.source, to: e.target, conditional: Boolean(e.conditional) }));
    return { name, title: WORKFLOW_LABELS[name], description: DESCRIPTIONS[name], nodes, edges };
  });
}
