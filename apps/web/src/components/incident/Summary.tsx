import { recoveryCoverage, recoveryMetrics, type CrisisState, type IncidentView } from "@crisiscrew/contracts";
import { Check, CirclePlay, Clock, ExternalLink, GitCommitHorizontal, Inbox, Users, Wrench, Siren, ClipboardList, RotateCcw } from "lucide-react";
import type { ScenarioSummary } from "../../api";
import { ADAPTER_LABELS, clock, IMPORTANCE, inr, pct, plural, SEVERITY, since, STATUS_LABELS, STATUS_TONE } from "../../format";
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
          CrisisCrew reads every new complaint. When a burst of them describes the same failure, it opens an incident, proves which customers were harmed from the
          payment data, finds the ones who stayed silent, and runs each one's recovery until every affected customer is covered.
        </p>
      </div>
    );
  }
  const tickets = new Set([...incident.ticketIds, ...incident.linkedTicketIds]).size;
  const severity = SEVERITY[incident.severity];
  const importance = incident.importance;
  const coverage = recoveryCoverage(incident);
  const record = incident.engineering;
  return (
    <div className="page-header">
      <div className="page-title-row">
        <h1 className="page-title">{incidentTitle(incident.surface)}</h1>
        <Badge tone={STATUS_TONE[incident.status]} dot>
          {STATUS_LABELS[incident.status]}
        </Badge>
        {importance ? (
          <Badge tone={IMPORTANCE[importance.level].tone}>
            {importance.level}
            {importance.page ? " · page on-call" : ""}
          </Badge>
        ) : (
          <Badge tone={severity.tone}>{severity.label}</Badge>
        )}
      </div>
      <div className="page-meta">
        <span className="mono">{incident.id}</span>
        {incident.trigger === "alert" && (
          <span>
            <Siren size={14} aria-hidden /> Opened by a critical alert
          </span>
        )}
        <span>
          <Clock size={14} aria-hidden /> Opened {clock(incident.openedAt)}
        </span>
        <span>
          <Inbox size={14} aria-hidden /> {plural(tickets, "ticket")}
        </span>
        {incident.impact && (
          <span>
            <Users size={14} aria-hidden /> {plural(coverage.confirmed, "customer")} harmed
          </span>
        )}
        {incident.rootCause && (
          <span>
            <GitCommitHorizontal size={14} aria-hidden /> Likely cause <strong>{incident.rootCause.label}</strong> ({pct(incident.rootCause.confidence)})
          </span>
        )}
        {record && (
          <span title="The incident engineering works from">
            <Wrench size={14} aria-hidden />
            {record.url ? (
              <a href={record.url} target="_blank" rel="noreferrer">
                {ADAPTER_LABELS[record.adapter] ?? record.adapter} {record.id} <ExternalLink size={12} aria-hidden />
              </a>
            ) : (
              <>
                Engineering incident <strong className="mono">{record.id}</strong> ({(ADAPTER_LABELS[record.adapter] ?? record.adapter).toLowerCase()})
              </>
            )}
            {record.importance && <span className="muted">· filed at {record.importance}</span>}
          </span>
        )}
        {record?.change && (
          <span title="A rollback requested for engineering to plan and approve">
            <RotateCcw size={14} aria-hidden />
            {record.change.url ? (
              <a href={record.change.url} target="_blank" rel="noreferrer">
                Rollback change {record.change.id} <ExternalLink size={12} aria-hidden />
              </a>
            ) : (
              <>
                Rollback change <strong className="mono">{record.change.id}</strong>
              </>
            )}
          </span>
        )}
        {record?.problem && (
          <span title="Opened for the post-incident review">
            <ClipboardList size={14} aria-hidden />
            {record.problem.url ? (
              <a href={record.problem.url} target="_blank" rel="noreferrer">
                Problem {record.problem.id} <ExternalLink size={12} aria-hidden />
              </a>
            ) : (
              <>
                Problem <strong className="mono">{record.problem.id}</strong> for the review
              </>
            )}
          </span>
        )}
      </div>
      {importance && importance.reasons.length > 0 && (
        <p className="page-lede importance-why">
          <strong>
            {importance.level}, {IMPORTANCE[importance.level].meaning}
          </strong>
          {" — "}
          {importance.reasons.map((r) => r.text).join("; ")}.
        </p>
      )}
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
            <div className="step-time">{step.at !== undefined ? since(step.at, start) : " "}</div>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function Stats({ state, incident }: { state: CrisisState; incident?: IncidentView }) {
  const coverage = incident?.impact ? recoveryCoverage(incident) : undefined;
  const metrics = incident?.impact ? recoveryMetrics(state, incident) : undefined;
  const spent = metrics ? metrics.spend.issuedInr + metrics.spend.approvedInr : 0;
  return (
    <div className="stats" aria-label="Key numbers">
      <Stat
        label="Customers harmed"
        value={coverage ? coverage.confirmed : "–"}
        sub={
          coverage
            ? `${coverage.complained} complained · ${coverage.silent} silent${coverage.unverified ? ` · ${coverage.unverified} not verified` : ""}`
            : "Proved from payment data once an incident opens"
        }
      />
      <Stat
        label="Recovery coverage"
        value={
          coverage && coverage.confirmed > 0 ? (
            <>
              {coverage.recovered}
              <span className="of">/{coverage.confirmed}</span>
            </>
          ) : (
            "–"
          )
        }
        meter={coverage?.ratio ?? undefined}
        tone={coverage?.complete ? "success" : coverage && coverage.needsHuman > 0 ? "warning" : "accent"}
        sub={
          !coverage
            ? "Every affected customer, recovered"
            : coverage.complete
              ? "Every affected customer recovered"
              : coverage.needsHuman > 0
                ? `${plural(coverage.needsHuman, "customer")} ${coverage.needsHuman === 1 ? "needs" : "need"} a human`
                : `${coverage.inProgress + coverage.attention} still in progress`
        }
      />
      <Stat
        label="Root cause"
        value={incident?.rootCause ? pct(incident.rootCause.confidence) : "–"}
        sub={incident?.rootCause ? incident.rootCause.label : "Ranked when the Investigator finishes"}
      />
      <Stat
        label="Recovery spend"
        value={metrics ? inr(spent) : "–"}
        sub={
          !metrics
            ? "Credits sized per customer, by the harm"
            : metrics.spend.awaitingInr > 0
              ? `${inr(metrics.spend.awaitingInr)} waiting for approval`
              : metrics.spend.approvedInr > 0
                ? `${inr(metrics.spend.approvedInr)} of it approved by a human`
                : "All within the agents' authority"
        }
      />
    </div>
  );
}
