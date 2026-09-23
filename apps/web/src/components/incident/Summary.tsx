import type { CrisisState, IncidentView } from "@crisiscrew/contracts";
import { Check, CirclePlay, Clock, GitCommitHorizontal, Inbox, Users } from "lucide-react";
import type { ScenarioSummary } from "../../api";
import { clock, CREDIT_STATUS, inr, pct, plural, SEVERITY, since, STATUS_LABELS, STATUS_TONE } from "../../format";
import { expectedOutcome, incidentTitle, progressSteps } from "../../view";
import { Badge, Stat } from "../ui";

export function ScenarioNote({ scenario, finished }: { scenario: ScenarioSummary; finished: boolean }) {
  return (
    <section className="card scenario-note" aria-label="Scenario">
      <CirclePlay size={18} aria-hidden />
      <div className="scenario-text">
        <strong>
          {finished ? "Replay finished" : "Replaying"}: {scenario.title}.
        </strong>{" "}
        {scenario.purpose}
        <div className="scenario-expected">{expectedOutcome(scenario.expected)}.</div>
      </div>
    </section>
  );
}

export function IncidentSummary({ incident }: { incident?: IncidentView }) {
  if (!incident) {
    return (
      <div className="page-header">
        <div className="page-title-row">
          <h1 className="page-title">No active incident</h1>
          <Badge tone="success" dot>
            Monitoring
          </Badge>
        </div>
        <p className="page-lede">
          The Pattern Agent compares every new ticket with the last 15 minutes of tickets. It opens an incident only when a group of similar failure reports
          passes all four gates.
        </p>
      </div>
    );
  }
  const tickets = new Set([...incident.ticketIds, ...incident.linkedTicketIds]).size;
  const severity = SEVERITY[incident.severity];
  return (
    <div className="page-header">
      <div className="page-title-row">
        <h1 className="page-title">{incidentTitle(incident.surface)}</h1>
        <Badge tone={STATUS_TONE[incident.status]} dot>
          {STATUS_LABELS[incident.status]}
        </Badge>
        <Badge tone={severity.tone}>{severity.label}</Badge>
      </div>
      <div className="page-meta">
        <span className="mono">{incident.id}</span>
        <span>
          <Clock size={14} aria-hidden /> Opened {clock(incident.openedAt)}
        </span>
        <span>
          <Inbox size={14} aria-hidden /> {plural(tickets, "ticket")}
        </span>
        {incident.affected && (
          <span>
            <Users size={14} aria-hidden /> {plural(incident.affected.total, "customer")} affected
          </span>
        )}
        {incident.rootCause && (
          <span>
            <GitCommitHorizontal size={14} aria-hidden /> Likely cause <strong>{incident.rootCause.label}</strong> ({pct(incident.rootCause.confidence)})
          </span>
        )}
      </div>
    </div>
  );
}

export function Stepper({ incident, start }: { incident: IncidentView; start: number }) {
  return (
    <section className="card" aria-label="Incident progress">
      <ol className="stepper">
        {progressSteps(incident).map((step) => (
          <li
            key={step.key}
            className={`step ${step.state}${step.key === "awaiting_approval" ? " waiting" : ""}`}
            aria-current={step.state === "current" ? "step" : undefined}
          >
            <span className="step-icon" aria-hidden>
              {step.state === "done" ? <Check size={13} strokeWidth={3} /> : step.state === "current" ? <span className="pulse" /> : null}
            </span>
            <div className="step-label">{step.label}</div>
            <div className="step-time">{step.at !== undefined ? since(step.at, start) : " "}</div>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function Stats({ state, incident }: { state: CrisisState; incident?: IncidentView }) {
  const tickets = state.ticketOrder.map((id) => state.tickets[id]!);
  const failures = tickets.filter((t) => t.signal?.isFailure).length;
  const affected = incident?.affected;
  const credit = incident?.credit;
  const proposed = credit ? credit.perCustomerInr * credit.customers : 0;
  const creditSub = !credit
    ? "Proposed after customers are updated"
    : credit.amountInr === proposed
      ? `${inr(credit.perCustomerInr)} × ${plural(credit.customers, "customer")} · ${CREDIT_STATUS[credit.status]}`
      : `Changed from the proposed ${inr(proposed)} · ${CREDIT_STATUS[credit.status]}`;
  return (
    <div className="stats" aria-label="Key numbers">
      <Stat label="Tickets read" value={tickets.length} sub={`${plural(failures, "failure report")} · ${plural(tickets.length - failures, "question")}`} />
      <Stat
        label="Customers affected"
        value={affected ? affected.total : "–"}
        sub={affected ? `${affected.ticketed.length} contacted us · ${affected.silent.length} silent` : "Found from failed payments once an incident opens"}
      />
      <Stat
        label="Root cause confidence"
        value={incident?.rootCause ? pct(incident.rootCause.confidence) : "–"}
        sub={incident?.rootCause ? incident.rootCause.label : "Ranked when the Investigator finishes"}
      />
      <Stat
        label="Goodwill credit"
        value={credit ? inr(credit.amountInr) : "–"}
        sub={creditSub}
      />
    </div>
  );
}
