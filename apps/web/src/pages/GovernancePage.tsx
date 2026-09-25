import { GUARD_REASONS, type CrisisState, type WiringReport } from "@crisiscrew/contracts";
import { Check, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { api, type AuditVerify, type Health, type PolicyView } from "../api";
import { Badge, Card, Empty, Segmented } from "../components/ui";
import { decisionOf, inr, plural, sentence, since, TOOL_OWNER } from "../format";

type Filter = "all" | "refused";

/** Guardrails at a glance: what screens untrusted text, what it flagged, what the gate refused, and who may write. */
function Guardrails({ state, wiring, health }: { state: CrisisState; wiring: WiringReport | null; health: Health | null }) {
  const guard = wiring?.ports.find((p) => p.port === "guard");
  const flags = [...state.guardFlags].reverse();
  const refused = state.toolCalls.filter((e) => e.decision === "denied").length;
  const locked = health ? health.auth.admin && health.auth.approver : null;
  return (
    <Card title="Guardrails" subtitle="Tickets, tool outputs and documents are data, never instructions. A flag never grants authority; the policy gate decides every action." flush>
      <div className="guard-grid">
        <div className="guard-stat">
          <div className="stat-label">Prompt guard</div>
          <div className="guard-value">{guard?.adapter === "lakera" ? "Lakera + rules" : "Built-in rules"}</div>
          <div className="stat-sub">Screens every ticket and the text in external tool outputs</div>
        </div>
        <div className="guard-stat">
          <div className="stat-label">Flagged inputs</div>
          <div className={`guard-value${flags.length ? " warn" : ""}`}>{flags.length}</div>
          <div className="stat-sub">{flags.length ? "Kept as data; see below" : "Nothing instruction-like this session"}</div>
        </div>
        <div className="guard-stat">
          <div className="stat-label">Refused calls</div>
          <div className={`guard-value${refused ? " bad" : ""}`}>{refused}</div>
          <div className="stat-sub">Allow-lists, authority levels, consent, exact amounts, unknown fields</div>
        </div>
        <div className="guard-stat">
          <div className="stat-label">Write access</div>
          <div className="guard-value">{locked === null ? "–" : locked ? "Tokens required" : "Open, local demo"}</div>
          <div className="stat-sub">An exposed server won't start without both tokens</div>
        </div>
      </div>
      {flags.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Source</th>
                <th>Why it was flagged</th>
                <th>Text</th>
              </tr>
            </thead>
            <tbody>
              {flags.map((f, i) => (
                <tr key={`${f.at}-${i}`}>
                  <td className="nowrap num">{since(f.at, state.session.startedAt)}</td>
                  <td className="nowrap primary">{f.source === "ticket" ? `Ticket ${f.ref}` : <span className="mono">{f.ref} output</span>}</td>
                  <td>
                    <div className="tags">
                      {f.verdict.reasons.map((r) => (
                        <Badge key={r} tone="warning" title={r}>
                          {GUARD_REASONS[r] ?? r}
                        </Badge>
                      ))}
                    </div>
                  </td>
                  <td className="wrap flagged-text">“{f.excerpt}”</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export function GovernancePage({ state, policy, wiring }: { state: CrisisState; policy: PolicyView | null; wiring: WiringReport | null }) {
  const [verify, setVerify] = useState<AuditVerify | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const calls = state.toolCalls.length;

  useEffect(() => {
    api.health().then(setHealth, () => undefined);
  }, []);

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
      <Guardrails state={state} wiring={wiring} health={health} />
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
            ? `Who may call which tool. The agents may credit up to ${inr(policy.limits.perCustomerLimitInr)} per customer and ${inr(policy.limits.authorityLimitInr)} per incident; anything above needs a human.`
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
