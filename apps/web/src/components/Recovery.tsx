import type { CrisisState } from "@crisiscrew/contracts";
import { useState } from "react";
import { api } from "../api";
import { CHANNEL_LABELS, inr } from "../format";
import { currentIncident } from "./Overview";

export function Recovery({ state }: { state: CrisisState }) {
  const incident = currentIncident(state);
  const affected = incident?.affected;
  const updates = incident?.updates ?? [];
  const count = (channel: keyof typeof CHANNEL_LABELS) => updates.filter((u) => u.channel === channel && u.status !== "refused").length;
  const sample = updates.find((u) => u.channel !== "voice");
  const voice = updates.find((u) => u.channel === "voice");
  const ticketedShare = affected && affected.total > 0 ? affected.ticketed.length / affected.total : 0;
  return (
    <section className="card pad" id="recovery" aria-label="Recovery">
      <div className="cardhead">
        <h2>Recovery Agent · customers</h2>
        <span className="aside">limited writes · contact only with consent</span>
      </div>
      {!affected ? (
        <div className="empty">
          The Recovery Agent links every related ticket and checks payment attempts to find customers who were hit but haven't written in, the silent ones.
        </div>
      ) : (
        <>
          <div className="corr-label">Customers affected since the failure started</div>
          <div className="corr-value">{affected.total}</div>
          <div className="split" role="img" aria-label={`${affected.ticketed.length} contacted us, ${affected.silent.length} silent`}>
            <span className="a" style={{ width: `${ticketedShare * 100}%` }} />
            <span className="b" style={{ width: `${(1 - ticketedShare) * 100}%` }} />
          </div>
          <div className="legend">
            <span>
              <i style={{ background: "var(--cyan)" }} />
              {affected.ticketed.length} contacted us
            </span>
            <span>
              <i style={{ background: "var(--violet)" }} />
              {affected.silent.length} silent: found from failed payments
            </span>
          </div>
          <div className="counts">
            <div className="mini">
              <div className="n">{count("ticket_reply")}</div>
              <div className="t">Ticket replies</div>
            </div>
            <div className="mini">
              <div className="n">{count("proactive_message")}</div>
              <div className="t">Proactive messages</div>
            </div>
            <div className="mini">
              <div className="n">{count("voice")}</div>
              <div className="t">Voice scripts</div>
            </div>
          </div>
          {sample && (
            <div className="message">
              <span className="label">
                The one message everyone gets · written from a {sample.source}
              </span>
              {sample.text}
            </div>
          )}
          {voice && (
            <div className="message" style={{ marginTop: 10 }}>
              <span className="label">
                Voice script for priority customers · {voice.status === "prepared" ? "prepared; voice is off, so no audio or call" : voice.adapter}
              </span>
              {voice.text}
            </div>
          )}
          <div className="updates">
            {[...updates].reverse().map((u) => (
              <div className="update" key={u.id}>
                <span className="who">{u.customerName}</span>
                <span className="faint">{u.id}</span>
                <span className="ch">
                  <span className={`badge ${u.status === "prepared" ? "off" : u.adapter === "sandbox" ? "sandbox" : "live"}`}>
                    {CHANNEL_LABELS[u.channel]} · {u.status === "prepared" ? "prepared" : u.adapter}
                  </span>
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

export function Approval({ state }: { state: CrisisState }) {
  const incident = currentIncident(state);
  const approval = incident?.approvalId ? state.approvals[incident.approvalId] : undefined;
  const credit = incident?.credit;
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const decide = async (decision: "approve" | "modify" | "reject") => {
    if (!approval) return;
    setBusy(true);
    setError(null);
    try {
      await api.decide(approval.id, {
        decision,
        ...(decision === "modify" ? { amountInr: Number(amount) } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const issued = state.credits.find((c) => c.incidentId === incident?.id);
  return (
    <section className={`card pad ${approval ? "approval" : ""}`} id="handoff" aria-label="Human decision">
      <div className="cardhead">
        <h2>Handoff Agent · human decision</h2>
        <span className="aside">agents propose; people decide above the limit</span>
      </div>
      {!credit ? (
        <div className="empty">
          After recovery, the agents propose a goodwill credit for everyone affected. Within the authority limit they may issue it themselves; above it, only a human can.
        </div>
      ) : !approval ? (
        <div className={`decided ${credit.status === "issued" ? "" : "rejected"}`}>
          {credit.status === "issued"
            ? `${inr(credit.amountInr)} credit issued by the Recovery Agent: within its authority, so no human was needed.`
            : `Credit of ${inr(credit.amountInr)} ${credit.status.replace("_", " ")}.`}
        </div>
      ) : (
        <>
          <div className="eyebrow" style={{ color: "var(--amber)" }}>
            {approval.id} · {approval.status === "pending" ? "waiting for you" : approval.status}
          </div>
          <div className="exposure">{inr(approval.amountInr)}</div>
          <div className="subline">
            {inr(approval.perCustomerInr)} goodwill credit × {approval.customers} customers, above the {inr(approval.limitInr)} the agents may approve alone
          </div>
          <div className="case">
            {approval.caseSummary.split("\n").map((line, i) => (
              <div key={i}>{line}</div>
            ))}
          </div>
          {approval.status === "pending" ? (
            <>
              <div className="decide">
                <button className="btn ok" disabled={busy} onClick={() => decide("approve")}>
                  Approve {inr(approval.amountInr)}
                </button>
                <label className="sr-only" htmlFor="modify-amount">
                  Modified amount in rupees
                </label>
                <input
                  id="modify-amount"
                  className="input"
                  inputMode="numeric"
                  placeholder="₹ amount"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, ""))}
                />
                <button className="btn warn" disabled={busy || !Number(amount)} onClick={() => decide("modify")}>
                  Modify
                </button>
                <button className="btn danger" disabled={busy} onClick={() => decide("reject")}>
                  Reject
                </button>
              </div>
              <input className="input" style={{ width: "100%", marginTop: 8 }} placeholder="Note for the record (optional)" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />
            </>
          ) : (
            <div className={`decided ${approval.status === "rejected" ? "rejected" : ""}`}>
              {approval.status === "rejected"
                ? `Rejected by ${approval.decidedBy}. Nothing was issued${approval.note ? `: “${approval.note}”` : "."}`
                : `${approval.status === "modified" ? "Modified" : "Approved"} by ${approval.decidedBy}: ${inr(approval.approvedAmountInr ?? approval.amountInr)}. ${
                    issued ? `Issued by the Handoff Agent (${issued.id}, ${issued.adapter}).` : "Issuing…"
                  } The agents can't pay any other amount on this approval.`}
            </div>
          )}
          {error && (
            <div className="faint" role="alert" style={{ marginTop: 8, fontSize: 12.5 }}>
              {error}
            </div>
          )}
        </>
      )}
    </section>
  );
}
