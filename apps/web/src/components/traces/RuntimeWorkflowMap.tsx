import { WORKFLOW_LABELS, type TraceDetail, type TraceSummary, type WorkflowGraph, type WorkflowName } from "@crisiscrew/contracts";
import { traceHref } from "../../router";
import { ACTOR_LABELS, isProblemStatus, latestWorkflowActivity, layout, SPAN_STATUS, type NodeState } from "../../traces";
import { WorkflowMap } from "./WorkflowMap";

type Props = {
  graphs: WorkflowGraph[];
  details: TraceDetail[];
  traces: TraceSummary[];
  replayFinished: boolean;
  replaying: boolean;
  onNode: (traceId: string, spanId: string) => void;
};

/** The runtime handoffs around the five compiled LangGraph workflows. */
export function RuntimeWorkflowMap({ graphs, details, traces, replayFinished, replaying, onNode }: Props) {
  const graph = (name: WorkflowName) => graphs.find((item) => item.name === name);
  const activity = new Map(graphs.map((workflow) => [workflow.name, latestWorkflowActivity(details, workflow)]));
  const running = graphs.flatMap((workflow) => {
    const current = activity.get(workflow.name);
    if (!current || current.detail.trace.endedAt) return [];
    const steps = workflow.nodes.filter((node) => current.states[node.id]?.active).map((node) => node.label);
    return [{ workflow, trace: current.detail.trace, steps }];
  });
  const recent = [...traces].reverse().filter((trace) => trace.workflow !== "mcp_call").slice(0, 3);
  const lane = (name: WorkflowName, number: number, trigger: string) => {
    const workflow = graph(name);
    if (!workflow) return null;
    const current = activity.get(name);
    const states = current?.states ?? {};
    const showRuns = Boolean(current);
    const inProgress = Boolean(current && !current.detail.trace.endedAt);
    const selectNode = (spanId: string) => current && onNode(current.detail.trace.id, spanId);
    return (
      <section className={`runtime-lane${inProgress ? " active" : ""}`} key={name} aria-label={`${workflow.title} workflow`}>
        <div className="runtime-lane-head">
          <span className="runtime-lane-number">{number}</span>
          <div>
            <h3>{workflow.title}</h3>
            <p>{trigger}</p>
          </div>
          {current && <a className={`runtime-lane-run${inProgress ? " active" : ""}`} href={traceHref(current.detail.trace.id)}>{inProgress ? "Running" : "Last run"} · {current.detail.trace.title}</a>}
        </div>
        <WorkflowMap graph={workflow} states={states} showRuns={showRuns} inProgress={inProgress} onNode={selectNode} />
        <CompactWorkflowMap graph={workflow} states={states} showRuns={showRuns} inProgress={inProgress} onNode={selectNode} />
      </section>
    );
  };

  return (
    <div className="runtime-workflow-map" aria-label="Complete agent and runtime workflow">
      <div className={`runtime-progress${running.length || replaying ? " active" : ""}`} role="status" aria-live="polite">
        <strong>{running.length ? "Running now" : replaying ? "Replay in progress" : traces.length === 0 ? "Waiting for workflow activity" : replayFinished ? "Replay finished" : "Latest workflow activity"}</strong>
        <span>{running.length ? `${running.length} workflow${running.length === 1 ? "" : "s"} active; the current nodes are highlighted below.` : replaying ? "The last completed runs are shown while the runtime waits for the next event." : traces.length ? "The most recent path through each workflow is highlighted below." : "Start a replay or add a ticket to see each step light up."}</span>
        {(running.length > 0 || recent.length > 0) && <div className="runtime-progress-steps">
          {running.length > 0
            ? running.map(({ workflow, trace, steps }) => <a key={workflow.name} href={traceHref(trace.id)}>{workflow.title}: {steps.join(" + ") || "starting"}</a>)
            : recent.map((trace) => <a key={trace.id} href={traceHref(trace.id)} title={trace.outcome ?? trace.title}>{WORKFLOW_LABELS[trace.workflow]} · {trace.outcome ?? trace.title}</a>)}
        </div>}
      </div>
      <div className="runtime-entry">
        <div><strong>Ticket sources</strong><span>Freshdesk webhook or poll · typed ticket · replay</span></div>
        <span className="runtime-arrow" aria-hidden="true">→</span>
        <div><strong>Server runtime</strong><span>Records the ticket and starts a trace</span></div>
        <span className="runtime-arrow" aria-hidden="true">→</span>
        <div><strong>Ticket intake</strong><span>One run for every ticket</span></div>
      </div>

      {lane("ticket", 1, "Screen untrusted text, classify the ticket, then correlate it with recent reports.")}

      <div className="runtime-branches" aria-label="Ticket intake outcomes">
        <div><strong>Incident gates pass ↓</strong><span>Start incident response</span></div>
        <div><strong>Matches an open incident ↓</strong><span>Run the late complaint workflow</span></div>
        <div><strong>No incident</strong><span>Record why; keep correlating new tickets</span></div>
      </div>

      {lane("incident", 2, "The Commander opens the incident. Investigation, impact assessment and engineering filing run in parallel before recovery.")}
      {lane("late_ticket", 3, "A new complaint joins an existing incident. Run recovery if it has started; otherwise reassess impact.")}

      <div className="runtime-join" aria-label="Recovery pass triggers">
        <span>Incident response <b>↓</b> recovery pass</span>
        <span>Late complaint <b>↓</b> recovery pass when recovery is underway</span>
      </div>
      {lane("recovery_pass", 4, "Reassess each customer, plan missing actions, act within authority, write back, request approvals and settle.")}

      <div className="runtime-join" aria-label="Human approval handoff">
        <span>Credit above agent authority <b>→</b> one approval per customer <b>→</b> human decision</span>
      </div>
      {lane("decision", 5, "After a human approves, changes or rejects a credit, carry out that exact decision, write back and settle coverage.")}

      <div className="runtime-services" aria-label="Shared runtime services">
        <div><strong>Every agent tool call + external MCP call</strong><span>enters the policy gate</span></div>
        <span className="runtime-arrow" aria-hidden="true">→</span>
        <div><strong>Policy gate</strong><span>Checks identity, permission and authority</span></div>
        <span className="runtime-arrow" aria-hidden="true">→</span>
        <div><strong>Allowed adapters</strong><span>Sandbox world · Freshdesk · Freshservice</span></div>
        <div className="runtime-services-foot">Calls enter the audit log. Events update the console over SSE; spans appear in Traces and, when configured, LangSmith.</div>
      </div>
    </div>
  );
}

