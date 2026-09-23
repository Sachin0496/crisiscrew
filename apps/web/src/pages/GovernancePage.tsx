import type { CrisisState } from "@crisiscrew/contracts";
import { Check, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { api, type AuditVerify, type PolicyView } from "../api";
import { Badge, Card, Empty, Segmented } from "../components/ui";
import { inr, plural, sentence, since, TOOL_OWNER } from "../format";
import { decisionOf } from "./AgentsPage";

type Filter = "all" | "refused";

export function GovernancePage({ state, policy }: { state: CrisisState; policy: PolicyView | null }) {
  const [verify, setVerify] = useState<AuditVerify | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const calls = state.toolCalls.length;

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      api.verifyAudit().then(
        (v) => !cancelled && setVerify(v),
        () => !cancelled && setVerify(null),
      );
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [calls, state.session.id]);

  const entries = [...state.toolCalls].reverse().filter((e) => filter === "all" || e.decision === "denied");
  const refused = state.toolCalls.filter((e) => e.decision === "denied").length;
  return (
    <div className="page">
      <div className="page-header">
        <div className="page-title-row">
          <h1 className="page-title">Governance</h1>
          {verify && (
            <Badge tone={verify.ok ? "success" : "danger"} dot>
              {verify.ok ? `Audit chain verified · ${plural(verify.count, "entry", "entries")}` : `Audit chain broken at entry ${verify.brokenAt}`}
            </Badge>
          )}
        </div>
        <p className="page-lede">
          Every tool call, allowed or refused, is recorded with the SHA-256 hash of the entry before it, so changing any entry breaks the chain. The permissions
          below are generated from config/policy.json, the same file the gate enforces.
        </p>
      </div>
      <Card
        title="Audit log"
        subtitle={`${plural(calls, "entry", "entries")} · ${refused} refused · this session`}
        actions={
          <Segmented
            label="Show"
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: "All" },
              { value: "refused", label: "Refused" },
            ]}
          />
        }
        flush
      >
        {entries.length === 0 ? (
          <Empty icon={<ShieldCheck size={18} />} title={calls === 0 ? "No entries yet" : "No refused calls"}>
            {calls === 0 ? "Every tool call lands here, whether an agent or an MCP client made it." : "Every call in this session was allowed."}
          </Empty>
        ) : (
          <div className="table-wrap tall">
            <table className="table">
              <thead>
                <tr>
                  <th className="right">#</th>
                  <th>Time</th>
                  <th>Caller</th>
                  <th>Tool</th>
                  <th>Level</th>
                  <th>Decision</th>
                  <th>Detail</th>
                  <th>Hash</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => {
                  const decision = decisionOf(e);
                  return (
                    <tr key={e.hash} className={e.decision === "denied" ? "refused" : undefined}>
                      <td className="right num">{e.seq}</td>
                      <td className="nowrap num">{since(e.at, state.session.startedAt)}</td>
                      <td className="primary nowrap">{TOOL_OWNER[e.identity] ?? e.identity}</td>
                      <td className="mono nowrap">{e.tool}</td>
                      <td className="nowrap">{e.level === null ? "–" : `L${e.level}`}</td>
                      <td>
                        <Badge tone={decision.tone}>{decision.label}</Badge>
                      </td>
                      <td className="wrap">{sentence((e.decision === "denied" || e.outcome === "error" ? e.reason : e.resultSummary) ?? "")}</td>
                      <td className="mono nowrap muted" title={e.hash}>
                        {e.hash.slice(0, 12)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Card
        title="Permissions"
        subtitle={
          policy
            ? `Who may call which tool. Authority limit ${inr(policy.limits.authorityLimitInr)}; credit ${inr(policy.limits.creditPerCustomerInr)} per affected customer.`
            : "Loading the policy…"
        }
        flush
      >
        {policy && (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Tool</th>
                  <th>Level</th>
                  {policy.identities.map((i) => (
                    <th key={i.identity} className="center" title={`${i.name}: up to L${i.maxLevel}`}>
                      {TOOL_OWNER[i.identity] ?? i.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {policy.tools.map((t) => (
                  <tr key={t.name}>
                    <td className="mono nowrap primary" title={t.description}>
                      {t.name}
                    </td>
                    <td className="nowrap">{t.levels.map((l) => `L${l}`).join(" / ")}</td>
                    {policy.identities.map((i) => {
                      const allowed = i.tools.find((x) => x.name === t.name)?.allowed ?? false;
                      return (
                        <td key={i.identity} className={allowed ? "center yes" : "center no"}>
                          {allowed ? <Check size={15} strokeWidth={2.5} aria-label="Allowed" /> : <span aria-label="Not allowed">–</span>}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
