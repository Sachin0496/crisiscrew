import { AGENT_IDS, WORKFLOW_LABELS, type CrisisState, type TraceDetail, type TraceSummary, type WiringReport, type WorkflowGraph, type WorkflowName } from "@crisiscrew/contracts";
import { Activity } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { TraceView } from "../components/traces/TraceView";
import { RuntimeWorkflowMap } from "../components/traces/RuntimeWorkflowMap";
import { WorkflowMap } from "../components/traces/WorkflowMap";
import { Badge, Card, Empty, Segmented } from "../components/ui";
import { AGENT_STATUS, plural, since } from "../format";
import { traceHref } from "../router";
import { defaultTrace, duration, latestWorkflowActivity, nodeStates, TRACE_STATUS } from "../traces";

type Filter = "all" | "attention" | "incidents";

/**
 * Agent observability. Every workflow is a LangGraph graph; every run of one
 * is a trace of its nodes and of every tool call, guard check and
 * classifier call inside them. The map shows which nodes a run went
 * through; the trace shows each step, opens at the first problem, and
 * narrows to the path that led there.
 */
export function TracesPage({ state, wiring, traceId }: { state: CrisisState; wiring: WiringReport | null; traceId?: string }) {
  const [graphs, setGraphs] = useState<WorkflowGraph[]>([]);
  const [tab, setTab] = useState<WorkflowName | "overview">("overview");
  const [filter, setFilter] = useState<Filter>("all");
  const [detail, setDetail] = useState<TraceDetail | null>(null);
  const [activityDetails, setActivityDetails] = useState<TraceDetail[]>([]);
  const [span, setSpan] = useState<string | null>(null);
  const pendingNode = useRef<{ traceId: string; spanId: string } | null>(null);

  useEffect(() => {
    api.workflows().then(setGraphs, () => undefined);
  }, []);

  const traces = state.traces;
  const selected = traces.find((t) => t.id === traceId) ?? defaultTrace(traces);
  const attention = traces.filter((t) => t.status === "attention" || t.status === "error").length;
  const langsmith = wiring?.ports.find((p) => p.port === "tracing" && p.adapter === "langsmith");

  // The overview follows the latest run of each workflow and every run still open.
  // Recovery is nested in incident and late-complaint traces, so those details cover it too.
  const activityTargets = useMemo(() => {
    const latest = new Map<WorkflowName, TraceSummary>();
    for (const trace of [...traces].reverse()) if (trace.workflow !== "mcp_call" && !latest.has(trace.workflow)) latest.set(trace.workflow, trace);
    return [...new Map([...latest.values(), ...traces.filter((trace) => trace.workflow !== "mcp_call" && !trace.endedAt)].map((trace) => [trace.id, trace])).values()];
  }, [traces]);
  const activityKey = activityTargets.map((trace) => `${trace.id}:${trace.endedAt ?? "running"}`).join("|");
  useEffect(() => {
    if (activityTargets.length === 0) {
      setActivityDetails([]);
      return;
    }
    let stopped = false;
    let loading = false;
    const load = async () => {
      if (loading) return;
      loading = true;
      const results = await Promise.allSettled(activityTargets.map((trace) => api.trace(trace.id)));
      if (!stopped) setActivityDetails(results.flatMap((result) => result.status === "fulfilled" && result.value.trace.sessionId === state.session.id ? [result.value] : []));
      loading = false;
    };
    void load();
    const timer = activityTargets.some((trace) => !trace.endedAt) ? setInterval(load, 750) : undefined;
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [state.session.id, activityKey]);

  // Follow the open trace: fetch its spans when it changes, and keep polling while it runs.
  const key = selected ? `${selected.id}:${selected.status}:${selected.endedAt ?? ""}:${selected.firstProblem?.spanId ?? ""}` : "";
  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    let stopped = false;
    const load = () =>
      api.trace(selected.id).then(
        (d) => !stopped && setDetail(d),
        () => !stopped && setDetail(null),
      );
    void load();
    const timer = selected.status === "running" ? setInterval(load, 1200) : undefined;
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [key]);

  // Opening a trace shows its workflow on the map, and its first problem.
  useEffect(() => {
    if (!traceId) setTab("overview");
    if (!selected) return;
    if (traceId && selected.workflow !== "mcp_call") setTab(selected.workflow);
    const pending = pendingNode.current;
    if (pending?.traceId === selected.id) {
      setSpan(pending.spanId);
      pendingNode.current = null;
    } else setSpan(selected.firstProblem?.spanId ?? null);
  }, [selected?.id, traceId]);

  const shown = useMemo(() => {
    const newest = [...traces].reverse();
    if (filter === "attention") return newest.filter((t) => t.status === "attention" || t.status === "error");
    if (filter === "incidents") return newest.filter((t) => t.workflow !== "ticket" && t.workflow !== "mcp_call");
    return newest;
  }, [traces, filter]);

  const graph = graphs.find((g) => g.name === tab);
  const openDetail = detail && selected && detail.trace.id === selected.id ? detail : null;
  const currentActivity = activityDetails.filter((item) => item.trace.sessionId === state.session.id);
  const focusedDetail = traceId ? openDetail : graph ? latestWorkflowActivity(currentActivity, graph)?.detail ?? null : null;
  const states = graph ? nodeStates(focusedDetail, graph) : {};
  const showRuns = Boolean(focusedDetail && Object.values(states).some((s) => s.ran));
  const openWorkflowNode = (nodeTraceId: string, spanId: string) => {
    if (selected?.id === nodeTraceId) setSpan(spanId);
    else {
      pendingNode.current = { traceId: nodeTraceId, spanId };
      window.location.hash = traceHref(nodeTraceId);
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <div className="page-title-row">
          <h1 className="page-title">Traces</h1>
          {traces.length > 0 && (
            <Badge tone={attention > 0 ? "warning" : "success"} dot>
              {plural(traces.length, "run")} · {attention > 0 ? `${attention} need${attention === 1 ? "s" : ""} attention` : "no problems"}
            </Badge>
          )}
          <span className="trace-sink">{langsmith ? <Badge tone="success">Also in LangSmith</Badge> : <span className="muted">Local traces · set TRACING=langsmith to send them to LangSmith</span>}</span>
        </div>
        <p className="page-lede">
          Each agent workflow is a LangGraph graph. Every run is a trace of its nodes, and of every tool call, guard check and classifier call inside them.
          Anything refused, flagged or failed is marked, and the trace opens at the first problem.
        </p>
      </div>

      <div className="agent-strip" aria-label="Agents">
        {AGENT_IDS.map((id) => {
          const agent = state.agents[id];
          const s = AGENT_STATUS[agent.status];
          return (
            <div className="agent-chip" key={id} title={`${agent.name}: ${s.label}${agent.task ? `. ${agent.task}` : ""}`}>
              <div className="agent-chip-head">
                <span className={`agent-dot ${agent.status}`} aria-label={s.label} />
                <span className="agent-chip-name">{agent.name}</span>
              </div>
              <div className="agent-chip-task">{agent.task ?? "Waiting"}</div>
            </div>
          );
        })}
      </div>

      <Card
        title="Workflow map"
        className="workflow-card"
        subtitle={tab === "overview" ? "The complete runtime handoffs and all five compiled LangGraph workflows" : graph ? graph.description : "The LangGraph workflows, read from the compiled graphs"}
        actions={
          <Segmented
            label="Workflow"
            value={tab}
            onChange={setTab}
            options={[{ value: "overview", label: "Full runtime" }, ...graphs.map((g) => ({ value: g.name, label: g.title }))]}
          />
        }
      >
        {tab === "overview" && graphs.length > 0 ? (
          <>
            <RuntimeWorkflowMap graphs={graphs} details={currentActivity} traces={traces} replayFinished={state.replayFinished} replaying={state.session.mode === "replay" && !state.replayFinished} onNode={openWorkflowNode} />
            <div className="wf-legend">
              <span><i className="solid" /> always</span>
              <span><i className="dashed" /> conditional</span>
              <span className="muted">The current and latest runs light up as the demo plays. Click a node to inspect its trace.</span>
            </div>
          </>
        ) : graph ? (
          <>
            <WorkflowMap graph={graph} states={states} showRuns={showRuns} inProgress={Boolean(focusedDetail && !focusedDetail.trace.endedAt)} onNode={(spanId) => focusedDetail && openWorkflowNode(focusedDetail.trace.id, spanId)} />
            <div className="wf-legend">
              <span>
                <i className="solid" /> always
              </span>
              <span>
                <i className="dashed" /> conditional
              </span>
              {showRuns ? (
                <span className="muted">Showing the run of {focusedDetail?.trace.title}. Click a node to open its step.</span>
              ) : (
                <span className="muted">Open a run of this workflow to see the path it took.</span>
              )}
            </div>
          </>
        ) : (
          <Empty icon={<Activity size={18} />} title="Loading workflows" />
        )}
      </Card>

      <div className="traces-grid">
        <Card
          title="Runs"
          subtitle="Newest first"
          actions={
            <Segmented
              label="Filter runs"
              value={filter}
              onChange={setFilter}
              options={[
                { value: "all", label: "All" },
                { value: "attention", label: `Attention${attention ? ` ${attention}` : ""}` },
                { value: "incidents", label: "Incidents" },
              ]}
            />
          }
          flush
        >
          {shown.length === 0 ? (
            <Empty icon={<Activity size={18} />} title={traces.length === 0 ? "No runs yet" : "Nothing here"}>
              {traces.length === 0 ? "Run a replay or type a ticket: every workflow run shows up here." : "No run matches this filter."}
            </Empty>
          ) : (
            <ul className="run-list">
              {shown.map((t) => (
                <RunRow key={t.id} trace={t} active={t.id === selected?.id} start={state.session.startedAt} />
              ))}
            </ul>
          )}
        </Card>
        {selected ? (
          <TraceView summary={selected} detail={openDetail} graphs={graphs} selected={span} onSelect={setSpan} sessionStart={state.session.startedAt} />
        ) : (
          <Card title="Trace">
            <Empty icon={<Activity size={18} />} title="Pick a run">
              A trace shows every step of one workflow run: who did it, what went in and out, and what was refused.
            </Empty>
          </Card>
        )}
      </div>
    </div>
  );
}

function RunRow({ trace, active, start }: { trace: TraceSummary; active: boolean; start: number }) {
  const status = TRACE_STATUS[trace.status];
  return (
    <li>
      <a className={`run${active ? " active" : ""}`} href={traceHref(trace.id)} aria-current={active ? "true" : undefined}>
        <span className={`run-dot ${trace.status}`} aria-label={status.label} />
        <span className="run-main">
          <span className="run-title">
            {trace.title}
            <span className="run-workflow">{WORKFLOW_LABELS[trace.workflow]}</span>
          </span>
          <span className={`run-outcome${trace.firstProblem ? " problem" : ""}`}>
            {trace.firstProblem ? `${trace.firstProblem.name}: ${trace.firstProblem.reason}` : (trace.outcome ?? "Running…")}
          </span>
        </span>
        <span className="run-meta">
          <span>{since(trace.startedAt, start)}</span>
          <span>{duration(trace.endedAt !== undefined ? trace.endedAt - trace.startedAt : undefined)}</span>
        </span>
      </a>
    </li>
  );
}