function CompactWorkflowMap({ graph, states, showRuns, inProgress, onNode }: { graph: WorkflowGraph; states: Record<string, NodeState>; showRuns: boolean; inProgress: boolean; onNode: (spanId: string) => void }) {
  const { at } = layout(graph);
  const columns = new Map<number, typeof graph.nodes>();
  for (const node of graph.nodes) {
    if (node.kind !== "node") continue;
    const col = at[node.id]!.col;
    columns.set(col, [...(columns.get(col) ?? []), node]);
  }

  return (
    <div className="runtime-compact-map">
      {[...columns.entries()].sort(([a], [b]) => a - b).map(([col, nodes], index) => {
        const conditional = graph.name !== "incident" && nodes.length > 1 && graph.edges.some((edge) => edge.conditional && nodes.some((node) => node.id === edge.to));
        return (
          <div className="runtime-stage" key={col}>
            {index > 0 && <span className="runtime-stage-arrow" aria-hidden="true">↓</span>}
            {nodes.length > 1 && <span className="runtime-stage-label">{conditional ? "One of these paths" : "In parallel"}</span>}
            <div className="runtime-stage-nodes">
              {nodes.map((node) => {
                const state = states[node.id];
                const tone = showRuns && state?.worst && isProblemStatus(state.worst) ? SPAN_STATUS[state.worst].tone : null;
                const status = !showRuns ? "idle" : !state?.ran ? inProgress ? "pending" : "skipped" : state.active ? "running" : tone ? `problem-${tone}` : "ok";
                const content = <><strong>{node.label}</strong><span>{ACTOR_LABELS[node.actor]}{showRuns && state && state.runs > 1 ? ` · ×${state.runs}` : ""}</span></>;
                return state?.spanId && showRuns ? (
                  <button key={node.id} type="button" className={`runtime-step ${status}`} title={node.description} onClick={() => onNode(state.spanId!)}>{content}</button>
                ) : (
                  <div key={node.id} className={`runtime-step ${status}`} title={node.description}>{content}</div>
                );
              })}
            </div>
          </div>
        );
      })}
      {graph.name === "recovery_pass" && <p className="runtime-compact-note">Conditional shortcut: if no recovery plan can be made, continue from Plan recovery to Ask a human, then Settle.</p>}
    </div>
  );
}
