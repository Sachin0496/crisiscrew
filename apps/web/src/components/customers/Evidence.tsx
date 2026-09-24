import type { AffectedCustomer, EvidenceKind, RecoveryAction, RecoveryKind } from "@crisiscrew/contracts";
import {
  Ban,
  CircleCheck,
  CircleDashed,
  Clock,
  CreditCard,
  GitCommitHorizontal,
  Hourglass,
  Inbox,
  IndianRupee,
  Mail,
  MessageCircleOff,
  MessageSquare,
  MessageSquareReply,
  NotebookPen,
  PhoneCall,
  Server,
  type LucideIcon,
} from "lucide-react";
import { EVIDENCE_SOURCE, EVIDENCE_TITLE, inr, RECOVERY_KIND, RECOVERY_STATUS, sentence } from "../../format";
import { Badge } from "../ui";

const EVIDENCE_ICON: Record<EvidenceKind, LucideIcon> = {
  payment_failed: CreditCard,
  payment_pending: Hourglass,
  payment_succeeded: CircleCheck,
  service: Server,
  cause: GitCommitHorizontal,
  window: Clock,
  reported: Inbox,
  no_ticket: MessageCircleOff,
  no_payment: CircleDashed,
};

/** Evidence of harm reads red; the absence of evidence reads muted. */
const EVIDENCE_TONE: Partial<Record<EvidenceKind, string>> = {
  payment_failed: "harm",
  payment_pending: "harm",
  payment_succeeded: "ok",
  no_payment: "absent",
  no_ticket: "absent",
};

/** Why CrisisCrew thinks this customer was affected: one line per edge of the impact graph. */
export function EvidenceChain({ customer }: { customer: AffectedCustomer }) {
  return (
    <div className="chain-wrap">
      <ol className="chain" aria-label={`Evidence for ${customer.name}`}>
        {customer.evidence.map((e, i) => {
          const Icon = EVIDENCE_ICON[e.kind];
          return (
            <li key={`${e.kind}-${e.node}-${i}`} className={`chain-item ${EVIDENCE_TONE[e.kind] ?? ""}`}>
              <span className="chain-icon" aria-hidden>
                <Icon size={14} />
              </span>
              <div className="chain-text">
                <div className="chain-title">
                  {EVIDENCE_TITLE[e.kind]}
                  {e.source !== "engine" && <Badge>{EVIDENCE_SOURCE[e.source] ?? sentence(e.source)}</Badge>}
                </div>
                <div className="chain-label">{e.label}</div>
              </div>
            </li>
          );
        })}
      </ol>
      <div className={customer.confidence === "confirmed" ? "confidence confirmed" : "confidence"}>
        {customer.confidence === "confirmed" ? (
          <>
            <strong>Confirmed.</strong> A failed or pending payment inside the incident window
            {customer.complained ? ", and they wrote in." : ". They never contacted support: CrisisCrew found them from the payment data."}
          </>
        ) : (
          <>
            <strong>Not verified.</strong> They reported the failure, but no failed payment is on record, so they get an acknowledgement and no credit until
            there's evidence.
          </>
        )}
      </div>
    </div>
  );
}

const ACTION_ICON: Record<RecoveryKind, LucideIcon> = {
  ticket_reply: MessageSquareReply,
  acknowledge: MessageSquare,
  proactive_message: Mail,
  voice: PhoneCall,
  account_note: NotebookPen,
  credit: IndianRupee,
  no_credit: Ban,
};

/** A customer's recovery actions, each with the reason the policy chose it and what happened. */
export function RecoveryPlan({ actions }: { actions: RecoveryAction[] }) {
  if (actions.length === 0) return <p className="muted small">Planned once the root cause is known.</p>;
  return (
    <ul className="plan" aria-label="Recovery plan">
      {actions.map((a) => {
        const Icon = ACTION_ICON[a.kind];
        const status = RECOVERY_STATUS[a.status];
        return (
          <li key={a.id} className="plan-item">
            <span className="plan-icon" aria-hidden>
              <Icon size={15} />
            </span>
            <div className="plan-body">
              <div className="plan-head">
                <span className="plan-name">
                  {RECOVERY_KIND[a.kind]}
                  {a.kind === "credit" && a.amountInr !== undefined ? ` · ${inr(a.amountInr)}` : ""}
                </span>
                {a.level !== null && <Badge title={`Needs authority level L${a.level}`}>L{a.level}</Badge>}
                {a.kind !== "no_credit" && (
                  <Badge tone={status.tone} dot={a.status === "awaiting_approval"}>
                    {status.label}
                  </Badge>
                )}
              </div>
              <div className="plan-reason">{a.reason}.</div>
              {a.detail && <div className="plan-detail">{a.detail}</div>}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
