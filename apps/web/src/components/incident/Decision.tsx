import type { Approval, CrisisState, IncidentView } from "@crisiscrew/contracts";
import { Check, CircleCheck, CircleX, Scale } from "lucide-react";
import { useState } from "react";
import { api } from "../../api";
import { inr, plural } from "../../format";
import { routeHref } from "../../router";
import { decisionsFor } from "../../view";
import { Badge, Callout, Card, Empty } from "../ui";

/** Approve, change the amount, or reject one customer's credit. Only the approved amount can be paid, and only to that customer. */
export function DecisionControl({ approval, compact = false }: { approval: Approval; compact?: boolean }) {
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = `decision-${approval.id}`;

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
      setBusy(false);
    }
  };

  return (
    <div className="decision-actions">
      <button className="btn btn-primary btn-block" type="button" disabled={busy} onClick={() => decide("approve")}>
        <Check size={16} aria-hidden />
        Approve {inr(approval.amountInr)}
      </button>
      <div className="modify-row">
        <label className="sr-only" htmlFor={`${id}-amount`}>
          Amount to approve instead, in rupees
        </label>
        <input
          id={`${id}-amount`}
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
        <button className="btn btn-danger" type="button" disabled={busy} onClick={() => decide("reject")}>
          <CircleX size={15} aria-hidden />
          Reject
        </button>
      </div>
      {!compact && (
        <>
          <label className="sr-only" htmlFor={`${id}-note`}>
            Note for the audit record
          </label>
          <input id={`${id}-note`} className="input" placeholder="Note for the audit record (optional)" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />
        </>
      )}
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

/** What was decided, in one line. */
export function decisionOutcome(approval: Approval, creditId?: string): string {
  const by = approval.decidedBy ?? "the approver";
  if (approval.status === "rejected") return `Declined by ${by}; nothing was paid${approval.note ? `: “${approval.note}”` : "."}`;
  const amount = approval.approvedAmountInr ?? approval.amountInr;
  const changed = amount !== approval.amountInr ? ` (changed from ${inr(approval.amountInr)})` : "";
  return `${inr(amount)} approved by ${by}${changed}. ${creditId ? `Issued as ${creditId}.` : "Issuing…"}`;
}

function PendingDecision({ approval }: { approval: Approval }) {
  return (
    <div className="decision-item">
      <div className="decision-head">
        <a className="decision-customer" href={routeHref("customers", approval.customerRef)}>
          {approval.customerName}
        </a>
        <span className="decision-amount">{inr(approval.amountInr)}</span>
      </div>
      <div className="amount-sub">
        Goodwill credit, above the {inr(approval.limitInr)} the agents may give one customer on their own.
      </div>
      <ul className="case-list">
        {approval.caseSummary
          .split("\n")
          .filter(Boolean)
          .slice(0, 3)
          .map((line, i) => (
            <li key={i}>{line}</li>
          ))}
      </ul>
      <DecisionControl approval={approval} />
    </div>
  );
}

/**
 * The human side of recovery. Credits within the agents' authority are
 * issued automatically; each one above it waits here, for one customer,
 * with that customer's evidence.
 */
export function Decisions({ state, incident }: { state: CrisisState; incident?: IncidentView }) {
  if (!incident) return null;
  const decisions = decisionsFor(state, incident.id);
  const pending = decisions.filter((a) => a.status === "pending");
  const decided = decisions.filter((a) => a.status !== "pending");
  const credits = new Map(state.credits.filter((c) => c.approvalId).map((c) => [c.approvalId!, c.id]));
  return (
    <Card
      className={pending.length > 0 ? "card-attention" : undefined}
      title={pending.length > 0 ? "Decisions required" : "Decisions"}
      subtitle="Handoff Agent · credits above the agents' authority"
      actions={
        pending.length > 0 ? (
          <Badge tone="warning" dot>
            {plural(pending.length, "customer")} waiting
          </Badge>
        ) : undefined
      }
      flush={pending.length > 0}
    >
      {decisions.length === 0 ? (
        <Empty icon={<Scale size={18} />} title="No decision needed yet">
          Credits of ₹500 or less per customer, up to ₹5,000 for the incident, are issued by the agents within policy. Anything above goes to a human, one customer at a
          time.
        </Empty>
      ) : (
        <>
          {pending.map((a) => (
            <PendingDecision key={a.id} approval={a} />
          ))}
          {decided.length > 0 && (
            <div className={pending.length > 0 ? "decided flush" : "decided"}>
              {decided.map((a) => (
                <Callout key={a.id} tone={a.status === "rejected" ? "neutral" : "success"} icon={a.status === "rejected" ? <CircleX size={16} aria-hidden /> : <CircleCheck size={16} aria-hidden />}>
                  <strong>{a.customerName}:</strong> {decisionOutcome(a, credits.get(a.id))}
                </Callout>
              ))}
            </div>
          )}
        </>
      )}
    </Card>
  );
}
