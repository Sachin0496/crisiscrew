import type { CrisisState } from "@crisiscrew/contracts";
import { useEffect, useState } from "react";
import { api, type AuditVerify, type PolicyView } from "../api";
import { since, TOOL_OWNER } from "../format";

export function Governance({ state, policy }: { state: CrisisState; policy: PolicyView | null }) {
  const [tab, setTab] = useState<"audit" | "permissions">("audit");
  const [verify, setVerify] = useState<AuditVerify | null>(null);
  const calls = state.toolCalls.length;

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      api.verifyAudit().then((v) => !cancelled && setVerify(v), () => !cancelled && setVerify(null));
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [calls, state.session.id]);

  return (
    <section className="card pad" id="governance" aria-label="Governance">
      <div className="cardhead">
        <h2>Governance</h2>
        {verify && (
          <span className="chain" title="Each audit entry carries the SHA-256 of the previous one">
            <span className={`dot ${verify.ok ? "" : "red"}`} />
            {verify.ok ? `Audit chain verified · ${verify.count} entries` : `Audit chain broken at entry ${verify.brokenAt}`}
          </span>
        )}
        <div className="tabs" role="tablist">
          <button className="tab" role="tab" aria-selected={tab === "audit"} onClick={() => setTab("audit")}>
            Audit log
          </button>
          <button className="tab" role="tab" aria-selected={tab === "permissions"} onClick={() => setTab("permissions")}>
            Who may do what
          </button>
        </div>
      </div>
      {tab === "audit" ? <AuditTable state={state} /> : <Permissions policy={policy} />}
    </section>
  );
}

function AuditTable({ state }: { state: CrisisState }) {
  const rows = [...state.toolCalls].reverse();
  if (rows.length === 0) return <div className="empty">Every tool call, allowed or refused, lands here with a hash that chains it to the previous one.</div>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>When</th>
            <th>Agent</th>
            <th>Tool</th>
            <th>Level</th>
            <th>Decision</th>
            <th>Hash</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((e) => (
            <tr key={e.hash} className={e.decision === "denied" ? "denied" : ""}>
              <td className="mono">{e.seq}</td>
              <td className="mono">{since(e.at, state.session.startedAt)}</td>
              <td>{TOOL_OWNER[e.identity] ?? e.identity}</td>
              <td className="mono">{e.tool}</td>
              <td>{e.level === null ? "·" : `L${e.level}`}</td>
              <td>{e.decision === "denied" ? `refused: ${e.reason}` : e.outcome === "error" ? `error: ${e.reason}` : "allowed"}</td>
              <td className="mono faint">{e.hash.slice(0, 10)}…</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Permissions({ policy }: { policy: PolicyView | null }) {
  if (!policy) return <div className="empty">Loading the policy…</div>;
  const tools = policy.tools;
  return (
    <>
      <p className="faint" style={{ fontSize: 12.5, marginTop: 0 }}>
        Generated from config/policy.json, the same file the gate enforces. Authority limit {`₹${policy.limits.authorityLimitInr.toLocaleString("en-IN")}`}; credit rate{" "}
        {`₹${policy.limits.creditPerCustomerInr.toLocaleString("en-IN")}`} per affected customer.
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Tool</th>
              <th>Level</th>
              {policy.identities.map((i) => (
                <th key={i.identity} className="center" title={`${i.name}: up to L${i.maxLevel}`}>
                  {i.name.replace(" Agent", "").replace("Incident ", "").replace("External MCP client", "MCP client")}
                  <br />≤L{i.maxLevel}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tools.map((t) => (
              <tr key={t.name}>
                <td className="mono" title={t.description}>
                  {t.name}
                </td>
                <td>{t.levels.map((l) => `L${l}`).join("/")}</td>
                {policy.identities.map((i) => {
                  const allowed = i.tools.find((x) => x.name === t.name)?.allowed;
                  return (
                    <td key={i.identity} className={`center ${allowed ? "yes" : "no"}`}>
                      {allowed ? "✓" : "·"}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
