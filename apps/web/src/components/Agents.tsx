import { AGENT_IDS, LEVEL_NAMES, type CrisisState } from "@crisiscrew/contracts";
import { since, TOOL_OWNER } from "../format";

export function Agents({ state }: { state: CrisisState }) {
  const calls = [...state.toolCalls].reverse().slice(0, 60);
  return (
    <section className="card pad" id="agents" aria-label="Agents">
      <div className="cardhead">
        <h2>Five agents, one trust boundary each</h2>
        <span className="aside">every action goes through the policy gate</span>
      </div>
      <div className="agent-grid">
        {AGENT_IDS.map((id) => {
          const a = state.agents[id];
          return (
            <div className={`agent ${a.status}`} key={id}>
              <span className="state" aria-hidden />
              <div className="name">{a.name}</div>
              <div className="level">Up to {LEVEL_NAMES[a.level]}</div>
              <div className="task">{a.task ?? "Idle"}</div>
            </div>
          );
        })}
      </div>
      <div className="cardhead" style={{ marginBottom: 6 }}>
        <h2 style={{ fontSize: 13.5 }}>Tool calls, live</h2>
        <span className="aside">{state.toolCalls.length} so far</span>
      </div>
      <div className="activity" aria-live="polite">
        {calls.length === 0 ? (
          <div className="empty">No agent has acted yet. Agents only run once an incident opens.</div>
        ) : (
          calls.map((c) => (
            <div className={`call ${c.decision === "denied" ? "denied" : ""}`} key={c.hash}>
              <span className="when">{since(c.at, state.session.startedAt)}</span>
              <span className="who">{TOOL_OWNER[c.identity] ?? c.identity}</span>
              <span>
                <span className="tool">{c.tool}</span>
                {c.level !== null && <span className="lvl">L{c.level}</span>}
                <span className={`badge ${c.adapter === "sandbox" ? "sandbox" : c.adapter === "off" ? "off" : "surface"}`} style={{ marginLeft: 6 }}>
                  {c.adapter}
                </span>
                <div className="res">
                  {c.decision === "denied" ? `Refused: ${c.reason}` : c.outcome === "error" ? `Error: ${c.reason}` : c.resultSummary}
                </div>
              </span>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
