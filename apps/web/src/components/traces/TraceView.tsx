import { WORKFLOW_LABELS, type Span, type TraceDetail, type TraceSummary, type WorkflowGraph } from "@crisiscrew/contracts";
import { ChevronDown, ChevronRight, CircleAlert, GitBranch, ListTree, ShieldAlert, Sparkles, Wrench } from "lucide-react";
import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { plural, sentence, since, TOOL_OWNER } from "../../format";
import { ACTOR_LABELS, duration, isProblemStatus, SPAN_STATUS, spanRows, timing, TRACE_STATUS, type SpanRow } from "../../traces";
import { Badge, Callout, Segmented } from "../ui";

const KIND_ICON = { workflow: GitBranch, node: ListTree, tool: Wrench, guard: ShieldAlert, classifier: Sparkles } as const;

type Props = {
  summary: TraceSummary;
  detail: TraceDetail | null;
  graphs: WorkflowGraph[];
  selected: string | null;
  onSelect: (spanId: string | null) => void;
  sessionStart: number;
};

/** What a span is called on screen: a graph node by its label in its own workflow, a workflow by its name, the rest as recorded. */
function spanTitle(span: Span, workflow: string | undefined, graphs: WorkflowGraph[]): ReactNode {
  if (span.kind === "workflow") return WORKFLOW_LABELS[span.name as keyof typeof WORKFLOW_LABELS] ?? span.name;
  if (span.kind === "node") return graphs.find((g) => g.name === workflow)?.nodes.find((n) => n.id === span.name)?.label ?? span.name;
  if (span.kind === "guard") return "Prompt guard";
  if (span.kind === "classifier") return span.name === "laya" ? "Laya classifier" : `${span.name} classifier`;
  return <span className="mono">{span.name}</span>;
}

function Json({ label, value }: { label: string; value: unknown }) {
  if (value === undefined) return null;
  return (
    <div className="span-json">
      <div className="span-json-label">{label}</div>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </div>
  );
}

function SpanDetail({ span }: { span: Span }) {
  const meta = Object.entries(span.meta ?? {}).filter(([k, v]) => v !== null && v !== "" && k !== "label" && k !== "langgraph_node");
  return (
    <div className="span-detail">
      {span.reason && (
        <Callout tone={SPAN_STATUS[span.status].tone === "danger" ? "danger" : "warning"} icon={<CircleAlert size={15} aria-hidden />}>
          {sentence(span.reason)}
        </Callout>
      )}
      {meta.length > 0 && (
        <div className="span-meta">
          {meta.map(([k, v]) => (
            <Badge key={k} mono>
              {k === "audit" ? `audit #${v}` : k === "level" ? `L${v}` : `${k} ${String(v)}`}
            </Badge>
          ))}
        </div>
      )}
      <div className="span-io">
        <Json label="Input" value={span.input} />
        <Json label="Output" value={span.output} />
      </div>
    </div>
  );
}

/**
 * One workflow run, span by span: a waterfall in the order things started,
 * with the first problem called out at the top and one click from its span.
 * "Problems only" keeps just the path from the workflow down to what went wrong.
 */
