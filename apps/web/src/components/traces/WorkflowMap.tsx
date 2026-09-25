import type { WorkflowGraph } from "@crisiscrew/contracts";
import type { KeyboardEvent } from "react";
import { ACTOR_LABELS, isProblemStatus, layout, SPAN_STATUS, type NodeState } from "../../traces";

const NODE_W = 168;
const NODE_H = 48;
const GAP_X = 30;
const TERMINAL_W = 26;
const ROW_H = 66;
const PAD = 14;
const LANE = 26;

type Props = {
  graph: WorkflowGraph;
  /** Which nodes ran in the selected trace; empty when no trace of this workflow is open. */
  states: Record<string, NodeState>;
  showRuns: boolean;
  onNode: (spanId: string) => void;
};

/**
 * One workflow entry point: nodes in columns by their longest path from Start.
 * With a trace open, the nodes it ran are marked, and a node
 * with a problem anywhere under it is ringed in red or amber.
 */
export function WorkflowMap({ graph, states, showRuns, onNode }: Props) {
  const { at, cols, maxRows } = layout(graph);
  const terminal = new Set(graph.nodes.filter((n) => n.kind !== "node").map((n) => n.id));
  // Columns holding only Start or End are narrow.
  const colW = Array.from({ length: cols }, (_, c) => (graph.nodes.every((n) => at[n.id]!.col !== c || terminal.has(n.id)) ? TERMINAL_W : NODE_W));
  const colX = colW.map((_, c) => PAD + colW.slice(0, c).reduce((sum, w) => sum + w + GAP_X, 0));
  const width = colX[cols - 1]! + colW[cols - 1]! + PAD;
  // Edges that skip a column run in a lane under the nodes, so they never cross one.
  const skips = graph.edges.some((e) => at[e.to]!.col - at[e.from]!.col > 1);
  const nodesHeight = Math.max(1, maxRows) * ROW_H + PAD * 2 - (ROW_H - NODE_H);
  const height = nodesHeight + (skips ? LANE : 0);
  const midY = nodesHeight / 2;
  const laneY = nodesHeight + LANE / 2 - 4;
  const box = (id: string) => {
    const p = at[id]!;
    const w = terminal.has(id) ? TERMINAL_W : NODE_W;
    const h = terminal.has(id) ? TERMINAL_W : NODE_H;
    const cy = midY + (p.row - (p.colSize - 1) / 2) * ROW_H;
    return { x: colX[p.col]! + (colW[p.col]! - w) / 2, y: cy - h / 2, w, h, cy };
  };

  return (
    <div className="wf-map">
      <svg viewBox={`0 0 ${width} ${height}`} width={width} role="img" aria-label={`${graph.title}: ${graph.nodes.filter((n) => n.kind === "node").map((n) => n.label).join(", ")}`}>
        <defs>
          <marker id={`arrow-${graph.name}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L8,4 L0,8 z" className="wf-arrow" />
          </marker>
        </defs>
        {graph.edges.map((e) => {
          const a = box(e.from);
          const b = box(e.to);
          const x1 = a.x + a.w;
          const x2 = b.x - 2;
          const skip = at[e.to]!.col - at[e.from]!.col > 1;
          const mx = (x1 + x2) / 2;
          const d = skip
            ? `M${x1},${a.cy} H${x1 + 10} Q${x1 + 16},${a.cy} ${x1 + 16},${a.cy + 8} V${laneY - 8} Q${x1 + 16},${laneY} ${x1 + 24},${laneY} H${x2 - 24} Q${x2 - 16},${laneY} ${x2 - 16},${laneY - 8} V${b.cy + 8} Q${x2 - 16},${b.cy} ${x2 - 8},${b.cy} H${x2}`
            : `M${x1},${a.cy} C${mx},${a.cy} ${mx},${b.cy} ${x2},${b.cy}`;
          const ran = showRuns && states[e.from]?.ran && states[e.to]?.ran;
          return (
            <path
              key={`${e.from}-${e.to}`}
              d={d}
              className={`wf-edge${e.conditional ? " conditional" : ""}${ran ? " ran" : ""}`}
              markerEnd={`url(#arrow-${graph.name})`}
            />
          );
        })}
        {graph.nodes.map((n) => {
          const b = box(n.id);
          const st = states[n.id];
          if (terminal.has(n.id)) {
            return (
              <g key={n.id} className={`wf-terminal${showRuns && st?.ran ? " ran" : ""}`}>
                <circle cx={b.x + b.w / 2} cy={b.cy} r={n.kind === "end" ? 8 : 6} />
                <text x={b.x + b.w / 2} y={b.cy + 22} textAnchor="middle" className="wf-terminal-label">
                  {n.label}
                </text>
              </g>
            );
          }
          const problem = showRuns && st?.worst && isProblemStatus(st.worst) ? SPAN_STATUS[st.worst].tone : null;
          const state = !showRuns ? "idle" : !st?.ran ? "skipped" : st.worst === "running" ? "running" : problem ? `problem-${problem}` : "ok";
          const clickable = showRuns && st?.spanId;
          return (
            <g
              key={n.id}
              className={`wf-node ${state}${clickable ? " clickable" : ""}`}
              {...(clickable
                ? {
                    role: "button",
                    tabIndex: 0,
                    onClick: () => onNode(st!.spanId!),
                    onKeyDown: (ev: KeyboardEvent) => (ev.key === "Enter" || ev.key === " ") && onNode(st!.spanId!),
                  }
                : {})}
            >
              <title>{`${n.label} · ${ACTOR_LABELS[n.actor]}\n${n.description}`}</title>
              <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={8} />
              <text x={b.x + 12} y={b.y + 20} className="wf-label">
                {n.label}
              </text>
              <text x={b.x + 12} y={b.y + 36} className="wf-actor">
                {ACTOR_LABELS[n.actor]}
                {showRuns && st && st.runs > 1 ? ` · ×${st.runs}` : ""}
              </text>
              {showRuns && st?.ran && <circle cx={b.x + b.w - 12} cy={b.y + 13} r={4} className={`wf-dot ${state}`} />}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
