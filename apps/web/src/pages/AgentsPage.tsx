import { AGENT_IDS, LEVEL_NAMES, type AuditEntry, type CrisisState } from "@crisiscrew/contracts";
import { Bot } from "lucide-react";
import { Badge, Card, Empty } from "../components/ui";
import { AGENT_STATUS, plural, sentence, since, TOOL_OWNER, type Tone } from "../format";

const ADAPTER: Record<string, string> = { sandbox: "Sandbox", core: "Engine", off: "Off" };

export function decisionOf(call: AuditEntry): { label: string; tone: Tone } {
  if (call.decision === "denied") return { label: "Refused", tone: "danger" };
  if (call.outcome === "error") return { label: "Error", tone: "danger" };
  return { label: "Allowed", tone: "neutral" };
}

export function AgentsPage({ state }: { state: CrisisState }) {
  const calls = [...state.toolCalls].reverse();
  const refused = calls.filter((c) => c.decision === "denied").length;
  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">Agents</h1>
        <p className="page-lede">
          Five agents, each with its own identity, allow-list and highest authority level. Every tool call goes through the policy gate and is written to the audit
          log.
        </p>
      </div>
      <Card title="Agents" subtitle="What each agent is doing now" flush>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Agent</th>
                <th>Highest authority</th>
                <th>Status</th>
                <th>Current task</th>
                <th>Last tool</th>
              </tr>
            </thead>
            <tbody>
              {AGENT_IDS.map((id) => {
                const agent = state.agents[id];
                const status = AGENT_STATUS[agent.status];
                return (
                  <tr key={id}>
                    <td className="primary nowrap">{agent.name}</td>
                    <td className="nowrap">{LEVEL_NAMES[agent.level]}</td>
                    <td>
                      <Badge tone={status.tone} dot={agent.status === "working"}>
                        {status.label}
                      </Badge>
                    </td>
                    <td className="wrap">{agent.task ?? "–"}</td>
                    <td className="mono nowrap">{agent.lastTool ?? "–"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
      <Card title="Tool calls" subtitle={`${plural(calls.length, "call")} · ${refused} refused · newest first`} flush>
        {calls.length === 0 ? (
          <Empty icon={<Bot size={18} />} title="No tool calls yet">
            Agents start work once an incident opens. Calls from MCP clients appear here too.
          </Empty>
        ) : (
          <div className="table-wrap tall">
            <table className="table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Agent</th>
                  <th>Tool</th>
                  <th>Level</th>
                  <th>Adapter</th>
                  <th>Decision</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {calls.map((c) => {
                  const decision = decisionOf(c);
                  return (
                    <tr key={c.hash} className={c.decision === "denied" ? "refused" : undefined}>
                      <td className="nowrap num">{since(c.at, state.session.startedAt)}</td>
                      <td className="primary nowrap">{TOOL_OWNER[c.identity] ?? c.identity}</td>
                      <td className="mono nowrap">{c.tool}</td>
                      <td className="nowrap">{c.level === null ? "–" : `L${c.level}`}</td>
                      <td>
                        <Badge>{ADAPTER[c.adapter] ?? "Live"}</Badge>
                      </td>
                      <td>
                        <Badge tone={decision.tone}>{decision.label}</Badge>
                      </td>
                      <td className="wrap">{sentence((c.decision === "denied" || c.outcome === "error" ? c.reason : c.resultSummary) ?? "")}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
