import type { CrisisState, IncidentView } from "@crisiscrew/contracts";
import { Check, CircleCheck, CircleX } from "lucide-react";
import { useState } from "react";
import { api } from "../../api";
import { CREDIT_STATUS, inr, plural } from "../../format";
import { Badge, Callout, Card } from "../ui";

/**
 * The goodwill credit. Within the authority limit the agents issue it
 * themselves; above it, the Handoff Agent asks a human, and only the amount
 * the human approves can be paid.
 */
export function Decision({ state, incident }: { state: CrisisState; incident?: IncidentView }) {
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const credit = incident?.credit;
  if (!incident || !credit) return null;
  const approval = incident.approvalId ? state.approvals[incident.approvalId] : undefined;
  const issued = state.credits.find((c) => c.incidentId === incident.id);

  if (!approval) {
    return (
      <Card title="Goodwill credit" subtitle="Recovery Agent">
        <Callout tone={credit.status === "issued" ? "success" : "neutral"} icon={<CircleCheck size={16} aria-hidden />}>
          {credit.status === "issued"
            ? `${inr(credit.amountInr)} issued by the Recovery Agent. It's within the agents' authority, so no human decision was needed.`
            : `${inr(credit.amountInr)} credit ${CREDIT_STATUS[credit.status]}.`}
        </Callout>
      </Card>
    );
  }

  const decide = async (decision: "approve" | "modify" | "reject") => {
    if (decision === "modify" && !Number(amount)) {
      setError("Enter the amount you want to approve.");
      return;
    }
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

  if (approval.status !== "pending") {
    const rejected = approval.status === "rejected";
    return (
      <Card title="Decision recorded" subtitle={`${approval.id} · decided by ${approval.decidedBy ?? "the approver"}`}>
        <Callout tone={rejected ? "neutral" : "success"} icon={rejected ? <CircleX size={16} aria-hidden /> : <CircleCheck size={16} aria-hidden />}>
          {rejected
            ? `Rejected. No credit was issued${approval.note ? `: “${approval.note}”` : "."}`
            : `${approval.status === "modified" ? "Approved at a changed amount" : "Approved"}: ${inr(approval.approvedAmountInr ?? approval.amountInr)}. ${
                issued ? `Issued by the Handoff Agent (${issued.id}, ${issued.adapter}).` : "Issuing…"
              } The agents can't pay any other amount on this approval.`}
        </Callout>
      </Card>
    );
  }

  return (
    <Card
      className="card-attention"
      title="Decision required"
      subtitle={`${approval.id} · requested by the Handoff Agent`}
      actions={
        <Badge tone="warning" dot>
          Waiting for you
        </Badge>
      }
    >
      <div className="amount">{inr(approval.amountInr)}</div>
      <div className="amount-sub">
        {inr(approval.perCustomerInr)} goodwill credit × {plural(approval.customers, "customer")}. That's above the {inr(approval.limitInr)} the agents may approve alone.
      </div>
      <ul className="case-list">
        {approval.caseSummary
          .split("\n")
          .filter(Boolean)
          .map((line, i) => (
            <li key={i}>{line}</li>
          ))}
      </ul>
      <div className="decision-actions">
        <button className="btn btn-primary btn-block" type="button" disabled={busy} onClick={() => decide("approve")}>
          <Check size={16} aria-hidden />
          Approve {inr(approval.amountInr)}
        </button>
        <div className="modify-row">
          <label className="sr-only" htmlFor="modify-amount">
            Amount to approve instead, in rupees
          </label>
          <input
            id="modify-amount"
            className="input"
            inputMode="numeric"
            placeholder="Other amount in ₹"
            value={amount}
            onChange={(e) => {
              setAmount(e.target.value.replace(/[^0-9]/g, ""));
              setError(null);
            }}
          />
          <button className="btn" type="button" disabled={busy} onClick={() => decide("modify")}>
            Modify
          </button>
        </div>
        <button className="btn btn-danger" type="button" disabled={busy} onClick={() => decide("reject")}>
          <CircleX size={15} aria-hidden />
          Reject
        </button>
        <label className="sr-only" htmlFor="decision-note">
          Note for the audit record
        </label>
        <input id="decision-note" className="input" placeholder="Note for the audit record (optional)" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
      </div>
    </Card>
  );
}
