import { AGENT_IDS, WORKFLOW_LABELS, type CrisisState, type TraceDetail, type TraceSummary, type WiringReport, type WorkflowGraph, type WorkflowName } from "@crisiscrew/contracts";
import { Activity } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { TraceView } from "../components/traces/TraceView";
import { WorkflowMap } from "../components/traces/WorkflowMap";
import { Badge, Card, Empty, Segmented } from "../components/ui";
import { AGENT_STATUS, plural, since } from "../format";
import { traceHref } from "../router";
import { defaultTrace, duration, nodeStates, TRACE_STATUS } from "../traces";

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
  const [tab, setTab] = useState<WorkflowName>("incident");
  const [filter, setFilter] = useState<Filter>("all");
  const [detail, setDetail] = useState<TraceDetail | null>(null);
  const [span, setSpan] = useState<string | null>(null);

  useEffect(() => {
    api.workflows().then(setGraphs, () => undefined);
  }, []);

  const traces = state.traces;
  const selected = traces.find((t) => t.id === traceId) ?? defaultTrace(traces);
  const attention = traces.filter((t) => t.status === "attention" || t.status === "error").length;
  const langsmith = wiring?.ports.find((p) => p.port === "tracing" && p.adapter === "langsmith");

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
    if (!selected) return;
    if (selected.workflow !== "mcp_call") setTab(selected.workflow);
    setSpan(selected.firstProblem?.spanId ?? null);
  }, [selected?.id]);

  const shown = useMemo(() => {
    const newest = [...traces].reverse();
    if (filter === "attention") return newest.filter((t) => t.status === "attention" || t.status === "error");
    if (filter === "incidents") return newest.filter((t) => t.workflow !== "ticket" && t.workflow !== "mcp_call");
    return newest;
  }, [traces, filter]);

  const graph = graphs.find((g) => g.name === tab);
  const openDetail = detail && selected && detail.trace.id === selected.id ? detail : null;
  const states = graph ? nodeStates(openDetail, graph) : {};
  const showRuns = Boolean(openDetail && Object.values(states).some((s) => s.ran));

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
        subtitle={graph ? graph.description : "The five LangGraph workflow entry points"}
        actions={
          <Segmented
            label="Workflow"
            value={tab}
            onChange={setTab}
            options={graphs.map((g) => ({ value: g.name, label: g.title }))}
          />
        }
      >
        {graph ? (
          <>
            <WorkflowMap graph={graph} states={states} showRuns={showRuns} onNode={setSpan} />
            <div className="wf-legend">
              <span>
                <i className="solid" /> always
              </span>
              <span>
                <i className="dashed" /> conditional
              </span>
              {showRuns ? (
                <span className="muted">Showing the run of {selected?.title}. Click a node to open its step.</span>
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