export function TraceView({ summary, detail, graphs, selected, onSelect, sessionStart }: Props) {
  const [filter, setFilter] = useState<"all" | "problems">("all");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const rows = useMemo(() => spanRows(detail?.spans ?? []), [detail]);
  // The workflow each span runs in: its nearest workflow ancestor, so node labels come from the right graph.
  const workflowOf = useMemo(() => {
    const byId = new Map(rows.map((r) => [r.span.id, r.span]));
    return new Map(rows.map((r) => [r.span.id, [...r.ancestors].reverse().map((a) => byId.get(a)).find((a) => a?.kind === "workflow")?.name]));
  }, [rows]);
  const start = summary.startedAt;
  const end = Math.max(summary.endedAt ?? 0, ...rows.map((r) => r.span.endedAt ?? r.span.startedAt), start + 1);
  const problems = rows.filter((r) => isProblemStatus(r.worst));
  const status = TRACE_STATUS[summary.status];

  useEffect(() => {
    setCollapsed(new Set());
    setFilter("all");
  }, [summary.id]);

  // Opening a span from the callout or the graph makes sure it isn't hidden.
  useEffect(() => {
    if (!selected) return;
    const row = rows.find((r) => r.span.id === selected);
    if (!row) return;
    if (row.ancestors.some((a) => collapsed.has(a))) setCollapsed(new Set([...collapsed].filter((c) => !row.ancestors.includes(c))));
    requestAnimationFrame(() => document.getElementById(`span-${selected}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
  }, [selected, rows]);

  const visible = rows.filter((r: SpanRow) => {
    if (r.ancestors.some((a) => collapsed.has(a))) return false;
    if (filter === "problems") return isProblemStatus(r.worst);
    return true;
  });
  const toggle = (id: string) => {
    const next = new Set(collapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setCollapsed(next);
  };
  const problem = summary.firstProblem;

  return (
    <section className="card trace-view" aria-label={`Trace: ${summary.title}`}>
      <header className="card-header trace-head">
        <div className="card-heading">
          <div className="trace-title">
            <h2 className="card-title">{summary.title}</h2>
            <Badge tone={status.tone} dot={summary.status !== "ok"}>
              {status.label}
            </Badge>
          </div>
          <p className="card-subtitle">
            {WORKFLOW_LABELS[summary.workflow]} · started {since(summary.startedAt, sessionStart)} · {duration(summary.endedAt !== undefined ? summary.endedAt - summary.startedAt : undefined)} ·{" "}
            {plural(summary.spanCount, "span")} · {plural(summary.toolCalls, "tool call")}
          </p>
        </div>
        <div className="card-actions">
          <Segmented
            label="Show"
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: "All steps" },
              { value: "problems", label: `Problems only${problems.length ? ` (${problems.filter((r) => isProblemStatus(r.span.status)).length})` : ""}` },
            ]}
          />
        </div>
      </header>
      {summary.outcome && <div className="trace-outcome">{summary.outcome}</div>}
      {problem && (
        <div className="trace-problem">
          <Callout tone={problem.status === "error" || problem.status === "denied" ? "danger" : "warning"} icon={<CircleAlert size={16} aria-hidden />}>
            <strong>Where it went wrong:</strong> {problem.actor ? `${ACTOR_LABELS[problem.actor]} · ` : ""}
            <span className="mono">{problem.name}</span> {SPAN_STATUS[problem.status].label.toLowerCase()}: {problem.reason}.{" "}
            <button type="button" className="link-btn" onClick={() => onSelect(problem.spanId)}>
              Show the step
            </button>
          </Callout>
        </div>
      )}
      {!detail ? (
        <div className="empty">Loading spans…</div>
      ) : (
        <div className="table-wrap trace-table-wrap">
          <table className="table trace-table">
            <thead>
              <tr>
                <th>Step</th>
                <th>Agent</th>
                <th>Status</th>
                <th className="timeline-col">Timeline</th>
                <th className="right">Duration</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => {
                const { span } = row;
                const Icon = KIND_ICON[span.kind];
                const t = timing(span, start, end);
                const st = SPAN_STATUS[span.status];
                const open = selected === span.id;
                const hiddenProblem = row.worst !== span.status && isProblemStatus(row.worst) && collapsed.has(span.id);
                return (
                  <Fragment key={span.id}>
                    <tr
                      id={`span-${span.id}`}
                      className={`span-row kind-${span.kind}${open ? " selected" : ""}${isProblemStatus(span.status) ? ` problem-${st.tone}` : ""}`}
                      onClick={() => onSelect(open ? null : span.id)}
                    >
                      <td className="span-name">
                        <div className="span-name-inner" style={{ paddingLeft: row.depth * 18 }}>
                          {row.childCount > 0 ? (
                            <button
                              type="button"
                              className="tree-toggle"
                              aria-label={collapsed.has(span.id) ? "Expand" : "Collapse"}
                              aria-expanded={!collapsed.has(span.id)}
                              onClick={(e) => {
                                e.stopPropagation();
                                toggle(span.id);
                              }}
                            >
                              {collapsed.has(span.id) ? <ChevronRight size={14} aria-hidden /> : <ChevronDown size={14} aria-hidden />}
                            </button>
                          ) : (
                            <span className="tree-spacer" />
                          )}
                          <Icon size={14} aria-hidden className="span-icon" />
                          <span className="span-title">{spanTitle(span, workflowOf.get(span.id), graphs)}</span>
                          {hiddenProblem && <span className="nested-problem" title="Something inside went wrong" />}
                        </div>
                      </td>
                      <td className="nowrap span-actor">{span.actor ? (TOOL_OWNER[span.actor] ?? ACTOR_LABELS[span.actor]) : "–"}</td>
                      <td className="nowrap">
                        {span.status === "ok" ? <span className="muted">OK</span> : <Badge tone={st.tone}>{st.label}</Badge>}
                      </td>
                      <td className="timeline-col">
                        <div className="span-bar" aria-hidden>
                          <span className={`tone-${span.status === "ok" ? "neutral" : st.tone}`} style={{ left: `${t.left * 100}%`, width: `${t.width * 100}%` }} />
                        </div>
                      </td>
                      <td className="right nowrap num">{duration(span.endedAt !== undefined ? span.endedAt - span.startedAt : undefined)}</td>
                    </tr>
                    {open && (
                      <tr className="span-detail-row">
                        <td colSpan={5}>
                          <SpanDetail span={span} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          {visible.length === 0 && <div className="empty">Nothing went wrong in this run.</div>}
        </div>
      )}
    </section>
  );
}
